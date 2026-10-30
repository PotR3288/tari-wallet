// The x402 signed-unbroadcast claim build path: the merchant's (claimant's) wallet builds,
// signs and seals the HTLC claim for a quote the paying wallet funded -- and STOPS. The sealed
// payload is returned to the caller for delivery to the indexer facilitator, which validates it
// natively and broadcasts at settle. Nothing in this module submits, preflights, or otherwise
// lets the preimage touch the network before the facilitator does.
//
// This is a deliberate transliteration of the ootle-sdk's own internal claim pipeline
// (`OotleAccount.htlcClaim` -> `buildHtlcSpendStatement` -> the module-private
// `buildHtlcSpendEnvelope`, wallet.js:2202/3424/3452 in @chironbuilder/ootle-sdk@0.1.30) with
// the submit and everything after it removed -- the Route-A verdict of the Task 2.2 spike: the
// published SDK exports every primitive needed, so no vendor patching. Two hard constraints
// from that spike, both enforced here:
//
// 1. **No preflight.** The SDK's claim path dry-runs the exact claim before submitting, which
//    POSTs the fully-signed transaction *including the preimage* to the indexer's dry-run
//    endpoint (wallet.d.ts:791-796). The preimage is the merchant's proof of payment and must
//    never reach the indexer before settle -- so this path never sets `dry_run` and never calls
//    the SDK's `dryRunEnvelope`.
// 2. **Transparent fee for v1.** The private-fee lane (`resolvePrivateFee`/`buildPrivateFeeInstructions`
//    + the internal `feeSigner`) is private to OotleAccount. A no-submit claim paying the fee
//    privately needs a small SDK-side export of `buildHtlcSpendEnvelope` (~10 lines, no wasm,
//    no vendor work) -- noted as future work, not attempted here.
//
// Every rejection before the seal is a distinct, actionable error (house style), and the SDK's
// own pre-reveal safety gate (`verifyHtlc`: terms, ownership, on-chain root, preimage hash,
// claim-admissible epochs) still runs against live chain state first — this module adds the
// wallet-boundary checks on top, it does not replace them.
import type { TransactionRequestOperation, X402SignedClaimPayload } from "../lib/messages";
import { validateX402SignClaimTerms, type X402SignClaimOperation } from "./x402";
import { buildHtlcSpendStatement, describeHtlcConditions, fromHex } from "@chironbuilder/ootle-sdk";
import type { HtlcExpectations } from "@chironbuilder/ootle-sdk";
import {
  TransactionBuilder,
  WasmStealthCrypto,
  decryptOwnedUtxo,
  getVaultIdsForAccount,
  resolveMaxEpoch,
  resolveTransaction,
  sealTransaction,
  signTransaction,
  stealthUtxoSubstateId,
} from "@tari-project/ootle";
import type { Network, Provider, Signer } from "@tari-project/ootle";
import type { IndexerGetSubstateResponse, InputDeclaration } from "@tari-project/ootle-ts-bindings";
import { sha256 } from "@noble/hashes/sha2.js";

export type { X402SignClaimOperation };

/**
 * The chain-facing surface `buildSignedX402Claim` needs: the same three reads the SDK's own
 * claim path makes (substate fetch, current epoch, input resolution) and nothing more, so the
 * full build path is exercisable offline against a stub (x402SignOnly.test.ts) while the real
 * `IndexerProvider` satisfies it structurally in the worker.
 */
export interface X402ClaimChain {
  getSubstate(substateId: string): Promise<unknown>;
  getCurrentEpoch(): Promise<number>;
  resolveInputs(inputs: InputDeclaration[]): Promise<InputDeclaration[]>;
}

/** A `Signer` that can also hand over its view secret -- exactly what `OotleAccount.signer`
 * (a `SecretKeyWallet`) is, and what decrypting the HTLC input needs. */
export type X402ClaimSigner = Signer & { getViewSecret(): Promise<Uint8Array> };

/**
 * The account surface `buildSignedX402Claim` needs. A seed-derived `OotleAccount` satisfies
 * this structurally (public `network`/`signer` fields, public `getWalletAddress`/
 * `getComponentAddress`/`getProvider`/`verifyHtlc` methods); it is spelled out as its own
 * interface so the build path is testable without a service worker or a live indexer.
 */
export interface X402ClaimSignerAccount {
  network: Network;
  signer: X402ClaimSigner;
  getWalletAddress(): Promise<string>;
  getComponentAddress(): Promise<string>;
  getProvider(): Promise<X402ClaimChain>;
  verifyHtlc(
    resourceAddress: string,
    commitmentHex: string,
    conditions: object[],
    expected?: HtlcExpectations,
    preimageHex?: string
  ): Promise<{ ok: boolean; problems: string[]; value: bigint | null; currentEpoch: bigint }>;
}

/** The claim statement the wasm assembles for one HTLC claim: inputs statement (the script-path
 * witness revealing the claim leaf + preimage), outputs statement (the claimant's fresh
 * key-spendable output), balance proof, and the covenant claim — one `StealthTransfer`
 * statement the real `validateStealthTransfer` accepts. Thin wrapper over the SDK's exported
 * `buildHtlcSpendStatement` (which itself runs that validation before returning); exposed
 * separately so the round-trip is directly testable against the real wasm. */
export function buildX402ClaimStatement(params: {
  network: Network;
  conditions: object[];
  preimageHex: string;
  /** The spent output's blinding factor, hex — recovered by decrypting the on-chain output. */
  mask: string;
  value: bigint;
  /** The claimant's own wallet address — the fresh output is addressed to the signer itself. */
  destinationWalletAddress: string;
  resourceAddress: string;
}): string {
  // Hygiene fix (review M4): this function is exported -- the real-wasm round-trip test drives
  // it directly -- so it must not lean on `validateX402SignClaimTerms` having already checked the
  // tree. Chosen over making it module-private so the round-trip stays directly testable; the
  // cost is this re-check, which is the SDK's own parser: if `describeHtlcConditions` cannot read
  // the tree as a two-leaf [claim, refund] HTLC, no claim statement can be built from it.
  if (!Array.isArray(params.conditions) || params.conditions.length < 2 || !params.conditions[0]) {
    throw new Error(
      "x402SignClaim: conditions must be the two-leaf [claim, refund] tree the paying wallet relayed (htlcFund's result) -- it cannot be recovered from the chain alone."
    );
  }
  try {
    describeHtlcConditions(params.conditions);
  } catch {
    throw new Error(
      "x402SignClaim: conditions must be the two-leaf [claim, refund] tree the paying wallet relayed (htlcFund's result) -- it cannot be recovered from the chain alone."
    );
  }
  const claimLeaf = params.conditions[0];
  return buildHtlcSpendStatement({
    network: params.network,
    conditions: params.conditions,
    leaf: claimLeaf,
    data: fromHex(params.preimageHex),
    mask: params.mask,
    value: params.value,
    destinationWalletAddress: params.destinationWalletAddress,
    resourceAddress: params.resourceAddress,
  });
}

/**
 * Input dedupe, transliterated verbatim from the ootle-sdk's module-private `dedupeInputs`
 * (wallet.js:3838 in @chironbuilder/ootle-sdk@0.1.30 — exported from the wallet module but not
 * from the package index): resolveTransaction's auto-resolve can surface the same substate
 * twice (e.g. the account component both as a fee source and a vault container), and a
 * duplicate input would make the sealed payload invalid at broadcast time.
 */
function dedupeInputs(inputs: InputDeclaration[]): InputDeclaration[] {
  const byId = new Map<string, InputDeclaration>();
  for (const input of inputs) {
    const existing = byId.get(input.substate_id);
    if (!existing) {
      byId.set(input.substate_id, { ...input });
      continue;
    }
    if (input.is_write) existing.is_write = true;
    if (existing.version === null && input.version !== null) existing.version = input.version;
  }
  return [...byId.values()];
}

/**
 * The envelope half of the SDK's module-private `buildHtlcSpendEnvelope` (wallet.js:3452),
 * transparent-fee branch only: one `StealthTransfer` instruction carrying the claim statement
 * verbatim as raw JSON (the `__ootleRawJson` splice — u64 fields must never round-trip through
 * a JS number), spending the HTLC UTXO, fee paid from the account's revealed balance. Seals and
 * returns the BOR envelope (base64, as `sealTransaction` emits) — never submits, never dry-runs.
 */
async function sealClaimEnvelope(params: {
  chain: X402ClaimChain;
  network: Network;
  componentAddress: string;
  substateId: string;
  resourceAddress: string;
  statementJson: string;
  signer: Signer;
  maxFee: bigint;
}): Promise<string> {
  const provider = params.chain as unknown as Provider;
  const maxEpoch = await resolveMaxEpoch(provider);
  const builder = TransactionBuilder.new(params.network, maxEpoch)
    .addInput({ substate_id: params.substateId, version: null })
    .addInput({ substate_id: params.componentAddress, version: null })
    // `statement` is spliced as a raw JSON fragment (see buildHtlcSpendStatement's own doc
    // comment: u64 fields must never round-trip through a JS number) -- the same technique
    // @tari-project/ootle's own `statementAsWire` uses internally, so this cast mirrors the
    // SDK's exactly (the engine understands `__ootleRawJson`; the TS bindings do not).
    .addInstruction({
      StealthTransfer: {
        resource_address_ref: { Address: params.resourceAddress },
        statement: { __ootleRawJson: params.statementJson },
        revealed_input_bucket: null,
      },
    } as unknown as Parameters<typeof builder.addInstruction>[0]);
  // Transparent fee only for v1 -- see the module header (constraint 2).
  builder.feeTransactionPayFromComponent(params.componentAddress, params.maxFee);
  for (const vaultId of await getVaultIdsForAccount(provider, params.componentAddress)) {
    builder.addInput({ substate_id: vaultId, version: null });
  }
  const unsigned = builder.buildUnsignedTransaction();
  // Never a dry run: dry-running POSTs the signed transaction (preimage included) to the
  // indexer -- the one network disclosure this whole module exists to prevent.
  unsigned.dry_run = false;
  const unsignedTx = await resolveTransaction(provider, unsigned);
  unsignedTx.inputs = dedupeInputs(unsignedTx.inputs);
  const signed = await signTransaction([params.signer], unsignedTx);
  return sealTransaction(signed);
}

/** base64 -> bytes, without Node's Buffer (this also runs in a service worker). */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Assembles the final `X402SignedClaimPayload` from a sealed envelope: the BOR bytes as
 * lowercase hex, the locally-computed SHA-256 digest of exactly those bytes as `txHash`, and
 * the quote's epochs echoed back. Pure, so the response shape is testable without any chain.
 */
export function finalizeSignedClaim(sealedEnvelopeBase64: string, htlcOutputCommitmentHex: string, refundEpoch: number): X402SignedClaimPayload {
  const envelopeBytes = base64ToBytes(sealedEnvelopeBase64);
  return {
    signedPayloadHex: bytesToHex(envelopeBytes),
    txHash: bytesToHex(sha256(envelopeBytes)),
    htlcOutputCommitment: htlcOutputCommitmentHex.toLowerCase(),
    refundEpoch,
    validUntilEpoch: refundEpoch - 1,
  };
}

/**
 * Builds, signs and seals the x402 HTLC claim — and stops. The wallet never broadcasts the
 * result; the caller hands it to the indexer facilitator, which validates it natively and
 * submits at settle. `account` must be the quote's own claimant (the merchant's seed-derived
 * local account — the claim needs its view secret to decrypt the funded output and its owner
 * signature to satisfy the claim leaf's AccessRule).
 *
 * Order of operations, each gate before the next:
 * 1. `validateX402SignClaimTerms` static pass (envelope terms, preimage-hash, conditions-vs-quote,
 *    structural field set).
 * 2. Live refund-epoch pass against the chain's current epoch.
 * 3. Claimant identity: this account's wallet address must BE the quote's `claimantAddress`.
 * 4. The SDK's `verifyHtlc` pre-reveal safety gate (ownership, amount, on-chain root, preimage
 *    hash, claim-admissible epochs) — the same check `htlcClaim` runs before it reveals anything.
 * 5. On-chain decrypt of the funded output; its recovered value must equal the quote's amount.
 * 6. Only then: statement (real wasm, self-validating), envelope, sign, seal.
 */
export async function buildSignedX402Claim(
  account: X402ClaimSignerAccount,
  operation: X402SignClaimOperation
): Promise<X402SignedClaimPayload> {
  validateX402SignClaimTerms(operation);
  const { envelope, preimageHex, htlcOutputCommitmentHex, conditions } = operation;

  const chain = await account.getProvider();
  validateX402SignClaimTerms(operation, { currentEpoch: await chain.getCurrentEpoch() });

  const walletAddress = await account.getWalletAddress();
  if (walletAddress !== envelope.claimantAddress) {
    throw new Error("x402SignClaim: this account is not the quote's claimant — only the merchant's own wallet may sign the claim.");
  }

  const verification = await account.verifyHtlc(
    envelope.resourceAddress,
    htlcOutputCommitmentHex,
    conditions,
    { amount: BigInt(envelope.amount), hashLockHex: envelope.hashLockHex, refundEpoch: BigInt(envelope.refundEpoch) },
    preimageHex
  );
  if (!verification.ok) {
    throw new Error(`x402SignClaim: the funded HTLC does not match the quote — ${verification.problems.join("; ")}`);
  }

  const substateId = stealthUtxoSubstateId(envelope.resourceAddress, fromHex(htlcOutputCommitmentHex));
  const decrypted = await decryptOwnedUtxo(
    new WasmStealthCrypto(account.network),
    await account.signer.getViewSecret(),
    (await chain.getSubstate(substateId)) as IndexerGetSubstateResponse,
    substateId
  );
  if (!decrypted) {
    throw new Error("x402SignClaim: the HTLC output no longer decrypts — it may have just been claimed or refunded.");
  }
  if (decrypted.value !== BigInt(envelope.amount)) {
    throw new Error(`x402SignClaim: the funded output is worth ${decrypted.value} but the quote says ${envelope.amount} — refusing to sign a claim for a different amount.`);
  }

  const statementJson = buildX402ClaimStatement({
    network: account.network,
    conditions,
    preimageHex,
    mask: decrypted.mask.toHex(),
    value: decrypted.value,
    destinationWalletAddress: walletAddress,
    resourceAddress: envelope.resourceAddress,
  });

  const componentAddress = await account.getComponentAddress();
  const maxFee = envelope.maxFee !== undefined ? BigInt(envelope.maxFee) : 50000n; // htlcClaim's own default.
  const sealed = await sealClaimEnvelope({
    chain,
    network: account.network,
    componentAddress,
    substateId,
    resourceAddress: envelope.resourceAddress,
    statementJson,
    signer: account.signer,
    maxFee,
  });
  return finalizeSignedClaim(sealed, htlcOutputCommitmentHex, envelope.refundEpoch);
}
