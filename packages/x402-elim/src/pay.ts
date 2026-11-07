import { X402IncompleteResultError, X402NoWalletError, X402PollTimeoutError, X402WalletError } from "./errors.js";
import { DEFAULT_POLL_TIMEOUT_MS } from "./tari.js";
import type { X402PaymentRecord, X402Quote, X402SignedClaim } from "./types.js";
import { createAndSubmit, getTari, type TariProvider } from "./tari.js";

const STORAGE_PREFIX = "x402:";
/** localStorage key for one quote's payment record — derived from the quote's hashLockHex. */
export const storageKey = (quote: X402Quote): string => `${STORAGE_PREFIX}${quote.hashLockHex}`;

/** The persisted shape: always `requestId` + `quote`; the rest land once the request submits. */
export interface StoredRecord {
  requestId: string;
  quote: X402Quote;
  txHash?: string;
  outputMask?: string;
  htlcOutputCommitmentHex?: string;
  conditions?: unknown[];
}

function loadStored(quote: X402Quote): StoredRecord | undefined {
  const raw = localStorage.getItem(storageKey(quote));
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const rec = parsed as StoredRecord;
    if (typeof rec.requestId !== "string") return undefined;
    return rec;
  } catch {
    return undefined;
  }
}

function persist(record: StoredRecord): void {
  localStorage.setItem(storageKey(record.quote), JSON.stringify(record));
}

function removeStored(quote: X402Quote): void {
  localStorage.removeItem(storageKey(quote));
}

/**
 * The shape the wallet's `x402Pay` (an `htlcFund` underneath) result must relay out of
 * band — the SDK's `HtlcFundResult` field names, relayed unmodified: `transactionId` is
 * the chain transaction id, `ownCommitment` the funded HTLC output's commitment.
 */
interface X402PayResult {
  transactionId?: unknown;
  outputMask?: unknown;
  ownCommitment?: unknown;
  conditions?: unknown;
}

function requireString(result: X402PayResult, field: keyof X402PayResult): string {
  const value = result[field];
  if (typeof value !== "string" || value === "") {
    throw new X402IncompleteResultError(String(field));
  }
  return value;
}

function requireConditions(result: X402PayResult): unknown[] {
  if (!Array.isArray(result.conditions)) {
    throw new X402IncompleteResultError("conditions");
  }
  return result.conditions as unknown[];
}

/** True when the injected `window.tari` provider looks usable. */
export function hasTari(): boolean {
  return getTari() !== undefined;
}

/**
 * Drives the wallet to fund the quote's HTLC: `createAndSubmit({ kind: "x402Pay", ...quote })`
 * via `window.tari.request`, following the create/get/submit reference implementation
 * (poll interval, idempotent stored-result resume).
 *
 * If a record for this quote's `hashLockHex` already exists in `localStorage`, the
 * stored `requestId` is resumed instead of creating a new request — a page that
 * reloaded while the approval popup was open continues where it left off, and an
 * already-submitted request resolves from the wallet's stored result.
 *
 * On success, persists the full record (requestId, txHash, outputMask,
 * htlcOutputCommitmentHex, conditions, quote) and resolves with it. Throws
 * {@link X402WalletError} on rejected/failed — and clears the stored record
 * first, so a re-served identical quote creates a fresh request instead of
 * resuming (and re-throwing on) the dead one. Unknown/stale wallet states keep
 * the record so a genuinely in-flight request still resumes after a reload.
 */
export async function pay(
  quote: X402Quote,
  opts?: { pollIntervalMs?: number; pollTimeoutMs?: number }
): Promise<X402PaymentRecord> {
  const tari = getTari();
  if (!tari) throw new X402NoWalletError();

  const stored = loadStored(quote);
  let requestId: string;
  let result: X402PayResult;
  try {
    if (stored) {
      // Resume: poll the stored requestId through the same state machine — an
      // already-submitted request resolves from the wallet's stored result.
      ({ requestId, result } = await resume(tari, stored.requestId, opts));
    } else {
      ({ requestId, result } = await createAndSubmit<X402PayResult>(
        tari,
        { kind: "x402Pay", ...quote },
        {
          ...opts,
          // Persist the bare {requestId, quote} immediately after create — BEFORE the
          // first poll — so a reload while the approval popup is still open resumes
          // the real in-flight request instead of creating a duplicate.
          onCreated: (id) => persist({ requestId: id, quote }),
        }
      ));
    }
  } catch (e) {
    // Terminal rejected/failed clears the stored record so a re-served identical
    // quote creates a fresh request instead of resuming (and re-throwing on) the
    // dead one forever. Unknown/stale states keep their record — a genuinely
    // in-flight request must still resume after a reload.
    if (e instanceof X402WalletError && (e.status === "rejected" || e.status === "failed")) {
      removeStored(quote);
    }
    throw e;
  }

  const txHash = requireString(result, "transactionId");
  const outputMask = requireString(result, "outputMask");
  const htlcOutputCommitmentHex = requireString(result, "ownCommitment");
  const conditions = requireConditions(result);

  const record: X402PaymentRecord = {
    ...(stored ?? {}),
    requestId,
    txHash,
    outputMask,
    htlcOutputCommitmentHex,
    conditions,
    quote,
  };
  persist(record);
  return record;
}

/** Poll a stored requestId to completion using only get/submit — the reload-resume path. */
async function resume(
  tari: TariProvider,
  requestId: string,
  opts?: { pollIntervalMs?: number; pollTimeoutMs?: number }
): Promise<{ requestId: string; result: X402PayResult }> {
  const interval = opts?.pollIntervalMs ?? 700;
  const deadline = Date.now() + (opts?.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS);
  for (;;) {
    const record = (await tari.request({
      method: "tari_getTransactionRequest",
      params: { requestId },
    })) as { status?: string; result?: unknown; error?: string };
    switch (record?.status) {
      case "approved":
        return {
          requestId,
          result: (await tari.request({
            method: "tari_submitTransactionRequest",
            params: { requestId },
          })) as X402PayResult,
        };
      case "submitted":
      case "signed-unbroadcast":
        return { requestId, result: record.result as X402PayResult };
      case "rejected":
      case "failed":
        throw new X402WalletError(record.error ?? `Transaction ${record.status}.`, requestId, record.status);
      case "pending":
      case "submitting":
        if (Date.now() >= deadline) {
          throw new X402PollTimeoutError(
            `Resumed transaction request ${requestId} stayed '${record?.status}' past the poll deadline.`,
            { requestId }
          );
        }
        await new Promise<void>((resolve) => setTimeout(resolve, interval));
        break;
      default:
        throw new X402WalletError(`Unknown transaction request status: ${String(record?.status)}.`, requestId);
    }
  }
}

/** Params for {@link signClaim}: everything the wallet's `x402SignClaim` kind requires. */
export interface X402SignClaimParams {
  /** The quote envelope being claimed (the merchant's own record of the sale). */
  envelope: X402Quote;
  /** The claim secret, hex. */
  preimageHex: string;
  /** The funded output's commitment, from the payer's relayed record. */
  htlcOutputCommitmentHex: string;
  /** The exact two-leaf condition tree the funding side relayed. */
  conditions: unknown[];
}

/**
 * Thin helper for the merchant side: drives
 * `createAndSubmit({ kind: "x402SignClaim", ... })` to build, sign and seal the claim
 * **without broadcasting it**, polling to the stored result exactly like `pay()`.
 * Feed the result to {@link settle} (in `settle.ts`) — the wallet never submits it.
 */
export async function signClaim(
  params: X402SignClaimParams,
  opts?: { pollIntervalMs?: number; pollTimeoutMs?: number }
): Promise<X402SignedClaim> {
  const tari = getTari();
  if (!tari) throw new X402NoWalletError();
  const { result } = await createAndSubmit<X402SignedClaim>(
    tari,
    { kind: "x402SignClaim", ...params },
    opts
  );
  if (typeof result?.signedPayloadHex !== "string" || typeof result?.txHash !== "string") {
    throw new X402IncompleteResultError("signedPayloadHex/txHash");
  }
  return result;
}

/**
 * Loads the persisted payment record for a quote (by `hashLockHex`) without driving the
 * wallet — lets a caller check for an in-flight payment (a partial record with only a
 * `requestId`) or recover the completed record's `outputMask` for a refund.
 * Returns `undefined` when nothing is stored for this quote.
 */
export function loadRecord(quote: X402Quote): StoredRecord | undefined {
  return loadStored(quote);
}
