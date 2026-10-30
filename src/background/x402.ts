// The x402Pay validation gate: the shape/sanity checks an x402 payment-terms envelope must pass
// before the wallet ever builds an HTLC for it (background/index.ts calls these at BOTH
// boundaries -- request-creation time for a fail-fast static pass, and submit time with the live
// chain epoch). Pure logic only, no provider/storage access, so every rejection path is
// unit-testable on its own (x402.test.ts).
// The x402SignClaim gate (validateX402SignClaimTerms, below) reuses the same envelope checks for
// the settlement side; its one import from the ootle-sdk (describeHtlcConditions) is pure tree
// parsing, but does drag the SDK's module graph (and its wasm) into this file's importers --
// acceptable everywhere it is used (the background worker already imports the SDK; the tests
// want the real wasm anyway).
import type { TransactionRequestOperation, X402PayTerms } from "../lib/messages";
import { isValidOotleWalletAddress } from "../popup/format";
import { describeHtlcConditions, fromHex, toHex } from "@chironbuilder/ootle-sdk";
import { sha256 } from "@noble/hashes/sha2.js";

export type X402PayOperation = Extract<TransactionRequestOperation, { kind: "x402Pay" }>;
export type X402SignClaimOperation = Extract<TransactionRequestOperation, { kind: "x402SignClaim" }>;

/** A SHA-256 hash rendered as exactly 64 lowercase hex characters -- what the HTLC claim leaf's
 * `HashLock` atom needs, and what `htlcConditions` (ootle-sdk) drops in verbatim with no check of
 * its own. Closes the weakness security-audit-deepseek-v4-pro.md §2 flagged for `htlcFund`, at the
 * boundaries this repo controls. */
const LOWERCASE_HEX_64 = /^[0-9a-f]{64}$/;

/** Integrity/identity pins: also 32-byte hashes, but only *pinned* here and never fed to the
 * engine's condition atoms, so mixed case is tolerated and canonicalized by the consumer. */
const HEX_64 = /^[0-9a-f]{64}$/i;

/** How far ahead of the current chain epoch a refund leaf may sit. Degenerate-value backstop only
 * -- see the comment in validateX402PayTerms for why the plan's "~60 minutes of epochs" bound
 * resolved to a plain sanity cap rather than a time-derived one. */
export const X402_MAX_REFUND_EPOCHS_AHEAD = 1440;

/**
 * The hash lock and refund epoch every HTLC-funding entry point shares: `x402Pay` (via
 * `validateX402PayTerms`) and a dApp's raw `htlcFund` request (both the deprecated `tari_htlcFund`
 * wrapper and `tari_createTransactionRequest({ kind: "htlcFund", ... })`). One helper, both
 * boundaries -- the same audit finding (security-audit-deepseek-v4-pro.md §2: `htlcConditions`
 * accepts any `hashLockHex` string and only a loosely-bounded epoch) must not stay open on one
 * path just because the other got fixed. `source` names the request kind in the error so the
 * caller knows which boundary rejected it.
 */
export function validateHtlcFundTerms(terms: { hashLockHex: string; refundEpoch: string | number }, source = "htlcFund"): void {
  if (!LOWERCASE_HEX_64.test(terms.hashLockHex)) {
    throw new Error(`${source}: hashLockHex must be exactly 64 lowercase hex characters (the SHA-256 of the claim secret).`);
  }
  // `x402Pay` carries the epoch as a number, a dApp's `htlcFund` request as a decimal string --
  // both must denote a non-negative whole epoch (no fractions, no signs, no scientific notation).
  const raw = terms.refundEpoch;
  const refundEpoch = typeof raw === "string" ? (/^\d+$/.test(raw) ? Number(raw) : NaN) : raw;
  if (!Number.isInteger(refundEpoch) || refundEpoch < 0) {
    throw new Error(`${source}: refundEpoch must be a whole number of chain epochs.`);
  }
  if (!Number.isSafeInteger(refundEpoch)) {
    throw new Error(`${source}: refundEpoch is too large to be a real chain epoch.`);
  }
}

/**
 * Validates an `x402Pay` envelope's terms. Two modes, matching the two places background/index.ts
 * calls it:
 *
 * - **Static pass** (no `live` context, at `tari_createTransactionRequest` time): everything
 *   checkable without the chain -- field shapes, hex pins, address well-formedness, integer-ness.
 *   The wallet may even be locked here, so the current epoch and clock are not consulted.
 * - **Live pass** (`live` carries the indexer's current epoch and the current time, at submit
 *   time, before the execution switch): additionally insists the refund epoch is still in the
 *   future and the facilitator's quote has not expired.
 *
 * Each failure throws its OWN distinct, actionable error (house style: `requireViewAccess`'s three
 * separate denials) so a facilitator can tell "ask for a fresh quote" apart from "your hashlock
 * encoding is wrong" instead of retrying blind.
 *
 * ### How the epoch bound was resolved
 *
 * The plan asked for "refundEpoch strictly in the future, and no more than ~60 minutes of epochs
 * ahead". A chain epoch is an opaque counter here: nothing in this repo, the ootle-sdk, or the
 * indexer typings states a constant epoch duration (checked -- `getCurrentEpoch()` returns a bare
 * number), so "~60 minutes" cannot be translated into a number of epochs. Per the plan's
 * fallback, the *time* bound is therefore carried by the quote's own `expiresAt` (checked live:
 * an expired quote is refused outright), and `X402_MAX_REFUND_EPOCHS_AHEAD` remains only as a
 * generous degenerate-value backstop against the absurd epochs the audit warned about -- never
 * tight enough to reject a quote a sane facilitator would issue.
 */
export function validateX402PayTerms(
  operation: X402PayTerms,
  live?: { currentEpoch: number; nowMs: number }
): void {
  validateHtlcFundTerms({ hashLockHex: operation.hashLockHex, refundEpoch: operation.refundEpoch }, "x402Pay");
  if (live && operation.refundEpoch <= live.currentEpoch) {
    throw new Error(
      `x402Pay: refundEpoch has already passed (epoch ${operation.refundEpoch}, current epoch ${live.currentEpoch}) — the merchant can no longer claim this payment; ask the site for a fresh quote.`
    );
  }
  if (live && operation.refundEpoch - live.currentEpoch > X402_MAX_REFUND_EPOCHS_AHEAD) {
    throw new Error(
      `x402Pay: refundEpoch is too far ahead (more than ${X402_MAX_REFUND_EPOCHS_AHEAD} epochs past the current one) — this is not a sane quote.`
    );
  }
  if (!Number.isFinite(operation.expiresAt)) {
    throw new Error("x402Pay: expiresAt must be a timestamp in milliseconds since epoch.");
  }
  if (live && operation.expiresAt <= live.nowMs) {
    throw new Error("x402Pay: this quote has already expired — ask the site for a fresh quote.");
  }
  if (!/^\d+$/.test(operation.amount) || BigInt(operation.amount) <= 0n) {
    throw new Error("x402Pay: amount must be a positive whole number of base units (raw integer, no decimals or scientific notation).");
  }
  if (!isValidOotleWalletAddress(operation.claimantAddress)) {
    throw new Error("x402Pay: claimantAddress is not a valid Ootle wallet address (expected the merchant's otl_… address).");
  }
  if (operation.facilitatorPubKeyHex !== undefined && !HEX_64.test(operation.facilitatorPubKeyHex)) {
    throw new Error("x402Pay: facilitatorPubKeyHex must be exactly 64 hex characters (the indexer's identity public key).");
  }
  if (operation.resourceSha256 !== undefined && !HEX_64.test(operation.resourceSha256)) {
    throw new Error("x402Pay: resourceSha256 must be exactly 64 hex characters (the SHA-256 integrity pin for the served response).");
  }
}

// ---------------------------------------------------------------------------
// x402SignClaim -- the settlement-side gate.
//
// The merchant's wallet signs (never broadcasts) the HTLC claim for a quote the paying wallet
// funded. The preimage it seals into the payload is the merchant's proof of payment, so this
// gate is the last purely local check before anything touches the chain-facing build path
// (background/x402SignOnly.ts, which additionally runs the SDK's own pre-reveal `verifyHtlc`
// against live chain state). Two deliberate differences from the x402Pay live pass:
//
// - **Only the refund epoch bounds a claim.** The quote's `expiresAt` gates whether a *quote*
//   may be accepted, not whether an already-funded HTLC may be settled: a merchant can
//   legitimately settle slightly after the quote lapsed, as long as the payer cannot have
//   refunded yet. So the live pass here checks `refundEpoch` alone.
// - **The field set is fixed, structurally.** `x402SignClaim` builds ONLY the HTLC claim
//   statement -- one StealthTransfer spending exactly the funded output into the claimant's
//   own fresh output -- so any `instructions`/`followUpInstructions` key, or any key at all
//   outside the five this kind defines, is rejected before anything is parsed further. A dApp
//   can never smuggle extra value-moving instructions into a payload the user is told only
//   signs a claim.
// ---------------------------------------------------------------------------

/** The fixed field set of the `x402SignClaim` kind -- nothing else may ride along. */
const SIGN_CLAIM_FIELDS = new Set(["kind", "envelope", "preimageHex", "htlcOutputCommitmentHex", "conditions"]);

/** 32-byte values in hex, case-tolerated (canonicalized by the consumers, not fed to atoms). */
const HEX_64_ANY_CASE = /^[0-9a-f]{64}$/i;

export function validateX402SignClaimTerms(operation: X402SignClaimOperation, live?: { currentEpoch: number }): void {
  // Structural boundary first: the built tx must not move any funds other than the HTLC output
  // into the claimant's destination, so this kind accepts no instruction arrays at all -- and
  // no unknown keys either (a future field is a decision, not a smuggler's free pass).
  if ("instructions" in operation || "followUpInstructions" in operation) {
    throw new Error(
      "x402SignClaim accepts no `instructions` or `followUpInstructions` fields -- it builds only the HTLC claim statement, and the built tx must move nothing but the HTLC output into the claimant's destination."
    );
  }
  const unexpected = Object.keys(operation).filter((key) => !SIGN_CLAIM_FIELDS.has(key));
  if (unexpected.length > 0) {
    throw new Error(`x402SignClaim: unexpected fields (${unexpected.sort().join(", ")}) — the kind's field set is fixed by design.`);
  }

  // The envelope is the exact quote the paying wallet funded -- the same gate as x402Pay's
  // static pass (shape, hashlock encoding, epoch sanity, amount, claimant well-formedness).
  validateX402PayTerms(operation.envelope);

  if (typeof operation.preimageHex !== "string" || !HEX_64_ANY_CASE.test(operation.preimageHex)) {
    throw new Error("x402SignClaim: preimageHex must be exactly 64 hex characters (32 bytes).");
  }
  // Hash the preimage BEFORE anything is built: sealing a claim whose preimage doesn't open
  // the hashlock would hand the facilitator a payload that can never settle.
  if (toHex(sha256(fromHex(operation.preimageHex))) !== operation.envelope.hashLockHex) {
    throw new Error("x402SignClaim: the preimage does not hash to the quote's hashLockHex — refusing to sign a claim that cannot be settled.");
  }

  if (typeof operation.htlcOutputCommitmentHex !== "string" || !HEX_64_ANY_CASE.test(operation.htlcOutputCommitmentHex)) {
    throw new Error("x402SignClaim: htlcOutputCommitmentHex must be exactly 64 hex characters (the funded output's commitment).");
  }

  // The relayed conditions tree must BE this quote's HTLC: only its root is on-chain, so the
  // tree is the claimant's only way to know which output to spend -- and a tree that disagrees
  // with the quote means the caller is trying to settle a different HTLC than the one this
  // purchase funded.
  if (!Array.isArray(operation.conditions) || operation.conditions.length < 2 || !operation.conditions[0]) {
    throw new Error(
      "x402SignClaim: conditions must be the two-leaf [claim, refund] tree the paying wallet relayed (htlcFund's result) -- it cannot be recovered from the chain alone."
    );
  }
  let described: { hashLockHex: string; refundEpoch: bigint };
  try {
    described = describeHtlcConditions(operation.conditions);
  } catch {
    throw new Error(
      "x402SignClaim: conditions must be the two-leaf [claim, refund] tree the paying wallet relayed (htlcFund's result) -- it cannot be recovered from the chain alone."
    );
  }
  if (described.hashLockHex.toLowerCase() !== operation.envelope.hashLockHex) {
    throw new Error("x402SignClaim: the relayed conditions tree's hash lock does not match the quote's hashLockHex — refusing to spend a different HTLC than the one this purchase funded.");
  }
  if (described.refundEpoch !== BigInt(operation.envelope.refundEpoch)) {
    throw new Error("x402SignClaim: the relayed conditions tree's refund epoch does not match the quote's refundEpoch — the payer's refund window and the claim must agree.");
  }

  if (live && operation.envelope.refundEpoch <= live.currentEpoch) {
    throw new Error(
      `x402SignClaim: the quote's refund epoch has already passed (epoch ${operation.envelope.refundEpoch}, current epoch ${live.currentEpoch}) -- the payer may already have refunded; there is nothing left to claim.`
    );
  }
}
