import type { X402PaymentRecord, X402Quote } from "./types.js";

/**
 * One distinct error per rejection cause — never a shared "invalid request" bucket —
 * mirroring the facilitator spec's error contract and the wallet's own house rule.
 * Callers discriminate on `name` (or `instanceof`).
 */

/** A 402 response carrying a valid quote: payment is required before the resource is served. */
export class X402PaymentRequired extends Error {
  readonly quote: X402Quote;
  readonly response: Response;
  constructor(quote: X402Quote, response: Response, message = "Payment required (HTTP 402).") {
    super(message);
    this.name = "X402PaymentRequired";
    this.quote = quote;
    this.response = response;
  }
}

/** A 402 response whose PAYMENT-REQUIRED header did not decode into a valid quote. */
export class X402QuoteParseError extends Error {
  readonly response: Response;
  readonly raw: string | null;
  constructor(detail: string, response: Response, raw: string | null) {
    super(`Malformed PAYMENT-REQUIRED header: ${detail}`);
    this.name = "X402QuoteParseError";
    this.response = response;
    this.raw = raw;
  }
}

/**
 * The server speaks foundation x402 v2 but the response carries no payment this library can
 * make: either an unknown protocol version, or a v2 `PaymentRequired` whose `accepts[]` has no
 * entry payable over Tari Ootle (needs scheme "exact", the Ootle extra keys hashLockHex /
 * refundEpoch / facilitatorUrl, and a recognized paymentFlow). Distinct from a parse error so
 * callers can tell "incompatible dialect" apart from "garbage header".
 */
export class X402UnsupportedVersionError extends Error {
  readonly response: Response;
  readonly raw: string | null;
  readonly version: number | null;
  constructor(response: Response, raw: string | null, version: number | null) {
    super(
      version === 2 || version === null
        ? "Unsupported x402 dialect: this server answered with a foundation x402 v2 PaymentRequired (base64-encoded, accepts[]), but no accepts[] entry is payable over Tari Ootle — an entry needs scheme 'exact', the Ootle extra keys hashLockHex/refundEpoch/facilitatorUrl, and paymentFlow 'upfront' or 'escrow'. See docs/integration/x402.md."
        : `Unsupported x402 dialect: PaymentRequired version ${String(version)} is not implemented.`
    );
    this.name = "X402UnsupportedVersionError";
    this.response = response;
    this.raw = raw;
    this.version = version;
  }
}

/** The wallet's approval popup rejected the request (or the request failed). */
export class X402WalletError extends Error {
  readonly requestId?: string;
  /** The wallet's terminal status when the error came from a get/submit poll (`rejected`/`failed`). */
  readonly status?: "rejected" | "failed";
  constructor(message: string, requestId?: string, status?: "rejected" | "failed") {
    super(message);
    this.name = "X402WalletError";
    this.requestId = requestId;
    this.status = status;
  }
}

/** The `window.tari` injected provider is absent. */
export class X402NoWalletError extends Error {
  constructor() {
    super(
      "No Tari wallet detected: window.tari is unavailable. Install/unlock the Tari Ootle wallet extension."
    );
    this.name = "X402NoWalletError";
  }
}

/** The x402Pay result was missing a field this library must persist (no refund path without it). */
export class X402IncompleteResultError extends Error {
  constructor(missing: string) {
    super(
      `x402Pay result is missing the required field '${missing}' — cannot build a persistable payment record.`
    );
    this.name = "X402IncompleteResultError";
  }
}

/** The settlement expired: the facilitator will never broadcast; the caller must drive the refund. */
export class X402SettlementExpired extends Error {
  /** The persisted output mask — the caller needs it for tari_htlcRefund. */
  readonly outputMask: string;
  /** The wallet-side request id of the original funding transaction. */
  readonly requestId: string;
  /** The local digest of the dead claim payload. */
  readonly localDigest: string;
  constructor(record: X402PaymentRecord, localDigest: string) {
    super(
      `Settlement ${localDigest} expired: the facilitator will never broadcast this claim. Drive tari_htlcRefund (outputMask + requestId available on this error) once refundEpoch has passed — this library does not auto-refund.`
    );
    this.name = "X402SettlementExpired";
    this.outputMask = record.outputMask;
    this.requestId = record.requestId;
    this.localDigest = localDigest;
  }
}

/**
 * `settle()` was handed a record whose `outputMask` was never persisted: without it
 * there is no refund path, so the expired case would strand the funds. Thrown loudly,
 * before any HTTP call.
 */
export class X402MissingOutputMaskError extends Error {
  constructor() {
    super(
      "X402 payment record is missing outputMask — it was not persisted at pay() time. Without outputMask there is no htlcRefund path if settlement expires; refusing to settle."
    );
    this.name = "X402MissingOutputMaskError";
  }
}
