// Decoders for the base64 CBOR engine values the Ootle 0.48 indexer serves (it served serde JSON
// before). A non-string passes through untouched, so an older indexer still reads the same way.
import { decodeEvent as wasmDecodeEvent, decodeSubstateValue as wasmDecodeSubstateValue } from "@tari-project/ootle-wasm-bor";

export const decodeSubstateValue = <T = unknown>(v: unknown): T => (typeof v === "string" ? (JSON.parse(wasmDecodeSubstateValue(v)) as T) : (v as T));
export const decodeEvent = <T = unknown>(v: unknown): T => (typeof v === "string" ? (JSON.parse(wasmDecodeEvent(v)) as T) : (v as T));

import { decodeExecuteResult as wasmDecodeExecuteResult } from "@tari-project/ootle-wasm-bor";
export const decodeExecuteResult = <T = unknown>(v: unknown): T => (typeof v === "string" ? (JSON.parse(wasmDecodeExecuteResult(v)) as T) : (v as T));

/** A `getSubstate` response with `state.up.substate` decoded (dApps get JSON, as before 0.48). */
export function decodeSubstateResponse(r: any): any {
  return r?.state && "up" in r.state ? { ...r, state: { up: { substate: decodeSubstateValue(r.state.up.substate) } } } : r;
}

/** A transaction-result response with `Finalized.execution_result` decoded. */
export function decodeTransactionResultResponse(r: any): any {
  const f = r?.result && typeof r.result === "object" && "Finalized" in r.result ? r.result.Finalized : null;
  return f ? { ...r, result: { Finalized: { ...f, execution_result: decodeExecuteResult(f.execution_result) } } } : r;
}
