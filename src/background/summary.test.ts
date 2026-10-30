// The approval-popup summary for the `x402Pay` kind (background/summary.ts): every field group
// of the payment-terms envelope as its own readable line -- WHAT is bought (site, not protocol
// fields), the price through `approvalAmount`, the quote expiry in wall-clock time, the
// conditional-payment deal, the facilitator's identity, and the optional integrity pin -- plus
// the two optionality edges (everything absent / everything present) and malformed-URL resilience
// (the popup must degrade, never crash: it's the one screen the user reads before signing).
import { describe, expect, it } from "vitest";
import type { TransactionRequestOperation } from "../lib/messages";
import { shortId, summarizeOperationForApproval } from "./summary";

type X402PayOperation = Extract<TransactionRequestOperation, { kind: "x402Pay" }>;

const TARI = "resource_0101010101010101010101010101010101010101010101010101010101010101";
const NOW_MS = 1790000000000;

function envelope(overrides: Partial<X402PayOperation> = {}): X402PayOperation {
  return {
    kind: "x402Pay",
    resourceUrl: "https://example.com/report",
    amount: "1000000",
    resourceAddress: TARI,
    claimantAddress: "otl_esm_1v3sn0fajd7kwyc3j8pzgsc0eqwtv4xqjmrxq0r7vqmr5l2e8",
    hashLockHex: "0f4a7d3b9c2e5186a0d1f2e3c4b5a6978897a6b5c4d3e2f10697a8b9c0d1e2f3",
    refundEpoch: 520,
    facilitatorUrl: "https://facilitator.example.com/x402/settle",
    expiresAt: NOW_MS + 60_000,
    ...overrides,
  };
}

function stepsOf(operation: X402PayOperation): string[] {
  const { instructions, steps } = summarizeOperationForApproval(operation);
  expect(instructions).toEqual([]); // the wallet builds the whole HTLC itself: nothing to display
  return steps ?? [];
}

describe("summarizeOperationForApproval: x402Pay", () => {
  it("renders every field group of a full envelope as its own line", () => {
    const steps = stepsOf(
      envelope({
        facilitatorPubKeyHex: "e5f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a",
        resourceSha256: "a3f5c0d1b2e4f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f",
      }),
    );
    // 1. What is bought: the resource URL's site -- the path is meaningful, so the full URL.
    expect(steps[0]).toBe("Buys https://example.com/report for 1 TARI.");
    // 2. The quote expiry, in the user's wall-clock time, labelled plainly.
    expect(steps[1]).toBe(`Quote expires ${new Date(NOW_MS + 60_000).toLocaleString()} — don't approve after that time.`);
    expect(steps[1].startsWith("Quote expires ")).toBe(true);
    // 3. The conditional-payment deal: claim-by-serving, refund-by-default, in one short line.
    expect(steps[2]).toBe(
      "Conditional payment: the merchant can only take it by serving the resource, and it refunds to you automatically if they don't in time.",
    );
    // 4. The facilitator: host, plus the truncated identity key.
    const pubkey = "e5f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a";
    expect(steps[3]).toBe(`Routed via the facilitator at facilitator.example.com (key ${shortId(pubkey)}).`);
    // 5. The integrity pin, truncated first/last 8 and deliberately last.
    expect(steps[4]).toBe("Response pinned to SHA-256 a3f5c0d1…5c6d7e8f.");
    expect(steps).toHaveLength(5);
  });

  it("shows only the hostname when the resource path is bare", () => {
    const steps = stepsOf(envelope({ resourceUrl: "https://cdn.example.net/" }));
    expect(steps[0]).toBe("Buys cdn.example.net for 1 TARI.");
  });

  it("renders the base case with every optional field absent", () => {
    const steps = stepsOf(envelope());
    expect(steps).toHaveLength(4);
    expect(steps[0]).toBe("Buys https://example.com/report for 1 TARI.");
    // No facilitator key suffix, no SHA-256 pin line.
    expect(steps[3]).toBe("Routed via the facilitator at facilitator.example.com.");
    expect(steps.join("\n")).not.toContain("SHA-256");
    expect(steps.join("\n")).not.toContain("key ");
  });

  it("rounds the amount through the divisibility when the resource isn't the well-known TARI", () => {
    const other = "resource_" + "cd".repeat(32);
    const steps = stepsOf(envelope({ resourceAddress: other, amount: "7" }));
    // Unknown resource -> no guessed scale: base units, labelled by the truncated address.
    expect(steps[0]).toBe(`Buys https://example.com/report for 7 base units of ${shortId(other)}.`);
  });

  it("degrades instead of crashing on malformed URLs", () => {
    const steps = stepsOf(
      envelope({
        resourceUrl: "not a url at all",
        facilitatorUrl: "also not a url",
      }),
    );
    // The raw string is still shown (it's the only identity the resource has) but nothing throws.
    expect(steps[0]).toBe("Buys not a url at all for 1 TARI.");
    expect(steps[3]).toBe("Routed via the facilitator at also not a url.");
  });
});