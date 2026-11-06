# Sapient — a Tari Ootle Wallet (Chrome extension)

Named after "sapient pearwood," the self-aware wood Discworld's ever-loyal, fiercely protective
Luggage is carved from — fitting for a wallet that follows only you and answers to no one else,
in the same nerdy-but-earnest naming tradition as Tari's own testnets (Weatherwax, Igor, Esmeralda
— all Discworld references).

A self-custody Chrome extension wallet for [Tari Ootle](https://github.com/tari-project/tari-ootle)
(L2 — not the Minotari L1 base layer). It generates and holds its own 24-word recovery phrase,
derives keys, and signs and submits transactions **directly to the network** — no
`tari_ootle_walletd` daemon required for its own accounts. Pages get a MetaMask-style injected
provider (`window.tari`), not the WalletConnect relay protocol — see "Design notes" below for why.

It can **also** connect to a running `tari_ootle_walletd` and relay to it — the same "self-custody
accounts + hardware-wallet-style external accounts, side by side" split MetaMask uses for Ledger.
See "Daemon-relayed accounts" below.

**[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/tari-ootle-wallet/demkeckolenopkgnfbnpflkpbbdhpgkl)**
— listed there under the extension's original name/version pending a store update; the current
name is Sapient. A new build submitted to the Web Store goes through Google's own review before it
goes live, so the listed version can lag behind `master` for a few days — if you want the latest
release right away, **[install from the latest GitHub release](#installing-from-a-github-release-instead-of-the-web-store)**
instead. **Testnet-only. Under active development. Do not use it to hold real value.**

📖 **[Full documentation](docs/README.md)** — architecture (extension internals, transaction
lifecycle, stealth/HTLC support) and integration (provider API reference, transaction-request flow,
what to expect) as a [GitBook](https://www.gitbook.com)-structured book under `docs/`.

## License

[MIT](LICENSE) — OSI-approved, no noncommercial restriction. (Previously PolyForm Noncommercial
1.0.0; relicensed to qualify for the Tari Ootle launch contest, which requires an OSI-approved
license for entries.)

## Status: tested end-to-end in a live browser

Loaded as an unpacked extension in real Chrome and exercised against a live Ootle testnet indexer
(esmeralda), not just unit-tested in isolation. Confirmed working live:

- Wallet creation and import (24-word recovery phrase), password unlock/lock, multiple accounts
  per wallet with switching
- Claiming testnet XTR from the network's builtin faucet, including the self-funding
  first-transaction path for a brand-new account
- Balances rendered with each token's **real on-chain divisibility and symbol** (not guessed
  constants) — confirmed against tokens with different divisibility (XTR = 6, a custom
  DemoToken = 8)
- **Send** (to any `component_…` address, for any held token) and **Receive** (address display +
  copy-to-clipboard), both in the popup UI. (Send now takes the recipient's `otl_…` wallet address
  instead and derives the component address internally — see "Recent additions" below; the
  underlying component-address send path itself is what was verified live here.)
- The `window.tari` injected-provider flow end-to-end against a real third-party page: connect
  request → approval popup → account access, and transaction build → approval popup → sign →
  submit → on-chain confirmation
- A full DEX built against this wallet (`../tari-dex/swap-ui`) exercising it for token creation,
  liquidity-pool creation, adding liquidity, and swaps — including the multi-instruction,
  multi-retry transactions those flows require
- `tari_withdrawStealthAndExecute` — the dApp-facing RPC method for revealing Stealth-typed funds
  (e.g. XTR) into a caller's own contract call in one signed transaction (a plain
  `tari_signAndSubmitTransaction` can't touch Stealth vaults at all — see `OotleAccount
  .withdrawStealthAndExecute`'s doc comment in `wallet.ts`). Confirmed live via a real sealed bid
  through `../tari-dex/dao-ui`: reveal → deposit → withdraw_confidential → place_bid, one
  wallet-signed transaction, no dry run.

**Not yet exercised in the browser: daemon-relayed accounts.** The underlying relay logic is
verified end-to-end against a live `tari_ootle_walletd` (see "Daemon-relayed accounts" below), but
that was driven from Node directly, not by clicking through the popup's Connect-daemon UI in Chrome.

See "Design notes" below for the architectural decisions (own seed scheme, `window.tari` instead
of WalletConnect) and their trade-offs.

## Recent additions (typecheck/test/build verified; not yet exercised live)

- **Private transaction fees** (`WalletCapabilities.supportsPrivateFees`): every
  `tari_createTransactionRequest` kind except `redeemStealthOutputWithPrivateFee` (already always
  private) now takes an optional `feeType: "private" | "transparent"` hint and `enforceFeeType`
  flag. Unenforced, the approval popup shows a Transparent/Private toggle seeded from the dApp's
  hint or the wallet's own default (Settings → "Default fee privacy") and the user can change it
  before signing; `enforceFeeType: true` locks the toggle to the dApp's choice instead, with a plain
  sentence explaining why. A private fee pays from a separate stealth XTR UTXO
  (`resolveFeeType` in `background/index.ts`) and needs a seed-derived local account, same
  requirement as the rest of the stealth surface. The approval screen's per-kind copy was also
  restructured while this was in: each operation now renders as separate one-line facts
  (`steps`) instead of one run-on paragraph, with the minimum-value-promise disclosure broken out
  into its own highlighted warning box.

- **The private surface is now available to dApps**, in two halves that are deliberately separate
  permissions:
  - **Reading** a connected account's confidential position (`tari_getPrivateBalances`,
    `tari_getShieldedOutputs`, `tari_scanForPrivatePayments`, `tari_claimPrivatePayment`, and the
    `confidentialAmount` half of `tari_getBalances`) requires its own one-time grant via
    `tari_requestViewAccess`, with its own approval popup, revocable per-site from Connected sites
    without disconnecting. Connecting reveals one public component address; this reveals the whole
    position nothing else on-chain can see, so it is asked for separately and read-only — it never
    authorizes a spend. Without the grant, `tari_getBalances` reports `confidentialAmount: "0"`
    alongside `privateVisible: false`, so a withheld value is distinguishable from a real zero.
  - **Spending** privately is five new `tari_createTransactionRequest` kinds — `shield`,
    `unshield`, `sendPrivately`, `htlcClaim`, `htlcRefund` — joining the existing `htlcFund`, each
    through the same create → approval → submit flow as any other transaction. The wallet builds
    every stealth transfer itself (a dApp cannot hand over a raw `StealthTransfer` instruction: it
    needs a balance proof and per-input one-time authorizations only the wallet's signer can
    produce) and does its own coin selection, so a dApp supplies an amount and never touches a
    blinding mask or the view secret. `htlcClaim`/`htlcRefund` flip `capabilities.scriptPathSpend`
    to true for local accounts — the other half of `htlcFund`, which had no dApp-facing spend path
    before.
  - Also new: `tari_getWalletAddress`, the bech32m address a dApp needs to address a stealth output
    *to* the user (a component address can't be used as a stealth `destination`, and the wallet
    address isn't derivable from one).

- **Backend audit — two real bugs found and fixed** (see `SECURITY_AUDIT.md` §4 and §9 for the
  full writeup): (1) any web page — connected or not, no approval needed — could keep the wallet's
  auto-lock timer reset forever by calling `tari_getNetwork` on a timer, since `touchActivity()`
  fired unconditionally before any connection check; now it only fires for requests that actually
  use an established, approved connection. (2) `scanForPrivatePayments()` could permanently skip an
  unscanned gap of transactions (silently missing a private payment forever) if a scan ran out of
  pages before reaching where it left off last time, because it advanced its cursor regardless; now
  it only advances the cursor once it actually catches up. Also serialized every read-modify-write
  helper in `storage.ts` against concurrent callers (two popup windows, a page request racing a
  popup request) that could otherwise silently clobber each other's write — covered by new
  regression tests in `storage.test.ts`.
- **A second backend-audit pass** (message bridge + crypto primitives, `SECURITY_AUDIT.md` §9)
  found the page↔extension boundary (`content-script.ts`/`inject.ts`) and the crypto files
  (`cipherSeed.ts`/`derivation.ts`/`mnemonic.ts`/`domainHash.ts`/`crc32.ts`) clean, plus one more
  real bug: `getLocalAccount()`'s cache key never identified *which seed* a cached account was
  built from, so a request racing a wallet reset could leave a stale, wrong-seed account cached —
  silently inherited by a brand-new wallet created right after if `popup-create-wallet`/
  `popup-import-wallet` didn't clear the cache themselves (they now do, matching
  `popup-lock`/`popup-reset-wallet`). Also flagged, not fixed (needs the real Rust reference
  implementation to check against, out of scope for this pass): the crypto files pass every
  self-consistency test this codebase has, but none of those tests pin a golden vector produced
  end-to-end by the actual Rust wallet — worth running one real recovery phrase through both and
  diffing the derived keys before trusting this on mainnet.
- **Home screen** now shows the wallet (`otl_esm_...`) address instead of the component address —
  same reasoning as the Receive screen rework, and it's what a sender needs either way now.
- **Polish tier** (finishing the audit): per-kind icons on History rows (arrows for plain
  send, lock/unlock for shield-family and private-payment kinds, an external-link glyph for dApp
  transactions) and per-row icons on every Settings entry; icon + text empty states instead of flat
  centered text everywhere a list can legitimately be empty; skeleton loading rows on History and
  Connected sites (previously a bare "Loading…" line); a small entrance animation on success
  banners (`.status.ok`) instead of a flat color swap; a slightly heavier press transition on
  `.danger` buttons (Lock/Erase wallet) to differentiate their stakes from routine clicks; the
  token-detail "Private balance" row gets the same lock-icon + highlight-color treatment the home
  hero's private balance already had, instead of being the only place that accent showed up.
  Deliberately **not** done as part of this pass: a fiat-value display (needs a price-data
  dependency and source decision) and a light theme (a real design commitment, not a mechanical
  fix) — both left for an explicit decision rather than guessed at.
- **Structural UI/UX pass** (continuing the audit above): Create Wallet now gates past the
  seed-phrase screen with a spot-check (re-enter 3 randomly-picked words) before finishing —
  previously trusted an unverified "I've saved it" click on the single highest-consequence screen
  in the app, matching how MetaMask/Phantom/Rainbow all gate theirs. Approval screens (connect and
  transaction) now show an account chip (avatar/label/short address) for whichever account will
  actually sign — for a transaction that's the site's originally-connected account
  (`approval.accountId`), not necessarily today's active one, so a multi-account user can confirm
  which identity/funds a request exposes before approving. Address-book "Remove", daemon
  "Disconnect", and connected-site "Disconnect" — previously instant on click — now go through an
  inline confirm/cancel step. The account switcher's rows are a flat list (`.settings-row`) instead
  of the active account rendering as a full-width filled CTA button in a stack of "buttons".
- **UI/UX pass** (from a full-popup audit — see `main.ts`/`styles.css`): submit buttons now show
  their own busy state (label swaps to "Sending…"/"Shielding…"/etc. instead of just graying out);
  live green/red address validation as you type on Send/Send-privately/Address book, since a wrong
  recipient there is unrecoverable-funds territory; thousands separators on displayed balances
  (`formatBalanceAmountGrouped` — kept separate from `formatBalanceAmount`, which stays
  round-trippable into the MAX-button-filled amount fields); the lock screen shows the real
  per-account identicon when known (`WalletState.lastKnownAddress`, cached in plaintext from the
  last unlock — a component address isn't secret) instead of a placeholder, the same
  spot-the-wrong-wallet pattern MetaMask uses; ARIA roles on the Send/Send-privately tabs and a
  live region on copy-to-clipboard feedback; `inputmode="decimal"` on amount fields; Enter-to-submit
  and autofocus on Create/Import, matching Unlock; consistent `.detail-value`/`.btn-compact` classes
  replacing several near-duplicate inline styles; a real chevron icon instead of a literal "▾"
  glyph; and native checkboxes recolored to the app's accent instead of rendering OS-default.
- **Address book** (Settings → Address book): saved `component_…`/`otl_…` recipients, offered as a
  picker in both Send and Send-privately without replacing manual entry.
- **Network switching** (Settings → Network): esmeralda/igor, with an inline confirmation before
  switching (the storage field and read path already existed; this wires up the write path + UI).
  Clears the account cache on switch so a stale daemon-relayed account can't keep talking to the
  old network — see `background/index.ts`'s `popup-set-network` handler.
- **Transaction history** (home screen → History): client-recorded from here forward, covering
  Send, Shield, Unshield, Send-privately, testnet-XTR claims, claimed private payments, and
  dApp-submitted transactions (labeled structurally via `instructionSummary.ts`, never decoding
  instruction args — same policy as the approval screen). **Not** a retroactive reconstruction of
  on-chain history; see `TransactionHistoryEntry`'s doc comment in `storage.ts` for why.
- **Memo support** on Shield/Unshield/Send-privately: an optional encrypted note attached to a
  stealth output (`{ Message: text }` — see `toMemo()` in `wallet.ts` for why this isn't a plain
  string at the SDK boundary). For Send-privately it's attached to the recipient's output only, not
  the sender's own change output.
- Fixed a `getBalances()` gap where a resource whose *only* balance came from redeeming someone
  else's shared stealth commitment (no on-chain vault ever created) showed as absent entirely.
- `scripts/local-unshield-test.ts`: a live-verification script mirroring `local-shield-test.ts`,
  since unshield shares shield's fixes but was never explicitly re-verified live after them.
  **Run this yourself** (it needs your real mnemonic) before trusting unshield in production.
- **Send now takes the recipient's `otl_…` wallet address**, not their `component_…` address —
  `componentAddressFromWalletAddress()` (`componentAddress.ts`) derives the latter from the former
  (they identify the same account), so a recipient only ever has to hand out the one address that
  also works for private sends. Not yet re-exercised live (the underlying send-to-a-component-address
  path was; only this new derivation step is unverified against a real testnet address).
- **Password strength check** on Create/Import (`src/lib/passwordStrength.ts`): blocks an exact or
  trivially-disguised match against a curated common-password list (leet substitutions, padding,
  sequential/repeated/keyboard-walk patterns all normalized away first), plus a live advisory
  strength meter. Addresses the "no strength meter or dictionary check" gap named in
  `SECURITY_AUDIT.md` §7.
- **Receive screen now leads with the wallet address**, not the component address, with copy
  explaining why: stealth-type payments (shield/send-privately) derive a fresh one-time on-chain key
  per payment off of it, so it's safe to publish and reuse without ever letting a chain observer link
  two payments together. The component address moved behind an "Advanced" disclosure — publishing it
  gives up that privacy for plain sends, which record it exactly as given, and it's otherwise
  redundant now that Send accepts the wallet address directly.

**`OotleAccount.getComponentAddress()` (`src/lib/wallet.ts`) derives the on-chain component
address client-side**, via `deriveAccountComponentAddress()` in `src/lib/componentAddress.ts`. This
reproduces `derive_component_address_from_public_key` (`crates/engine_types/src/component.rs`,
tari-project/tari-ootle) — a domain-separated Blake2b-256 hash of
(`ACCOUNT_TEMPLATE_ADDRESS`, `owner_public_key`) — byte-for-byte in TypeScript, since neither
`@tari-project/ootle` nor `@tari-project/ootle-wasm` expose this computation. Getting the
domain-separation/Borsh-framing bytes even slightly wrong would produce a wrong-but-plausible
address silently, so this was verified against all three of the golden test vectors committed
upstream in `crates/ootle_sdk_core/fixtures/address_derive/*.json` (generated by the real Rust
engine) — see the `component address matches golden vector` assertions in
`scripts/test-crypto.ts`. One byte-level detail worth flagging for a future reviewer: the public
key is Borsh **slice**-encoded (4-byte LE length prefix + 32 bytes), not raw-array-encoded like
`template_address` — `RistrettoPublicKeyBytes`'s manual `BorshSerialize` impl delegates to
`self.as_bytes(): &[u8]`, which Borsh treats as a dynamically-sized slice. Missing that prefix is
the one way this silently produces a wrong-but-plausible address instead of failing loudly.

## Design notes

**Seed & derivation use Tari's official CipherSeed format (implemented 2026-07-23).** The 24-word
recovery phrase is a real `CipherSeed` (`src/lib/cipherSeed.ts`, reproducing
`base_layer/common_types/src/seeds/cipher_seed.rs` byte-for-byte: version‖birthday‖16-byte
entropy‖MAC, ChaCha20-encrypted with a key derived via Argon2d — 46 MiB memory cost — and CRC32
checksummed) and account keys are derived with Ootle's own `derive_ristretto_key`
(`src/lib/derivation.ts`, reproducing `tari-ootle`'s `crates/wallet/crypto/src/derive.rs`: a
domain-separated Blake2b-512 hash under `KeyManagerDomain`, wide-reduced to a Ristretto scalar).
**Practical consequence:** a recovery phrase created here imports into the official wallet
daemon/Aurora/desktop wallet, and phrases from those import here — verified byte-exact against the
real `tari_common_types`/`tari_crypto`/`tari_hashing` crates (see `scripts/test-crypto.ts`'s golden
vectors, generated via a throwaway `cargo` harness against those crates at tari-ootle's exact pinned
versions, since no known-answer vectors exist upstream for this format).

**Scope limit: no separate seed passphrase.** Tari's CipherSeed supports an optional passphrase
distinct from whatever encrypts the wallet at rest (like BIP-39's optional 25th word). This
extension doesn't expose that as a feature — it always enciphers/deciphers with the documented
default (`None` → `"TARI_CIPHER_SEED"`), same as the official console wallet's own default when the
user hasn't set one. Importing a phrase that was created elsewhere *with* a custom seed passphrase
will fail to decrypt here with a clear error, not silently derive the wrong keys.

**`window.tari`, not WalletConnect v2.** Real WalletConnect requires registering a project with
Reown's relay network and implementing the wallet side of that pairing protocol (which,
per research at the time this was built, doesn't exist yet anywhere in the Tari ecosystem — only
the dApp-consumer side, `@tari-project/wallet-connect-signer`, does). This extension instead
injects a MetaMask-style provider object into every page — same spirit (a page requests accounts
and signatures from a wallet the user controls), much smaller surface area, no external relay
dependency, works with pages coded against it (e.g. `../tari-dex/swap-ui`) but isn't interoperable
with arbitrary WalletConnect-speaking dApps.

## Daemon-relayed accounts

**Core relay path verified against a live `tari_ootle_walletd` (esmeralda) from Node — connect,
authenticate, list accounts, read balances, and both dry-run and real transaction submission all
confirmed working end-to-end.** The popup UI itself (Connect daemon wallet screen, account picker,
Send/Receive/balances rendering for a daemon-backed active account) has not yet been clicked through
in Chrome — only the underlying `DaemonAccount` class has been exercised directly.

One real bug was caught and fixed during that verification: a locally-built unsigned transaction
defaults `is_seal_signer_authorized: false`, which the engine's `TransactionSignatureValidator`
rejects with "has no main signer" for a single-signer request (the shape every daemon-relayed
transaction here uses) — `DaemonAccount.execute()` now sets it explicitly. See the comment at its
call site in `daemonAccount.ts` for the full explanation; this is exactly the kind of silent,
plausible-looking failure mode the "Design notes" section above warns about elsewhere in this
codebase, and worth knowing about if you extend this class.

Local (seed-derived) and daemon-relayed accounts coexist in the same wallet, switchable from the
same account list — Settings → "+ Connect daemon wallet", or straight from the account switcher.
Connecting asks for the daemon's URL (`http://127.0.0.1:5100`-style) and an **API key**, then lists
that daemon's accounts so you pick which ones to add — the same "connect, then choose accounts to
import" shape as a hardware-wallet flow.

**Why an API key, not a login.** The first version of this connected via the daemon's normal
session flow (`auth.request` + silent `auth.refresh`) — this was wrong, and broke as soon as a
token actually expired. Per the tari-ootle maintainers (confirmed in review of the fix this section
used to describe, [PR #2375](https://github.com/tari-project/tari-ootle/pull/2375)):
`auth.refresh` reads an HttpOnly, `SameSite=Strict` session cookie set on browser login — a
`chrome-extension://` origin can never hold that cookie, by design, not a bug. WebAuthn (the
daemon's actual default auth method — this project's earlier testing only worked because the local
test daemon was deliberately misconfigured with `authentication=none`) locks its RP origin to
`http://localhost:{json_rpc_port}` regardless, which a Chrome extension page never runs on either
way. Neither session-auth path can work from here, full stop. The supported way for an external
client like this extension to authenticate is a long-lived **API key**, minted once from the
daemon's own web UI (which *does* have a real Admin browser session) and pasted into the connect
screen here — no refresh needed, ever, since it isn't a session token. Verified end-to-end against
a live daemon: minted a real API key, connected with it exclusively (no session at all), listed
accounts, read balances, and confirmed an invalid key gets rejected with a clear message rather
than a raw RPC error.

The connect screen has an **"Open API Keys page ↗"** button that opens the daemon's own web UI
("Tari Asset Vault") directly to `/api-keys` in a new tab — confirmed that route works as a direct
deep link, not just in-app client-side navigation, so this doesn't just dump the user on the
homepage to go find it themselves. Since opening a new tab steals focus and an extension popup
closes the instant it loses focus, the URL/label fields (not the API key itself) are drafted to
`chrome.storage.session` on every keystroke and restored the next time this screen renders, so
going to mint a key and coming back doesn't lose what was already typed.

**Expiry, revocation, and insufficient permissions are all handled explicitly**, not just left to
surface as raw RPC errors:

- `connectClient()` requires the key to carry the **`admin`** permission, checked *at connect time*
  — confirmed empirically that this wallet's own daemon-relayed "Claim testnet XTR" feature
  (`accounts.create_free_test_coins`) hard-rejects a narrower key with "Insufficient permissions.
  Required 'Admin'" verbatim, not a finer per-resource grant, so nothing less will do. There's no
  direct "what does this key grant" introspection available to API-key auth at all —
  `auth.list_api_keys` explicitly refuses it ("requires an interactive user session, not an API
  key") — so the check instead probes `settings.get`: a harmless read nothing else in this wallet
  ever calls, gated on `Settings(Read)` specifically, which only an admin-scoped key would satisfy
  in practice.
- Every daemon call distinguishes **expired/invalid/revoked** from **insufficient permission** —
  confirmed empirically that the daemon reports both as the *same* 401, distinguishable only by
  message text (`"Access denied. ..."` vs `"Insufficient permissions. Required '...'"`) — and
  rewrites each into an actionable message pointing at the right fix (mint a fresh key vs. mint one
  with broader permissions), instead of a raw `RPC Error 401: ...` either way.
- Verified all of this against a live daemon: an admin key connects cleanly, a narrowly-scoped key
  is rejected at connect time with the permission message, and both a garbage key and a freshly
  revoked (formerly valid) key are correctly classified as expired/invalid rather than a permission
  problem.

A daemon-relayed account (`src/lib/daemonAccount.ts`, `DaemonAccount`) never signs or derives
anything client-side — the daemon holds the real key material. Two consequences that make this a
genuinely different code path from `OotleAccount`, not just a swapped-in signer:

- **No client-side retry loop.** `OotleAccount.execute()`'s whole reason for existing is that
  neither this TS SDK nor the indexer this extension talks to directly does automatic
  dependency-graph discovery ("want-derivation") the way Rust's `ootle_sdk_core` does, so it has to
  retry reactively off rejection messages (see that method's own doc comment). The daemon's
  `transactions.submit` JRPC takes a `detect_inputs: true` flag that asks the daemon to do that
  discovery itself, server-side, in one round trip — so `DaemonAccount.execute()` just builds the
  unsigned transaction and submits it once.
- **Deliberately does not use `WalletDaemonSigner`** (the higher-level signer class the same npm
  package exports). Its own doc comment flags that its `signTransaction`'s handling of
  `seal_public_key` is unverified against a real daemon and can fail late and opaquely if the
  daemon doesn't honor it. `DaemonAccount` sidesteps that entirely by calling the daemon's own
  account/balance/submit JRPC methods directly (`accountsGetBalances`, `submitTransaction`,
  `createFreeTestCoins`, ...) rather than composing this extension's own `TransactionBuilder` with
  a borrowed `Signer` — the daemon does its own signing internally, out of band from this class.

**Known limitation:** stealth/confidential operations aren't wired up for daemon accounts (XTR's
native container type is `Stealth`, but everything this extension actually does with it — claim,
send, swap — moves it through revealed `withdraw`/`deposit`, which needs no stealth signing). The
daemon's own stealth JRPC (`stealthTransfer`, `stealthUtxosList`, ...) exists but isn't called here.

Connecting to a remote daemon (not `localhost`/`127.0.0.1`, which are covered by
`manifest.json`'s unconditional `host_permissions`) prompts Chrome's own permission dialog for
that specific origin at connect time, via `optional_host_permissions` +
`chrome.permissions.request()` in the Connect screen's click handler — this has to run in the
popup's own foreground context as a direct result of the user's click; a background service worker
can't call it. Declining leaves the connection attempt cancelled with a clear message, not a
confusing CORS failure.

## Integrating a dApp

Once loaded, the extension injects a MetaMask-style provider at `window.tari` into every page —
EIP-1193-shaped (`request({ method, params })`), not the WalletConnect relay protocol (see "Design
notes"). `../tari-dex/swap-ui/index.html` is a complete, real working example of everything below.

```js
// Detect the wallet. It may not exist yet at page-load time, so also listen for its ready event.
if (!window.tari?.isTariWallet) {
  window.addEventListener("tari#initialized", () => console.log("Tari wallet ready"), { once: true });
}

// Connect — prompts the user with an approval popup the first time; a no-op afterwards.
const [accountAddress] = await window.tari.request({ method: "tari_requestAccounts" });

// Read-only calls — no approval popup.
await window.tari.request({ method: "tari_getAccounts" });   // -> string[] (already-connected accounts)
await window.tari.request({ method: "tari_getNetwork" });    // -> "esmeralda" | "igor"
await window.tari.request({ method: "tari_getBalances" });   // -> { resourceAddress, kind, amount, confidentialAmount, privateVisible, divisibility, symbol }[]
await window.tari.request({ method: "tari_getWalletAddress" }); // -> bech32m address to pay this account *privately*
await window.tari.request({
  method: "tari_getSubstate",
  params: { substateId: "resource_...", version: null },     // -> raw Substate (e.g. to read a resource's divisibility/metadata)
});

// Build and submit a transaction — prompts an approval popup unless dryRun is true.
const result = await window.tari.request({
  method: "tari_signAndSubmitTransaction",
  params: {
    instructions: [ /* raw Instruction[] from @tari-project/ootle-ts-bindings */ ],
    maxFee: "5000",       // optional, string (µT)
    dryRun: false,        // true = simulate only, no approval popup, nothing spent
    inputs: [],            // optional: substates you already know are needed; the wallet
                            // auto-resolves anything else missing via its own retry loop
  },
});

// ---- Private balance -------------------------------------------------------------------------
// Reading the user's *private* (shielded) position is a separate permission from connecting, with
// its own approval popup — connecting reveals one public address, this reveals the whole position
// nothing else on-chain can see. It is read-only: it never authorizes a spend.
const { granted } = await window.tari.request({ method: "tari_requestViewAccess" }); // approval popup
if (granted) {
  await window.tari.request({ method: "tari_getPrivateBalances" });  // -> per-resource shielded totals
  await window.tari.request({ method: "tari_getShieldedOutputs" });  // -> the individual UTXOs behind them
  await window.tari.request({ method: "tari_scanForPrivatePayments" }); // view-key scan for incoming payments
}
await window.tari.request({ method: "tari_revokeViewAccess" });      // give it back when you're done

// Without the grant, `tari_getBalances` still works but withholds the confidential half — it
// reports `confidentialAmount: "0"` with `privateVisible: false`. Branch on `privateVisible`;
// a withheld value is NOT a claim that the account holds nothing privately.

// ---- Private spends --------------------------------------------------------------------------
// Six transaction-request kinds move value in/out of stealth outputs: shield, unshield,
// sendPrivately, htlcFund, htlcClaim, htlcRefund. Each goes through the same
// create -> approval -> submit flow as any other transaction (view access is neither required for
// them nor a substitute for their approval).
const { requestId } = await window.tari.request({
  method: "tari_createTransactionRequest",
  params: { kind: "shield", resourceAddress: "resource_...", amount: "1000000" },
});
// ...poll tari_getTransactionRequest until status === "approved", then tari_submitTransactionRequest.
// You can't hand the wallet a raw StealthTransfer instruction — it needs a balance proof and
// per-input authorizations only its own signer can produce, so it builds the transfer itself.
// Coin selection is likewise the wallet's decision: you supply an amount, not a set of UTXOs.

await window.tari.request({ method: "tari_disconnect" });

// Fires (mirroring EIP-1193's accountsChanged) whenever the wallet drops this page's connection
// out from under it — e.g. the user switched the active account in the extension. `detail` is
// always `[]`; treat it purely as a signal to re-run `tari_requestAccounts` before the next call.
window.addEventListener("tari#accountsChanged", (e) => {
  console.log("accounts changed:", e.detail); // []
});
```

Notes for dApp authors, learned building `tari-dex/swap-ui` against this wallet:

- **CBOR-encode instruction args yourself.** `instructions` are the raw `Instruction[]` shape from
  `@tari-project/ootle-ts-bindings` — numeric/address/string args need `InstructionArg::Literal`
  CBOR encoding (see `amountLiteral`/`resourceAddressLiteral`/`componentAddressLiteral`/
  `stringLiteral` exported by `@tari-project/ootle` if you can depend on it directly).
- **You don't need to know every substate your instructions touch.** The wallet's own auto-retry
  (`OotleAccount.execute()`) discovers and pins whatever's still missing by parsing the engine's
  rejection messages and resubmitting — `inputs` is purely an optimization, never required for
  correctness.
- **Dry-run calls skip the approval popup**, real submissions don't — so it's safe to dry-run on
  every keystroke (e.g. for a live price quote) without spamming the user with popups.
- Resource decimal precision (`divisibility`) and display names (`symbol`) are real on-chain data
  (`Resource.divisibility` / `Resource.metadata.SYMBOL`) fetched via `tari_getSubstate` or returned
  directly by `tari_getBalances` — don't hardcode a decimals constant per token.
- Switching the active account inside the extension disconnects every connected site (each
  connection is pinned to whichever account was active when it was made) and fires
  `tari#accountsChanged` on every open tab — listen for it rather than caching the account address
  from `tari_requestAccounts` indefinitely.
- **Private view access is dropped by all the same things**, plus the user revoking it from
  Connected sites while leaving the site connected. Re-approving a connection does not restore it.
  Re-check `tari_getViewAccess` (or `capabilities.privateViewGranted`) instead of assuming a grant
  from earlier in the session still holds.
- **Ask for view access when a feature needs it, not at connect time.** It is a separate prompt on
  purpose, so the user is answering about something visible in front of them. Check
  `capabilities.privateBalanceView` first — it's false for a daemon-relayed account, which can never
  serve these reads, so prompting there is a dead end.
- **`sendPrivately`'s `recipientCommitment` is the recipient's only lead to their payment.** There
  is no scan-by-view-key API for a specific counterparty; deliver it out of band, or the payment is
  invisible to them even though it landed on-chain. They redeem it with `tari_claimPrivatePayment`.
- **Persist `htlcFund`'s `outputMask` and `amount`.** The output is addressed to the claimant, so
  the funder can't decrypt it — without those two values retained from funding time, `htlcRefund`
  has no recovery path at all.

## Architecture

```
src/
  lib/
    domainHash.ts    DomainSeparatedHasher<Blake2b> byte-exact port (tari_crypto's hashing.rs)
    crc32.ts         standalone CRC-32 (IEEE 802.3), CipherSeed's checksum
    mnemonic.ts      33 bytes <-> 24 words, Tari's radix-2048 codec (not BIP-39)
    cipherSeed.ts    Tari's official CipherSeed format: encipher/decipher, mnemonic <-> seed
    derivation.ts    entropy + account index -> (owner, view) Ristretto scalars (Ootle's own scheme, byte-exact)
    componentAddress.ts  owner public key -> on-chain component_<hex> address (Tari's own scheme, byte-exact)
    vault.ts         password -> AES-256-GCM encrypt/decrypt of the seed (WebCrypto, PBKDF2 600k)
    wallet.ts         OotleAccount: wraps SecretKeyWallet (signing) + IndexerProvider (network)
    daemonAccount.ts  DaemonAccount: relays to a connected tari_ootle_walletd instead of signing locally
    accountApi.ts      WalletAccountApi: the shared surface OotleAccount and DaemonAccount both implement
    storage.ts        chrome.storage.local wrapper (encrypted vault + local/daemon accounts + connected sites)
    messages.ts        shared message shapes across all contexts
  background/
    index.ts           service worker: message router, page-request + popup-request handling
    session.ts          unlocked seed cache, in chrome.storage.session (survives SW restarts)
    accounts.ts          resolves an account id (local or daemon) to a WalletAccountApi, cached
    approvals.ts          pending connect/sign requests + approval popup windows
  content/
    inject.ts             MAIN-world script; defines window.tari
    content-script.ts       ISOLATED-world relay: page <-postMessage-> here <-runtime.sendMessage-> background
  popup/
    main.ts                vanilla-TS UI: onboarding, unlock, home, send, receive, settings,
                            connect-daemon-wallet, approvals (routed via location.hash)
```

Manifest V3 service workers are ephemeral — Chrome can kill and restart the background script at
any time. The unlocked seed lives in `chrome.storage.session` (in-memory only, cleared when the
browser fully closes) specifically so a SW restart mid-session doesn't silently re-lock the wallet;
a plain module variable would not have survived that.

## Icon

`public/icons/icon.svg` is the source of truth for the eye mark (a vesica-shaped "eye" — the
sapience/self-awareness half of "sapient pearwood" — filled with the app's own accent gradient).
`icon16/48/128.png` are rasterized from it (`sharp`, not committed as a project dependency — it
was run once via a throwaway scratch script, since pnpm's install-script allowlist deliberately
keeps native-binary dev tools like this out of the real dependency tree unless they're needed at
build time). To regenerate after editing the SVG: rasterize it to 16/48/128px PNGs with any
SVG-to-PNG tool (e.g. `npx sharp-cli`) and overwrite the files in `public/icons/`.

**Known stale asset:** `store-assets/screenshot-*.png` were captured before this rename and still
show the old icon/wordmark — regenerate them next time the extension is loaded for real (see
"Loading it in Chrome" below), they weren't auto-updated here.

## Building

Uses [pnpm](https://pnpm.io) (see "Supply chain" below for why), not npm/yarn:

```
pnpm install
pnpm run build      # -> dist/
```

Wasm handling needs `vite-plugin-wasm` + `vite-plugin-top-level-await` — `@tari-project/ootle-wasm`
ships as `import * as wasm from "./x.wasm"` (the still-not-natively-supported-in-Chrome "ESM
integration for WebAssembly" pattern; verified empirically against a real browser during
development, not assumed), which only a bundler with a dedicated transform can handle. Plain esbuild
cannot; that's why this project uses Vite specifically.

## Supply chain

Package installs go through **pnpm**, not npm, specifically for one property npm can't give you:
pnpm blocks every dependency's install-time (`preinstall`/`install`/`postinstall`) scripts by
default — the single most common real-world npm supply-chain attack vector, since a compromised
package's postinstall script runs with full filesystem/network access at install time, no
different from executing arbitrary code. `pnpm-workspace.yaml`'s `allowBuilds` is the explicit,
committed allowlist of the only two dependencies that legitimately need one (`@swc/core` and
`esbuild`, both downloading their own platform-specific native binary — confirmed by inspecting
every installed package's own `package.json` for a lifecycle script before allowing it, not
assumed). Anything else pulled in later that tries to run an install script stays blocked until
someone deliberately adds it here — that's a deliberate speed bump, not an oversight.

Also: `pnpm-lock.yaml` is the only lockfile (no `package-lock.json` — having both invites
installing with whichever tool someone has handy, silently drifting from what CI actually
verified), CI runs `pnpm install --frozen-lockfile` (fails outright on any lockfile drift, never
silently re-resolves) followed by `pnpm audit`, and a known vulnerability in a transitive,
build-time-only dependency (`uuid`, pulled in by `vite-plugin-top-level-await`) is pinned to a
patched version via `pnpm-workspace.yaml`'s `overrides` rather than by changing the wasm build
plugin itself, which this project is deliberately pinned to (see above).

## Loading it in Chrome

### Installing from a GitHub release (instead of the Web Store)

The [Chrome Web Store listing](https://chromewebstore.google.com/detail/tari-ootle-wallet/demkeckolenopkgnfbnpflkpbbdhpgkl)
has to clear Google's own review before an update goes live, which can lag a real release by days
— a prebuilt, ready-to-load zip is attached to every
[GitHub release](https://github.com/chironbuilds/tari-wallet/releases) for exactly that gap. No
build step, no Node/pnpm required.

1. Download `sapient-wallet-<version>.zip` from the
   [latest release](https://github.com/chironbuilds/tari-wallet/releases/latest) and unzip it
   somewhere you'll keep it (Chrome loads the extension from that folder every time it starts —
   don't delete or move it afterward).
2. Open `chrome://extensions`, enable **Developer mode** (top right).
3. Click **Load unpacked** and select the unzipped folder (the one containing `manifest.json`
   directly, not a parent folder).
4. Click the extension icon to open the popup and create or import a wallet.

Chrome doesn't auto-update a sideloaded extension — repeat these steps with a newer release's zip
(over the same unzipped folder) when you want to upgrade.

### Building and loading from source

1. `pnpm run build`
2. Open `chrome://extensions`, enable **Developer mode** (top right)
3. **Load unpacked** → select the `dist/` folder
4. Click the extension icon to open the popup and create or import a wallet

## Testing

**Node version:** run tests on Node ≤25 — CI pins 24. Under Node 26, `cbor@10.0.12` corrupts Buffer encoding (`encode(Buffer)` truncates to a single byte), which breaks the x402 sign-only fixtures; reproduced in a clean install.


```
pnpm test              # unit tests (vitest) — pure logic: parsing, validation, error classification
pnpm run test:watch    # same, in watch mode
pnpm run test:crypto   # scripts/test-crypto.ts — see below
```

`pnpm test` covers the pieces that are easy to get subtly wrong and hard to notice when they are:
`parseDecimalToRaw`/`normalizeDaemonUrl`/`isValidComponentAddress` (`src/popup/format.ts`),
`extractMissingSubstateAddress`/`extractStaleLockVersion` (the regexes `OotleAccount.execute()`'s
retry loop depends on), `isDaemonUnreachable`/`toIndexerResultShape` (`DaemonAccount`'s error
classification and result-shape normalization), and the account-id encode/decode round-trip
(`storage.ts`). Runs against plain Node (`vitest.config.ts` deliberately skips the CRX/wasm/
top-level-await plugins `vite.config.ts` needs for packaging — the tests don't need them).

Pure display/validation logic that a popup screen needs is kept in a plain module (e.g.
`src/popup/format.ts`) separate from the screen's own render function, specifically so it stays
importable in a test file without pulling in `main.ts`'s side effects (it calls `main()` — which
touches `document` — at module load).

`pnpm run test:crypto` verifies CipherSeed enciphering/deciphering and mnemonic encoding against
golden vectors generated from the real `tari_common_types`/`tari_crypto`/`tari_hashing` crates,
account-key derivation against golden vectors from the same run (derivation determinism: same
entropy+index always derives the same keys; different index/seed always derives different keys;
derived scalars are correctly reduced mod the Ristretto group order), and component-address
derivation against three golden vectors generated by the real upstream Rust engine. This doesn't
touch the `@tari-project/ootle-wasm` module (Node needs `--experimental-wasm-modules`-style native
support for that, which is a separate concern from whether Chrome's bundler-target import works —
see Design notes) — it does exercise `hash-wasm`'s Argon2d WASM, which loads fine under plain Node.
