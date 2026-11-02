// Public payments received by a local account, for History.
//
// History is otherwise recorded as this wallet acts (see withHistory in index.ts), and private
// payments are recorded when a scan finds them -- but a plain public transfer *into* the account
// leaves no trace in either. Ootle has no "transactions for my account" query, so receipts are read
// from the indexer's per-vault events: a transaction that left one of the account's vaults richer
// is a receipt, unless it is one of this wallet's own (already in History, or its fee was paid
// from that same vault -- a sender pays the fee from their own vault, never the recipient's).

import { defaultIndexerUrl, getVaultIdsForAccount } from "@tari-project/ootle";
import { OotleAccount, toOotleNetwork, type NetworkName } from "@chironbuilder/ootle-sdk";
import { addTransactionHistoryEntry, listTransactionHistory } from "../lib/storage";
import { decodeEvent, decodeSubstateValue } from "../lib/bor";

const EVENT_PAGE = 100;
const EVENT_PAGES = 5;
const RECENT_PAGES = 2;
const SEEN_PREFIX = "publicReceiptsSeen:";

type VaultEvent = [string, { topic: string; payload: { amount?: number | string } }];

interface Deposit {
  key: string;
  transactionId: string;
  resourceAddress: string | null;
  net: bigint;
}

let running = false;

/**
 * Adds a "received" History entry for each public payment into the account not yet recorded.
 * Safe to call often: a pass already running is not doubled, each receipt is recorded once
 * (remembered by key, so a trimmed History is not refilled), and any failure leaves things as they
 * were for the next pass. The first pass for an account also records what arrived before it was
 * watched; those it can't date (no longer among the indexer's recent transactions) are recorded
 * with `createdAt: 0`, which History shows as "earlier".
 */
export async function syncPublicReceipts(
  accountId: string,
  account: OotleAccount,
  network: NetworkName,
  /** True while one of this wallet's own operations is in flight: its transaction id is not in
   * History yet, so its deposit can't be told from a receipt -- wait for the next pass. */
  busy: () => boolean
): Promise<number> {
  if (running || busy()) return 0;
  running = true;
  try {
    const seenKey = SEEN_PREFIX + accountId;
    const stored = (await chrome.storage.local.get(seenKey))[seenKey] as string[] | undefined;
    const backfill = stored === undefined;
    const seen = new Set(stored ?? []);

    const base = defaultIndexerUrl(toOotleNetwork(network));
    const provider = await account.getProvider();
    const component = await account.getComponentAddress();
    const deposits = await fetchDeposits(base, provider, component);
    const fresh = deposits.filter((d) => !seen.has(d.key));
    if (fresh.length === 0) {
      if (backfill) await chrome.storage.local.set({ [seenKey]: [] });
      return 0;
    }

    const history = await listTransactionHistory(accountId);
    const logged = new Set(history.map((e) => e.transactionId).filter(Boolean));
    if (busy()) return 0;
    const times = await recentTransactionTimes(base, new Set(fresh.map((d) => d.transactionId)));
    const balances = await account.getBalances().catch(() => []);

    let added = 0;
    // Oldest first, so History (newest first, by insertion) ends up in order.
    for (const d of [...fresh].reverse()) {
      seen.add(d.key);
      if (logged.has(d.transactionId)) continue;
      logged.add(d.transactionId);
      const meta = balances.find((b) => b.resourceAddress === d.resourceAddress);
      await addTransactionHistoryEntry({
        id: crypto.randomUUID(),
        accountId,
        kind: "received",
        resourceAddress: d.resourceAddress ?? undefined,
        amount: d.net.toString(),
        transactionId: d.transactionId,
        divisibility: meta?.divisibility,
        symbol: meta?.symbol,
        status: "confirmed",
        createdAt: times.get(d.transactionId) ?? (backfill ? 0 : Date.now()),
      });
      added++;
    }
    await chrome.storage.local.set({ [seenKey]: [...seen].slice(-2000) });
    return added;
  } catch {
    return 0; // indexer unreachable: the next pass tries again
  } finally {
    running = false;
  }
}

async function fetchDeposits(base: string, provider: Awaited<ReturnType<OotleAccount["getProvider"]>>, component: string): Promise<Deposit[]> {
  const vaultIds = await getVaultIdsForAccount(provider, component as Parameters<typeof getVaultIdsForAccount>[1]);
  if (vaultIds.length === 0) return [];
  const { substates } = await provider.fetchSubstates(vaultIds);
  const out: Deposit[] = [];
  for (const vaultId of vaultIds) {
    const value = decodeSubstateValue(substates[vaultId]?.value) as { Vault?: { resource_container: Record<string, { address?: string }> } } | undefined;
    const container = value?.Vault ? Object.values(value.Vault.resource_container)[0] : undefined;
    const resourceAddress = container?.address ?? null;
    const order: string[] = [];
    const net = new Map<string, bigint>();
    const feePaid = new Set<string>();
    for (let page = 0; page < EVENT_PAGES; page++) {
      const res = await fetch(`${base}/transactions/events?substate_id=${vaultId}&limit=${EVENT_PAGE}&offset=${page * EVENT_PAGE}`);
      if (!res.ok) throw new Error(`indexer ${res.status}`);
      // From Ootle 0.48 each event is a base64 CBOR `Event`; decodeEvent passes the old JSON through.
      const { events: raw } = (await res.json()) as { events: Array<[string, unknown]> };
      const events = raw.map(([txId, ev]) => [txId, decodeEvent<VaultEvent[1]>(ev)] as VaultEvent);
      for (const [txId, ev] of events) {
        if (ev.topic === "std.vault.pay_fee") feePaid.add(txId);
        const sign = ev.topic === "std.vault.deposit" ? 1n : ev.topic === "std.vault.withdraw" ? -1n : 0n;
        if (sign === 0n) continue;
        if (!net.has(txId)) order.push(txId);
        let amount = 0n;
        try {
          amount = BigInt(String(ev.payload.amount ?? 0));
        } catch {
          /* non-integer payload: count as nothing */
        }
        net.set(txId, (net.get(txId) ?? 0n) + sign * amount);
      }
      if (events.length < EVENT_PAGE) break;
    }
    // Events come newest first.
    for (const txId of order) {
      const n = net.get(txId)!;
      if (n > 0n && !feePaid.has(txId)) out.push({ key: `${txId}:${vaultId}`, transactionId: txId, resourceAddress, net: n });
    }
  }
  return out;
}

/** When the indexer saw each of these transactions, for those still among its recent ones. */
async function recentTransactionTimes(base: string, wanted: Set<string>): Promise<Map<string, number>> {
  const times = new Map<string, number>();
  let lastId: string | null = null;
  try {
    for (let page = 0; page < RECENT_PAGES && times.size < wanted.size; page++) {
      const res = await fetch(`${base}/transactions/recent?limit=50${lastId ? `&last_id=${lastId}` : ""}`);
      if (!res.ok) break;
      const { transactions } = (await res.json()) as { transactions: { transaction_id: string; created_at?: string }[] };
      if (transactions.length === 0) break;
      for (const t of transactions) {
        if (!wanted.has(t.transaction_id) || !t.created_at) continue;
        // "2026-10-01 09:06:40.0", in UTC.
        const at = Date.parse(t.created_at.replace(" ", "T") + "Z");
        if (Number.isFinite(at)) times.set(t.transaction_id, at);
      }
      lastId = transactions[transactions.length - 1]!.transaction_id;
    }
  } catch {
    /* undated is fine */
  }
  return times;
}
