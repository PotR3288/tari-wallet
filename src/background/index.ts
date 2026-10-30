import { createWalletSeed, deserializeSeed, importWalletSeed, seedToMnemonic, serializeSeed } from "../lib/cipherSeed";
import { decodeSubstateResponse, decodeTransactionResultResponse } from "../lib/bor";
import { decryptVault, encryptVault } from "../lib/vault";
import {
  addAddressBookEntry,
  addConnectedSite,
  addDaemonAccount,
  addDaemonConnection,
  addTransactionHistoryEntry,
  addTransactionRequest,
  beginTransactionRequestSubmit,
  daemonAccountId,
  getConnectedSite,
  getState,
  getTransactionRequest,
  hasViewAccess,
  listTransactionHistory,
  parseAccountId,
  removeAddressBookEntry,
  removeAllConnectedSites,
  removeConnectedSite,
  removeDaemonAccount,
  removeDaemonConnection,
  setState,
  setTransactionRequestStatus,
  setViewAccess,
  TRANSACTION_REQUEST_TTL_MS,
  type TransactionHistoryEntry,
  type TransactionRequestRecord,
  wipeWallet,
  importedAccountId,
} from "../lib/storage";
import { isNewerVersion } from "../lib/version";
import { decryptSecret } from "../lib/secretAtRest";
import { fromHex as fromHexString, toHex as toHexString } from "../lib/vault";
import { summarizeInstruction } from "../lib/instructionSummary";
import { formatMaxFee } from "../popup/format";
// The approval-popup summary builder (summary.ts): pure, kept out of this file -- same
// reasoning as x402.ts -- so every kind's popup wording is unit-testable without a service worker.
import { approvalAmount, summarizeOperationForApproval, TARI_RESOURCE_ADDRESS } from "./summary";
import { classifyProviderError } from "../lib/messages";
// The x402 validation gate (x402.ts): pure checks, kept out of this file so every rejection path
// is unit-testable without a service worker.
import { validateHtlcFundTerms, validateX402PayTerms, validateX402SignClaimTerms } from "./x402";
import type {
  AccountSummary,
  AccountsChangedBroadcast,
  DaemonAccountOption,
  DappTokenBalance,
  PageRequestMessage,
  PageResponseMessage,
  PendingApprovalInput,
  PopupRequest,
  PrivateBalance,
  PrivatePaymentScanResult,
  ResourceUtxoScanResult,
  ShieldedOutputSummary,
  TransactionRequestOperation,
  TransactionRequestSummary,
  WalletCapabilities,
  WalletStatus,
} from "../lib/messages";
import type { Instruction, SubstateRequirement } from "@tari-project/ootle-ts-bindings";
import { defaultIndexerUrl, isStealthTransferInstruction } from "@tari-project/ootle";
import {
  OotleAccount,
  chromeStorageAdapter,
  listShieldedOutputs,
  parseConsoleWalletBurnProof,
  toHex,
  toOotleNetwork,
  configureOotleStorage,
  getPrivatePaymentScanCursor,
  localAccountId,
  recoverPendingShields,
  resetKnownVersions,
  wipeOotleState,
  type FeeType,
  type WalletAccountApi,
} from "@chironbuilder/ootle-sdk";
import { DaemonAccount } from "../lib/daemonAccount";
import { clearAccountCache, getAccountById, getActiveAccount, getDaemonClient } from "./accounts";
import { clearPendingMnemonic, clearUnlockedSeed, getLastActivity, getPendingMnemonic, getUnlockedSeed, isUnlocked, setPendingMnemonic, setUnlockedSeed, touchActivity } from "./session";
import { canRequestApproval, getPendingApproval, requestApproval, resolveApproval } from "./approvals";
import { shouldAutoLock } from "../lib/autoLock";
import { encryptSecret } from "../lib/secretAtRest";
import { migrateOotleStorageOnce } from "../lib/migrateOotleStorage";
import { syncPublicReceipts } from "./receipts";
import { fetchNftDetails } from "./nftDetails";
import { ownAccountCalls, previewOperation } from "./preview";
import { isSecureDappOrigin } from "../lib/dappOrigin";
import { setTransactionRequestPreviewedHtlcValue } from "../lib/storage";
import type { TransactionPreview } from "../lib/messages";

/** Caps on the scan budgets a dApp may ask for -- each page is one or more indexer round trips. */
const MAX_DAPP_SCAN_PAGES = 20;
const MAX_DAPP_SCAN_PAGE_SIZE = 100;
const clampScan = (n: number | undefined, max: number): number | undefined =>
  typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : undefined;

// Must happen before anything below touches OotleAccount/shielded-output/known-versions storage.
// Synchronous (just sets a module-level variable), so there's no ordering risk with the message
// listener registered right after it. The one-time data migration is fire-and-forget: it only
// backfills data an existing install already had lying around under the old (pre-SDK) storage
// keys, so a message handled before it finishes just sees an empty SDK-side cache momentarily,
// never wrong data.
configureOotleStorage(chromeStorageAdapter());
void migrateOotleStorageOnce();

// chrome.runtime.sendMessage serializes its payload as JSON, not a full structured clone — a
// BigInt anywhere in a response (transaction results, token amounts) makes the whole send fail
// with "could not serialize message" rather than a catchable per-field error. Deep-converting
// every BigInt to a string before handing a result to sendResponse() sidesteps that entirely; nothing
// downstream needs BigInt precision beyond display/round-tripping through a string.
function sanitizeForMessage(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(sanitizeForMessage);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeForMessage(v)]));
  }
  return value;
}

// The approval popup opens one of these (named "approval-keepalive") for as long as it's showing
// a pending approval, purely so this service worker has an open port to hold it awake -- MV3 tears
// a worker down after ~30s with no activity, and a human actually reading a transaction summary
// before clicking Approve routinely takes longer than that. Losing the worker mid-approval doesn't
// just fail this one approval: the deprecated blocking RPCs (`tari_signAndSubmitTransaction` and
// friends, still what most dApps call through window.tari) have their entire suspended call --
// including the `sendResponse` closure the dApp is waiting on -- torn down with it, with no way to
// recover that specific promise (see `createAndWaitToSubmit`'s own comment). The dApp then hangs
// forever awaiting a response that will never come, which for a dApp that also gates "one
// transaction at a time" on that same promise (as tari-market does) locks out every later attempt
// too. Nothing needs to happen in this listener beyond accepting the connection; the open port
// itself is what keeps the worker classified as active.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "approval-keepalive") return;
  port.onDisconnect.addListener(() => {});
});

// Chrome downloads an available update in the background but won't swap it in while the extension
// is in active use (an open popup counts) -- it waits for a natural idle reload, which for a
// wallet extension a user might open daily without ever fully quitting Chrome could be a long
// wait. Persisting the version lets the popup surface "update available, reload to apply" instead
// of the update silently sitting downloaded-but-inert; see buildStatus()'s updateAvailable field
// and popup-reload-extension's handler for the other two ends of this.
chrome.runtime.onUpdateAvailable.addListener((details) => {
  void setState({ pendingUpdateVersion: details.version });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.kind === "tari-page-request") {
    handlePageRequest(message as PageRequestMessage, sender)
      .then((result) =>
        sendResponse({ kind: "tari-page-response", id: message.id, result: sanitizeForMessage(result) } satisfies PageResponseMessage)
      )
      .catch((err) =>
        sendResponse({
          kind: "tari-page-response",
          id: message.id,
          error: classifyProviderError(String(err?.message ?? err)),
        } satisfies PageResponseMessage)
      );
    return true;
  }
  if (message && typeof message.kind === "string" && message.kind.startsWith("popup-")) {
    // Gate on origin, not `sender.tab`: the approval window (approvals.ts's
    // `chrome.windows.create({ type: "popup", url: "popup.html#/approve/..." })`) runs this same
    // popup.html/main.ts bundle, but -- unlike the toolbar popup -- it's a real window with a real
    // tab in it, so `sender.tab` is set for it too. Checking `sender.tab` alone would reject every
    // approval-flow message (connect/approve/reject, transaction approvals, ...), not just ones
    // from a content script. `sender.origin` is what actually distinguishes "one of this
    // extension's own pages" (chrome-extension://<this-id>/...) from a content script's sender,
    // whose origin is always the *page's* origin, never the extension's -- true for the toolbar
    // popup and the approval window alike. A page can never reach this branch at all regardless
    // (chrome.runtime isn't exposed to page scripts, and externally_connectable isn't declared --
    // see inject.ts's relay design); this mainly guards a future content-script bug forwarding a
    // page-supplied `kind` straight through, or a compromised content script reaching a
    // popup-only command directly.
    if (sender.origin !== chrome.runtime.getURL("").slice(0, -1)) {
      sendResponse({ ok: false, error: "Not permitted from this context." });
      return true;
    }
    handlePopupRequest(message as PopupRequest)
      .then((result) => sendResponse({ ok: true, result: sanitizeForMessage(result) }))
      .catch((err) => {
        // Deliberately not logging the error text: a failed popup request's error can embed the
        // user-entered daemon URL, which shouldn't leak into the extension console.
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      });
    return true;
  }
  return false;
});

// ---------------------------------------------------------------------------
// Page (dApp) requests, relayed by the content script
// ---------------------------------------------------------------------------

async function handlePageRequest(message: PageRequestMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const { origin, method, params } = message;

  // Defense in depth on the origin every permission decision below keys off. `origin` comes from
  // the content script's message (it set it from `window.location.origin`), but `sender.origin` is
  // the origin Chrome itself stamped on the sender -- unforgeable from page JS. In the intended
  // design they always agree: a page can't reach this listener at all (chrome.runtime isn't exposed
  // to page scripts and externally_connectable isn't declared -- see inject.ts's relay), only the
  // content script can, and it reports its own frame's origin honestly. Rejecting a mismatch closes
  // off a compromised or buggy content script claiming an origin that isn't its own to borrow
  // another site's connection, view-access grant, or signing authority. Only enforced when
  // `sender.origin` is a concrete string: a sandboxed/opaque-origin frame reports "null" on both
  // sides (still matches), and the rare undefined falls back to the message origin as before.
  if (typeof sender.origin === "string" && sender.origin !== origin) {
    throw new Error("Origin mismatch: the request's origin does not match its sender.");
  }
  // A plain-http page can be rewritten by anyone on the network path, who would then inherit its
  // connection and signing prompts -- only loopback dev servers may use http.
  if (!isSecureDappOrigin(origin)) {
    throw new Error("Sapient only connects to https:// sites (or http://localhost during development).");
  }

  // No page request touches the auto-lock activity clock: a connected tab polling on a timer would
  // otherwise keep the wallet unlocked forever. Only the user's own popup/approval use counts.
  switch (method) {
    case "tari_getNetwork": {
      // No connected-site check on purpose: any page can ask which network this is.
      const { network } = await getState();
      return network;
    }

    case "tari_getAccounts": {
      const site = await getConnectedSite(origin);
      if (!site || !(await isUnlocked())) return [];
      const account = await getAccountById(site.accountId);
      if (!account) return [];
      return [await account.getComponentAddress()];
    }

    case "tari_requestAccounts": {
      if (!(await getState()).vault) throw new Error("No wallet set up in the Tari extension yet.");
      const existing = await getConnectedSite(origin);
      if (existing && (await isUnlocked())) {
        const account = await getAccountById(existing.accountId);
        if (account) return [await account.getComponentAddress()];
      }
      // Captured BEFORE the (arbitrarily long) approval prompt and both shown on it and bound
      // below -- not re-read after it resolves. Otherwise a user who switched the active account
      // while the connect window sat open would approve connecting the account the chip showed but
      // silently bind whichever account is active at click time (same TOCTOU the viewAccess grant
      // already guards against, for the same reason).
      const { activeAccountId } = await getState();
      const approved = await requestApproval({ kind: "connect", origin, accountId: activeAccountId });
      if (!approved) throw new Error("Connection request rejected.");
      // Unlocking (if needed) happens inside the approval popup before it resolves; by the time
      // we get here the wallet must be unlocked or the user closed the window without unlocking.
      if (!(await isUnlocked())) throw new Error("Wallet is locked.");
      await addConnectedSite(origin, activeAccountId);
      const account = await getAccountById(activeAccountId);
      if (!account) throw new Error("Could not resolve account.");
      return [await account.getComponentAddress()];
    }

    case "tari_disconnect": {
      await removeConnectedSite(origin);
      return null;
    }

    // ---- Private view access -----------------------------------------------------------------
    // A read grant over the connected account's confidential position, asked for separately from
    // the connection itself: connecting reveals one public component address, this reveals the
    // whole position the rest of the chain cannot see. See ConnectedSite.viewAccessGrantedAt.

    case "tari_requestViewAccess": {
      const site = await getConnectedSite(origin);
      if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
      if (site.viewAccessGrantedAt !== undefined) return { granted: true };
      const account = await getAccountById(site.accountId);
      if (!account) throw new Error("Wallet is locked.");
      // Refused early, before opening a prompt the user could only answer with a lie, for any
      // account this grant could serve nothing behind at all. A daemon-relayed account no longer
      // qualifies for that blanket refusal -- it can serve tari_getPrivateBalances/
      // tari_getShieldedOutputs (daemon-delegated via its own stealth JRPC), just not the rest of
      // what view access gates (scanForPrivatePayments, scanForResourceUtxos, claimPrivatePayment
      // -- see requireViewAccess, still local-only for those).
      if (!(account instanceof OotleAccount) && !(account instanceof DaemonAccount)) {
        throw new Error("Private view access isn't available for this account.");
      }
      const approved = await requestApproval({ kind: "viewAccess", origin, accountId: site.accountId });
      if (!approved) return { granted: false };
      // Pass the accountId captured before the (arbitrarily long) approval prompt, not a re-read
      // one -- the user may have disconnected this origin, or reconnected it to a *different*
      // account, while the window sat open. setViewAccess is a no-op unless the site's current
      // accountId still matches what was actually shown and approved (see its own doc comment);
      // either way, a stale `{ granted: true }` back to the dApp would be a lie.
      const granted = await setViewAccess(origin, true, site.accountId);
      if (!granted) throw new Error("This site's connection changed before view access could be granted -- ask it to request again.");
      return { granted: true };
    }

    case "tari_getViewAccess": {
      const site = await getConnectedSite(origin);
      if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
      return { granted: site.viewAccessGrantedAt !== undefined };
    }

    case "tari_revokeViewAccess": {
      // No connected-site check and no error for an origin that never had it: giving up a
      // permission you may not hold is idempotent by nature, and a dApp cleaning up after itself
      // shouldn't have to guard the call.
      await setViewAccess(origin, false);
      return null;
    }

    // ---- Confidential reads ------------------------------------------------------------------

    case "tari_getPrivateBalances": {
      const account = await requireViewAccessAnyAccount(origin);
      return (await account.getPrivateBalances()).map(
        (b): PrivateBalance => ({
          resourceAddress: b.resourceAddress,
          amount: b.amount.toString(),
          outputCount: b.outputCount,
          divisibility: b.divisibility,
          symbol: b.symbol,
          name: b.name,
        })
      );
    }

    case "tari_getShieldedOutputs": {
      const account = await requireViewAccessAnyAccount(origin);
      const p = (params ?? {}) as { resourceAddress?: string };
      const records = await account.listUnspentShieldedOutputs(p.resourceAddress);
      // Mapped field by field rather than spread: a ShieldedOutputRecord also carries `accountId`
      // and `spent`, neither of which is any of a dApp's business, and a spread would hand both
      // over the moment a new internal field is added to that record.
      return records.map(
        (r): ShieldedOutputSummary => ({
          resourceAddress: r.resourceAddress,
          commitment: r.commitment,
          amount: r.amount,
          transactionId: r.transactionId,
          createdAt: r.createdAt,
          memo: r.memo,
        })
      );
    }

    case "tari_scanForPrivatePayments": {
      const account = await requireViewAccess(origin);
      const p = (params ?? {}) as { maxPages?: number };
      const { claimed, found } = await account.scanForPrivatePayments(clampScan(p.maxPages, MAX_DAPP_SCAN_PAGES));
      // Same reason the popup's own rescan does this: a scan that discovers real incoming payments
      // must leave a trace in the wallet's own history, not only in the dApp's response.
      const site = await getConnectedSite(origin);
      if (site) await recordPrivatePaymentHistory(site.accountId, found);
      const result: PrivatePaymentScanResult = {
        claimed,
        found: found.map((f) => ({
          resourceAddress: f.resourceAddress,
          commitment: f.commitment,
          amount: f.amount.toString(),
          transactionId: f.transactionId,
          memo: f.memo,
        })),
      };
      return result;
    }

    case "tari_scanForResourceUtxos": {
      const account = await requireViewAccess(origin);
      const p = params as { resourceAddress: string; maxPages?: number; pageSize?: number; limit?: number; transactionIds?: string[] };
      if (!p?.resourceAddress) throw new Error("resourceAddress is required.");
      const found = await account.scanForResourceUtxos(p.resourceAddress, {
        maxPages: clampScan(p.maxPages, MAX_DAPP_SCAN_PAGES),
        pageSize: clampScan(p.pageSize, MAX_DAPP_SCAN_PAGE_SIZE),
        limit: p.limit,
        transactionIds: Array.isArray(p.transactionIds) ? p.transactionIds.slice(0, MAX_DAPP_SCAN_PAGE_SIZE) : undefined,
      });
      const site = await getConnectedSite(origin);
      if (site) await recordPrivatePaymentHistory(site.accountId, found);
      const result: ResourceUtxoScanResult = {
        claimed: found.length,
        found: found.map((f) => ({
          resourceAddress: f.resourceAddress,
          commitment: f.commitment,
          amount: f.amount.toString(),
          transactionId: f.transactionId,
          memo: f.memo,
        })),
      };
      return result;
    }

    case "tari_scanForOwnedUtxos": {
      // Uses the indexer's live UTXO set rather than transaction history, so it finds any output
      // that exists on-chain right now regardless of age or how it was created. Complements
      // tari_scanForPrivatePayments (which walks transaction history) and works without the indexer
      // retaining full history. Requires view access for the same reason: it decrypts outputs with
      // the account's view key.
      const account = await requireViewAccess(origin);
      if (!(account instanceof OotleAccount)) throw new Error("UTXO set scanning is only available for local accounts.");
      const p = params as { resourceAddress: string; mode?: "delta" | "full" };
      if (!p?.resourceAddress) throw new Error("resourceAddress is required.");
      const { network } = await getState();
      const indexerBaseUrl = defaultIndexerUrl(toOotleNetwork(network));
      const { newOutputs, markedSpent } = await account.scanForOwnedUtxos(p.resourceAddress, indexerBaseUrl, { mode: p.mode });
      return { newOutputs, markedSpent };
    }

    case "tari_claimPrivatePayment": {
      const account = await requireViewAccess(origin);
      const p = params as { resourceAddress: string; commitment: string };
      const { amount, memo } = await account.claimPrivatePayment(p.resourceAddress, p.commitment);
      const site = await getConnectedSite(origin);
      if (site) {
        await recordPrivatePaymentHistory(site.accountId, [
          { resourceAddress: p.resourceAddress, amount, transactionId: p.commitment, memo },
        ]);
      }
      return { amount: amount.toString(), memo };
    }

    case "tari_signOwnershipChallenge": {
      const site = await getConnectedSite(origin);
      if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
      const rawAccount = await getAccountById(site.accountId);
      if (!rawAccount) throw new Error("Wallet is locked.");
      const account = requireLocalAccount(rawAccount, "Proving ownership");
      const p = params as { resourceAddress: string; substateId: string; challenge: string };
      if (typeof p.challenge !== "string" || p.challenge.length === 0) {
        throw new Error("challenge must be a non-empty string.");
      }
      const approved = await requestApproval({
        kind: "signOwnershipProof",
        origin,
        accountId: site.accountId,
        resourceAddress: p.resourceAddress,
        substateId: p.substateId,
        challenge: p.challenge,
      });
      if (!approved) throw new Error("Rejected by the user.");
      return account.signOwnershipProof(p.resourceAddress, p.substateId, p.challenge);
    }

    case "tari_signWalletOwnershipChallenge": {
      const site = await getConnectedSite(origin);
      if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
      const rawAccount = await getAccountById(site.accountId);
      if (!rawAccount) throw new Error("Wallet is locked.");
      const account = requireLocalAccount(rawAccount, "Proving wallet ownership");
      const p = params as { challenge: string };
      if (typeof p.challenge !== "string" || p.challenge.length === 0) {
        throw new Error("challenge must be a non-empty string.");
      }
      const walletAddress = await account.getWalletAddress();
      const approved = await requestApproval({
        kind: "signWalletOwnershipProof",
        origin,
        accountId: site.accountId,
        walletAddress,
        challenge: p.challenge,
      });
      if (!approved) throw new Error("Rejected by the user.");
      return account.signWalletOwnership(p.challenge);
    }

    case "tari_getWalletAddress": {
      const site = await getConnectedSite(origin);
      if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
      const account = await getAccountById(site.accountId);
      if (!account) throw new Error("Wallet is locked.");
      return account.getWalletAddress();
    }

    case "tari_getBalances": {
      const site = await getConnectedSite(origin);
      if (!site || !(await isUnlocked())) return [];
      const account = await getAccountById(site.accountId);
      if (!account) return [];
      // The confidential half is withheld unless this site holds the separate view grant -- see
      // ConnectedSite.viewAccessGrantedAt. `privateVisible` is what makes the withheld case
      // distinguishable from a genuine zero; a dApp that reads `confidentialAmount` alone and sees
      // "0" must not be able to conclude the account holds nothing privately.
      const privateVisible = site.viewAccessGrantedAt !== undefined;
      const balances = await account.getBalances();
      return balances.map(
        (b): DappTokenBalance => ({
          resourceAddress: b.resourceAddress,
          kind: b.kind,
          amount: b.amount.toString(),
          confidentialAmount: privateVisible ? b.confidentialAmount.toString() : "0",
          privateVisible,
          divisibility: b.divisibility,
          symbol: b.symbol,
          name: b.name,
        })
      );
    }

    case "tari_getSubstate": {
      const site = await getConnectedSite(origin);
      if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
      const account = await getAccountById(site.accountId);
      if (!account) throw new Error("Wallet is locked.");
      const p = params as { substateId: string; version?: number | null };
      const provider = await account.getProvider();
      const response = await provider.getSubstate(p.substateId, p.version ?? null);
      // 0.48+ indexers serve the value as base64 CBOR; dApps get the decoded JSON value as before.
      return decodeSubstateResponse(response);
    }

    case "tari_getCapabilities": {
      const site = await getConnectedSite(origin);
      if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
      const account = await getAccountById(site.accountId);
      if (!account) throw new Error("Wallet is locked.");
      // Some stealth-touching features need this account's own view secret and one-time stealth
      // signing, which only a seed-derived local account has (see WalletDaemonSigner's doc
      // comment) -- those stay `isLocal`-only below. Others (shield/unshield/sendPrivately/balance
      // reads) the daemon can do entirely server-side instead, so they're `isLocal || isDaemon` --
      // see each field's own doc comment in messages.ts for which is which.
      const isLocal = account instanceof OotleAccount;
      const isDaemon = account instanceof DaemonAccount;
      const capabilities: WalletCapabilities = {
        exactInputSelection: true,
        stealthWithdraw: isLocal,
        stealthRedeem: isLocal,
        stealthRedeemPrivateFee: isLocal,
        htlcFund: isLocal,
        scriptPathSpend: isLocal,
        privateSpend: isLocal || isDaemon,
        shieldFunds: isLocal || isDaemon,
        privateBalanceView: isLocal || isDaemon,
        privateScan: isLocal,
        privateViewGranted: site.viewAccessGrantedAt !== undefined,
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
      return capabilities;
    }

    case "tari_getTransactionResult": {
      const site = await getConnectedSite(origin);
      if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
      const account = await getAccountById(site.accountId);
      if (!account) throw new Error("Wallet is locked.");
      const p = params as { transactionId: string };
      const provider = await account.getProvider();
      return decodeTransactionResultResponse(await provider.getTransactionResult(p.transactionId));
    }

    // Deprecated (see messages.ts): a thin wrapper over createTransactionRequest +
    // submitTransactionRequestOperation, blocking for the whole round trip like it always has.
    case "tari_signAndSubmitTransaction": {
      const site = await getConnectedSite(origin);
      if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
      const p = params as { instructions: Instruction[]; maxFee?: string; dryRun?: boolean; inputs?: SubstateRequirement[] };
      assertNoStealthTransferInstruction(p.instructions);
      // Dry runs are read-only simulations (quotes, balance-adjacent lookups) — a DEX price quote
      // that reprices on every keystroke would otherwise pop an approval window per keystroke.
      // Only a real submission spends anything, so only that needs the user's sign-off; dry runs
      // never go through the request/approval system at all, deprecated or not.
      if (p.dryRun) {
        if (!(await isUnlocked())) throw new Error("Wallet is locked.");
        const account = await getAccountById(site.accountId);
        if (!account) throw new Error("Could not resolve account.");
        const maxFee = p.maxFee ? BigInt(p.maxFee) : undefined;
        return account.execute(p.instructions, { maxFee, dryRun: true, inputs: p.inputs });
      }
      const operation: TransactionRequestOperation = {
        kind: "instructions",
        instructions: p.instructions,
        maxFee: p.maxFee,
        inputs: p.inputs,
      };
      return createAndWaitToSubmit(origin, site.accountId, operation);
    }

    // Deprecated (see messages.ts). The only way for a connected dApp to move Stealth-typed funds
    // (e.g. TARI) into its own contract call — `tari_signAndSubmitTransaction`'s `account.execute()`
    // cannot: a plain `CallMethod withdraw` on a Stealth vault is not a standalone-valid instruction
    // (confirmed: fails client-side with a generic `TransactionInput` deserialization error, even
    // alone with no other instructions). See `OotleAccount.withdrawStealthAndExecute`'s own doc
    // comment for the full story.
    case "tari_withdrawStealthAndExecute": {
      const site = await getConnectedSite(origin);
      if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
      const p = params as {
        resourceAddress: string;
        amount: string;
        workspaceVarName: string;
        followUpInstructions: Instruction[];
        relatedComponents?: string[];
        maxFee?: string;
      };
      const operation: TransactionRequestOperation = { kind: "withdrawStealthAndExecute", ...p };
      return createAndWaitToSubmit(origin, site.accountId, operation);
    }

    // Deprecated (see messages.ts). See `OotleAccount.htlcFund`'s doc comment: fund-only for now
    // (no way to claim/refund yet).
    case "tari_htlcFund": {
      const site = await getConnectedSite(origin);
      if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
      const p = params as {
        resourceAddress: string;
        amount: string;
        claimantWalletAddress: string;
        hashLockHex: string;
        refundEpoch: string;
        maxFee?: string;
      };
      // The dApp-entry half of the audit fix (security-audit-deepseek-v4-pro.md §2): the SDK's own
      // `htlcFund` validation is internal to the ootle-sdk and untouchable from this repo, so the
      // raw `hashLockHex`/`refundEpoch` a dApp hands over are tightened here, at this repo's
      // boundary, through the same helper the x402Pay gate uses (see x402.ts).
      validateHtlcFundTerms(p);
      const operation: TransactionRequestOperation = { kind: "htlcFund", ...p };
      return createAndWaitToSubmit(origin, site.accountId, operation);
    }

    case "tari_createTransactionRequest": {
      const site = await getConnectedSite(origin);
      if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
      const operation = params as TransactionRequestOperation;
      if (operation.kind === "instructions") assertNoStealthTransferInstruction(operation.instructions);
      if (operation.kind === "htlcFund") {
        // Same tightening as the deprecated `tari_htlcFund` wrapper above, at the second way a
        // dApp can hand over raw HTLC terms -- one helper, both entries (see x402.ts).
        validateHtlcFundTerms(operation);
      }
      if (operation.kind === "x402Pay") {
        // The x402 validation gate's static pass: everything checkable without the chain, so a
        // malformed envelope is refused before anything is persisted or an approval window is
        // popped. The live pass (refund epoch still future, quote not expired) reruns at submit
        // time in `submitApprovedTransactionRequest`, right before the execution switch.
        validateX402PayTerms(operation);
      }
      if (operation.kind === "x402SignClaim") {
        // Same fail-fast rule for the settlement side: the sign-claim gate's static pass (quote
        // terms, preimage-hash, relayed-conditions-vs-quote, structural field set) runs before
        // anything is persisted; the live refund-epoch pass runs inside `buildSignedX402Claim`
        // at submit time, against the chain epoch.
        validateX402SignClaimTerms(operation);
      }
      if ("enforceFeeType" in operation && operation.enforceFeeType && !operation.feeType) {
        throw new Error("enforceFeeType requires feeType to also be set.");
      }
      const { requestId } = await createTransactionRequest(origin, site.accountId, operation);
      return { requestId };
    }

    case "tari_getTransactionRequest": {
      const site = await getConnectedSite(origin);
      if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
      const p = params as { requestId: string };
      const record = await getTransactionRequest(p.requestId);
      if (!record || record.origin !== origin) throw new Error("Unknown transaction request.");
      return toTransactionRequestSummary(record);
    }

    case "tari_submitTransactionRequest": {
      const site = await getConnectedSite(origin);
      if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
      const p = params as { requestId: string };
      const record = await getTransactionRequest(p.requestId);
      if (!record || record.origin !== origin) throw new Error("Unknown transaction request.");
      // The request was bound to whichever account the site was connected to when it was created
      // (record.accountId, set at createTransactionRequest time). If the site has since reconnected
      // under a different account (e.g. the user switched accounts in the extension, which drops
      // every connection, then re-approved this site), the approved request must not spend from an
      // account the site is no longer bound to -- it would otherwise silently move funds from the
      // *old* account even though the site is now connected to a different one.
      if (record.accountId !== site.accountId) {
        throw new Error("This transaction request belongs to a different account — switch back to that account or create a new request.");
      }
      return submitApprovedTransactionRequest(p.requestId);
    }

    default:
      throw new Error(`Unknown method: ${method satisfies never}`);
  }
}

// ---------------------------------------------------------------------------
// Transaction requests: create -> (popup approval) -> submit
//
// Shared by both the new tari_createTransactionRequest/tari_getTransactionRequest/
// tari_submitTransactionRequest RPCs and the deprecated single-call RPCs (tari_
// signAndSubmitTransaction/tari_withdrawStealthAndExecute/tari_htlcFund), which are thin wrappers
// over the same primitives -- see messages.ts's TransactionRequestOperation doc comment.
// ---------------------------------------------------------------------------

// account.execute() only builds/signs/seals via TransactionBuilder -- it never runs
// WalletStealthAuthorizer, so it can't produce the balance proof or per-input one-time
// authorizations a real StealthTransfer instruction needs. The engine would reject an incomplete
// statement anyway (no fund-loss risk), but failing fast with a clear message beats a confusing
// late rejection, and skips popping an approval window for a tx that can never succeed via this
// path.
function assertNoStealthTransferInstruction(instructions: Instruction[]): void {
  if (instructions.some(isStealthTransferInstruction)) {
    throw new Error(
      "A raw StealthTransfer instruction can't be submitted through a connected app — the wallet has to build it. " +
        'Use tari_createTransactionRequest with one of the private-spend kinds instead ("shield", "unshield", "sendPrivately", "htlcFund", "htlcClaim", "htlcRefund").'
    );
  }
}

/**
 * The single gate in front of every confidential *read* RPC: resolves the connected account,
 * insisting on all three of a live connection, the site's explicit private view grant (see
 * `ConnectedSite.viewAccessGrantedAt`), and a seed-derived local account -- the only kind holding
 * the view secret these reads decrypt with.
 *
 * The three failures are deliberately distinct messages rather than one generic denial: a dApp
 * handling "ask for the grant", "ask the user to unlock", and "this account can never do this"
 * identically would be stuck in a prompt loop for the last of them.
 */
async function requireViewAccessAccount(origin: string): Promise<WalletAccountApi> {
  const site = await getConnectedSite(origin);
  if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
  if (site.viewAccessGrantedAt === undefined) {
    throw new Error("This site doesn't have private view access. Call tari_requestViewAccess first.");
  }
  const account = await getAccountById(site.accountId);
  if (!account) throw new Error("Wallet is locked.");
  return account;
}

async function requireViewAccess(origin: string): Promise<OotleAccount> {
  const account = await requireViewAccessAccount(origin);
  if (!(account instanceof OotleAccount)) {
    throw new Error("Reading private balances isn't available for daemon-connected accounts — switch to a local account first.");
  }
  return account;
}

/** Like `requireViewAccess`, but for the subset of private-read operations `DaemonAccount` also
 * implements (`getPrivateBalances`/`listUnspentShieldedOutputs`, both daemon-delegated via its own
 * stealth JRPC) -- everything else gated by `requireViewAccess` itself (scanForPrivatePayments,
 * scanForResourceUtxos, claimPrivatePayment) has no daemon-side equivalent yet, so those stay
 * local-only. */
async function requireViewAccessAnyAccount(origin: string): Promise<OotleAccount | DaemonAccount> {
  const account = await requireViewAccessAccount(origin);
  if (!(account instanceof OotleAccount) && !(account instanceof DaemonAccount)) {
    throw new Error("Reading private balances isn't available for this account.");
  }
  return account;
}


/** The transaction-history `counterparty` label for `operation` -- one case per kind, matching
 * exactly what each of the three deprecated RPCs recorded before they became wrappers. */
function operationHistoryLabel(origin: string, operation: TransactionRequestOperation): string {
  switch (operation.kind) {
    case "instructions": {
      const summary = operation.instructions.map((i) => summarizeInstruction(i).title).join(", ");
      return `${origin}: ${summary}`;
    }
    case "withdrawStealthAndExecute": {
      const summary = operation.followUpInstructions.map((i) => summarizeInstruction(i).title).join(", ");
      return `${origin}: reveal + ${summary}`;
    }
    case "redeemStealthOutputAndExecute": {
      const summary = operation.followUpInstructions.map((i) => summarizeInstruction(i).title).join(", ");
      return `${origin}: redeem + ${summary}`;
    }
    case "redeemStealthOutputWithPrivateFee": {
      const summary = operation.followUpInstructions.map((i) => summarizeInstruction(i).title).join(", ");
      return `${origin}: private redeem + ${summary}`;
    }
    case "htlcFund":
      return `${origin}: HTLC fund -> ${operation.claimantWalletAddress}`;
    case "x402Pay":
      return `${origin}: x402 payment -> ${operation.claimantAddress}`;
    case "x402SignClaim":
      return `${origin}: x402 claim (sign only) -> ${operation.envelope.resourceUrl}`;
    case "shield":
      return `${origin}: shield`;
    case "depositConfidential":
      return `${origin}: deposit confidential`;
    case "unshield":
      return `${origin}: unshield`;
    case "sendPrivately":
      return `${origin}: private send -> ${operation.recipientWalletAddress}`;
    case "htlcClaim":
      return `${origin}: HTLC claim`;
    case "htlcRefund":
      return `${origin}: HTLC refund`;
  }
}

function toTransactionRequestSummary(record: TransactionRequestRecord): TransactionRequestSummary {
  return {
    requestId: record.id,
    status: record.status,
    note: record.note,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    result: record.result,
    error: record.error,
  };
}

/**
 * Persists a `TransactionRequestRecord` (status "pending") and fires off — without awaiting — the
 * same popup approval every transaction always required, sharing the approval's id with the
 * record's id (see approvals.ts's `requestApproval` doc comment) so the popup's click updates this
 * exact record. Returns immediately; `approved` resolves later, whenever the user actually clicks
 * — callers that need to block on it (the deprecated wrappers) await it themselves.
 */
async function createTransactionRequest(
  origin: string,
  accountId: string,
  operation: TransactionRequestOperation
): Promise<{ requestId: string; approved: Promise<boolean> }> {
  const requestId = crypto.randomUUID();
  const divisibility =
    "resourceAddress" in operation ? (await resolveResourceMeta(operation.resourceAddress))?.divisibility : undefined;
  const { instructions, steps, warning } = summarizeOperationForApproval(operation, divisibility);
  // The persisted record's `note` (also `TransactionRequestSummary.note` -- the dApp-facing text
  // from `tari_getTransactionRequest`) stays a single flat string for API stability; the popup
  // gets the structured `steps`/`warning` below instead, so it can render each fact on its own
  // line and the promise disclosure in its own highlighted box.
  const note = [...(steps ?? []), warning].filter(Boolean).join(" ");
  // Formatted as a human TARI amount here, not shown raw: the approval popup renders this string
  // verbatim (`approval.maxFee`), and fees are always paid in TARI -- see formatMaxFee.
  const rawMaxFee = "maxFee" in operation ? operation.maxFee : undefined;
  const maxFee = rawMaxFee !== undefined ? formatMaxFee(rawMaxFee) : undefined;
  // Refused before anything is persisted: a refused request must not take a slot in the capped
  // request list, or a spamming site could push other sites' approved requests out of it.
  if (!canRequestApproval(origin)) throw new Error("Too many requests are waiting for approval -- answer those first.");
  const now = Date.now();
  const record: TransactionRequestRecord = {
    id: requestId,
    origin,
    accountId,
    network: (await getState()).network,
    operation,
    note,
    status: "pending",
    createdAt: now,
    expiresAt: now + TRANSACTION_REQUEST_TTL_MS,
  };
  // Written before the approval popup can possibly be interacted with, so resolveApproval's dual
  // write (background/approvals.ts) always finds this record -- there is no window where the user
  // could click before it exists.
  await addTransactionRequest(record);
  // Absent for `redeemStealthOutputWithPrivateFee` (no `feeType` field -- already always private),
  // for `x402Pay` (a payment-terms envelope, not a dApp-authored spend -- the fee is this
  // wallet's own transparent default) and for `x402SignClaim` (the sign-only build path fixes
  // the fee to the transparent lane by construction). Otherwise seeded from the dApp's own
  // `feeType` hint if it gave one, else this wallet's own default -- `enforced` locks the popup's
  // toggle instead of letting the user change it (background/index.ts's
  // `tari_createTransactionRequest` handler already required `feeType` be set whenever
  // `enforceFeeType` is).
  const feeChoice =
    operation.kind === "redeemStealthOutputWithPrivateFee" || operation.kind === "x402Pay" || operation.kind === "x402SignClaim"
      ? undefined
      : {
          enforced: operation.enforceFeeType === true,
          initial: operation.feeType ?? (await getState()).feePrivacyDefault,
        };
  const approval: PendingApprovalInput = { kind: "transaction", origin, instructions, maxFee, note, steps, warning, accountId, feeChoice };
  const approved = requestApproval(approval, requestId);
  return { requestId, approved };
}

/**
 * Narrows an account to the seed-derived kind every stealth-touching operation needs (a
 * daemon-relayed account has no view secret and can't produce one-time stealth signatures -- see
 * `WalletDaemonSigner`'s doc comment), or throws naming the operation that wanted it. Written once
 * here rather than per-case so a new stealth operation can't quietly ship without the check.
 */
function requireLocalAccount(account: WalletAccountApi, what: string): OotleAccount {
  if (!(account instanceof OotleAccount)) {
    throw new Error(`${what} isn't available for daemon-connected accounts — switch to a local account first.`);
  }
  return account;
}

/**
 * Like `requireLocalAccount`, but for the popup-triggered stealth operations (`popup-shield`/
 * `popup-unshield`/`popup-send-privately`) that a `DaemonAccount` can *also* perform server-side --
 * narrows to whichever of the two concrete classes `account` actually is, or throws naming the
 * operation that wanted it. `what` reads as a gerund (e.g. "Shielding", "Sending privately") to fit
 * "<what> isn't available for this account.".
 */
function requireLocalOrDaemonAccount(account: WalletAccountApi, what: string): OotleAccount | DaemonAccount {
  if (!(account instanceof OotleAccount) && !(account instanceof DaemonAccount)) {
    throw new Error(`${what} isn't available for this account.`);
  }
  return account;
}

/**
 * A daemon-relayed account has no local stealth-fee support (see `resolveFeeType`'s own doc
 * comment) -- shared by every stealth operation `submitApprovedTransactionRequest` lets a
 * `DaemonAccount` perform (`shield`/`unshield`/`sendPrivately`), so a `feeType: "private"` request
 * fails with the same clear error regardless of which one asked for it.
 */
function rejectPrivateFeeForDaemon(feeType: "private" | "transparent" | undefined, what: string): void {
  if (feeType === "private") {
    throw new Error(
      `Paying a private fee isn't available for daemon-connected accounts (needed for ${what}) — use a transparent fee or switch to a local account.`
    );
  }
}

/**
 * Resolves an operation's already-decided `feeType` ("private" | "transparent" | absent, set at
 * approval time — see `resolveApproval`'s own doc comment) into the SDK's `FeeType` shape.
 *
 * A daemon-relayed account has no local stealth-fee support (`OotleAccount`'s `feeType: "private"`
 * builds and signs a `StealthTransfer` fee spend itself; a `DaemonAccount` only relays to
 * `tari_ootle_walletd`, which this doesn't talk to) — same reasoning as `requireLocalAccount`,
 * reused here so both give the same style of error naming what needs a local account.
 *
 * "private" needs a `feeResourceAddress` the dApp never supplies (only the wallet's own fee
 * resource is meaningful here, almost always TARI) — found the same way the wallet's own send UI
 * does: the balance whose `symbol` is `"TARI"`.
 */
async function resolveFeeType(account: WalletAccountApi, feeType: "private" | "transparent" | undefined): Promise<FeeType> {
  if (feeType !== "private") return { kind: "transparent" };
  requireLocalAccount(account, "Paying a private fee");
  // TARI_RESOURCE_ADDRESS is a fixed, well-known constant -- no balance lookup needed, and
  // `getBalances()` (revealed/vault balances) would be the wrong thing to check anyway: it can
  // come back with no TARI entry at all for an account holding TARI purely as shielded UTXOs (no
  // revealed vault ever touched), which is exactly the kind of account most likely to want a
  // private fee. Whether there's actually a shielded UTXO big enough to pay from is
  // ootle-sdk-ts's own concern (`selectPrivateFeeUtxo`, surfaced as its own clear error if not).
  return { kind: "private", feeResourceAddress: TARI_RESOURCE_ADDRESS };
}

/**
 * Submits a transaction request through the storage-level claim gate: atomically moves the record
 * from "approved" to "submitting" BEFORE anything executes (beginTransactionRequestSubmit), runs
 * the operation via the matching account method, and settles the persisted status to
 * "submitted"+result or "failed"+error afterwards. The pre-execution claim is what makes
 * submission safe against concurrency: two simultaneous submits (or a submit racing the
 * deprecated blocking wrapper over the same record) cannot both pass the gate -- exactly one wins,
 * the other fails with "wrong-status" instead of double-executing. Shared by
 * `tari_submitTransactionRequest` and every deprecated wrapper's final step.
 */
async function submitApprovedTransactionRequest(requestId: string): Promise<unknown> {
  // Checked before claiming so a locked wallet can't strand the record in "submitting" with no
  // execution ever following.
  if (!(await isUnlocked())) throw new Error("Wallet is locked.");
  // An approval is for one network: refused before the claim so the record stays answerable.
  const pre = await getTransactionRequest(requestId);
  if (pre?.network && pre.network !== (await getState()).network) {
    throw new Error(`This request was approved on ${pre.network}; switch back to that network or create a new request.`);
  }
  const outcome = await beginTransactionRequestSubmit(requestId);
  if (!outcome.claimed) {
    switch (outcome.reason) {
      case "not-found":
        throw new Error("Unknown transaction request.");
      case "expired":
        throw new Error("This transaction request expired before it was submitted.");
      case "wrong-status":
        throw new Error(`Cannot submit: this request's status is "${outcome.record!.status}".`);
    }
  }
  const record = outcome.record;
  const account = await getAccountById(record.accountId);
  if (!account) throw new Error("Could not resolve account.");
  const operation = record.operation;
  // `x402SignClaim`'s fee is nested in its `envelope` (and fixed to the transparent lane by the
  // sign-only build path itself), so it is not among the kinds with a top-level `maxFee`.
  const maxFee = "maxFee" in operation && operation.maxFee !== undefined ? BigInt(operation.maxFee) : undefined;

  // `redeemStealthOutputWithPrivateFee`, `x402Pay` and `x402SignClaim` carry no `feeType` field
  // (the first is always private; `x402Pay` is a payment-terms envelope whose fee is this
  // wallet's own transparent default; `x402SignClaim`'s fee is fixed to the transparent lane --
  // background/x402SignOnly.ts's module header) -- every other kind resolves whatever `feeType`
  // approval settled on.
  const feeType =
    operation.kind === "redeemStealthOutputWithPrivateFee" || operation.kind === "x402Pay" || operation.kind === "x402SignClaim"
      ? undefined
      : operation.feeType;

  const doExecute = async (): Promise<unknown> => {
    // The x402 validation gate's live pass: the refund epoch must still be in the future and the
    // facilitator's quote must not have expired -- checked against the chain RIGHT HERE, before
    // the execution switch, not just at request-creation time (a quote can lapse while it sits
    // pending). The current epoch comes from the indexer provider the `htlcFund` this executes as
    // would use anyway; no epoch cadence is assumed (see validateX402PayTerms' own doc comment for
    // how the plan's "~60 minutes of epochs" bound resolved).
    if (operation.kind === "x402Pay") {
      const local = requireLocalAccount(account, "Funding an HTLC");
      const currentEpoch = await (await local.getProvider()).getCurrentEpoch();
      validateX402PayTerms(operation, { currentEpoch, nowMs: Date.now() });
    }
    // These kinds exist to spend one bounded amount (the revealed bucket); their follow-up
    // instructions run under this account's own signature, so a withdraw (or any non-deposit call)
    // on the account itself would spend beyond what the approval stated.
    if (
      operation.kind === "withdrawStealthAndExecute" ||
      operation.kind === "redeemStealthOutputAndExecute" ||
      operation.kind === "redeemStealthOutputWithPrivateFee"
    ) {
      const calls = ownAccountCalls(operation.followUpInstructions, await account.getComponentAddress());
      if (calls.length > 0) {
        throw new Error(`Refused: this request's follow-up instructions call "${calls[0]}" on your own account, which this kind of request may not do.`);
      }
    }
    switch (operation.kind) {
      case "instructions":
        return account.execute(operation.instructions, {
          maxFee,
          inputs: operation.inputs,
          feeType: await resolveFeeType(account, feeType),
        });
      case "withdrawStealthAndExecute": {
        // Needs this account's own view secret + one-time stealth signing (SecretKeyWallet), same
        // as shield()/unshield() — a daemon-relayed account can't provide either (see
        // WalletDaemonSigner's own doc comment).
        const local = requireLocalAccount(account, "Withdrawing stealth funds");
        return local.withdrawStealthAndExecute(
          operation.resourceAddress,
          BigInt(operation.amount),
          operation.workspaceVarName,
          operation.followUpInstructions,
          operation.relatedComponents ?? [],
          maxFee,
          await resolveFeeType(local, feeType)
        );
      }
      case "redeemStealthOutputAndExecute": {
        // Same account requirement as withdrawStealthAndExecute -- see its own comment above.
        const local = requireLocalAccount(account, "Redeeming a stealth token");
        return local.redeemStealthOutputAndExecute(
          operation.resourceAddress,
          operation.commitmentHex,
          BigInt(operation.revealedAmount),
          operation.followUpInstructions,
          operation.relatedComponents ?? [],
          maxFee,
          await resolveFeeType(local, feeType)
        );
      }
      case "redeemStealthOutputWithPrivateFee":
        // Same account requirement as withdrawStealthAndExecute -- see its own comment above.
        // Already always a private fee -- no feeType to resolve here.
        return requireLocalAccount(account, "Redeeming a stealth token privately").redeemStealthOutputWithPrivateFee(
          operation.resourceAddress,
          operation.commitmentHex,
          BigInt(operation.revealedAmount),
          operation.followUpInstructions,
          operation.feeResourceAddress,
          operation.feeCommitmentHex,
          BigInt(operation.maxFee),
          operation.relatedComponents ?? []
        );
      // `x402Pay` is the same HTLC fund underneath (see its doc comment in messages.ts): the
      // envelope's `claimantAddress`/`refundEpoch` map straight onto `htlcFund`'s fields, sharing
      // this one builder path -- no duplicated HTLC logic. It falls through into the `htlcFund`
      // case body via the shared `claimant`/`refundEpoch` locals below.
      case "x402Pay":
      case "htlcFund": {
        // See tari_withdrawStealthAndExecute's own comment: only a seed-derived local account can
        // build the PayTo::Conditions output witness this needs.
        const local = requireLocalAccount(account, "Funding an HTLC");
        // `x402Pay` carries `refundEpoch` as a number, `htlcFund` as a string -- `BigInt` takes
        // both, so the shared call site below needs no conversion either way.
        const claimant = operation.kind === "x402Pay" ? operation.claimantAddress : operation.claimantWalletAddress;
        return local.htlcFund(
          operation.resourceAddress,
          BigInt(operation.amount),
          claimant,
          operation.hashLockHex,
          BigInt(operation.refundEpoch),
          maxFee,
          await resolveFeeType(local, feeType)
        );
      }
      // Private spends. Each defers entirely to the OotleAccount method of the same name -- the
      // dApp never sees a mask, a view secret, or which specific UTXOs get spent (coin selection is
      // the wallet's own decision, from its own local ledger of stealth outputs). Same
      // local-account requirement as everything else stealth-touching.
      case "shield": {
        if (account instanceof DaemonAccount) {
          rejectPrivateFeeForDaemon(feeType, "shielding funds");
          return account.shield(
            operation.resourceAddress,
            BigInt(operation.amount),
            maxFee,
            operation.memo,
            operation.minimumValuePromise !== undefined ? BigInt(operation.minimumValuePromise) : 0n
          );
        }
        const local = requireLocalAccount(account, "Shielding funds");
        return local.shield(
          operation.resourceAddress,
          BigInt(operation.amount),
          maxFee,
          operation.memo,
          operation.minimumValuePromise !== undefined ? BigInt(operation.minimumValuePromise) : 0n,
          await resolveFeeType(local, feeType)
        );
      }
      case "depositConfidential": {
        const local = requireLocalAccount(account, "Depositing into a Confidential vault");
        return local.depositConfidential(operation.resourceAddress, BigInt(operation.amount), maxFee, await resolveFeeType(local, feeType));
      }
      case "unshield": {
        if (account instanceof DaemonAccount) {
          rejectPrivateFeeForDaemon(feeType, "unshielding funds");
          return account.unshield(operation.resourceAddress, BigInt(operation.revealedAmount), maxFee, operation.memo);
        }
        const local = requireLocalAccount(account, "Unshielding funds");
        return local.unshield(
          operation.resourceAddress,
          BigInt(operation.revealedAmount),
          maxFee,
          operation.memo,
          await resolveFeeType(local, feeType)
        );
      }
      case "sendPrivately": {
        if (account instanceof DaemonAccount) {
          rejectPrivateFeeForDaemon(feeType, "sending privately");
          return account.sendPrivately(
            operation.resourceAddress,
            operation.recipientWalletAddress,
            BigInt(operation.amount),
            maxFee,
            operation.memo,
            operation.minimumValuePromise !== undefined ? BigInt(operation.minimumValuePromise) : 0n
          );
        }
        const local = requireLocalAccount(account, "Sending privately");
        return local.sendPrivately(
          operation.resourceAddress,
          operation.recipientWalletAddress,
          BigInt(operation.amount),
          maxFee,
          operation.memo,
          operation.minimumValuePromise !== undefined ? BigInt(operation.minimumValuePromise) : 0n,
          await resolveFeeType(local, feeType)
        );
      }
      case "htlcClaim": {
        const local = requireLocalAccount(account, "Claiming an HTLC");
        return local.htlcClaim(
          operation.resourceAddress,
          operation.commitment,
          operation.conditions,
          operation.preimageHex,
          maxFee,
          await resolveFeeType(local, feeType),
          // The amount the approval screen showed, when it showed one: the pre-claim check then
          // refuses to reveal the preimage for an output worth anything else.
          record.previewedHtlcValue !== undefined ? { expected: { amount: BigInt(record.previewedHtlcValue) } } : {}
        );
      }
      case "htlcRefund": {
        const local = requireLocalAccount(account, "Refunding an HTLC");
        return local.htlcRefund(
          operation.resourceAddress,
          operation.commitment,
          operation.conditions,
          BigInt(operation.amount),
          operation.outputMask,
          maxFee,
          await resolveFeeType(local, feeType)
        );
      }
    }
  };

  const counterparty = operationHistoryLabel(record.origin, operation);
  try {
    const result = await withHistory({ accountId: record.accountId, kind: "dapp-transaction", counterparty }, doExecute);
    await setTransactionRequestStatus(record.id, { status: "submitted", result: sanitizeForMessage(result) });
    return result;
  } catch (e) {
    await setTransactionRequestStatus(record.id, { status: "failed", error: String(e instanceof Error ? e.message : e) });
    throw e;
  }
}

/**
 * Waits for a transaction request to leave "pending", the same way `createAndWaitToSubmit`
 * always has -- except it doesn't trust the in-memory `approved` promise alone. That promise's
 * resolver lives only in this service worker instance's memory (`approvals.ts`'s `pending` Map);
 * if Chrome tears the MV3 worker down mid-approval (it does this after ~30s idle, and a human
 * actually reading a transaction summary easily takes longer), the resolver is gone for good even
 * though the click itself still lands -- `resolveApproval` writes the decision through
 * `chrome.storage` regardless of whether an in-memory waiter exists. Racing `approved` against a
 * poll of that same persisted record means the fast path (worker survives, common case) resolves
 * exactly as before with no added latency, while a restart is recovered by the poll noticing the
 * record moved to "approved"/"rejected" instead of hanging forever -- which otherwise strands not
 * just this call but every future one, since a dApp's own "one transaction at a time" guard has no
 * way to know this one will never finish.
 */
async function waitForApprovalDecision(requestId: string, approved: Promise<boolean>): Promise<boolean> {
  let stopped = false;
  const poll = (async (): Promise<boolean> => {
    while (!stopped) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (stopped) break;
      const record = await getTransactionRequest(requestId);
      if (!record || record.status === "rejected" || record.status === "failed") return false;
      if (record.status === "approved" || record.status === "submitting" || record.status === "submitted") return true;
    }
    return false;
  })();
  try {
    return await Promise.race([approved, poll]);
  } finally {
    stopped = true;
  }
}

/** The deprecated-RPC path: create, block until the user responds (exactly like these methods
 * always blocked), then submit through the same atomic claim gate as
 * `tari_submitTransactionRequest` -- which also closes the old gap where an approval granted after
 * the request sat past its TTL still submitted (the gate rejects an expired "approved" record). */
async function createAndWaitToSubmit(origin: string, accountId: string, operation: TransactionRequestOperation): Promise<unknown> {
  const { requestId, approved } = await createTransactionRequest(origin, accountId, operation);
  if (!(await waitForApprovalDecision(requestId, approved))) throw new Error("Transaction rejected.");
  return submitApprovedTransactionRequest(requestId);
}

/**
 * Pushes a `tari-accounts-changed` message to every tab's content script (which forwards it into
 * the page as a `tari#accountsChanged` DOM event — see inject.ts). Broadcasts blind to every tab
 * rather than filtering by which origins were actually connected: reading a tab's URL to filter
 * would need either the `tabs` permission or a host-permission match, and a page that was never
 * connected simply has nothing listening for this event, so there's no harm in it arriving.
 */
async function broadcastAccountsChanged(accounts: string[]): Promise<void> {
  const tabs = await chrome.tabs.query({});
  const message: AccountsChangedBroadcast = { kind: "tari-accounts-changed", accounts };
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    // Most tabs have no content script (chrome://, extension pages, other origins mid-navigation)
    // — sendMessage rejects with "Receiving end does not exist" for those, which is expected and
    // not worth surfacing.
    chrome.tabs.sendMessage(tab.id, message).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Popup requests
// ---------------------------------------------------------------------------

async function buildStatus(): Promise<WalletStatus> {
  const state = await getState();
  const unlocked = await isUnlocked();
  let address: string | null = null;
  let receiveAddress: string | null = null;
  let activeAccountError: string | null = null;
  let lastKnownAddress = state.lastKnownAddress;
  if (unlocked) {
    // A daemon-relayed active account can throw here (the daemon is off, unreachable, etc.) — that
    // must not take down the whole status fetch, or the popup can't even render enough UI (the
    // account switcher included) to let the user switch away from the broken account.
    try {
      const account = await getActiveAccount();
      if (account) {
        receiveAddress = await account.getWalletAddress();
        address = await account.getComponentAddress();
        // Cache for the lock screen's identicon (see WalletState.lastKnownAddress's doc comment)
        // -- only a write when it actually changed, so this doesn't touch storage on every popup
        // open for the common case of reopening the same already-unlocked account.
        if (address !== lastKnownAddress) {
          lastKnownAddress = address;
          await setState({ lastKnownAddress: address });
        }
        // Best-effort reconciliation of any shield that finalized on-chain but never got its
        // ShieldedOutputRecord written (service worker killed mid-flight — see
        // OotleAccount.shield()'s doc comment). Any local account's provider works here: a
        // transaction result lookup isn't account-scoped, so this recovers pending shields from
        // every local account, not just the currently active one. Silently skipped if the
        // active account happens to be daemon-connected this round — it'll get another chance
        // once a local account is active again; this is a safety net, not the primary write path
        // (shield() already writes the record itself right after polling, in the same call).
        if (account instanceof OotleAccount) {
          try {
            await recoverPendingShields(await account.getProvider());
          } catch {
            // Don't let a recovery hiccup (indexer down, etc.) break the whole status fetch.
          }
          // Private-payment scanning does NOT happen here anymore -- it used to run synchronously
          // on every popup open, and a wallet's very first scan (no cursor yet) defaults to a
          // 400-page lookback (see scanForPrivatePayments()'s doc comment), which blocked the
          // popup's first render on up to 20,000 transactions of indexer round trips. The popup now
          // triggers `popup-auto-scan-private-payments` itself once the home screen has already
          // rendered (see renderHome()), so this cost is never on the path to seeing a balance at
          // all -- least of all for a freshly created wallet, which can't have any private payment
          // history to find in the first place (see that handler's own doc comment).
        }
      }
    } catch (e) {
      activeAccountError = e instanceof Error ? e.message : String(e);
    }
  }
  // A local account's component address is pure client-side crypto derivation (seed -> public key
  // -> hash, see OotleAccount.getComponentAddress()) -- no network call, safe to compute for every
  // account on every status fetch. Only null while locked (getAccountById already returns null
  // then, via resolveAccountId's unlocked-seed gate -- no separate check needed here).
  const localAccounts: AccountSummary[] = await Promise.all(
    Array.from({ length: state.accountCount }, async (_, i) => {
      const id = localAccountId(i);
      const account = await getAccountById(id);
      return { id, label: `Account ${i + 1}`, kind: "local" as const, address: account ? await account.getComponentAddress() : null };
    })
  );
  const importedSummaries: AccountSummary[] = await Promise.all(
    state.importedAccounts.map(async (a) => {
      const id = importedAccountId(a.id);
      const account = await getAccountById(id);
      return { id, label: a.label, kind: "imported" as const, address: account ? await account.getComponentAddress() : null };
    })
  );
  const daemonAccounts: AccountSummary[] = state.daemonAccounts.map((a) => ({
    id: daemonAccountId(a.connectionId, a.componentAddress),
    label: a.label,
    kind: "daemon",
    address: a.componentAddress,
  }));
  return {
    hasWallet: state.vault !== null,
    backupPending: state.vault !== null && state.backupPending === true,
    isUnlocked: unlocked,
    network: state.network,
    activeAccountId: state.activeAccountId,
    accountCount: state.accountCount,
    address,
    receiveAddress,
    lastKnownAddress,
    activeAccountError,
    accounts: [...localAccounts, ...importedSummaries, ...daemonAccounts],
    daemonConnections: state.daemonConnections.map((c) => ({ id: c.id, url: c.url, label: c.label })),
    addressBook: state.addressBook,
    autoLockMinutes: state.autoLockMinutes,
    feePrivacyDefault: state.feePrivacyDefault,
    // Only offered while it is actually newer than the running build: after the reload the stored
    // version equals the current one, and leaving the banner up would make Reload look broken.
    updateAvailable: state.pendingUpdateVersion && isNewerVersion(state.pendingUpdateVersion, chrome.runtime.getManifest().version) ? state.pendingUpdateVersion : null,
    language: state.language,
  };
}

/**
 * Wraps a transaction-submitting call with client-side history recording (see
 * TransactionHistoryEntry's doc comment for scope) — records "confirmed" if `action` resolves,
 * "failed" if it rejects, then re-throws so the caller's own error handling is unaffected either
 * way. A recording hiccup itself is swallowed (best-effort only), the same "don't let a recording
 * hiccup break the real flow" policy buildStatus() already applies to recoverPendingShields()/
 * scanForPrivatePayments().
 */
/**
 * Looks up `resourceAddress`'s current `divisibility`/`symbol` from the active account's balances,
 * to snapshot onto a `TransactionHistoryEntry` at write time (see that field's doc comment for
 * why this can't just be re-derived later from whatever the account holds *then*). Best-effort:
 * `undefined` (record without the fields, same as before this existed) if there's no active
 * account, the lookup fails, or the resource isn't in the current balance list at all -- a
 * dust-swept or otherwise since-vacated vault, most commonly.
 */
async function resolveResourceMeta(resourceAddress: string): Promise<Pick<TransactionHistoryEntry, "divisibility" | "symbol"> | undefined> {
  try {
    const account = await getActiveAccount();
    const balance = (await account?.getBalances())?.find((b) => b.resourceAddress === resourceAddress);
    return balance ? { divisibility: balance.divisibility, symbol: balance.symbol } : undefined;
  } catch {
    return undefined;
  }
}

/** Simulates a still-pending transaction request against its own account and formats the result
 * for the approval screen. `null` for request kinds whose approval steps already say exactly what
 * moves (the wallet builds those transactions itself). */
async function previewTransactionRequest(requestId: string): Promise<TransactionPreview | null> {
  const record = await getTransactionRequest(requestId);
  if (!record || record.status !== "pending") return null;
  const account = await getAccountById(record.accountId);
  if (!account) throw new Error("Wallet is locked.");
  const raw = await previewOperation(account, record.operation);
  if (!raw) return null;

  const balances = await account.getBalances().catch(() => []);
  const fmt = (amount: bigint, resourceAddress: string) =>
    approvalAmount(amount.toString(), resourceAddress, balances.find((b) => b.resourceAddress === resourceAddress)?.divisibility);

  const outgoing: string[] = [];
  const incoming: string[] = [];
  for (const [resourceAddress, delta] of raw.changes) {
    (delta < 0n ? outgoing : incoming).push(fmt(delta < 0n ? -delta : delta, resourceAddress));
  }
  const preview: TransactionPreview = {
    simulated: raw.simulated,
    error: raw.error,
    wouldFail: raw.wouldFail,
    outgoing,
    incoming,
    ownAccountCalls: raw.ownAccountCalls,
  };
  if (raw.htlc && record.operation.kind === "htlcClaim") {
    preview.htlcProblems = raw.htlc.problems;
    if (raw.htlc.value !== null) {
      preview.htlcValue = fmt(raw.htlc.value, record.operation.resourceAddress);
      await setTransactionRequestPreviewedHtlcValue(record.id, raw.htlc.value.toString());
    }
  }
  return preview;
}

/**
 * The on-chain transaction id in an SDK call's resolved result, whichever spelling that call uses:
 * `transactionId` (shield/unshield/sendPrivately/claimBurn/withdrawStealthAndExecute/...) or the
 * indexer's `transaction_id` (send/execute/claimTestnetXtr). `undefined` when the result carries
 * neither, e.g. claimPrivatePayment() -- history then simply shows no id for that entry.
 */
function transactionIdOf(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as { transactionId?: unknown; transaction_id?: unknown };
  const id = typeof r.transactionId === "string" ? r.transactionId : typeof r.transaction_id === "string" ? r.transaction_id : undefined;
  return id && /^[0-9a-f]{64}$/i.test(id) ? id.toLowerCase() : undefined;
}

/** This wallet's own operations under way (see withHistory) -- receipt detection waits them out. */
let opsInFlight = 0;

/** Records public payments into the active local account (see receipts.ts); best-effort. */
async function syncActivePublicReceipts(): Promise<void> {
  const account = await getActiveAccount();
  if (!(account instanceof OotleAccount)) return;
  const { activeAccountId, network } = await getState();
  await syncPublicReceipts(activeAccountId, account, network, () => opsInFlight > 0);
}

async function withHistory<T>(
  base: Omit<TransactionHistoryEntry, "id" | "createdAt" | "status">,
  action: () => Promise<T>,
  // Fields only knowable from the action's resolved result (e.g. claimPrivatePayment()'s
  // decrypted memo) -- merged into the "confirmed" record only, since there's no result to derive
  // them from on failure.
  deriveOnSuccess?: (result: T) => Partial<Omit<TransactionHistoryEntry, "id" | "createdAt" | "status">>
): Promise<T> {
  const record = async (status: TransactionHistoryEntry["status"], extra?: Partial<TransactionHistoryEntry>) => {
    try {
      const meta = base.resourceAddress ? await resolveResourceMeta(base.resourceAddress) : undefined;
      await addTransactionHistoryEntry({ ...base, ...meta, ...extra, status, id: crypto.randomUUID(), createdAt: Date.now() });
    } catch {
      // Best-effort -- see doc comment above.
    }
  };
  opsInFlight++;
  try {
    const result = await action();
    const derived = deriveOnSuccess?.(result);
    const transactionId = derived?.transactionId ?? transactionIdOf(result);
    await record("confirmed", { ...derived, ...(transactionId ? { transactionId } : {}) });
    return result;
  } catch (e) {
    await record("failed");
    throw e;
  } finally {
    opsInFlight--;
  }
}

/**
 * Records a `"private-payment-received"` history entry for each output `scanForPrivatePayments()`
 * newly discovered -- shared by `buildStatus()`'s opportunistic auto-scan, the manual
 * `popup-rescan-private-payments` handler, and the dApp-facing `tari_scanForPrivatePayments`/
 * `tari_claimPrivatePayment`, so a payment found by any of them shows up in History and not just in
 * the private balance. That matters most for the dApp path: a payment discovered by a site the user
 * granted view access to should leave the same visible trace in their own wallet as one they found
 * themselves. Best-effort per entry, matching `withHistory`'s own policy: one bad
 * write must not lose the rest.
 */
async function recordPrivatePaymentHistory(accountId: string, found: { resourceAddress: string; amount: bigint; transactionId: string; memo?: string }[]) {
  // One shared balances fetch for the whole batch (see resolveResourceMeta's doc comment for why
  // this gets snapshotted at all) rather than one per output -- a claim-everything rescan can
  // surface a handful of outputs at once.
  const balances = await getActiveAccount()
    .then((a) => a?.getBalances())
    .catch(() => undefined);
  for (const output of found) {
    const balance = balances?.find((b) => b.resourceAddress === output.resourceAddress);
    try {
      await addTransactionHistoryEntry({
        accountId,
        kind: "private-payment-received",
        resourceAddress: output.resourceAddress,
        amount: output.amount.toString(),
        transactionId: output.transactionId,
        memo: output.memo,
        divisibility: balance?.divisibility,
        symbol: balance?.symbol,
        status: "confirmed",
        id: crypto.randomUUID(),
        createdAt: Date.now(),
      });
    } catch {
      // Best-effort -- see doc comment above.
    }
  }
}

async function handlePopupRequest(message: PopupRequest): Promise<unknown> {
  await touchActivity();
  switch (message.kind) {
    case "popup-get-status":
      return buildStatus();

    case "popup-set-language":
      await setState({ language: message.language });
      return {};

    case "popup-reload-extension":
      // Fire-and-forget on purpose: reload() tears down this service worker (and every page using
      // it, popup included) essentially immediately, before a response could reliably arrive back
      // at the popup's `send()` anyway.
      chrome.runtime.reload();
      return {};

    case "popup-create-wallet": {
      // Overwriting an existing vault would destroy its seed; the reset flow wipes first.
      if ((await getState()).vault) throw new Error("A wallet already exists -- reset it first.");
      const { seed, mnemonic } = await createWalletSeed();
      const vault = await encryptVault(message.password, serializeSeed(seed));
      await setState({ vault, accountCount: 1, activeAccountId: localAccountId(0), walletOrigin: "created", backupPending: true });
      // getLocalAccount() caches by "network:index" alone, not by seed identity -- unreachable in
      // the normal flow (this case only shows when no wallet exists yet, i.e. the cache was never
      // populated), but a request racing a just-completed popup-reset-wallet could read the old
      // seed before its clearUnlockedSeed() and repopulate the cache after its clearAccountCache(),
      // leaving a stale entry from the *wiped* seed for this brand-new wallet to silently inherit.
      // Cheap enough to always clear here regardless of whether that race actually happened.
      clearAccountCache();
      await setUnlockedSeed(seed.entropy);
      await setPendingMnemonic(mnemonic);
      return { mnemonic };
    }

    // Lets a popup that was closed mid-onboarding show the phrase again. Only answers while the
    // wallet is unlocked and unverified; after the check there is no way back to it except
    // popup-reveal-mnemonic, which asks for the password.
    case "popup-get-pending-mnemonic": {
      const { vault, backupPending } = await getState();
      if (!vault || !backupPending) throw new Error("No recovery phrase is waiting to be verified.");
      if (!(await isUnlocked())) throw new Error("Wallet is locked.");
      const mnemonic = await getPendingMnemonic();
      if (!mnemonic) throw new Error("The recovery phrase is no longer in memory.");
      return { mnemonic };
    }

    case "popup-confirm-backup": {
      await setState({ backupPending: false });
      await clearPendingMnemonic();
      return {};
    }

    case "popup-import-wallet": {
      if ((await getState()).vault) throw new Error("A wallet already exists -- reset it first.");
      const seed = await importWalletSeed(message.mnemonic);
      const vault = await encryptVault(message.password, serializeSeed(seed));
      await setState({ vault, accountCount: 1, activeAccountId: localAccountId(0), walletOrigin: "imported", backupPending: false });
      // See popup-create-wallet's comment just above -- same stale-cache race, same fix.
      clearAccountCache();
      await setUnlockedSeed(seed.entropy);
      return {};
    }

    case "popup-unlock": {
      const { vault } = await getState();
      if (!vault) throw new Error("No wallet set up yet.");
      const seed = deserializeSeed(await decryptVault(message.password, vault));
      await setUnlockedSeed(seed.entropy);
      return {};
    }

    case "popup-lock": {
      await clearUnlockedSeed();
      clearAccountCache();
      return {};
    }

    case "popup-reveal-mnemonic": {
      const { vault } = await getState();
      if (!vault) throw new Error("No wallet set up yet.");
      const seed = deserializeSeed(await decryptVault(message.password, vault));
      return { mnemonic: await seedToMnemonic(seed) };
    }

    case "popup-get-balances": {
      const account = await getActiveAccount();
      if (!account) throw new Error("Wallet is locked.");
      // The indexer's vault lookup has a hard 15s limit inside the SDK and an occasionally slow indexer
      // trips it; a second attempt almost always lands (the first warms the indexer), so retry once
      // before showing the user a timeout.
      try {
        return await account.getBalances();
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("Timed out")) return account.getBalances();
        throw e;
      }
    }

    case "popup-get-nft-details": {
      const { network } = await getState();
      return fetchNftDetails(network, message.resourceAddress, message.tokenIds);
    }

    case "popup-claim-testnet-xtr": {
      const account = await getActiveAccount();
      if (!account) throw new Error("Wallet is locked.");
      const { activeAccountId } = await getState();
      return withHistory({ accountId: activeAccountId, kind: "claim" }, () => account.claimTestnetXtr());
    }

    case "popup-send": {
      const account = await getActiveAccount();
      if (!account) throw new Error("Wallet is locked.");
      const { activeAccountId } = await getState();
      // The recipient only ever hands out their one main "otl_..." wallet address -- `send()`
      // derives the on-chain component address from it itself, and also needs the wallet address
      // (not just the derived address) to create that component on the fly if the recipient has
      // no prior on-chain activity yet (see OotleAccount.send()'s doc comment).
      return withHistory(
        {
          accountId: activeAccountId,
          kind: "send",
          resourceAddress: message.resourceAddress,
          amount: message.amount,
          counterparty: message.recipientWalletAddress,
        },
        () => account.send(message.recipientWalletAddress, message.resourceAddress, BigInt(message.amount))
      );
    }

    case "popup-shield": {
      const activeAccount = await getActiveAccount();
      if (!activeAccount) throw new Error("Wallet is locked.");
      // Unlike unshield/sendPrivately/HTLC (still local-only: they need this account's own view
      // secret client-side to spend an existing stealth output, which a daemon-relayed account can
      // never have -- see WalletDaemonSigner's own doc comment), shield only ever *creates* a new
      // stealth output from revealed funds, which the daemon can do entirely server-side via its
      // own accounts.stealth_transfer RPC (DaemonAccount.shield(), confirmed against a live daemon).
      const account = requireLocalOrDaemonAccount(activeAccount, "Shielding");
      const maxFee = message.maxFee ? BigInt(message.maxFee) : undefined;
      const { activeAccountId } = await getState();
      return withHistory(
        { accountId: activeAccountId, kind: "shield", resourceAddress: message.resourceAddress, amount: message.amount, memo: message.memo },
        () => account.shield(message.resourceAddress, BigInt(message.amount), maxFee, message.memo)
      );
    }

    case "popup-unshield": {
      const activeAccount = await getActiveAccount();
      if (!activeAccount) throw new Error("Wallet is locked.");
      // See popup-shield's own comment: unlike HTLC/withdrawStealthAndExecute, this doesn't need
      // this account's own view secret client-side -- the daemon spends its own stealth UTXOs
      // server-side (DaemonAccount.unshield(), confirmed against a live daemon).
      const account = requireLocalOrDaemonAccount(activeAccount, "Unshielding");
      const maxFee = message.maxFee ? BigInt(message.maxFee) : undefined;
      const { activeAccountId } = await getState();
      return withHistory(
        { accountId: activeAccountId, kind: "unshield", resourceAddress: message.resourceAddress, amount: message.revealedAmount, memo: message.memo },
        () => account.unshield(message.resourceAddress, BigInt(message.revealedAmount), maxFee, message.memo)
      );
    }

    case "popup-send-privately": {
      const activeAccount = await getActiveAccount();
      if (!activeAccount) throw new Error("Wallet is locked.");
      // See popup-unshield's own comment.
      const account = requireLocalOrDaemonAccount(activeAccount, "Sending privately");
      const maxFee = message.maxFee ? BigInt(message.maxFee) : undefined;
      const { activeAccountId } = await getState();
      // A private send spends only stealth inputs, so the fee is the one thing that could tie it to
      // this account: paid transparently it withdraws from the account's vault and names the
      // account on-chain. Default to a private fee (a separate shielded UTXO, excluded from the
      // send's own coin selection by the SDK) wherever that's possible, i.e. a local account.
      const feeType = message.feeType ?? (account instanceof OotleAccount ? "private" : "transparent");
      rejectPrivateFeeForDaemon(account instanceof OotleAccount ? undefined : feeType, "a private send's fee");
      return withHistory(
        {
          accountId: activeAccountId,
          kind: "send-privately",
          resourceAddress: message.resourceAddress,
          amount: message.amount,
          counterparty: message.recipientWalletAddress,
          memo: message.memo,
        },
        async () =>
          account.sendPrivately(
            message.resourceAddress,
            message.recipientWalletAddress,
            BigInt(message.amount),
            maxFee,
            message.memo,
            undefined,
            await resolveFeeType(account, feeType)
          )
      );
    }

    case "popup-auto-scan-private-payments": {
      // The popup's own opportunistic scan, triggered once the home screen is already showing
      // (see renderHome()) instead of blocking buildStatus() -- see that removal's comment for why.
      const account = await getActiveAccount();
      if (!account || !(account instanceof OotleAccount)) return { claimed: 0 };
      const { activeAccountId, walletOrigin, network } = await getState();
      const hasCursor = (await getPrivatePaymentScanCursor(activeAccountId)) !== null;
      // A wallet this extension generated cannot have received a private payment before the moment
      // it was created -- there is no seed, therefore no view key, therefore nothing to have been
      // encrypted to. Its first scan can use the same shallow window every later scan does. An
      // imported (or origin-unknown, pre-this-field) wallet's seed may be years old, so its first
      // scan alone gets the deep lookback -- scanForPrivatePayments()'s own default for exactly
      // this case. Only applies before a cursor exists; once one is written every scan is shallow
      // regardless of origin.
      const maxPages = !hasCursor && walletOrigin === "created" ? 3 : undefined;
      try {
        const { claimed, found } = await account.scanForPrivatePayments(maxPages);
        await recordPrivatePaymentHistory(activeAccountId, found);
        // Private outputs spent from another wallet on this seed stay listed until checked; drop
        // them so the private balance is the real one.
        await account.pruneSpentShieldedOutputs().catch(() => 0);
        await syncActivePublicReceipts();

        // UTXO-set delta scan: finds any stealth output that exists on-chain right now, regardless
        // of age or how it was created. Runs for every resource this account already has shielded
        // outputs for, plus the native TARI resource (which may have received a direct UTXO-mint
        // from a template that bypasses StealthTransfer). Best-effort -- an indexer hiccup here
        // shouldn't surface as an error the user has to dismiss.
        const indexerBaseUrl = defaultIndexerUrl(toOotleNetwork(network));
        const knownOutputs = await listShieldedOutputs(activeAccountId);
        const knownResources = [...new Set([TARI_RESOURCE_ADDRESS, ...knownOutputs.map((o) => o.resourceAddress)])];
        for (const resourceAddress of knownResources) {
          await account.scanForOwnedUtxos(resourceAddress, indexerBaseUrl).catch(() => undefined);
        }

        return { claimed };
      } catch {
        return { claimed: 0 }; // best-effort -- an indexer hiccup here shouldn't surface as an error the user has to dismiss
      }
    }

    case "popup-rescan-private-payments": {
      const account = await getActiveAccount();
      if (!account) throw new Error("Wallet is locked.");
      if (!(account instanceof OotleAccount)) {
        throw new Error("Rescanning for private payments isn't available for daemon-connected accounts -- switch to a local account first.");
      }
      const { activeAccountId } = await getState();
      // A much deeper lookback than buildStatus()'s opportunistic per-popup-open scan (3 pages /
      // 50 each = 150 transactions) -- this is the user explicitly asking to go looking, so it's
      // worth the extra round trips to actually catch up on a long gap since the wallet was last
      // opened, not just the same shallow window the automatic scan already covers.
      const { claimed, found } = await account.scanForPrivatePayments(20, 50);
      await recordPrivatePaymentHistory(activeAccountId, found);
      return { claimed };
    }

    case "popup-claim-private-payment": {
      const account = await getActiveAccount();
      if (!account) throw new Error("Wallet is locked.");
      if (!(account instanceof OotleAccount)) {
        throw new Error("Claiming a private payment isn't available for daemon-connected accounts -- switch to a local account first.");
      }
      const { activeAccountId } = await getState();
      return withHistory(
        { accountId: activeAccountId, kind: "private-payment-received", resourceAddress: message.resourceAddress, counterparty: message.commitment },
        () => account.claimPrivatePayment(message.resourceAddress, message.commitment),
        // The amount/memo are only known once decryption succeeds -- see withHistory's own doc
        // comment for why these can't just go in the static base above.
        (result) => ({ amount: result.amount.toString(), memo: result.memo })
      );
    }

    case "popup-get-burn-claim-key": {
      const account = await getActiveAccount();
      if (!account) throw new Error("Wallet is locked.");
      if (!(account instanceof OotleAccount)) {
        throw new Error("Claiming L1 burns isn't available for daemon-connected accounts -- switch to a local account first.");
      }
      return { publicKey: toHex(await account.getPublicKey()) };
    }

    case "popup-claim-burn": {
      const account = await getActiveAccount();
      if (!account) throw new Error("Wallet is locked.");
      if (!(account instanceof OotleAccount)) {
        throw new Error("Claiming L1 burns isn't available for daemon-connected accounts -- switch to a local account first.");
      }
      const proof = parseConsoleWalletBurnProof(message.proofJson);
      const { activeAccountId } = await getState();
      return withHistory(
        { accountId: activeAccountId, kind: "burn-claim", resourceAddress: TARI_RESOURCE_ADDRESS, counterparty: proof.claim_proof.commitment },
        () => account.claimBurn(proof),
        (result) => ({ amount: result.claimedAmount.toString(), transactionId: result.transactionId })
      );
    }

    case "popup-add-account": {
      const state = await getState();
      const newIndex = state.accountCount;
      const newId = localAccountId(newIndex);
      await setState({ accountCount: newIndex + 1, activeAccountId: newId });
      return { index: newIndex };
    }

    case "popup-import-account": {
      const master = await getUnlockedSeed();
      if (!master) throw new Error("Wallet is locked.");
      const imported = await importWalletSeed(message.mnemonic);
      const state = await getState();
      // Refuse a phrase already in the wallet: the same keys twice would be two names for one account.
      const addr = (e: Uint8Array) => OotleAccount.fromSeed(e, 0, state.network).getComponentAddress();
      const newAddr = await addr(imported.entropy);
      if (newAddr === (await addr(master))) throw new Error("That's this wallet's own recovery phrase.");
      for (const ref of state.importedAccounts) {
        if ((await addr(fromHexString(await decryptSecret(master, ref.encryptedSeed)))) === newAddr) {
          throw new Error("That recovery phrase is already imported.");
        }
      }
      const id = crypto.randomUUID().slice(0, 8);
      const ledgerIndex = 1_000_000 + state.importedAccounts.reduce((m, a) => Math.max(m, a.ledgerIndex - 1_000_000 + 1), 0);
      const label = (message.label ?? "").trim().slice(0, 40) || `Imported ${state.importedAccounts.length + 1}`;
      const ref = { id, label, ledgerIndex, encryptedSeed: await encryptSecret(master, toHexString(imported.entropy)) };
      await setState({ importedAccounts: [...state.importedAccounts, ref], activeAccountId: importedAccountId(id) });
      await removeAllConnectedSites();
      await broadcastAccountsChanged([]);
      return { accountId: importedAccountId(id) };
    }

    case "popup-remove-imported-account": {
      const state = await getState();
      const id = message.accountId.replace(/^imported:/, "");
      const importedAccounts = state.importedAccounts.filter((a) => a.id !== id);
      if (importedAccounts.length === state.importedAccounts.length) throw new Error("No such imported account.");
      const wasActive = state.activeAccountId === message.accountId;
      if (wasActive) {
        await removeAllConnectedSites();
        await broadcastAccountsChanged([]);
      }
      await setState({ importedAccounts, activeAccountId: wasActive ? "local:0" : state.activeAccountId });
      clearAccountCache();
      return {};
    }

    case "popup-set-active-account": {
      const { activeAccountId } = await getState();
      if (message.accountId !== activeAccountId) {
        // Every existing connection is pinned to whichever account was active when it was made
        // (see addConnectedSite) — switching accounts without dropping them would leave connected
        // sites silently reading/spending from the account the user just switched away from.
        await removeAllConnectedSites();
        await broadcastAccountsChanged([]);
      }
      await setState({ activeAccountId: message.accountId });
      return {};
    }

    case "popup-get-connected-sites": {
      const { connectedSites } = await getState();
      return connectedSites;
    }

    case "popup-revoke-site-view-access": {
      await setViewAccess(message.origin, false);
      return null;
    }

    case "popup-disconnect-site": {
      await removeConnectedSite(message.origin);
      return {};
    }

    case "popup-get-pending-approval":
      return getPendingApproval(message.approvalId) ?? null;

    case "popup-preview-transaction-request":
      return previewTransactionRequest(message.approvalId);

    case "popup-resolve-approval":
      return { resolved: await resolveApproval(message.approvalId, message.approve, message.feeType) };

    case "popup-reset-wallet": {
      await clearUnlockedSeed();
      await clearPendingMnemonic();
      clearAccountCache();
      resetKnownVersions();
      await wipeWallet();
      await wipeOotleState();
      return {};
    }

    case "popup-connect-daemon": {
      // Adding a daemon connection requires the wallet to be unlocked -- its API key is
      // encrypted with a key derived from the seed (see secretAtRest.ts), so there's nothing to
      // derive that encryption key from otherwise. In practice Settings (where this is reached
      // from) is already unreachable while locked, so this should never actually trip; it's here
      // so the failure is a clear message rather than a confusing crash if that ever changes.
      const seed = await getUnlockedSeed();
      if (!seed) throw new Error("Wallet is locked.");
      const id = crypto.randomUUID();
      // Validates connectivity/the API key up front so a bad URL or key fails here, in the
      // "connect" step, rather than silently later on the first real account operation.
      const client = await DaemonAccount.connectClient(message.url, message.apiKey);
      const encryptedApiKey = await encryptSecret(seed, message.apiKey);
      await addDaemonConnection({ id, url: message.url, encryptedApiKey, label: message.label });
      const accounts = await DaemonAccount.listAccounts(client, message.url);
      const options: DaemonAccountOption[] = accounts.map((a) => ({
        componentAddress: a.component_address,
        label: a.name ?? a.component_address,
      }));
      return { connectionId: id, accounts: options };
    }

    case "popup-list-daemon-accounts": {
      const seed = await getUnlockedSeed();
      if (!seed) throw new Error("Wallet is locked.");
      const { client, url } = await getDaemonClient(message.connectionId, seed);
      const accounts = await DaemonAccount.listAccounts(client, url);
      const options: DaemonAccountOption[] = accounts.map((a) => ({
        componentAddress: a.component_address,
        label: a.name ?? a.component_address,
      }));
      return { accounts: options };
    }

    case "popup-add-daemon-accounts": {
      for (const account of message.accounts) {
        await addDaemonAccount({ connectionId: message.connectionId, componentAddress: account.componentAddress, label: account.label });
      }
      // Switch to the first newly-added account so the user lands somewhere useful, matching
      // `popup-add-account`'s behavior for a freshly-derived local account.
      const first = message.accounts[0];
      if (first) await setState({ activeAccountId: daemonAccountId(message.connectionId, first.componentAddress) });
      return {};
    }

    case "popup-remove-daemon-connection": {
      await removeDaemonConnection(message.connectionId);
      // Both cache maps are keyed off connectionId (see accounts.ts) and neither is consulted
      // against current state before returning a hit -- without clearing them, an account
      // resolved earlier this session under this connection would keep working from its stale
      // cached client/instance even though the connection (and every account under it) is now
      // gone from storage. Reset activeAccountId too if it was pointing at one of those accounts:
      // buildStatus() otherwise keeps trying to resolve an id storage no longer has any record of,
      // surfacing as a raw "wallet is locked"-style error rather than a clean fallback.
      clearAccountCache();
      const { activeAccountId } = await getState();
      const parsed = parseAccountId(activeAccountId);
      if (parsed.type === "daemon" && parsed.connectionId === message.connectionId) {
        await setState({ activeAccountId: "local:0" });
      }
      return {};
    }

    case "popup-remove-daemon-account": {
      await removeDaemonAccount(message.connectionId, message.componentAddress);
      clearAccountCache();
      const { activeAccountId } = await getState();
      const parsed = parseAccountId(activeAccountId);
      if (parsed.type === "daemon" && parsed.connectionId === message.connectionId && parsed.componentAddress === message.componentAddress) {
        await setState({ activeAccountId: "local:0" });
      }
      return {};
    }

    case "popup-set-auto-lock-minutes": {
      await setState({ autoLockMinutes: message.minutes });
      return {};
    }

    case "popup-set-fee-privacy-default": {
      await setState({ feePrivacyDefault: message.feeType });
      return {};
    }

    case "popup-add-address-book-entry": {
      const entry = { id: crypto.randomUUID(), label: message.label, address: message.address };
      await addAddressBookEntry(entry);
      return entry;
    }

    case "popup-remove-address-book-entry": {
      await removeAddressBookEntry(message.id);
      return {};
    }

    case "popup-get-transaction-history": {
      // Catch up on public payments first, but never hold History up for long on a slow indexer.
      await Promise.race([syncActivePublicReceipts(), new Promise((resolve) => setTimeout(resolve, 8000))]);
      const { activeAccountId } = await getState();
      return listTransactionHistory(activeAccountId);
    }

    case "popup-set-network": {
      // Connections and approvals are per network: a site approved on one network must ask again
      // on the other (submitApprovedTransactionRequest also refuses a cross-network submit).
      if ((await getState()).network !== message.network) {
        await removeAllConnectedSites();
        await broadcastAccountsChanged([]);
      }
      await setState({ network: message.network });
      // Local accounts are cached by "network:index" (see accounts.ts's getLocalAccount), so they
      // already pick up the new network on their own -- but a daemon-relayed account's cache key
      // has no network component, and getDaemonAccount() only reads the current network when
      // constructing a *fresh* instance, so a cached one would otherwise keep talking to the old
      // network's indexer silently. Clearing forces everything to rebuild against the new network.
      clearAccountCache();
      return {};
    }

    default:
      throw new Error(`Unknown popup message: ${JSON.stringify(message)}`);
  }
}

// Reset in-memory session state whenever the browser (re)starts the service worker fresh — the
// session storage already handles this correctly on its own (it's cleared when the browser
// closes), this just ensures our per-worker caches don't outlive a stale seed.
chrome.runtime.onStartup.addListener(() => {
  clearAccountCache();
});

// ---------------------------------------------------------------------------
// Auto-lock on inactivity
// ---------------------------------------------------------------------------
// Before this, there was no auto-lock at all: chrome.storage.session (see session.ts) keeps the
// decrypted seed alive until the whole browser closes, no matter how long the wallet sat idle —
// real exposure on a shared or unattended machine. chrome.alarms (not setInterval/setTimeout) is
// what actually works here: MV3 kills this service worker after ~30s of inactivity, and a plain
// timer dies with it, while an alarm persists and re-fires even across a worker restart.
const AUTO_LOCK_ALARM = "tari-auto-lock-check";

chrome.alarms.create(AUTO_LOCK_ALARM, { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== AUTO_LOCK_ALARM) return;
  void checkAutoLock();
});

async function checkAutoLock(): Promise<void> {
  if (!(await isUnlocked())) return;
  const lastActivity = await getLastActivity();
  if (lastActivity === null) return; // defensive: shouldn't happen while unlocked
  const { autoLockMinutes } = await getState();
  if (!shouldAutoLock(lastActivity, Date.now(), autoLockMinutes)) return;
  await clearUnlockedSeed();
  clearAccountCache();
}
