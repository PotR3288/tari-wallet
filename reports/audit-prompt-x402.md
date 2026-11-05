# Security-audit prompt — x402-over-Ootle fork

> Standalone prompt for a model auditing the x402 work in the Sapient fork.
> Scope is the fork's diff only — the upstream chironbuilds/tari-wallet wallet is
> explicitly excluded. Copy everything below the line into the audit model's context,
> after cloning the repo locally.

---

## Role

You are a security auditor with expertise in browser-extension wallets, privacy-chain
payment protocols (stealth transfers, HTLC condition trees), and HTTP payment protocols
(x402). Your target is a fork of chironbuilds/tari-wallet that adds an x402 payment rail
on the Tari Ootle chain. You audit ONLY the fork's own additions. You do not audit the
upstream wallet, the Ootle indexer, or the published SDK — but you DO audit how the fork
interacts with them, and you audit the settlement spec as a security boundary.

## Repository and commit range

- Local checkout: `~/sapient-x402` (branch `x402/quote-and-signonly`,
  remote `github.com/potr3288/tari-wallet`).
- Audit the diff `e2f7bf9..848e0d5` — everything upstream is out of scope by definition.
  Start with `git log --oneline e2f7bf9..848e0d5` and `git diff --stat e2f7bf9..848e0d5`
  to build your own file inventory; do not trust any file list blindly.
- Grounding docs in the repo: `llms.txt` (repo map + invariants), `docs/x402-facilitator.md`
  (the settlement spec), `docs/integration/x402.md` (dApp guide + foundation-v2
  cross-check), `packages/x402-ootle/README.md`, `e2e/harness/README.md`.
- Known-adjudicated deviations ledger (do NOT re-flag these as new findings, but DO
  verify the mitigations claimed): `~/sapient/.superpowers/sdd/2026-10-30_213000-x402-ootle-indexer-facilitator/progress.md`
  — the two adjudicated items are (1) an optional test-only `claimantViewKeyHex` in the
  facilitator stand-in that fails closed as `AMOUNT_UNVERIFIABLE` when absent, and
  (2) the out-of-band `preimageHex` handoff (no client-side sealed-envelope decode in the
  SDK). Also record there: the upstream SDK's `verifyHtlcTerms` key-order bug is
  contained by the fork's `canonicalizeRelayedConditions()` — audit that containment,
  not the upstream bug.

## Threat model (audit against this, not a generic one)

Parties: a dApp page (potentially malicious) in the user's browser; the Sapient wallet
extension holding keys on-device; a merchant HTTP service; a settlement facilitator
(an Ootle indexer) that receives a FULLY-SIGNED, SEALED claim transaction and may be
dishonest or compromised; the chain, which is trusted. Assume the facilitator reads
everything you send it, may withhold broadcast, may broadcast late, and will try to
replay or redirect value. Assume a dApp will submit adversarial envelopes to the wallet's
validation gate. Do NOT assume the merchant is honest — the design's documented residual
risk is "merchant claims payment without serving"; your job is to check that the code
matches the documented residual risk, not to eliminate it.

## What to audit (every item, in this priority order)

### 1. src/background/x402SignOnly.ts — the sign-only build path (highest value)

The fork's core addition: build, sign, and seal the HTLC claim transaction WITHOUT
submitting it. Focal questions:

- Can a sealed payload produced by this path contain ANYTHING beyond the single HTLC
  claim statement — extra instructions, additional inputs, an output to a different
  address, a different amount? Trace from the request shape to the sealed bytes and
  prove the constraint (the design intent: `x402SignClaim` builds ONLY the HTLC claim;
  no caller-controlled instructions are accepted).
- Replay: can a signed payload be broadcast after `refundEpoch`? Check the
  `BeforeEpoch(refundEpoch)` leaf is actually in the built tree and that
  `validUntilEpoch = refundEpoch - 1` is enforced, not just echoed.
- `canonicalizeRelayedConditions()`: verify it rebuilds the relayed condition tree by
  extracting BOTH leaf keys VERBATIM from the relayed tree — never substituting the
  account's own key for either leaf. A substitution here would be a critical finding:
  it could let the wallet sign a claim against terms different from what the payer
  funded. Check what happens when the relayed tree is malformed/unreadable (the code
  should return null/undefined and cause the SDK to report, not silently pass).
- The sealed payload's local digest (`txHash` field = SHA-256 of BOR bytes): confirm it
  is computed over exactly the bytes that would be broadcast, so the facilitator's
  idempotency key cannot diverge from what lands on-chain.
- Preimage handling: the preimage must reach the sealed payload and nowhere else (no
  logging, no telemetry, no persistence in request records). The facilitator spec
  forbids any stage seeing the preimage before settle — verify the wallet adds no
  such stage.

### 2. src/background/index.ts — dispatch and the validation gate

- Walk every rejection path for `x402Pay` and `x402SignClaim`: hashLockHex (64 lowercase
  hex), refundEpoch bounds, expiresAt > now, amount > 0, claimantAddress well-formed.
  For each, ask how it fails and whether any crafted input bypasses it (unicode,
  scientific notation in the amount string, uppercase hex, negative/zero epoch,
  integer overflow in amount parsing).
- Confirm `x402Pay` executes strictly as the mapped `htlcFund` (reuse of the existing
  execution case) — no path where an approved envelope can move funds outside the
  mapped terms, and no path where approval of one kind executes the other.
- Confirm a `signed-unbroadcast` record can never be rendered or treated as a submitted
  transaction (status enum separation, popup history).
- Check the known upstream-audit fixes actually live here: `htlcFund`'s hashLockHex
  validation and the tightened refundEpoch bound (upstream deepseek audit §2 flagged
  both; this fork claims to fix them in the gate — verify, don't rediscover).

### 3. src/popup/* — approval rendering

- The "Sign only — not submitted to the network. The settlement service submits it
  later." copy is a security boundary (sign ≠ spend). Verify it is unconditional for
  `x402SignClaim`, rendered before approval is possible, and cannot be suppressed by
  envelope contents.
- The popup must show what the user is buying (resource host, human-readable amount,
  fee, refund deadline in wall-clock time). Check for fields the envelope could craft
  to spoof these (e.g., a `resourceUrl` that renders as a different host).

### 4. packages/x402-ootle/src/ — the client package

- `pay402()`/`validateQuote()`: is the shallow validation enough to prevent a malicious
  server quote from steering `x402Pay` into funding wrong terms, given the wallet
  re-validates? Identify anything the package trusts that the wallet does not
  re-check.
- v2 detection (`X402UnsupportedVersionError`): can a v2-shaped response be confused
  with a valid Ootle quote, or vice versa? (base64 that decodes to something
  quote-like; a quote that happens to carry `accepts[]`.)
- Persistence of `outputMask` + `requestId` (keyed by hashLockHex): is any code path
  able to settle or refund without the mask, or overwrite a stored record in a way
  that strands funds? The failure mode to rule out is a silent refund-path loss.
- `settle()`: what does the package leak to the facilitator (preimage, envelope), and
  does it pin `facilitatorUrl` from the quote only, or can it be redirected?
- `verifyBody()`: is the integrity check (sha256 vs `resourceSha256`) actually wired
  into the example flow, or optional-only?

### 5. docs/x402-facilitator.md — audit AS A SPEC

This is the security boundary for the (out-of-scope) indexer implementation. Audit it
for completeness and internal consistency, not prose:

- The nine-cause error contract and the validation checklist: is any validation
  missing that would let a facilitator accept a claim that steals value (e.g., is
  destination == claimantAddress enforced against the ON-CHAIN output, not the payload's
  metadata)? Is the `localDigest` idempotency airtight (can a second, different payload
  with the same digest be accepted)?
- The confidentiality rule (no preflight may see the preimage) vs the retention rule
  (`expired` is terminal, never resurrected) vs the hold-window bound (`quote.expiresAt`):
  check these compose without a gap (e.g., a payload held past refundEpoch whose
  broadcast would still be admissible on-chain).
- Cross-check the spec's ordering claims against the code in `e2e/facilitator/server.ts`
  — the stand-in is the reference implementation of the spec; any divergence is either
  a spec bug or a code bug, and you should say which.

### 6. src/lib/messages.ts, src/background/capabilities.ts, llms.txt

- Type-level consistency: the request kinds, the `signed-unbroadcast` status, and the
  `WalletCapabilities.signOnly` docs must match the spec and the code.
- Capability honesty: `signOnly: isLocal` must not overclaim (no delivery proof, no
  facilitator honesty implied).
- `llms.txt`: spot-check its safety-critical claims (strict AfterEpoch, outputMask
  load-bearing, no-preflight rule) — an agent consuming it will trust these.

### 7. e2e/ (harness) — low priority, but check two things

- The harness is dev-only, but confirm no production code path imports from it and no
  harness code ships in the extension bundle.
- The harness's funding relay (`sendPrivately` + out-of-band commitment claim) documents
  a real protocol property (private transfers are not view-key scannable); confirm the
  docs say this where a dApp developer would read it.

## Out of scope (do not spend time here)

- The upstream wallet's pre-existing surface: stealth/HTLC core, transaction building,
  account model, onboarding, the pre-existing request kinds and their execution paths
  (except where the diff touches them), `tari_getCapabilities` flags other than
  `signOnly`.
- `@chironbuilder/ootle-sdk` internals and the Ootle indexer implementation — the fork
  pins the indexer interface via `docs/x402-facilitator.md` only. State assumptions
  about each in your report instead.
- The e2e harness's Playwright plumbing beyond the two checks above.

## Known prior findings (context, not targets)

- Upstream deepseek audit §2 (low): `htlcFund` missing `hashLockHex` validation and
  loose `refundEpoch` bounding — claimed fixed in this fork's validation gate.
- SDK `verifyHtlcTerms` key-order sensitivity — claimed contained via
  `canonicalizeRelayedConditions()`; verify the containment preserves the security
  property (both leaf keys verbatim from the relayed tree).
- `AfterEpoch(N)` is strict (spendable at N+1) — live-verified; check every epoch
  comparison in the fork's code against this semantics (off-by-one here stranded a
  test run; it could strand a refund in production).
- Live e2e evidence (background, not to be re-verified): happy path claim tx
  `21257dd3cb0e…891a0b2` finalized Commit; refund tx `52a51a16ee86…ec9f1` finalized
  Commit with the facilitator frozen.

## Report format

For each finding: severity (critical/high/medium/low/informational), file and line,
a minimal exploit or counterexample sketch, and a one-line recommended fix. Explicitly
separate (a) findings in the fork's diff, (b) findings in the spec doc, (c) gaps that
belong to out-of-scope components but that this fork should document. End with the
residual-risk statement you believe the README should carry — one paragraph, honest,
no reassurance-by-omission. Do not pad; "no finding" is a valid result per section.
