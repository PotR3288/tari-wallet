import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localAccountId } from "@chironbuilder/ootle-sdk";
import {
  addAddressBookEntry,
  addTransactionHistoryEntry,
  addTransactionRequest,
  beginTransactionRequestSubmit,
  daemonAccountId,
  getState,
  getConnectedSite,
  getTransactionRequest,
  hasViewAccess,
  listTransactionHistory,
  parseAccountId,
  recordTransactionRequestDecision,
  addConnectedSite,
  removeAddressBookEntry,
  removeConnectedSite,
  setTransactionRequestStatus,
  setViewAccess,
  type TransactionRequestRecord,
} from "./storage";

/** A minimal in-memory stand-in for chrome.storage.local -- get/set semantics only (get returns
 * whichever requested keys exist, set shallow-merges), enough for storage.ts's own usage. Not used
 * elsewhere in this suite (see vitest.config.ts's own comment on why chrome APIs normally aren't
 * mocked here) -- added specifically to exercise the read-modify-write race fix below, which is
 * exactly the kind of bug a future refactor could silently reintroduce without a real regression
 * test catching it. */
function installChromeStorageStub(): Record<string, unknown> {
  const store: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async (keys: string[]) => Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]])),
        set: async (patch: Record<string, unknown>) => {
          Object.assign(store, patch);
        },
        clear: async () => {
          for (const k of Object.keys(store)) delete store[k];
        },
      },
    },
  });
  return store;
}

describe("localAccountId / parseAccountId round-trip", () => {
  it("round-trips a local account id", () => {
    const id = localAccountId(3);
    expect(id).toBe("local:3");
    expect(parseAccountId(id)).toEqual({ type: "local", index: 3 });
  });

  it("round-trips index 0", () => {
    expect(parseAccountId(localAccountId(0))).toEqual({ type: "local", index: 0 });
  });
});

describe("daemonAccountId / parseAccountId round-trip", () => {
  it("round-trips a daemon account id", () => {
    const id = daemonAccountId("conn-1", "component_abc123");
    expect(id).toBe("daemon:conn-1:component_abc123");
    expect(parseAccountId(id)).toEqual({ type: "daemon", connectionId: "conn-1", componentAddress: "component_abc123" });
  });

  it("handles a component address that itself contains colons safely", () => {
    // Component addresses never actually contain colons, but the parser splits on the *first*
    // colon after "daemon:<connectionId>" — verifying it doesn't truncate the component address if
    // the connection id or address ever did contain one.
    const id = daemonAccountId("conn-1", "component_abc:def");
    expect(parseAccountId(id)).toEqual({ type: "daemon", connectionId: "conn-1", componentAddress: "component_abc:def" });
  });
});

describe("parseAccountId", () => {
  it("throws on a malformed id", () => {
    expect(() => parseAccountId("garbage")).toThrow("Malformed account id");
  });

  it("throws on an empty string", () => {
    expect(() => parseAccountId("")).toThrow("Malformed account id");
  });
});

describe("concurrent mutations serialize instead of losing updates", () => {
  beforeEach(() => installChromeStorageStub());
  afterEach(() => vi.unstubAllGlobals());

  it("two concurrent addAddressBookEntry calls both survive (neither read-modify-write clobbers the other)", async () => {
    await Promise.all([
      addAddressBookEntry({ id: "a", label: "Alice", address: "otl_esm_a" }),
      addAddressBookEntry({ id: "b", label: "Bob", address: "otl_esm_b" }),
    ]);
    const { addressBook } = await getState();
    expect(addressBook.map((e) => e.id).sort()).toEqual(["a", "b"]);
  });

  it("many concurrent adds all survive, not just two", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => addAddressBookEntry({ id: `entry-${i}`, label: `Entry ${i}`, address: `otl_esm_${i}` }))
    );
    const { addressBook } = await getState();
    expect(addressBook).toHaveLength(20);
    expect(new Set(addressBook.map((e) => e.id)).size).toBe(20);
  });

  it("an add racing a remove resolves to a consistent, non-clobbered state", async () => {
    await addAddressBookEntry({ id: "keep", label: "Keep", address: "otl_esm_keep" });
    await Promise.all([
      addAddressBookEntry({ id: "new", label: "New", address: "otl_esm_new" }),
      removeAddressBookEntry("keep"),
    ]);
    const { addressBook } = await getState();
    expect(addressBook.map((e) => e.id).sort()).toEqual(["new"]);
  });
});

describe("transaction requests", () => {
  beforeEach(() => installChromeStorageStub());
  afterEach(() => vi.unstubAllGlobals());

  function pendingRecord(overrides: Partial<TransactionRequestRecord> = {}): TransactionRequestRecord {
    const now = Date.now();
    return {
      id: "req-1",
      origin: "https://dapp.example",
      accountId: "local:0",
      operation: { kind: "instructions", instructions: [] },
      note: "",
      status: "pending",
      createdAt: now,
      expiresAt: now + 60_000,
      ...overrides,
    };
  }

  it("round-trips a stored record", async () => {
    await addTransactionRequest(pendingRecord());
    const record = await getTransactionRequest("req-1");
    expect(record?.status).toBe("pending");
    expect(record?.origin).toBe("https://dapp.example");
  });

  it("returns undefined for an unknown id", async () => {
    expect(await getTransactionRequest("does-not-exist")).toBeUndefined();
  });

  it("transitions pending -> approved -> submitted, carrying the result", async () => {
    await addTransactionRequest(pendingRecord());
    expect(await recordTransactionRequestDecision("req-1", true)).toBe(true);
    expect((await getTransactionRequest("req-1"))?.status).toBe("approved");

    await setTransactionRequestStatus("req-1", { status: "submitted", result: { transactionId: "tx-123" } });
    const submitted = await getTransactionRequest("req-1");
    expect(submitted?.status).toBe("submitted");
    expect(submitted?.result).toEqual({ transactionId: "tx-123" });
  });

  it("transitions to failed, carrying the error", async () => {
    await addTransactionRequest(pendingRecord({ status: "approved" }));
    await setTransactionRequestStatus("req-1", { status: "failed", error: "insufficient funds" });
    const record = await getTransactionRequest("req-1");
    expect(record?.status).toBe("failed");
    expect(record?.error).toBe("insufficient funds");
  });

  it("setTransactionRequestStatus returns false for an unknown id, without throwing", async () => {
    expect(await setTransactionRequestStatus("does-not-exist", { status: "submitted", result: null })).toBe(false);
  });

  it("a stale pending request reads back as rejected/expired instead of staying approvable forever", async () => {
    await addTransactionRequest(pendingRecord({ expiresAt: Date.now() - 1000 }));
    const record = await getTransactionRequest("req-1");
    expect(record?.status).toBe("rejected");
    expect(record?.error).toMatch(/expired/i);
  });

  it("a stale approved (but never submitted) request also reads back as expired", async () => {
    await addTransactionRequest(pendingRecord({ status: "approved", expiresAt: Date.now() - 1000 }));
    const record = await getTransactionRequest("req-1");
    expect(record?.status).toBe("rejected");
  });

  it("an already-submitted request never reads back as expired, however old", async () => {
    await addTransactionRequest(pendingRecord({ status: "submitted", result: { ok: true }, expiresAt: Date.now() - 1000 }));
    const record = await getTransactionRequest("req-1");
    expect(record?.status).toBe("submitted");
  });

  it("expiry is derived on read, never written back to storage", async () => {
    await addTransactionRequest(pendingRecord({ expiresAt: Date.now() - 1000 }));
    await getTransactionRequest("req-1"); // trigger the lazy-expiry read path
    // A fresh read still sees the original "pending" status in storage -- the decision write
    // would still succeed against it (an approval that arrives just as a request goes stale should
    // still be honored, not silently dropped because a read happened to observe it as expired
    // first; the submit-time claim re-checks expiry).
    expect(await recordTransactionRequestDecision("req-1", true)).toBe(true);
  });

  it("many concurrent addTransactionRequest calls all survive", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => addTransactionRequest(pendingRecord({ id: `req-${i}` }))));
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => getTransactionRequest(`req-${i}`)));
    expect(results.every((r) => r !== undefined)).toBe(true);
  });
});

describe("transaction request submit claiming", () => {
  beforeEach(() => installChromeStorageStub());
  afterEach(() => vi.unstubAllGlobals());

  function pendingRecord(overrides: Partial<TransactionRequestRecord> = {}): TransactionRequestRecord {
    const now = Date.now();
    return {
      id: "req-1",
      origin: "https://dapp.example",
      accountId: "local:0",
      operation: { kind: "instructions", instructions: [] },
      note: "",
      status: "pending",
      createdAt: now,
      expiresAt: now + 60_000,
      ...overrides,
    };
  }

  it("claims an approved request atomically, moving it to submitting", async () => {
    await addTransactionRequest(pendingRecord({ status: "approved" }));
    const outcome = await beginTransactionRequestSubmit("req-1");
    expect(outcome.claimed).toBe(true);
    if (outcome.claimed) {
      expect(outcome.record.status).toBe("submitting");
      expect(outcome.record.operation).toEqual(pendingRecord().operation);
    }
    expect((await getTransactionRequest("req-1"))?.status).toBe("submitting");
  });

  it("a second claim over an already-claimed request fails with wrong-status (no double execution)", async () => {
    await addTransactionRequest(pendingRecord({ status: "approved" }));
    expect((await beginTransactionRequestSubmit("req-1")).claimed).toBe(true);
    const second = await beginTransactionRequestSubmit("req-1");
    expect(second.claimed).toBe(false);
    if (!second.claimed) {
      expect(second.reason).toBe("wrong-status");
      expect(second.record?.status).toBe("submitting");
    }
  });

  it("two concurrent claims over one approved request let exactly one win", async () => {
    await addTransactionRequest(pendingRecord({ status: "approved" }));
    const [a, b] = await Promise.all([beginTransactionRequestSubmit("req-1"), beginTransactionRequestSubmit("req-1")]);
    expect([a.claimed, b.claimed].filter(Boolean)).toHaveLength(1);
    expect((await getTransactionRequest("req-1"))?.status).toBe("submitting");
  });

  it("refuses to claim a pending (never-approved) request", async () => {
    await addTransactionRequest(pendingRecord());
    const outcome = await beginTransactionRequestSubmit("req-1");
    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed) expect(outcome.reason).toBe("wrong-status");
    // The refused claim must not have mutated anything -- the request is still approvable.
    expect(await recordTransactionRequestDecision("req-1", true)).toBe(true);
  });

  it("refuses to claim an expired approved request, and reports expired", async () => {
    await addTransactionRequest(pendingRecord({ status: "approved", expiresAt: Date.now() - 1000 }));
    const outcome = await beginTransactionRequestSubmit("req-1");
    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed) expect(outcome.reason).toBe("expired");
    // The failed claim must not have moved it out of the expirable states.
    expect((await getTransactionRequest("req-1"))?.status).toBe("rejected"); // lazy-expired view
  });

  it("reports not-found for an unknown id", async () => {
    const outcome = await beginTransactionRequestSubmit("does-not-exist");
    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed) expect(outcome.reason).toBe("not-found");
  });

  it("a stuck submitting record never reads back as expired, however old", async () => {
    await addTransactionRequest(pendingRecord({ status: "submitting", expiresAt: Date.now() - 1000 }));
    const record = await getTransactionRequest("req-1");
    expect(record?.status).toBe("submitting");
  });
});

describe("recordTransactionRequestDecision guard", () => {
  beforeEach(() => installChromeStorageStub());
  afterEach(() => vi.unstubAllGlobals());

  function pendingRecord(overrides: Partial<TransactionRequestRecord> = {}): TransactionRequestRecord {
    const now = Date.now();
    return {
      id: "req-1",
      origin: "https://dapp.example",
      accountId: "local:0",
      operation: { kind: "instructions", instructions: [] },
      note: "",
      status: "pending",
      createdAt: now,
      expiresAt: now + 60_000,
      ...overrides,
    };
  }

  it("decides a pending request exactly once; a duplicate click is a no-op", async () => {
    await addTransactionRequest(pendingRecord());
    expect(await recordTransactionRequestDecision("req-1", true)).toBe(true);
    expect(await recordTransactionRequestDecision("req-1", true)).toBe(false);
    expect(await recordTransactionRequestDecision("req-1", false)).toBe(false);
    expect((await getTransactionRequest("req-1"))?.status).toBe("approved");
  });

  it("never overwrites a claimed/submitted/failed record with a late decision write", async () => {
    // The race this guards: a submission claims ("submitting") moments after the user's click
    // resolved; resolveApproval's persisted write must not flip it back to "approved" and reopen
    // the double-submit window.
    for (const status of ["submitting", "submitted", "failed"] as const) {
      const id = `req-${status}`;
      await addTransactionRequest(pendingRecord({ id, status, result: status === "submitted" ? { ok: true } : undefined, error: status === "failed" ? "boom" : undefined }));
      expect(await recordTransactionRequestDecision(id, true)).toBe(false);
      expect(await recordTransactionRequestDecision(id, false)).toBe(false);
      expect((await getTransactionRequest(id))?.status).toBe(status);
    }
  });

  it("returns false for an unknown id", async () => {
    expect(await recordTransactionRequestDecision("does-not-exist", true)).toBe(false);
  });
});

// The `signed-unbroadcast` terminal state (Task 2.4): a completed `x402SignClaim` -- the wallet
// built, signed and sealed the HTLC claim and handed the payload back, and nothing was ever
// broadcast. It must read back idempotently (the stored payload IS the result), must never be
// claimable for submission again, and must never expire into a misleading status.
describe("signed-unbroadcast (completed x402SignClaim) requests", () => {
  beforeEach(() => installChromeStorageStub());
  afterEach(() => vi.unstubAllGlobals());

  function signClaimRecord(overrides: Partial<TransactionRequestRecord> = {}): TransactionRequestRecord {
    const now = Date.now();
    return {
      id: "req-1",
      origin: "https://dapp.example",
      accountId: "local:0",
      operation: {
        kind: "x402SignClaim",
        envelope: {
          resourceUrl: "https://example.com/report",
          amount: "1000000",
          resourceAddress: "resource_0101010101010101010101010101010101010101010101010101010101010101",
          claimantAddress: "otl_esm_1v3sn0fajd7kwyc3j8pzgsc0eqwtv4xqjmrxq0r7vqmr5l2e8",
          hashLockHex: "0f4a7d3b9c2e5186a0d1f2e3c4b5a6978897a6b5c4d3e2f10697a8b9c0d1e2f3",
          refundEpoch: 520,
          facilitatorUrl: "https://facilitator.example.com/x402/settle",
          expiresAt: now + 60_000,
        },
        preimageHex: "cd".repeat(32),
        htlcOutputCommitmentHex: "ab".repeat(32),
        conditions: [],
      },
      note: "",
      status: "approved",
      createdAt: now,
      expiresAt: now + 60_000,
      ...overrides,
    };
  }

  const SEALED = { signedPayloadHex: "00ff", txHash: "ab".repeat(32), htlcOutputCommitment: "ab".repeat(32), refundEpoch: 520, validUntilEpoch: 519 };

  it("finalizes a completed sign-only request as signed-unbroadcast, with the sealed payload as its result", async () => {
    await addTransactionRequest(signClaimRecord());
    expect(await setTransactionRequestStatus("req-1", { status: "signed-unbroadcast", result: SEALED })).toBe(true);
    const record = await getTransactionRequest("req-1");
    expect(record?.status).toBe("signed-unbroadcast");
    expect(record?.result).toEqual(SEALED);
  });

  it("re-polls idempotently: repeated reads return the same status and stored result, even past the request's TTL", async () => {
    await addTransactionRequest(signClaimRecord({ status: "signed-unbroadcast", expiresAt: Date.now() - 1000, result: SEALED }));
    for (let i = 0; i < 3; i++) {
      const record = await getTransactionRequest("req-1");
      // Like "submitted" (and unlike a stale "pending"/"approved"), a completed sign-only request
      // is past the lazy-expiry gate: a dApp recovering after a reload re-reads its payload.
      expect(record?.status).toBe("signed-unbroadcast");
      expect(record?.result).toEqual(SEALED);
    }
  });

  it("is not re-submittable: the submit claim gate refuses it and leaves the record intact", async () => {
    await addTransactionRequest(signClaimRecord({ status: "signed-unbroadcast", result: SEALED }));
    const outcome = await beginTransactionRequestSubmit("req-1");
    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed) {
      expect(outcome.reason).toBe("wrong-status");
      expect(outcome.record?.status).toBe("signed-unbroadcast");
    }
    // The refused claim must not have mutated anything -- the stored payload survives.
    const record = await getTransactionRequest("req-1");
    expect(record?.status).toBe("signed-unbroadcast");
    expect(record?.result).toEqual(SEALED);
  });

  it("history: a signed-unbroadcast entry round-trips distinctly from confirmed/failed (never implies funds moved)", async () => {
    await addTransactionHistoryEntry({
      id: "hist-1",
      accountId: "local:0",
      kind: "dapp-transaction",
      counterparty: "https://dapp.example: x402 claim (sign only) -> https://example.com/report",
      status: "signed-unbroadcast",
      createdAt: Date.now(),
    });
    const entries = await listTransactionHistory("local:0");
    expect(entries[0]?.status).toBe("signed-unbroadcast");
    expect(entries[0]?.status).not.toBe("confirmed");
  });
});

describe("private view access grants", () => {
  beforeEach(() => installChromeStorageStub());
  afterEach(() => vi.unstubAllGlobals());

  const ORIGIN = "https://dapp.example";

  it("a fresh connection has no view access", async () => {
    await addConnectedSite(ORIGIN, localAccountId(0));
    expect((await getConnectedSite(ORIGIN))?.viewAccessGrantedAt).toBeUndefined();
    expect(await hasViewAccess(ORIGIN)).toBe(false);
  });

  it("grants, reports and revokes", async () => {
    await addConnectedSite(ORIGIN, localAccountId(0));
    expect(await setViewAccess(ORIGIN, true)).toBe(true);
    expect(await hasViewAccess(ORIGIN)).toBe(true);
    expect(typeof (await getConnectedSite(ORIGIN))?.viewAccessGrantedAt).toBe("number");

    expect(await setViewAccess(ORIGIN, false)).toBe(true);
    expect(await hasViewAccess(ORIGIN)).toBe(false);
    // Revoking must remove the key outright, not leave a falsy timestamp behind that a later
    // `!== undefined` check would read as still granted.
    expect("viewAccessGrantedAt" in ((await getConnectedSite(ORIGIN)) ?? {})).toBe(false);
  });

  it("cannot be granted to an origin that isn't connected", async () => {
    // Otherwise a site could get a view grant without ever passing the connect prompt.
    expect(await setViewAccess("https://never-connected.example", true)).toBe(false);
    expect(await hasViewAccess("https://never-connected.example")).toBe(false);
  });

  it("does not survive a disconnect + reconnect", async () => {
    await addConnectedSite(ORIGIN, localAccountId(0));
    await setViewAccess(ORIGIN, true);
    await removeConnectedSite(ORIGIN);
    await addConnectedSite(ORIGIN, localAccountId(0));
    expect(await hasViewAccess(ORIGIN)).toBe(false);
  });

  it("does not survive re-approving a connection that was never disconnected", async () => {
    // addConnectedSite replaces the record wholesale rather than merging into it -- re-approving a
    // *connection* must not silently re-grant a *view* permission the user was never re-asked about.
    await addConnectedSite(ORIGIN, localAccountId(0));
    await setViewAccess(ORIGIN, true);
    await addConnectedSite(ORIGIN, localAccountId(1));
    expect(await hasViewAccess(ORIGIN)).toBe(false);
  });

  it("is scoped to one origin", async () => {
    await addConnectedSite(ORIGIN, localAccountId(0));
    await addConnectedSite("https://other.example", localAccountId(0));
    await setViewAccess(ORIGIN, true);
    expect(await hasViewAccess(ORIGIN)).toBe(true);
    expect(await hasViewAccess("https://other.example")).toBe(false);
  });

  it("leaves the connection itself intact when revoked", async () => {
    // The Connected sites screen offers revoke as an alternative to Disconnect -- the site has to
    // keep working afterwards, just without the confidential reads.
    await addConnectedSite(ORIGIN, localAccountId(2));
    await setViewAccess(ORIGIN, true);
    await setViewAccess(ORIGIN, false);
    const site = await getConnectedSite(ORIGIN);
    expect(site?.accountId).toBe(localAccountId(2));
  });
});
