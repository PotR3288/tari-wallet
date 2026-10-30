// Shared message shapes for the three extension contexts:
//   injected page script <-> content script <-> background service worker
// and separately: popup UI <-> background service worker.
import type { Instruction, SubstateRequirement } from "@tari-project/ootle-ts-bindings";

// ---- Page (window.tari) <-> content script <-> background ----

export type ProviderMethod =
  | "tari_requestAccounts"
  | "tari_getAccounts"
  | "tari_getNetwork"
  | "tari_getWalletAddress"
  | "tari_getBalances"
  | "tari_getSubstate"
  | "tari_getCapabilities"
  | "tari_getTransactionResult"
  | "tari_signAndSubmitTransaction"
  | "tari_withdrawStealthAndExecute"
  | "tari_htlcFund"
  | "tari_createTransactionRequest"
  | "tari_getTransactionRequest"
  | "tari_submitTransactionRequest"
  // ---- Private view access (see `ConnectedSite.viewAccessGrantedAt` in storage.ts) ----
  | "tari_requestViewAccess"
  | "tari_getViewAccess"
  | "tari_revokeViewAccess"
  // ---- Confidential reads, all gated on the grant above ----
  | "tari_getPrivateBalances"
  | "tari_getShieldedOutputs"
  | "tari_scanForPrivatePayments"
  | "tari_scanForResourceUtxos"
  | "tari_scanForOwnedUtxos"
  | "tari_claimPrivatePayment"
  // ---- Ownership proof (spends nothing; local accounts only) ----
  | "tari_signOwnershipChallenge"
  | "tari_signWalletOwnershipChallenge"
  | "tari_disconnect";

/**
 * The x402 payment-terms envelope: what an x402 facilitator (indexer) quotes for one HTTP
 * resource. Declared once as its own interface because TWO kinds carry it: `x402Pay` (the paying
 * wallet funds it, executing as an `htlcFund` -- the same HTLC-locked stealth output, built by the
 * same internal path in background/index.ts, a thin mapping of these fields onto `htlcFund`'s
 * with no duplicated builder logic) and `x402SignClaim` (the merchant's wallet settles the exact
 * same quote by signing -- never broadcasting -- the HTLC claim). One declaration, so the two
 * sides cannot drift apart.
 */
export interface X402PayTerms {
  /** WHAT the user is buying -- shown on the approval popup, the only place they see it. */
  resourceUrl: string;
  /** Optional integrity pin for the served response, lowercase-or-mixed 64-hex SHA-256. */
  resourceSha256?: string;
  /** Price, raw integer base units (no decimals/scientific notation). */
  amount: string;
  /** The payment token (XTR = TARI_RESOURCE_ADDRESS). */
  resourceAddress: string;
  /** The merchant's wallet address -- becomes the HTLC output's claimant. */
  claimantAddress: string;
  /** SHA-256 of the claim secret, exactly 64 lowercase hex characters. */
  hashLockHex: string;
  /** HTLC refund leaf epoch (a chain epoch; see background/index.ts's x402 validation gate). */
  refundEpoch: number;
  /** The indexer's settle endpoint, where the payment is settled. */
  facilitatorUrl: string;
  /** Optional pin of the indexer's identity public key (the envelope carries it). */
  facilitatorPubKeyHex?: string;
  /** Quote expiry, ms since epoch. */
  expiresAt: number;
  maxFee?: string;
}

/**
 * `x402SignClaim`'s result -- the signed-unbroadcast claim, everything the indexer facilitator
 * needs to validate and (at settle) broadcast, without re-deriving anything. Produced by
 * background/x402SignOnly.ts; the wallet itself never submits this transaction.
 */
export interface X402SignedClaimPayload {
  /** The sealed, BOR-encoded transaction envelope, hex -- the artifact to POST to the
   * facilitator's settle endpoint. (`sealTransaction` emits BOR bytes as base64; the wallet
   * re-encodes to hex so every field of this result is lowercase hex, as the field name
   * promises and the facilitator spec expects.) */
  signedPayloadHex: string;
  /** SHA-256 of the sealed envelope's BOR bytes, 64 lowercase hex -- a locally-computed
   * digest for receipt matching and idempotency, NOT the chain's transaction id (which only
   * exists once the facilitator broadcasts; the indexer derives its own). */
  txHash: string;
  /** The HTLC output this claim spends (its commitment, 64 lowercase hex) -- the facilitator
   * validates this output against the quote. */
  htlcOutputCommitment: string;
  /** The quote's refund epoch, echoed from the envelope. */
  refundEpoch: number;
  /** The LAST chain epoch at which the claim path is still admissible: the claim leaf is
   * `BeforeEpoch(refundEpoch)`, so this is `refundEpoch - 1`. The facilitator must not
   * broadcast at/after `refundEpoch + 1`; at that point the payer can refund instead. */
  validUntilEpoch: number;
}

/**
 * A dApp-proposed transaction's actual operation -- one variant per underlying account call.
 * Shared verbatim between `tari_createTransactionRequest`'s input and what a
 * `TransactionRequestRecord` (storage.ts) persists and later executes at submit time, so there is
 * exactly one place this shape is defined.
 */
/**
 * `feeType`/`enforceFeeType`, present on every kind below except `redeemStealthOutputWithPrivateFee`
 * (already always a private fee): lets a dApp request or require how the transaction's fee is
 * paid. `feeType` alone is only a hint -- the wallet still applies its own default/switch and the
 * user can change it in the approval popup. `enforceFeeType: true` makes `feeType` (then
 * required) binding: the popup locks the choice and tells the user this site requires it, with no
 * way to change it short of rejecting. `feeType: "private"` needs a seed-derived local account
 * (same requirement as every Stealth-touching kind below) -- see `resolveFeeType`'s doc comment in
 * background/index.ts. See `WalletCapabilities.supportsPrivateFees` for how a dApp checks this
 * exists before relying on it.
 */
export type TransactionRequestOperation =
  // `inputs` lets a dApp pin substates it already knows are needed (e.g. a component it just read
  // and knows the address of); the wallet's own auto-resolve retry (see OotleAccount.execute())
  // handles whatever's still missing, so this is an optimization, never required for correctness.
  | {
      kind: "instructions";
      instructions: Instruction[];
      maxFee?: string;
      inputs?: SubstateRequirement[];
      feeType?: "private" | "transparent";
      enforceFeeType?: boolean;
    }
  // See `OotleAccount.withdrawStealthAndExecute`'s doc comment: the only way for a dApp to move
  // Stealth-typed funds (e.g. TARI) into its own contract call in one transaction.
  | {
      kind: "withdrawStealthAndExecute";
      resourceAddress: string;
      amount: string;
      workspaceVarName: string;
      followUpInstructions: Instruction[];
      relatedComponents?: string[];
      maxFee?: string;
      feeType?: "private" | "transparent";
      enforceFeeType?: boolean;
    }
  // See `OotleAccount.redeemStealthOutputAndExecute`'s doc comment: unlike `withdrawStealthAndExecute`
  // (an *amount* drawn from this account's own tracked vault balance), this spends *one specific,
  // externally-known* stealth commitment -- a token some other party minted directly to this
  // wallet's address out of band (a voting ballot, ticket, voucher) -- revealing its full value into
  // `followUpInstructions`. `commitmentHex` and `revealedAmount` (the output's actual value) both
  // come from whatever protocol minted the token; the connected account must be its intended owner
  // or this fails when the wallet can't decrypt it.
  | {
      kind: "redeemStealthOutputAndExecute";
      resourceAddress: string;
      commitmentHex: string;
      revealedAmount: string;
      followUpInstructions: Instruction[];
      relatedComponents?: string[];
      maxFee?: string;
      feeType?: "private" | "transparent";
      enforceFeeType?: boolean;
    }
  // See `OotleAccount.redeemStealthOutputWithPrivateFee`'s doc comment: identical to
  // `redeemStealthOutputAndExecute`, except the fee is ALSO paid from a stealth UTXO (a second,
  // separate commitment of `feeResourceAddress` this account owns) instead of this account's
  // revealed balance -- required whenever `followUpInstructions` carries information that would
  // deanonymize the account if the fee input did (e.g. a voting ballot's ranking). Confirmed live:
  // the resulting transaction's substates never include this account's own component address.
  // Returns `{ transactionId, feeChangeCommitment }` -- the fee UTXO's unspent remainder becomes a
  // new stealth output the caller must track itself to fund a next call the same way. Already
  // always a private fee -- no `feeType`/`enforceFeeType` here; use
  // `redeemStealthOutputAndExecute` with `enforceFeeType: true, feeType: "private"` instead if
  // auto-selecting the fee UTXO is fine.
  | {
      kind: "redeemStealthOutputWithPrivateFee";
      resourceAddress: string;
      commitmentHex: string;
      revealedAmount: string;
      followUpInstructions: Instruction[];
      feeResourceAddress: string;
      feeCommitmentHex: string;
      maxFee: string;
      relatedComponents?: string[];
    }
  // See `OotleAccount.htlcFund`'s doc comment: creates an HTLC-locked stealth output, claimable by
  // `claimantWalletAddress` (with the preimage of `hashLockHex`) before `refundEpoch`, refundable
  // to this account after. The other two sides of the swap are the `htlcClaim`/`htlcRefund` kinds
  // below; `htlcFund`'s result carries the `conditions` tree and `outputMask` they need.
  | {
      kind: "htlcFund";
      resourceAddress: string;
      amount: string;
      claimantWalletAddress: string;
      hashLockHex: string;
      refundEpoch: string;
      maxFee?: string;
      feeType?: "private" | "transparent";
      enforceFeeType?: boolean;
    }
  // The x402 payment side: approving one executes as an `htlcFund` against the envelope's fields
  // (see `X402PayTerms` above) -- the same HTLC-locked stealth output, built by the same internal
  // path in background/index.ts (a thin mapping of these fields onto `htlcFund`'s, no duplicated
  // builder logic): the claimant reveals the SHA-256 preimage of `hashLockHex` to take payment
  // before `refundEpoch`, and this account refunds after. The extra fields beyond `htlcFund`'s
  // are what makes this a *purchase* rather than a bare swap leg: `resourceUrl` is WHAT the user
  // is buying, and the approval popup is the only place they ever see it -- so every field here
  // must render human-readably there (the popup case for this kind is expected alongside the
  // others; see background/index.ts's `summarizeOperationForApproval`).
  | ({ kind: "x402Pay" } & X402PayTerms)
  // The settlement side of an x402 purchase, run in the *merchant's* wallet (the HTLC claimant):
  // builds, signs and seals the HTLC claim -- and stops. **The wallet does NOT broadcast.** The
  // indexer facilitator holds the sealed payload and submits it at settle (serve-then-broadcast),
  // because the preimage it carries is the merchant's proof of payment and must not touch the
  // chain (not even the indexer's dry-run preflight) until the resource has been served.
  //
  // The signer is the claimant, and the claim leaf's `AccessRule` badge is satisfied by the
  // signer's own normal transaction signature (per docs/architecture/stealth-and-htlc.md) -- no
  // one-time-key dance, just `signTransaction`/`sealTransaction`. The result
  // (`X402SignedClaimPayload`) is everything the facilitator needs to validate and later
  // broadcast, without re-deriving anything.
  //
  // **Security boundary (structural):** this kind builds ONLY the HTLC claim statement -- one
  // `StealthTransfer` instruction spending exactly the funded HTLC output into this account's own
  // fresh stealth output, plus the transparent fee lane. There is deliberately no
  // `instructions`/`followUpInstructions` field, and the runtime validation gate
  // (background/x402.ts `validateX402SignClaimTerms`) rejects any request carrying keys outside
  // this kind's fixed field set, so a dApp can never smuggle extra value-moving instructions
  // into a payload the user is told "only signs a claim".
  | {
      kind: "x402SignClaim";
      /** The quote being settled -- the exact `x402Pay` field set the paying wallet funded. */
      envelope: X402PayTerms;
      /** The SHA-256 preimage of `hashLockHex`, held by the claimant (merchant). Never leaves
       * this device except inside the sealed payload handed to the facilitator. */
      preimageHex: string;
      /** The funded HTLC output's commitment (64 hex), and the two-leaf condition tree the
       * paying wallet's `x402Pay` result relayed out of band -- only their root is on-chain, so
       * the claimant cannot recover them from the chain alone (`htlcClaim` requires the same
       * pair; see its doc comment in messages.ts). */
      htlcOutputCommitmentHex: string;
      conditions: object[];
    }
  // ---- Private spends ----------------------------------------------------------------------
  // The four operations that move value in or out of, or between, stealth (confidential) outputs.
  // Each maps 1:1 onto the `OotleAccount` method of the same name, and each is deliberately a
  // *request kind* rather than something a dApp can express as raw `instructions`: a real
  // `StealthTransfer` instruction needs a balance proof and per-input one-time authorizations that
  // only the wallet's own signer can produce (see `assertNoStealthTransferInstruction` in
  // background/index.ts), so a dApp can only ever ask the wallet to build one, never hand one over.
  //
  // All four require a seed-derived local account (`capabilities.privateSpend`); a daemon-relayed
  // account cannot produce the view secret or one-time stealth signatures they need.
  //
  // Every one of these goes through the same create -> user approval -> submit flow as any other
  // transaction. Private view access (`tari_requestViewAccess`) is a *read* grant and is not
  // required for, nor does it substitute for, the per-transaction approval these still get.
  /** Revealed -> private, staying in this same account. `amount` is in the resource's own raw
   * units, same as `TokenBalance.amount`.
   *
   * `minimumValuePromise` turns the resulting output into a **proof of funds**: see the shared
   * doc comment on this field below. Result:
   * `{ transactionId, commitment, substateId, minimumValuePromise }` -- `substateId` is the
   * proof artifact, verifiable by anyone with no cooperation from this wallet. */
  | {
      kind: "shield";
      resourceAddress: string;
      amount: string;
      maxFee?: string;
      memo?: string;
      minimumValuePromise?: string;
      feeType?: "private" | "transparent";
      enforceFeeType?: boolean;
    }
  /** Revealed -> a Confidential-type vault, same account -- the "Confidential" `ResourceType`'s
   * equivalent of `shield`, a different privacy mechanism (vault-based, ElGamal-encrypted to a
   * resource view key) than the Stealth kinds around it. Only meaningful against a resource
   * actually created as `ResourceType::Confidential`; fails on-chain against any other resource
   * type, not client-side. No `minimumValuePromise` equivalent exists for Confidential vaults --
   * see the integration docs' resource-types section for why. */
  | {
      kind: "depositConfidential";
      resourceAddress: string;
      amount: string;
      maxFee?: string;
      feeType?: "private" | "transparent";
      enforceFeeType?: boolean;
    }
  /** Private -> revealed, back into this same account's on-chain vault. `revealedAmount` is what
   * lands revealed; which stealth UTXOs get spent to cover it is the wallet's own coin-selection
   * decision (largest-first), not the dApp's. */
  | {
      kind: "unshield";
      resourceAddress: string;
      revealedAmount: string;
      maxFee?: string;
      memo?: string;
      feeType?: "private" | "transparent";
      enforceFeeType?: boolean;
    }
  /** Private -> private, to someone else's bech32m wallet address. The result carries
   * `recipientCommitment` -- the recipient has no way to discover the payment without it (there is
   * no scan-by-view-key API for a specific counterparty), so a dApp brokering this transfer is
   * responsible for delivering that commitment to them out of band. */
  | {
      kind: "sendPrivately";
      resourceAddress: string;
      recipientWalletAddress: string;
      amount: string;
      maxFee?: string;
      memo?: string;
      /** Applies to the *recipient's* output only, never this account's change -- see the field's
       * shared doc comment below. Lets a payer hand the recipient a publicly verifiable floor on
       * what they were paid without revealing the exact amount. Result adds
       * `recipientSubstateId` and `minimumValuePromise`. */
      minimumValuePromise?: string;
      feeType?: "private" | "transparent";
      enforceFeeType?: boolean;
    }
  /** Spends an HTLC output addressed to this account by revealing the claim leaf's preimage.
   * `conditions` must be the exact two-leaf tree the funding side produced (`htlcFund`'s result),
   * passed through unchanged -- only its root is on-chain, so it cannot be recovered from the
   * chain alone. */
  | {
      kind: "htlcClaim";
      resourceAddress: string;
      commitment: string;
      conditions: object[];
      preimageHex: string;
      maxFee?: string;
      feeType?: "private" | "transparent";
      enforceFeeType?: boolean;
    }
  /** Refunds an HTLC *this* account funded, once `refundEpoch` has passed. `amount` and
   * `outputMask` must be exactly what the matching `htlcFund` returned: the output is addressed to
   * the claimant, so this account cannot decrypt it and has no other way to recover them. */
  | {
      kind: "htlcRefund";
      resourceAddress: string;
      commitment: string;
      conditions: object[];
      amount: string;
      outputMask: string;
      maxFee?: string;
      feeType?: "private" | "transparent";
      enforceFeeType?: boolean;
    };

/**
 * ### `minimumValuePromise` (on the `shield` and `sendPrivately` kinds)
 *
 * A public claim, committed into the new output's own range proof, that it is worth **at least**
 * this much. Raw resource units, as a decimal string; omitted or `"0"` means no claim, which is the
 * default and the ordinary case.
 *
 * A confidential output normally proves `0 <= v < 2^64`, hiding `v` entirely. With a promise `m`
 * the proof instead attests `m <= v < 2^64`, and `m` is stored in the clear as
 * `UnspentOutput.minimum_value_promise`. That makes the output a self-contained proof of funds:
 *
 * ```js
 * // Prove this wallet can cover 100000, without revealing what it actually holds.
 * const { requestId } = await tari.request({ method: "tari_createTransactionRequest", params: {
 *   kind: "shield", resourceAddress, amount: "100000", minimumValuePromise: "100000",
 * }});
 * // ...approve, submit, then share result.substateId. Anyone verifies it with no help from you:
 * const s = await tari.request({ method: "tari_getSubstate", params: { substateId } });
 * // -> read `minimum_value_promise` off the output, and that the substate is still unspent.
 * ```
 *
 * Three properties worth designing around:
 *
 * - **Non-interactive and permanent.** Verification needs no cooperation from this wallet, no
 *   signature, and no live session -- just the chain. Equally, the disclosure is permanent and
 *   public: it is visible to everyone forever, not only to whoever the proof was made for.
 * - **It proves one output, not a balance.** "This output is worth >= m", not "this account holds
 *   >= m". To prove total spending power, shield the whole amount into a single output and promise
 *   against that; a caller can check `tari_getPrivateBalances`' `outputCount` to see how funds are
 *   currently split.
 * - **Spending the output destroys the proof.** Which is the correct semantics -- a proof of funds
 *   should stop verifying once the funds move -- but it means a verifier must re-check that the
 *   substate is still unspent at the moment they care, not merely that it once existed.
 *
 * Must not exceed the output's own `amount`: a range proof asserting "at least m" is impossible for
 * an output actually worth less, and is rejected client-side before anything is signed.
 */

/** `tari_getTransactionRequest`/`tari_createTransactionRequest`'s result -- the dApp-facing view
 * of a `TransactionRequestRecord` (storage.ts), with internal fields (the account id, the raw
 * `operation` the dApp already has its own copy of) stripped. */
export interface TransactionRequestSummary {
  requestId: string;
  /** "signed-unbroadcast" is the terminal state of a completed sign-only `x402SignClaim`: the
   * wallet signed and sealed the claim and handed the payload back -- nothing was broadcast, and
   * the settlement facilitator submits it at settle. Idempotent to re-poll (the stored `result`
   * is the sealed payload) and never re-submittable -- `tari_submitTransactionRequest` throws
   * with an explanation instead. */
  status: "pending" | "approved" | "submitting" | "submitted" | "signed-unbroadcast" | "rejected" | "failed";
  /** Human-readable summary of what this request does, the same text shown on the popup approval
   * screen -- useful for a dApp's own UI while waiting on approval. */
  note: string;
  createdAt: number;
  expiresAt: number;
  /** Set once `status` is "submitted" (or "signed-unbroadcast", whose result is the sealed claim
   * payload the dApp delivers to the settlement facilitator). */
  result?: unknown;
  /** Set once `status` is "rejected"/"failed". */
  error?: string;
}

export interface ProviderRequestParams {
  tari_requestAccounts: undefined;
  tari_getAccounts: undefined;
  tari_getNetwork: undefined;
  /**
   * The connected account's **bech32m wallet address** (`account_...`) -- its owner + view *public*
   * keys, which is what a stealth output's `destination` decodes as. Distinct from the on-chain
   * component address `tari_requestAccounts`/`tari_getAccounts` return, and not derivable from it:
   * a component address is a one-way hash of the owner key alone and carries no view key at all.
   *
   * A dApp needs this to address a private payment *to* the user -- e.g. a DEX paying a fill out as
   * a stealth output, or a counterparty funding an HTLC claimable by them. Publishing it is safe:
   * it holds only public keys, so it lets anyone pay this account privately and no one read it.
   *
   * Requires a connection but **not** view access -- this is a receiving address, not a view key.
   */
  tari_getWalletAddress: undefined;
  /**
   * Returns `DappTokenBalance[]`. `amount` (the public, revealed balance) is always real.
   * `confidentialAmount` is only real when this site holds private view access -- without it the
   * field reads `"0"` and `privateVisible` is `false`, so a dApp can tell "no private balance" from
   * "not allowed to see it" rather than silently mistaking the second for the first. Call
   * `tari_requestViewAccess` to ask for it, or use `tari_getPrivateBalances` once granted.
   */
  tari_getBalances: undefined;
  // Read-only substate lookup (e.g. a resource's on-chain `divisibility`) — general-purpose, not
  // tied to the connected account, so a dApp can look up any address it already knows.
  tari_getSubstate: { substateId: string; version?: number | null };
  // Lets a dApp discover which optional provider features the *connected account* actually
  // supports before relying on them (e.g. `tari_withdrawStealthAndExecute` needs a seed-derived
  // local account, not a daemon-relayed one) — see `WalletCapabilities` below for the fields.
  tari_getCapabilities: undefined;
  // Recovers a past transaction's result by id (e.g. after a page refresh dropped the original
  // `tari_signAndSubmitTransaction` promise) rather than requiring the dApp to have stayed alive
  // for the whole submit-and-poll cycle.
  tari_getTransactionResult: { transactionId: string };
  /** @deprecated Prefer `tari_createTransactionRequest` + `tari_submitTransactionRequest` -- this
   * blocks for the whole approval+submit round trip in one call, which can't recover if the page
   * reloads mid-flight. Still fully supported; implemented as a thin wrapper over the same
   * create/submit primitives. `dryRun: true` is unaffected -- it never needed approval and stays a
   * direct, un-request-tracked call either way. */
  tari_signAndSubmitTransaction: { instructions: Instruction[]; maxFee?: string; dryRun?: boolean; inputs?: SubstateRequirement[] };
  /** @deprecated Prefer `tari_createTransactionRequest({ kind: "withdrawStealthAndExecute", ... })`
   * + `tari_submitTransactionRequest`. Still fully supported; implemented as a thin wrapper. */
  tari_withdrawStealthAndExecute: {
    resourceAddress: string;
    amount: string;
    workspaceVarName: string;
    followUpInstructions: Instruction[];
    relatedComponents?: string[];
    maxFee?: string;
  };
  /** @deprecated Prefer `tari_createTransactionRequest({ kind: "htlcFund", ... })` +
   * `tari_submitTransactionRequest`. Still fully supported; implemented as a thin wrapper. */
  tari_htlcFund: {
    resourceAddress: string;
    amount: string;
    claimantWalletAddress: string;
    hashLockHex: string;
    refundEpoch: string;
    maxFee?: string;
  };
  /**
   * Proposes a transaction and returns a `requestId` immediately, without waiting for the user to
   * approve it -- mirrors `tari_ootle_walletd`'s `transaction_requests.create` (tari-project/
   * tari-ootle#2348). Opens the same approval popup `tari_signAndSubmitTransaction` always has;
   * the difference is this call doesn't block on it. Poll `tari_getTransactionRequest` (survives a
   * page reload -- the request is persisted, not tied to this call's own promise) until `status`
   * is `"approved"`, then call `tari_submitTransactionRequest`. There is deliberately no
   * dApp-facing "approve" method -- only the human, via the popup, can approve a request; a dApp
   * approving its own request would defeat the entire point of asking.
   */
  tari_createTransactionRequest: TransactionRequestOperation;
  /** Looks up a transaction request this same origin created, by id. Works after a page
   * reload/service-worker restart -- the record is persisted, not held only in memory. */
  tari_getTransactionRequest: { requestId: string };
  /** Executes an `"approved"` transaction request and returns its result -- throws if the request
   * isn't approved yet (still `pending`), was rejected, already submitted, or has expired. A
   * `signed-unbroadcast` request (a completed sign-only `x402SignClaim`) also throws: its sealed
   * payload was already handed back, and the settlement facilitator -- not this wallet --
   * broadcasts it at settle. Submission is claimed atomically at submit time, so
   * racing/duplicate submits over one request are safe: exactly one executes, the rest throw. */
  tari_submitTransactionRequest: { requestId: string };

  // ---- Private view access -------------------------------------------------------------------
  /**
   * Asks the user for **private view access**: permission for this site to read the connected
   * account's confidential position -- shielded balances, the individual stealth UTXOs behind them,
   * and view-key scanning. Opens its own approval popup, separate from the connect prompt, and
   * resolves to `{ granted: boolean }` rather than throwing on refusal (a refused optional
   * permission is a normal answer, not an error). Already-granted is a no-op that returns
   * `{ granted: true }` without prompting.
   *
   * Requires an existing connection -- call `tari_requestAccounts` first. The grant is bound to
   * that connection: disconnecting, or the user switching the active account (which drops every
   * connection), drops it too, and re-approving a connection does not restore it.
   *
   * This is read-only. It never authorizes a spend -- private spends go through the same
   * per-transaction approval as everything else, granted or not.
   */
  tari_requestViewAccess: undefined;
  /** Whether this site currently holds private view access -- `{ granted: boolean }`, never
   * prompts. Use it to decide whether to show a "connect your private balance" affordance instead
   * of firing a prompt the user may not be expecting. */
  tari_getViewAccess: undefined;
  /** Voluntarily gives up this site's private view access. Idempotent; never prompts. Worth calling
   * when a dApp is done with a flow that needed it, so the grant does not sit around longer than
   * the feature that asked for it. */
  tari_revokeViewAccess: undefined;

  // ---- Confidential reads (all require the grant above) ---------------------------------------
  /**
   * Per-resource shielded totals for the connected account -- `PrivateBalance[]`. This is the
   * sum of the account's *unspent* stealth outputs, which is strictly more than the
   * `confidentialAmount` on a vault: freestanding `utxo_{resource}_{commitment}` substates (what a
   * shield/private-send actually creates) are not entries in any vault's commitments map, so a
   * resource can have a real private balance and no on-chain vault at all.
   */
  tari_getPrivateBalances: undefined;
  /**
   * The individual unspent stealth UTXOs behind those totals -- `ShieldedOutputSummary[]`, newest
   * first. Optionally filtered to one `resourceAddress`. A dApp needs the per-output breakdown
   * (not just the total) to reason about what a spend can actually be covered by, since each
   * output is spent whole.
   */
  tari_getShieldedOutputs: { resourceAddress?: string } | undefined;
  /**
   * Runs a view-key scan over the indexer's recent transactions for stealth outputs belonging to
   * this account, recording any it finds so they show up in the balances above. Returns
   * `{ claimed, found }`. Costs real network round trips (it walks transaction pages), so treat it
   * as a user-initiated "refresh", not something to poll -- the wallet already scans
   * opportunistically on its own.
   *
   * `maxPages` (default: the wallet's own budget) bounds the walk. Nothing is lost by a short walk:
   * the scan cursor only advances when a pass actually reaches where the last one left off.
   */
  tari_scanForPrivatePayments: { maxPages?: number } | undefined;
  /**
   * Like `tari_scanForPrivatePayments`, but for one specific `resourceAddress` and not limited to
   * outputs from a native `StealthTransfer` instruction -- it also finds a UTXO minted by custom
   * template logic inside a `CallFunction`/`CallMethod` (a voting template's ballot tokens, for
   * instance), which `tari_scanForPrivatePayments` can never see. Returns `{ claimed, found }`,
   * same shape as `tari_scanForPrivatePayments`.
   *
   * More expensive per page than `tari_scanForPrivatePayments` (it fetches each candidate
   * transaction's full result, not just the pruned listing), so `maxPages`/`pageSize` default to a
   * small lookback meant for an interactive "do I have one of these" check on a resource whose
   * mint is known to be recent -- not a background sweep of the whole chain. Pass `limit` when the
   * resource is known to mint at most that many outputs per account (a voting ballot: exactly one)
   * to stop the walk the instant it's satisfied instead of exhausting the rest of the page budget.
   * Pass `transactionIds` when the caller already knows exactly which transaction(s) created this
   * resource's outputs (e.g. a voting app's own election-creation transaction) to check those
   * directly instead of ever walking recent transactions at all.
   */
  tari_scanForResourceUtxos: { resourceAddress: string; maxPages?: number; pageSize?: number; limit?: number; transactionIds?: string[] };
  /**
   * Scans the indexer's live UTXO set for outputs owned by this account, without requiring the
   * indexer to retain full transaction history. Finds any stealth output that exists on-chain for
   * `resourceAddress` regardless of how it was created (unlike `tari_scanForPrivatePayments`
   * which only sees native `StealthTransfer`s, or `tari_scanForResourceUtxos` which requires
   * recent history). Also marks known outputs as spent when the chain reports they were consumed.
   *
   * `mode` is `"delta"` (default: incremental, checkpoint-based, fast on repeat calls) or
   * `"full"` (paginated scan of the entire current UTXO set; use when checkpoints are lost or a
   * full re-scan is needed). Returns `{ newOutputs, markedSpent }`.
   */
  tari_scanForOwnedUtxos: { resourceAddress: string; mode?: "delta" | "full" };
  /**
   * Claims a specific stealth payment this account was told about out of band, by commitment --
   * the recipient-side counterpart to a `sendPrivately` result's `recipientCommitment`. Fetches the
   * `utxo_{resource}_{commitment}` substate and decrypts it with this account's view secret;
   * success both proves ownership and recovers the amount, and records the output so it counts
   * toward the private balance from then on. Returns `{ amount, memo? }`.
   *
   * Purely local bookkeeping -- it submits no transaction and moves nothing on-chain, which is why
   * it sits behind the view grant rather than a transaction approval. Throws if the commitment
   * isn't this account's, isn't on-chain, or was already claimed.
   */
  tari_claimPrivatePayment: { resourceAddress: string; commitment: string };

  // ---- Ownership proof -----------------------------------------------------------------------
  /**
   * Proves the connected account currently controls the stealth output at `substateId` -- e.g. a
   * `minimumValuePromise` proof-of-funds output it created earlier -- without spending it or
   * revealing anything about it beyond what `tari_getSubstate` already shows anyone. Opens its own
   * approval popup showing `challenge` verbatim; the user must read and approve it before the
   * wallet signs. Local accounts only (`capabilities.ownershipProof`).
   *
   * `challenge` should be something the verifier generated themselves and can recognize -- signing
   * someone else's static text proves nothing about *when* or *for whom* it was signed. Returns
   * `{ publicKey, publicNonce, signature }` (all hex): `publicKey` is the output's one-time spend
   * key -- matches the substate's on-chain `auth.Key` -- and the caller verifies
   * `(publicNonce, signature)` against `(publicKey, challenge)` independently; the wallet is not
   * asked to vouch for the check.
   *
   * The bytes actually signed are never `challenge` alone -- see `ownershipProof.ts` for why a raw
   * signature over caller-supplied bytes would be unsafe here.
   */
  tari_signOwnershipChallenge: { resourceAddress: string; substateId: string; challenge: string };
  /**
   * Proves the connected account holds its own `otl_…` wallet address by signing `challenge` with
   * the account's persistent owner key -- unlike `tari_signOwnershipChallenge`, not tied to any
   * particular output, so no `resourceAddress`/`substateId` to supply. Opens the same kind of
   * approval popup, challenge shown verbatim. Local accounts only
   * (`capabilities.walletOwnershipProof`).
   *
   * Returns `{ walletAddress, publicNonce, signature }` (walletAddress echoed for convenience --
   * verify against the owner key decoded from the address *you* already have in mind, never
   * against this field taken at face value).
   */
  tari_signWalletOwnershipChallenge: { challenge: string };

  tari_disconnect: undefined;
}

/**
 * `tari_getBalances`' element type -- `TokenBalance` (wallet.ts) as a dApp sees it: BigInts
 * stringified for the message channel, and the confidential half gated behind private view access.
 */
export interface DappTokenBalance {
  resourceAddress: string;
  /** "Fungible" | "NonFungible" | "Confidential" | "Stealth" */
  kind: string;
  /** The public, revealed balance. Always real, granted or not. */
  amount: string;
  /** This resource's private balance -- `"0"` whenever `privateVisible` is false, which is NOT the
   * same claim as "this account holds nothing privately". Check `privateVisible` first. */
  confidentialAmount: string;
  /** Whether `confidentialAmount` reflects reality (this site holds private view access) or is
   * withheld. */
  privateVisible: boolean;
  divisibility: number;
  symbol: string | null;
  name: string | null;
}

/** `tari_getPrivateBalances`' element type: one resource's total unspent shielded value. */
export interface PrivateBalance {
  resourceAddress: string;
  /** Total unspent shielded value, raw resource-native units (same convention as
   * `DappTokenBalance.amount`). */
  amount: string;
  /** How many unspent stealth outputs make up `amount` -- each is spent whole, so this is what
   * bounds how a spend can be covered. */
  outputCount: number;
  divisibility: number;
  symbol: string | null;
  name: string | null;
}

/** `tari_getShieldedOutputs`' element type: one unspent stealth UTXO. Deliberately excludes the
 * blinding mask and view secret -- a dApp gets to see *what* the account holds privately, never the
 * material needed to spend it or to decrypt anything else addressed to it. */
export interface ShieldedOutputSummary {
  resourceAddress: string;
  /** 32-byte Pedersen commitment, hex -- public on-chain data (it is half of the output's own
   * substate id), so no more sensitive than the fact of the output itself. */
  commitment: string;
  amount: string;
  /** The transaction that created it, or its own substate id for an output recovered by commitment
   * rather than seen created (see `claimPrivatePayment`). */
  transactionId: string;
  createdAt: number;
  memo?: string;
}

/** `tari_scanForPrivatePayments`' result. */
export interface PrivatePaymentScanResult {
  /** How many previously-unknown outputs this pass found and recorded. */
  claimed: number;
  found: { resourceAddress: string; commitment: string; amount: string; transactionId: string; memo?: string }[];
}

/** `tari_scanForResourceUtxos`' result -- same shape as `PrivatePaymentScanResult`. */
export type ResourceUtxoScanResult = PrivatePaymentScanResult;

/** Sent from the content script to the background, tagged with the requesting page's origin. */
export interface PageRequestMessage {
  kind: "tari-page-request";
  origin: string;
  id: string;
  method: ProviderMethod;
  params: unknown;
}

export interface PageResponseMessage {
  kind: "tari-page-response";
  id: string;
  result?: unknown;
  error?: ProviderError;
}

/** `{code, message}` shape a dApp can branch on (`if (e.code === 4001) …`) instead of parsing
 * message text -- the same convention the Tari Universe web wallet's bridge already implements
 * (see tari-l1-wallet-ui's dappBridge.ts `ERROR` table), so a dApp written against one wallet's
 * error codes doesn't silently degrade to string-only errors on the other. */
export interface ProviderError {
  code: number;
  message: string;
}

export const ERROR = {
  rejected: { code: 4001, message: "Request rejected by the user" },
  unauthorized: { code: 4100, message: "Not connected — call tari_requestAccounts first" },
  unsupported: (m: string): ProviderError => ({ code: 4200, message: `Unsupported method: ${m}` }),
  internal: (m: string): ProviderError => ({ code: -32603, message: m }),
} as const;

/**
 * Classifies an already-thrown Error's message into the same `{code, message}` shape, for the
 * single boundary point (background/index.ts's `tari-page-request` handler) where every throw from
 * `handlePageRequest` -- and everything it calls -- ends up. Cheaper and less error-prone than
 * hand-annotating each of the ~30 individual throw sites with a code: they already use a small,
 * consistent set of message strings (checked against every current throw site in
 * background/index.ts), so matching on those preserves the exact same classification a per-site
 * `ERROR.rejected`/`ERROR.unauthorized` call would have produced, without the two ever drifting
 * apart as new cases are added elsewhere in the switch.
 */
// The exact, fixed set of messages a user *declining an approval popup* produces (see
// background/index.ts's own `if (!approved) throw new Error(...)` / `waitForApprovalDecision`
// call sites) -- not a substring/regex match. A genuine on-chain rejection (e.g.
// `daemonAccount.ts`'s `throwOnRejection`: "Transaction <id> was rejected: ...", or the
// equivalent from OotleAccount's own polling) also contains the word "rejected", but means the
// opposite thing to a dApp: the user approved fine, the *network* rejected the transaction. A
// bare `/rejected/i` test conflated the two, so a dApp checking `error.code === 4001` (EIP-1193's
// "user rejected" convention) to decide whether to let its own user retry immediately would were
// wrongly parking a real, informative on-chain failure under the sole message "Request rejected
// by the user" -- confirmed against a live daemon: a real `Reject` outcome surfaced exactly that
// generic text instead of its own reason.
const USER_DECLINED_MESSAGES = new Set(["Connection request rejected.", "Rejected by the user.", "Transaction rejected."]);

export function classifyProviderError(message: string): ProviderError {
  if (USER_DECLINED_MESSAGES.has(message)) return ERROR.rejected;
  if (message === "Wallet is locked." || message.startsWith("Site is not connected")) return ERROR.unauthorized;
  if (message.startsWith("Unknown method:")) return ERROR.unsupported(message.replace(/^Unknown method:\s*/, ""));
  return ERROR.internal(message);
}

/** `tari_getCapabilities`'s result -- reflects what the *currently connected account* can
 * actually do, not just what the wallet extension's codebase supports (e.g. `stealthWithdraw` is
 * false for a daemon-relayed account even though the wallet has the feature). */
export interface WalletCapabilities {
  /** `tari_signAndSubmitTransaction`'s `inputs` param already lets a dApp pin exact
   * `SubstateRequirement`s (including a specific UTXO it already knows about) instead of relying
   * on the wallet's own auto-resolve retry. Always true today. */
  exactInputSelection: boolean;
  /** `tari_withdrawStealthAndExecute` -- moves Stealth-typed funds into a dApp's own contract call
   * in one signed transaction. Only a seed-derived local account can produce the stealth balance
   * proof this needs; a daemon-relayed account can't. */
  stealthWithdraw: boolean;
  /** The `redeemStealthOutputAndExecute` transaction-request kind -- spends one specific,
   * externally-known stealth commitment (e.g. a ballot/ticket token minted directly to this
   * wallet by another party) into a dApp's own contract call. Same account requirement as
   * `stealthWithdraw`. */
  stealthRedeem: boolean;
  /** The `redeemStealthOutputWithPrivateFee` transaction-request kind -- like `stealthRedeem`,
   * but the fee is also paid from a stealth UTXO, so the transaction never reveals this
   * account's address at all. Same account requirement as `stealthWithdraw`. */
  stealthRedeemPrivateFee: boolean;
  /** `tari_htlcFund` -- creates an HTLC-locked (hashlock/timelock ScriptPath) stealth output.
   * Only a seed-derived local account can build the `PayTo::Conditions` output witness this
   * needs; a daemon-relayed account can't. */
  htlcFund: boolean;
  /** Spending a ScriptPath/conditional-locked stealth output -- the `htlcClaim`/`htlcRefund`
   * transaction-request kinds, the other half of `htlcFund`. Same account requirement as the rest
   * of the stealth surface: a seed-derived local account only. */
  scriptPathSpend: boolean;
  /** The `x402SignClaim` transaction-request kind -- build, sign and seal the HTLC claim for an
   * x402 purchase WITHOUT broadcasting it; the sealed payload is handed back for the settlement
   * facilitator to submit at settle. Same account requirement as the rest of the stealth surface:
   * a seed-derived local account only (the claim needs its view secret to decrypt the funded
   * output). The build path exists in code; live-testnet verification (Phase 5 e2e) is still
   * ahead -- see background/capabilities.ts's own note. */
  signOnly: boolean;
  /** The `unshield`/`sendPrivately` transaction-request kinds -- spending an *existing* stealth
   * output. A daemon-relayed account can do this too (via `accounts.create_stealth_transfer_statement`,
   * confirmed against a live daemon), unlike the rest of the stealth-spend surface
   * (`stealthWithdraw`/`stealthRedeem`/`htlcFund`/`scriptPathSpend`), which still needs this
   * account's own view secret client-side and so stays local-only. True for both account kinds,
   * but a daemon-relayed account can't pay the transaction fee privately -- `feeType: "private"`
   * on either operation still requires a local account (see `resolveFeeType`'s own doc comment).
   * Does NOT cover `shield` -- see `shieldFunds` below, which a daemon-relayed account can do too. */
  privateSpend: boolean;
  /** `tari_shield` -- moving revealed balance into a new stealth output. Unlike the rest of the
   * private-spend surface, this only ever *creates* a stealth output rather than spending an
   * existing one, so a daemon-relayed account can do it entirely server-side via its own
   * `accounts.stealth_transfer` RPC (confirmed against a live daemon) without ever needing the
   * view secret client-side. True for both account kinds. */
  shieldFunds: boolean;
  /** Whether this wallet can serve `tari_getPrivateBalances`/`tari_getShieldedOutputs` for the
   * connected account. A daemon-relayed account can, via its own stealth JRPC (`stealthUtxosList`
   * + `stealthUtxosDecryptValue`) -- unlike the rest of the confidential-read surface, these never
   * need the view secret client-side, since the daemon already holds it and does the decryption
   * itself. True for both account kinds. Independent of `privateViewGranted`: this says the
   * feature exists, that says the user said yes. */
  privateBalanceView: boolean;
  /** Whether this wallet can serve the *remaining* confidential reads (`tari_scanForPrivatePayments`,
   * `tari_scanForResourceUtxos`, `tari_claimPrivatePayment`) for the connected account. Unlike
   * `privateBalanceView`'s two methods, these still need this account's own view secret
   * client-side (to trial-decrypt candidate outputs / produce a claim's ownership proof), which a
   * daemon-relayed account never has. */
  privateScan: boolean;
  /** Whether *this site* currently holds the private view grant. False means the confidential-read
   * methods will throw and `tari_getBalances`' `confidentialAmount` is withheld -- call
   * `tari_requestViewAccess` to ask. See `ConnectedSite.viewAccessGrantedAt` in storage.ts. */
  privateViewGranted: boolean;
  /** `tari_getTransactionResult` -- look up a past transaction's result by id. Always true today. */
  transactionResultLookup: boolean;
  /** `tari_createTransactionRequest`/`tari_getTransactionRequest`/`tari_submitTransactionRequest`
   * -- the create/submit transaction flow, mirroring `tari_ootle_walletd`'s `transaction_requests`
   * (tari-project/tari-ootle#2348). Always true today; `tari_signAndSubmitTransaction` and friends
   * remain supported as deprecated wrappers over the same primitives. */
  transactionRequests: boolean;
  /** `tari_getWalletAddress` -- the bech32m address needed to address a stealth output *to* this
   * account. Always true today. */
  walletAddress: boolean;
  /** `minimumValuePromise` on the `shield`/`sendPrivately` operation kinds -- proof-of-funds
   * outputs. Same account requirement as the rest of the stealth surface: seed-derived local
   * accounts only. */
  minimumValuePromise: boolean;
  /** `tari_signOwnershipChallenge` -- proves control of a specific stealth output (e.g. a
   * `minimumValuePromise` proof-of-funds output) without spending it. Same account requirement as
   * the rest of the stealth surface: seed-derived local accounts only. */
  ownershipProof: boolean;
  /** `tari_signWalletOwnershipChallenge` -- proves control of the connected wallet address itself,
   * not tied to any particular output. Same account requirement: seed-derived local accounts only. */
  walletOwnershipProof: boolean;
  /** The `depositConfidential` transaction-request kind -- moves revealed balance into a
   * Confidential-type vault (a different privacy mechanism from the Stealth surface the rest of
   * this interface covers). Same account requirement: seed-derived local accounts only. */
  confidentialDeposit: boolean;
  /** `feeType`/`enforceFeeType` on every transaction-request kind except
   * `redeemStealthOutputWithPrivateFee` (always private already) -- see that field's own doc
   * comment on `TransactionRequestOperation`. `feeType: "private"` needs a seed-derived local
   * account, same requirement as the rest of the stealth surface; this reports false for a
   * daemon-relayed account even though `feeType: "transparent"` still works for one. */
  supportsPrivateFees: boolean;
  /** Whether `tari_signAndSubmitTransaction`'s `dryRun: true` executes locally (no network
   * egress) or is simulated remotely by the indexer. False today -- a transaction carrying secret
   * witness data (e.g. a future ScriptPath preimage) should not be dry-run through this wallet
   * until this is true. */
  dryRunIsLocal: boolean;
}

/**
 * Unsolicited push from the background to every tab's content script, forwarded into the page as
 * a `tari#accountsChanged` DOM event (see inject.ts) — mirrors EIP-1193's `accountsChanged`.
 * Fired with an empty `accounts` array when the user switches the wallet's active account, since
 * every existing connection gets dropped at the same time (see `removeAllConnectedSites` in
 * storage.ts) and the page needs to know its previously-authorized account is no longer valid
 * without waiting for its next request to fail.
 */
export interface AccountsChangedBroadcast {
  kind: "tari-accounts-changed";
  accounts: string[];
}

// ---- Popup <-> background ----

export type PopupRequest =
  | { kind: "popup-get-status" }
  | { kind: "popup-reload-extension" }
  | { kind: "popup-set-language"; language: "en" | "zh" }
  | { kind: "popup-create-wallet"; password: string }
  | { kind: "popup-get-pending-mnemonic" }
  | { kind: "popup-confirm-backup" }
  | { kind: "popup-import-wallet"; password: string; mnemonic: string }
  | { kind: "popup-unlock"; password: string }
  | { kind: "popup-lock" }
  | { kind: "popup-reveal-mnemonic"; password: string }
  | { kind: "popup-get-balances" }
  | { kind: "popup-get-nft-details"; resourceAddress: string; tokenIds: string[] }
  | { kind: "popup-claim-testnet-xtr" }
  | { kind: "popup-send"; recipientWalletAddress: string; resourceAddress: string; amount: string }
  | { kind: "popup-shield"; resourceAddress: string; amount: string; maxFee?: string; memo?: string }
  | { kind: "popup-unshield"; resourceAddress: string; revealedAmount: string; maxFee?: string; memo?: string }
  | {
      kind: "popup-send-privately";
      resourceAddress: string;
      recipientWalletAddress: string;
      amount: string;
      maxFee?: string;
      memo?: string;
      /** Omitted = private for a local account (see the handler), transparent for a daemon one. */
      feeType?: "private" | "transparent";
    }
  | { kind: "popup-claim-private-payment"; resourceAddress: string; commitment: string }
  /** The active local account's public key -- the claim key a Minotari (L1) burn is addressed to. */
  | { kind: "popup-get-burn-claim-key" }
  /** Claims an L1 burn from its proof file (minotari_console_wallet or wallet-daemon JSON). */
  | { kind: "popup-claim-burn"; proofJson: string }
  | { kind: "popup-rescan-private-payments" }
  /** The popup's own opportunistic scan -- triggered once the home screen has already rendered
   * (see renderHome()), not blocking on it the way buildStatus() used to. */
  | { kind: "popup-auto-scan-private-payments" }
  | { kind: "popup-add-account" }
  | { kind: "popup-import-account"; mnemonic: string; label?: string }
  | { kind: "popup-remove-imported-account"; accountId: string }
  | { kind: "popup-set-active-account"; accountId: string }
  | { kind: "popup-get-connected-sites" }
  | { kind: "popup-disconnect-site"; origin: string }
  /** Revokes a site's private view grant from the Connected sites screen without disconnecting it
   * outright -- the user-side counterpart to a dApp's own `tari_revokeViewAccess`. */
  | { kind: "popup-revoke-site-view-access"; origin: string }
  | { kind: "popup-get-pending-approval"; approvalId: string }
  /** Simulates a pending transaction request and reports what it does to the signing account. */
  | { kind: "popup-preview-transaction-request"; approvalId: string }
  | { kind: "popup-resolve-approval"; approvalId: string; approve: boolean; feeType?: "private" | "transparent" }
  | { kind: "popup-reset-wallet" }
  | { kind: "popup-connect-daemon"; url: string; apiKey: string; label: string }
  | { kind: "popup-list-daemon-accounts"; connectionId: string }
  | { kind: "popup-add-daemon-accounts"; connectionId: string; accounts: { componentAddress: string; label: string }[] }
  | { kind: "popup-remove-daemon-connection"; connectionId: string }
  | { kind: "popup-remove-daemon-account"; connectionId: string; componentAddress: string }
  | { kind: "popup-set-auto-lock-minutes"; minutes: number }
  | { kind: "popup-set-fee-privacy-default"; feeType: "private" | "transparent" }
  | { kind: "popup-add-address-book-entry"; label: string; address: string }
  | { kind: "popup-remove-address-book-entry"; id: string }
  | { kind: "popup-set-network"; network: "esmeralda" | "igor" }
  | { kind: "popup-get-transaction-history" };

export interface AccountSummary {
  id: string;
  label: string;
  kind: "local" | "daemon" | "imported";
  /** This account's on-chain component address, for rendering a per-account avatar in the
   * switcher (matching the MetaMask/Phantom convention of letting users recognize accounts by
   * icon, not just an ordinal label). Null only when the wallet is locked (no seed available to
   * derive a local account's address, and daemon addresses aren't fetched while locked either). */
  address: string | null;
}

export interface WalletStatus {
  hasWallet: boolean;
  /** A created wallet whose recovery phrase has not been verified yet. */
  backupPending: boolean;
  isUnlocked: boolean;
  network: "esmeralda" | "igor";
  activeAccountId: string;
  accountCount: number;
  address: string | null;
  receiveAddress: string | null;
  /** The active account's component address from the last time it was unlocked, cached in
   * plaintext (see storage.ts's WalletState.lastKnownAddress) -- unlike `address`, this is set
   * even while locked, so the lock screen can show a real identicon instead of a placeholder. */
  lastKnownAddress: string | null;
  /** Set when resolving the active account failed (e.g. a daemon-relayed account whose daemon is
   * unreachable) — `address`/`receiveAddress` are null in that case, but the rest of the status
   * (account list, network, etc.) is still valid, so the popup can render enough UI to let the
   * user switch to a working account instead of being stuck on a blank error screen. */
  activeAccountError: string | null;
  accounts: AccountSummary[];
  daemonConnections: { id: string; url: string; label: string }[];
  addressBook: { id: string; label: string; address: string }[];
  autoLockMinutes: number;
  feePrivacyDefault: "private" | "transparent";
  /** Set to the newer version string once Chrome has downloaded an update and is waiting for the
   * extension to reload to apply it (chrome.runtime.onUpdateAvailable) -- null the rest of the
   * time. Chrome won't swap the update in on its own while the popup/service worker are in use, so
   * without surfacing this, an install can sit on a downloaded-but-unapplied update indefinitely. */
  updateAvailable: string | null;
  /** The popup's display language -- see src/lib/i18n/index.ts. */
  language: "en" | "zh";
}

/** Mirrors storage.ts's `TransactionHistoryEntry` — see its doc comment for scope. Declared
 * separately here rather than imported, matching how `WalletStatus`'s other storage-backed fields
 * (e.g. `daemonConnections`) are their own popup-facing shapes, not direct storage.ts imports. */
export interface TransactionHistoryEntry {
  id: string;
  accountId: string;
  kind: "send" | "shield" | "unshield" | "send-privately" | "claim" | "private-payment-received" | "received" | "burn-claim" | "dapp-transaction";
  resourceAddress?: string;
  amount?: string;
  counterparty?: string;
  transactionId?: string;
  createdAt: number;
  /** "confirmed" for an action that really completed on-chain; "signed-unbroadcast" for a
   * completed sign-only `x402SignClaim` (nothing moved on-chain -- history must never render it
   * as a completed spend); "failed" otherwise. */
  status: "confirmed" | "failed" | "signed-unbroadcast";
  memo?: string;
  divisibility?: number;
  symbol?: string | null;
}

/** One account as reported by a wallet daemon's `accounts.list`/`accounts.get` JRPC, surfaced to
 * the popup so the user can pick which ones to add — the "select accounts to import" step of the
 * hardware-wallet-style connect flow. */
export interface DaemonAccountOption {
  componentAddress: string;
  label: string;
}

// ---- Approval requests (background holds these; popup renders + resolves them) ----

export type PendingApproval =
  /** `accountId` is the account that was active when the prompt was raised -- the one the chip
   * shows and the one the connection will bind, captured up front so a user who switches the active
   * account while this window sits open still connects exactly the account they saw and approved
   * (not whatever happens to be active at click time). Absent only for a pending approval raised
   * before this field existed; display and binding then fall back to the current active account. */
  | { kind: "connect"; id: string; origin: string; accountId?: string }
  /** `tari_requestViewAccess`'s prompt -- a read grant over the connected account's confidential
   * position, deliberately its own approval kind rather than a checkbox on the connect screen: it
   * is asked for separately, at the moment a feature actually needs it, so the user is answering
   * about a visible thing rather than pre-authorizing one. `accountId` is the site's connected
   * account (whose private balance would be exposed), not necessarily the active one. */
  | { kind: "viewAccess"; id: string; origin: string; accountId: string }
  | {
      kind: "transaction";
      id: string;
      origin: string;
      instructions: Instruction[];
      maxFee?: string;
      dryRun?: boolean;
      /** The flat, dApp-facing text (also `TransactionRequestSummary.note` from
       * `tari_getTransactionRequest`) -- `steps`/`warning` below are the same facts, structured
       * for the popup's own rendering; this is `[...steps, warning].join(" ")`. */
      note?: string;
      /** Each one a single fact worth reading on its own (see `summarizeOperationForApproval`'s
       * doc comment in background/index.ts) -- rendered as separate lines rather than the one
       * run-on paragraph `note` collapses them into. Absent only for a raw `instructions` request
       * whose own instruction cards already carry the detail. */
      steps?: string[];
      /** The minimum-value-promise disclosure, when this request carries one -- kept apart from
       * `steps` so the popup can render it in its own highlighted box instead of a line indistinct
       * from the rest. */
      warning?: string;
      /** The account that will actually sign -- the site's connected account (bound at connect
       * time), which is NOT necessarily whichever account happens to be active right now. Shown
       * on the approval screen so a user with multiple accounts can confirm which identity/funds
       * a request is exposing before approving it. Absent only for approvals created before this
       * field existed (a pending approval from before an extension update — display falls back to
       * "an account" rather than guessing). */
      accountId?: string;
      /** Absent for a dry run or for `redeemStealthOutputWithPrivateFee` (no `feeType` field, and
       * dry runs never touch storage or spend anything). Otherwise `enforced` locks the popup's
       * fee-type row to `initial` (a fact, not a choice); unenforced renders it as a toggle seeded
       * at `initial` -- see `resolveApproval`'s doc comment for where the user's live pick ends up. */
      feeChoice?: { enforced: boolean; initial: "private" | "transparent" };
    }
  /** `tari_signOwnershipChallenge`'s prompt. Spends nothing -- shown as its own kind, not folded
   * into `transaction`, so the copy can say that plainly instead of reusing language about moving
   * value. `challenge` is rendered to the user verbatim: the domain-tagged bytes actually signed
   * are constructed by the wallet itself (see ownershipProof.ts), never handed to it by the site,
   * but the human-readable text is exactly what a site asked the user to vouch for, and the user
   * must see it as-is before approving. */
  | { kind: "signOwnershipProof"; id: string; origin: string; accountId: string; resourceAddress: string; substateId: string; challenge: string }
  /** `tari_signWalletOwnershipChallenge`'s prompt -- same idea as `signOwnershipProof` but for the
   * wallet address itself, not one output, so no resource/substate to show. */
  | { kind: "signWalletOwnershipProof"; id: string; origin: string; accountId: string; walletAddress: string; challenge: string };

// `Omit<PendingApproval, "id">` does not distribute over the union the way you'd want (it loses
// the discriminant), so this is spelled out by hand for requestApproval()'s input.
export type PendingApprovalInput =
  | { kind: "connect"; origin: string; accountId?: string }
  | { kind: "viewAccess"; origin: string; accountId: string }
  | {
      kind: "transaction";
      origin: string;
      instructions: Instruction[];
      maxFee?: string;
      dryRun?: boolean;
      note?: string;
      steps?: string[];
      warning?: string;
      accountId?: string;
      feeChoice?: { enforced: boolean; initial: "private" | "transparent" };
    }
  | { kind: "signOwnershipProof"; origin: string; accountId: string; resourceAddress: string; substateId: string; challenge: string }
  | { kind: "signWalletOwnershipProof"; origin: string; accountId: string; walletAddress: string; challenge: string };

/** What a pending transaction request does to the signing account, found by simulating it
 * (`popup-preview-transaction-request`). Amounts are already formatted for display. */
export interface TransactionPreview {
  /** False when the request couldn't be simulated at all -- `error` says why. */
  simulated: boolean;
  error?: string;
  /** Set when the simulation ran but the engine rejected the transaction. */
  wouldFail?: string;
  outgoing: string[];
  incoming: string[];
  /** Methods other than deposit* that the request calls on the signing account's own component. */
  ownAccountCalls: string[];
  /** For an HTLC claim: the funded output's decrypted value, and any problem the pre-claim check found. */
  htlcValue?: string;
  htlcProblems?: string[];
}
