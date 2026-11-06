/**
 * Shared shapes for the x402 client library. These mirror the wallet extension's own
 * declarations (`src/lib/messages.ts` in the sapient repo) and the facilitator spec
 * (`docs/x402-facilitator.md`) but are declared here independently: this package has
 * zero runtime dependencies and must never import extension internals.
 */

/**
 * The x402 payment-terms envelope — the quote a facilitator hands back on a 402, funds
 * via the wallet's `x402Pay` (an `htlcFund` underneath), and settles via `POST /x402/settle`.
 */
export interface X402Quote {
  /** What was bought. */
  resourceUrl: string;
  /** Optional integrity pin for the served response, 64 hex SHA-256. */
  resourceSha256?: string;
  /** Price, raw integer base units (no decimals/scientific notation). */
  amount: string;
  /** The payment token (XTR). */
  resourceAddress: string;
  /** The merchant's wallet address — the HTLC output's claimant. */
  claimantAddress: string;
  /** SHA-256 of the claim secret, exactly 64 lowercase hex characters. */
  hashLockHex: string;
  /** HTLC refund leaf epoch (a chain epoch). */
  refundEpoch: number;
  /** The indexer's settle endpoint URL. */
  facilitatorUrl: string;
  /** Optional pin of the indexer's identity public key. */
  facilitatorPubKeyHex?: string;
  /** Quote expiry, ms since epoch. */
  expiresAt: number;
  /** Max claim fee, raw base units. */
  maxFee?: string;
}

/**
 * What `pay()` resolves with and persists to `localStorage` (keyed by the quote's
 * `hashLockHex`): everything a caller needs to settle, resume after a reload, or drive
 * `tari_htlcRefund` if the settlement expires. `outputMask` and the
 * `htlcOutputCommitmentHex` + `conditions` pair are relayed out of band by the
 * `x402Pay` result — they cannot be recovered from the chain alone — so a caller that
 * drops this record has no refund path.
 */
export interface X402PaymentRecord {
  /** The wallet-side transaction-request id — resume polling with this after a reload. */
  requestId: string;
  /**
   * The funding transaction's on-chain transaction id (`transactionId` in the wallet's
   * `HtlcFundResult`). The `localDigest`-style "local SHA-256 of sealed BOR bytes"
   * semantics belong only to the `x402SignClaim` result's `txHash`, which `settle()`
   * consumes — not to this funding record.
   */
  txHash: string;
  /** The output mask from the `x402Pay`/`htlcFund` result — required by `htlcRefund`. */
  outputMask: string;
  /** The funded HTLC output's commitment, 64 lowercase hex. */
  htlcOutputCommitmentHex: string;
  /** The exact two-leaf condition tree the funding side produced. */
  conditions: unknown[];
  /** The quote this record paid. */
  quote: X402Quote;
}

/**
 * The wallet's `x402SignClaim` result — the signed, un-broadcast claim payload the
 * merchant side obtains and hands to `settle()`. `txHash` is the locally computed
 * SHA-256 of the sealed envelope's BOR bytes (the wire name in the facilitator
 * interface is `localDigest`); it is not a chain transaction id.
 */
export interface X402SignedClaim {
  /** The sealed, BOR-encoded claim transaction, lowercase hex. */
  signedPayloadHex: string;
  /** SHA-256 of the sealed envelope's BOR bytes — the settlement's idempotency key. */
  txHash: string;
  /** The HTLC output this claim spends (its commitment, 64 lowercase hex). */
  htlcOutputCommitment: string;
  /** The quote's refund epoch, echoed from the envelope. */
  refundEpoch: number;
  /** The last chain epoch at which the claim is admissible: `refundEpoch - 1`. */
  validUntilEpoch: number;
}

/** What `settle()` resolves with once the facilitator has broadcast (or confirmed). */
export interface SettlementResult {
  /** Terminal settlement status. */
  status: "held" | "broadcast" | "confirmed";
  /** The facilitator's own chain transaction id — set once broadcast. */
  chainTxId?: string;
  /** The wallet's local digest the settlement was tracked under. */
  localDigest: string;
}
