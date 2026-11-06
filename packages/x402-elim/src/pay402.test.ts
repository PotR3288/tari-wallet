import { describe, expect, it, vi } from "vitest";
import { normalizeFoundationV2, pay402, X402PaymentRequired, X402QuoteParseError, X402UnsupportedVersionError } from "./index.js";
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

  describe("foundation x402 v2 detection", () => {
    // A foundation v2 PaymentRequired the way the v2 spec's HTTP transport carries it.
    const v2Object = {
      x402Version: 2,
      resource: { url: "https://api.example.com/premium", mimeType: "application/json" },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:84532",
          amount: "10000",
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
          maxTimeoutSeconds: 60,
          extra: {},
        },
      ],
      extensions: {},
    };
    const b64 = (obj: unknown) => btoa(JSON.stringify(obj));

    it("a base64-encoded v2 PaymentRequired rejects with the unsupported-version error, not a parse error", async () => {
      const wrapped = pay402(
        vi.fn(async () => textResponse(402, { "PAYMENT-REQUIRED": b64(v2Object) }))
      );
      const err = await wrapped("https://x.example/").then(undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(X402UnsupportedVersionError);
      expect((err as X402UnsupportedVersionError).name).toBe("X402UnsupportedVersionError");
      expect((err as X402UnsupportedVersionError).version).toBe(2);
      expect((err as X402UnsupportedVersionError).message).toContain("x402 v2");
    });

    it("an inline (plain-JSON) v2-shaped PaymentRequired rejects the same way", async () => {
      const wrapped = pay402(
        vi.fn(async () => jsonResponse(402, {}, header(v2Object)))
      );
      const err = await wrapped("https://x.example/").then(undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(X402UnsupportedVersionError);
      expect((err as X402UnsupportedVersionError).version).toBe(2);
    });

    it("an unknown future version marker also reports unsupported (not parse error)", async () => {
      const wrapped = pay402(
        vi.fn(async () => jsonResponse(402, {}, header({ x402Version: 3, resource: {}, accepts: [] })))
      );
      const err = await wrapped("https://x.example/").then(undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(X402UnsupportedVersionError);
      expect((err as X402UnsupportedVersionError).version).toBe(3);
    });

    it("base64 that does NOT decode to a v2 shape stays a plain parse error", async () => {
      const raw = btoa("not a payment required object");
      const wrapped = pay402(
        vi.fn(async () => textResponse(402, { "PAYMENT-REQUIRED": raw }))
      );
      const err = await wrapped("https://x.example/").then(undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(X402QuoteParseError);
      expect(err).not.toBeInstanceOf(X402UnsupportedVersionError);
    });
  });

  describe("foundation x402 v2 normalization", () => {
    // A foundation v2 PaymentRequired carrying an Ootle entry — the wire shape our own dApp
    // servers emit (docs/integration/x402.md): scheme-specific terms in extra, and no network
    // field until the tari:* CAIP-2 namespace is registered (deferred to mainnet, 11/11).
    const OTL = "otl_esm_1v3snq8z9xk7d2m4p6r8t0wyaubcdefghijkl";
    const XTR_RESOURCE =
      "resource_0101010101010101010101010101010101010101010101010101010101010101";
    const ootleV2 = (over: { extra?: Record<string, unknown>; entryOver?: Record<string, unknown>; omitExpiresAt?: boolean } = {}) => {
      const extra: Record<string, unknown> = {
        hashLockHex: HASH_LOCK,
        refundEpoch: 12758,
        facilitatorUrl: "http://127.0.0.1:4020",
        expiresAt: Date.now() + 3_600_000,
        paymentFlow: "escrow",
        ...over.extra,
      };
      if (over.omitExpiresAt) delete extra.expiresAt;
      return {
        x402Version: 2,
        resource: { url: "https://api.example.com/premium" },
        accepts: [
          {
            scheme: "exact",
            amount: "10000",
            asset: XTR_RESOURCE,
            payTo: OTL,
            maxTimeoutSeconds: 60,
            extra,
            ...over.entryOver,
          },
        ],
      };
    };

    it("a base64 v2 header with an Ootle entry resolves to a typed payment-required error carrying the mapped quote", async () => {
      const wrapped = pay402(
        vi.fn(async () => textResponse(402, { "PAYMENT-REQUIRED": btoa(JSON.stringify(ootleV2())) }))
      );
      const err = await wrapped("https://x.example/").then(undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(X402PaymentRequired);
      const typed = err as X402PaymentRequired;
      // Every mapped field, individually.
      expect(typed.quote.resourceUrl).toBe("https://api.example.com/premium");
      expect(typed.quote.amount).toBe("10000");
      expect(typed.quote.resourceAddress).toBe(XTR_RESOURCE);
      expect(typed.quote.claimantAddress).toBe(OTL);
      expect(typed.quote.hashLockHex).toBe(HASH_LOCK);
      expect(typed.quote.refundEpoch).toBe(12758);
      expect(typed.quote.facilitatorUrl).toBe("http://127.0.0.1:4020");
      expect(typeof typed.quote.expiresAt).toBe("number");
    });

    it("an inline (plain-JSON) v2 PaymentRequired with an Ootle entry normalizes the same way", async () => {
      const wrapped = pay402(vi.fn(async () => jsonResponse(402, {}, header(ootleV2()))));
      const err = await wrapped("https://x.example/").then(undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(X402PaymentRequired);
      expect((err as X402PaymentRequired).quote.claimantAddress).toBe(OTL);
    });

    it("optional extra keys (facilitatorPubKeyHex, maxFee) ride through when present", async () => {
      const wrapped = pay402(
        vi.fn(async () =>
          textResponse(402, {
            "PAYMENT-REQUIRED": btoa(JSON.stringify(ootleV2({ extra: { facilitatorPubKeyHex: "ab".repeat(32), maxFee: "500" } }))),
          })
        )
      );
      const err = await wrapped("https://x.example/").then(undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(X402PaymentRequired);
      const typed = err as X402PaymentRequired;
      expect(typed.quote.facilitatorPubKeyHex).toBe("ab".repeat(32));
      expect(typed.quote.maxFee).toBe("500");
    });

    it("an Ootle entry with an unrecognized paymentFlow is skipped -> unsupported dialect", async () => {
      const wrapped = pay402(
        vi.fn(async () =>
          textResponse(402, { "PAYMENT-REQUIRED": btoa(JSON.stringify(ootleV2({ extra: { paymentFlow: "authorization" } }))) })
        )
      );
      const err = await wrapped("https://x.example/").then(undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(X402UnsupportedVersionError);
      expect((err as X402UnsupportedVersionError).version).toBe(2);
    });

    it("a v2 Ootle entry whose payTo is not an otl_ address rejects with a distinct parse error", async () => {
      const wrapped = pay402(
        vi.fn(async () =>
          textResponse(402, { "PAYMENT-REQUIRED": btoa(JSON.stringify(ootleV2({ entryOver: { payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C" } }))) })
        )
      );
      const err = await wrapped("https://x.example/").then(undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(X402QuoteParseError);
      expect((err as X402QuoteParseError).message).toContain("payTo");
    });

    it("a v2 Ootle entry missing extra.expiresAt rejects with a distinct parse error", async () => {
      const wrapped = pay402(
        vi.fn(async () => textResponse(402, { "PAYMENT-REQUIRED": btoa(JSON.stringify(ootleV2({ omitExpiresAt: true }))) }))
      );
      const err = await wrapped("https://x.example/").then(undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(X402QuoteParseError);
      expect((err as X402QuoteParseError).message).toContain("expiresAt");
    });

    it("a v2 Ootle entry with an expired expiresAt rejects as expired", async () => {
      const wrapped = pay402(
        vi.fn(async () => textResponse(402, { "PAYMENT-REQUIRED": btoa(JSON.stringify(ootleV2({ extra: { expiresAt: Date.now() - 1000 } }))) }))
      );
      const err = await wrapped("https://x.example/").then(undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(X402QuoteParseError);
      expect((err as X402QuoteParseError).message).toContain("expired");
    });

    it("normalizeFoundationV2 is a pure function: undefined for non-v2 and for v2 without an Ootle entry", () => {
      expect(normalizeFoundationV2({ hello: "world" })).toBeUndefined();
      // The detection fixture's shape (EVM exact, empty extra) has no Ootle terms.
      const evmOnly = {
        x402Version: 2,
        resource: { url: "https://api.example.com/premium" },
        accepts: [
          { scheme: "exact", network: "eip155:84532", amount: "10000", asset: "0xabc", payTo: "0xdef", maxTimeoutSeconds: 60, extra: {} },
        ],
      };
      expect(normalizeFoundationV2(evmOnly)).toBeUndefined();
      const quote = normalizeFoundationV2(ootleV2());
      expect(quote?.hashLockHex).toBe(HASH_LOCK);
    });
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
