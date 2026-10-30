// The facilitator stand-in's validation matrix, unit-tested against a fake `FacilitatorChain`
// (the same injected-chain pattern `src/background/x402SignOnly.test.ts` uses for the wallet's
// build path) with the real wasm everywhere else: the two-leaf tree is built by the real
// `htlcConditions`, its root by the real `conditionRootOf`, and every gate's expected value is
// derived from the real crypto — never hand-asserted. No live indexer calls anywhere: reads,
// the dry-run, the broadcast and the result poll are all faked.
import { afterAll, describe, expect, it } from "vitest";
import { bytesToBase64, createFacilitatorServer, localDigestOf, X402Facilitator, type FacilitatorChain } from "./server";
import type { X402ErrorCode, X402SettleRequest } from "./server";
import { conditionRootOf, fromHex, htlcConditions, toHex } from "@chironbuilder/ootle-sdk";
import { generateOotleAddress, generateOotleSecretKey, ootlePublicKeyFromSecretKey } from "@tari-project/ootle-wasm";
import { toOotleNetwork } from "@chironbuilder/ootle-sdk";
import type { DecryptedData, IndexerGetSubstateResponse } from "@tari-project/ootle";
import { sha256 } from "@noble/hashes/sha2.js";
import type { X402PayTerms } from "../../src/lib/messages";

const RES = "resource_0101010101010101010101010101010101010101010101010101010101010101";
const AMOUNT = 1_000_000n;
const PREIMAGE_HEX = "cd".repeat(32);
const HASHLOCK_HEX = toHex(sha256(fromHex(PREIMAGE_HEX)));
const CURRENT_EPOCH = 500;
const REFUND_EPOCH = CURRENT_EPOCH + 500;
const CHAIN_TX_ID = "tx_5150" + "ee".repeat(15);
const NOW = 1_000_000;

const claimantKeys = generateOotleSecretKey();
const refunderKeys = generateOotleSecretKey();
const claimantPub = ootlePublicKeyFromSecretKey(claimantKeys.owner_key, claimantKeys.view_key);
const refunderPub = ootlePublicKeyFromSecretKey(refunderKeys.owner_key, refunderKeys.view_key);
const CLAIMANT_VIEW_KEY_HEX = toHex(claimantKeys.view_key);
const NETWORK = toOotleNetwork("esmeralda");
const CLAIMANT_ADDRESS = generateOotleAddress(claimantPub.owner_key, claimantPub.view_key, NETWORK);

// The real two-leaf [claim, refund] tree for this quote, and its real on-chain root.
const conditions = htlcConditions({
  hashLockHex: HASHLOCK_HEX,
  refundEpoch: BigInt(REFUND_EPOCH),
  claimantPublicKeyHex: toHex(claimantPub.owner_key),
  refunderPublicKeyHex: toHex(refunderPub.owner_key),
});
const TREE_ROOT = conditionRootOf(conditions);

// The "on-chain" HTLC output: a fabricated UTXO body whose spend authorization commits to
// exactly the tree above (what a real fund would have written at creation time).
function utxoSubstate(scriptRoot: string = TREE_ROOT): IndexerGetSubstateResponse {
  const output = { public_nonce: "ab".repeat(32), spend_authorization: { Script: scriptRoot } };
  return {
    state: {
      up: {
        substate: {
          Utxo: {
            output: {
              output,
            },
          },
        },
      },
    },
  } as unknown as IndexerGetSubstateResponse;
}

function baseQuote(overrides: Partial<X402PayTerms> = {}): X402PayTerms {
  return {
    resourceUrl: "https://merchant.example/paid.txt",
    amount: AMOUNT.toString(),
    resourceAddress: RES,
    claimantAddress: CLAIMANT_ADDRESS,
    hashLockHex: HASHLOCK_HEX,
    refundEpoch: REFUND_EPOCH,
    facilitatorUrl: "http://127.0.0.1:4020/x402/settle",
    expiresAt: NOW + 60 * 60 * 1000,
    ...overrides,
  };
}

function decryptResult(value: bigint): DecryptedData {
  return { value, mask: new Uint8Array(32) } as unknown as DecryptedData;
}

/** A fake chain with call counters, the same reads the real chain makes, and per-test overrides. */
function makeFakeChain(overrides: Partial<FacilitatorChain> = {}) {
  const calls = { dryRun: 0, submit: 0, getStealthUtxo: 0, decrypt: 0 };
  const chain: FacilitatorChain = {
    getCurrentEpoch: async () => CURRENT_EPOCH,
    getStealthUtxo: async () => (calls.getStealthUtxo++, utxoSubstate()),
    decryptOutput: async () => (calls.decrypt++, decryptResult(AMOUNT)),
    dryRun: async () => (calls.dryRun++, { admissible: true }),
    submitTransaction: async () => (calls.submit++, { transaction_id: CHAIN_TX_ID }),
    getTransactionResult: async () => ({
      result: {
        Finalized: {
          final_decision: "Commit",
          execution_result: null,
          execution_time: { secs: 0, nanos: 0 },
          finalized_time: new Date(0).toISOString(),
          abort_details: null,
        },
      },
    }),
    ...overrides,
  };
  return { chain, calls };
}

function baseRequest(overrides: Partial<X402SettleRequest> = {}): X402SettleRequest {
  return {
    signedPayloadHex: "ab".repeat(300), // opaque sealed bytes; only the digest and dry-run see through it
    quote: baseQuote(),
    htlcOutputCommitmentHex: "1f".repeat(32),
    conditions,
    validUntilEpoch: REFUND_EPOCH - 1,
    preimageHex: PREIMAGE_HEX,
    claimantViewKeyHex: CLAIMANT_VIEW_KEY_HEX,
    ...overrides,
  };
}

const servers: import("node:http").Server[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

/** Starts the facilitator's real HTTP surface on an ephemeral port. */
async function startServer(chain: FacilitatorChain) {
  const server = createFacilitatorServer(new X402Facilitator(chain, () => NOW));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  return `http://127.0.0.1:${address.port}`;
}

/** Settles via the class surface and asserts the rejection is exactly `code`. */
async function expectReject(chain: FacilitatorChain, request: unknown, code: X402ErrorCode) {
  const facilitator = new X402Facilitator(chain, () => NOW);
  await expect(facilitator.settle(request)).rejects.toMatchObject({ code });
}

// ── validation matrix: one test per distinct error code ────────────────────────────────────

describe("validation matrix (one distinct error per rejection cause)", () => {
  it("PAYLOAD_MALFORMED: missing required field", async () => {
    const { chain } = makeFakeChain();
    await expectReject(chain, { ...baseRequest(), htlcOutputCommitmentHex: undefined }, "PAYLOAD_MALFORMED");
  });

  it("PAYLOAD_MALFORMED: signedPayloadHex is not lowercase hex", async () => {
    const { chain } = makeFakeChain();
    await expectReject(chain, baseRequest({ signedPayloadHex: "XYZ!" }), "PAYLOAD_MALFORMED");
  });

  it("PAYLOAD_MALFORMED: odd-length hex", async () => {
    const { chain } = makeFakeChain();
    await expectReject(chain, baseRequest({ signedPayloadHex: "abc" }), "PAYLOAD_MALFORMED");
  });

  it("PAYLOAD_MALFORMED: conditions is not a two-leaf tree", async () => {
    const { chain } = makeFakeChain();
    await expectReject(chain, baseRequest({ conditions: [{ not: "an HTLC" }] }), "PAYLOAD_MALFORMED");
  });

  it("QUOTE_MISMATCH: the quote fails the wallet's own x402Pay gate (uppercase hashLockHex)", async () => {
    const { chain } = makeFakeChain();
    await expectReject(chain, baseRequest({ quote: baseQuote({ hashLockHex: HASHLOCK_HEX.toUpperCase() }) }), "QUOTE_MISMATCH");
  });

  it("QUOTE_MISMATCH: stale quote (expiresAt lapsed)", async () => {
    const { chain } = makeFakeChain();
    await expectReject(chain, baseRequest({ quote: baseQuote({ expiresAt: NOW - 1 }) }), "QUOTE_MISMATCH");
  });

  it("QUOTE_MISMATCH: relayed tree's hash lock differs from the quote", async () => {
    const { chain } = makeFakeChain();
    const otherTree = htlcConditions({
      hashLockHex: toHex(sha256(fromHex("ef".repeat(32)))),
      refundEpoch: BigInt(REFUND_EPOCH),
      claimantPublicKeyHex: toHex(claimantPub.owner_key),
      refunderPublicKeyHex: toHex(refunderPub.owner_key),
    });
    await expectReject(chain, baseRequest({ conditions: otherTree }), "QUOTE_MISMATCH");
  });

  it("QUOTE_MISMATCH: validUntilEpoch violates the refundEpoch - 1 convention", async () => {
    const { chain } = makeFakeChain();
    await expectReject(chain, baseRequest({ validUntilEpoch: REFUND_EPOCH }), "QUOTE_MISMATCH");
  });

  it("EPOCH_PASSED: current epoch is at the refund epoch", async () => {
    const { chain } = makeFakeChain({ getCurrentEpoch: async () => REFUND_EPOCH });
    await expectReject(chain, baseRequest(), "EPOCH_PASSED");
  });

  it("PREIMAGE_MISMATCH: the preimage does not hash to hashLockHex", async () => {
    const { chain } = makeFakeChain();
    await expectReject(chain, baseRequest({ preimageHex: "00".repeat(32) }), "PREIMAGE_MISMATCH");
  });

  it("OUTPUT_MISSING: no UTXO exists at the relayed commitment", async () => {
    const { chain } = makeFakeChain({ getStealthUtxo: async () => null });
    await expectReject(chain, baseRequest(), "OUTPUT_MISSING");
  });

  it("OUTPUT_SPENT: the UTXO substate is Down", async () => {
    const { chain } = makeFakeChain({ getStealthUtxo: async () => ({ state: { down: {} } }) as unknown as IndexerGetSubstateResponse });
    await expectReject(chain, baseRequest(), "OUTPUT_SPENT");
  });

  it("ROOT_MISMATCH: on-chain root differs from the relayed tree's root", async () => {
    const { chain } = makeFakeChain({ getStealthUtxo: async () => utxoSubstate("7e".repeat(32)) });
    await expectReject(chain, baseRequest(), "ROOT_MISMATCH");
  });

  it("ROOT_MISMATCH: output body commits to no script root at all", async () => {
    const { chain } = makeFakeChain({ getStealthUtxo: async () => ({ state: { up: { substate: { Utxo: { output: { output: { public_nonce: "ab".repeat(32) } } } } } } }) as unknown as IndexerGetSubstateResponse });
    await expectReject(chain, baseRequest(), "ROOT_MISMATCH");
  });

  it("AMOUNT_UNVERIFIABLE: no claimant view key rides along — fail closed", async () => {
    const { chain, calls } = makeFakeChain();
    await expectReject(chain, baseRequest({ claimantViewKeyHex: undefined }), "AMOUNT_UNVERIFIABLE");
    expect(calls.dryRun).toBe(0); // failed closed before the dry-run
  });

  it("DEST_MISMATCH: the output does not decrypt as addressed to the claimant", async () => {
    const { chain } = makeFakeChain({ decryptOutput: async () => null });
    await expectReject(chain, baseRequest(), "DEST_MISMATCH");
  });

  it("AMOUNT_MISMATCH: decrypted value differs from the quote's amount", async () => {
    const { chain } = makeFakeChain({ decryptOutput: async () => decryptResult(AMOUNT + 1n) });
    await expectReject(chain, baseRequest(), "AMOUNT_MISMATCH");
  });

  it("SIGNATURE_INVALID: the dry-run rejects the sealed claim", async () => {
    const { chain } = makeFakeChain({
      dryRun: async () => ({ admissible: false, detail: "ScriptPath: invalid signature" }),
    });
    await expectReject(chain, baseRequest(), "SIGNATURE_INVALID");
  });

  it("SIGNATURE_INVALID: the dry-run endpoint itself fails", async () => {
    const { chain } = makeFakeChain({ dryRun: async () => { throw new Error("HTTP 503"); } });
    await expectReject(chain, baseRequest(), "SIGNATURE_INVALID");
  });

  it("UNKNOWN_DIGEST: GET for a digest that was never settled", async () => {
    const { chain } = makeFakeChain();
    const facilitator = new X402Facilitator(chain, () => NOW);
    await expect(facilitator.getSettlement("ee".repeat(32))).rejects.toMatchObject({ code: "UNKNOWN_DIGEST" });
  });
});

// ── hold state machine ─────────────────────────────────────────────────────────────────────

describe("hold state machine", () => {
  it("happy path: held -> idempotent re-POST -> broadcast -> confirmed, with a mocked submit", async () => {
    let epoch = CURRENT_EPOCH;
    const { chain, calls } = makeFakeChain({
      getCurrentEpoch: async () => epoch,
    });
    const facilitator = new X402Facilitator(chain, () => NOW);
    const request = baseRequest();

    const settled = await facilitator.settle(request);
    expect(settled).toEqual({ localDigest: localDigestOf(request.signedPayloadHex), status: "held" });
    expect(calls.dryRun).toBe(1);

    // Idempotent re-POST on the same localDigest: same status response, NO re-validation.
    const rePosted = await facilitator.settle(baseRequest());
    expect(rePosted).toEqual(settled);
    expect(calls.dryRun).toBe(1);
    expect(calls.submit).toBe(0);
    expect((await facilitator.getSettlement(settled.localDigest)).status).toBe("held");

    // The merchant confirms settle: broadcast via the mocked submit, then poll to confirmed.
    const broadcast = await facilitator.triggerBroadcast(settled.localDigest);
    expect(broadcast).toEqual({ status: "broadcast", txHash: CHAIN_TX_ID });
    expect(calls.submit).toBe(1);
    await viWaitUntil(async () => (await facilitator.getSettlement(settled.localDigest)).status === "confirmed");
    expect((await facilitator.getSettlement(settled.localDigest)).txHash).toBe(CHAIN_TX_ID);

    // Re-triggering broadcast is a no-op: the claim is already in flight/settled.
    await facilitator.triggerBroadcast(settled.localDigest);
    expect(calls.submit).toBe(1);
  });

  it("expiry: a held payload past its refund epoch is expired, never broadcast", async () => {
    let epoch = CURRENT_EPOCH;
    const { chain, calls } = makeFakeChain({ getCurrentEpoch: async () => epoch });
    const facilitator = new X402Facilitator(chain, () => NOW);
    const settled = await facilitator.settle(baseRequest());
    expect(settled.status).toBe("held");

    epoch = REFUND_EPOCH; // the chain moves on; the claim leaf (BeforeEpoch) is no longer admissible
    expect(await facilitator.getSettlement(settled.localDigest)).toMatchObject({ status: "expired" });

    // expired is terminal: the merchant's late settle confirmation is refused, nothing submits.
    expect(await facilitator.triggerBroadcast(settled.localDigest)).toMatchObject({ status: "expired" });
    expect(calls.submit).toBe(0);
    // ... and it stays terminal (never resurrected).
    expect(await facilitator.getSettlement(settled.localDigest)).toMatchObject({ status: "expired" });
  });
});

// ── the HTTP surface itself (plain node:http) ───────────────────────────────────────────────

describe("HTTP surface", () => {
  it("routes settle/settlement/broadcast and maps structured errors to statuses", async () => {
    const { chain } = makeFakeChain();
    const baseUrl = await startServer(chain);
    const request = baseRequest();

    const settle = await fetch(`${baseUrl}/x402/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(settle.status).toBe(200);
    const settled = (await settle.json()) as { localDigest: string; status: string };
    expect(settled.status).toBe("held");

    const poll = await fetch(`${baseUrl}/x402/settlement/${settled.localDigest}`);
    expect(poll.status).toBe(200);
    expect((await poll.json()) as object).toEqual({ status: "held" });

    const notJson = await fetch(`${baseUrl}/x402/settle`, { method: "POST", body: "{{not json" });
    expect(notJson.status).toBe(400);
    expect(((await notJson.json()) as { error: string }).error).toBe("PAYLOAD_MALFORMED");

    const unknown = await fetch(`${baseUrl}/x402/settlement/${"0e".repeat(32)}`);
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: string }).error).toBe("UNKNOWN_DIGEST");

    const broadcast = await fetch(`${baseUrl}/x402/settlement/${settled.localDigest}/broadcast`, { method: "POST" });
    expect(broadcast.status).toBe(200);
    expect((await broadcast.json()) as object).toEqual({ status: "broadcast", txHash: CHAIN_TX_ID });
  });

  it("localDigest is the SHA-256 of the sealed envelope's bytes, base64 round-trips them", () => {
    const request = baseRequest();
    const digest = localDigestOf(request.signedPayloadHex);
    expect(digest).toBe(toHex(sha256(fromHex(request.signedPayloadHex))));
    expect(bytesToBase64(fromHex(request.signedPayloadHex))).toBe(
      Buffer.from(fromHex(request.signedPayloadHex)).toString("base64")
    );
  });
});

/** Tiny bounded wait helper (vitest's `vi.waitFor` needs fake timers or long real timeouts). */
async function viWaitUntil(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("viWaitUntil: timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}