# @asterius/x402-elim

Zero-dependency TypeScript client for **x402 payments over the Tari Ootle wallet
extension**: capture a facilitator's 402 quote, pay it through the injected
`window.tari` provider (with persistence + reload-resume), settle against the x402
facilitator, and verify the served body against the quote's integrity pin.

Built against the frozen spec in the host repo: [`docs/x402-facilitator.md`](../../docs/x402-facilitator.md).
The wallet flow follows [`docs/integration/transaction-requests.md`](../../docs/integration/transaction-requests.md)'s
create/get/submit reference implementation exactly.

## Install

```sh
pnpm add @asterius/x402-elim
```

Requires the Tari Ootle wallet extension to be installed for `pay`/`signClaim`
(`hasTari()` reports availability). No runtime dependencies; the wallet is detected
structurally, never imported.

## The four functions

```ts
import { pay402, pay, settle, verifyBody } from "@asterius/x402-elim";

// 1. Wrap fetch: a 402 becomes a typed X402PaymentRequired error carrying the parsed
//    quote (validated: required fields, hex formats, unexpired). Everything else
//    passes through untouched.
const f = pay402();
try {
  return await f(articleUrl);
} catch (e) {
  if (!(e instanceof X402PaymentRequired)) throw e;

  // 2. Pay: drives the wallet's create/get/submit flow with { kind: "x402Pay", ...quote },
  //    polls at `pollIntervalMs` (default 700ms), and persists {requestId, quote} to
  //    localStorage (keyed by hashLockHex) immediately after create — before the first
  //    poll — then merges in txHash (the chain transaction id), outputMask,
  //    htlcOutputCommitmentHex, conditions on success. A reload mid-approval resumes
  //    the same requestId, and an already-submitted request resolves from the
  //    wallet's stored result.
  const record = await pay(e.quote);

  // (merchant side serves the article here and signs the claim — see signClaim())

  // 3. Settle: POSTs { signedPayloadHex, quote } to facilitatorUrl + /x402/settle
  //    (idempotent on the wallet's local digest) and polls
  //    GET /x402/settlement/{localDigest} until broadcast|confirmed. On `expired`,
  //    throws X402SettlementExpired carrying outputMask + requestId so the caller
  //    can drive tari_htlcRefund — this library never auto-refunds. A record whose
  //    outputMask was never persisted fails loudly before any HTTP call.
  const result = await settle(record, signedClaim);

  // 4. Optional integrity check: sha256(body) === the quote's resourceSha256 pin.
  if (!(await verifyBody(new TextEncoder().encode(bodyText), e.quote.resourceSha256))) {
    throw new Error("body does not match the pinned hash");
  }
  return bodyText;
}
```

The merchant side's signed claim comes from the wallet's `x402SignClaim` kind; this
package ships a thin helper that polls it to the stored result:

```ts
import { signClaim } from "@asterius/x402-elim";
const signedClaim = await signClaim({
  envelope: quote,
  preimageHex,
  htlcOutputCommitmentHex: record.htlcOutputCommitmentHex,
  conditions: record.conditions,
});
```

Errors are one distinct class per rejection cause (`X402PaymentRequired`,
`X402QuoteParseError`, `X402UnsupportedVersionError`, `X402WalletError`,
`X402NoWalletError`, `X402IncompleteResultError`, `X402SettlementExpired`,
`X402MissingOutputMaskError`) — never a shared "invalid request" bucket.
Foundation x402 v2 interop (Phase A wire conformance): when a 402 carries a base64-encoded
foundation v2 `PaymentRequired`, `pay402()` decodes it and normalizes any payable Ootle entry
onto the flat envelope — an entry is payable when it has `scheme: "exact"`, the Ootle `extra`
keys (`hashLockHex`, `refundEpoch`, `facilitatorUrl`), and a recognized `paymentFlow`
(`upfront` or `escrow`). The mapping is top-level `resource.url` → `resourceUrl`;
`accepts[i].{amount,asset,payTo}` → `{amount,resourceAddress,claimantAddress}`; the Ootle
terms — including the absolute-ms `expiresAt`, which rides in `extra` and is NOT derived from
v2's relative `maxTimeoutSeconds` — map straight across. v2 adds one strictness the flat
dialect leaves to the wallet: `payTo` must be an `otl_…` address. A v2 response with no
payable entry throws `X402UnsupportedVersionError` (spec §6.1: clients skip entries they
cannot pay) instead of misreporting it as malformed; garbage that merely looks like base64
still fails as a parse error. The pure mapping is exported as `normalizeFoundationV2()` for
servers and tests that want the flat quote without a fetch.

## Integrator notes

- **Browser-only by design.** `pay()`/`loadRecord()` persist to `localStorage`
  directly and the wallet lives on `window.tari` — there is no Node/server guard,
  and both fail naturally (`localStorage` undefined, `X402NoWalletError`). Do not
  call `pay`, `signClaim`, or `settle` from server-side code. `pay402()`,
  `validateQuote`, `normalizeFoundationV2`, and `verifyBody` are runtime-neutral.
- **Always pass the integrity pin.** `verifyBody()` resolves `true` (no-op) when the
  quote carries no `resourceSha256` — that absence is a facilitator configuration
  gap, not a reason to skip the check. For paid content, treat a quote without a
  `resourceSha256` pin as suspect and gate the body on the check either way.
- **`facilitatorUrl` is server-controlled.** The quote (and therefore the URL the
  signed claim is POSTed to) comes from the 402 response header. In a browser the
  same-origin-ish threat model is ordinary; never reuse this library server-side
  without gating `facilitatorUrl` against an allowlist first.
- **Settlement confirmation is trust-based.** The facilitator reports settlement status
  (`held`/`broadcast`/`confirmed`/`expired`) and `chainTxId` as plain JSON — the client does
  not verify a facilitator signature. The safety net is wallet-side: funds sit in the HTLC
  escrow until the claim broadcasts, and `outputMask` + `requestId` are preserved so the
  caller can drive `tari_htlcRefund` once the refund epoch passes. Treat the facilitator as
  a semi-trusted party and surface settlement status to the user rather than as chain truth.

## Spec

See [`docs/x402-facilitator.md`](../../docs/x402-facilitator.md) in the host repo for
the settle/settlement endpoint contract, the `localDigest` idempotency convention
(the signed claim's `txHash` — the wallet's `localDigest` — is the SHA-256 of the
sealed BOR bytes, not a chain tx id; the funding record's `txHash` IS the chain
transaction id),
and the hold-then-broadcast settlement ordering.
