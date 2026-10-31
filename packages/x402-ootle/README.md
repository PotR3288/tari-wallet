# @potr3288/x402-ootle

Zero-dependency TypeScript client for **x402 payments over the Tari Ootle wallet
extension**: capture a facilitator's 402 quote, pay it through the injected
`window.tari` provider (with persistence + reload-resume), settle against the x402
facilitator, and verify the served body against the quote's integrity pin.

Built against the frozen spec in the host repo: [`docs/x402-facilitator.md`](../../docs/x402-facilitator.md).
The wallet flow follows [`docs/integration/transaction-requests.md`](../../docs/integration/transaction-requests.md)'s
create/get/submit reference implementation exactly.

## Install

```sh
pnpm add @potr3288/x402-ootle
```

Requires the Tari Ootle wallet extension to be installed for `pay`/`signClaim`
(`hasTari()` reports availability). No runtime dependencies; the wallet is detected
structurally, never imported.

## The four functions

```ts
import { pay402, pay, settle, verifyBody } from "@potr3288/x402-ootle";

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
import { signClaim } from "@potr3288/x402-ootle";
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
`X402UnsupportedVersionError` is thrown when a server answers with a foundation x402 v2
`PaymentRequired` (base64-encoded, `accepts[]`): the Ootle dialect is deliberately not
v2-wire-compatible, and no Ootle scheme can appear in a v2 server's `accepts[]` yet, so
the error says so instead of misreporting the header as malformed.

## Spec

See [`docs/x402-facilitator.md`](../../docs/x402-facilitator.md) in the host repo for
the settle/settlement endpoint contract, the `localDigest` idempotency convention
(the signed claim's `txHash` — the wallet's `localDigest` — is the SHA-256 of the
sealed BOR bytes, not a chain tx id; the funding record's `txHash` IS the chain
transaction id),
and the hold-then-broadcast settlement ordering.
