import { X402MissingOutputMaskError, X402PollTimeoutError, X402SettlementExpired } from "./errors.js";

/** Default bound on the held-settlement poll loop: five minutes. Also capped at the quote's expiresAt. */
export const DEFAULT_SETTLE_POLL_TIMEOUT_MS = 5 * 60_000;
import type { SettlementResult, X402PaymentRecord, X402SignedClaim } from "./types.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `facilitatorUrl + "/x402/settle"`, tolerating a trailing slash on the configured base. */
export function settleUrl(facilitatorUrl: string): string {
  return `${facilitatorUrl.replace(/\/+$/, "")}/x402/settle`;
}

/** `facilitatorUrl + "/x402/settlement/{localDigest}"`. */
export function settlementUrl(facilitatorUrl: string, localDigest: string): string {
  return `${facilitatorUrl.replace(/\/+$/, "")}/x402/settlement/${localDigest}`;
}

interface FacilitatorStatus {
  status?: unknown;
  chainTxId?: unknown;
}

function parseStatus(
  body: unknown
): { status: "held" | "broadcast" | "confirmed" | "expired"; chainTxId?: string } {
  const parsed = body as FacilitatorStatus;
  const status = parsed?.status;
  if (status !== "held" && status !== "broadcast" && status !== "confirmed" && status !== "expired") {
    throw new Error(`Facilitator returned an unknown settlement status: ${String(status)}.`);
  }
  const chainTxId = typeof parsed.chainTxId === "string" ? parsed.chainTxId : undefined;
  if ((status === "broadcast" || status === "confirmed") && chainTxId === undefined) {
    throw new Error(`Facilitator reported '${status}' without a chainTxId.`);
  }
  return { status, chainTxId };
}

/**
 * Settles a paid quote against its facilitator.
 *
 * POSTs `{ signedPayloadHex, quote }` to `quote.facilitatorUrl + "/x402/settle"` — the
 * wallet's local digest (`signedPayload.txHash`, the wire-side `localDigest`) makes the
 * POST idempotent, so re-POSTing a known digest returns the same status response —
 * then polls `GET /x402/settlement/{localDigest}` until the claim is broadcast or
 * confirmed.
 *
 * On `expired`, throws a typed {@link X402SettlementExpired} carrying the persisted
 * `outputMask` + `requestId` so the caller can drive `tari_htlcRefund` once the refund
 * epoch passes — this library never auto-refunds.
 *
 * If `record.outputMask` was never persisted (a caller that dropped it has no refund
 * path), throws {@link X402MissingOutputMaskError} loudly, before any HTTP call.
 */
export async function settle(
  record: X402PaymentRecord,
  signedPayload: X402SignedClaim,
  opts?: { pollIntervalMs?: number; pollTimeoutMs?: number }
): Promise<SettlementResult> {
  if (typeof record.outputMask !== "string" || record.outputMask === "") {
    throw new X402MissingOutputMaskError();
  }
  const interval = opts?.pollIntervalMs ?? 700;
  // Poll bound: the caller's timeout, additionally capped at the quote's own expiry —
  // past expiresAt the facilitator can no longer honor the quote, so the refund path
  // (X402SettlementExpired) is the correct answer either way.
  const requested = Date.now() + (opts?.pollTimeoutMs ?? DEFAULT_SETTLE_POLL_TIMEOUT_MS);
  const expiresAt = record.quote.expiresAt;
  const deadline = Number.isFinite(expiresAt) ? Math.min(requested, expiresAt) : requested;
  const localDigest = signedPayload.txHash;

  const response = await fetch(settleUrl(record.quote.facilitatorUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signedPayloadHex: signedPayload.signedPayloadHex, quote: record.quote }),
  });
  if (!response.ok) {
    throw new Error(`Facilitator settle POST failed: HTTP ${String(response.status)}.`);
  }
  let current = parseStatus(await response.json());

  while (current.status === "held") {
    await sleep(interval);
    const poll = await fetch(settlementUrl(record.quote.facilitatorUrl, localDigest));
    if (!poll.ok) {
      throw new Error(`Facilitator settlement GET failed: HTTP ${String(poll.status)}.`);
    }
    current = parseStatus(await poll.json());
    if (current.status === "held" && Date.now() >= deadline) {
      if (Date.now() >= expiresAt) {
        throw new X402SettlementExpired(record, localDigest);
      }
      throw new X402PollTimeoutError(
        `Settlement ${localDigest} stayed 'held' past the poll deadline.`,
        { localDigest }
      );
    }
  }

  if (current.status === "expired") {
    throw new X402SettlementExpired(record, localDigest);
  }
  return { status: current.status, chainTxId: current.chainTxId, localDigest };
}
