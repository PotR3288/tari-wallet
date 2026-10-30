# x402 e2e harness (Phase 5, Task 5.2)

Playwright-driven end-to-end runs of the full x402-over-Tari-Ootle payment flow against **live
esmeralda**, with the wallet as the built extension (`dist/`), the Task 5.1 facilitator stand-in
(`e2e/facilitator/`) as the settlement endpoint, and this directory's merchant service
(`service.mjs`) as the paywalled HTTP face.

```
payer wallet (extension #1)   merchant wallet (extension #2)      facilitator stand-in      esmeralda
        │  fetch /protected ──────────► service.mjs (merchant)               │                    │
        │  ◄─ 402 PAYMENT_REQUIRED + quote (X402PayTerms) ──────────────────┘                    │
        │  x402Pay ─► REAL popup approval click ─► htlcFund ───────────────────────────────────► │
        │  relays ownCommitment + conditions + outputMask                                         │
        │                    x402SignClaim ─► REAL popup approval click ─► sealed claim (no bc)  │
        │                    service POSTs /x402/settle ─► facilitator validates + HOLDS ──────► │
        │  ◄─ 200 resource (served while HELD — the spec's ordering)                              │
        │                    service confirms settle ─► facilitator broadcasts ────────────────► │
        │                                       held → broadcast → confirmed (chainTxId)           │
```

## Run

```sh
pnpm run build                # the harness loads the built extension from dist/
npx tsx e2e/harness/run.ts    # runs happy, then refund
```

Both scenarios run by default. Select one with `X402_E2E_SCENARIOS=happy` (or `refund`).
Requires a display for the two headed chromium instances (`Xvfb` works: `xvfb-run -a npx tsx
e2e/harness/run.ts`); extension loading needs headed chromium. Every approval is clicked in the
real popup window the background opens (`popup.html#/approve/<id>`) — no background bypass.

The run spawns and stops its own child services per scenario: the facilitator stand-in
(`npx tsx e2e/facilitator/server.ts`, port `X402_E2E_FACILITATOR_PORT` default 4020) and the
merchant service (`node e2e/harness/service.mjs`, port `X402_E2E_SERVICE_PORT` default 4021).
Full transcript with timestamps is written to `e2e/harness/logs/run-<timestamp>.log`.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `X402_E2E_SCENARIOS` | `happy,refund` | Which scenarios to run. |
| `X402_E2E_RUN_INDEX` | `1` | Seed index. **Increment per rerun** — wallets are seeded from deterministic mnemonics keyed by (role, scenario, run index), so a rerun must use a fresh index or it will import the same already-spent wallet. |
| `X402_E2E_DIST` | `<repo>/dist` | The built-extension directory to load. |
| `X402_E2E_INDEXER_URL` | `https://ootle-indexer-a.tari.com` | Real esmeralda indexer (reads/broadcast stay here; the facilitator is only the `/x402/settle` target). |
| `X402_E2E_NETWORK` | `esmeralda` | Network (faucet exists on esmeralda/igor only). |
| `X402_E2E_HAPPY_REFUND_EPOCHS` | `4` | Happy-path quote: refundEpoch = current + N (must outlive the settle leg; esmeralda epochs are ~1 hour). |
| `X402_E2E_REFUND_REFUND_EPOCHS` | `2` | Refund scenario: short refund epoch so the expiry wait is bounded. |
| `X402_E2E_TURNSTILE_WAIT_MINUTES` | `15` | How long the community-faucet fallback waits for its Cloudflare Turnstile token (auto-issued in a clean browser; otherwise a human clicks the checkbox in the faucet window once per wallet). |
| `X402_E2E_EPOCH_WAIT_MINUTES` | `150` | Wall-clock budget for the refund scenario's epoch wait. |
| `X402_E2E_WALLET_PASSWORD` | fixed | Password for the imported test wallets. |
| `X402_E2E_SERVICE_PORT` / `X402_E2E_FACILITATOR_PORT` | pid-derived | Local service ports (unique per invocation so a killed prior run's orphaned children can't collide). |
| `X402_E2E_HEADLESS` | off | `1` = headless chromium (extension support requires a new-headless-capable build; headed is the supported mode). |

Service-side knobs (set by the runner; documented for manual runs): `X402_SERVICE_CLAIMANT_ADDRESS`
(the merchant's otl_ address — required), `X402_SERVICE_FREEZE_BROADCAST=1` (refund scenario:
settle is held, never broadcast), `X402_SERVICE_REFUND_EPOCH_OFFSET`, `X402_SERVICE_AMOUNT`.

## How wallets are seeded (exact path)

The runner derives a deterministic Sapient cipher-seed 24-word mnemonic from
`sha256("x402-e2e-seed|<network>|<payer|merchant>|<runIndex*10+scenario>")` (via the repo's own
`src/lib/cipherSeed.ts` `encipherSeed` + `src/lib/mnemonic.ts` `bytesToWords`), then imports it
through the wallet's real onboarding UI: `popup.html` → “Import Existing Wallet” (`#import`)
→ mnemonic textarea (`#mnemonic`) + password (`#pw`/`#pw2`) → submit (`#submit`). Import needs no
backup verification.

**Funding** (both wallets need revealed XTR — every x402/x402SignClaim fee lane is transparent):
1. The network's on-chain faucet first: `popup-claim-testnet-xtr` (`OotleAccount.claimTestnetXtr`
   on esmeralda), **exactly one claim per wallet** (the template dispenses a fixed 1 XTR from a
   vault that either has it or does not — its own built-in retries handle contention; a dry vault
   is the escalation condition, not something to hammer).
2. Fallback when that vault is dry (measured 999,651,320/1,000,000,000 on 2026-10-30): the
   taritracker **community faucet** (`https://testnet-faucet.taritracker.com/`, ~1M tXTR pool,
   10 tXTR per claim, one per wallet per hour, Cloudflare Turnstile — auto-issued in a clean
   browser, otherwise click the checkbox in the faucet window). Those funds land as stealth
   outputs, so the wallet then rescans (`popup-rescan-private-payments`) and **unshields 2 tXTR**
   via a real dApp approval with the fee paid privately from the stealth UTXO itself
   (`{ kind: "unshield", feeType: "private", enforceFeeType: true }`).
3. Both funding paths failing IS the faucet-dry escalation: the run stops, prints its exact
   state, exits 2.

The same seed entropy lets the runner derive each wallet's address offline
(`OotleAccount.fromSeed`): the quote's `claimantAddress` and — test-only, per the facilitator
stand-in's documented `claimantViewKeyHex` deviation — the merchant view secret it passes to
`/x402/settle`.

## Scenarios and assertions

**Happy path** — one purchase, fresh facilitator + service:
1. dApp `fetch /protected` → asserts `402` + `PAYMENT_REQUIRED` envelope.
2. `x402Pay` via `tari_createTransactionRequest` → **real popup approval click** → submit →
   asserts the `HtlcFundResult` relay (`ownCommitment`, two-leaf `conditions`, `outputMask`).
3. Merchant wallet `x402SignClaim` (same origin, second extension) → **real popup approval
   click** → asserts the sealed claim payload (`signedPayloadHex`,
   `validUntilEpoch == refundEpoch - 1`).
4. Merchant service POSTs `/x402/settle` → asserts the claim validates into `held` (the
   facilitator runs every spec checklist gate against the live indexer).
5. Resource served while held; then merchant confirms settle → settlement transitions
   `held → broadcast → confirmed` are logged verbatim with the chain tx id.
6. Asserts: settlement `confirmed` with a real chain tx id; the claim tx is
   `Finalized/Commit` on esmeralda; the claimed HTLC output is spent on-chain
   (`getStealthUtxo` → gone/`Down`).

**Refund path** — second run, fresh facilitator + service with `X402_SERVICE_FREEZE_BROADCAST=1`
(the “frozen facilitator”: the claim is held and the broadcast is never confirmed):
1–5. Same purchase leg; asserts the resource was served while the payload was still held.
6. Waits (polling, no fixed sleeps) until the chain's own epoch passes the quote's short
   `refundEpoch`.
7. Asserts the facilitator reports the settlement `expired` (terminal; no chainTxId).
8. Payer refunds via the funder's `outputMask` path: `htlcRefund` request with the relayed
   `commitment`/`conditions`/`amount`/`outputMask` → **real popup approval click** → asserts the
   refund tx finalizes (`Finalized/Commit`) and the HTLC output is spent on esmeralda.

Exit codes: `0` all scenarios passed, `1` an assertion failed, `2` escalation/infrastructure
(faucet dry, services or indexer unreachable, epoch wait budget exhausted) — the log states the
exact point of failure either way.

## Scope notes

- This harness is excluded from `pnpm test`/vitest/typecheck (`tsconfig.json` includes `src/`
  only) — it is run explicitly via `npx tsx`, per the Phase 5 freeze constraints.
- `playwright` is a root devDependency solely for this harness.
- The facilitator unit tests stay offline (`npx vitest run --config e2e/facilitator/vitest.config.ts`);
  live runs are this harness's job.
- Ordering ruling: the merchant serves the resource while the claim is still `held` (spec
  ordering in `docs/x402-facilitator.md` — hold → serve → confirm → broadcast), which is also what
  makes the frozen-facilitator refund scenario coherent.
