// The x402Pay validation gate (background/x402.ts): every rejection path an envelope can take
// before it reaches the execution switch, plus one happy path. Each failure mode asserts its own
// DISTINCT, actionable error message -- house style (see requireViewAccess's three separate
// denials in background/index.ts): a facilitator handling "bad hashlock", "expired quote" and
// "refund window already closed" identically would be stuck in a retry loop for the last of them.
import { describe, expect, it } from "vitest";
import type { TransactionRequestOperation, X402PayTerms } from "../lib/messages";
import { validateHtlcFundTerms, validateX402PayTerms, validateX402SignClaimTerms, X402_MAX_REFUND_EPOCHS_AHEAD } from "./x402";
import { htlcConditions } from "@chironbuilder/ootle-sdk";
import { sha256 } from "@noble/hashes/sha2.js";

type X402PayOperation = Extract<TransactionRequestOperation, { kind: "x402Pay" }>;
type X402SignClaimOperation = Extract<TransactionRequestOperation, { kind: "x402SignClaim" }>;

const CURRENT_EPOCH = 500;
const NOW_MS = 1790000000000;

function validEnvelope(): X402PayOperation {
  return {
    kind: "x402Pay",
    resourceUrl: "https://example.com/report",
    amount: "1000000",
    resourceAddress: "resource_0101010101010101010101010101010101010101010101010101010101010101",
    claimantAddress: "otl_esm_1v3sn0fajd7kwyc3j8pzgsc0eqwtv4xqjmrxq0r7vqmr5l2e8",
    hashLockHex: "0f4a7d3b9c2e5186a0d1f2e3c4b5a6978897a6b5c4d3e2f10697a8b9c0d1e2f3",
    refundEpoch: CURRENT_EPOCH + 20,
    facilitatorUrl: "https://facilitator.example.com/x402/settle",
    expiresAt: NOW_MS + 60_000,
  };
}

describe("validateX402PayTerms", () => {
  it("accepts a well-formed, unexpired quote (happy path)", () => {
    expect(() => validateX402PayTerms(validEnvelope(), { currentEpoch: CURRENT_EPOCH, nowMs: NOW_MS })).not.toThrow();
  });

  it("accepts the optional pins when they are well-formed, and their absence", () => {
    const withPins = { ...validEnvelope(), facilitatorPubKeyHex: "e5f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a", resourceSha256: "A3F5C0D1B2E4F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F", maxFee: "50000" };
    expect(() => validateX402PayTerms(withPins, { currentEpoch: CURRENT_EPOCH, nowMs: NOW_MS })).not.toThrow();
    expect(() => validateX402PayTerms(validEnvelope(), { currentEpoch: CURRENT_EPOCH, nowMs: NOW_MS })).not.toThrow();
  });

  // ---- hashLockHex: exactly 64 lowercase hex chars (closes the htlcFund audit weakness at the
  // x402 boundary -- security-audit-deepseek-v4-pro.md §2) -----------------------------------
  it("rejects a hashLockHex of the wrong length", () => {
    expect(() => validateX402PayTerms({ ...validEnvelope(), hashLockHex: "0f4a7d3b" }, { currentEpoch: CURRENT_EPOCH, nowMs: NOW_MS }))
      .toThrow("hashLockHex must be exactly 64 lowercase hex characters");
  });

  it("rejects an uppercase hashLockHex", () => {
    expect(() => validateX402PayTerms({ ...validEnvelope(), hashLockHex: "0F4A7D3B9C2E5186A0D1F2E3C4B5A6978897A6B5C4D3E2F10697A8B9C0D1E2F3" }, { currentEpoch: CURRENT_EPOCH, nowMs: NOW_MS }))
      .toThrow("hashLockHex must be exactly 64 lowercase hex characters");
  });

  it("rejects a non-hex hashLockHex", () => {
    expect(() => validateX402PayTerms({ ...validEnvelope(), hashLockHex: "zz4a7d3b9c2e5186a0d1f2e3c4b5a6978897a6b5c4d3e2f10697a8b9c0d1e2f3" }, { currentEpoch: CURRENT_EPOCH, nowMs: NOW_MS }))
      .toThrow("hashLockHex must be exactly 64 lowercase hex characters");
  });

  // ---- refundEpoch ------------------------------------------------------------------------------
  it("rejects a refundEpoch that is not a whole number", () => {
    expect(() => validateX402PayTerms({ ...validEnvelope(), refundEpoch: 520.5 }, { currentEpoch: CURRENT_EPOCH, nowMs: NOW_MS }))
      .toThrow("refundEpoch must be a whole number of chain epochs");
  });

  it("rejects a negative refundEpoch", () => {
    expect(() => validateX402PayTerms({ ...validEnvelope(), refundEpoch: -1 }, { currentEpoch: CURRENT_EPOCH, nowMs: NOW_MS }))
      .toThrow("refundEpoch must be a whole number of chain epochs");
  });

  it("rejects a refundEpoch beyond the JS-safe-integer range (absurd epoch)", () => {
    expect(() => validateX402PayTerms({ ...validEnvelope(), refundEpoch: 2 ** 53 }, { currentEpoch: CURRENT_EPOCH, nowMs: NOW_MS }))
      .toThrow("refundEpoch is too large to be a real chain epoch");
  });

  it("rejects a refundEpoch that has already passed", () => {
    expect(() => validateX402PayTerms({ ...validEnvelope(), refundEpoch: CURRENT_EPOCH }, { currentEpoch: CURRENT_EPOCH, nowMs: NOW_MS }))
      .toThrow("refundEpoch has already passed");
  });

  it("rejects a refundEpoch absurdly far in the future", () => {
    expect(() => validateX402PayTerms({ ...validEnvelope(), refundEpoch: CURRENT_EPOCH + X402_MAX_REFUND_EPOCHS_AHEAD + 1 }, { currentEpoch: CURRENT_EPOCH, nowMs: NOW_MS }))
      .toThrow("refundEpoch is too far ahead");
  });

  it("skips the live epoch check when no currentEpoch is supplied (create-time static pass)", () => {
    // The static pass at tari_createTransactionRequest time cannot know the current epoch (the
    // wallet may even be locked); it must still accept a shape-sane envelope -- the live check
    // runs again at submit time.
    expect(() => validateX402PayTerms(validEnvelope())).not.toThrow();
  });

  // ---- expiresAt --------------------------------------------------------------------------------
  it("rejects a quote that has already expired", () => {
    expect(() => validateX402PayTerms({ ...validEnvelope(), expiresAt: NOW_MS }, { currentEpoch: CURRENT_EPOCH, nowMs: NOW_MS }))
      .toThrow("quote has already expired");
  });

  // ---- amount -----------------------------------------------------------------------------------
  it("rejects a zero amount", () => {
    expect(() => validateX402PayTerms({ ...validEnvelope(), amount: "0" }, { currentEpoch: CURRENT_EPOCH, nowMs: NOW_MS }))
      .toThrow("amount must be a positive whole number");
  });

  it("rejects a negative amount", () => {
    expect(() => validateX402PayTerms({ ...validEnvelope(), amount: "-5" }, { currentEpoch: CURRENT_EPOCH, nowMs: NOW_MS }))
      .toThrow("amount must be a positive whole number");
  });

  it("rejects a non-numeric amount", () => {
    expect(() => validateX402PayTerms({ ...validEnvelope(), amount: "ten" }, { currentEpoch: CURRENT_EPOCH, nowMs: NOW_MS }))
      .toThrow("amount must be a positive whole number");
  });

  it("rejects scientific notation in the amount", () => {
    expect(() => validateX402PayTerms({ ...validEnvelope(), amount: "1e6" }, { currentEpoch: CURRENT_EPOCH, nowMs: NOW_MS }))
      .toThrow("amount must be a positive whole number");
  });

  // ---- claimantAddress ---------------------------------------------------------------------------
  it("rejects a malformed claimant address", () => {
    expect(() => validateX402PayTerms({ ...validEnvelope(), claimantAddress: "component_0101010101010101010101010101010101010101010101010101010101010101" }, { currentEpoch: CURRENT_EPOCH, nowMs: NOW_MS }))
      .toThrow("claimantAddress is not a valid Ootle wallet address");
    expect(() => validateX402PayTerms({ ...validEnvelope(), claimantAddress: "otl_esm_1v3sn" }, { currentEpoch: CURRENT_EPOCH, nowMs: NOW_MS }))
      .toThrow("claimantAddress is not a valid Ootle wallet address");
  });

  // ---- optional hex pins ----------------------------------------------------------------------------
  it("rejects a malformed facilitatorPubKeyHex", () => {
    expect(() => validateX402PayTerms({ ...validEnvelope(), facilitatorPubKeyHex: "e5f6a7b8c9d0e1f2" }, { currentEpoch: CURRENT_EPOCH, nowMs: NOW_MS }))
      .toThrow("facilitatorPubKeyHex must be exactly 64 hex characters");
  });

  it("rejects a malformed resourceSha256", () => {
    expect(() => validateX402PayTerms({ ...validEnvelope(), resourceSha256: "not-hex-at-all-64-characters-not-hex-at-all-64-charactersx" }, { currentEpoch: CURRENT_EPOCH, nowMs: NOW_MS }))
      .toThrow("resourceSha256 must be exactly 64 hex characters");
  });

  it("gives each failure mode its own distinct message (house style)", () => {
    const messages = new Set<string>();
    for (const envelope of [
      { ...validEnvelope(), hashLockHex: "ab" },
      { ...validEnvelope(), refundEpoch: CURRENT_EPOCH },
      { ...validEnvelope(), expiresAt: NOW_MS },
      { ...validEnvelope(), amount: "0" },
      { ...validEnvelope(), claimantAddress: "nope" },
      { ...validEnvelope(), facilitatorPubKeyHex: "ab" },
      { ...validEnvelope(), resourceSha256: "ab" },
    ]) {
      try {
        validateX402PayTerms(envelope as X402PayOperation, { currentEpoch: CURRENT_EPOCH, nowMs: NOW_MS });
        throw new Error("expected a rejection");
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
        messages.add((e as Error).message);
      }
    }
    expect(messages.size).toBe(7);
  });
});

describe("validateHtlcFundTerms (the shared dApp-entry tightening -- same audit finding, both boundaries)", () => {
  it("accepts a well-formed htlcFund hashlock/refundEpoch pair", () => {
    expect(() => validateHtlcFundTerms({ hashLockHex: "0f4a7d3b9c2e5186a0d1f2e3c4b5a6978897a6b5c4d3e2f10697a8b9c0d1e2f3", refundEpoch: "512" })).not.toThrow();
  });

  it("rejects a malformed hashLockHex from a dApp's htlcFund request", () => {
    expect(() => validateHtlcFundTerms({ hashLockHex: "0F4A", refundEpoch: "512" })).toThrow("htlcFund: hashLockHex must be exactly 64 lowercase hex characters");
  });

  it("rejects a non-integer refundEpoch string from a dApp's htlcFund request", () => {
    expect(() => validateHtlcFundTerms({ hashLockHex: "0f4a7d3b9c2e5186a0d1f2e3c4b5a6978897a6b5c4d3e2f10697a8b9c0d1e2f3", refundEpoch: "12.5" })).toThrow("htlcFund: refundEpoch must be a whole number of chain epochs");
  });
});

// ---- x402SignClaim: the settlement-side gate -------------------------------------------------
// Same distinct-message house style. The preimage/hashlock fixtures are REAL: the hashlock is
// the actual SHA-256 of the preimage bytes, and the conditions fixture is a real
// `htlcConditions` tree, so the gate is exercised against the exact shapes it will see live.
const SC_PREIMAGE_HEX = "cd".repeat(32);
const SC_HASHLOCK_HEX = Array.from(sha256(new Uint8Array(SC_PREIMAGE_HEX.length / 2).map((_, i) => parseInt(SC_PREIMAGE_HEX.slice(i * 2, i * 2 + 2), 16))))
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("");
const SC_REFUND_EPOCH = CURRENT_EPOCH + 20;

function validSignClaimTerms(): X402PayTerms {
  return {
    resourceUrl: "https://example.com/report",
    amount: "1000000",
    resourceAddress: "resource_0101010101010101010101010101010101010101010101010101010101010101",
    claimantAddress: "otl_esm_1v3sn0fajd7kwyc3j8pzgsc0eqwtv4xqjmrxq0r7vqmr5l2e8",
    hashLockHex: SC_HASHLOCK_HEX,
    refundEpoch: SC_REFUND_EPOCH,
    facilitatorUrl: "https://facilitator.example.com/x402/settle",
    expiresAt: NOW_MS + 60_000,
  };
}

function validSignClaim(): X402SignClaimOperation {
  return {
    kind: "x402SignClaim",
    envelope: validSignClaimTerms(),
    preimageHex: SC_PREIMAGE_HEX,
    htlcOutputCommitmentHex: "ab".repeat(32),
    conditions: htlcConditions({
      hashLockHex: SC_HASHLOCK_HEX,
      refundEpoch: BigInt(SC_REFUND_EPOCH),
      claimantPublicKeyHex: "11".repeat(32),
      refunderPublicKeyHex: "22".repeat(32),
    }),
  };
}

describe("validateX402SignClaimTerms", () => {
  it("accepts a well-formed settlement request whose preimage really hashes to the quote's lock", () => {
    expect(() => validateX402SignClaimTerms(validSignClaim(), { currentEpoch: CURRENT_EPOCH })).not.toThrow();
  });

  // ---- the preimage IS the merchant's proof of payment: hash it before anything is signed ------
  it("rejects a preimageHex of the wrong length", () => {
    expect(() => validateX402SignClaimTerms({ ...validSignClaim(), preimageHex: "cd".repeat(31) }, { currentEpoch: CURRENT_EPOCH }))
      .toThrow("x402SignClaim: preimageHex must be exactly 64 hex characters (32 bytes)");
  });

  it("rejects a preimage that does not hash to the quote's hashLockHex (distinct message)", () => {
    expect(() => validateX402SignClaimTerms({ ...validSignClaim(), preimageHex: "ee".repeat(32) }, { currentEpoch: CURRENT_EPOCH }))
      .toThrow("x402SignClaim: the preimage does not hash to the quote's hashLockHex");
  });

  it("rejects a malformed htlcOutputCommitmentHex", () => {
    expect(() => validateX402SignClaimTerms({ ...validSignClaim(), htlcOutputCommitmentHex: "ab" }, { currentEpoch: CURRENT_EPOCH }))
      .toThrow("x402SignClaim: htlcOutputCommitmentHex must be exactly 64 hex characters");
  });

  // ---- live pass: the only time bound for a claim is the refund epoch --------------------------
  it("refuses to sign once the refund epoch has passed (distinct message)", () => {
    expect(() => validateX402SignClaimTerms(validSignClaim(), { currentEpoch: SC_REFUND_EPOCH }))
      .toThrow("x402SignClaim: the quote's refund epoch has already passed");
  });

  it("does NOT refuse a settlement whose quote expiresAt is past but whose refund epoch is not", () => {
    // The claim window is bounded by the refund leaf, not the facilitator's quote expiry: a
    // merchant may legitimately settle slightly after the quote lapsed, as long as the payer
    // cannot have refunded yet.
    const stale = validSignClaim();
    stale.envelope.expiresAt = NOW_MS - 60_000;
    expect(() => validateX402SignClaimTerms(stale, { currentEpoch: CURRENT_EPOCH })).not.toThrow();
  });

  // ---- structural security boundary: this kind ONLY builds the HTLC claim ----------------------
  it("rejects a smuggled `instructions` field outright", () => {
    const smuggled = { ...validSignClaim(), instructions: [] } as unknown as X402SignClaimOperation;
    expect(() => validateX402SignClaimTerms(smuggled, { currentEpoch: CURRENT_EPOCH }))
      .toThrow("x402SignClaim accepts no `instructions` or `followUpInstructions` fields");
  });

  it("rejects a smuggled `followUpInstructions` field outright", () => {
    const smuggled = { ...validSignClaim(), followUpInstructions: [] } as unknown as X402SignClaimOperation;
    expect(() => validateX402SignClaimTerms(smuggled, { currentEpoch: CURRENT_EPOCH }))
      .toThrow("x402SignClaim accepts no `instructions` or `followUpInstructions` fields");
  });

  it("rejects any key outside the kind's fixed field set (unknown-field refusal)", () => {
    const smuggled = { ...validSignClaim(), maxFee: "50000" } as unknown as X402SignClaimOperation;
    expect(() => validateX402SignClaimTerms(smuggled, { currentEpoch: CURRENT_EPOCH }))
      .toThrow("x402SignClaim: unexpected fields");
  });

  // ---- the relayed conditions tree must BE the quote's HTLC ------------------------------------
  it("rejects a conditions tree whose hash lock differs from the quote's (distinct message)", () => {
    const wrong = validSignClaim();
    wrong.conditions = htlcConditions({
      hashLockHex: "00".repeat(32),
      refundEpoch: BigInt(SC_REFUND_EPOCH),
      claimantPublicKeyHex: "11".repeat(32),
      refunderPublicKeyHex: "22".repeat(32),
    });
    expect(() => validateX402SignClaimTerms(wrong, { currentEpoch: CURRENT_EPOCH }))
      .toThrow("x402SignClaim: the relayed conditions tree's hash lock does not match the quote's hashLockHex");
  });

  it("rejects a conditions tree whose refund epoch differs from the quote's (distinct message)", () => {
    const wrong = validSignClaim();
    wrong.conditions = htlcConditions({
      hashLockHex: SC_HASHLOCK_HEX,
      refundEpoch: BigInt(SC_REFUND_EPOCH + 5),
      claimantPublicKeyHex: "11".repeat(32),
      refunderPublicKeyHex: "22".repeat(32),
    });
    expect(() => validateX402SignClaimTerms(wrong, { currentEpoch: CURRENT_EPOCH }))
      .toThrow("x402SignClaim: the relayed conditions tree's refund epoch does not match the quote's refundEpoch");
  });

  it("rejects a conditions value that is not the two-leaf [claim, refund] tree", () => {
    expect(() => validateX402SignClaimTerms({ ...validSignClaim(), conditions: [] }, { currentEpoch: CURRENT_EPOCH }))
      .toThrow("x402SignClaim: conditions must be the two-leaf [claim, refund] tree the paying wallet relayed");
    expect(() => validateX402SignClaimTerms({ ...validSignClaim(), conditions: "not-a-tree" as unknown as object[] }, { currentEpoch: CURRENT_EPOCH }))
      .toThrow("x402SignClaim: conditions must be the two-leaf [claim, refund] tree the paying wallet relayed");
  });

  it("propagates the x402Pay envelope gate for malformed quote fields", () => {
    const bad = validSignClaim();
    bad.envelope.amount = "0";
    expect(() => validateX402SignClaimTerms(bad, { currentEpoch: CURRENT_EPOCH }))
      .toThrow("x402Pay: amount must be a positive whole number");
  });
});
