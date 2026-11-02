import { describe, expect, it, vi } from "vitest";
import {
  DaemonAccount,
  classifyAuthRejection,
  isDaemonUnreachable,
  nextMissingSubstateToRetry,
  throwOnRejection,
  toIndexerResultShape,
} from "./daemonAccount";
import type { Account, IndexerGetTransactionResultResponse, TransactionWaitResultResponse } from "@tari-project/ootle-ts-bindings";

const XTR = "resource_0101010101010101010101010101010101010101010101010101010101010101";
const TEST_ACCOUNT: Account = {
  name: "test",
  component_address: "component_" + "aa".repeat(32),
  view_only_key_id: { Derived: { index: 0, key_branch: "view_only_key" } },
  owner_key_id: { Derived: { index: 0, key_branch: "account" } },
  owner_public_key: "bb".repeat(32),
  birthday_epoch: 0,
  is_confirmed_on_chain: true,
  is_default: true,
};
const TEST_ADDRESS = "otl_esm_test";
const TEST_URL = "http://localhost:5100";

// Only the client/indexerProvider methods a given test actually exercises need a real
// implementation -- the rest of DaemonAccount's real constructor signature is satisfied with
// empty stubs, same spirit as not hand-mocking an entire JRPC client just to construct one.
function makeAccount(clientOverrides: Record<string, unknown>, indexerOverrides: Record<string, unknown> = {}): DaemonAccount {
  const client = clientOverrides as unknown as ConstructorParameters<typeof DaemonAccount>[0];
  const indexerProvider = indexerOverrides as unknown as ConstructorParameters<typeof DaemonAccount>[1];
  return new DaemonAccount(client, indexerProvider, "esmeralda", TEST_ACCOUNT, TEST_ADDRESS, TEST_URL);
}

function rpcError(code: number, message: string, method = "some.method"): Error {
  return new Error(`RPC Error ${code}: ${message}`, { cause: { method, code, message } });
}

describe("classifyAuthRejection", () => {
  it("classifies an insufficient-permission message (confirmed against a live daemon)", () => {
    expect(classifyAuthRejection(rpcError(401, "Insufficient permissions. Required 'Admin'"))).toBe("insufficient-permission");
  });

  it("classifies an insufficient-permission message for a scoped resource permission", () => {
    expect(classifyAuthRejection(rpcError(401, "Insufficient permissions. Required 'Settings(Read)'"))).toBe("insufficient-permission");
  });

  it("classifies an 'Access denied' message as expired-or-invalid", () => {
    expect(classifyAuthRejection(rpcError(401, "Access denied. Invalid bearer token"))).toBe("expired-or-invalid");
  });

  it("classifies a revoked-key message as expired-or-invalid", () => {
    expect(classifyAuthRejection(rpcError(401, "Access denied. API key is invalid or revoked"))).toBe("expired-or-invalid");
  });

  it("is case-insensitive about the 'insufficient permission' phrasing", () => {
    expect(classifyAuthRejection(rpcError(401, "INSUFFICIENT PERMISSIONS. Required 'Admin'"))).toBe("insufficient-permission");
  });

  it("returns null for a non-401 RPC error", () => {
    expect(classifyAuthRejection(rpcError(500, "Internal server error"))).toBeNull();
  });

  it("returns null for an unreachable-daemon-shaped error (no method/code cause)", () => {
    expect(classifyAuthRejection(new TypeError("Failed to fetch"))).toBeNull();
  });

  it("returns null for a non-Error value", () => {
    expect(classifyAuthRejection("some string")).toBeNull();
  });
});

describe("isDaemonUnreachable", () => {
  it("treats a bare TypeError (browser fetch failure) as unreachable", () => {
    expect(isDaemonUnreachable(new TypeError("Failed to fetch"))).toBe(true);
  });

  it("treats a non-Error value as not unreachable (nothing to classify)", () => {
    expect(isDaemonUnreachable("some string")).toBe(false);
    expect(isDaemonUnreachable(undefined)).toBe(false);
    expect(isDaemonUnreachable(null)).toBe(false);
  });

  it("treats a real RPC error (method + code in cause) as NOT unreachable", () => {
    const rpcError = new Error("RPC Error 401: Access denied", { cause: { method: "accounts.list", code: 401, message: "Access denied" } });
    expect(isDaemonUnreachable(rpcError)).toBe(false);
  });

  it("treats a Node errno-style cause (has code but no method) as unreachable", () => {
    // Regression: Node's fetch() sets .cause to the underlying errno error (e.g. ECONNREFUSED),
    // which also has a `.code` — checking for `code` alone previously misclassified this as a real
    // RPC error instead of a connectivity failure.
    const nodeFetchError = new Error("fetch failed", { cause: { code: "ECONNREFUSED", errno: -4078 } });
    expect(isDaemonUnreachable(nodeFetchError)).toBe(true);
  });

  it("treats our own withTimeout() timeout error as unreachable", () => {
    expect(isDaemonUnreachable(new Error("Timed out after 15000ms while connecting to the daemon."))).toBe(true);
  });
});

describe("throwOnRejection", () => {
  it("does not throw for an Accept outcome", () => {
    expect(() => throwOnRejection("tx1", { Accept: {} } as never)).not.toThrow();
  });

  it("throws a clear message for a Reject outcome", () => {
    expect(() => throwOnRejection("tx1", { Reject: "SomeReason" } as never)).toThrow("Transaction tx1 was rejected");
  });

  it("throws a clear message for an AcceptFeeRejectRest outcome", () => {
    expect(() => throwOnRejection("tx1", { AcceptFeeRejectRest: [{}, "SomeReason"] } as never)).toThrow(
      "Transaction tx1 accepted the fee but rejected the rest"
    );
  });
});

describe("nextMissingSubstateToRetry", () => {
  // Real shape confirmed live: a marketplace escrow template's own internal cross-template
  // `deposit` call rejected a real submission (`AcceptFeeRejectRest`) with this exact message
  // (see `execute()`'s own doc comment for the full story).
  const REAL_MESSAGE =
    "Transaction 4dad4f4719e6c1d5e4909a05e9cf8fddd0b959894c0cc9673554fe1231ee76 accepted the fee but rejected the rest: " +
    '[{...},{"ExecutionFailure":"At instruction #1: Cross-template call failed for method \'deposit\' on component ' +
    "f33184eb2f3606248f78d54a9d466d5a520356f72d50c3febafa537286cf41c': Runtime error: Substate " +
    "'vault_6fa9b48a6ada7974e36d11b36d5c58728d576f4f059f20994f5151f7b9704eee' not found or is not a transaction input\"}]";

  it("extracts the missing substate id from a real cross-template-call rejection", () => {
    const missing = nextMissingSubstateToRetry(new Error(REAL_MESSAGE), 0, 3, new Set());
    expect(missing).toBe("vault_6fa9b48a6ada7974e36d11b36d5c58728d576f4f059f20994f5151f7b9704eee");
  });

  it("returns null once the retry budget is spent", () => {
    expect(nextMissingSubstateToRetry(new Error(REAL_MESSAGE), 3, 3, new Set())).toBeNull();
    expect(nextMissingSubstateToRetry(new Error(REAL_MESSAGE), 4, 3, new Set())).toBeNull();
  });

  it("returns null for the same address a second time, instead of looping forever", () => {
    const seen = new Set(["vault_6fa9b48a6ada7974e36d11b36d5c58728d576f4f059f20994f5151f7b9704eee"]);
    expect(nextMissingSubstateToRetry(new Error(REAL_MESSAGE), 0, 3, seen)).toBeNull();
  });

  it("returns null for an error that isn't a missing-substate rejection (e.g. insufficient fees)", () => {
    expect(nextMissingSubstateToRetry(new Error("Transaction abc was rejected: InsufficientFeesPaid"), 0, 3, new Set())).toBeNull();
  });

  it("returns null for a non-Error value", () => {
    expect(nextMissingSubstateToRetry("some string", 0, 3, new Set())).toBeNull();
    expect(nextMissingSubstateToRetry(undefined, 0, 3, new Set())).toBeNull();
  });
});

describe("toIndexerResultShape", () => {
  it("maps a null result to Pending, carrying the transaction id along either way", () => {
    const response = { transaction_id: "tx1", result: null, status: "Pending", final_fee: 0n, timed_out: false } as TransactionWaitResultResponse;
    expect(toIndexerResultShape(response)).toEqual({ result: "Pending", transaction_id: "tx1", transactionId: "tx1" });
  });

  it("wraps a finalized result into OotleAccount's IndexerGetTransactionResultResponse shape", () => {
    const finalize = {
      transaction_hash: "hash1",
      events: [],
      logs: [],
      execution_results: [],
      result: { Accept: {} },
      fee_receipt: {},
    } as never;
    const response = {
      transaction_id: "tx1",
      result: finalize,
      status: "Accepted",
      final_fee: 629n,
      timed_out: false,
    } as TransactionWaitResultResponse;

    const wrapped = toIndexerResultShape(response);
    expect(wrapped.transaction_id).toBe("tx1");
    expect(wrapped.transactionId).toBe("tx1");
    const shaped = wrapped.result as Extract<IndexerGetTransactionResultResponse["result"], { Finalized: unknown }>;
    expect("Finalized" in shaped).toBe(true);
    if ("Finalized" in shaped) {
      expect(shaped.Finalized.final_decision).toBe("Commit");
      expect((shaped.Finalized.execution_result as unknown as { finalize: unknown } | null)?.finalize).toBe(finalize);
      expect(shaped.Finalized.abort_details).toBeNull();
    }
  });
});

describe("DaemonAccount.listUnspentShieldedOutputs", () => {
  it("maps each listed utxo to a ShieldedOutputRecord, using list's own already-decrypted value directly", async () => {
    // Confirmed against a live daemon: stealthUtxosList's `value` is already the real decrypted
    // amount for any utxo scoped by account_address -- a *separate* stealthUtxosDecryptValue call
    // for the same ids came back `{}` (that RPC is for a commitment this account doesn't already
    // recognize as its own, not for re-deriving a value list already decrypted).
    const account = makeAccount({
      stealthUtxosList: vi.fn().mockResolvedValue({
        utxos: [
          { address: { resource_address: XTR, id: "commitment-a" }, value: 1000n, status: "Unspent", memo: { Message: "hi" }, is_burnt: false, is_frozen: false, is_on_chain: true, sender_address: null, auth: "StealthPublicKey" },
          { address: { resource_address: XTR, id: "commitment-b" }, value: 2000n, status: "Unspent", memo: null, is_burnt: false, is_frozen: false, is_on_chain: true, sender_address: null, auth: "StealthPublicKey" },
        ],
      }),
    });

    const records = await account.listUnspentShieldedOutputs(XTR);
    expect(records).toEqual([
      { accountId: TEST_ACCOUNT.component_address, resourceAddress: XTR, commitment: "commitment-a", amount: "1000", transactionId: "", createdAt: 0, spent: false, memo: "hi" },
      { accountId: TEST_ACCOUNT.component_address, resourceAddress: XTR, commitment: "commitment-b", amount: "2000", transactionId: "", createdAt: 0, spent: false, memo: undefined },
    ]);
  });

  it("returns empty when there is nothing to list", async () => {
    const account = makeAccount({ stealthUtxosList: vi.fn().mockResolvedValue({ utxos: [] }) });
    expect(await account.listUnspentShieldedOutputs(XTR)).toEqual([]);
  });
});

describe("DaemonAccount.getPrivateBalances", () => {
  it("totals unspent outputs and folds in the resource's real metadata", async () => {
    const account = makeAccount(
      {
        stealthUtxosList: vi.fn().mockResolvedValue({
          utxos: [
            { address: { resource_address: XTR, id: "a" }, value: 400n, status: "Unspent", memo: null, is_burnt: false, is_frozen: false, is_on_chain: true, sender_address: null, auth: "StealthPublicKey" },
            { address: { resource_address: XTR, id: "b" }, value: 600n, status: "Unspent", memo: null, is_burnt: false, is_frozen: false, is_on_chain: true, sender_address: null, auth: "StealthPublicKey" },
          ],
        }),
      },
      { fetchSubstates: vi.fn().mockResolvedValue({ substates: { [XTR]: { version: 0, value: { Resource: { metadata: { SYMBOL: "tTARI" }, divisibility: 6 } } } } }) }
    );

    expect(await account.getPrivateBalances()).toEqual([{ resourceAddress: XTR, amount: 1000n, outputCount: 2, divisibility: 6, symbol: "tTARI", name: null }]);
  });

  it("returns empty (and never fetches resource metadata) when there are no unspent outputs", async () => {
    const fetchSubstates = vi.fn();
    const account = makeAccount({ stealthUtxosList: vi.fn().mockResolvedValue({ utxos: [] }) }, { fetchSubstates });
    expect(await account.getPrivateBalances()).toEqual([]);
    expect(fetchSubstates).not.toHaveBeenCalled();
  });
});

describe("DaemonAccount.shield", () => {
  // Real shape confirmed live against a running tari_ootle_walletd (both a dry run and a real
  // submission): stealthTransfer's own response carries only transaction_id, never the resulting
  // commitment/substate, so shield() has to recover both from the finalized result's up_substates.
  function finalizedAcceptResult(substateId: string) {
    return {
      transaction_id: "tx1",
      timed_out: false,
      final_fee: 9271n,
      status: "Accepted",
      result: {
        result: {
          Accept: {
            up_substates: [
              [substateId, { substate: { Utxo: {} }, version: 0 }],
              ["vault_x", { substate: { Vault: {} }, version: 4 }],
            ],
            down_substates: [["vault_x", 3]],
            fee_withdrawals: [],
          },
        },
      },
    } as unknown as TransactionWaitResultResponse;
  }

  it("submits via stealth_transfer and recovers commitment/substateId from the finalized up_substates", async () => {
    const substateId = `utxo_${XTR}_d6a5649f36e542f541879583acc34b689135565151897a213c62527859d9443f`;
    const stealthTransfer = vi.fn().mockResolvedValue({ transaction_id: "tx1" });
    const waitForTransactionResult = vi.fn().mockResolvedValue(finalizedAcceptResult(substateId));
    const account = makeAccount({ stealthTransfer, waitForTransactionResult });

    const result = await account.shield(XTR, 5000n, 50000n, "a memo");

    expect(stealthTransfer).toHaveBeenCalledWith({
      owner_account: { ComponentAddress: TEST_ACCOUNT.component_address },
      fee_params: { input_selection: "RevealedOnly", pay_fee_with_swap: null },
      input_selection: "RevealedOnly",
      resource_address: XTR,
      transfers: [
        {
          destination_address: TEST_ADDRESS,
          blinded_output_amount: "5000",
          revealed_output_amount: 0n,
          pay_to: "StealthPublicKey",
          attach_sender_address: false,
          output_memo: { Message: "a memo" },
        },
      ],
      max_fee: "50000",
      dry_run: false,
    });
    expect(result).toEqual({
      transactionId: "tx1",
      commitment: "d6a5649f36e542f541879583acc34b689135565151897a213c62527859d9443f",
      substateId,
      minimumValuePromise: "0",
    });
  });

  it("rejects a nonzero minimumValuePromise before ever calling the daemon (create_output_witness hardcodes minimum_value_promise: 0 server-side -- confirmed by reading the Rust source, no daemon JRPC can set it)", async () => {
    const stealthTransfer = vi.fn();
    const account = makeAccount({ stealthTransfer });
    await expect(account.shield(XTR, 5000n, 50000n, undefined, 1200n)).rejects.toThrow("minimumValuePromise");
    expect(stealthTransfer).not.toHaveBeenCalled();
  });

  it("throws on a genuine on-chain rejection instead of trying to find a substate that was never created", async () => {
    const stealthTransfer = vi.fn().mockResolvedValue({ transaction_id: "tx1" });
    const waitForTransactionResult = vi.fn().mockResolvedValue({
      transaction_id: "tx1",
      timed_out: false,
      final_fee: 0n,
      status: "Accepted",
      result: { result: { Reject: "SomeReason" } },
    } as unknown as TransactionWaitResultResponse);
    const account = makeAccount({ stealthTransfer, waitForTransactionResult });

    await expect(account.shield(XTR, 5000n)).rejects.toThrow("was rejected");
  });
});

function unspentUtxo(id: string, value: bigint) {
  return {
    address: { resource_address: XTR, id },
    value,
    status: "Unspent" as const,
    memo: null,
    is_burnt: false,
    is_frozen: false,
    is_on_chain: true,
    sender_address: null,
    auth: "StealthPublicKey" as const,
  };
}

// Both `unshield` and `sendPrivately` call `createStealthTransferStatement()` (a raw
// `sendRequest()` call -- `accounts.create_stealth_transfer_statement` isn't in the published
// `@tari-project/wallet_jrpc_client` npm bindings, confirmed by grepping its index.d.ts) *before*
// ever touching `TransactionBuilder`/`resolveTransaction` (real WASM, not worth mocking here --
// same reasoning as why this file has no `DaemonAccount.execute` tests either, only live
// verification). Rejecting that call with a distinctive, non-auth-shaped RPC error (so
// `daemonCall` propagates it unchanged instead of rewriting it) lets these tests inspect exactly
// what request was built -- coin selection, `Specific` input selection, output amounts -- without
// needing to mock the builder pipeline at all.
function stopHere() {
  return new Error("RPC Error 500: stop-here", { cause: { method: "accounts.create_stealth_transfer_statement", code: 500, message: "stop-here" } });
}

describe("DaemonAccount.unshield", () => {
  it("rejects a non-positive revealedOutAmount before ever calling the daemon", async () => {
    const stealthUtxosList = vi.fn();
    const account = makeAccount({ stealthUtxosList });
    await expect(account.unshield(XTR, 0n)).rejects.toThrow("greater than zero");
    await expect(account.unshield(XTR, -1n)).rejects.toThrow("greater than zero");
    expect(stealthUtxosList).not.toHaveBeenCalled();
  });

  it("selects the largest unspent UTXO covering the amount and builds a Specific-selection statement request with a combined revealed+blinded change output", async () => {
    const sendRequest = vi.fn().mockRejectedValue(stopHere());
    const account = makeAccount({
      stealthUtxosList: vi.fn().mockResolvedValue({ utxos: [unspentUtxo("big", 20000n)] }),
      sendRequest,
    });

    await expect(account.unshield(XTR, 3000n, 50000n, "note")).rejects.toThrow("stop-here");

    expect(sendRequest).toHaveBeenCalledWith("accounts.create_stealth_transfer_statement", {
      requests: [
        {
          sender_account: { ComponentAddress: TEST_ACCOUNT.component_address },
          resource_address: XTR,
          input_selection: { Specific: { utxo_addresses: [{ resource_address: XTR, id: "big" }] } },
          outputs: [
            { address: TEST_ADDRESS, revealed_amount: "3000", blinded_amount: "17000", memo: { Message: "note" }, pay_to: "StealthPublicKey" },
          ],
        },
      ],
    });
  });
});

describe("DaemonAccount.sendPrivately", () => {
  it("rejects a non-positive amount before ever calling the daemon", async () => {
    const stealthUtxosList = vi.fn();
    const account = makeAccount({ stealthUtxosList });
    await expect(account.sendPrivately(XTR, "otl_recipient", 0n)).rejects.toThrow("greater than zero");
    expect(stealthUtxosList).not.toHaveBeenCalled();
  });

  it("rejects a nonzero minimumValuePromise (not yet supported for daemon accounts) before ever calling the daemon", async () => {
    const stealthUtxosList = vi.fn();
    const account = makeAccount({ stealthUtxosList });
    await expect(account.sendPrivately(XTR, "otl_recipient", 1000n, 50000n, undefined, 1n)).rejects.toThrow("minimumValuePromise");
    expect(stealthUtxosList).not.toHaveBeenCalled();
  });

  it("puts the recipient output first, then a same-account change output, when the selected total exceeds amount", async () => {
    const sendRequest = vi.fn().mockRejectedValue(stopHere());
    const account = makeAccount({
      stealthUtxosList: vi.fn().mockResolvedValue({ utxos: [unspentUtxo("big", 9000n)] }),
      sendRequest,
    });

    await expect(account.sendPrivately(XTR, "otl_recipient", 1111n, 50000n, "hi")).rejects.toThrow("stop-here");

    expect(sendRequest).toHaveBeenCalledWith("accounts.create_stealth_transfer_statement", {
      requests: [
        {
          sender_account: { ComponentAddress: TEST_ACCOUNT.component_address },
          resource_address: XTR,
          input_selection: { Specific: { utxo_addresses: [{ resource_address: XTR, id: "big" }] } },
          outputs: [
            { address: "otl_recipient", revealed_amount: "0", blinded_amount: "1111", memo: { Message: "hi" }, pay_to: "StealthPublicKey" },
            { address: TEST_ADDRESS, revealed_amount: "0", blinded_amount: "7889", memo: null, pay_to: "StealthPublicKey" },
          ],
        },
      ],
    });
  });

  it("omits the change output entirely when the selected total exactly covers the amount", async () => {
    const sendRequest = vi.fn().mockRejectedValue(stopHere());
    const account = makeAccount({
      stealthUtxosList: vi.fn().mockResolvedValue({ utxos: [unspentUtxo("exact", 500n)] }),
      sendRequest,
    });

    await expect(account.sendPrivately(XTR, "otl_recipient", 500n)).rejects.toThrow("stop-here");

    const request = sendRequest.mock.calls[0]?.[1] as { requests: Array<{ outputs: unknown[] }> };
    expect(request.requests[0]?.outputs).toHaveLength(1);
  });
});
