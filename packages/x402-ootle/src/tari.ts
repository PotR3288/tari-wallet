/**
 * A loose structural interface for the injected Tari Ootle provider — only the methods
 * this library actually calls, deliberately not the extension's full surface, so the
 * package never imports extension internals.
 */

import { X402WalletError } from "./errors.js";

/** A JSON-RPC-ish request record as returned by `tari_getTransactionRequest`. */
export interface TariRequestRecord {
  status:
    | "pending"
    | "submitting"
    | "approved"
    | "rejected"
    | "failed"
    | "submitted"
    | "signed-unbroadcast";
  /** Present once status is `submitted` — the stored operation result. */
  result?: unknown;
  /** Present on `rejected`/`failed` — the wallet's own error text. */
  error?: string;
}

/** The structural slice of `window.tari` this library uses. */
export interface TariProvider {
  request(args: { method: string; params?: Record<string, unknown> }): Promise<unknown>;
}

/** Locates the injected provider without throwing when absent. */
export function getTari(): TariProvider | undefined {
  const w = (globalThis as { window?: { tari?: TariProvider } }).window;
  return w?.tari ?? (globalThis as { tari?: TariProvider }).tari;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The create/get/submit split with polling, following
 * `docs/integration/transaction-requests.md`'s reference implementation exactly: the
 * request is persisted wallet-side, so an already-approved (or already-submitted)
 * requestId resumes cleanly after a page reload instead of starting over.
 */
export async function createAndSubmit<T>(
  tari: TariProvider,
  operation: Record<string, unknown>,
  opts?: {
    pollIntervalMs?: number;
    /** Called with the requestId immediately after create, before the first poll. */
    onCreated?: (requestId: string) => void;
  }
): Promise<{ requestId: string; result: T }> {
  const interval = opts?.pollIntervalMs ?? 700;
  const created = (await tari.request({
    method: "tari_createTransactionRequest",
    params: operation,
  })) as { requestId?: string };
  const requestId = created?.requestId;
  if (typeof requestId !== "string" || requestId === "") {
    throw new Error("tari_createTransactionRequest did not return a requestId.");
  }
  opts?.onCreated?.(requestId);
  for (;;) {
    const record = (await tari.request({
      method: "tari_getTransactionRequest",
      params: { requestId },
    })) as TariRequestRecord;
    switch (record?.status) {
      case "approved":
        return { requestId, result: (await tari.request({
          method: "tari_submitTransactionRequest",
          params: { requestId },
        })) as T };
      case "submitted":
      case "signed-unbroadcast":
        return { requestId, result: record.result as T };
      case "rejected":
      case "failed":
        throw new X402WalletError(record.error ?? `Transaction ${record.status}.`, requestId);
      case "pending":
      case "submitting":
        await sleep(interval);
        break;
      default:
        throw new Error(`Unknown transaction request status: ${String(record?.status)}.`);
    }
  }
}
