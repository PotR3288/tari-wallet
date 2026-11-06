import { decipherSeed, encipherSeed } from "../src/lib/cipherSeed";
import { deriveAccountKeys, deriveAccountComponentAddress } from "@chironbuilder/ootle-sdk";
import { bytesToWords } from "../src/lib/mnemonic";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("ok  " + msg);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// CipherSeed + account-key-derivation golden vectors, generated from the real upstream crates
// (tari_common_types v5.5.0-pre.1, tari_crypto v0.23.2, tari_hashing v5.5.0-pre.1 — the exact
// versions tari-ootle pins) via a throwaway `cargo` harness: `CipherSeed::random()`, then its
// `entropy()`/`birthday()`, `encipher()` bytes, `to_mnemonic()` words, and (reimplementing
// `derive_ristretto_key` inline against the same tari_crypto/tari_hashing primitives, since that
// function lives in tari-ootle's wallet crate rather than tari_common_types) the derived
// account/view-only secret keys at indices 0 and 1. No known-answer vectors exist upstream for
// this format (every Rust test there is a self-consistent round-trip, per CipherSeed's own doc
// comment), so this is what "verified against the real engine" means here — self-generated, not
// upstream-provided, but produced by the actual unmodified crate. Byte-exact agreement here is the
// only thing standing between a recovery phrase and either losing funds or a wrong-but-plausible
// wallet that silently doesn't interoperate with the official wallet daemon/Aurora.
const cipherSeedVectors = [
  {
    label: "default passphrase (None -> TARI_CIPHER_SEED)",
    passphrase: undefined as string | undefined,
    birthday: 1664,
    entropy: "3d78714125ebc4cf12d7063bc5e0c12a",
    salt: "1e7ec5002d",
    enciphered: "02f586981ca903db46200c4ff960df92d69001967a73d8581e7ec5002d39d6c119",
    mnemonic:
      "park bridge era mushroom also replace acquire around clarify loop hurry hard canvas lesson start inflict brand just sample arrange foam mixture attitude border",
    account0: "66e5591b5dc48f82f7615dc4db2758da6ed9df4e8def7032cf052784c247000d",
    viewOnly0: "e103fb7197f3d17d074b55051f02fcada921967eb5b35b5a2e1a78c4220eac06",
    account1: "8b1425e448f80af88e57207da50c2bfca926676c8d485ad97e934dcd5c643609",
  },
  {
    label: "custom passphrase",
    passphrase: "TestPassphrase123",
    birthday: 1664,
    entropy: "c61de85cecac74970f88dbd075230273",
    salt: "8cd354e91f",
    enciphered: "02ab57b5371c338a80ca01b393f67adca1df9a7c32c76dd68cd354e91fed36c2af",
    mnemonic:
      "gate gadget survey sell great card favorite achieve island surge dice build satisfy chase negative shrimp soap crew hawk next divert robust balance quit",
    account0: "ac922f991dffa999ab2b710a0374fd7da2945f9785300103d598212f9e8caf0d",
    viewOnly0: "8f917d6bcc1498ca5208ed945281efd95d0e9e8049cdac2fde7442c472318006",
    account1: "e5b67d6e4661d5ede44d3ab933f42fb6017e69e98587709b73870256fe33780c",
  },
];

for (const v of cipherSeedVectors) {
  const entropy = hexToBytes(v.entropy);
  const seed = { birthday: v.birthday, entropy, salt: hexToBytes(v.salt) };

  const enciphered = await encipherSeed(seed, v.passphrase);
  assert(toHex(enciphered) === v.enciphered, `[${v.label}] encipher matches golden vector`);
  assert(bytesToWords(enciphered).join(" ") === v.mnemonic, `[${v.label}] mnemonic encoding matches golden vector`);

  const deciphered = await decipherSeed(enciphered, v.passphrase);
  assert(
    toHex(deciphered.entropy) === v.entropy && deciphered.birthday === v.birthday && toHex(deciphered.salt) === v.salt,
    `[${v.label}] decipher round-trips to the original seed`
  );

  const { ownerSecret: account0 } = deriveAccountKeys(entropy, 0);
  const { viewSecret: viewOnly0 } = deriveAccountKeys(entropy, 0);
  const { ownerSecret: account1 } = deriveAccountKeys(entropy, 1);
  assert(toHex(account0) === v.account0, `[${v.label}] account[0] key matches golden vector`);
  assert(toHex(viewOnly0) === v.viewOnly0, `[${v.label}] view_only_key[0] matches golden vector`);
  assert(toHex(account1) === v.account1, `[${v.label}] account[1] key matches golden vector (index changes the key)`);
}

// Wrong passphrase must fail closed (checksum passes since it doesn't depend on the passphrase;
// only the MAC, which does, catches it) — this is what actually distinguishes "wrong password"
// from "corrupted phrase" in the real format.
let rejectedWrongPassphrase = false;
try {
  await decipherSeed(hexToBytes(cipherSeedVectors[1]!.enciphered), "wrong passphrase");
} catch {
  rejectedWrongPassphrase = true;
}
assert(rejectedWrongPassphrase, "wrong passphrase is rejected (MAC mismatch)");

// Derivation: same seed+index is deterministic, different index/branch/seed are distinct.
const seedA = hexToBytes(cipherSeedVectors[0]!.entropy);
const keys0a = deriveAccountKeys(seedA, 0);
const keys0b = deriveAccountKeys(seedA, 0);
assert(Buffer.from(keys0a.ownerSecret).equals(Buffer.from(keys0b.ownerSecret)), "same entropy+index derives the same owner key twice");
assert(!Buffer.from(keys0a.ownerSecret).equals(Buffer.from(keys0a.viewSecret)), "owner and view keys differ");

// Scalars must be reduced mod the group order (top bits of a 32-byte little-endian value can't
// all be set if it's < 2^252ish; a cheap sanity check that we didn't just return raw hash bytes).
const GROUP_ORDER = (1n << 252n) + 27742317777372353535851937790883648493n;
function leToBigInt(b: Uint8Array): bigint {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]!);
  return n;
}
assert(leToBigInt(keys0a.ownerSecret) < GROUP_ORDER, "derived owner scalar is < group order");
assert(leToBigInt(keys0a.viewSecret) < GROUP_ORDER, "derived view scalar is < group order");

// Component-address derivation: golden vectors committed in tari-ootle's
// crates/ootle_sdk_core/fixtures/address_derive/*.json (operation: derive_account_address),
// generated by the upstream Rust engine itself. Byte-exact agreement here is the only thing
// standing between this wallet and sending funds to addresses nobody controls.
const goldenVectors: [string, string][] = [
  ["f6f89e316e6ba5f05e5250ddd4a5d3ed39dcd038cf812cc6a154b6ec0951d25f", "component_26cf65a80010d961aa64950a5677fd9d3852adcf3618aa7fe171f6dda8b961ae"],
  ["44f53520926ec81fbd5a387845beb7df85a96a24ece18738bdcfa6a7822a176d", "component_23e5679a3e55e58e32318b94e258b73e72e3164b658f187fe5de833a861e2d45"],
  ["0707070707070707070707070707070707070707070707070707070707070707", "component_0f987d031de55aee41a7233426059b1c3506408832f3283eb2bdaed15a314021"],
];
for (const [pubKeyHex, expected] of goldenVectors) {
  const got = deriveAccountComponentAddress(hexToBytes(pubKeyHex));
  assert(got === expected, `component address matches golden vector for pk ${pubKeyHex.slice(0, 8)}…`);
}

console.log("\nAll crypto core tests passed.");
