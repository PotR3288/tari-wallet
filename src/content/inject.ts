// Runs in the PAGE's own JS world (manifest.json declares this content script with
// `"world": "MAIN"`), so `window` here is the actual page window — this is what defines
// `window.tari` for dApps to call, MetaMask-`window.ethereum`-style.
//
// It never touches key material directly; every call is relayed via window.postMessage to the
// content script (isolated world) which forwards it to the background service worker.
//
// Shaped to match the Tari Universe web wallet's own injected provider (its
// `public/tari-connector.js`) field-for-field and method-for-method — a dApp written against one
// should work unmodified against the other, and never has to detect which wallet it has.
import type { ProviderMethod, ProviderError } from "../lib/messages";

const PAGE_TARGET = "tari-wallet-page";
const CONTENT_TARGET = "tari-wallet-content";

type PendingResolvers = Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
const pending: PendingResolvers = new Map();

type Listener = (data: unknown) => void;
const listeners = new Map<string, Set<Listener>>();

function emit(event: string, data: unknown) {
  for (const handler of listeners.get(event) ?? []) {
    try {
      handler(data);
    } catch {
      // A dApp listener that throws must not break every other listener, or the bridge itself.
    }
  }
}

function randomId(): string {
  // A same-page script guessing a pending request's id could pre-resolve it with a forged
  // response before the real one arrives -- crypto.randomUUID() (a CSPRNG) instead of Math.random()
  // (not one) closes that off, matching the id generation approvals.ts already uses background-side.
  return crypto.randomUUID();
}

function request(method: ProviderMethod, params?: unknown): Promise<unknown> {
  const id = randomId();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // Targeted at this page's own origin, not "*" -- this never crosses an origin boundary (both
    // ends are the same window), so this is belt-and-braces rather than a fix for a real leak, but
    // it costs nothing and removes any doubt from future refactors.
    window.postMessage({ target: CONTENT_TARGET, type: "tari-request", id, method, params }, window.location.origin);
  });
}

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data || data.target !== PAGE_TARGET) return;

  if (data.type === "tari-response") {
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.error) {
      const providerError = data.error as ProviderError;
      const err = new Error(providerError.message || "Request failed") as Error & { code?: number };
      err.code = providerError.code;
      entry.reject(err);
    } else {
      entry.resolve(data.result);
    }
    return;
  }

  if (data.type === "tari-accounts-changed") {
    // Mirrors EIP-1193's `accountsChanged` event. Fires with an empty array whenever the wallet
    // drops this page's connection out from under it (e.g. the user switched accounts in the
    // extension) — listen for this instead of waiting for the next request to fail with "Site is
    // not connected" to know a fresh `tari_requestAccounts` call is needed. Dispatched both ways:
    // as a window CustomEvent (this wallet's original convention) and through `.on()` (the
    // documented cross-wallet provider interface, `tari-dapp.d.ts`'s `on?(event, handler)`) — a
    // dApp coded against either one sees it.
    window.dispatchEvent(new CustomEvent<string[]>("tari#accountsChanged", { detail: data.accounts }));
    emit("accountsChanged", data.accounts);
  }
});

export interface TariProvider {
  isTariWallet: true;
  info: { name: string; rdns: string; embedded: false };
  request(args: { method: ProviderMethod; params?: unknown }): Promise<unknown>;
  on(event: "accountsChanged", handler: (accounts: string[]) => void): () => void;

  // Sugar. Each is exactly the `request` call a dApp could make itself — mirrors the web wallet's
  // `public/tari-connector.js` so a dApp targeting both never loses the nicer API on either one.
  requestAccounts(): Promise<unknown>;
  getAccounts(): Promise<unknown>;
  getNetwork(): Promise<unknown>;
  getBalances(): Promise<unknown>;
  getCapabilities(): Promise<unknown>;
  getWalletAddress(): Promise<unknown>;
  getSubstate(substateId: string, version?: number | null): Promise<unknown>;
  getTransactionResult(transactionId: string): Promise<unknown>;
  signAndSubmitTransaction(params: unknown): Promise<unknown>;
  disconnect(): Promise<unknown>;
  requestViewAccess(): Promise<unknown>;
  getViewAccess(): Promise<unknown>;
  revokeViewAccess(): Promise<unknown>;
  getPrivateBalances(): Promise<unknown>;
  getShieldedOutputs(resourceAddress?: string): Promise<unknown>;
  scanForPrivatePayments(maxPages?: number): Promise<unknown>;
  scanForResourceUtxos(resourceAddress: string, maxPages?: number, pageSize?: number, limit?: number, transactionIds?: string[]): Promise<unknown>;
  claimPrivatePayment(resourceAddress: string, commitment: string): Promise<unknown>;
  signOwnershipChallenge(resourceAddress: string, substateId: string, challenge: string): Promise<unknown>;
  signWalletOwnershipChallenge(challenge: string): Promise<unknown>;
  createTransactionRequest(operation: unknown): Promise<unknown>;
  getTransactionRequest(requestId: string): Promise<unknown>;
  submitTransactionRequest(requestId: string): Promise<unknown>;
  /** The whole create -> approve -> submit cycle in one call, for when the page is happy to stay
   * alive for it. Prefer the three steps individually if your page can reload mid-flow: the
   * request id survives that and this promise does not. */
  requestTransaction(operation: unknown, pollIntervalMs?: number): Promise<unknown>;
}

const provider: TariProvider = {
  isTariWallet: true,
  info: { name: "Sapient", rdns: "mw.tari.sapient", embedded: false },
  request: ({ method, params }) => request(method, params),
  on: (event, handler) => {
    const set = listeners.get(event) ?? new Set();
    set.add(handler as Listener);
    listeners.set(event, set);
    return () => set.delete(handler as Listener);
  },

  requestAccounts: () => request("tari_requestAccounts"),
  getAccounts: () => request("tari_getAccounts"),
  getNetwork: () => request("tari_getNetwork"),
  getBalances: () => request("tari_getBalances"),
  getCapabilities: () => request("tari_getCapabilities"),
  getWalletAddress: () => request("tari_getWalletAddress"),
  getSubstate: (substateId, version) => request("tari_getSubstate", { substateId, version: version ?? null }),
  getTransactionResult: (transactionId) => request("tari_getTransactionResult", { transactionId }),
  signAndSubmitTransaction: (params) => request("tari_signAndSubmitTransaction", params),
  disconnect: () => request("tari_disconnect"),
  requestViewAccess: () => request("tari_requestViewAccess"),
  getViewAccess: () => request("tari_getViewAccess"),
  revokeViewAccess: () => request("tari_revokeViewAccess"),
  getPrivateBalances: () => request("tari_getPrivateBalances"),
  getShieldedOutputs: (resourceAddress) => request("tari_getShieldedOutputs", resourceAddress ? { resourceAddress } : {}),
  scanForPrivatePayments: (maxPages) => request("tari_scanForPrivatePayments", maxPages == null ? {} : { maxPages }),
  scanForResourceUtxos: (resourceAddress, maxPages, pageSize, limit, transactionIds) =>
    request("tari_scanForResourceUtxos", { resourceAddress, maxPages, pageSize, limit, transactionIds }),
  claimPrivatePayment: (resourceAddress, commitment) => request("tari_claimPrivatePayment", { resourceAddress, commitment }),
  signOwnershipChallenge: (resourceAddress, substateId, challenge) =>
    request("tari_signOwnershipChallenge", { resourceAddress, substateId, challenge }),
  signWalletOwnershipChallenge: (challenge) => request("tari_signWalletOwnershipChallenge", { challenge }),
  createTransactionRequest: (operation) => request("tari_createTransactionRequest", operation),
  getTransactionRequest: (requestId) => request("tari_getTransactionRequest", { requestId }),
  submitTransactionRequest: (requestId) => request("tari_submitTransactionRequest", { requestId }),

  requestTransaction: (operation, pollIntervalMs) => {
    const interval = pollIntervalMs ?? 500;
    return request("tari_createTransactionRequest", operation).then(
      (created) =>
        new Promise((resolve, reject) => {
          const { requestId } = created as { requestId: string };
          const poll = () => {
            request("tari_getTransactionRequest", { requestId }).then((raw) => {
              const summary = raw as { status: string; result?: unknown; error?: string };
              if (summary.status === "approved") {
                request("tari_submitTransactionRequest", { requestId }).then(resolve, reject);
                return;
              }
              // "signed-unbroadcast" is a completed sign-only x402SignClaim: the wallet's part is
              // done and the stored result is the sealed payload to hand to the facilitator --
              // resolve exactly like "submitted" would.
              if (summary.status === "submitted" || summary.status === "signed-unbroadcast") {
                resolve(summary.result);
                return;
              }
              if (summary.status === "rejected" || summary.status === "failed") {
                reject(new Error(summary.error || "The transaction request was not approved"));
                return;
              }
              setTimeout(poll, interval);
            }, reject);
          };
          poll();
        })
    );
  },
};

(window as unknown as { tari: TariProvider }).tari = provider;

// Announces itself the same way the web wallet's connector does (`window.tariProviders` +
// `tari:announceProvider`), so a page with both installed can enumerate every wallet instead of
// only ever seeing whichever one last claimed `window.tari`.
try {
  const w = window as unknown as { tariProviders?: TariProvider[] };
  const registry = Array.isArray(w.tariProviders) ? w.tariProviders : [];
  registry.push(provider);
  w.tariProviders = registry;
} catch {
  // A frozen window still gets the announcement event below.
}
try {
  window.dispatchEvent(new CustomEvent("tari:announceProvider", { detail: provider }));
} catch {
  // Older engines get window.tari/window.tariProviders regardless.
}
window.dispatchEvent(new Event("tari#initialized"));
