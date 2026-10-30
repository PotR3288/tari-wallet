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
    // The sign-only x402 claim build path (background/x402SignOnly.ts) exists in code today, so
    // this reports honestly for local accounts -- but it has NOT yet been verified against a live
    // testnet round trip. Per the plan, capability flags stay honest about the code while the
    // Phase 5 e2e verification gate is still ahead; revisit this comment once that lands.
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
