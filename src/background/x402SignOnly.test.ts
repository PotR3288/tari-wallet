// The x402SignClaim build path (background/x402SignOnly.ts), exercised against the REAL wasm
// crypto throughout — mirroring the ootle-sdk's own real-crypto HTLC round-trip test pattern
// (its `htlc.test.ts`, per the spike report): a fund-side output witness is created with the
// real `createStealthOutputWitness`, "put on chain" as a fabricated substate, decrypted with the
// real `decryptOwnedUtxo` + the claimant's real view secret, assembled into a statement the real
// `validateStealthTransfer` accepts, and signed+sealed with a real `SecretKeyWallet`. No network,
// no submit — which is the entire point of the module: nothing here ever broadcasts.
import { describe, expect, it } from "vitest";
import type { TransactionRequestOperation, X402PayTerms, X402SignedClaimPayload } from "../lib/messages";
import { buildSignedX402Claim, buildX402ClaimStatement, type X402ClaimChain, type X402ClaimSignerAccount } from "./x402SignOnly";
import { componentAddressFromWalletAddress, fromHex, htlcConditions, toHex, toOotleNetwork } from "@chironbuilder/ootle-sdk";
import type { HtlcExpectations } from "@chironbuilder/ootle-sdk";
import { createStealthOutputWitness, generateOotleAddress, generateOotleSecretKey, ootlePublicKeyFromSecretKey, validateStealthTransfer } from "@tari-project/ootle-wasm";
import { decryptOwnedUtxo, stealthUtxoSubstateId, WasmStealthCrypto } from "@tari-project/ootle";
import type { InputDeclaration } from "@tari-project/ootle-ts-bindings";
import { SecretKeyWallet } from "@tari-project/ootle-secret-key-wallet";
import { sha256 } from "@noble/hashes/sha2.js";

type X402SignClaimOperation = Extract<TransactionRequestOperation, { kind: "x402SignClaim" }>;

const RES = "resource_0101010101010101010101010101010101010101010101010101010101010101";
const AMOUNT = 1_000_000n;
const PREIMAGE_HEX = "cd".repeat(32);
const CURRENT_EPOCH = 500;
const REFUND_EPOCH = CURRENT_EPOCH + 500;
const HASHLOCK_HEX = toHex(sha256(fromHex(PREIMAGE_HEX)));

function toHexLower(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// One full fixture: a claimant (merchant), a refunder (payer), the two-leaf tree, and a funded
// output the payer "created" with the real wasm output-witness builder.
function makeFixture(value: bigint = AMOUNT) {
  const network = toOotleNetwork("esmeralda");
  const claimantKeys = generateOotleSecretKey();
  const refunderKeys = generateOotleSecretKey();
  const claimantPub = ootlePublicKeyFromSecretKey(claimantKeys.owner_key, claimantKeys.view_key);
  const refunderPub = ootlePublicKeyFromSecretKey(refunderKeys.owner_key, refunderKeys.view_key);
  const claimantWalletAddress = generateOotleAddress(claimantPub.owner_key, claimantPub.view_key, network);
  const conditions = htlcConditions({
    hashLockHex: HASHLOCK_HEX,
    refundEpoch: BigInt(REFUND_EPOCH),
    claimantPublicKeyHex: toHex(claimantPub.owner_key),
    refunderPublicKeyHex: toHex(refunderPub.owner_key),
  });
  // The fund side: a real encrypted output witness addressed to the claimant (pay_to null keeps
  // it a plain key-spendable output; the claim statement's ScriptPath witness is what turns the
  // same mask/value into the HTLC spend — the tree is revealed, not re-encrypted).
  const fundWitness = JSON.parse(
    createStealthOutputWitness(network, claimantPub.owner_key, claimantPub.view_key, value, RES, null, null, null, 0n)
  ).witness as { mask: string; sender_public_nonce: string; encrypted_data: string };
  return { network, claimantKeys, claimantWalletAddress, conditions, fundWitness };
}

// The commitment of an output worth (value, mask) — read out of a real statement the wasm built
// for exactly that input, rather than re-derived by hand.
function commitmentOf(network: ReturnType<typeof toOotleNetwork>, conditions: object[], mask: string, value: bigint, destinationWalletAddress: string): string {
  const statement = JSON.parse(
    buildX402ClaimStatement({ network, conditions, preimageHex: PREIMAGE_HEX, mask, value, destinationWalletAddress, resourceAddress: RES })
  );
  const commitment = statement.inputs_statement.inputs[0]?.commitment;
  if (typeof commitment !== "string") throw new Error("fixture: no commitment in the built statement");
  return commitment;
}

// A fabricated chain: exactly the reads buildSignedX402Claim makes, answered locally.
function fakeChain(substateId: string, utxoBody: { encrypted_data: string; public_nonce: string }, componentAddress: string): X402ClaimChain {
  const componentSubstate = { state: { up: { substate: { Component: { body: { state: [] } } } } } };
  return {
    getSubstate: async (id: string) => (id === substateId ? { state: { up: { substate: { Utxo: { output: { output: utxoBody } } } } } } : componentSubstate),
    getCurrentEpoch: async () => CURRENT_EPOCH,
    resolveInputs: async (inputs) => inputs.map((i) => ({ ...i, version: i.version ?? 1 })),
  };
}

function makeAccount(
  fixture: ReturnType<typeof makeFixture>,
  chain: X402ClaimChain,
  verifyHtlcOverride?: X402ClaimSignerAccount["verifyHtlc"]
): { account: X402ClaimSignerAccount; verifyHtlcCalls: { resourceAddress: string; commitmentHex: string; conditions: object[]; expected?: HtlcExpectations; preimageHex?: string }[] } {
  const verifyHtlcCalls: { resourceAddress: string; commitmentHex: string; conditions: object[]; expected?: HtlcExpectations; preimageHex?: string }[] = [];
  const signer = SecretKeyWallet.fromSecretKey(fixture.claimantKeys.owner_key, fixture.network, fixture.claimantKeys.view_key);
  const componentAddress = componentAddressFromWalletAddress(fixture.claimantWalletAddress);
  const account: X402ClaimSignerAccount = {
    network: fixture.network,
    signer,
    getWalletAddress: async () => fixture.claimantWalletAddress,
    getComponentAddress: async () => componentAddress,
    getProvider: async () => chain,
    verifyHtlc:
      verifyHtlcOverride ??
      (async (resourceAddress: string, commitmentHex: string, conditions: object[], expected?: HtlcExpectations, preimageHex?: string) => {
        verifyHtlcCalls.push({ resourceAddress, commitmentHex, conditions, expected, preimageHex });
        return { ok: true, problems: [], value: AMOUNT, currentEpoch: BigInt(CURRENT_EPOCH) };
      }),
  };
  return { account, verifyHtlcCalls };
}

function signClaimOperation(fixture: ReturnType<typeof makeFixture>, commitmentHex: string, amount: string = AMOUNT.toString()): X402SignClaimOperation {
  const envelope: X402PayTerms = {
    resourceUrl: "https://example.com/report",
    amount,
    resourceAddress: RES,
    claimantAddress: fixture.claimantWalletAddress,
    hashLockHex: HASHLOCK_HEX,
    refundEpoch: REFUND_EPOCH,
    facilitatorUrl: "https://facilitator.example.com/x402/settle",
    expiresAt: Date.now() + 60_000,
  };
  return { kind: "x402SignClaim", envelope, preimageHex: PREIMAGE_HEX, htlcOutputCommitmentHex: commitmentHex, conditions: fixture.conditions };
}

describe("buildX402ClaimStatement (real-wasm round-trip)", () => {
  it("builds a statement the real wasm's validateStealthTransfer accepts, spending the claim leaf with the preimage", () => {
    const fixture = makeFixture();
    const statementJson = buildX402ClaimStatement({
      network: fixture.network,
      conditions: fixture.conditions,
      preimageHex: PREIMAGE_HEX,
      mask: fixture.fundWitness.mask,
      value: AMOUNT,
      destinationWalletAddress: fixture.claimantWalletAddress,
      resourceAddress: RES,
    });
    // The round-trip the spike report names as the acceptance gate: a statement the engine
    // would reject must never be sealed into a payload.
    expect(() => validateStealthTransfer(statementJson, null)).not.toThrow();
    const parsed = JSON.parse(statementJson);
    expect(parsed.inputs_statement.inputs).toHaveLength(1);
    expect(parsed.inputs_statement.inputs[0].witness.ScriptPath.data).toBe(PREIMAGE_HEX);
    expect(statementJson).toContain(AMOUNT.toString());
    expect(parsed.outputs_statement.outputs).toHaveLength(1);
  });

  it("refuses to build a statement from a conditions value with no claim leaf", () => {
    const fixture = makeFixture();
    expect(() =>
      buildX402ClaimStatement({
        network: fixture.network,
        conditions: [],
        preimageHex: PREIMAGE_HEX,
        mask: fixture.fundWitness.mask,
        value: AMOUNT,
        destinationWalletAddress: fixture.claimantWalletAddress,
        resourceAddress: RES,
      })
    ).toThrow("x402SignClaim: conditions must be the two-leaf [claim, refund] tree the paying wallet relayed");
  });

  // The M4 hygiene fix: buildX402ClaimStatement is exported, so it re-checks the tree shape
  // itself (describeHtlcConditions) rather than trusting validateX402SignClaimTerms to have run.
  // A non-empty value that is not a parseable two-leaf HTLC tree must be refused here too, not
  // just by the gate.
  it("refuses a non-empty conditions value the SDK's own parser cannot read as an HTLC tree", () => {
    const fixture = makeFixture();
    expect(() =>
      buildX402ClaimStatement({
        network: fixture.network,
        conditions: [{ not: "a claim leaf" }],
        preimageHex: PREIMAGE_HEX,
        mask: fixture.fundWitness.mask,
        value: AMOUNT,
        destinationWalletAddress: fixture.claimantWalletAddress,
        resourceAddress: RES,
      })
    ).toThrow("x402SignClaim: conditions must be the two-leaf [claim, refund] tree the paying wallet relayed");
  });
});

describe("buildSignedX402Claim (offline real-crypto end to end: decrypt -> statement -> sign -> seal, no submit)", () => {
  it("returns the complete five-field payload, all hex fields lowercase hex, and runs the SDK safety gate first", async () => {
    const fixture = makeFixture();
    // Commitment of the funded output, derived with the real wasm.
    const commitmentHex = commitmentOf(fixture.network, fixture.conditions, fixture.fundWitness.mask, AMOUNT, fixture.claimantWalletAddress);
    const substateId = stealthUtxoSubstateId(RES, fromHex(commitmentHex));
    const chain = fakeChain(substateId, { encrypted_data: fixture.fundWitness.encrypted_data, public_nonce: fixture.fundWitness.sender_public_nonce }, componentAddressFromWalletAddress(fixture.claimantWalletAddress));
    const { account, verifyHtlcCalls } = makeAccount(fixture, chain);
    const operation = signClaimOperation(fixture, commitmentHex);

    const result: X402SignedClaimPayload = await buildSignedX402Claim(account, operation);

    // Response shape: all five fields, hex formats.
    expect(result.signedPayloadHex).toMatch(/^[0-9a-f]+$/);
    expect(result.signedPayloadHex.length % 2).toBe(0);
    expect(result.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.htlcOutputCommitment).toBe(commitmentHex.toLowerCase());
    expect(result.refundEpoch).toBe(REFUND_EPOCH);
    expect(result.validUntilEpoch).toBe(REFUND_EPOCH - 1);

    // txHash is honestly the SHA-256 of the sealed envelope's BOR bytes (hex-decoded back).
    const envelopeBytes = new Uint8Array(result.signedPayloadHex.length / 2).map((_, i) => parseInt(result.signedPayloadHex.slice(i * 2, i * 2 + 2), 16));
    expect(result.txHash).toBe(toHexLower(sha256(envelopeBytes)));

    // The SDK's pre-reveal safety gate ran with the quote's terms pinned, and the preimage was
    // handed to it (its hashlock check is the last line of defense before anything is sealed).
    expect(verifyHtlcCalls).toHaveLength(1);
    expect(verifyHtlcCalls[0]!.resourceAddress).toBe(RES);
    expect(verifyHtlcCalls[0]!.commitmentHex).toBe(commitmentHex);
    expect(verifyHtlcCalls[0]!.preimageHex).toBe(PREIMAGE_HEX);
    expect(verifyHtlcCalls[0]!.expected?.amount).toBe(AMOUNT);
    expect(verifyHtlcCalls[0]!.expected?.hashLockHex).toBe(HASHLOCK_HEX);
    expect(verifyHtlcCalls[0]!.expected?.refundEpoch).toBe(BigInt(REFUND_EPOCH));
  });

  it("decrypts the funded output with the claimant's real view secret before building the statement", async () => {
    const fixture = makeFixture();
    const commitmentHex = commitmentOf(fixture.network, fixture.conditions, fixture.fundWitness.mask, AMOUNT, fixture.claimantWalletAddress);
    const substateId = stealthUtxoSubstateId(RES, fromHex(commitmentHex));
    // Decrypt the fabricated substate directly with the real wasm — the same call the module
    // makes — proving the fixture really is a claimant-decryptable HTLC output.
    const decrypted = await decryptOwnedUtxo(
      new WasmStealthCrypto(fixture.network),
      fixture.claimantKeys.view_key,
      { state: { up: { substate: { Utxo: { output: { output: { encrypted_data: fixture.fundWitness.encrypted_data, public_nonce: fixture.fundWitness.sender_public_nonce } } } } } } } as never,
      substateId
    );
    expect(decrypted?.value).toBe(AMOUNT);
    expect(decrypted?.mask.toHex()).toBe(fixture.fundWitness.mask);
  });

  it("refuses when the account is not the quote's claimant (distinct message)", async () => {
    const fixture = makeFixture();
    const otherKeys = generateOotleSecretKey();
    const otherPub = ootlePublicKeyFromSecretKey(otherKeys.owner_key, otherKeys.view_key);
    const otherAddress = generateOotleAddress(otherPub.owner_key, otherPub.view_key, fixture.network);
    const commitmentHex = commitmentOf(fixture.network, fixture.conditions, fixture.fundWitness.mask, AMOUNT, fixture.claimantWalletAddress);
    const chain = fakeChain(stealthUtxoSubstateId(RES, fromHex(commitmentHex)), { encrypted_data: fixture.fundWitness.encrypted_data, public_nonce: fixture.fundWitness.sender_public_nonce }, componentAddressFromWalletAddress(fixture.claimantWalletAddress));
    const { account } = makeAccount(fixture, chain);
    const operation = signClaimOperation(fixture, commitmentHex);
    const wrongAccount: X402ClaimSignerAccount = { ...account, getWalletAddress: async () => otherAddress };
    await expect(buildSignedX402Claim(wrongAccount, operation)).rejects.toThrow("x402SignClaim: this account is not the quote's claimant");
  });

  it("refuses when the funded output decrypts to a different amount than the quote (distinct message)", async () => {
    const fixture = makeFixture(AMOUNT * 2n);
    const commitmentHex = commitmentOf(fixture.network, fixture.conditions, fixture.fundWitness.mask, AMOUNT * 2n, fixture.claimantWalletAddress);
    const chain = fakeChain(stealthUtxoSubstateId(RES, fromHex(commitmentHex)), { encrypted_data: fixture.fundWitness.encrypted_data, public_nonce: fixture.fundWitness.sender_public_nonce }, componentAddressFromWalletAddress(fixture.claimantWalletAddress));
    const { account } = makeAccount(fixture, chain);
    // The quote says 1000000; the output on "chain" is worth 2000000.
    const operation = signClaimOperation(fixture, commitmentHex, AMOUNT.toString());
    await expect(buildSignedX402Claim(account, operation)).rejects.toThrow("x402SignClaim: the funded output is worth 2000000 but the quote says 1000000");
  });

  it("refuses before decrypting when the SDK safety gate reports problems (the preimage is never sealed)", async () => {
    const fixture = makeFixture();
    const commitmentHex = commitmentOf(fixture.network, fixture.conditions, fixture.fundWitness.mask, AMOUNT, fixture.claimantWalletAddress);
    const chain = fakeChain(stealthUtxoSubstateId(RES, fromHex(commitmentHex)), { encrypted_data: fixture.fundWitness.encrypted_data, public_nonce: fixture.fundWitness.sender_public_nonce }, componentAddressFromWalletAddress(fixture.claimantWalletAddress));
    const failing = async () => ({ ok: false, problems: ["the tree's refund leaf is not the agreed counterparty"], value: null, currentEpoch: BigInt(CURRENT_EPOCH) });
    const { account } = makeAccount(fixture, chain, failing as unknown as X402ClaimSignerAccount["verifyHtlc"]);
    const operation = signClaimOperation(fixture, commitmentHex);
    await expect(buildSignedX402Claim(account, operation)).rejects.toThrow(
      "x402SignClaim: the funded HTLC does not match the quote — the tree's refund leaf is not the agreed counterparty"
    );
  });

  it("refuses when the refund epoch is already past (distinct message, checked against the live chain epoch)", async () => {
    const fixture = makeFixture();
    const commitmentHex = commitmentOf(fixture.network, fixture.conditions, fixture.fundWitness.mask, AMOUNT, fixture.claimantWalletAddress);
    const chain = fakeChain(stealthUtxoSubstateId(RES, fromHex(commitmentHex)), { encrypted_data: fixture.fundWitness.encrypted_data, public_nonce: fixture.fundWitness.sender_public_nonce }, componentAddressFromWalletAddress(fixture.claimantWalletAddress));
    const lateChain: X402ClaimChain = { ...chain, getCurrentEpoch: async () => REFUND_EPOCH };
    const { account } = makeAccount(fixture, lateChain);
    const operation = signClaimOperation(fixture, commitmentHex);
    await expect(buildSignedX402Claim(account, operation)).rejects.toThrow("x402SignClaim: the quote's refund epoch has already passed");
  });

  it("refuses when the HTLC output no longer decrypts (already claimed/refunded)", async () => {
    const fixture = makeFixture();
    const commitmentHex = commitmentOf(fixture.network, fixture.conditions, fixture.fundWitness.mask, AMOUNT, fixture.claimantWalletAddress);
    const chain = fakeChain(stealthUtxoSubstateId(RES, fromHex(commitmentHex)), { encrypted_data: "00".repeat(64), public_nonce: "00".repeat(64) }, componentAddressFromWalletAddress(fixture.claimantWalletAddress));
    const { account } = makeAccount(fixture, chain);
    const operation = signClaimOperation(fixture, commitmentHex);
    await expect(buildSignedX402Claim(account, operation)).rejects.toThrow("x402SignClaim: the HTLC output no longer decrypts");
  });
});
