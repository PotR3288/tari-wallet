// Thin wrapper around chrome.storage.local for everything the wallet persists between browser
// restarts. The encrypted vault blob and every daemon connection's API key are the sensitive
// pieces here — see vault.ts and secretAtRest.ts respectively for how each is protected;
// everything else in this file is plain metadata.
import type { TransactionRequestOperation } from "./messages";
import type { EncryptedVault } from "./vault";
import type { EncryptedSecret } from "./secretAtRest";
import { DEFAULT_AUTO_LOCK_MINUTES } from "./autoLock";

export interface ConnectedSite {
  origin: string;
  /** Stable account id this site is bound to — see `localAccountId`/`daemonAccountId`. */
  accountId: string;
  connectedAt: number;
  /**
   * When (if ever) this site was granted **private view access** — the separate, explicitly
   * approved permission to read this account's confidential position: shielded balances, the
   * individual stealth UTXOs behind them, and the ability to run a view-key scan
   * (`tari_getPrivateBalances`/`tari_getShieldedOutputs`/`tari_scanForPrivatePayments`/
   * `tari_scanForResourceUtxos`/`tari_claimPrivatePayment`). Absent = never granted.
   *
   * Deliberately NOT implied by a plain connection. A connection reveals one public component
   * address; view access reveals the whole confidential position the rest of the chain cannot
   * see, which is the entire point of holding funds privately — the two are different asks and
   * get different prompts. It is also never carried over into a *new* connection record (see
   * `addConnectedSite`): re-approving a connection re-approves a connection, nothing more.
   *
   * This grants read access only. It never lets a site *spend* private funds — every private
   * spend still goes through the same per-transaction approval as any other (see
   * `TransactionRequestOperation`'s private-spend kinds in messages.ts).
   */
  viewAccessGrantedAt?: number;
}

/**
 * A daemon this extension has connected to as a JRPC client — the "hardware wallet" analog of a
 * seed. Authenticated with a long-lived **API key** the user mints from the daemon's own web UI
 * (which has a real browser session there), not a session token this extension logs into itself —
 * confirmed with the tari-ootle maintainers that a `chrome-extension://` origin can't hold a
 * daemon browser session at all (session refresh needs an HttpOnly cookie this origin never gets;
 * WebAuthn's RP origin is locked to `http://localhost:{port}` regardless). See `DaemonAccount`.
 *
 * `encryptedApiKey` (not a plain `apiKey: string`) -- this key carries the daemon's `admin`
 * permission (see README "Daemon-relayed accounts"), the same severity of credential as the
 * wallet seed itself, so it gets the same "unreadable without the unlocked wallet" protection
 * via secretAtRest.ts rather than sitting in chrome.storage.local as plain text.
 */
export interface DaemonConnectionConfig {
  id: string;
  url: string;
  encryptedApiKey: EncryptedSecret;
  label: string;
}

/** One account on a connected daemon that the user has added to this wallet's account list. */
/** A second seed phrase imported as its own account; the entropy is encrypted under the master seed (see secretAtRest.ts). */
export interface ImportedAccountRef {
  id: string;
  label: string;
  /** Unique per imported account: keys the SDK's per-account ledger so two seeds never share one. */
  ledgerIndex: number;
  encryptedSeed: { iv: string; ciphertext: string };
}

export function importedAccountId(id: string): string {
  return `imported:${id}`;
}

export interface DaemonAccountRef {
  connectionId: string;
  componentAddress: string;
  label: string;
}

/**
 * A saved recipient — either a `component_…` public address (for Send) or an `otl_…` bech32m
 * wallet address (for Send privately). Plain metadata, same sensitivity as a daemon connection's
 * `url`/`label` (not the encrypted API key) — addresses are public on-chain data regardless.
 */
export interface AddressBookEntry {
  id: string;
  label: string;
  address: string;
}

// ShieldedOutputRecord/PendingShield moved to @chironbuilder/ootle-sdk -- import them from there.

/**
 * A transaction this wallet itself submitted (or an inbound private payment it explicitly
 * claimed), recorded client-side for a local history view. Deliberately scoped: this only covers
 * actions taken *from this point forward* through this wallet, not a retroactive reconstruction
 * of on-chain history (the indexer's recent-transactions feed is global/paginated, not filterable
 * by address — see OotleAccount.scanForPrivatePayments()'s use of it for the one place this
 * codebase already walks that feed). `resourceAddress`/`amount`/`transactionId` are omitted where
 * genuinely not known or not meaningfully decodable — see the `dapp-transaction` kind, which
 * deliberately never decodes instruction args (same "never decode a Literal" policy as
 * instructionSummary.ts, used for the approval screen).
 */
export interface TransactionHistoryEntry {
  id: string;
  accountId: string;
  kind: "send" | "shield" | "unshield" | "send-privately" | "claim" | "private-payment-received" | "received" | "burn-claim" | "dapp-transaction";
  resourceAddress?: string;
  /** Raw, resource-native units (matches ShieldedOutputRecord.amount's convention). */
  amount?: string;
  /** Recipient/sender address for a send-like kind, or a structural summary label for
   * `dapp-transaction` (see instructionSummary.ts) — free-form, display-only. */
  counterparty?: string;
  /** The real on-chain transaction id, when known — omitted for kinds whose underlying SDK call
   * doesn't currently surface one to the caller (see wallet.ts's `execute()`, which discards it
   * after using it internally to poll for the result). */
  transactionId?: string;
  /** 0 for a receipt found on chain with no way to tell when it arrived (shown as "earlier"). */
  createdAt: number;
  /** The plaintext memo attached to a shield/unshield/send-privately/private-payment-received
   * entry, if any -- see `ShieldedOutputRecord.memo`. */
  memo?: string;
  /** "confirmed" for an action that really completed on-chain; "signed-unbroadcast" for a
   * completed sign-only `x402SignClaim` (the wallet sealed and handed over a payload -- nothing
   * moved on-chain, so history must never render it as a completed spend); "failed" otherwise. */
  status: "confirmed" | "failed" | "signed-unbroadcast";
  /** `resourceAddress`'s `divisibility`/`symbol` at the time this entry was recorded (see
   * `TokenBalance`) -- persisted rather than re-derived from the account's *current* balances,
   * which may no longer hold this resource at all (a fully-spent/dust-swept vault drops out of
   * `getBalances()`) or may briefly show a divisibility of 0 for a resource whose only remaining
   * balance is confidential-only. Either gap would otherwise silently misrender a raw amount by
   * orders of magnitude. Omitted for an entry with no `resourceAddress`, and for entries recorded
   * before this field existed -- the popup falls back to a current-balance lookup for those. */
  divisibility?: number;
  symbol?: string | null;
}

const MAX_TRANSACTION_HISTORY_ENTRIES = 500;

/**
 * A dApp-proposed transaction, tracked through create -> (popup approval) -> submit -- mirrors
 * `tari_ootle_walletd`'s `transaction_requests.create/approve/submit` flow (tari-project/
 * tari-ootle#2348), adapted for a browser extension where the *approver* is always the human via
 * the popup (never the dApp itself; there is deliberately no dApp-facing "approve" RPC -- that
 * would let a dApp approve its own request).
 *
 * Persisted (unlike the plain in-memory approval queue in background/approvals.ts) specifically
 * so `tari_getTransactionRequest`/`tari_submitTransactionRequest` keep working across a service
 * worker restart (MV3 tears the worker down after ~30s idle) -- a dApp that created a request,
 * had the user approve it, then the worker recycled before it called submit, can still discover
 * the "approved" status and submit, instead of the whole flow being silently lost.
 */
export interface TransactionRequestRecord {
  id: string;
  origin: string;
  accountId: string;
  /** The network active when the request was created -- submit refuses to run it on any other.
   * Absent only on records written before this field existed. */
  network?: WalletState["network"];
  /** For an htlcClaim: the funded output's value as shown on the approval screen (raw units).
   * Passed to the SDK's pre-claim check at submit, so the claim refuses a different amount. */
  previewedHtlcValue?: string;
  operation: TransactionRequestOperation;
  /** Human-readable summary shown on the popup approval screen and returned to the dApp --
   * computed once at creation from `operation` (see background/index.ts). */
  note: string;
  /** "signed-unbroadcast" is the terminal state of a completed `x402SignClaim`: the wallet
   * signed and sealed the claim and handed the payload back -- nothing was broadcast, and the
   * settlement facilitator (not this wallet) submits it at settle. It behaves like "submitted"
   * everywhere except that re-submitting is refused (see `tari_submitTransactionRequest`). */
  status: "pending" | "approved" | "submitting" | "submitted" | "signed-unbroadcast" | "rejected" | "failed";
  createdAt: number;
  /** A stale "pending"/"approved" request reads back as expired (checked lazily on read, never
   * written -- mirrors walletd's own "Expired = derived on read" design) rather than being
   * submittable indefinitely against possibly-stale substate versions/fee estimates. */
  expiresAt: number;
  /** "submitting" is the in-between state claimed atomically BEFORE execution starts (see
   * beginTransactionRequestSubmit) -- it pins the request against a concurrent second submit and,
   * if the service worker dies mid-execution, permanently blocks a retry that could double-submit
   * an already-landed transaction (a stuck "submitting" record never expires; the dApp learns the
   * outcome via its own re-derivation of the operation or `tari_getTransactionResult` once it
   * knows the id). */
  /** Set once the operation has actually executed -- the sanitized (BigInt-free) result, present
   * only when `status` is "submitted" (or "signed-unbroadcast", whose result is the sealed claim
   * payload the dApp delivers to the settlement facilitator). */
  result?: unknown;
  /** Set once `status` is "failed". */
  error?: string;
}

const MAX_TRANSACTION_REQUESTS = 200;
/** How long a "pending"/"approved" request stays submittable -- see `getTransactionRequest`'s
 * lazy-expiry doc comment. Exported so background/index.ts can stamp `expiresAt` at creation
 * without duplicating the constant. */
export const TRANSACTION_REQUEST_TTL_MS = 15 * 60 * 1000;

export interface WalletState {
  vault: EncryptedVault | null;
  accountCount: number; // how many *local* (seed-derived) accounts have been derived/revealed
  /** Stable id of whichever account (local or daemon) is currently active — see
   * `localAccountId`/`daemonAccountId`/`parseAccountId`. */
  activeAccountId: string;
  network: "esmeralda" | "igor";
  connectedSites: ConnectedSite[];
  daemonConnections: DaemonConnectionConfig[];
  daemonAccounts: DaemonAccountRef[];
  importedAccounts: ImportedAccountRef[];
  /** Saved recipient addresses, shared across Send and Send-privately. */
  addressBook: AddressBookEntry[];
  /** Transactions this wallet has submitted/claimed, newest first, capped at
   * MAX_TRANSACTION_HISTORY_ENTRIES — see TransactionHistoryEntry's doc comment for scope. */
  transactionHistory: TransactionHistoryEntry[];
  /** Minutes of inactivity before the wallet auto-locks; 0 = never. See src/lib/autoLock.ts. */
  autoLockMinutes: number;
  /** Default fee-payment type for a transaction request when the dApp doesn't enforce one.
   * "transparent" (unchanged behavior) unless the user opts in to "private" -- see
   * `resolveFeeType` in background/index.ts. */
  feePrivacyDefault: "private" | "transparent";
  /** The active account's own component address, cached in plaintext from the last time it was
   * unlocked -- a component address is public on-chain data, no more sensitive than the addressBook
   * entries above, so caching it costs nothing. Lets the lock screen show the real per-account
   * identicon instead of a placeholder, matching MetaMask's "spot a wrong wallet/device at a
   * glance" pattern -- the address can't be derived without decrypting the seed, so there'd
   * otherwise be no way to know it before the password is entered. */
  lastKnownAddress: string | null;
  /** dApp-proposed transactions tracked through create -> approve -> submit, newest first,
   * capped at MAX_TRANSACTION_REQUESTS -- see TransactionRequestRecord's doc comment. */
  transactionRequests: TransactionRequestRecord[];
  /** How this wallet's seed came to exist -- "created" means it was generated fresh by this
   * extension, so no private payment could possibly have arrived before that moment; "imported"
   * means the seed pre-dates this install and may have real history. `null` for any wallet that
   * existed before this field did (an upgrade from an older extension version) -- treated the same
   * as "imported" (unknown history, scan for it) rather than assumed empty, since defaulting the
   * other way would silently skip real payments for anyone already using the extension. Read by
   * `popup-auto-scan-private-payments` to decide whether the very first scan needs the deep,
   * many-page lookback or can use the same shallow window every later scan uses. */
  walletOrigin: "created" | "imported" | null;
  /** True from the moment a wallet is created until the user passes the recovery-phrase check.
   * The vault is saved the instant the password is set, so without this a popup closed on the
   * phrase screen left a working wallet whose phrase was never verified. Absent (undefined) on
   * wallets that predate the flag, which are treated as already backed up. */
  backupPending?: boolean;
  /** Mirrors WalletStatus.updateAvailable -- the version chrome.runtime.onUpdateAvailable last
   * reported, persisted so it survives a service-worker restart between the update landing and the
   * user next opening the popup. Cleared back to null once the user actually reloads. */
  pendingUpdateVersion: string | null;
  /** The popup's display language -- see src/lib/i18n/index.ts. */
  language: "en" | "zh";
}

const DEFAULTS: WalletState = {
  vault: null,
  accountCount: 1,
  activeAccountId: "local:0",
  network: "esmeralda",
  connectedSites: [],
  daemonConnections: [],
  daemonAccounts: [],
  importedAccounts: [],
  addressBook: [],
  transactionHistory: [],
  autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES,
  feePrivacyDefault: "transparent",
  lastKnownAddress: null,
  transactionRequests: [],
  walletOrigin: null,
  pendingUpdateVersion: null,
  language: "en",
};

export function daemonAccountId(connectionId: string, componentAddress: string): string {
  return `daemon:${connectionId}:${componentAddress}`;
}

export type AccountId = { type: "local"; index: number } | { type: "imported"; id: string } | { type: "daemon"; connectionId: string; componentAddress: string };

export function parseAccountId(id: string): AccountId {
  if (id.startsWith("local:")) return { type: "local", index: Number(id.slice("local:".length)) };
  if (id.startsWith("imported:")) return { type: "imported", id: id.slice("imported:".length) };
  if (id.startsWith("daemon:")) {
    const rest = id.slice("daemon:".length);
    const sep = rest.indexOf(":");
    return { type: "daemon", connectionId: rest.slice(0, sep), componentAddress: rest.slice(sep + 1) };
  }
  throw new Error(`Malformed account id: ${id}`);
}

export async function getState(): Promise<WalletState> {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored } as WalletState;
}

export async function setState(patch: Partial<WalletState>): Promise<void> {
  await chrome.storage.local.set(patch);
}

// MV3 service workers process messages concurrently (a page request racing a popup request, or
// two popup windows open at once both mutating the same list), so two of this file's read-then-
// write helpers below could interleave: both read the same stale array, both compute their own
// append/removal from it, and whichever writes second silently clobbers the first's change --
// nothing about `getState()`/`setState()` on their own makes a read-modify-write cycle atomic.
// Every mutating helper below runs its whole read-modify-write cycle through this queue so they
// serialize against each other instead. Reads alone (getConnectedSite, listTransactionHistory,
// ...) don't need this -- a plain read has nothing to lose by racing a write, it just sees
// whichever state happens to be current, same as any eventually-consistent read would.
let writeQueue: Promise<unknown> = Promise.resolve();
export function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(fn, fn);
  writeQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

export async function hasWallet(): Promise<boolean> {
  const { vault } = await getState();
  return vault !== null;
}

export async function getConnectedSite(origin: string): Promise<ConnectedSite | undefined> {
  const { connectedSites } = await getState();
  return connectedSites.find((s) => s.origin === origin);
}

/** Records (or re-records) a site's connection. Any previous record for the same origin is
 * dropped wholesale rather than merged, so a prior `viewAccessGrantedAt` does **not** survive
 * into the new connection — see that field's doc comment. */
export async function addConnectedSite(origin: string, accountId: string): Promise<void> {
  await serialized(async () => {
    const state = await getState();
    const withoutExisting = state.connectedSites.filter((s) => s.origin !== origin);
    await setState({
      connectedSites: [...withoutExisting, { origin, accountId, connectedAt: Date.now() }],
    });
  });
}

/**
 * Grants or revokes a connected site's private view access (see `ConnectedSite.viewAccessGrantedAt`).
 * A no-op for an origin that isn't connected at all — there is nothing to attach the grant to, and
 * creating a connection as a side effect of a view grant would let a site skip the connect prompt.
 *
 * `expectedAccountId`, when passed, must still match the site's *current* `accountId` or this is
 * also a no-op — a grant approval prompt names one specific account and can sit open for as long
 * as the user leaves it, during which the site's connection can be dropped and re-established
 * against a *different* account (same origin, new `addConnectedSite` call). Without this check, a
 * grant approved for account A's private balance would silently land on whatever account the
 * origin happens to be connected to by the time the prompt resolves — a real account confusion,
 * not just a stale no-op. Callers granting (never revoking) should always pass the accountId they
 * captured before opening the approval prompt, not one re-read after.
 * Returns whether it actually wrote anything.
 */
export async function setViewAccess(origin: string, granted: boolean, expectedAccountId?: string): Promise<boolean> {
  return serialized(async () => {
    const state = await getState();
    const site = state.connectedSites.find((s) => s.origin === origin);
    if (!site) return false;
    if (expectedAccountId !== undefined && site.accountId !== expectedAccountId) return false;
    const updated: ConnectedSite = granted
      ? { ...site, viewAccessGrantedAt: Date.now() }
      : // Rebuilt without the key rather than set to `undefined`: this object is JSON-serialized
        // into chrome.storage, where an explicit `undefined` value is dropped on write anyway --
        // spelling it out here keeps the in-memory shape identical to what reads back.
        { origin: site.origin, accountId: site.accountId, connectedAt: site.connectedAt };
    await setState({ connectedSites: state.connectedSites.map((s) => (s.origin === origin ? updated : s)) });
    return true;
  });
}

/** Whether `origin` is connected *and* holds a private view grant. The single gate every
 * confidential-read RPC calls — see `ConnectedSite.viewAccessGrantedAt`. */
export async function hasViewAccess(origin: string): Promise<boolean> {
  const site = await getConnectedSite(origin);
  return site?.viewAccessGrantedAt !== undefined;
}

export async function removeConnectedSite(origin: string): Promise<void> {
  await serialized(async () => {
    const state = await getState();
    await setState({ connectedSites: state.connectedSites.filter((s) => s.origin !== origin) });
  });
}

/** Disconnects every connected site. Each connection is pinned to the account id active at the
 * time it was made (see `addConnectedSite`), so switching accounts without this would leave sites
 * silently talking to the account the user just switched away from — clearing them forces every
 * site to reconnect via `tari_requestAccounts`, which then binds to the newly active account. */
export async function removeAllConnectedSites(): Promise<void> {
  await serialized(async () => {
    await setState({ connectedSites: [] });
  });
}

export async function addDaemonConnection(config: DaemonConnectionConfig): Promise<void> {
  await serialized(async () => {
    const state = await getState();
    await setState({ daemonConnections: [...state.daemonConnections, config] });
  });
}

export async function removeDaemonConnection(id: string): Promise<void> {
  await serialized(async () => {
    const state = await getState();
    await setState({
      daemonConnections: state.daemonConnections.filter((c) => c.id !== id),
      daemonAccounts: state.daemonAccounts.filter((a) => a.connectionId !== id),
    });
  });
}

export async function addDaemonAccount(ref: DaemonAccountRef): Promise<void> {
  await serialized(async () => {
    const state = await getState();
    const withoutExisting = state.daemonAccounts.filter(
      (a) => !(a.connectionId === ref.connectionId && a.componentAddress === ref.componentAddress)
    );
    await setState({ daemonAccounts: [...withoutExisting, ref] });
  });
}

export async function removeDaemonAccount(connectionId: string, componentAddress: string): Promise<void> {
  await serialized(async () => {
    const state = await getState();
    await setState({
      daemonAccounts: state.daemonAccounts.filter((a) => !(a.connectionId === connectionId && a.componentAddress === componentAddress)),
    });
  });
}

export async function addAddressBookEntry(entry: AddressBookEntry): Promise<void> {
  await serialized(async () => {
    const state = await getState();
    await setState({ addressBook: [...state.addressBook, entry] });
  });
}

export async function removeAddressBookEntry(id: string): Promise<void> {
  await serialized(async () => {
    const state = await getState();
    await setState({ addressBook: state.addressBook.filter((e) => e.id !== id) });
  });
}

/** Newest-first; entries beyond MAX_TRANSACTION_HISTORY_ENTRIES are dropped (oldest first). */
export async function addTransactionHistoryEntry(entry: TransactionHistoryEntry): Promise<void> {
  await serialized(async () => {
    const state = await getState();
    await setState({ transactionHistory: [entry, ...state.transactionHistory].slice(0, MAX_TRANSACTION_HISTORY_ENTRIES) });
  });
}

export async function listTransactionHistory(accountId: string): Promise<TransactionHistoryEntry[]> {
  const { transactionHistory } = await getState();
  return transactionHistory.filter((e) => e.accountId === accountId);
}

/** Newest-first; entries beyond MAX_TRANSACTION_REQUESTS are dropped (oldest first) -- these are
 * short-lived (a few minutes, per TRANSACTION_REQUEST_TTL_MS), so the cap is mainly a defense
 * against a misbehaving/spamming site, not normal usage. */
export async function addTransactionRequest(record: TransactionRequestRecord): Promise<void> {
  await serialized(async () => {
    const state = await getState();
    await setState({ transactionRequests: [record, ...state.transactionRequests].slice(0, MAX_TRANSACTION_REQUESTS) });
  });
}

/** Reports a lazily-computed "expired" status (never written back) for a stale pending/approved
 * request, mirroring walletd's own "Expired = derived on read" design -- see
 * TransactionRequestRecord's doc comment. "submitting"/"submitted"/"signed-unbroadcast"/
 * "rejected"/"failed" are past the expiry gate and always report as-is. */
export async function getTransactionRequest(id: string): Promise<TransactionRequestRecord | undefined> {
  const { transactionRequests } = await getState();
  const record = transactionRequests.find((r) => r.id === id);
  if (!record) return undefined;
  if ((record.status === "pending" || record.status === "approved") && Date.now() > record.expiresAt) {
    return { ...record, status: "rejected", error: "This request expired before it was submitted." };
  }
  return record;
}

/** Transitions a request to "submitted"/"signed-unbroadcast"/"failed" once its operation has
 * actually executed ("signed-unbroadcast" for a completed `x402SignClaim`, whose sealed payload
 * -- never broadcast by this wallet -- is the `result`). The approved/rejected decision write
 * lives in recordTransactionRequestDecision instead -- it is the only transition allowed to move
 * a request out of "pending", and it must be guarded against clobbering later states (a click
 * racing a submit must never resurrect "approved" over "submitting", which would let a second
 * concurrent claim through). */
export async function setTransactionRequestStatus(
  id: string,
  update: { status: "submitted" | "signed-unbroadcast"; result: unknown } | { status: "failed"; error: string }
): Promise<boolean> {
  return serialized(async () => {
    const state = await getState();
    const index = state.transactionRequests.findIndex((r) => r.id === id);
    if (index === -1) return false;
    const transactionRequests = [...state.transactionRequests];
    transactionRequests[index] = { ...transactionRequests[index]!, ...update };
    await setState({ transactionRequests });
    return true;
  });
}

/** Records the user's approve/reject click, but ONLY while the request is still "pending" --
 * returns false for an unknown id or any request already past the decision point. Deliberately
 * refuses to overwrite "submitting"/"submitted"/"failed": resolveApproval's persisted write can
 * race a submission that started moments earlier, and an unconditional write would flip a
 * mid-flight request back to "approved", reopening the exact double-submit window
 * beginTransactionRequestSubmit exists to close. */
/**
 * `chosenFeeType`, when given on an approval, overwrites the operation's own `feeType` with
 * whatever the user settled on in the popup — the dApp's original `feeType` was only ever a hint
 * (or, under `enforceFeeType`, the locked value the popup didn't let the user change either way) —
 * so by the time `submitApprovedTransactionRequest` reads the record's operation later, it's
 * always the final decision, not the dApp's request.
 */
export async function recordTransactionRequestDecision(
  id: string,
  approved: boolean,
  chosenFeeType?: "private" | "transparent"
): Promise<boolean> {
  return serialized(async () => {
    const state = await getState();
    const index = state.transactionRequests.findIndex((r) => r.id === id);
    if (index === -1) return false;
    const record = state.transactionRequests[index]!;
    if (record.status !== "pending") return false;
    const transactionRequests = [...state.transactionRequests];
    const operation =
      approved && chosenFeeType && record.operation.kind !== "redeemStealthOutputWithPrivateFee"
        ? { ...record.operation, feeType: chosenFeeType }
        : record.operation;
    transactionRequests[index] = { ...record, operation, status: approved ? "approved" : "rejected" };
    await setState({ transactionRequests });
    return true;
  });
}

/** Remembers the HTLC value the approval screen showed, while the request is still pending. */
export async function setTransactionRequestPreviewedHtlcValue(id: string, value: string): Promise<void> {
  await serialized(async () => {
    const state = await getState();
    const index = state.transactionRequests.findIndex((r) => r.id === id);
    if (index === -1 || state.transactionRequests[index]!.status !== "pending") return;
    const transactionRequests = [...state.transactionRequests];
    transactionRequests[index] = { ...transactionRequests[index]!, previewedHtlcValue: value };
    await setState({ transactionRequests });
  });
}

/** How beginTransactionRequestSubmit failed -- `record` carries the request's current (unmodified)
 * state whenever one was found, so callers can build a precise error message without a second
 * read. */
export type BeginSubmitOutcome =
  | { claimed: true; record: TransactionRequestRecord }
  | { claimed: false; reason: "not-found" | "expired" | "wrong-status"; record?: TransactionRequestRecord };

/**
 * Atomically claims an "approved" request for submission, moving it to "submitting" in the same
 * serialized read-modify-write that validates it -- the storage-level gate every submit path
 * (tari_submitTransactionRequest and the deprecated blocking wrappers alike) must pass before
 * executing anything. Because validation and transition happen as ONE queued write, two concurrent
 * submits cannot both observe "approved" and both execute: exactly one claim wins, the loser sees
 * "wrong-status". Also enforces the TTL here (an expired "approved" request fails with "expired"
 * rather than executing stale), which closes the deprecated blocking path's old gap where an
 * approval granted after sitting past `expiresAt` still submitted. A successful claim is final:
 * execution then either records "submitted"+result or "failed"+error, and a service worker killed
 * mid-execution leaves "submitting" stuck -- deliberately unresubmittable, see
 * TransactionRequestRecord.status's doc comment.
 */
export async function beginTransactionRequestSubmit(id: string): Promise<BeginSubmitOutcome> {
  return serialized(async () => {
    const state = await getState();
    const index = state.transactionRequests.findIndex((r) => r.id === id);
    if (index === -1) return { claimed: false as const, reason: "not-found" as const };
    const record = state.transactionRequests[index]!;
    if ((record.status === "pending" || record.status === "approved") && Date.now() > record.expiresAt) {
      return { claimed: false as const, reason: "expired" as const, record };
    }
    if (record.status !== "approved") {
      return { claimed: false as const, reason: "wrong-status" as const, record };
    }
    const transactionRequests = [...state.transactionRequests];
    transactionRequests[index] = { ...record, status: "submitting" };
    await setState({ transactionRequests });
    return { claimed: true as const, record: { ...record, status: "submitting" } };
  });
}

export async function wipeWallet(): Promise<void> {
  // Serialized too, even though it has no prior read to go stale: without this, a write already
  // in flight (e.g. an addTransactionHistoryEntry from a request that started just before Reset
  // was clicked) could finish *after* this clear and leave a stray fragment of the "wiped" wallet
  // behind -- exactly the kind of leftover a deliberate full wipe should never allow.
  await serialized(async () => {
    await chrome.storage.local.clear();
  });
}

// listShieldedOutputs/addShieldedOutput/markShieldedOutputSpent/listPendingShields/
// addPendingShield/removePendingShield/getPrivatePaymentScanCursor/setPrivatePaymentScanCursor
// moved to @chironbuilder/ootle-sdk (its own storage.ts, backed by this file's chromeStorageAdapter
// -- see background/index.ts's configureOotleStorage() call). See migrateOotleStorage.ts for the
// one-time move of any pre-SDK data an existing install already has under this file's old keys.
