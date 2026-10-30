// Simulates a pending dApp transaction request so the approval screen can show what it actually
// does to the signing account -- the approval summary itself never decodes instruction arguments
// (see instructionSummary.ts), so without this a site-authored transaction is signed blind.
import { getVaultIdsForAccount } from "@tari-project/ootle";
import { OotleAccount, type WalletAccountApi } from "@chironbuilder/ootle-sdk";
import type { ExecuteResult, Instruction } from "@tari-project/ootle-ts-bindings";
import type { TransactionRequestOperation } from "../lib/messages";
import { decodeSubstateValue } from "../lib/bor";

const SIMULATION_TIMEOUT_MS = 45_000;

export interface RawPreview {
  simulated: boolean;
  error?: string;
  wouldFail?: string;
  /** Net change per resource across the account's existing vaults (negative = leaves the account). */
  changes: Map<string, bigint>;
  ownAccountCalls: string[];
  htlc?: { value: bigint | null; problems: string[] };
}

/** Methods a request calls on the account's own component, other than deposits into it. */
export function ownAccountCalls(instructions: Instruction[], accountComponent: string): string[] {
  const out: string[] = [];
  for (const instr of instructions) {
    if (typeof instr === "string" || !("CallMethod" in instr)) continue;
    const { call, method } = instr.CallMethod as unknown as { call: { Address?: string }; method: string };
    if (call?.Address === accountComponent && !String(method).startsWith("deposit")) out.push(String(method));
  }
  return out;
}

/** Sums `std.vault.withdraw` / `std.vault.deposit` events on the given vaults, per resource. */
export function accountBalanceChanges(result: ExecuteResult, vaultResources: Map<string, string>): Map<string, bigint> {
  const net = new Map<string, bigint>();
  for (const ev of result.finalize.events) {
    const sign = ev.topic === "std.vault.withdraw" ? -1n : ev.topic === "std.vault.deposit" ? 1n : 0n;
    if (sign === 0n || !ev.substate_id) continue;
    const resource = vaultResources.get(String(ev.substate_id));
    if (!resource) continue;
    let amount: bigint;
    try {
      amount = BigInt(String((ev.payload as Record<string, unknown>).amount ?? 0));
    } catch {
      continue;
    }
    net.set(resource, (net.get(resource) ?? 0n) + sign * amount);
  }
  for (const [resource, delta] of net) if (delta === 0n) net.delete(resource);
  return net;
}

/** The engine's verdict, or undefined when it accepted the whole transaction. */
export function rejectionOf(result: ExecuteResult): string | undefined {
  const outcome = result.finalize.result as unknown;
  if (outcome && typeof outcome === "object") {
    if ("Reject" in outcome) return JSON.stringify((outcome as { Reject: unknown }).Reject).slice(0, 300);
    if ("AcceptFeeRejectRest" in outcome) return JSON.stringify((outcome as { AcceptFeeRejectRest: unknown[] }).AcceptFeeRejectRest[1]).slice(0, 300);
  }
  return undefined;
}

async function vaultResources(account: OotleAccount, component: string): Promise<Map<string, string>> {
  const provider = await account.getProvider();
  const ids = await getVaultIdsForAccount(provider, component as Parameters<typeof getVaultIdsForAccount>[1]);
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const { substates } = await provider.fetchSubstates(ids);
  for (const id of ids) {
    const value = decodeSubstateValue<{ Vault?: { resource_container: Record<string, { address?: string }> } } | undefined>(substates[id]?.value);
    const address = value?.Vault ? Object.values(value.Vault.resource_container)[0]?.address : undefined;
    if (address) map.set(String(id), address);
  }
  return map;
}

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timed out")), SIMULATION_TIMEOUT_MS))]);
}

/** `null` for operation kinds the wallet builds itself, whose approval steps already state exactly what moves. */
export async function previewOperation(account: WalletAccountApi, operation: TransactionRequestOperation): Promise<RawPreview | null> {
  const followUps =
    operation.kind === "instructions"
      ? operation.instructions
      : operation.kind === "withdrawStealthAndExecute" ||
          operation.kind === "redeemStealthOutputAndExecute" ||
          operation.kind === "redeemStealthOutputWithPrivateFee"
        ? operation.followUpInstructions
        : null;
  if (followUps === null && operation.kind !== "htlcClaim") return null;

  const empty: RawPreview = { simulated: false, changes: new Map(), ownAccountCalls: [] };
  if (!(account instanceof OotleAccount)) {
    return { ...empty, error: "only a local account can simulate it" };
  }
  const component = await account.getComponentAddress();

  if (operation.kind === "htlcClaim") {
    try {
      const v = await withTimeout(account.verifyHtlc(operation.resourceAddress, operation.commitment, operation.conditions, {}, operation.preimageHex));
      return { ...empty, htlc: { value: v.value, problems: v.problems } };
    } catch (e) {
      return { ...empty, error: e instanceof Error ? e.message : String(e) };
    }
  }

  const calls = ownAccountCalls(followUps!, component);
  // `x402SignClaim`'s fee is nested in its `envelope` (it never reaches this line -- its preview
  // returns above with every other wallet-built kind -- but the `in`-narrowing also keeps the
  // union honest without it).
  const maxFee = "maxFee" in operation && operation.maxFee !== undefined ? BigInt(operation.maxFee) : undefined;
  try {
    let result: ExecuteResult;
    if (operation.kind === "instructions") {
      const res = (await withTimeout(account.execute(operation.instructions, { maxFee, dryRun: true, inputs: operation.inputs }))) as { result: ExecuteResult };
      result = res.result;
    } else if (operation.kind === "withdrawStealthAndExecute") {
      result = await withTimeout(
        account.dryRunWithdrawStealthAndExecute(
          operation.resourceAddress,
          BigInt(operation.amount),
          operation.workspaceVarName,
          operation.followUpInstructions,
          operation.relatedComponents ?? [],
          maxFee
        )
      );
    } else {
      return { ...empty, ownAccountCalls: calls, error: "this kind of request can't be simulated yet" };
    }
    const changes = accountBalanceChanges(result, await vaultResources(account, component));
    return { simulated: true, wouldFail: rejectionOf(result), changes, ownAccountCalls: calls };
  } catch (e) {
    return { ...empty, ownAccountCalls: calls, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}
