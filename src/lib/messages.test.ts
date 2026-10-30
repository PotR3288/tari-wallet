import { describe, expect, it } from "vitest";
import { classifyProviderError, type TransactionRequestOperation } from "./messages";

// Every message string here is copied verbatim from an actual `throw new Error(...)` site in
// background/index.ts's handlePageRequest (or something it calls) -- this locks the classifier to
// what those throw sites actually say today, so a message wording change that silently drops out
// of one of these buckets fails loudly here instead of only showing up as a dApp getting the wrong
// `.code`.
describe("classifyProviderError", () => {
  it("classifies user-declined approvals as 4001 (rejected)", () => {
    expect(classifyProviderError("Connection request rejected.")).toEqual({ code: 4001, message: "Request rejected by the user" });
    expect(classifyProviderError("Rejected by the user.")).toEqual({ code: 4001, message: "Request rejected by the user" });
    expect(classifyProviderError("Transaction rejected.")).toEqual({ code: 4001, message: "Request rejected by the user" });
  });

  it("does not classify a genuine on-chain transaction rejection as user-declined, even though its message also contains 'rejected' (confirmed live against a daemon: a real Reject outcome was previously misreported as 4001)", () => {
    expect(classifyProviderError("Transaction abc123 was rejected: SubstateNotFound")).toEqual({
      code: -32603,
      message: "Transaction abc123 was rejected: SubstateNotFound",
    });
    expect(classifyProviderError("Transaction abc123 accepted the fee but rejected the rest: InsufficientFeesPaid")).toEqual({
      code: -32603,
      message: "Transaction abc123 accepted the fee but rejected the rest: InsufficientFeesPaid",
    });
  });

  it("classifies no-connection/locked-wallet states as 4100 (unauthorized)", () => {
    expect(classifyProviderError("Wallet is locked.")).toEqual({
      code: 4100,
      message: "Not connected — call tari_requestAccounts first",
    });
    expect(classifyProviderError("Site is not connected. Call tari_requestAccounts first.")).toEqual({
      code: 4100,
      message: "Not connected — call tari_requestAccounts first",
    });
  });

  it("classifies an unknown RPC method as 4200 (unsupported), keeping the method name", () => {
    expect(classifyProviderError("Unknown method: tari_madeUpMethod")).toEqual({
      code: 4200,
      message: "Unsupported method: tari_madeUpMethod",
    });
  });

  it("falls back to -32603 (internal) for anything else, preserving the original message", () => {
    expect(classifyProviderError("No wallet set up in the Tari extension yet.")).toEqual({ code: -32603, message: "No wallet set up in the Tari extension yet." });
    expect(classifyProviderError("Indexer request timed out")).toEqual({ code: -32603, message: "Indexer request timed out" });
  });
});

// The `x402Pay` request kind -- a payment-terms envelope from an x402 facilitator, executed as an
// HTLC fund. TransactionRequestRecord persists the operation as plain JSON (storage.ts), so the
// union must survive a JSON round-trip with every envelope field intact: this is the exact path a
// pending request takes from `tari_createTransactionRequest` to `submitApprovedTransactionRequest`.
// (The type annotation is the other half of the test: it fails `pnpm typecheck` unless the kind is
// a member of the union with exactly these fields.)
describe("TransactionRequestOperation x402Pay", () => {
  const operation: TransactionRequestOperation = {
    kind: "x402Pay",
    resourceUrl: "https://example.com/report",
    resourceSha256: "a3f5c0d1b2e4f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f",
    amount: "1000000",
    resourceAddress: "resource_0101010101010101010101010101010101010101010101010101010101010101",
    claimantAddress: "otl_esm_1v3sn0fajd7kwyc3j8pzgsc0eqwtv4xqjmrxq0r7vqmr5l2e8",
    hashLockHex: "0f4a7d3b9c2e5186a0d1f2e3c4b5a6978897a6b5c4d3e2f10697a8b9c0d1e2f3a",
    refundEpoch: 512,
    facilitatorUrl: "https://facilitator.example.com/x402/settle",
    facilitatorPubKeyHex: "e5f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a",
    expiresAt: 1790000000000,
    maxFee: "50000",
  };

  it("round-trips every envelope field through the record's JSON persistence", () => {
    const back = JSON.parse(JSON.stringify(operation)) as TransactionRequestOperation;
    if (back.kind !== "x402Pay") throw new Error(`kind did not survive the round-trip: ${String((back as { kind?: string }).kind)}`);
    expect(back).toEqual(operation);
    expect(back.resourceUrl).toBe("https://example.com/report");
    expect(back.claimantAddress).toBe(operation.claimantAddress);
    expect(back.refundEpoch).toBe(512);
    expect(back.expiresAt).toBe(1790000000000);
  });

  it("keeps the optional integrity/identity pins optional", () => {
    const minimal: TransactionRequestOperation = {
      ...operation,
    };
    delete (minimal as Partial<typeof operation>).resourceSha256;
    delete (minimal as Partial<typeof operation>).facilitatorPubKeyHex;
    delete (minimal as Partial<typeof operation>).maxFee;
    const back = JSON.parse(JSON.stringify(minimal)) as TransactionRequestOperation;
    if (back.kind !== "x402Pay") throw new Error("minimal envelope lost its kind");
    expect("resourceSha256" in back).toBe(false);
    expect("facilitatorPubKeyHex" in back).toBe(false);
    expect("maxFee" in back).toBe(false);
  });
});
