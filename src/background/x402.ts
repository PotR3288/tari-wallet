// The x402Pay validation gate: the shape/sanity checks an x402 payment-terms envelope must pass
// before the wallet ever builds an HTLC for it (background/index.ts calls these at BOTH
// boundaries -- request-creation time for a fail-fast static pass, and submit time with the live
// chain epoch). Pure logic only, no provider/storage access, so every rejection path is
// unit-testable on its own (x402.test.ts).
import type { TransactionRequestOperation } from "../lib/messages";
import { isValidOotleWalletAddress } from "../popup/format";

export type X402PayOperation = Extract<TransactionRequestOperation, { kind: "x402Pay" }>;

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
  operation: X402PayOperation,
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
