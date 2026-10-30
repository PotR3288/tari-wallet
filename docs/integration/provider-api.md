# Provider API Reference

Every method is called the same way: `window.tari.request({ method, params })`. Methods marked
**approval** pop the wallet's own confirmation window and wait on the human; everything else
resolves immediately (subject to the account being connected/unlocked).

## Connection

| Method | Params | Returns | Notes |
|---|---|---|---|
| `tari_requestAccounts` | none | `string[]` | **Approval** the first time per origin; a no-op afterward. |
| `tari_getAccounts` | none | `string[]` | Already-connected accounts for this origin, `[]` if none. |
| `tari_disconnect` | none | `null` | Drops this origin's connection. |
| `tari_getNetwork` | none | `"esmeralda" \| "igor"` | Never touches activity/auto-lock — safe to poll. |
| `tari_getWalletAddress` | none | `string` | The connected account's **bech32m wallet address** — what you address a stealth (private) output to. Not the same value as, nor derivable from, the component address `tari_requestAccounts` returns. |

`tari_getWalletAddress` is what a dApp needs to pay the user *privately* — a stealth output's
`destination` decodes as this address, never as a component address. It carries only public keys
(owner + view), so anyone holding it can pay this account privately and no one can read its
payments; it needs a connection, not view access.

## Reading state

| Method | Params | Returns | Notes |
|---|---|---|---|
| `tari_getBalances` | none | `DappTokenBalance[]` | See shape below. Requires a connected, unlocked account. The confidential half is withheld without view access. |
| `tari_getSubstate` | `{ substateId, version? }` | raw `Substate` | General-purpose; not tied to the connected account. |
| `tari_getCapabilities` | none | `WalletCapabilities` | See shape below. Reflects the *connected account*, not just the codebase. |
| `tari_getTransactionResult` | `{ transactionId }` | indexer result | Look up a past transaction's on-chain result by id. |

```ts
interface DappTokenBalance {
  resourceAddress: string;
  kind: string; // "Fungible" | "NonFungible" | "Confidential" | "Stealth"
  amount: string;             // plain, public (revealed) amount
  confidentialAmount: string; // "0" unless privateVisible is true -- see below
  privateVisible: boolean;    // whether confidentialAmount is real or withheld
  divisibility: number;       // real on-chain Resource.divisibility, e.g. 6 for XTR
  symbol: string | null;      // Resource.metadata.SYMBOL, if set
  name: string | null;        // Resource.metadata.name, if set
}

interface WalletCapabilities {
  exactInputSelection: boolean;      // always true today
  stealthWithdraw: boolean;          // withdrawStealthAndExecute -- local accounts only
  stealthRedeem: boolean;            // redeemStealthOutputAndExecute -- local accounts only
  stealthRedeemPrivateFee: boolean;  // redeemStealthOutputWithPrivateFee -- local accounts only
  htlcFund: boolean;                 // htlcFund -- local accounts only
  scriptPathSpend: boolean;           // htlcClaim / htlcRefund -- local accounts only
  signOnly: boolean;                  // x402SignClaim (sign + seal, never broadcast; the settlement facilitator submits) -- local accounts only
  privateSpend: boolean;             // unshield / sendPrivately -- local AND daemon-relayed accounts
  shieldFunds: boolean;              // shield -- local AND daemon-relayed accounts
  privateBalanceView: boolean;       // tari_getPrivateBalances / tari_getShieldedOutputs -- both account kinds
  privateScan: boolean;              // tari_scanForPrivatePayments / tari_scanForResourceUtxos / tari_claimPrivatePayment -- local accounts only
  privateViewGranted: boolean;       // has *this site* been granted view access
  transactionResultLookup: boolean;  // always true today
  transactionRequests: boolean;      // create/approve/submit flow -- always true today
  walletAddress: boolean;            // tari_getWalletAddress -- always true today
  minimumValuePromise: boolean;      // proof-of-funds outputs on shield/sendPrivately -- local accounts only
  ownershipProof: boolean;           // tari_signOwnershipChallenge -- local accounts only
  walletOwnershipProof: boolean;     // tari_signWalletOwnershipChallenge -- local accounts only
  confidentialDeposit: boolean;      // depositConfidential -- local accounts only
  supportsPrivateFees: boolean;      // feeType: "private" on a transaction request -- local accounts only
  dryRunIsLocal: boolean;            // always false today -- dry runs round-trip to the indexer
}
```

A daemon-relayed account (connected to a running `tari_ootle_walletd` rather than holding its own
seed) can perform a growing but still partial subset of the private surface: it can create new
stealth outputs (`shieldFunds`) and spend existing ones (`privateSpend`, covering `unshield` and
`sendPrivately`), and read its own private balances (`privateBalanceView`) -- all done server-side
by the daemon, which holds the view secret and signing keys this extension never sees. Everything
else marked "local accounts only" above genuinely needs the account's own key material inside the
browser and has no daemon-relayed equivalent yet. Always branch on the specific capability flag,
never on "is this a daemon account" -- the split changes as daemon support grows.

> **`confidentialAmount: "0"` is not a balance.** Without view access the field is withheld, not
> measured. Always branch on `privateVisible` first — treating a withheld value as "this account
> holds nothing privately" is the one mistake this shape exists to prevent.

## Private view access

Connecting reveals one public component address. Reading the user's **private** balance — the
amounts held in stealth outputs, which nothing else on-chain can see — is a separate ask with its
own prompt, and it is read-only: it never authorizes a spend.

| Method | Params | Returns | Notes |
|---|---|---|---|
| `tari_requestViewAccess` | none | `{ granted: boolean }` | **Approval**. Resolves `{ granted: false }` on refusal rather than throwing. No-op (no prompt) if already granted. Requires an existing connection. |
| `tari_getViewAccess` | none | `{ granted: boolean }` | Never prompts. |
| `tari_revokeViewAccess` | none | `null` | Gives the grant up voluntarily. Idempotent; never prompts. |

The grant is bound to the connection, so it is dropped by any of: `tari_disconnect`, the user
disconnecting the site, the user switching the active account (which drops every connection), or
the user revoking it from **Connected sites** while leaving the site connected. Re-approving a
connection does **not** restore it. Call `tari_getViewAccess` (or read
`capabilities.privateViewGranted`) rather than assuming a grant from earlier in the session still
holds.

`capabilities.privateBalanceView` is true for both a seed-derived local account and a
daemon-relayed one — the daemon serves `tari_getPrivateBalances`/`tari_getShieldedOutputs` from its
own server-side view-key access, never handing that key to this extension. It is
`capabilities.privateScan` that stays local-only (see below): trial-decrypting *candidate* incoming
payments and producing a claim's ownership proof both need the view secret client-side, which a
daemon-relayed account never has. Check the specific flag you need before offering the prompt, so a
user on an account missing it gets an explanation instead of a dead end.

## Reading private state

All four require the view grant above. `tari_getPrivateBalances`/`tari_getShieldedOutputs` work for
both a seed-derived local account and a daemon-relayed one (`capabilities.privateBalanceView`);
`tari_scanForPrivatePayments`/`tari_claimPrivatePayment` need a seed-derived local account
(`capabilities.privateScan`). Without the grant, all four throw `"This site doesn't have private
view access. Call tari_requestViewAccess first."`

| Method | Params | Returns | Notes |
|---|---|---|---|
| `tari_getPrivateBalances` | none | `PrivateBalance[]` | Per-resource totals over the account's unspent stealth outputs. |
| `tari_getShieldedOutputs` | `{ resourceAddress? }` | `ShieldedOutputSummary[]` | The individual UTXOs behind those totals, newest first. |
| `tari_scanForPrivatePayments` | `{ maxPages? }` | `{ claimed, found }` | View-key scan for incoming payments. Real network cost — user-initiated refresh, not a poll. Local accounts only. |
| `tari_claimPrivatePayment` | `{ resourceAddress, commitment }` | `{ amount, memo? }` | Claims a payment by commitment shared out of band. Local bookkeeping only — submits nothing. Local accounts only. |

```ts
interface PrivateBalance {
  resourceAddress: string;
  amount: string;       // total unspent shielded value, raw resource-native units
  outputCount: number;  // how many outputs make it up -- each is spent whole
  divisibility: number;
  symbol: string | null;
  name: string | null;
}

interface ShieldedOutputSummary {
  resourceAddress: string;
  commitment: string;    // 32-byte Pedersen commitment, hex (public on-chain data)
  amount: string;
  transactionId: string;
  createdAt: number;
  memo?: string;
}
```

`tari_getPrivateBalances` is the authoritative "what can I spend privately right now" number: it is
exactly the set of outputs the wallet's own coin selection draws from. It differs from
`DappTokenBalance.confidentialAmount` on purpose — that one also folds in a Confidential *vault*'s
decrypted commitments, whereas this counts the freestanding `utxo_{resource}_{commitment}` substates
a shield or private send actually creates. A resource can have a real private balance and no
on-chain vault at all.

None of these ever expose a blinding mask or the view secret. A site with view access can see
**what** the account holds privately; it can never derive the material to spend it, and it cannot
read payments addressed to anyone else.

## Submitting transactions

Prefer the create/approve/submit trio for anything new — see
[Transaction Requests](transaction-requests.md) for the full flow, polling pattern, and why it's
worth adopting over the single-call methods below.

| Method | Params | Returns | Notes |
|---|---|---|---|
| `tari_createTransactionRequest` | `TransactionRequestOperation` | `{ requestId }` | **Approval** (opens the popup, doesn't block on it). |
| `tari_getTransactionRequest` | `{ requestId }` | `TransactionRequestSummary` | Poll this until `status !== "pending"`. Works after a reload. |
| `tari_submitTransactionRequest` | `{ requestId }` | the operation's result | Throws unless `status === "approved"`. Submission is claimed atomically — racing/duplicate submits over one request are safe: exactly one executes, the rest throw. |

```ts
type TransactionRequestOperation =
  | { kind: "instructions"; instructions: Instruction[]; maxFee?: string; inputs?: SubstateRequirement[] }
  | {
      kind: "withdrawStealthAndExecute";
      resourceAddress: string;
      amount: string;
      workspaceVarName: string;
      followUpInstructions: Instruction[];
      relatedComponents?: string[];
      maxFee?: string;
    }
  | {
      kind: "htlcFund";
      resourceAddress: string;
      amount: string;
      claimantWalletAddress: string;
      hashLockHex: string;
      refundEpoch: string;
      maxFee?: string;
    }
  // ---- Private spends (capabilities.privateSpend / capabilities.scriptPathSpend) ----
  | { kind: "shield"; resourceAddress: string; amount: string; maxFee?: string; memo?: string;
      minimumValuePromise?: string }                    // see "Proof of funds" below
  | { kind: "unshield"; resourceAddress: string; revealedAmount: string; maxFee?: string; memo?: string }
  | {
      kind: "sendPrivately";
      resourceAddress: string;
      recipientWalletAddress: string;
      amount: string;
      maxFee?: string;
      memo?: string;
      minimumValuePromise?: string;                     // applies to the recipient's output
    }
  | {
      kind: "htlcClaim";
      resourceAddress: string;
      commitment: string;
      conditions: object[];
      preimageHex: string;
      maxFee?: string;
    }
  | {
      kind: "htlcRefund";
      resourceAddress: string;
      commitment: string;
      conditions: object[];
      amount: string;
      outputMask: string;
      maxFee?: string;
    };

interface TransactionRequestSummary {
  requestId: string;
  status: "pending" | "approved" | "submitting" | "submitted" | "signed-unbroadcast" | "rejected" | "failed";
  note: string;       // human-readable summary, the same text shown on the popup
  createdAt: number;
  expiresAt: number;
  result?: unknown;   // set once status === "submitted" | "signed-unbroadcast"
  error?: string;     // set once status === "rejected" | "failed"
}
```

`"submitting"` is a transient state the wallet claims atomically at submit time (before the
operation executes). Treat it like `"submitted"`-in-progress: keep polling until it resolves to
`"submitted"` or `"failed"`. It only sticks if the wallet's service worker died mid-submission, in
which case the request is permanently unresubmittable — re-create it instead.

**Fee type.** Every kind above except `redeemStealthOutputWithPrivateFee` (already always private)
also takes an optional `feeType: "private" | "transparent"` hint and `enforceFeeType?: boolean`.
Unenforced, it's only a hint — the approval popup shows a toggle seeded from it (or the wallet's
own default) that the user can still change. `enforceFeeType: true` requires `feeType` and locks
the popup's toggle to it. `"private"` needs `capabilities.supportsPrivateFees` (seed-derived local
accounts only) and pays the fee from a separate stealth XTR UTXO.

### Private spends

The six kinds that move value in or out of, or between, stealth outputs (`htlcFund` included -- it is listed again here because it is one of them, not only a deprecated single-call method). Each goes through the
same create → approval → submit flow as any other transaction; the approval screen shows a
plain-language note describing which direction value moves and whether it becomes publicly visible.

| Kind | Moves | Result | Daemon-relayed account |
|---|---|---|---|
| `shield` | public → private, same account | `{ transactionId, commitment, substateId, minimumValuePromise }` | Yes (`capabilities.shieldFunds`) |
| `unshield` | private → public, same account | `{ transactionId }` | Yes (`capabilities.privateSpend`) |
| `sendPrivately` | private → private, to another wallet address | `{ transactionId, recipientCommitment, recipientSubstateId, minimumValuePromise }` | Yes (`capabilities.privateSpend`), but only with `minimumValuePromise: "0"` (the default) — see note below |
| `htlcFund` | public → HTLC-locked private output | `{ transactionId, conditions, ownCommitment, outputMask }` | No (`capabilities.htlcFund`) |
| `htlcClaim` | HTLC-locked → your private balance (reveals the preimage) | `{ transactionId }` | No (`capabilities.scriptPathSpend`) |
| `htlcRefund` | HTLC you funded → back to your private balance (after `refundEpoch`) | `{ transactionId }` | No (`capabilities.scriptPathSpend`) |

Notes that matter for getting these right:

- **You cannot build a stealth transfer yourself.** A raw `StealthTransfer` instruction passed as
  `{ kind: "instructions" }` is rejected outright — it needs a balance proof and per-input one-time
  authorizations only the wallet's signer can produce. These kinds exist precisely so you can ask
  for one without ever holding the material to make one.
- **You don't choose which UTXOs get spent.** Coin selection (largest-first, across multiple
  outputs where needed) is the wallet's own decision from its local ledger. You supply an amount.
- **`sendPrivately`'s `recipientCommitment` must reach the recipient out of band.** There is no
  scan-by-view-key API for a specific counterparty, so a payment whose commitment you drop is
  invisible to them even though it succeeded on-chain. They redeem it with
  `tari_claimPrivatePayment`.
- **`htlcRefund` needs `amount` and `outputMask` exactly as `htlcFund` returned them.** The output
  is addressed to the *claimant*, so the funder cannot decrypt it and has no other route back to
  those values. Persist them at funding time.
- **`htlcClaim`/`htlcRefund` need the full `conditions` tree** the funding side produced. Only its
  root is committed on-chain, so it cannot be recovered from the chain alone — pass it through
  unchanged.
- `shield`, `unshield`, and `sendPrivately` (with `minimumValuePromise: "0"`, the default) also work
  for a daemon-relayed account — the daemon builds and signs the stealth statement server-side, via
  its own `accounts.stealth_transfer`/`accounts.create_stealth_transfer_statement` RPCs, so this
  extension never needs the view secret client-side for them. `htlcFund`/`htlcClaim`/`htlcRefund`
  do not: they need `capabilities.htlcFund`/`scriptPathSpend`, which stay local-account-only, since
  building a `PayTo::Conditions` output witness (or spending one) is done entirely client-side.
  Check the specific kind's capability flag (see the table above), not a blanket "is this account
  local" test.
- **`sendPrivately`'s `minimumValuePromise` is local-accounts-only, even though the rest of the
  kind isn't.** A nonzero promise partially reveals the *recipient's* output, which needs depositing
  the revealed portion into their own account component — not yet built for a daemon-relayed
  account. It throws a clear error rather than silently ignoring the value; pass `"0"` (or omit it)
  against a daemon-relayed account.
- A daemon-relayed account cannot pay any of these six privately either way —
  `capabilities.supportsPrivateFees` is false for one, so `feeType: "private"` on any of them
  (or on `enforceFeeType: true`) throws. Use `feeType: "transparent"` (the default) against one.
- Private view access is **not** required for any of them, and holding it does **not** waive the
  per-transaction approval. Reads and spends are separate permissions in both directions.

### Proof of funds

`shield` and `sendPrivately` accept a `minimumValuePromise` — a public claim, committed into the new
output's own range proof, that it is worth **at least** that much (raw resource units, decimal
string; omitted or `"0"` means no claim).

A confidential output normally proves `0 ≤ v < 2^64`, hiding `v` completely. With a promise `m` the
proof instead attests `m ≤ v < 2^64`, and `m` is stored in the clear as the output's
`minimum_value_promise`. The output becomes a self-contained proof of funds.

```js
// Prove this wallet can cover 100000, without revealing what it actually holds.
const { requestId } = await tari.request({ method: "tari_createTransactionRequest", params: {
  kind: "shield", resourceAddress, amount: "100000", minimumValuePromise: "100000",
}});
// ...poll until approved, then submit. The result carries `substateId` — the proof artifact.

// Anyone verifies it with no cooperation from the wallet, no signature, no live session:
const substate = await tari.request({ method: "tari_getSubstate", params: { substateId } });
// -> read `minimum_value_promise` off the output, and that the substate is still unspent.
```

Three properties to design around:

1. **Non-interactive and permanent, in both directions.** A verifier needs nothing from the prover.
   Equally, the disclosure is permanent and visible to *everyone*, not only to whoever the proof was
   made for. Shielding is how value stops being publicly visible; a promise puts a floor back on
   public view for the life of the output. The approval screen states this outright; your UI should
   too.
2. **It proves one output, not a balance.** "This output is worth ≥ m", not "this account holds
   ≥ m". To prove total spending power, shield the whole amount into a single output and promise
   against that — `tari_getPrivateBalances`' `outputCount` shows how funds are currently split.
3. **Spending the output destroys the proof.** Correct semantics — a proof of funds *should* stop
   verifying once the funds move — but a verifier must re-check the substate is still unspent at the
   moment they care, not merely that it once existed. Anything built on this should carry its own
   expiry and re-verify at view time.

`minimumValuePromise` must not exceed the output's own `amount`: a range proof asserting "at least
m" is impossible for an output actually worth less, and is refused client-side before anything is
signed.

On `sendPrivately` the promise applies to the **recipient's** output only, never your change —
putting one on change would publish a floor on your own remaining private balance.

### Deprecated single-call methods

Still fully supported — implemented as thin wrappers over the create/submit primitives above, so
existing integrations keep working unchanged. New integrations should prefer the trio above.

| Method | Params | Returns | Equivalent to |
|---|---|---|---|
| `tari_signAndSubmitTransaction` | `{ instructions, maxFee?, dryRun?, inputs? }` | execution result | `{ kind: "instructions", ... }` (or a direct dry-run call, unaffected either way) |
| `tari_withdrawStealthAndExecute` | `{ resourceAddress, amount, workspaceVarName, followUpInstructions, relatedComponents?, maxFee? }` | execution result | `{ kind: "withdrawStealthAndExecute", ... }` |
| `tari_htlcFund` | `{ resourceAddress, amount, claimantWalletAddress, hashLockHex, refundEpoch, maxFee? }` | `{ transactionId, conditions, ownCommitment, outputMask }` | `{ kind: "htlcFund", ... }` |

The private-spend kinds have deliberately **no** single-call equivalents — they are new, and the
create/submit trio is the shape new methods get. A private spend is also the case where the
deprecated shape hurts most: it blocks the page for a whole approval-plus-submit round trip and
loses the result outright if the page reloads, which for a `sendPrivately` means losing the
`recipientCommitment` the recipient needs to ever see the payment.

`tari_signAndSubmitTransaction`'s `dryRun: true` path is a **direct, synchronous call** in every
case — it never needed approval, and never goes through the request-tracking system at all,
regardless of which method you use for the real submission afterward.

## Events

| Event | Detail | Fires when |
|---|---|---|
| `tari#initialized` | none | The provider has finished injecting — listen for this if `window.tari` isn't present yet at your load time. |
| `tari#accountsChanged` | `[]` | The wallet drops this page's connection out from under it (e.g. the user switched accounts). Treat as a signal to re-run `tari_requestAccounts`, not as carrying the new account list. |
