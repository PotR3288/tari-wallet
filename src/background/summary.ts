// The approval-popup summary builder: what the one screen the user reads before signing shows
// for every transaction-request kind, as short separate lines rather than one run-on sentence.
// Kept out of background/index.ts (same reasoning as x402.ts's own header): pure, no service
// worker, no browser APIs -- every kind's wording is unit-testable straight from here.
import { formatBalanceAmountGrouped } from "../popup/format";
import type { Instruction } from "@tari-project/ootle-ts-bindings";
import type { TransactionRequestOperation } from "../lib/messages";

/** The well-known native-token resource -- engine-special-cased on-chain (see chain.mjs-style
 * comments elsewhere in this codebase), so worth a real ticker instead of 64 hex characters. */
export const TARI_RESOURCE_ADDRESS = "resource_0101010101010101010101010101010101010101010101010101010101010101";

/** A short, readable label for a resource address -- the one thing that shows up in nearly every
 * approval fact below and is otherwise the least readable part of it. */
export function resourceLabel(address: string): string {
  if (address === TARI_RESOURCE_ADDRESS) return "TARI";
  return shortId(address);
}

/** Truncates a long identifier (a resource/component address, a wallet address, a commitment) to
 * its first and last 8 characters -- long enough to eyeball-match against something the user
 * already has open, short enough not to dominate the line it's part of. */
export function shortId(id: string, n = 8): string {
  return id.length > n * 2 + 3 ? `${id.slice(0, n)}…${id.slice(-n)}` : id;
}

/** TARI's on-chain divisibility -- the fallback when `resolveResourceMeta` can't see the resource
 * (an account that doesn't hold it yet), since TARI is the one resource we can always label. */
const TARI_DIVISIBILITY = 6;

/**
 * An operation's raw on-chain integer amount as the user thinks of it: `10000000` of TARI is
 * "10 TARI", never "10000000 TARI". Every amount the approval popup states goes through here -- a
 * raw integer labelled with a token symbol overstates the amount by 10^divisibility on the one
 * screen the user reads before signing. A resource whose divisibility is genuinely unknown says
 * outright that it's in base units rather than guessing a scale.
 */
export function approvalAmount(raw: string, resourceAddress: string, divisibility?: number): string {
  const d = divisibility ?? (resourceAddress === TARI_RESOURCE_ADDRESS ? TARI_DIVISIBILITY : undefined);
  const label = resourceLabel(resourceAddress);
  return d === undefined ? `${BigInt(raw).toString()} base units of ${label}` : `${formatBalanceAmountGrouped(raw, d)} ${label}`;
}

/** The site a URL points at, for the approval popup: just the hostname when the path is bare
 * ("/" -- the host IS the thing), the full URL when the path is what identifies the resource.
 * An unparseable URL degrades to the raw string rather than crashing the approval screen. */
export function resourceSite(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname === "/" || parsed.pathname === "" ? parsed.hostname : url;
  } catch {
    return url;
  }
}

/** The hostname a facilitator URL points at -- the site the wallet reports the payment to. An
 * unparseable URL degrades to the raw string (same resilience rule as `resourceSite`). */
export function facilitatorHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Breaks an operation down into the distinct facts the approval popup shows as separate lines
 * (see main.ts's `renderApprovalDetails`), rather than one run-on sentence -- each line is one
 * thing worth reading on its own, in the order that matters most: what moves, then where it ends
 * up, then anything unusual about how. `warning` (the minimum-value-promise disclosure, the one
 * case here that's a genuine risk to miss) is kept separate so the popup can render it in its own
 * highlighted box instead of buried in the middle of a paragraph.
 */
export function summarizeOperationForApproval(
  operation: TransactionRequestOperation,
  divisibility?: number
): { instructions: Instruction[]; steps?: string[]; warning?: string } {
  const fmt = (raw: string) =>
    "resourceAddress" in operation ? approvalAmount(raw, operation.resourceAddress, divisibility) : BigInt(raw).toString();
  switch (operation.kind) {
    case "instructions": {
      // Unlike every other kind below, this is arbitrary dApp-authored instructions -- there is no
      // structured field to build a specific sentence from (see instructionSummary.ts's own file
      // header for why the args' actual values are never decoded either). A plain step count at
      // least tells the user there IS a sequence to read below, rather than nothing at all.
      const count = operation.instructions.length;
      return {
        instructions: operation.instructions,
        steps:
          count === 0
            ? ["This transaction has no instructions."]
            : [`Custom transaction from this site — ${count} step${count === 1 ? "" : "s"}, run in order.`, "Review each one below before approving."],
      };
    }
    case "withdrawStealthAndExecute":
      return {
        instructions: operation.followUpInstructions,
        steps: [`Reveals ${fmt(operation.amount)} for use in this transaction.`],
      };
    case "redeemStealthOutputAndExecute":
      return {
        instructions: operation.followUpInstructions,
        steps: [
          `Redeems a stealth token (${shortId(operation.commitmentHex)}).`,
          `Reveals ${fmt(operation.revealedAmount)} for use in this transaction.`,
        ],
      };
    case "redeemStealthOutputWithPrivateFee":
      return {
        instructions: operation.followUpInstructions,
        steps: [
          `Redeems a stealth token (${shortId(operation.commitmentHex)}).`,
          `Reveals ${fmt(operation.revealedAmount)} for use in this transaction.`,
          "Pays the fee from a separate stealth UTXO — this account's address is never revealed.",
        ],
      };
    case "htlcFund":
      return {
        instructions: [],
        steps: [
          `Locks ${fmt(operation.amount)} in an HTLC.`,
          `Claimable by ${shortId(operation.claimantWalletAddress)} with the matching secret, before epoch ${BigInt(operation.refundEpoch).toString()}.`,
          "Refundable back to this account after that epoch.",
        ],
      };
    // A payment, not a bare swap leg: `resourceUrl` is the one field that says WHAT the user is
    // buying, so it leads. The rest of the envelope renders as purchase facts (site, price, quote
    // expiry in wall-clock time, the conditional-payment deal, who routes it) rather than protocol
    // fields -- the user reads a purchase here, not an HTLC leg.
    case "x402Pay": {
      return {
        instructions: [],
        steps: [
          `Buys ${resourceSite(operation.resourceUrl)} for ${fmt(operation.amount)}.`,
          // The fee is NOT a step here: like every other kind, it rides the approval's own
          // `maxFee` field (formatMaxFee in createTransactionRequest), rendered by the popup in
          // the same place for every operation.
          `Quote expires ${new Date(operation.expiresAt).toLocaleString()} — don't approve after that time.`,
          "Conditional payment: the merchant can only take it by serving the resource, and it refunds to you automatically if they don't in time.",
          `Routed via the facilitator at ${facilitatorHost(operation.facilitatorUrl)}${operation.facilitatorPubKeyHex ? ` (key ${shortId(operation.facilitatorPubKeyHex)})` : ""}.`,
          // The integrity pin is deliberately last and terse — present for eyeballing against
          // what the merchant advertised, never prominent enough to crowd out the price.
          ...(operation.resourceSha256
            ? [`Response pinned to SHA-256 ${operation.resourceSha256.slice(0, 8)}…${operation.resourceSha256.slice(-8)}.`]
            : []),
        ],
      };
    }
    // Every private-spend kind shows an empty instruction list on purpose: the wallet builds the
    // StealthTransfer itself at submit time (a dApp cannot hand one over -- see
    // assertNoStealthTransferInstruction), so there are no dApp-authored instructions to display.
    // The steps carry the whole meaning of the request instead, and each one states plainly which
    // direction value moves and whether it becomes publicly visible -- that is the only thing
    // distinguishing these from each other on the approval screen.
    case "shield":
      return {
        instructions: [],
        steps: [
          `Moves ${fmt(operation.amount)} from your public balance into your private balance.`,
          "Stays in this account.",
        ],
        // Stated outright, not left for the user to infer from a field name. Shielding is the act
        // of making value invisible; a promise puts a permanent public floor back on it, for
        // everyone, for as long as the output lives. Someone approving a "move to private" must
        // not discover afterwards that they also published a number.
        warning: promiseWarning(operation.minimumValuePromise, "this new private output", fmt),
      };
    case "depositConfidential":
      return {
        instructions: [],
        steps: [
          `Moves ${fmt(operation.amount)} from your public balance into a Confidential vault.`,
          "Stays in this account.",
          `Different privacy mechanism from "shield" — only works if this resource was created as a Confidential-type resource.`,
        ],
      };
    case "unshield":
      return {
        instructions: [],
        steps: [
          `Moves ${fmt(operation.revealedAmount)} from your private balance back into your public balance.`,
          "This amount becomes visible on-chain.",
        ],
      };
    case "sendPrivately":
      return {
        instructions: [],
        steps: [
          `Sends ${fmt(operation.amount)} privately to ${shortId(operation.recipientWalletAddress)}.`,
          "The amount and recipient stay hidden on-chain.",
        ],
        warning: promiseWarning(operation.minimumValuePromise, "the recipient's new output", fmt),
      };
    case "htlcClaim":
      return {
        instructions: [],
        steps: [
          `Claims an HTLC-locked private payment of ${resourceLabel(operation.resourceAddress)} into your private balance.`,
          "Reveals the secret to the network.",
        ],
      };
    case "htlcRefund":
      return {
        instructions: [],
        steps: [
          `Refunds ${fmt(operation.amount)} from an HTLC you funded, back into your private balance.`,
          "Only works once its refund epoch has passed.",
        ],
      };
  }
}

/**
 * The minimum-value-promise disclosure, when one is set -- kept as its own function (rather than
 * inlined per case) so the wording can never drift between the two operation kinds that carry a
 * promise: the whole point is that the user reads the exact same unambiguous sentence about a
 * permanent public disclosure regardless of which one triggered it. A zero or absent promise
 * returns `undefined` -- a warning shown on every transaction is one nobody reads on the
 * transaction that needed it.
 */
function promiseWarning(minimumValuePromise: string | undefined, subject: string, fmt: (raw: string) => string): string | undefined {
  if (minimumValuePromise === undefined || BigInt(minimumValuePromise) === 0n) return undefined;
  return `This will also publicly and permanently record that ${subject} is worth at least ${fmt(
    minimumValuePromise,
  )} — visible to everyone on-chain, not just this site, for as long as the output exists.`;
}