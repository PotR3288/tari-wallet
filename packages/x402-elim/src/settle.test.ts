import { describe, expect, it, vi } from "vitest";
import {
  settle,
  X402MissingOutputMaskError,
  X402BrowserOnlyError,
  X402PollTimeoutError,
  X402SettlementExpired,
  type X402PaymentRecord,
  type X402SignedClaim,
} from "./index.js";
import { makeQuote } from "./test-utils.js";

const fast = { pollIntervalMs: 1, allowServerSide: true };

function makeRecord(overrides: Partial<X402PaymentRecord> = {}): X402PaymentRecord {
  return {
    requestId: "req-1",
    txHash: "d".repeat(64),
    outputMask: "mask-1",
    htlcOutputCommitmentHex: "e".repeat(64),
    conditions: [{ type: "HashLock" }, { type: "AfterEpoch", epoch: 5000 }],
    quote: makeQuote(),
    ...overrides,
  };
}

function makeSignedClaim(): X402SignedClaim {
  return {
    signedPayloadHex: "ff".repeat(32),
    txHash: "9".repeat(64),
    htlcOutputCommitment: "e".repeat(64),
    refundEpoch: 5000,
    validUntilEpoch: 4999,
  };
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const spy = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init)
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("settle", () => {
  it("held → broadcast → confirmed: POSTs the payload+quote then polls to a terminal status", async () => {
    const record = makeRecord();
    const signed = makeSignedClaim();
    const spy = stubFetch((url) => {
      if (url.endsWith("/x402/settle")) {
        return new Response(JSON.stringify({ status: "held" }), { status: 200 });
      }
      expect(url).toBe(`${record.quote.facilitatorUrl}/x402/settlement/${signed.txHash}`);
      return new Response(JSON.stringify({ status: "broadcast", chainTxId: "tx-abc" }), { status: 200 });
    });

    const result = await settle(record, signed, fast);
    // `broadcast` is a terminal status for the client — polling stops there.
    expect(result).toEqual({ status: "broadcast", chainTxId: "tx-abc", localDigest: signed.txHash });

    // The POST body carries exactly the spec shape.
    const post = spy.mock.calls[0];
    expect(post?.[0]).toBe(`${record.quote.facilitatorUrl}/x402/settle`);
    const body = JSON.parse(String(post?.[1]?.body)) as Record<string, unknown>;
    expect(body.signedPayloadHex).toBe(signed.signedPayloadHex);
    expect(body.quote).toEqual(record.quote);
  });

  it("resolves immediately when the POST itself reports confirmed", async () => {
    const record = makeRecord();
    const signed = makeSignedClaim();
    stubFetch((url) => {
      if (url.endsWith("/x402/settle")) {
        return new Response(JSON.stringify({ status: "confirmed", chainTxId: "tx-abc" }), { status: 200 });
      }
      throw new Error(`unexpected GET ${url}`);
    });
    const result = await settle(record, signed, fast);
    expect(result).toEqual({ status: "confirmed", chainTxId: "tx-abc", localDigest: signed.txHash });
  });

  it("an idempotent re-POST of a known localDigest returns the same status without re-polling from scratch", async () => {
    const record = makeRecord();
    const signed = makeSignedClaim();
    const spy = stubFetch((url) => {
      if (url.endsWith("/x402/settle")) {
        // Second POST for a known digest: the facilitator replays the current status.
        return new Response(JSON.stringify({ status: "confirmed", chainTxId: "tx-abc" }), { status: 200 });
      }
      throw new Error(`unexpected GET ${url}`);
    });

    const first = await settle(record, signed, fast);
    const second = await settle(record, signed, fast);
    expect(first).toEqual(second);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.filter(([u]) => String(u).includes("/settlement/"))).toHaveLength(0);
  });

  it("expired settlement rejects with a typed error carrying outputMask + requestId", async () => {
    const record = makeRecord();
    const signed = makeSignedClaim();
    stubFetch((url) => {
      if (url.endsWith("/x402/settle")) {
        return new Response(JSON.stringify({ status: "held" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "expired" }), { status: 200 });
    });

    const err = await settle(record, signed, fast).then(undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(X402SettlementExpired);
    const typed = err as X402SettlementExpired;
    expect(typed.outputMask).toBe("mask-1");
    expect(typed.requestId).toBe("req-1");
    expect(typed.localDigest).toBe(signed.txHash);
    expect(typed.message).toContain("htlcRefund");
  });

  it("missing outputMask fails loudly before any HTTP call", async () => {
    const record = makeRecord({ outputMask: "" });
    const spy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", spy);

    const err = await settle(record, makeSignedClaim(), fast).then(undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(X402MissingOutputMaskError);
    expect((err as X402MissingOutputMaskError).message).toContain("outputMask");
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects on a failed settle POST", async () => {
    stubFetch(() => new Response("nope", { status: 503 }));
    await expect(settle(makeRecord(), makeSignedClaim(), fast)).rejects.toThrow(/HTTP 503/);
  });

  it("rejects on an unknown settlement status", async () => {
    stubFetch((url) => {
      if (url.endsWith("/x402/settle")) {
        return new Response(JSON.stringify({ status: "held" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "weird" }), { status: 200 });
    });
    await expect(settle(makeRecord(), makeSignedClaim(), fast)).rejects.toThrow(/weird/);
  });

  it("tolerates a trailing slash on facilitatorUrl", async () => {
    const record = makeRecord({ quote: makeQuote({ facilitatorUrl: "https://indexer.example/" }) });
    const spy = stubFetch(() => new Response(JSON.stringify({ status: "confirmed", chainTxId: "tx-1" }), { status: 200 }));
    await settle(record, makeSignedClaim(), fast);
    expect(spy.mock.calls[0]?.[0]).toBe("https://indexer.example/x402/settle");
  });
});

describe("settle poll bounds (audit #2)", () => {
  it("throws X402PollTimeoutError when held persists past pollTimeoutMs", async () => {
    const record = makeRecord();
    const signed = makeSignedClaim();
    stubFetch(() => new Response(JSON.stringify({ status: "held" }), { status: 200 }));
    await expect(
      settle(record, signed, { pollIntervalMs: 1, pollTimeoutMs: 40, allowServerSide: true })
    ).rejects.toBeInstanceOf(X402PollTimeoutError);
    await expect(
      settle(record, signed, { pollIntervalMs: 1, pollTimeoutMs: 40, allowServerSide: true })
    ).rejects.toMatchObject({ localDigest: signed.txHash });
  });

  it("caps the poll at the quote's expiresAt and throws X402SettlementExpired", async () => {
    const record = makeRecord({ quote: makeQuote({ expiresAt: Date.now() - 1 }) });
    const signed = makeSignedClaim();
    stubFetch(() => new Response(JSON.stringify({ status: "held" }), { status: 200 }));
    await expect(
      settle(record, signed, { pollIntervalMs: 1, pollTimeoutMs: 60_000, allowServerSide: true })
    ).rejects.toBeInstanceOf(X402SettlementExpired);
  });

  it("no timeout error when the POST immediately resolves", async () => {
    const record = makeRecord();
    const signed = makeSignedClaim();
    stubFetch(() => new Response(JSON.stringify({ status: "confirmed", chainTxId: "t" }), { status: 200 }));
    const result = await settle(record, signed, { pollIntervalMs: 1, pollTimeoutMs: 0, allowServerSide: true });
    expect(result.status).toBe("confirmed");
  });
});

describe("server-side guard (audit #3)", () => {
  it("settle throws X402BrowserOnlyError in Node without the explicit opt-in", async () => {
    const record = makeRecord();
    const signed = makeSignedClaim();
    await expect(settle(record, signed, { pollIntervalMs: 1 })).rejects.toBeInstanceOf(
      X402BrowserOnlyError
    );
  });

  it("settle proceeds in Node with allowServerSide: true", async () => {
    const record = makeRecord();
    const signed = makeSignedClaim();
    stubFetch(() => new Response(JSON.stringify({ status: "confirmed", chainTxId: "t" }), { status: 200 }));
    const result = await settle(record, signed, { pollIntervalMs: 1, allowServerSide: true });
    expect(result.status).toBe("confirmed");
  });
});
