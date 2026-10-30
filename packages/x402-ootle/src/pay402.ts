import { X402PaymentRequired, X402QuoteParseError } from "./errors.js";
import type { X402Quote } from "./types.js";

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Minimal shape validation for a parsed PAYMENT-REQUIRED header: required fields
 * present with the right primitive types, hex fields well-formed, and the quote not
 * already expired. Deliberately shallow — the wallet re-validates everything with
 * full context at `x402Pay` time; this only decides "is this a usable quote".
 */
export function validateQuote(value: unknown, now = Date.now()): X402Quote {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("not a JSON object");
  }
  const q = value as Record<string, unknown>;
  for (const field of [
    "resourceUrl",
    "amount",
    "resourceAddress",
    "claimantAddress",
    "hashLockHex",
    "facilitatorUrl",
  ] as const) {
    if (typeof q[field] !== "string" || (q[field] as string) === "") {
      throw new Error(`missing or non-string field '${field}'`);
    }
  }
  if (typeof q.refundEpoch !== "number" || !Number.isFinite(q.refundEpoch)) {
    throw new Error("missing or non-number field 'refundEpoch'");
  }
  if (typeof q.expiresAt !== "number" || !Number.isFinite(q.expiresAt)) {
    throw new Error("missing or non-number field 'expiresAt'");
  }
  if (!HEX_64.test(q.hashLockHex as string)) {
    throw new Error("hashLockHex is not 64 lowercase hex characters");
  }
  if (q.resourceSha256 !== undefined && (typeof q.resourceSha256 !== "string" || !HEX_64.test(q.resourceSha256))) {
    throw new Error("resourceSha256, when present, must be 64 lowercase hex characters");
  }
  if ((q.expiresAt as number) <= now) {
    throw new Error(`quote expired at ${String(q.expiresAt)} (now ${now})`);
  }
  return value as X402Quote;
}

/**
 * Wraps a fetch implementation: on a 402 response, parses the `PAYMENT-REQUIRED`
 * response header into an {@link X402Quote} and rejects with a typed
 * {@link X402PaymentRequired} error carrying the quote and the original response.
 * Any other status — success or server error alike — passes through untouched.
 *
 * The header's value is the JSON-encoded quote envelope.
 */
export function pay402(fetchImpl?: typeof fetch): typeof fetch {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new TypeError("pay402: no fetch implementation available (global or argument).");
  }
  const wrapped: typeof fetch = async (input, init) => {
    const response = await doFetch(input, init);
    if (response.status !== 402) {
      return response;
    }
    const raw = response.headers.get("PAYMENT-REQUIRED");
    let parsed: unknown;
    try {
      if (raw === null) throw new Error("header absent");
      parsed = JSON.parse(raw);
    } catch {
      throw new X402QuoteParseError("header is not valid JSON", response, raw);
    }
    let quote: X402Quote;
    try {
      quote = validateQuote(parsed);
    } catch (e) {
      throw new X402QuoteParseError(e instanceof Error ? e.message : String(e), response, raw);
    }
    throw new X402PaymentRequired(quote, response);
  };
  return wrapped;
}
