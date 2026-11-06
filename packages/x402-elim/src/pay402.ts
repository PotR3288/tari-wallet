import { X402PaymentRequired, X402QuoteParseError, X402UnsupportedVersionError } from "./errors.js";
import type { X402Quote } from "./types.js";

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Loose Ootle wallet address shape — mirrors the extension's `isValidOotleWalletAddress` (full
 * bech32m checksum validation happens wasm-side at submit time regardless). Used to reject a
 * foundation-v2 `payTo` that could never fund an HTLC before it reaches the wallet.
 */
const OTL_ADDRESS = /^otl_[a-z0-9]+_[a-z0-9]{20,}$/i;

/**
 * The paymentFlow values this client recognizes (spec §6.1: clients MUST NOT construct a
 * payment for a flow they do not recognize and SHOULD skip such accepts[] entries). The shipped
 * rail is escrow-shaped (fund → serve → claim broadcast); `upfront` is accepted as the fallback
 * mapping if the foundation rejects escrow.
 */
const RECOGNIZED_PAYMENT_FLOWS = new Set(["upfront", "escrow"]);

/**
 * Minimal shape validation for a parsed PAYMENT-REQUIRED header: required fields present with
 * the right primitive types, hex fields well-formed, and the quote not already expired.
 * Deliberately shallow — the wallet re-validates everything with full context at `x402Pay` time;
 * this only decides "is this a usable quote".
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
 * True when a foundation v2 `accepts[]` entry is payable over Tari Ootle. Pre-CAIP-2 the
 * Ootle-specific `extra` keys are how an unregistered network identifies itself (the `tari:*`
 * CAIP-2 namespace registration is deferred until mainnet, 11/11); once registered, selection
 * will additionally require `network ∈ {tari:esmeralda, tari:igor, tari:mainnet}`.
 */
function isOotleEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as Record<string, unknown>;
  if (e.scheme !== "exact") return false;
  const extra = typeof e.extra === "object" && e.extra !== null ? (e.extra as Record<string, unknown>) : {};
  // The Ootle-specific keys: their presence is what makes an accepts[] entry ours.
  if (typeof extra.hashLockHex !== "string") return false;
  if (typeof extra.refundEpoch !== "number" || !Number.isFinite(extra.refundEpoch)) return false;
  if (typeof extra.facilitatorUrl !== "string" || extra.facilitatorUrl === "") return false;
  // Spec §6.1 MUST-NOT: skip entries whose paymentFlow we do not recognize.
  const flow = extra.paymentFlow;
  if (flow !== undefined && !RECOGNIZED_PAYMENT_FLOWS.has(String(flow))) return false;
  return true;
}

/**
 * Normalize a foundation x402 v2 `PaymentRequired` into this library's flat quote dialect, or
 * `undefined` when no accepts[] entry is payable over Tari Ootle (the caller then reports the
 * dialect as unsupported). Field mapping: top-level `resource.url` → `resourceUrl`;
 * `accepts[i].{amount,asset,payTo}` → `{amount,resourceAddress,claimantAddress}`; the Ootle terms
 * ride in scheme-specific `extra` keys — including `expiresAt`, which MUST be an absolute ms
 * timestamp there (v2's `maxTimeoutSeconds` is relative wall-clock and is deliberately NOT
 * derived from). The first acceptable entry wins.
 */
export function normalizeFoundationV2(value: unknown): X402Quote | undefined {
  if (foundationV2Version(value) !== 2) return undefined;
  const o = value as Record<string, unknown>;
  const resource = typeof o.resource === "object" && o.resource !== null ? (o.resource as Record<string, unknown>) : {};
  const accepts = Array.isArray(o.accepts) ? o.accepts : [];
  for (const entry of accepts) {
    if (!isOotleEntry(entry)) continue; // spec §6.1: skip entries we cannot pay
    const e = entry as Record<string, unknown>;
    const extra = e.extra as Record<string, unknown>;
    const quote: X402Quote = {
      resourceUrl: typeof resource.url === "string" ? resource.url : "",
      amount: typeof e.amount === "string" ? e.amount : "",
      resourceAddress: typeof e.asset === "string" ? e.asset : "",
      claimantAddress: typeof e.payTo === "string" ? e.payTo : "",
      hashLockHex: extra.hashLockHex as string,
      refundEpoch: extra.refundEpoch as number,
      facilitatorUrl: extra.facilitatorUrl as string,
      expiresAt:
        typeof extra.expiresAt === "number" && Number.isFinite(extra.expiresAt) ? (extra.expiresAt as number) : NaN,
    };
    if (typeof extra.facilitatorPubKeyHex === "string") quote.facilitatorPubKeyHex = extra.facilitatorPubKeyHex;
    if (typeof extra.maxFee === "string") quote.maxFee = extra.maxFee;
    return quote; // first acceptable entry wins
  }
  return undefined;
}

/**
 * Wraps a fetch implementation: on a 402 response, parses the `PAYMENT-REQUIRED` response header
 * into an {@link X402Quote} and rejects with a typed {@link X402PaymentRequired} error carrying
 * the quote and the original response. Any other status — success or server error alike — passes
 * through untouched.
 *
 * The header's value is either this dialect's JSON-encoded flat quote envelope, or a base64-
 * encoded foundation x402 v2 `PaymentRequired` (the spec's canonical HTTP wire form), which
 * {@link normalizeFoundationV2} maps onto the flat dialect when it carries an Ootle entry.
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
      // Not plain JSON. Before giving up as garbage, check whether this is a foundation x402 v2
      // response (base64-encoded PaymentRequired — the spec's canonical HTTP wire form).
      const v2 = decodeFoundationV2Object(raw);
      if (v2 !== undefined) {
        return paymentRequiredFromV2(v2, response, raw);
      }
      throw new X402QuoteParseError("header is not valid JSON", response, raw);
    }
    // Plain JSON: either our flat dialect or an inline foundation-v2 object.
    if (foundationV2Version(parsed) !== undefined) {
      return paymentRequiredFromV2(parsed, response, raw);
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

/**
 * A foundation-v2-shaped header: normalize an Ootle entry into the typed payment-required error,
 * or report the dialect as unsupported (no payable entry / unknown version).
 */
function paymentRequiredFromV2(v2: unknown, response: Response, raw: string | null): never {
  const quote = normalizeFoundationV2(v2);
  if (quote === undefined) {
    throw new X402UnsupportedVersionError(response, raw, foundationV2Version(v2) ?? null);
  }
  // v2-specific strictness the flat dialect leaves to the wallet: payTo must be an Ootle address.
  if (!OTL_ADDRESS.test(quote.claimantAddress)) {
    throw new X402QuoteParseError("payTo is not an Ootle wallet address (expected otl_…)", response, raw);
  }
  let validated: X402Quote;
  try {
    validated = validateQuote(quote);
  } catch (e) {
    throw new X402QuoteParseError(e instanceof Error ? e.message : String(e), response, raw);
  }
  throw new X402PaymentRequired(validated, response);
}

/** The `x402Version` field of a foundation x402 PaymentRequired, or undefined if not one. */
function foundationV2Version(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  if (typeof o.x402Version === "number") return o.x402Version;
  // v2 shape without the explicit version marker: resource + non-empty accepts[].
  if (Array.isArray(o.accepts) && o.accepts.length > 0 && typeof o.resource === "object" && o.resource !== null) {
    return 2;
  }
  return undefined;
}

/** base64-decode the header and return the object when it is a foundation v2 PaymentRequired. */
function decodeFoundationV2Object(raw: string | null): unknown {
  if (raw === null) return undefined;
  let decoded: string;
  try {
    // eslint-disable-next-line no-undef -- atob is available in every runtime this library targets
    decoded = atob(raw.replace(/\s+/g, ""));
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return undefined;
  }
  return foundationV2Version(parsed) !== undefined ? parsed : undefined;
}
