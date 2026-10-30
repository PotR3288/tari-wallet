import { describe, expect, it, vi } from "vitest";
import { pay402, X402PaymentRequired, X402QuoteParseError } from "./index.js";
import { HASH_LOCK, jsonResponse, makeQuote, textResponse } from "./test-utils.js";

const header = (quote: unknown): Record<string, string> => ({
  "PAYMENT-REQUIRED": JSON.stringify(quote),
});

describe("pay402", () => {
  it("402 with a valid header rejects with a typed error carrying the parsed quote", async () => {
    const quote = makeQuote();
    const original = jsonResponse(402, "payment required", header(quote));
    const wrapped = pay402(vi.fn(async () => original));

    const err = await wrapped("https://merchant.example/article").then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(X402PaymentRequired);
    const typed = err as X402PaymentRequired;
    expect(typed.name).toBe("X402PaymentRequired");
    expect(typed.quote).toEqual(quote);
    expect(typed.quote.hashLockHex).toBe(HASH_LOCK);
    expect(typed.response).toBe(original);
  });

  it("402 with a non-JSON header rejects with a distinct parse error", async () => {
    const wrapped = pay402(
      vi.fn(async () =>
        textResponse(402, { "PAYMENT-REQUIRED": "this is not json <<" })
      )
    );
    const err = await wrapped("https://x.example/").then(undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(X402QuoteParseError);
    expect(err).not.toBeInstanceOf(X402PaymentRequired);
    expect((err as X402QuoteParseError).name).toBe("X402QuoteParseError");
    expect((err as X402QuoteParseError).raw).toBe("this is not json <<");
  });

  it("402 with a JSON header that is not a valid quote rejects with a parse error", async () => {
    const wrapped = pay402(vi.fn(async () => jsonResponse(402, {}, header({ hello: "world" }))));
    const err = await wrapped("https://x.example/").then(undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(X402QuoteParseError);
    expect((err as X402QuoteParseError).message).toContain("resourceUrl");
  });

  it("402 with an expired quote (expiresAt in the past) rejects with a parse error", async () => {
    const wrapped = pay402(
      vi.fn(async () => jsonResponse(402, {}, header(makeQuote({ expiresAt: Date.now() - 1000 }))))
    );
    const err = await wrapped("https://x.example/").then(undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(X402QuoteParseError);
    expect((err as X402QuoteParseError).message).toContain("expired");
  });

  it("402 with a malformed hashLockHex rejects with a parse error", async () => {
    const wrapped = pay402(
      vi.fn(async () => jsonResponse(402, {}, header(makeQuote({ hashLockHex: "XYZ" }))))
    );
    const err = await wrapped("https://x.example/").then(undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(X402QuoteParseError);
    expect((err as X402QuoteParseError).message).toContain("hashLockHex");
  });

  it("200 responses pass through untouched", async () => {
    const ok = jsonResponse(200, { article: "hello" });
    const wrapped = pay402(vi.fn(async () => ok));
    const res = await wrapped("https://x.example/");
    expect(res).toBe(ok);
    expect(res.status).toBe(200);
  });

  it("500 responses pass through untouched", async () => {
    const boom = textResponse(500);
    const wrapped = pay402(vi.fn(async () => boom));
    const res = await wrapped("https://x.example/");
    expect(res).toBe(boom);
    expect(res.status).toBe(500);
  });

  it("defaults to the global fetch when no implementation is given", async () => {
    const original = jsonResponse(200, {});
    const stub = vi.fn(async () => original);
    vi.stubGlobal("fetch", stub);
    try {
      const wrapped = pay402();
      const res = await wrapped("https://x.example/");
      expect(res).toBe(original);
      expect(stub).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
