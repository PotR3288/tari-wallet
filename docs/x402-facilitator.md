# x402 Facilitator Settlement Interface

This is the spec for the settlement endpoint an ootle indexer exposes to act as the **x402
facilitator** for Tari Ootle payments — the indexer-side counterpart to the wallet's
`x402Pay` / `x402SignClaim` transaction-request kinds (see `src/lib/messages.ts` and
`docs/integration/transaction-requests.md`).

## Overview

The indexer is already the component that indexes every transaction and serves balance
reads; the settlement endpoint is a thin addition to that existing surface, not a new
service. An `x402` purchase is an HTLC-locked stealth output funded by the paying wallet
(`x402Pay`, which executes as an `htlcFund`) and claimed by the merchant's wallet
(`x402SignClaim`, which builds, signs and seals the claim **without broadcasting it**).
The merchant's wallet hands the sealed payload to the indexer's settle endpoint; the
indexer validates it and broadcasts it at settle time.

Trust posture: the settlement payload is **not opaque** to the indexer. It is a sealed
BOR transaction the indexer parses natively, and every claim in it — signature, spent
output, amounts, epochs, condition root — is checked against the indexer's **own chain
index**. There is no separate facilitator-facing verify-spec: this document is the whole
contract.

## Settlement ordering

Three orderings were candidates for *when the claim transaction actually hits the chain*.
Two were rejected; the third is the spec.

**Broadcast-immediately — rejected.** If the merchant's wallet broadcast the claim itself
(`htlcClaim`-style), the payment would be settled before the resource is served. Once the
claim is on-chain, the merchant owns the funds regardless of whether delivery ever
happens — the exact "paid but not served" hole EIP-3009-style pull payments have: the
irreversible chain event precedes the reversible HTTP event, and the client has no
recourse. The HTLC's time-locked refund only helps the client while the claim is *not*
yet broadcast.

**Client-receipt-triggered — rejected.** If broadcast waited for a confirmation from the
client (e.g. "I received the 200"), the client gets a free-serve option: consume the
resource, never send the confirmation, let the refund epoch pass the claim's admissibility
window, and refund itself. The merchant served and cannot collect.

**Merchant-initiated hold-then-broadcast — chosen.**

```
client wallet            merchant                indexer (facilitator)
    │  x402Pay (funds the HTLC)  │                        │
    │───────────────────────────▶│                        │
    │   relays htlcOutputCommitmentHex + conditions       │
    │                            │ verify funding on its │
    │                            │ own index             │
    │                            │ POST /x402/settle     │
    │                            │──────────────────────▶│ validate + HOLD
    │                            │      {status:"held"}  │
    │◀──────── serve resource ───│◀──────────────────────│ (nothing on-chain yet)
    │                            │ merchant confirms settle
    │                            │──────────────────────▶│ broadcast
    │                            │    {status:"broadcast", chainTxId}
```

The merchant verifies funding on its own index (it can read the HTLC output's existence
and its condition root from the chain too), then POSTs the signed claim to the indexer.
The indexer validates it and **holds** it — nothing is on-chain yet. The merchant serves
the resource, then confirms settle; the indexer broadcasts.

The hold window is what gives the HTLC its point:

- The **client** can abort before the merchant settles: while the payload is held, the
  client can still issue `htlcRefund`-side recovery once `refundEpoch` passes — the claim
  has not touched the chain, so the refund path is intact.
- If the merchant **never settles**, the refund epoch returns the funds to the client
  automatically. No one has to do anything.

What the HTLC does *not* do: prove delivery. HTTP delivery cannot be proven to the
payment layer — the indexer never sees the resource, the client's HTTP stack, or the 200.
So the residual risk is stated plainly: **the merchant can sign a claim, get it held, and
not serve.** That is the same residual risk as ETH x402's "paid but no 200" — an
irreversible payment event with an unprovable delivery step. The HTLC's job here is
client-side abort + automatic refund, not delivery proof.

The hold is also bounded by the quote, not just the chain: the indexer must not hold a
payload past `quote.expiresAt` (the quote's own wall-clock expiry, ms since epoch) even
if `refundEpoch` is still in the future. A quote whose `expiresAt` has lapsed is a stale
quote; the client should have a fresh one, and the indexer should not keep settlement
state alive for it.

## Endpoints

### `POST /x402/settle`

Body:

```json
{
  "signedPayloadHex": "<the sealed, BOR-encoded claim transaction, lowercase hex —
                        exactly what the wallet's X402SignedClaimPayload.signedPayloadHex
                        hands back>",
  "quote": { "...the x402Pay envelope fields the paying wallet funded..." }
}
```

The `quote` object is the `X402PayTerms` envelope verbatim:

| Field | Type | Notes |
|---|---|---|
| `resourceUrl` | string | What was bought. |
| `resourceSha256?` | string (64 hex) | Optional integrity pin for the served response. |
| `amount` | string | Raw integer base units. |
| `resourceAddress` | string | The payment token (XTR). |
| `claimantAddress` | string | Merchant's otl_… wallet address — the HTLC claimant. |
| `hashLockHex` | string | SHA-256 of the claim secret, exactly 64 lowercase hex. |
| `refundEpoch` | number | HTLC refund leaf epoch (chain epoch). |
| `facilitatorUrl` | string | This settle endpoint's URL. |
| `facilitatorPubKeyHex?` | string | Optional pin of the indexer's identity public key. |
| `expiresAt` | number | Quote expiry, ms since epoch. |
| `maxFee?` | string | Max claim fee, raw base units. |

**Idempotency: `localDigest`.** The wallet's `X402SignedClaimPayload` carries a field the
wallet names `txHash` — but it is **not** a chain transaction id. It is a locally
computed SHA-256 of the sealed envelope's BOR bytes (64 lowercase hex; see
`finalizeSignedClaim` in `src/background/x402SignOnly.ts`), used for receipt matching and
idempotency. To avoid conflation, the wire name for it in this interface is
`localDigest`. A `POST /x402/settle` with a `localDigest` already known to the indexer
MUST return the same status response as the first POST, not re-validate or re-broadcast.
The indexer's own post-broadcast chain transaction id is a separate field, `chainTxId`,
and only exists once the indexer has broadcast.

Response:

```json
{ "status": "held" | "broadcast" | "confirmed", "chainTxId?": "<the indexer's own tx id>" }
```

- `held` — payload validated, stored, nothing on-chain yet.
- `broadcast` — the claim transaction is in flight; `chainTxId` is set.
- `confirmed` — the claim is in a block; `chainTxId` is set.

### `GET /x402/settlement/{localDigest}`

```json
{ "status": "held" | "broadcast" | "confirmed" | "expired", "chainTxId?": "<tx id>" }
```

- `expired` — the payload was held, `refundEpoch` passed without a broadcast, and the
  indexer has given up on it. The client/wallet at this point executes its refund path
  (`htlcRefund`); the claim payload is dead and the indexer must never broadcast it.

### Retention

Held payloads are garbage-collected at `refundEpoch` + a small grace window (the grace
exists because the chain's view of "what epoch is it" can lag; the exact value is a
deployment choice). `expired` is a stable terminal answer: once reported, a payload is
never resurrected. Held payloads are also bounded by `quote.expiresAt` — see the ordering
section; a payload whose quote has lapsed is not valid settlement state even before the
refund epoch passes.

### Error contract

Structured errors — one distinct error per rejection cause, never a shared "invalid
request" bucket — mirroring the wallet's own house rule (`src/background/x402.ts`:
"each failure throws its OWN distinct, actionable error ... so a facilitator can tell
'ask for a fresh quote' apart from 'your hashlock encoding is wrong' instead of retrying
blind"). At minimum, each of these is its own distinguishable error:

| Rejection cause |
|---|
| Malformed payload (does not parse as a BOR transaction) |
| Signature invalid against the claimant key |
| HTLC output missing (never funded) or already spent |
| Condition root mismatch: the relayed conditions' Merkle root disagrees with the on-chain root, or the root is not bound to `quote.hashLockHex` |
| Preimage-hash mismatch: the revealed preimage does not hash to `hashLockHex` |
| Past `refundEpoch` — the claim is no longer admissible |
| Amount mismatch: output value ≠ `quote.amount` |
| Payee mismatch: output destination ≠ `quote.claimantAddress` |
| Unknown facilitator: `quote.facilitatorUrl` / `facilitatorPubKeyHex` does not match this indexer's identity |

## Validation checklist

Before accepting a payload into `held`, the indexer MUST verify each of these
**natively, from its own index** — no trust in the merchant's claims about the chain:

1. **Payload parses.** `signedPayloadHex` is valid hex and decodes as a sealed BOR
   transaction.
2. **Signature valid** against the claimant key — the claim leaf's `AccessRule` badge is
   satisfied by the signer's normal transaction signature; the signer must be (a key
   belonging to) `quote.claimantAddress`.
3. **HTLC output exists and is unspent**, at the commitment the payer relayed
   (`htlcOutputCommitmentHex` in the wallet's shape). The commitment and the two-leaf
   condition tree are relayed out of band by the paying wallet's `x402Pay` result —
   **only the condition root is on-chain**; the claim needs the leaf + Merkle siblings,
   which is why every settle shape carries the pair.
4. **Condition root agrees three ways**: the relayed conditions' Merkle root equals the
   on-chain root on the output, and the root is bound to `quote.hashLockHex` (the claim
   leaf's `HashLock` atom).
5. **Preimage hashes to the hashlock**: SHA-256 of the revealed preimage == `quote.hashLockHex`.
6. **Output amount == `quote.amount`** (raw base units, exact).
7. **Destination == `quote.claimantAddress`** — the claim spends the output into the
   claimant's own fresh stealth output; the claimant key from (2) must be the quote's
   payee.
8. **`refundEpoch` is in the future** at validation time (the indexer knows the current
   epoch — it indexes every block).
9. **The `validUntilEpoch = refundEpoch − 1` convention is respected.** The claim leaf is
   `BeforeEpoch(refundEpoch)`, so the last epoch at which the claim is admissible is
   `refundEpoch − 1`. The wallet's payload echoes `validUntilEpoch` under exactly this
   convention (`refundEpoch - 1`, never anything else); the indexer must not broadcast at
   or after `refundEpoch + 1`, at which point the payer can refund instead. If the
   payload's `validUntilEpoch` is anything but `refundEpoch − 1`, reject it — it did not
   come from the wallet's build path.

The relayed commitment/conditions pair (`htlcOutputCommitmentHex` + `conditions`) appears
in **every** settle shape — it is the wallet's own claim pipeline's required input and
cannot be recovered from the chain alone, so the indexer should treat its presence and
its consistency with the payload as part of shape validation, not an optional extra.

## Confidentiality note

The preimage is inside the sealed payload and reaches the indexer **only at settle time**.
The indexer must not require it — or anything derived from it — at any earlier point:
no quote stage, no funding-verification stage, no dry-run/preflight stage. The wallet's
build path (`src/background/x402SignOnly.ts`) deliberately never dry-runs and never
preflights precisely because the SDK's claim path would otherwise POST the fully-signed
transaction, preimage included, to the indexer before settle — and the preimage is the
merchant's proof of payment. An indexer implementation that adds a "validate early"
endpoint accepting the preimage before settle violates this spec.

## Scope note

v1 target deployment: the ootle indexer default at `https://ootle-indexer-a.tari.com/`
(esmeralda), or any self-hosted instance of the same code. The endpoint is specified so
that **any** ootle-indexer deployment can opt in — enabling settlement is a deployment
decision, not a fork of the indexer. The private-fee claim lane (a claim whose
transaction fee is paid from a stealth UTXO, keeping the merchant's address entirely off
the claim) is future work: it needs a small SDK-side export of the envelope builder
(`buildHtlcSpendEnvelope`), at which point this doc's settle shapes gain an optional
fee-privacy marker; until then the v1 claim is transparent-fee only.
