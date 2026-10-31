// The tari_getCapabilities report, kept as a pure function (same reasoning as summary.ts and
// x402.ts: no service worker, no browser APIs) so the flag set is unit-testable -- a flag that
// silently flips for the wrong account kind is exactly the kind of regression nothing else in
// this codebase would catch, since background/index.ts itself has no test harness.
// See WalletCapabilities' field docs (lib/messages.ts) for what each flag covers and why the
// local/daemon split lands where it does.
import type { WalletCapabilities } from "../lib/messages";

/**
 * Builds the capabilities for the *connected account*. `isLocal` means a seed-derived
 * `OotleAccount` (the only kind holding the view secret and one-time stealth signing most of the
 * stealth surface needs), `isDaemon` a daemon-relayed `DaemonAccount` (which can do the
 * server-delegated subset), `viewGranted` whether *this site* holds the separate private-view
 * grant (see `ConnectedSite.viewAccessGrantedAt`).
 */
export function walletCapabilities(isLocal: boolean, isDaemon: boolean, viewGranted: boolean): WalletCapabilities {
  return {
    exactInputSelection: true,
    stealthWithdraw: isLocal,
    stealthRedeem: isLocal,
    stealthRedeemPrivateFee: isLocal,
    htlcFund: isLocal,
    scriptPathSpend: isLocal,
    // The sign-only x402 claim build path (background/x402SignOnly.ts), verified live on
    // esmeralda (Phase 5 e2e: happy path settle + frozen-facilitator refund both PASS --
    // claim signed/held/served, refund tx finalized Commit, HTLC output spent). What this
    // flag does NOT claim is delivery proof or facilitator honesty -- see the trust and
    // honesty-semantics section of docs/x402-facilitator.md.
    signOnly: isLocal,
    privateSpend: isLocal || isDaemon,
    shieldFunds: isLocal || isDaemon,
    privateBalanceView: isLocal || isDaemon,
    privateScan: isLocal,
    privateViewGranted: viewGranted,
    transactionResultLookup: true,
    transactionRequests: true,
    walletAddress: true,
    minimumValuePromise: isLocal,
    ownershipProof: isLocal,
    walletOwnershipProof: isLocal,
    confidentialDeposit: isLocal,
    supportsPrivateFees: isLocal,
    dryRunIsLocal: false,
  };
}
