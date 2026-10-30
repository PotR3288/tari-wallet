import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasTari,
  pay,
  signClaim,
  storageKey,
  X402NoWalletError,
  X402WalletError,
  type X402PaymentRecord,
  type X402Quote,
} from "./index.js";
import { FakeLocalStorage, HASH_LOCK, makeQuote } from "./test-utils.js";

/** Records every request and answers from a scripted method handler map. */
function makeTari(handlers: Record<string, (params: Record<string, unknown>) => unknown>) {
  const calls: { method: string; params: Record<string, unknown> | undefined }[] = [];
  const tari = {
    calls,
    async request(args: { method: string; params?: Record<string, unknown> }): Promise<unknown> {
      calls.push({ method: args.method, params: args.params });
      const handler = handlers[args.method];
      if (!handler) throw new Error(`unexpected method ${args.method}`);
      return handler(args.params ?? {});
    },
  };
  vi.stubGlobal("window", { tari });
  return tari;
}

const SUBMIT_RESULT = {
  txHash: "d".repeat(64),
  outputMask: "mask-1",
  htlcOutputCommitmentHex: "e".repeat(64),
  conditions: [{ type: "HashLock" }, { type: "AfterEpoch", epoch: 5000 }],
};

const fast = { pollIntervalMs: 1 };

let ls: FakeLocalStorage;
beforeEach(() => {
  ls = new FakeLocalStorage();
  vi.stubGlobal("localStorage", ls);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hasTari", () => {
  it("is false without a provider and true with one", () => {
    vi.stubGlobal("window", {});
    expect(hasTari()).toBe(false);
    vi.stubGlobal("window", { tari: { request: vi.fn() } });
    expect(hasTari()).toBe(true);
  });

  it("pay throws a typed error with no wallet", async () => {
    vi.stubGlobal("window", {});
    await expect(pay(makeQuote())).rejects.toBeInstanceOf(X402NoWalletError);
  });
});

describe("pay", () => {
  it("drives create → pending → approved → submit and persists all five fields", async () => {
    const quote = makeQuote();
    let getStatuss = 0;
    const tari = makeTari({
      tari_createTransactionRequest: (p) => {
        expect(p.kind).toBe("x402Pay");
        expect((p as unknown as X402Quote).amount).toBe(quote.amount);
        return { requestId: "req-1" };
      },
      tari_getTransactionRequest: () => {
        getStatuss += 1;
        return getStatuss === 1 ? { status: "pending" } : { status: "approved" };
      },
      tari_submitTransactionRequest: () => SUBMIT_RESULT,
    });

    const record = await pay(quote, fast);

    expect(record).toEqual({
      requestId: "req-1",
      txHash: SUBMIT_RESULT.txHash,
      outputMask: SUBMIT_RESULT.outputMask,
      htlcOutputCommitmentHex: SUBMIT_RESULT.htlcOutputCommitmentHex,
      conditions: SUBMIT_RESULT.conditions,
      quote,
    });
    // The persisted record matches the resolved one, under the hashLockHex-derived key.
    expect(JSON.parse(ls.dump()[storageKey(quote)] ?? "{}")).toEqual(record);
    expect(tari.calls.map((c) => c.method)).toEqual([
      "tari_createTransactionRequest",
      "tari_getTransactionRequest",
      "tari_getTransactionRequest",
      "tari_submitTransactionRequest",
    ]);
  });

  it("rejects with the wallet's error on a rejected request", async () => {
    makeTari({
      tari_createTransactionRequest: () => ({ requestId: "req-2" }),
      tari_getTransactionRequest: () => ({ status: "rejected", error: "User said no." }),
    });
    const err = await pay(makeQuote(), fast).then(undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(X402WalletError);
    expect((err as X402WalletError).message).toBe("User said no.");
    expect((err as X402WalletError).requestId).toBe("req-2");
    expect(ls.dump()[storageKey(makeQuote())]).toBeUndefined();
  });

  it("rejects on a failed request with a default message", async () => {
    makeTari({
      tari_createTransactionRequest: () => ({ requestId: "req-3" }),
      tari_getTransactionRequest: () => ({ status: "failed" }),
    });
    await expect(pay(makeQuote(), fast)).rejects.toThrow("Transaction failed.");
  });

  it("resume: a fresh module instance resumes an already-approved stored requestId and submits it", async () => {
    const quote = makeQuote();
    // A previous page created the request; the user approved it during the reload.
    ls.setItem(
      storageKey(quote),
      JSON.stringify({ requestId: "req-resume", quote })
    );
    const tari = makeTari({
      tari_getTransactionRequest: (p) => {
        expect(p.requestId).toBe("req-resume");
        return { status: "approved" };
      },
      tari_submitTransactionRequest: () => SUBMIT_RESULT,
    });

    // Fresh module instance, as after a reload.
    vi.resetModules();
    const { pay: freshPay } = (await import("./index.js")) as typeof import("./index.js");
    const record = await freshPay(quote, fast);

    // No create call — the stored requestId was resumed, not re-created.
    expect(tari.calls.map((c) => c.method)).toEqual([
      "tari_getTransactionRequest",
      "tari_submitTransactionRequest",
    ]);
    expect(record.requestId).toBe("req-resume");
    expect(record.outputMask).toBe(SUBMIT_RESULT.outputMask);
    expect(JSON.parse(ls.dump()[storageKey(quote)] ?? "{}")).toEqual(record);
  });

  it("resume: an already-submitted stored requestId resolves from the stored result", async () => {
    const quote = makeQuote();
    ls.setItem(
      storageKey(quote),
      JSON.stringify({ requestId: "req-done", quote })
    );
    const tari = makeTari({
      tari_getTransactionRequest: (p) => {
        expect(p.requestId).toBe("req-done");
        return { status: "submitted", result: SUBMIT_RESULT };
      },
    });

    const record = await pay(quote, fast);
    expect(tari.calls.map((c) => c.method)).toEqual(["tari_getTransactionRequest"]);
    expect(record.txHash).toBe(SUBMIT_RESULT.txHash);
    expect(record.requestId).toBe("req-done");
  });

  it("throws a typed error when the x402Pay result is missing outputMask", async () => {
    makeTari({
      tari_createTransactionRequest: () => ({ requestId: "req-4" }),
      tari_getTransactionRequest: () => ({ status: "approved" }),
      tari_submitTransactionRequest: () => ({ ...SUBMIT_RESULT, outputMask: undefined }),
    });
    await expect(pay(makeQuote(), fast)).rejects.toThrow(/outputMask/);
  });

  it("re-pays are idempotent through the stored record (no second create)", async () => {
    const quote = makeQuote();
    const done: X402PaymentRecord = {
      requestId: "req-old",
      txHash: SUBMIT_RESULT.txHash,
      outputMask: SUBMIT_RESULT.outputMask,
      htlcOutputCommitmentHex: SUBMIT_RESULT.htlcOutputCommitmentHex,
      conditions: SUBMIT_RESULT.conditions,
      quote,
    };
    ls.setItem(storageKey(quote), JSON.stringify(done));
    const tari = makeTari({
      tari_getTransactionRequest: () => ({ status: "submitted", result: SUBMIT_RESULT }),
    });
    const record = await pay(quote, fast);
    expect(tari.calls.every((c) => c.method === "tari_getTransactionRequest")).toBe(true);
    expect(record).toEqual(done);
  });
});

describe("signClaim", () => {
  it("drives the x402SignClaim kind and resolves the signed payload", async () => {
    const quote = makeQuote();
    const signed = {
      signedPayloadHex: "ff".repeat(32),
      txHash: "9".repeat(64),
      htlcOutputCommitment: "e".repeat(64),
      refundEpoch: 5000,
      validUntilEpoch: 4999,
    };
    const tari = makeTari({
      tari_createTransactionRequest: (p) => {
        expect(p.kind).toBe("x402SignClaim");
        return { requestId: "req-sc" };
      },
      tari_getTransactionRequest: () => ({ status: "approved" }),
      tari_submitTransactionRequest: () => signed,
    });
    const result = await signClaim(
      { envelope: quote, preimageHex: "01", htlcOutputCommitmentHex: "e".repeat(64), conditions: [] },
      fast
    );
    expect(result).toEqual(signed);
    expect(tari.calls[0]?.params?.kind).toBe("x402SignClaim");
  });
});
