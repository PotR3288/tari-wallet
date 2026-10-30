# x402 facilitator stand-in (Phase 5 e2e)

A local implementation of the frozen settlement spec `docs/x402-facilitator.md`, used only by
the Phase 5 e2e harness while the real indexer-side endpoint (Task 3.2) does not exist. It is
the **reference implementation the real indexer will be measured against**: every validation
gate of the spec's checklist runs against the **real public esmeralda indexer** — reads via
`IndexerProvider` (no signing capability), signature/admissibility via the indexer's
`POST /transactions/dry-run`, broadcast via the raw `POST /transactions`
(`{ "transaction": <sealed envelope> }`) route. Nothing runs locally except the hold state.

The service never holds keys beyond the optional test view key below, and never signs
anything: broadcasting a sealed claim needs no signer (spike-5-report Q1).

## Running

```sh
npx tsx e2e/facilitator/server.ts
```

- Port: `X402_FACILITATOR_PORT` (default `4020`).
- Indexer: `X402_INDEXER_URL` (default `https://ootle-indexer-a.tari.com`).
- Network: `X402_NETWORK` (default `esmeralda`).

## Routes

| Route | Purpose |
|---|---|
| `POST /x402/settle` | Validate a signed claim into the hold. Body: `{ signedPayloadHex, quote, htlcOutputCommitmentHex, conditions, validUntilEpoch, preimageHex?, claimantViewKeyHex? }`. Idempotent on `localDigest` (SHA-256 of the sealed BOR bytes — the wallet's `txHash` field): a digest already known returns the first POST's status response without re-validating. Returns `{ localDigest, status }`. |
| `GET /x402/settlement/{localDigest}` | Poll the hold. Returns `{ status: held \| broadcast \| confirmed \| expired, txHash? }` (`txHash` = the indexer's own chain transaction id, set only once broadcast). `expired` is terminal. |
| `POST /x402/settlement/{localDigest}/broadcast` | The merchant's "confirm settle" trigger (the spec's ordering diagram; no wire name yet — this stand-in defines one). Refuses (reports `expired`) once the refund epoch has passed. |

## Validation gates → structured errors

One distinct error per rejection cause, never a shared bucket (repo house style):
`PAYLOAD_MALFORMED`, `SIGNATURE_INVALID`, `OUTPUT_MISSING`, `OUTPUT_SPENT`, `ROOT_MISMATCH`,
`PREIMAGE_MISMATCH`, `EPOCH_PASSED`, `AMOUNT_MISMATCH`, `AMOUNT_UNVERIFIABLE`, `DEST_MISMATCH`,
`QUOTE_MISMATCH` — each as `{ "error": <code>, "detail": "..." }` (HTTP 400; unknown digest
404).

Gate order follows the spec's checklist: quote shape → conditions-vs-quote binding →
`validUntilEpoch == refundEpoch − 1` → live epoch admissibility → local SHA-256 preimage →
output exists/unspent (`getStealthUtxo`: null = missing, `Down` = spent) → condition root
(`conditionRootOf(conditions)` vs `findScriptRoot(outputBody)`) → amount/destination
(`decryptOwnedUtxo` + the claimant view key) → the indexer's dry-run as the
signature/admissibility oracle → hold.

## Amount caveat (documented deviation)

The spec's checklist item 6 ("amount == quote.amount, natively, from its own index") is not
keyless-verifiable client-side: the HTLC output's value is stealth-encrypted, and decrypting
it needs the claimant's view secret — which a trustless facilitator must never hold
(spike-5-report Q2 caveat). This stand-in therefore:

- accepts an optional **test-only** `claimantViewKeyHex` in the settle request and runs
  gates 6/7 (`AMOUNT_MISMATCH` / `DEST_MISMATCH`) via the real `decryptOwnedUtxo`;
- **fails closed** with `AMOUNT_UNVERIFIABLE` when it is absent — never a silent pass.

Two more test-only deviations, both documented in `server.ts`'s header:
`preimageHex` (the sealed envelope cannot be deserialized client-side — no exported SDK
decoder — so the local SHA-256 gate takes the preimage out of band, at settle time only) and
the relayed `validUntilEpoch`. The real indexer closes all three natively from its own index.

## Tests

Unit tests only, no live indexer calls (a fake `FacilitatorChain`; the real wasm builds the
condition tree and its root). The root `pnpm test` / `vitest.config.ts` are frozen to
`src/**/*.test.ts`, so run this suite with its sibling config:

```sh
npx vitest run --config e2e/facilitator/vitest.config.ts
```