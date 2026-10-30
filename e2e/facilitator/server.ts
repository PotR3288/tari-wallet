// x402 facilitator stand-in service (Phase 5 e2e) — a local implementation of the frozen
// settlement interface in `docs/x402-facilitator.md`, used while the real indexer-side
// endpoint (Task 3.2) does not exist. This is the reference implementation the real indexer
// will be measured against: every validation gate of the spec's checklist is implemented
// against the real esmeralda indexer's public reads (no local chain stack), via the same
// SDK exports the wallet itself uses (`@chironbuilder/ootle-sdk` htlcSafety, `@tari-project/ootle`
// stealth reads). Hold state machine: validate -> hold -> (merchant confirms settle)
// -> broadcast -> poll -> confirmed; `expired` once `refundEpoch` passes without a broadcast
// (stable terminal answer — never resurrected).
//
// DOCUMENTED DEVIATIONS from the spec's settle body, all test-stand-in-only (spike-5-report Q2):
//
// 1. `preimageHex` (optional) — the spec keeps the preimage sealed inside the BOR payload,
//    where only the chain's dry-run can see it (spec §Confidentiality). No exported SDK
//    surface deserializes a sealed envelope client-side (`@tari-project/ootle-wasm-bor`
//    decodes indexer-served CBOR substates, not envelopes), so the stand-in accepts the
//    preimage out of band to run checklist gate 5 (local SHA-256) directly. Legitimate
//    here only because the merchant legitimately holds it anyway, and it reaches this
//    service exactly at settle time, never earlier (same boundary the spec draws).
//    When omitted, gate 5 is covered by the dry-run abort oracle instead.
// 2. `claimantViewKeyHex` (optional) — the spec's gate 6 ("amount == quote.amount,
//    natively, from its own index") is not keyless-verifiable: the HTLC output's value is
//    stealth-encrypted, and `decryptOwnedUtxo` needs the claimant's view secret the
//    facilitator must never hold (spike-5-report Q2 caveat). The documented caveat path:
//    the e2e merchant caller hands this stand-in the TEST view key, and gates 6/7
//    (`AMOUNT_MISMATCH`/`DEST_MISMATCH`) run via `decryptOwnedUtxo`. When omitted, the
//    service fails closed with `AMOUNT_UNVERIFIABLE` — never a silent pass. The real
//    indexer closes this natively from its own index.
// 3. `validUntilEpoch` — the wallet's `X402SignedClaimPayload` echoes it (checklist gate 9);
//    relayed here because the sealed payload cannot be parsed client-side (same reason as 1).
// 4. `POST /x402/settlement/{localDigest}/broadcast` — the spec's "merchant confirms settle"
//    trigger has no wire name yet; this stand-in defines one (README).
//
// The service never holds keys beyond the optional test view key above, and never signs
// anything: the broadcast is a pure transport submit of the sealed envelope
// (`POST {indexerUrl}/transactions` with body `{ "transaction": <envelope> }`, spike Q1).
import * as http from "node:http";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  conditionRootOf,
  describeHtlcConditions,
  epochsUntilRefund,
  findScriptRoot,
  fromHex,
  isHtlcClaimableByEpoch,
  toOotleNetwork,
} from "@chironbuilder/ootle-sdk";
import type { NetworkName } from "@chironbuilder/ootle-sdk";
import { decryptOwnedUtxo, stealthUtxoSubstateId, WasmStealthCrypto } from "@tari-project/ootle";
import { IndexerProvider } from "@tari-project/ootle-indexer";
import type { DecryptedData } from "@tari-project/ootle";
import type {
  IndexerGetSubstateResponse,
  IndexerSubmitTransactionResponse,
  IndexerTransactionFinalizedResult,
} from "@tari-project/ootle-ts-bindings";
import type { X402PayTerms } from "../../src/lib/messages";
import { validateX402PayTerms } from "../../src/background/x402";

export type { X402PayTerms };

// ────────────────────────────────────────────────────────────────────────────────────────────
// Wire shapes
// ────────────────────────────────────────────────────────────────────────────────────────────

/** The settle request body. See the module header for the documented test-only deviations. */
export interface X402SettleRequest {
  /** The sealed, BOR-encoded claim envelope, lowercase hex — the wallet's `signedPayloadHex`. */
  signedPayloadHex: string;
  /** The `X402PayTerms` quote envelope verbatim (what the paying wallet funded). */
  quote: X402PayTerms;
  /** The funded HTLC output's commitment, 64 hex — spec: the pair rides every settle shape. */
  htlcOutputCommitmentHex: string;
  /** The two-leaf [claim, refund] condition tree the paying wallet relayed out of band. */
  conditions: object[];
  /** The wallet build path's echoed last-admissible epoch; must equal `refundEpoch - 1`. */
  validUntilEpoch: number;
  /** TEST-ONLY (deviation 1): the claim preimage, for the local SHA-256 gate. */
  preimageHex?: string;
  /** TEST-ONLY (deviation 2): the claimant's view secret key, for the amount/destination gates. */
  claimantViewKeyHex?: string;
}

/** Every distinct structured error code — one per rejection cause, never a shared bucket. */
export type X402ErrorCode =
  | "PAYLOAD_MALFORMED"
  | "SIGNATURE_INVALID"
  | "OUTPUT_MISSING"
  | "OUTPUT_SPENT"
  | "ROOT_MISMATCH"
  | "PREIMAGE_MISMATCH"
  | "EPOCH_PASSED"
  | "AMOUNT_MISMATCH"
  | "AMOUNT_UNVERIFIABLE"
  | "DEST_MISMATCH"
  | "QUOTE_MISMATCH"
  | "UNKNOWN_DIGEST";

export class SettlementError extends Error {
  constructor(readonly code: X402ErrorCode, readonly detail: string) {
    super(`${code}: ${detail}`);
  }
  toJSON() {
    return { error: this.code, detail: this.detail };
  }
}

export type SettlementStatus = "held" | "broadcast" | "confirmed" | "expired";

// ────────────────────────────────────────────────────────────────────────────────────────────
// Chain surface — every read/submit the facilitator makes. Injected so the validation matrix
// is unit-testable with a fake chain (same pattern as `src/background/x402SignOnly.ts`'s
// `X402ClaimChain`), while the default implementation is the real esmeralda indexer.
// ────────────────────────────────────────────────────────────────────────────────────────────

export interface FacilitatorChain {
  getCurrentEpoch(): Promise<number>;
  getStealthUtxo(resourceAddress: string, commitment: Uint8Array): Promise<IndexerGetSubstateResponse | null>;
  decryptOutput(substate: IndexerGetSubstateResponse, substateId: string, viewSecret: Uint8Array): Promise<DecryptedData | null>;
  /** The signature/admissibility oracle: a sealed envelope posted to the indexer's dry-run route. */
  dryRun(envelopeBase64: string): Promise<{ admissible: boolean; detail?: string }>;
  submitTransaction(envelopeBase64: string): Promise<IndexerSubmitTransactionResponse>;
  getTransactionResult(transactionId: string): Promise<{ result: IndexerTransactionFinalizedResult }>;
}

/** Lowercase hex → bytes (`@chironbuilder/ootle-sdk`'s `fromHex`, kept local for the gate's own error). */
const HEX = /^([0-9a-f]{2})+$/;

function hexToBytes(hex: string, what: string): Uint8Array {
  if (typeof hex !== "string" || !HEX.test(hex)) {
    throw new SettlementError("PAYLOAD_MALFORMED", `${what} must be an even number of lowercase hex characters.`);
  }
  return fromHex(hex);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 of the sealed envelope's BOR bytes — the spec's `localDigest` (the wallet's `txHash`). */
export function localDigestOf(signedPayloadHex: string): string {
  return bytesToHex(sha256(hexToBytes(signedPayloadHex, "signedPayloadHex")));
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// The facilitator
// ────────────────────────────────────────────────────────────────────────────────────────────

interface Settlement {
  quote: X402PayTerms;
  /** The sealed envelope verbatim (base64 of the BOR bytes) — what gets broadcast at settle. */
  envelopeBase64: string;
  refundEpoch: number;
  status: SettlementStatus;
  /** The indexer's own chain transaction id — only once broadcast (never the `localDigest`). */
  chainTxId?: string;
}

/**
 * The in-memory hold: `settle` validates a payload into `held`, `triggerBroadcast` submits it
 * at the merchant's confirmation, and background polling advances `broadcast` → `confirmed`.
 * `expired` is terminal: once a held payload's refund epoch passes, it is never broadcast.
 */
export class X402Facilitator {
  private readonly settlements = new Map<string, Settlement>();

  constructor(
    private readonly chain: FacilitatorChain,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** `POST /x402/settle` — validate and hold. Idempotent on `localDigest` (no re-validation). */
  async settle(request: unknown): Promise<{ localDigest: string; status: SettlementStatus; txHash?: string }> {
    const req = this.parseSettleRequest(request);
    const localDigest = localDigestOf(req.signedPayloadHex);
    // Spec idempotency: a digest already known returns the same status response as the first
    // POST — no re-validation, no re-broadcast.
    const known = this.settlements.get(localDigest);
    if (known) return { localDigest, status: known.status, txHash: known.chainTxId };
    await this.validate(req);
    this.settlements.set(localDigest, {
      quote: req.quote,
      envelopeBase64: bytesToBase64(fromHex(req.signedPayloadHex)),
      refundEpoch: req.quote.refundEpoch,
      status: "held",
    });
    return { localDigest, status: "held" };
  }

  /** `GET /x402/settlement/{localDigest}` — poll the hold. */
  async getSettlement(localDigest: string): Promise<{ status: SettlementStatus; txHash?: string }> {
    const settlement = this.settlements.get(localDigest.toLowerCase());
    if (!settlement) throw new SettlementError("UNKNOWN_DIGEST", `No settlement known for digest ${localDigest}.`);
    await this.expireIfRefundable(settlement);
    return { status: settlement.status, txHash: settlement.chainTxId };
  }

  /** `POST /x402/settlement/{localDigest}/broadcast` — the merchant's settle confirmation. */
  async triggerBroadcast(localDigest: string): Promise<{ status: SettlementStatus; txHash?: string }> {
    const settlement = this.settlements.get(localDigest.toLowerCase());
    if (!settlement) throw new SettlementError("UNKNOWN_DIGEST", `No settlement known for digest ${localDigest}.`);
    if (settlement.status === "held") {
      await this.expireIfRefundable(settlement);
      if (settlement.status === "held") {
        // Spec: the claim leaf is BeforeEpoch(refundEpoch), so broadcast only while claimable.
        const submitted = await this.chain.submitTransaction(settlement.envelopeBase64);
        settlement.chainTxId = submitted.transaction_id;
        settlement.status = "broadcast";
        // Poll in the background: broadcast → confirmed once the claim lands in a block.
        void this.pollToConfirmed(settlement).catch(() => {});
      }
    }
    return { status: settlement.status, txHash: settlement.chainTxId };
  }

  private async expireIfRefundable(settlement: Settlement): Promise<void> {
    if (settlement.status !== "held") return; // expired/broadcast/confirmed are all terminal-or-in-flight
    const currentEpoch = BigInt(await this.chain.getCurrentEpoch());
    if (!isHtlcClaimableByEpoch(currentEpoch, BigInt(settlement.refundEpoch))) {
      settlement.status = "expired"; // stable terminal answer — never resurrected, never broadcast
    }
  }

  private async pollToConfirmed(settlement: Settlement): Promise<void> {
    if (!settlement.chainTxId) return;
    const deadline = this.now() + 60_000;
    for (;;) {
      const { result } = await this.chain.getTransactionResult(settlement.chainTxId);
      if (result !== "Pending") {
        if ("Finalized" in result && result.Finalized.final_decision === "Commit") settlement.status = "confirmed";
        // An aborted/rejected claim stays reported as `broadcast` (in flight, needs
        // reconciliation) — the stand-in never converts a rejection into `confirmed`.
        return;
      }
      if (this.now() > deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  // ── Validation checklist (docs/x402-facilitator.md "Validation checklist", gates 1-9) ──

  private parseSettleRequest(request: unknown): X402SettleRequest {
    if (request === null || typeof request !== "object") {
      throw new SettlementError("PAYLOAD_MALFORMED", "The settle body must be a JSON object.");
    }
    const req = request as Record<string, unknown>;
    for (const field of ["signedPayloadHex", "quote", "htlcOutputCommitmentHex", "conditions", "validUntilEpoch"] as const) {
      if (req[field] === undefined) {
        throw new SettlementError("PAYLOAD_MALFORMED", `The settle body is missing the required field \`${field}\`.`);
      }
    }
    const signedPayloadHex = req["signedPayloadHex"];
    if (typeof signedPayloadHex !== "string" || !HEX.test(signedPayloadHex)) {
      throw new SettlementError("PAYLOAD_MALFORMED", "signedPayloadHex must be an even number of lowercase hex characters.");
    }
    // Gate 1's byte-level half (does it parse as a sealed BOR transaction) is delegated to the
    // indexer's own dry-run decoder below — the only decoder that can read a sealed envelope.
    hexToBytes(req["htlcOutputCommitmentHex"] as string, "htlcOutputCommitmentHex");
    const conditions = req["conditions"];
    if (!Array.isArray(conditions) || conditions.length < 2 || !conditions[0]) {
      throw new SettlementError(
        "PAYLOAD_MALFORMED",
        "conditions must be the two-leaf [claim, refund] tree the paying wallet relayed — it cannot be recovered from the chain alone."
      );
    }
    if (req["quote"] === null || typeof req["quote"] !== "object") {
      throw new SettlementError("QUOTE_MISMATCH", "quote must be the X402PayTerms envelope the paying wallet funded.");
    }
    // Field presence, hex shape and tree shape are checked above; the quote's own field
    // validation runs in `validate` below (gate by gate, each with its own error).
    return request as unknown as X402SettleRequest;
  }

  private async validate(req: X402SettleRequest): Promise<void> {
    // Gate shape: the quote is the exact `x402Pay` envelope — the repo's own static gate.
    try {
      validateX402PayTerms(req.quote);
    } catch (e) {
      throw new SettlementError("QUOTE_MISMATCH", e instanceof Error ? e.message : String(e));
    }
    if (req.quote.expiresAt <= this.now()) {
      // Spec §Settlement ordering: a lapsed quote is a stale quote — no settlement state kept.
      throw new SettlementError("QUOTE_MISMATCH", "This quote has already expired — ask the site for a fresh one.");
    }

    // The relayed pair, part of shape validation (spec: every settle shape carries it):
    // the tree must read back as this quote's HTLC.
    let described: { hashLockHex: string; refundEpoch: bigint };
    try {
      described = describeHtlcConditions(req.conditions);
    } catch {
      throw new SettlementError("PAYLOAD_MALFORMED", "conditions does not read back as a two-leaf HTLC condition tree.");
    }
    if (described.hashLockHex.toLowerCase() !== req.quote.hashLockHex) {
      throw new SettlementError("QUOTE_MISMATCH", "The relayed conditions tree's hash lock does not match the quote's hashLockHex.");
    }
    if (described.refundEpoch !== BigInt(req.quote.refundEpoch)) {
      throw new SettlementError("QUOTE_MISMATCH", "The relayed conditions tree's refund epoch does not match the quote's refundEpoch.");
    }

    // Checklist gate 9: the wallet's build path echoes `validUntilEpoch = refundEpoch - 1`,
    // never anything else — anything else did not come from the wallet's build path.
    if (req.validUntilEpoch !== req.quote.refundEpoch - 1) {
      throw new SettlementError(
        "QUOTE_MISMATCH",
        `validUntilEpoch must be refundEpoch - 1 (${req.quote.refundEpoch - 1}) under the wallet's build-path convention, got ${req.validUntilEpoch}.`
      );
    }

    // Checklist gate 8: the claim is only admissible while the current epoch is before
    // `refundEpoch` — checked against the chain, never the merchant's word for it.
    const currentEpoch = BigInt(await this.chain.getCurrentEpoch());
    if (!isHtlcClaimableByEpoch(currentEpoch, BigInt(req.quote.refundEpoch))) {
      throw new SettlementError(
        "EPOCH_PASSED",
        `The quote's refund epoch has passed (epoch ${currentEpoch}, refund epoch ${req.quote.refundEpoch}, ${epochsUntilRefund(currentEpoch, BigInt(req.quote.refundEpoch))} epochs left) — the payer may already have refunded; there is nothing left to claim.`
      );
    }

    // Checklist gate 5 (deviation 1): when the test preimage rides along, verify it locally.
    if (req.preimageHex !== undefined) {
      const preimage = hexToBytes(req.preimageHex, "preimageHex");
      if (bytesToHex(sha256(preimage)) !== req.quote.hashLockHex) {
        throw new SettlementError("PREIMAGE_MISMATCH", "The revealed preimage does not hash to the quote's hashLockHex.");
      }
    }

    // Checklist gate 3: the HTLC output exists at the relayed commitment, and is unspent.
    // `getStealthUtxo` returns null only when the UTXO does not exist at all; a spent
    // substate answers `Down`.
    const commitment = hexToBytes(req.htlcOutputCommitmentHex, "htlcOutputCommitmentHex");
    const substate = await this.chain.getStealthUtxo(req.quote.resourceAddress, commitment);
    if (substate === null) {
      throw new SettlementError("OUTPUT_MISSING", `No HTLC output exists at commitment ${req.htlcOutputCommitmentHex} — it was never funded.`);
    }
    if (substate.state !== null && typeof substate.state === "object" && !("up" in substate.state)) {
      throw new SettlementError("OUTPUT_SPENT", `The HTLC output at commitment ${req.htlcOutputCommitmentHex} has already been spent.`);
    }
    const upBody = (substate.state as { up: { substate: unknown } }).up?.substate;

    // Checklist gate 4: the relayed tree's root equals the on-chain root on the output, and
    // the tree is bound to the quote's hashLockHex (checked above via describeHtlcConditions).
    const treeRoot = conditionRootOf(req.conditions);
    const onChainRoot = findScriptRoot(upBody);
    if (onChainRoot === null || onChainRoot !== treeRoot) {
      throw new SettlementError(
        "ROOT_MISMATCH",
        `The relayed conditions root (${treeRoot}) does not match the on-chain condition root (${onChainRoot ?? "none found"}) — refusing to spend a different HTLC than the one this purchase funded.`
      );
    }

    // Checklist gates 6+7 (deviation 2): amount and destination, via the claimant's TEST view
    // key. Without it the output's value is unreadable (stealth-encrypted) — fail closed.
    if (req.claimantViewKeyHex === undefined) {
      throw new SettlementError(
        "AMOUNT_UNVERIFIABLE",
        "No claimantViewKeyHex was supplied, so the funded output's amount cannot be verified natively — failing closed. (Test stand-in only; the real indexer closes this from its own index.)"
      );
    }
    const substateId = stealthUtxoSubstateId(req.quote.resourceAddress, commitment);
    const decrypted = await this.chain.decryptOutput(substate, substateId, hexToBytes(req.claimantViewKeyHex, "claimantViewKeyHex"));
    if (decrypted === null) {
      throw new SettlementError("DEST_MISMATCH", "The funded output does not decrypt as addressed to this claimant — its destination is not the quote's claimant.");
    }
    if (decrypted.value !== BigInt(req.quote.amount)) {
      throw new SettlementError(
        "AMOUNT_MISMATCH",
        `The funded output is worth ${decrypted.value} base units but the quote says ${req.quote.amount} — refusing to settle a different amount.`
      );
    }

    // Checklist gate 2 (and gate 1's envelope half): the indexer's dry-run is the signature/
    // admissibility oracle — it decodes the sealed BOR envelope natively and aborts per-input
    // with a structured reason when the signature does not satisfy the claim leaf's AccessRule
    // or anything else is inadmissible. Any dry-run failure maps to SIGNATURE_INVALID.
    try {
      const { admissible, detail } = await this.chain.dryRun(bytesToBase64(fromHex(req.signedPayloadHex)));
      if (!admissible) {
        throw new SettlementError("SIGNATURE_INVALID", `The dry-run rejected the sealed claim: ${detail ?? "no abort reason supplied"}.`);
      }
    } catch (e) {
      if (e instanceof SettlementError) throw e;
      throw new SettlementError("SIGNATURE_INVALID", `The dry-run could not be performed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// The real chain: the public esmeralda indexer. Reads via `IndexerProvider` (no signing
// capability — spike Q1), dry-run via raw `fetch` (the SDK's own broken-`sendDryRun`
// replacement route), decrypt via the real wasm stealth crypto.
// ────────────────────────────────────────────────────────────────────────────────────────────

/** `POST {indexerUrl}/transactions/dry-run` — mirrors the ootle-sdk's own `submitDryRun` fetch
 * leg: `{ "transaction": <envelope> }`, rejection embedded in a 200's `result`, never a 4xx. */
export async function dryRunTransaction(indexerUrl: string, envelopeBase64: string): Promise<{ admissible: boolean; detail?: string }> {
  const res = await fetch(`${indexerUrl}/transactions/dry-run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: envelopeBase64 }),
  });
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    // fall through to the raw-text report below
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body?.error?.message ?? text ?? res.statusText}`);
  if (body?.error) throw new Error(`${body.error.code}: ${body.error.message}`);
  const outcome = body?.result?.finalize?.result;
  const admissible = !(typeof outcome === "object" && outcome !== null && ("Reject" in outcome || "AcceptFeeRejectRest" in outcome));
  return { admissible, detail: admissible ? undefined : JSON.stringify(outcome) };
}

/** The real-indexer `FacilitatorChain`: `IndexerProvider` reads/submit + raw dry-run + wasm decrypt. */
export async function createIndexerFacilitatorChain(indexerUrl: string, networkName: NetworkName): Promise<FacilitatorChain> {
  const network = toOotleNetwork(networkName);
  const provider = await IndexerProvider.connect({ url: indexerUrl, network });
  const crypto = new WasmStealthCrypto(network);
  return {
    getCurrentEpoch: () => provider.getCurrentEpoch(),
    getStealthUtxo: (resourceAddress, commitment) => provider.getStealthUtxo(resourceAddress, commitment),
    decryptOutput: (substate, substateId, viewSecret) => decryptOwnedUtxo(crypto, viewSecret, substate, substateId),
    dryRun: (envelopeBase64) => dryRunTransaction(indexerUrl, envelopeBase64),
    submitTransaction: (envelope) => provider.submitTransaction(envelope),
    getTransactionResult: (transactionId) => provider.getTransactionResult(transactionId),
  };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// HTTP wiring (plain `node:http`, no framework)
// ────────────────────────────────────────────────────────────────────────────────────────────

function respond(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) });
  res.end(json);
}

export function createFacilitatorServer(facilitator: X402Facilitator): http.Server {
  return http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      try {
        if (req.method === "POST" && url.pathname === "/x402/settle") {
          const text = await new Promise<string>((resolve, reject) => {
            let raw = "";
            req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
            req.on("end", () => resolve(raw));
            req.on("error", reject);
          });
          let body: unknown;
          try {
            body = text ? JSON.parse(text) : undefined;
          } catch (e) {
            throw new SettlementError("PAYLOAD_MALFORMED", `The settle body is not valid JSON (${e instanceof Error ? e.message : String(e)}).`);
          }
          respond(res, 200, await facilitator.settle(body));
          return;
        }
        const broadcast = url.pathname.match(/^\/x402\/settlement\/([0-9a-f]{64})\/broadcast$/);
        if (req.method === "POST" && broadcast) {
          const found = await facilitator.triggerBroadcast(broadcast[1]!);
          respond(res, 200, { status: found.status, txHash: found.txHash });
          return;
        }
        const poll = url.pathname.match(/^\/x402\/settlement\/([0-9a-f]{64})$/);
        if (req.method === "GET" && poll) {
          respond(res, 200, await facilitator.getSettlement(poll[1]!));
          return;
        }
        respond(res, 404, { error: "NOT_FOUND", detail: `No such route: ${req.method} ${url.pathname}` });
      } catch (e) {
        if (e instanceof SettlementError) {
          respond(res, e.code === "UNKNOWN_DIGEST" ? 404 : 400, e.toJSON());
          return;
        }
        respond(res, 500, { error: "INTERNAL", detail: e instanceof Error ? e.message : String(e) });
      }
    })();
  });
}

/** Entry point: `npx tsx e2e/facilitator/server.ts` (see e2e/facilitator/README.md). */
export async function main(): Promise<void> {
  const port = Number(process.env["X402_FACILITATOR_PORT"] ?? 4020);
  const indexerUrl = process.env["X402_INDEXER_URL"] ?? "https://ootle-indexer-a.tari.com";
  const networkName = (process.env["X402_NETWORK"] ?? "esmeralda") as NetworkName;
  const chain = await createIndexerFacilitatorChain(indexerUrl, networkName);
  const server = createFacilitatorServer(new X402Facilitator(chain));
  server.listen(port, () => {
    console.log(`x402 facilitator stand-in listening on http://127.0.0.1:${port} (indexer ${indexerUrl}, network ${networkName})`);
  });
}

if (process.argv[1]?.endsWith("server.ts")) {
  void main();
}