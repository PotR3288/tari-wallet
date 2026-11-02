import {
  Network,
  TransactionBuilder,
  amountLiteral,
  defaultIndexerUrl,
  resolveMaxEpoch,
  resolveTransaction,
  resourceAddressLiteral,
} from "@tari-project/ootle";
import { decodeSubstateValue } from "./bor";
import { IndexerProvider } from "@tari-project/ootle-indexer";
import { WalletDaemonClient } from "@tari-project/ootle-wallet-daemon-signer";
import { parseOotleAddress } from "@tari-project/ootle-wasm";
import type {
  Account,
  AccountsCreateStealthTransferStatementRequest,
  AccountsCreateStealthTransferStatementResponse,
  IndexerGetTransactionResultResponse,
  Instruction,
  KeyId,
  Memo,
  StealthTransferStatement,
  SubstateRequirement,
  TransactionResult,
  TransactionWaitResultResponse,
  TransferOutput,
} from "@tari-project/ootle-ts-bindings";
import {
  type NetworkName,
  type PrivateBalance,
  type ShieldedOutputRecord,
  type TokenBalance,
  type TransactionExecuteOpts,
  type WalletAccountApi,
  deriveAccountComponentAddress,
  extractMissingSubstateAddress,
  resolveInputsWithRetry,
  resolveSendPrivatelyPlan,
  resolveUnshieldPlan,
  substateExists,
  toOotleNetwork,
  withTimeout,
} from "@chironbuilder/ootle-sdk";
import { toHex } from "./vault";

const DAEMON_TIMEOUT_MS = 15_000;

// Mirrors tari-wallet-extension's own popup/format.ts copy of this same well-known constant (not
// re-exported by @chironbuilder/ootle-sdk itself, and not worth importing across the popup/lib
// boundary just for one string) -- see that file's own comment for why every project in this
// ecosystem independently declares it rather than sharing one source.
const TARI_RESOURCE_ADDRESS = "resource_0101010101010101010101010101010101010101010101010101010101010101";

/** Shared by every stealth output this class creates (`shield`/`unshield`/`sendPrivately`) --
 * a plain-text memo is always the `Message` variant of the daemon's `Memo` union. */
function toMemo(memo?: string): Memo | null {
  return memo ? { Message: memo } : null;
}

/**
 * A plain `fetch()` failure (connection refused, DNS failure, or — on some platforms — a hang that
 * never even reaches the daemon) throws a raw `TypeError`/`AbortError` straight out of
 * `FetchRpcTransport`. An actual JSON-RPC error the daemon *did* respond with (wrong auth, bad
 * params, ...) is always wrapped by `WalletDaemonClient` as `Error("RPC Error ...", { cause: {
 * method, code, message, data } })` — checking for `method` alongside `code` matters: Chrome's
 * `fetch()` throws a bare `TypeError` with no `.cause` for a connection failure, but Node's
 * (undici-based) `fetch()` sets `.cause` to the underlying errno error, which *also* has a `.code`
 * (e.g. `"ECONNREFUSED"`) — confirmed empirically this produces a false negative here when
 * exercised from a Node verification script, even though the real (browser) code path never hits
 * it. `method` is unique to this client's own RPC-error wrapping either way, so checking for it is
 * strictly more correct in both environments. That distinction is what lets `connectClient()` below
 * skip a doomed-to-fail retry when the daemon isn't reachable at all, instead of just being slow to
 * say so.
 */
export function isDaemonUnreachable(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return !(e.cause && typeof e.cause === "object" && "method" in e.cause && "code" in e.cause);
}

/**
 * The daemon rejects both "this API key is invalid/expired/revoked" and "this API key lacks the
 * permission this call needed" as the *same* HTTP-ish code (401) — confirmed empirically against a
 * live daemon; there's no 403 involved at all. The only way to tell them apart is the message text:
 * "Access denied. ..." for the former, "Insufficient permissions. Required '...'" for the latter.
 * Distinguishing them matters because the fix is different — a dead key needs a fresh one, a live
 * key with too-narrow a scope needs one minted with more permissions.
 */
export function classifyAuthRejection(e: unknown): "expired-or-invalid" | "insufficient-permission" | null {
  if (!(e instanceof Error) || !e.cause || typeof e.cause !== "object" || !("code" in e.cause) || e.cause.code !== 401) {
    return null;
  }
  const message = "message" in e.cause ? String(e.cause.message) : "";
  if (/insufficient permission/i.test(message)) return "insufficient-permission";
  return "expired-or-invalid";
}

/** Runs a daemon call with a bounded timeout and rewrites an unreachable-daemon failure (dead
 * connection or a hang past the timeout — indistinguishable from the user's point of view) or an
 * auth-shaped rejection (see `classifyAuthRejection`) into an actionable message, instead of a raw
 * "Failed to fetch" or "RPC Error 401: ...". */
async function daemonCall<T>(url: string, promise: Promise<T>, label: string, timeoutMs = DAEMON_TIMEOUT_MS): Promise<T> {
  try {
    return await withTimeout(promise, timeoutMs, label);
  } catch (e) {
    if (isDaemonUnreachable(e)) {
      const details = e instanceof Error ? e.message : String(e);
      throw new Error(`Could not reach the daemon at ${url} — make sure tari_ootle_walletd is running. (${details})`);
    }
    const details = e instanceof Error ? e.message : String(e);
    const authKind = classifyAuthRejection(e);
    if (authKind === "insufficient-permission") {
      throw new Error(
        `This daemon's API key doesn't have enough permission (needed while ${label}). Mint a new key with the "admin" permission from the daemon's web UI and reconnect. (${details})`
      );
    }
    if (authKind === "expired-or-invalid") {
      throw new Error(
        `This daemon's API key was rejected while ${label} — it may have expired or been revoked. Reconnect this daemon with a fresh API key (Settings → Daemon connections). (${details})`
      );
    }
    throw e;
  }
}

/**
 * One account on a `tari_ootle_walletd` this extension has connected to as a JRPC client — the
 * "hardware wallet" counterpart to `OotleAccount`. The daemon holds the real key material; this
 * class never signs or derives anything itself. Two consequences follow directly from that:
 *
 * 1. Unlike `OotleAccount.execute()`, this never runs a client-side substate-discovery retry loop.
 *    The daemon's own `transactions.submit` JRPC takes `detect_inputs: true`, which asks the
 *    daemon to run its real want-derivation (the same pass `ootle_sdk_core` does natively in Rust,
 *    which the TS indexer path this extension otherwise relies on doesn't have) — so it resolves
 *    every substate an instruction touches itself, server-side, in one round trip.
 * 2. `resolveTransaction()` (this extension's own `IndexerProvider`, not the daemon's) is still
 *    used before submission purely to fill in valid epoch bounds locally — a cheap, read-only step
 *    that doesn't require the daemon and keeps this class's shape close to `OotleAccount`'s.
 */
export class DaemonAccount implements WalletAccountApi {
  readonly network: Network;

  constructor(
    private readonly client: WalletDaemonClient,
    private readonly indexerProvider: IndexerProvider,
    networkName: NetworkName,
    private account: Account,
    private readonly address: string,
    private readonly url: string
  ) {
    this.network = toOotleNetwork(networkName);
  }

  /**
   * Connects to a running wallet daemon using a long-lived **API key**, not a browser session.
   *
   * This deliberately does *not* attempt `auth.request`/WebAuthn/`auth.refresh` session login —
   * confirmed with the tari-ootle maintainers (see the PR this replaced:
   * github.com/tari-project/tari-ootle/pull/2375) that `auth.refresh` reads an HttpOnly,
   * SameSite=Strict session cookie set on browser login, which a `chrome-extension://` origin
   * cannot ever hold — by design, not a bug. WebAuthn (the daemon's actual default auth method,
   * not `none`) additionally locks its RP origin to `http://localhost:{json_rpc_port}`, which a
   * Chrome extension page is never running on either way. Neither session-auth path can work from
   * here, full stop — an API key (minted from the daemon's own web UI, which *does* have a real
   * Admin browser session) is the supported way for an external client like this extension to
   * authenticate, and needs no refresh at all.
   */
  static async connectClient(url: string, apiKey: string): Promise<WalletDaemonClient> {
    if (!apiKey) {
      throw new Error(
        "This daemon needs an API key. Mint one from the daemon's own web UI (requires an Admin login there), then paste it in here."
      );
    }
    const client = WalletDaemonClient.usingFetchTransport(url);
    client.setReauthenticationEnabled(false);
    client.setToken(apiKey);
    // `accounts.list` (not `wallet.get_info`, which doesn't require auth at all — confirmed
    // empirically it answers fine with a garbage token) doubles as both the connectivity check and
    // the "is this API key even valid" check in one round trip. `daemonCall`'s own auth-rejection
    // classification already turns a dead/wrong key into a clear message from here.
    await daemonCall(url, client.accountsList({ offset: 0, limit: 1 }), "connecting to the daemon");

    // This wallet needs Admin specifically, not just read access — confirmed empirically that
    // accounts.create_free_test_coins (the daemon-relayed "Claim testnet TARI" feature) rejects a
    // narrowly-scoped key with "Insufficient permissions. Required 'Admin'" verbatim, not a finer
    // per-resource grant, and transaction submission needs write access this class has no way to
    // probe more surgically. There's no direct "what does this key grant" introspection available
    // to API-key auth — auth.list_api_keys explicitly refuses it ("requires an interactive user
    // session, not an API key") — so this probes settings.get instead: a harmless read nothing else
    // in this class ever calls, gated on Settings(Read) specifically. No legitimately-scoped
    // wallet-purpose key would have a reason to carry that permission on its own, so requiring it
    // succeed is a reliable proxy for "this key was minted with admin" in practice, even though it
    // isn't a direct proof of it.
    await daemonCall(url, client.settingsGet(), "verifying this API key has admin permissions");
    return client;
  }

  static async listAccounts(client: WalletDaemonClient, url: string): Promise<Account[]> {
    const { accounts } = await daemonCall(url, client.accountsList({ offset: 0, limit: 200 }), "listing the daemon's accounts");
    return accounts.map((a) => a.account);
  }

  static async connectAccount(
    client: WalletDaemonClient,
    url: string,
    networkName: NetworkName,
    componentAddress: string
  ): Promise<DaemonAccount> {
    const { account, address } = await daemonCall(
      url,
      client.accountsGet({ name_or_address: { ComponentAddress: componentAddress } }),
      "looking up the daemon account"
    );
    const indexerProvider = await IndexerProvider.connect({ url: defaultIndexerUrl(toOotleNetwork(networkName)), network: toOotleNetwork(networkName) });
    return new DaemonAccount(client, indexerProvider, networkName, account, address, url);
  }

  async getComponentAddress(): Promise<string> {
    return this.account.component_address;
  }

  async getWalletAddress(): Promise<string> {
    return this.address;
  }

  async getProvider(): Promise<IndexerProvider> {
    return this.indexerProvider;
  }

  async getBalances(): Promise<TokenBalance[]> {
    const { balances } = await daemonCall(
      this.url,
      this.client.accountsGetBalances({ account: { ComponentAddress: this.account.component_address }, refresh: true }),
      "fetching balances"
    );
    if (balances.length === 0) return [];

    // The daemon's own balance RPC only returns `token_symbol`, not the resource's longer
    // `metadata.name` — fetched separately via this account's own indexer connection (the same one
    // used for epoch-bound resolution in execute()), mirroring OotleAccount.getBalances()'s
    // resource-substate lookup so both account types expose the same TokenBalance shape.
    const resourceIds = [...new Set(balances.map((b) => b.resource_address))];
    const { substates } = await this.indexerProvider.fetchSubstates(resourceIds);
    const nameByResource = new Map<string, string | null>();
    for (const id of resourceIds) {
      const value = decodeSubstateValue<Record<string, unknown> | undefined>(substates[id]?.value);
      const resource = value && "Resource" in value ? (value.Resource as { metadata?: Record<string, unknown> }) : undefined;
      const name = resource?.metadata?.name;
      nameByResource.set(id, typeof name === "string" ? name : null);
    }

    return balances.map((b) => ({
      resourceAddress: b.resource_address,
      kind: b.resource_type,
      amount: BigInt(b.balance),
      // The daemon computes this server-side with its own view-key access (BalanceEntry's
      // own `confidential_balance` field) — no client-side decryption needed or possible here,
      // unlike OotleAccount.getBalances(). confidentialDecryptFailures has no daemon-side
      // equivalent to report, so it's always 0 for this account type.
      confidentialAmount: BigInt(b.confidential_balance),
      confidentialDecryptFailures: 0,
      divisibility: b.divisibility,
      symbol: b.token_symbol,
      name: nameByResource.get(b.resource_address) ?? null,
      // The daemon's BalanceEntry RPC has no token-id list field to surface here (unlike the local
      // vault-container path in OotleAccount.getBalances()) -- daemon-relayed NonFungible display
      // is out of scope for this fix.
      nonFungibleTokenIds: null,
    }));
  }

  /** Shared by getPrivateBalances() and shield()'s own recipient-side friendly display -- the
   * daemon's stealth RPCs return only a resource address, never its symbol/name/divisibility
   * (unlike accountsGetBalances(), whose BalanceEntry carries token_symbol/divisibility directly).
   * Mirrors getBalances()'s own indexer substate lookup. */
  private async fetchResourceMeta(resourceAddress: string): Promise<{ name: string | null; symbol: string | null; divisibility: number }> {
    const { substates } = await this.indexerProvider.fetchSubstates([resourceAddress]);
    const value = decodeSubstateValue<Record<string, unknown> | undefined>(substates[resourceAddress]?.value);
    const resource = value && "Resource" in value ? (value.Resource as { metadata?: Record<string, unknown>; divisibility?: number }) : undefined;
    const name = resource?.metadata?.name;
    const symbol = resource?.metadata?.SYMBOL ?? resource?.metadata?.symbol;
    return {
      name: typeof name === "string" ? name : null,
      symbol: typeof symbol === "string" ? symbol : null,
      divisibility: resource?.divisibility ?? 0,
    };
  }

  /**
   * Lists this account's unspent stealth (freestanding UTXO) outputs for `resourceAddress` —
   * the daemon-relayed counterpart to `OotleAccount.listUnspentShieldedOutputs()`. Unlike that
   * local method (which can only ever know about an output it created or was explicitly told
   * about — see `ShieldedOutputRecord`'s own doc comment for why there is no scan-by-commitment
   * API), the daemon maintains its own server-side index of every stealth UTXO addressed to this
   * account's view key, decrypted server-side, so `stealthUtxosList`'s own `value` field is
   * already the real amount for any UTXO this call scopes to (`account_address` set) — confirmed
   * directly against a live daemon that a *separate* `stealthUtxosDecryptValue` call for the same
   * ids comes back empty (that RPC is for a commitment this account doesn't already recognize as
   * its own -- claiming an externally-handed-off payment, not re-deriving a value `list` already
   * decrypted), so this does not also call it.
   *
   * `transactionId`/`createdAt` are always empty/zero: `UtxoInfo` (the daemon's own shape) carries
   * neither, unlike `OotleAccount`'s locally-written `ShieldedOutputRecord`, which knows both
   * because it wrote the record itself at creation time.
   */
  async listUnspentShieldedOutputs(resourceAddress: string = TARI_RESOURCE_ADDRESS): Promise<ShieldedOutputRecord[]> {
    const { utxos } = await daemonCall(
      this.url,
      this.client.stealthUtxosList({ resource_address: resourceAddress, account_address: this.account.component_address, filter_by_status: "Unspent" }),
      "listing shielded outputs"
    );
    return utxos.map((utxo) => ({
      accountId: this.account.component_address,
      resourceAddress,
      commitment: utxo.address.id,
      amount: utxo.value.toString(),
      transactionId: "",
      createdAt: 0,
      spent: utxo.status !== "Unspent",
      memo: utxo.memo && "Message" in utxo.memo ? utxo.memo.Message : undefined,
    }));
  }

  /** Daemon-relayed counterpart to `OotleAccount.getPrivateBalances()`. Scoped to TARI only (unlike
   * the local implementation, which can total any resource it has records for): the daemon has no
   * "list every resource this account has stealth activity in" RPC, only a per-resource
   * `stealthUtxosList`, so there is no way to discover which other resources to even ask about
   * without the caller already naming one. TARI is the one resource every account in this ecosystem
   * is guaranteed to have touched (fees, `claimTestnetXtr()`), so it is the only one queried here. */
  async getPrivateBalances(): Promise<PrivateBalance[]> {
    const resourceAddress = TARI_RESOURCE_ADDRESS;
    const outputs = await this.listUnspentShieldedOutputs(resourceAddress);
    if (outputs.length === 0) return [];
    const amount = outputs.reduce((sum, o) => sum + BigInt(o.amount), 0n);
    const meta = await this.fetchResourceMeta(resourceAddress);
    return [{ resourceAddress, amount, outputCount: outputs.length, divisibility: meta.divisibility, symbol: meta.symbol, name: meta.name }];
  }

  /**
   * Moves `amount` of this account's own revealed balance into a freestanding stealth output
   * addressed to itself, via the daemon's own `accounts.stealth_transfer` RPC (`RevealedOnly`
   * input selection: source is the revealed vault, never an existing stealth/confidential output).
   * Unlike `OotleAccount.shield()`, which builds and signs the `StealthTransfer` locally and
   * already knows the commitment it created before submitting, this only learns the daemon's own
   * choice of commitment/substate after the fact, by finding the one `utxo_<resource>_<commitment>`
   * entry in the finalized transaction's `up_substates` — confirmed directly against a live daemon
   * (dry-run and real submission both verified) rather than assumed from the request/response
   * types alone, since neither documents this shape.
   *
   * `feeType` is deliberately not a parameter (unlike `OotleAccount.shield()`'s signature): a
   * private-fee shield needs a stealth UTXO to already exist to pay from, which is exactly what
   * this call is creating — `resolveFeeType()` in background/index.ts already requires a local
   * account for `feeType: "private"` on every operation, this one included.
   *
   * `minimumValuePromise > 0` is rejected outright: read the Rust source and confirmed
   * `create_output_witness` (`crates/wallet/sdk/src/apis/stealth_outputs.rs` -- the function
   * *every* server-side stealth-output-creating RPC goes through) hardcodes `minimum_value_promise:
   * 0` on every output it builds. There is no daemon JRPC that can put a nonzero floor on the
   * output's own commitment at all -- the previous version of this method instead silently
   * reinterpreted the parameter as "split the shielded amount into a smaller blinded output plus a
   * plain, fully public deposit of the 'promise' back into this account's revealed vault," which is
   * not a proof of anything and, confirmed live, throws outright once the whole amount is
   * "promised" (blinded_output_amount becomes 0, so no witness/output gets created at all, and
   * `up_substates` never gets a `utxo_` entry to report back).
   */
  async shield(
    resourceAddress: string,
    amount: bigint,
    maxFee = 50000n,
    memo?: string,
    minimumValuePromise = 0n
  ): Promise<{ transactionId: string; commitment: string; substateId: string; minimumValuePromise: string }> {
    if (minimumValuePromise > 0n) {
      throw new Error(
        "A proof-of-funds minimumValuePromise isn't supported for daemon-connected accounts — the daemon has no JRPC that can set it on the output. Pass minimumValuePromise: 0n (the default) or switch to a local account."
      );
    }

    const { transaction_id } = await daemonCall(
      this.url,
      this.client.stealthTransfer({
        owner_account: { ComponentAddress: this.account.component_address },
        fee_params: { input_selection: "RevealedOnly", pay_fee_with_swap: null },
        input_selection: "RevealedOnly",
        resource_address: resourceAddress,
        transfers: [
          {
            destination_address: this.address,
            blinded_output_amount: amount.toString(),
            revealed_output_amount: 0n,
            pay_to: "StealthPublicKey",
            attach_sender_address: false,
            output_memo: toMemo(memo),
          },
        ],
        max_fee: maxFee.toString(),
        dry_run: false,
      }),
      "shielding funds"
    );

    const response = await this.waitForFinalization(transaction_id, "waiting for the shield to finalize");
    if (!response.result) throw new Error(`Transaction ${transaction_id} has no result after waiting.`);
    throwOnRejection(transaction_id, response.result.result);

    const upSubstates = "Accept" in response.result.result ? response.result.result.Accept.up_substates : [];
    const utxoEntry = upSubstates.find(([id]) => id.startsWith("utxo_"));
    if (!utxoEntry) throw new Error(`Shield transaction ${transaction_id} finalized but created no stealth output substate.`);
    const [substateId] = utxoEntry;
    const commitment = substateId.slice(substateId.lastIndexOf("_") + 1);

    return { transactionId: transaction_id, commitment, substateId, minimumValuePromise: minimumValuePromise.toString() };
  }

  /**
   * Low-level counterpart to `shield()`'s single high-level RPC: asks the daemon to build a
   * signed spend statement for `utxoIds` (named, exact stealth UTXOs -- `Specific` selection,
   * never an amount-based one, so the daemon locks precisely the inputs this class's own
   * coin-selection already chose) and lock them under a `lock_id` for up to 5 minutes, without
   * yet building or submitting any transaction. This is `accounts.create_stealth_transfer_statement`
   * -- confirmed present and fully working against this locally-built daemon, but absent from the
   * currently-published `@tari-project/wallet_jrpc_client` npm bindings (see the tari-ootle issue
   * this gap was filed against), so it is called via `WalletDaemonClient.sendRequest()`'s raw
   * escape hatch rather than a typed wrapper method.
   *
   * The response's own `signing_keys` is *not* always this account's owner key: confirmed live
   * that for a `Specific` selection the daemon always derives a fresh one-off nonce key instead
   * (since `Specific` never draws from the revealed vault, so no owner-key signature is needed for
   * that part) -- the caller must still carry it into the transaction as an `other_signers` entry,
   * since it authorises the statement's own balance proof. The UTXO spend-key signature itself
   * (`utxo_signers` in the response) needs no such handling here: passing `lock_id` back as the
   * transaction's own `lock_ids` makes the daemon re-derive and apply it automatically
   * (`derive_stealth_signers` in `transaction.rs`).
   */
  private async createStealthTransferStatement(
    resourceAddress: string,
    utxoIds: string[],
    outputs: TransferOutput[]
  ): Promise<{ statement: StealthTransferStatement; lockId: number; otherSigners: KeyId[] }> {
    const request: AccountsCreateStealthTransferStatementRequest = {
      requests: [
        {
          sender_account: { ComponentAddress: this.account.component_address },
          resource_address: resourceAddress,
          input_selection: { Specific: { utxo_addresses: utxoIds.map((id) => ({ resource_address: resourceAddress, id })) } },
          outputs,
        },
      ],
    };
    const response = await daemonCall(
      this.url,
      this.client.sendRequest<AccountsCreateStealthTransferStatementResponse>(
        "accounts.create_stealth_transfer_statement",
        request
      ),
      "building the stealth transfer statement"
    );
    const statement = response.statements[0];
    if (!statement) throw new Error("The daemon returned no statement for this stealth transfer request.");
    const ownerKeyId = this.account.owner_key_id;
    const otherSigners = response.signing_keys.filter((k) => JSON.stringify(k) !== JSON.stringify(ownerKeyId));
    return { statement, lockId: response.lock_id, otherSigners };
  }

  /**
   * Submits `instructions` (already containing the `StealthTransfer` instruction built from a
   * `createStealthTransferStatement()` statement) via the shared `buildSubmitRequest()`/
   * `waitForFinalization()` pair `execute()` also uses, except it also passes `lockId` back as the
   * request's own `lock_ids` and `otherSigners` -- the two details `execute()` itself never needs
   * (a plain instruction has no stealth lock to redeem or extra statement signer to carry).
   */
  private async submitStealthTransaction(
    instructions: Instruction[],
    lockId: number,
    otherSigners: KeyId[],
    maxFee: bigint
  ): Promise<{ transactionId: string; result: TransactionWaitResultResponse }> {
    const request = await this.buildSubmitRequest(instructions, maxFee, { otherSigners, lockIds: [lockId] });
    const { transaction_id } = await daemonCall(this.url, this.client.submitTransaction(request), "submitting the stealth transaction");
    const response = await this.waitForFinalization(transaction_id);
    if (response.result) throwOnRejection(transaction_id, response.result.result);
    return { transactionId: transaction_id, result: response };
  }

  /**
   * Daemon-relayed counterpart to `OotleAccount.unshield()`. Selects this account's own unspent
   * stealth UTXOs via the same exported `resolveUnshieldPlan` coin-selection `OotleAccount` uses
   * (largest-first, guaranteeing a stealth change remainder `> 0`), then spends them through
   * `createStealthTransferStatement()`/`submitStealthTransaction()` instead of local signing.
   *
   * A `StealthTransfer` instruction whose statement carries a positive revealed amount always
   * leaves that amount as a dangling bucket on the workspace -- confirmed live (dry-run and a real
   * submission) against this daemon. `OotleAccount`'s own local path never hits this because its
   * `WalletStealthAuthorizer` only auto-emits the matching deposit when the *same* instruction also
   * withdraws a trivial revealed "dust" input (see that class's own `unshield()` doc comment) --
   * this class has no such local authorizer to lean on, so it always appends its own
   * `PutLastInstructionOutputOnWorkspace` + `deposit` pair to consume the bucket itself.
   */
  async unshield(
    resourceAddress: string,
    revealedOutAmount: bigint,
    maxFee = 50000n,
    memo?: string
  ): Promise<{ transactionId: string }> {
    if (revealedOutAmount <= 0n) throw new Error("The amount to reveal must be greater than zero.");

    const records = await this.listUnspentShieldedOutputs(resourceAddress);
    const { commitments, remainder } = resolveUnshieldPlan(records, resourceAddress, revealedOutAmount);

    const { statement, lockId, otherSigners } = await this.createStealthTransferStatement(resourceAddress, commitments, [
      {
        address: this.address,
        revealed_amount: revealedOutAmount.toString(),
        blinded_amount: remainder.toString(),
        memo: toMemo(memo),
        pay_to: "StealthPublicKey",
      },
    ]);

    const instructions: Instruction[] = [
      { StealthTransfer: { resource_address_ref: { Address: resourceAddress }, statement, revealed_input_bucket: null } },
      { PutLastInstructionOutputOnWorkspace: { key: 0 } },
      {
        CallMethod: {
          call: { Address: this.account.component_address },
          method: "deposit",
          args: [{ Workspace: { id: 0, offset: null } }],
        },
      },
    ];

    return this.submitStealthTransaction(instructions, lockId, otherSigners, maxFee);
  }

  /**
   * Daemon-relayed counterpart to `OotleAccount.sendPrivately()`. Selects this account's own
   * unspent stealth UTXOs via the same exported `resolveSendPrivatelyPlan` coin-selection
   * `OotleAccount` uses, and spends them to create a brand-new stealth output addressed to
   * `recipientWalletAddress` (plus a same-account change output if the selected total exceeds
   * `amount`) -- same on-chain shape as `OotleAccount.sendPrivately()`, same caveats (no scan API;
   * the recipient only discovers the payment once handed the resulting commitment out of band).
   *
   * The recipient's output is always the *first* entry in the statement request specifically so
   * `extractRecipientCommitment` can pick it out of the finalized transaction's `up_substates` --
   * confirmed live (a real two-output submission, distinct amounts) that `up_substates`' stealth
   * UTXO entries come back in the same order the request's `outputs` were given in, not some
   * other order (e.g. smallest-first or hash order).
   *
   * `minimumValuePromise > 0` is deliberately unsupported here (unlike `OotleAccount`'s own
   * signature): partially revealing the *recipient's* output would need that revealed portion
   * deposited into their own account component -- deriving it, and creating it on-chain first if
   * it doesn't exist yet, the same way `send()` already handles a first-time recipient -- which
   * has not been built or verified against a live daemon. Only the fully-blinded transfer this
   * defaults to has been confirmed (dry-run and a real submission).
   */
  async sendPrivately(
    resourceAddress: string,
    recipientWalletAddress: string,
    amount: bigint,
    maxFee = 50000n,
    memo?: string,
    minimumValuePromise = 0n
  ): Promise<{ transactionId: string; recipientCommitment: string; recipientSubstateId: string; minimumValuePromise: string }> {
    if (amount <= 0n) throw new Error("The amount to send must be greater than zero.");
    if (minimumValuePromise > 0n) {
      throw new Error(
        "Sending with a revealed minimumValuePromise isn't supported for daemon-connected accounts yet — pass minimumValuePromise: 0n (the default) or switch to a local account."
      );
    }

    const records = await this.listUnspentShieldedOutputs(resourceAddress);
    const { commitments, changeAmount } = resolveSendPrivatelyPlan(records, resourceAddress, amount);

    const outputs: TransferOutput[] = [
      {
        address: recipientWalletAddress,
        revealed_amount: "0",
        blinded_amount: amount.toString(),
        memo: toMemo(memo),
        pay_to: "StealthPublicKey",
      },
    ];
    if (changeAmount > 0n) {
      outputs.push({
        address: this.address,
        revealed_amount: "0",
        blinded_amount: changeAmount.toString(),
        memo: null,
        pay_to: "StealthPublicKey",
      });
    }

    const { statement, lockId, otherSigners } = await this.createStealthTransferStatement(resourceAddress, commitments, outputs);

    const instructions: Instruction[] = [
      { StealthTransfer: { resource_address_ref: { Address: resourceAddress }, statement, revealed_input_bucket: null } },
    ];

    const { transactionId, result } = await this.submitStealthTransaction(instructions, lockId, otherSigners, maxFee);

    const upSubstates =
      result.result?.result && "Accept" in result.result.result ? result.result.result.Accept.up_substates : [];
    const recipientEntry = upSubstates.find(([id]) => id.startsWith("utxo_"));
    if (!recipientEntry) {
      throw new Error(`sendPrivately transaction ${transactionId} finalized but created no stealth output substate.`);
    }
    const [recipientSubstateId] = recipientEntry;
    const recipientCommitment = recipientSubstateId.slice(recipientSubstateId.lastIndexOf("_") + 1);

    return { transactionId, recipientCommitment, recipientSubstateId, minimumValuePromise: minimumValuePromise.toString() };
  }

  /**
   * Builds an unsigned transaction locally (same `TransactionBuilder` as `OotleAccount`), then hands
   * it to the daemon to resolve inputs, sign, and submit/simulate. `seal_signer` must be this
   * account's own owner key so the daemon signs and seals with the same key that pays the fee.
   * Shared by `execute()` (plain instructions, no stealth lock) and `submitStealthTransaction()`
   * (a `StealthTransfer` instruction, which needs `lockIds`/`otherSigners` from its own statement).
   */
  private async buildSubmitRequest(
    instructions: Instruction[],
    maxFee: bigint,
    opts: { inputs?: SubstateRequirement[]; otherSigners?: KeyId[]; lockIds?: number[] } = {}
  ) {
    const ownerKeyId: KeyId | null = this.account.owner_key_id;
    if (!ownerKeyId) throw new Error("This daemon account has no owner key — it is view-only and cannot sign transactions.");

    const maxEpoch = await resolveMaxEpoch(this.indexerProvider);
    const builder = TransactionBuilder.new(this.network, maxEpoch)
      .withInstructions(instructions)
      .feeTransactionPayFromComponent(this.account.component_address, maxFee);
    if (opts.inputs?.length) builder.withInputs(opts.inputs);
    const unsignedTx = await withTimeout(
      resolveTransaction(this.indexerProvider, builder.buildUnsignedTransaction()),
      DAEMON_TIMEOUT_MS,
      "resolving the transaction"
    );
    // `TransactionBuilder` defaults this to false — the engine's `TransactionSignatureValidator`
    // then rejects with "has no main signer" unless there's a real per-instruction participant
    // signature (what OotleAccount's local signing produces via `signTransaction([signer], ...)`).
    // The daemon's own single-signer convenience RPCs (accountsTransfer, createFreeTestCoins) rely
    // on this flag being true instead, so their `seal_signer`-only, empty-`other_signers` shape
    // works — confirmed empirically: submission failed with exactly that "no main signer" error
    // until this was set, against a live tari_ootle_walletd on esmeralda.
    unsignedTx.main_signer = "SealSigner";

    return {
      transaction: { V1: unsignedTx },
      seal_signer: ownerKeyId,
      other_signers: opts.otherSigners ?? [],
      signatures: [],
      detect_inputs: true,
      detect_inputs_use_unversioned: true,
      lock_ids: opts.lockIds ?? [],
    };
  }

  /** The daemon's own `timeout_secs: 60` bounds how long it waits for finalization server-side; the
   * client-side budget here just needs enough slack for that plus normal round-trip time so a dead
   * connection (not just a slow finalization) still surfaces as a clear error. Shared by every
   * submit path (`execute()`, `submitStealthTransaction()`, `shield()`). */
  private async waitForFinalization(
    transactionId: string,
    label = "waiting for the transaction to finalize"
  ): Promise<TransactionWaitResultResponse> {
    const response = await daemonCall(
      this.url,
      this.client.waitForTransactionResult({ transaction_id: transactionId, timeout_secs: 60 }),
      label,
      70_000
    );
    if (response.timed_out) throw new Error(`Timed out waiting for transaction ${transactionId} to finalize.`);
    return response;
  }

  async execute(instructions: Instruction[], opts: TransactionExecuteOpts = {}): Promise<unknown> {
    const maxFee = opts.maxFee ?? 5000n;

    if (opts.dryRun) {
      const request = await this.buildSubmitRequest(instructions, maxFee, { inputs: opts.inputs });
      const response = await daemonCall(this.url, this.client.submitTransactionDryRun(request), "simulating the transaction");
      throwOnRejection(response.transaction_id, response.result.finalize.result);
      return response;
    }

    // The daemon's own `detect_inputs` runs a real want-derivation pass server-side (see this
    // class's own doc comment above the constructor), but confirmed live it still can't discover a
    // substate that only becomes reachable once a *nested* cross-template call actually runs (e.g.
    // a marketplace escrow template's own internal `deposit` into the seller's vault, one level
    // below the instruction this class submits) -- that fails on-chain as `AcceptFeeRejectRest`
    // with "Substate '<id>' not found or is not a transaction input", the exact shape
    // `extractMissingSubstateAddress` (originally built for `OotleAccount`'s own client-side
    // want-derivation retry, which has no server-side detection to lean on at all) already parses.
    // Same bounded-retry shape here: pin the newly-discovered substate as an explicit input and
    // resubmit -- a real new transaction each attempt (a rejected one still burns its fee, same
    // cost `OotleAccount`'s own retry already accepts), capped at `opts.maxRetries` and never
    // retried twice for the same address.
    const maxRetries = opts.maxRetries ?? 3;
    let inputs = opts.inputs ?? [];
    const seenAddresses = new Set<string>();
    for (let attempt = 0; ; attempt++) {
      const request = await this.buildSubmitRequest(instructions, maxFee, { inputs });
      const { transaction_id } = await daemonCall(this.url, this.client.submitTransaction(request), "submitting the transaction");
      const response = await this.waitForFinalization(transaction_id);
      try {
        if (response.result) throwOnRejection(transaction_id, response.result.result);
        return toIndexerResultShape(response);
      } catch (e) {
        const missing = nextMissingSubstateToRetry(e, attempt, maxRetries, seenAddresses);
        if (!missing) throw e;
        seenAddresses.add(missing);
        const [resolved] = await resolveInputsWithRetry(this.indexerProvider, [{ substate_id: missing, version: null }]);
        if (!resolved) throw e;
        inputs = [...inputs, resolved];
      }
    }
  }

  /** See `OotleAccount.send()`'s doc comment — same missing-recipient-account problem, same fix:
   * a recipient with no prior on-chain activity has no account component for `deposit` to target,
   * `detect_inputs` on the daemon's own submit RPC only resolves *existing* substates, and no
   * amount of retrying makes a component exist that was never created. */
  async send(recipientWalletAddress: string, resourceAddress: string, amount: bigint, maxFee = 5000n): Promise<unknown> {
    const account = await this.getComponentAddress();
    const provider = await this.getProvider();
    const { owner_key: recipientPublicKey } = parseOotleAddress(recipientWalletAddress);
    const recipientAddress = deriveAccountComponentAddress(recipientPublicKey);
    const recipientExists = await substateExists(provider, recipientAddress);

    const instructions: Instruction[] = [];
    if (!recipientExists) {
      instructions.push(
        { CreateAccount: { owner_public_key: toHex(recipientPublicKey), owner_rule: null, access_rules: null, bucket_workspace_id: null } },
        { PutLastInstructionOutputOnWorkspace: { key: 0 } },
      );
    }
    instructions.push(
      { CallMethod: { call: { Address: account }, method: "withdraw", args: [resourceAddressLiteral(resourceAddress), amountLiteral(amount)] } },
      { PutLastInstructionOutputOnWorkspace: { key: 1 } },
      {
        CallMethod: {
          call: recipientExists ? { Address: recipientAddress } : { Workspace: 0 },
          method: "deposit",
          args: [{ Workspace: { id: 1, offset: null } }],
        },
      },
    );
    return this.execute(instructions, { maxFee });
  }

  /** Delegates to the daemon's own free-testnet-coins RPC — much simpler than `OotleAccount`'s
   * hand-rolled self-funding claim, since the daemon already knows how to fund its own accounts. */
  async claimTestnetXtr(): Promise<unknown> {
    return daemonCall(
      this.url,
      this.client.createFreeTestCoins({ account: { ComponentAddress: this.account.component_address }, max_fee: 5000n }),
      "claiming testnet TARI"
    );
  }
}

/**
 * The retry decision for `execute()`'s missing-substate loop, pulled out as a pure function so it
 * can be unit-tested without the real `TransactionBuilder`/indexer pipeline (see `execute()`'s own
 * comment for why that pipeline itself is only verified live). Returns the substate id to pin and
 * retry with, or `null` if `error` isn't a retryable "missing substate" rejection, the retry budget
 * is spent, or this exact address has already been retried once (its own resolved input clearly
 * didn't fix it, so retrying it again would only loop).
 */
export function nextMissingSubstateToRetry(
  error: unknown,
  attempt: number,
  maxRetries: number,
  seenAddresses: ReadonlySet<string>
): string | null {
  if (!(error instanceof Error) || attempt >= maxRetries) return null;
  const missing = extractMissingSubstateAddress(error.message);
  if (!missing || seenAddresses.has(missing)) return null;
  return missing;
}

export function throwOnRejection(transactionId: string, outcome: TransactionResult): void {
  if ("Reject" in outcome) {
    throw new Error(`Transaction ${transactionId} was rejected: ${JSON.stringify(outcome.Reject)}`);
  }
  if ("AcceptFeeRejectRest" in outcome) {
    throw new Error(`Transaction ${transactionId} accepted the fee but rejected the rest: ${JSON.stringify(outcome.AcceptFeeRejectRest)}`);
  }
}

/**
 * Reshapes the daemon's `transactions.wait_result` response into the exact
 * `IndexerGetTransactionResultResponse` shape `OotleAccount.execute()` returns for a real
 * submission — `{result: {Finalized: {execution_result: ExecuteResult, ...}}}`, not the daemon's
 * own flatter `{result: FinalizeResult, status, final_fee, ...}`. Without this, any dApp parsing
 * the result (this extension's own DEX included) has to special-case which account backend served
 * it — confirmed empirically: the DEX's create-token flow threw "Unexpected transaction result
 * shape" against a daemon-relayed account before this normalization existed. `throwOnRejection`
 * has already run by the time this is called, so `response.result` being present here always means
 * a successful `Accept` outcome.
 *
 * Also carries `transaction_id`/`transactionId` at the top level, matching
 * `OotleAccount.execute()`'s own declared return type exactly (`IndexerGetTransactionResultResponse
 * & {transaction_id: TransactionId} & {transactionId?: string}`) -- missing here before, a plain
 * dApp-submitted transaction (e.g. Tari Market's "Buy", via `tari_signAndSubmitTransaction`) had no
 * id anywhere in the response for the site to read back, confirmed live: it showed "No transaction
 * id returned" even though the transaction had actually gone through.
 */
export function toIndexerResultShape(
  response: TransactionWaitResultResponse
): IndexerGetTransactionResultResponse & { transaction_id: string; transactionId: string } {
  if (!response.result) {
    return { result: "Pending", transaction_id: response.transaction_id, transactionId: response.transaction_id };
  }
  return {
    transaction_id: response.transaction_id,
    transactionId: response.transaction_id,
    result: {
      Finalized: {
        final_decision: "Commit",
        execution_result: {
          finalize: response.result,
          execution_time: { secs: 0, nanos: 0 },
          execute_epoch: null,
          wasm_execution_points: 0n,
          native_execution_points: 0n,
          // Decoded, like the SDK's own execute() results (the indexer type says base64 CBOR).
        } as unknown as string,
        execution_time: { secs: 0, nanos: 0 },
        finalized_time: new Date().toISOString(),
        abort_details: null,
      },
    },
  };
}
