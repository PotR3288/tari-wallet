import { vi } from "vitest";
import type { X402Quote } from "./types.js";

export const HASH_LOCK = "a".repeat(64);
/** SHA-256 of the string "the paid-for article body". */
export const RESOURCE_SHA =
  "d19146759fe2938ec1a5170b94b38b5eb0788e9932221f0d6ffdc8235a701415";
export const OTHER_SHA = "c".repeat(64);

export function makeQuote(overrides: Partial<X402Quote> = {}): X402Quote {
  return {
    resourceUrl: "https://merchant.example/article",
    resourceSha256: RESOURCE_SHA,
    amount: "1000",
    resourceAddress: "TARI_RESOURCE_ADDRESS",
    claimantAddress: "otl_merchant_claimant_address_0000000000000000",
    hashLockHex: HASH_LOCK,
    refundEpoch: 5000,
    facilitatorUrl: "https://indexer.example",
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

/** In-memory localStorage stand-in (tests run in the node environment). */
export class FakeLocalStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
  dump(): Record<string, string> {
    return Object.fromEntries(this.store);
  }
}

export function stubBrowser(localStorage: FakeLocalStorage) {
  vi.stubGlobal("localStorage", localStorage);
  return () => vi.unstubAllGlobals();
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

export function textResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response("body", { status, headers });
}
