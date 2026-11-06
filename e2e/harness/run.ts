// The Phase 5 e2e harness runner (Task 5.2): drives BOTH built-extension wallet instances
// (payer + merchant) against LIVE esmeralda and the Task 5.1 facilitator stand-in, through the
// merchant service (service.mjs). Two scenarios, per the plan's Task 5.2 list:
//
//   happy  -- dApp fetch -> 402 envelope -> x402Pay approval in a REAL popup window click ->
//            merchant wallet x402SignClaim (real popup approval) -> merchant service POSTs settle ->
//            facilitator validates + holds -> resource served -> broadcast -> confirmed on chain,
//            with a real chain tx id and the claimed output spent on esmeralda.
//
//   refund -- second run against a FROZEN facilitator (the claim is held, never broadcast):
//            resource served while held, refundEpoch passes, payer refunds via the funder's
//            outputMask path (htlcRefund, real popup approval), settlement reports `expired`,
//            HTLC output spent back to the payer on esmeralda.
//
// Every user approval is clicked in the real popup window the background opens
// (chrome.windows.create -> a new page in the same context) -- never a background bypass.
// Wallets are seeded deterministically: a fixed 24-word Sapient cipher-seed mnemonic derived
// from (role, scenario, run index) is IMPORTED through the wallet's own onboarding UI
// (popup.html -> "Import Existing Wallet" -> mnemonic + password), so reruns never collide with
// already-spent outputs (unique index per run) and the runner can derive the merchant's wallet
// address and TEST view secret offline (OotleAccount.fromSeed on the same entropy -- used only
// to satisfy the facilitator stand-in's documented test-only claimantViewKeyHex deviation).
//
// Escalation rule (task brief): if the faucet stays dry or esmeralda is unstable for >20 min,
// stop, print the exact state reached, and exit with code 2 rather than retrying indefinitely.
//
// Run: `npx tsx e2e/harness/run.ts` (see e2e/harness/README.md). Not part of `pnpm test`.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { chromium, type BrowserContext, type Page } from "playwright";
import { OotleAccount, fromHex, toOotleNetwork } from "@chironbuilder/ootle-sdk";
import { IndexerProvider } from "@tari-project/ootle-indexer";
import { encipherSeed } from "../../src/lib/cipherSeed";
import { bytesToWords } from "../../src/lib/mnemonic";
import type { X402PayTerms } from "../../src/lib/messages";
import { pay402 } from "../../packages/x402-elim/src/pay402.js";
import { X402PaymentRequired } from "../../packages/x402-elim/src/errors.js";

// ─── Configuration (env-overridable) ────────────────────────────────────────────────────────

const REPO = path.resolve(import.meta.dirname, "../..");
const DIST = process.env.X402_E2E_DIST ?? path.join(REPO, "dist");
const SCENARIOS = (process.env.X402_E2E_SCENARIOS ?? "happy,refund")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const RUN_INDEX = Number(process.env.X402_E2E_RUN_INDEX ?? 1);
// Unique per invocation (pid-derived, env-overridable): a killed prior run can leave its child
// services holding the default ports, and a fresh facilitator on a taken port dies with
// EADDRINUSE while the stale one (same spec, but a stranger's process) silently serves the run.
const SERVICE_PORT = Number(process.env.X402_E2E_SERVICE_PORT ?? 4521 + (process.pid % 500));
const FACILITATOR_PORT = Number(process.env.X402_E2E_FACILITATOR_PORT ?? 4020 + (process.pid % 500));
const INDEXER_URL = process.env.X402_E2E_INDEXER_URL ?? "https://ootle-indexer-a.tari.com";
const NETWORK = (process.env.X402_E2E_NETWORK ?? "esmeralda") as "esmeralda" | "igor";
// Wire dialect for the merchant service's 402 answer: "v2" (default) = base64 foundation v2
// PaymentRequired in the PAYMENT-REQUIRED header, parsed through the client package's pay402()
// normalization exactly as a real dApp would consume it; "legacy" = flat quote in the JSON body.
const WIRE_DIALECT = process.env.X402_E2E_WIRE_DIALECT ?? "v2";
// Measured live on esmeralda (2026-10-30): block time ~70s, ~80 blocks/epoch -> one epoch is
// roughly an HOUR. The refund scenario's expiry wait is therefore bounded by the chain's own
// cadence (the brief's "minutes, not hours" wish does not survive contact with esmeralda; the
// refundEpoch offset is the only knob, and it cannot go below +1 without risking the fund leg
// landing past it). The epoch-wait budget below covers two epoch ticks.
const HAPPY_REFUND_EPOCHS = Number(process.env.X402_E2E_HAPPY_REFUND_EPOCHS ?? 4);
const REFUND_REFUND_EPOCHS = Number(process.env.X402_E2E_REFUND_REFUND_EPOCHS ?? 2);
// (The old `X402_E2E_FAUCET_TIMEOUT_MINUTES` knob is gone: the on-chain faucet gets exactly one
// claim per wallet -- a dry vault cannot be retried away -- and the community faucet has its own
// bounded waits. A dry on-chain vault IS the escalation condition, handled by the fallback below.)
const EPOCH_WAIT_MINUTES = Number(process.env.X402_E2E_EPOCH_WAIT_MINUTES ?? 150);
const HEADLESS = process.env.X402_E2E_HEADLESS === "1";
const WALLET_PASSWORD = process.env.X402_E2E_WALLET_PASSWORD ?? "x402 harness pass 7f3a9d41";
const TARI_RESOURCE_ADDRESS = "resource_0101010101010101010101010101010101010101010101010101010101010101";
const SERVICE_URL = `http://127.0.0.1:${SERVICE_PORT}`;
const FACILITATOR_URL = `http://127.0.0.1:${FACILITATOR_PORT}`;
const LOG_DIR = path.join(REPO, "e2e/harness/logs");

// ─── Logging + assertions ───────────────────────────────────────────────────────────────────

mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
const t0 = Date.now();
function log(msg: string): void {
  const line = `[+${((Date.now() - t0) / 1000).toFixed(1).padStart(7)}s] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}
function assert(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${what}`);
  log(`  ✓ ${what}`);
}

class Escalation extends Error {}

// ─── Deterministic seeds ─────────────────────────────────────────────────────────────────────

const sha256 = (input: string) => createHash("sha256").update(input).digest();

/** A deterministic Sapient 24-word cipher-seed mnemonic: fixed entropy/salt per (role, index). */
async function deriveMnemonic(role: string, index: number): Promise<{ mnemonic: string; entropy: Uint8Array }> {
  const entropy = sha256(`x402-e2e-seed|${NETWORK}|${role}|${index}`).subarray(0, 16);
  const salt = sha256(`x402-e2e-salt|${NETWORK}|${role}|${index}`).subarray(0, 5);
  const enciphered = await encipherSeed({ birthday: 1000, entropy, salt });
  return { mnemonic: bytesToWords(enciphered).join(" "), entropy };
}

async function deriveAccountInfo(entropy: Uint8Array) {
  const account = OotleAccount.fromSeed(entropy, 0, NETWORK);
  const walletAddress = await account.getWalletAddress();
  const viewSecret = await account.signer.getViewSecret();
  return { walletAddress, viewSecretHex: Buffer.from(viewSecret).toString("hex") };
}

// ─── Child services (facilitator stand-in + merchant service) ────────────────────────────────

function spawnChild(name: string, command: string, args: string[], env: Record<string, string>): ChildProcess {
  const proc = spawn(command, args, { cwd: REPO, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const tag = (stream: NodeJS.ReadableStream, bang: string) =>
    stream.on("data", (d: Buffer) => {
      for (const line of d.toString().split("\n").filter(Boolean)) log(`  [${name}${bang}] ${line}`);
    });
  tag(proc.stdout!, "");
  tag(proc.stderr!, "!");
  log(`${name} spawned (pid ${proc.pid})`);
  return proc;
}

/** Poll a URL until it answers anything HTTP (404 counts: the service is up). */
async function waitHttpUp(url: string, label: string, deadlineMs: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      log(`${label} is up (HTTP ${res.status} on ${url})`);
      return;
    } catch {
      if (Date.now() - start > deadlineMs) throw new Escalation(`${label} did not come up within ${deadlineMs / 1000}s`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// ─── Wallet instances (Playwright persistent contexts) ──────────────────────────────────────

interface Wallet {
  name: string;
  ctx: BrowserContext;
  /** The always-open popup.html tab: the wallet's own UI, used for import/funding/unlock. */
  popup: Page;
  extId: string;
  password: string;
}

const PROFILE_ROOT = path.join(os.tmpdir(), `x402-e2e-profiles-${process.pid}`);

async function launchWallet(name: string, mnemonic: string): Promise<Wallet> {
  const profileDir = path.join(PROFILE_ROOT, name);
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: HEADLESS,
    // The default 180s launch timeout loses to a loaded box (e.g. a concurrent miner at
    // ~30 cores); Chromium is fine under load, it just starts slowly.
    timeout: 600_000,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, "--no-first-run", "--no-default-browser-check"],
  });
  // tsx/esbuild compiles this file with keepNames, which injects a bare `__name(...)` helper
  // into every function -- including the closures serialized into page.evaluate, where no such
  // binding exists. Defining it on every page of the context (a no-op passthrough) keeps the
  // evaluate bodies working verbatim. Harness-only shim; nothing touches the extension itself.
  await ctx.addInitScript("window.__name = (f) => f;");
  let worker = ctx.serviceWorkers()[0];
  if (!worker) worker = await ctx.waitForEvent("serviceworker", { timeout: 60_000 });
  const extId = new URL(worker.url()).host;
  log(`${name}: chromium up, extension ${extId}`);

  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForSelector("#import", { timeout: 60_000 });
  log(`${name}: onboarding welcome screen rendered`);

  // Import path (documented exactly, per the brief): popup.html -> "Import Existing Wallet"
  // (#import) -> mnemonic textarea (#mnemonic) + password (#pw, #pw2) -> #submit.
  await popup.click("#import");
  await popup.waitForSelector("#mnemonic");
  await popup.fill("#mnemonic", mnemonic);
  await popup.fill("#pw", WALLET_PASSWORD);
  await popup.fill("#pw2", WALLET_PASSWORD);
  await popup.click("#submit");

  // Import derives the account (Argon2) then lands on home; poll the wallet's own status.
  const deadline = Date.now() + 90_000;
  for (;;) {
    const status = await popupSend(popup, { kind: "popup-get-status" });
    if (status.hasWallet && status.isUnlocked) break;
    if (Date.now() > deadline) throw new Error(`${name}: wallet import did not complete within 90s`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  log(`${name}: wallet imported and unlocked (deterministic seed)`);
  return { name, ctx, popup, extId, password: WALLET_PASSWORD };
}

/** chrome.runtime.sendMessage from the popup page, with the same cold-start retry as main.ts. */
function popupSend<T = any>(page: Page, message: unknown): Promise<T> {
  return page.evaluate(async (msg) => {
    const once = () =>
      new Promise((resolve, reject) => {
        (window as any).chrome.runtime.sendMessage(msg, (response: any) => {
          const err = (window as any).chrome.runtime.lastError;
          if (err) return reject(new Error(err.message));
          if (!response || response.ok === false) reject(new Error(response?.error ?? "popup request failed"));
          else resolve(response.result);
        });
      });
    for (let attempt = 0; ; attempt++) {
      try {
        return await once();
      } catch (e: any) {
        const coldStart = String(e?.message ?? "").includes("Receiving end does not exist");
        if (coldStart && attempt < 10) {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        throw e;
      }
    }
  }, message);
}

/** Locks happen (auto-lock fires on idle); re-unlock through the popup's own lock screen. */
async function ensureUnlocked(wallet: Wallet): Promise<void> {
  const status = await popupSend(wallet.popup, { kind: "popup-get-status" });
  if (status.isUnlocked) return;
  log(`${wallet.name}: wallet locked -- re-unlocking via the popup lock screen`);
  await wallet.popup.reload();
  await wallet.popup.waitForSelector("#unlock", { timeout: 30_000 });
  await wallet.popup.fill("#pw", wallet.password);
  await wallet.popup.click("#unlock");
  const deadline = Date.now() + 60_000;
  for (;;) {
    const s = await popupSend(wallet.popup, { kind: "popup-get-status" });
    if (s.isUnlocked) break;
    if (Date.now() > deadline) throw new Error(`${wallet.name}: unlock did not complete`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  log(`${wallet.name}: unlocked again`);
}

/** The wallet's revealed XTR balance, read through the popup's own message surface. */
async function revealedXtr(wallet: Wallet): Promise<bigint> {
  const balances = await popupSend(wallet.popup, { kind: "popup-get-balances" });
  const xtr = (balances as any[]).find(
    (b) => b.resourceAddress === "resource_0101010101010101010101010101010101010101010101010101010101010101"
  );
  return BigInt(xtr?.amount ?? "0");
}

/**
 * The taritracker community testnet faucet (https://testnet-faucet.taritracker.com/) -- the
 * fallback when the network's own on-chain faucet vault runs dry (it dispenses a FIXED 1 XTR per
 * claim and was measured 999,651,320/1,000,000,000 on 2026-10-30). Cloudflare Turnstile guards
 * the claim: in a clean browser it usually auto-issues, but a human may need to click the
 * checkbox once per wallet -- the harness waits (visible window) for either.
 *
 * Community-faucet funds land as STEALTH outputs to the wallet address, but every x402/x402SignClaim
 * fee lane is transparent (paid from revealed vault balance), so after discovery the wallet also
 * unshields a slice -- via a real dApp approval, with the fee paid privately from the stealth UTXO
 * itself (the popup's own unshield action has no feeType knob; the request kind does).
 */
const TURNSTILE_WAIT_MINUTES = Number(process.env.X402_E2E_TURNSTILE_WAIT_MINUTES ?? 15);

/**
 * One claim per wallet, ever: `claimTestnetXtr`'s own built-in retry/backoff already handles the
 * shared faucet-vault substate contention, and re-driving the SAME wallet after a shortfall
 * cannot succeed (the template dispenses a fixed 1 XTR from a vault that either has it or does
 * not). A dry vault IS the faucet-dry escalation condition -- this returns false and the caller
 * either uses the community faucet or escalates; it never hammers the same account.
 */
async function fundViaOnchainFaucet(wallet: Wallet): Promise<boolean> {
  await ensureUnlocked(wallet);
  try {
    log(`${wallet.name}: on-chain faucet claim (popup-claim-testnet-xtr, single attempt -- SDK retries contention internally)`);
    await popupSend(wallet.popup, { kind: "popup-claim-testnet-xtr" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`${wallet.name}: on-chain faucet claim rejected (dry or unavailable): ${msg.split("\n")[0]}`);
    return false;
  }
  const pollDeadline = Date.now() + 120_000;
  for (;;) {
    try {
      const amount = await revealedXtr(wallet);
      log(`${wallet.name}: balance poll -> revealed XTR ${amount}`);
      if (amount > 0n) return true;
    } catch (e) {
      log(`${wallet.name}: balance poll threw: ${e instanceof Error ? e.message : e}`);
    }
    if (Date.now() > pollDeadline) return false;
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function fundViaCommunityFaucet(wallet: Wallet, walletAddress: string, dappPage: Page): Promise<void> {
  log(`${wallet.name}: claiming from the taritracker community faucet (10 tXTR to ${walletAddress.slice(0, 30)}...)`);
  const page = await wallet.ctx.newPage();
  try {
    await page.goto("https://testnet-faucet.taritracker.com/");
    await page.waitForSelector("#claim-form", { timeout: 30_000 });
    await page.fill("#address", walletAddress);
    await page.fill("#claim-amount", "10");
    log(
      `${wallet.name}: waiting up to ${TURNSTILE_WAIT_MINUTES} min for the Turnstile token ` +
        `(auto in a clean browser; otherwise click the checkbox in the faucet window once)`
    );
    const gotToken = await page
      .waitForFunction(
        () => {
          const w = window as any;
          if (!w.turnstile) return false;
          try {
            const r = w.turnstile.getResponse();
            return typeof r === "string" && r.length > 20;
          } catch {
            return false;
          }
        },
        undefined,
        { timeout: TURNSTILE_WAIT_MINUTES * 60_000, polling: 3000 }
      )
      .then(() => true)
      .catch(() => false);
    assert(gotToken, "community faucet Turnstile token acquired");
    await page.click("#claim-button");
    const receipt = (await page.evaluate(() => localStorage.getItem("faucet-pending"))) as string | null;
    assert(typeof receipt === "string" && receipt.length > 0, `faucet accepted the claim (receipt ${receipt})`);
    const claim = await pollUntil(
      "faucet payment confirmed",
      async () => {
        const row = await page.evaluate(async (rid) => (await fetch(`/api/claims/${rid}`).then((r) => r.json())), receipt);
        log(`  faucet claim status: ${row.status}${row.transactionId ? ` (tx ${row.transactionId})` : ""}`);
        if (row.status === "rejected" || row.status === "failed") throw new Error(`faucet claim ${row.status}: ${JSON.stringify(row)}`);
        return row.status === "confirmed" ? row : null;
      },
      5 * 60_000,
      4000
    );
    log(`${wallet.name}: community faucet paid (tx ${claim.transactionId})`);
  } finally {
    await page.close().catch(() => {});
  }

  // Discover the stealth output into the wallet's own ledger (the popup's own rescan action).
  await ensureUnlocked(wallet);
  for (let i = 0; i < 6; i++) {
    try {
      const scan = await popupSend(wallet.popup, { kind: "popup-rescan-private-payments" });
      log(`${wallet.name}: private payment scan -> ${JSON.stringify(scan).slice(0, 120)}`);
      break;
    } catch (e) {
      log(`${wallet.name}: scan attempt ${i + 1} threw: ${e instanceof Error ? e.message : e}`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }

  // Fees are transparent, so unshield a slice -- real dApp approval, private fee from the UTXO.
  const revealed = await revealedXtr(wallet);
  if (revealed === 0n) {
    log(`${wallet.name}: unshielding 2 tXTR for the transparent fee lane (fee paid privately from the stealth UTXO)`);
    await requestWithApproval(
      wallet,
      dappPage,
      {
        kind: "unshield",
        resourceAddress: TARI_RESOURCE_ADDRESS,
        revealedAmount: "2000000",
        feeType: "private",
        enforceFeeType: true,
      },
      "unshield (fee funding)"
    );
    await pollUntil(
      "revealed XTR balance after unshield",
      async () => {
        const amount = await revealedXtr(wallet).catch(() => 0n);
        return amount > 0n ? amount : null;
      },
      120_000
    );
  }
  const final = await revealedXtr(wallet);
  assert(final > 0n, `${wallet.name} has revealed XTR for fees (balance ${final})`);
}

/**
 * Discover inbound PRIVATE transfers (manual out-of-band funding, e.g. a taritracker payout
 * requested from another browser) and unshield a slice into the revealed vault. Taritracker
 * dispenses stealth outputs, so a wallet funded that way shows revealed XTR 0 until it scans
 * and unshields. Unshield amounts descend (fee paid privately from the stealth UTXO itself)
 * because the exact received amount is not directly readable through the popup surface.
 */
async function discoverAndUnshieldInbound(wallet: Wallet, dappPage: Page): Promise<boolean> {
  await ensureUnlocked(wallet);
  log(`${wallet.name}: scanning for inbound private payments (manual/taritracker funding)`);
  for (let i = 0; i < 6; i++) {
    try {
      const scan = await popupSend(wallet.popup, { kind: "popup-rescan-private-payments" });
      log(`${wallet.name}: private payment scan -> ${JSON.stringify(scan).slice(0, 120)}`);
      break;
    } catch (e) {
      log(`${wallet.name}: scan attempt ${i + 1} threw: ${e instanceof Error ? e.message : e}`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  // Give the scan and the inbound tx a moment to confirm; poll revealed, then unshield.
  const scanDeadline = Date.now() + 180_000;
  while (Date.now() < scanDeadline) {
    const amount = await revealedXtr(wallet).catch(() => 0n);
    if (amount > 0n) {
      log(`${wallet.name}: discovered revealed XTR ${amount} after private scan`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  for (const slice of ["200000000000", "200000000", "2000000"]) {
    try {
      log(`${wallet.name}: unshielding slice ${slice} for the transparent fee/payment lane (private fee)`);
      await requestWithApproval(
        wallet,
        dappPage,
        {
          kind: "unshield",
          resourceAddress: TARI_RESOURCE_ADDRESS,
          revealedAmount: slice,
          feeType: "private",
          enforceFeeType: true,
        },
        "unshield (inbound private funding)"
      );
      await pollUntil(
        "revealed XTR after inbound unshield",
        async () => {
          const amount = await revealedXtr(wallet).catch(() => 0n);
          return amount > 0n ? amount : null;
        },
        120_000
      );
      log(`${wallet.name}: inbound private funding unshielded (revealed XTR ${await revealedXtr(wallet)})`);
      return true;
    } catch (e) {
      log(`${wallet.name}: unshield slice ${slice} failed: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
    }
  }
  return (await revealedXtr(wallet).catch(() => 0n)) > 0n;
}

/**
 * Payer -> target private relay: `sendPrivately` transfers are NOT view-key scannable (the
 * recipientCommitment must reach the recipient out of band), so the harness is that out-of-band
 * channel: send 20M XTR privately from the payer, take `recipientCommitment` from the result, and
 * claim it directly in the target's popup. Fully in-harness -- no external faucet needed.
 */
async function relayFromPayer(
  payer: Wallet, payerPage: Page, target: Wallet, targetAddress: string, dappPage: Page
): Promise<boolean> {
  // The sender's private balance may be below the full relay amount (chained relays drain it).
  // On a balance rejection, cap to what the sender actually holds minus a fee buffer and retry once.
  let result: any;
  let amount = "20000000";
  for (let attempt = 1; ; attempt++) {
    try {
      log(`${target.name}: relaying ${amount} private XTR from ${payer.name}`);
      result = await requestWithApproval(
        payer,
        payerPage,
        {
          kind: "sendPrivately",
          resourceAddress: TARI_RESOURCE_ADDRESS,
          recipientWalletAddress: targetAddress,
          amount,
          feeType: "private",
          enforceFeeType: true,
        },
        "sendPrivately (in-harness funding relay)"
      );
      break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const m = /you have (\d+)/.exec(msg);
      if (m && attempt === 1) {
        const capped = BigInt(m[1]) - 2_000_000n; // fee buffer for the private-fee lane
        if (capped >= 2_000_000n) {
          log(`${target.name}: sender holds only ${m[1]} -- capping relay to ${capped} and retrying`);
          amount = capped.toString();
          continue;
        }
      }
      log(`${target.name}: relay send failed: ${msg.split("\n")[0]}`);
      return false;
    }
  }
  const commitment: string | undefined = result?.recipientCommitment ?? result?.recipient_commitment;
  if (!commitment) {
    log(`${target.name}: relay result carried no recipientCommitment: ${JSON.stringify(result).slice(0, 200)}`);
    return false;
  }
  log(`${target.name}: claiming relayed private payment (commitment ${commitment.slice(0, 16)}...)`);
  try {
    await popupSend(target.popup, { kind: "popup-claim-private-payment", resourceAddress: TARI_RESOURCE_ADDRESS, commitment });
  } catch (e) {
    log(`${target.name}: relay claim failed: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
    return false;
  }
  return await discoverAndUnshieldInbound(target, dappPage);
}

/** Fund a wallet: already-funded skips everything; else discover inbound private transfers, then the on-chain faucet, then the community faucet. */
async function fundWallet(
  wallet: Wallet,
  walletAddress: string,
  dappPage: Page,
  relay?: { payer: Wallet; payerPage: Page }
): Promise<void> {
  await popupSend(wallet.popup, { kind: "popup-set-auto-lock-minutes", minutes: 480 });
  // A wallet that already holds revealed XTR (e.g. funded manually out of band, or a rerun) needs
  // no faucet at all -- every faucet is one-shot per wallet, so never re-drive a funded one.
  const existing = await revealedXtr(wallet).catch(() => 0n);
  if (existing > 0n) {
    log(`${wallet.name}: already holds revealed XTR ${existing} -- skipping faucet funding entirely`);
    return;
  }
  await ensureUnlocked(wallet);
  if (await fundViaOnchainFaucet(wallet)) {
    log(`${wallet.name}: FUNDED via the on-chain faucet (revealed XTR ${await revealedXtr(wallet)})`);
    return;
  }
  // Inbound private transfers (manual funding requested from another browser) land as stealth
  // outputs -- discover + unshield before escalating to any interactive faucet.
  log(`${wallet.name}: on-chain faucet unavailable -- checking for inbound private transfers`);
  if (await discoverAndUnshieldInbound(wallet, dappPage)) {
    log(`${wallet.name}: FUNDED via inbound private transfer (revealed XTR ${await revealedXtr(wallet)})`);
    return;
  }
  // Last automated alternative before any interactive faucet: relay private XTR from the payer
  // (sendPrivately + out-of-band recipientCommitment claim). Deterministic, no external service.
  if (relay && (await relayFromPayer(relay.payer, relay.payerPage, wallet, walletAddress, dappPage))) {
    log(`${wallet.name}: FUNDED via payer relay (revealed XTR ${await revealedXtr(wallet)})`);
    return;
  }
  // Escalation rule: the on-chain faucet vault is dry. The community faucet below is the only
  // automated alternative; when it is unavailable too, this throws and the run stops with the
  // state report -- never an infinite retry against a dry vault.
  log(`${wallet.name}: on-chain faucet unavailable -- falling back to the taritracker community faucet`);
  await fundViaCommunityFaucet(wallet, walletAddress, dappPage);
  log(`${wallet.name}: FUNDED via the community faucet (revealed XTR ${await revealedXtr(wallet)})`);
}

// ─── Real-popup approvals + the dApp request surface ────────────────────────────────────────

/**
 * Waits for the approval popup window the BACKGROUND opened (chrome.windows.create of
 * popup.html#/approve/<id> -> a new page in this context), reads the button the user would see,
 * and clicks it. This is the real user-visible approval -- no background bypass anywhere.
 * `expectUrlPart` pins the window to the request id when there is one.
 */
async function approveWindow(wallet: Wallet, expectUrlPart: string | null, what: string): Promise<Page> {
  // The window may already be open by the time we look (createTransactionRequest returns the
  // request id just as the background fires openApprovalWindow) -- scan before waiting.
  let page: Page | undefined = wallet.ctx.pages().find((p) => p.url().includes("#/approve/"));
  if (!page) {
    const candidate = await Promise.race([
      wallet.ctx.waitForEvent("page", { timeout: 90_000 }),
      (async () => {
        for (let i = 0; i < 180; i++) {
          const found = wallet.ctx.pages().find((p) => p.url().includes("#/approve/"));
          if (found) return found;
          await new Promise((r) => setTimeout(r, 500));
        }
        throw new Error("no approval window appeared");
      })(),
    ]);
    page = candidate as Page;
  }
  await page.waitForURL(/#\/approve\//, { timeout: 30_000 });
  const url = page.url();
  if (expectUrlPart && !url.includes(expectUrlPart)) {
    log(`  (approval window mismatch: wanted ${expectUrlPart} in ${url}; proceeding with this window anyway -- only one approval is pending in this harness)`);
  }
  await page.waitForSelector("#approve", { timeout: 60_000 });
  const label = (await page.locator("#approve").innerText()).trim();
  log(`${wallet.name}: approval window for ${what} -- clicking "${label}"`);
  // force:true -- the approval UI re-renders on status polls, which keeps the button "not stable"
  // for Playwright's actionability window; a mid-render window close then aborts the whole run.
  page.on("close", () => log(`${wallet.name}: approval window for ${what} CLOSED (url was ${page.url()})`));
  try {
    await page.locator("#approve").click({ force: true, timeout: 30_000 });
  } catch (e) {
    // Benign race: resolveApproval() closes the approval window the instant the click lands, so
    // Playwright can see "Target page ... closed" mid-click even though the click was delivered.
    if (page.isClosed()) {
      log(`${wallet.name}: approval window for ${what} closed on click (delivered)`);
    } else {
      throw e;
    }
  }
  return page;
}

/** Connect a fresh dApp tab (at the merchant service's origin) to this wallet. */
async function connectDapp(wallet: Wallet): Promise<Page> {
  const page = await wallet.ctx.newPage();
  await page.goto(`${SERVICE_URL}/`);
  await page.waitForFunction(() => !!(window as any).tari?.isTariWallet, null, { timeout: 30_000 });
  const request = page.evaluate(() => (window as any).tari.requestAccounts());
  await approveWindow(wallet, null, "site connect");
  const accounts = await request;
  log(`${wallet.name}: dApp connected at ${SERVICE_URL} -> ${JSON.stringify(accounts)}`);
  return page;
}

/**
 * create -> (real popup approval click) -> poll -> submit, using the provider's own primitives
 * (not the blocking sugar) so the approval window can be matched to the request id.
 */
async function requestWithApproval<T = any>(wallet: Wallet, page: Page, operation: Record<string, unknown>, what: string): Promise<T> {
  await ensureUnlocked(wallet);
  const { requestId } = await page.evaluate(
    (op) => (window as any).tari.request({ method: "tari_createTransactionRequest", params: op }),
    operation
  );
  log(`${wallet.name}: created ${what} request ${requestId}`);
  await approveWindow(wallet, requestId, what);
  const result = await page.evaluate(async ({ rid, label }) => {
    for (;;) {
      const s = await (window as any).tari.request({ method: "tari_getTransactionRequest", params: { requestId: rid } });
      if (s.status === "approved") {
        return await (window as any).tari.request({ method: "tari_submitTransactionRequest", params: { requestId: rid } });
      }
      if (s.status === "rejected" || s.status === "failed") throw new Error(`${label} request ${s.status}: ${s.error}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }, { rid: requestId, label: what });
  log(`${wallet.name}: ${what} completed -> ${JSON.stringify(result).slice(0, 400)}`);
  return result as T;
}

// ─── Generic polling ────────────────────────────────────────────────────────────────────────

async function pollUntil<T>(what: string, fn: () => Promise<T | null>, deadlineMs: number, intervalMs = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== null) return value;
    if (Date.now() - start > deadlineMs) throw new Error(`Timed out after ${deadlineMs / 1000}s waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const jfetch = async <T = any>(url: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}: ${JSON.stringify(body).slice(0, 300)}`);
  return body as T;
};

// ─── The shared purchase leg (both scenarios) ────────────────────────────────────────────────

interface Purchase {
  quote: X402PayTerms;
  fund: { transactionId: string; conditions: object[]; ownCommitment: string; outputMask: string };
  signedClaim: { signedPayloadHex: string; txHash: string; htlcOutputCommitment: string; refundEpoch: number; validUntilEpoch: number };
  claimResp: { status: string; localDigest?: string; chainTxId?: string; frozen?: boolean };
  resource: { body: string };
}

async function runPurchaseLeg(payer: Wallet, merchant: Wallet, payerPage: Page, merchantPage: Page, merchantViewKeyHex: string): Promise<Purchase> {
  // 1. The dApp fetch hits the paywall; the quote is parsed through the CLIENT PACKAGE's own
  //    wire path (pay402 -> base64 decode -> v2 detection -> Ootle entry normalization), exactly
  //    as a real dApp would consume it — not by reading a harness-side JSON body.
  let quote: X402PayTerms;
  if (WIRE_DIALECT === "v2") {
    const wrapped = pay402(fetch);
    try {
      await wrapped(`${SERVICE_URL}/protected`);
      throw new Error("expected the dApp fetch to be rejected with a 402 payment-required");
    } catch (e) {
      assert(e instanceof X402PaymentRequired, `dApp fetch answered 402 PAYMENT-REQUIRED (got ${String(e)})`);
      quote = e.quote as unknown as X402PayTerms;
    }
  } else {
    const response402 = await payerPage.evaluate(async () => {
      const res = await fetch("/protected");
      return { status: res.status, body: await res.json() };
    });
    assert(response402.status === 402, `dApp fetch answered 402 PAYMENT-REQUIRED (got ${response402.status})`);
    assert(response402.body.error === "PAYMENT_REQUIRED", "402 body carries error=PAYMENT_REQUIRED");
    quote = response402.body.quote as X402PayTerms;
  }
  log(`quote (${WIRE_DIALECT} dialect): ${JSON.stringify(quote)}`);

  // 2. The paying wallet funds the HTLC -- with a REAL popup approval click.
  const fund = await requestWithApproval(payer, payerPage, { kind: "x402Pay", ...quote }, "x402Pay (htlcFund)");
  assert(typeof fund.transactionId === "string" && fund.transactionId.length > 0, `x402Pay funded on-chain (fund tx ${fund.transactionId})`);
  assert(Array.isArray(fund.conditions) && fund.conditions.length >= 2, "x402Pay relayed the two-leaf conditions tree");
  assert(typeof fund.ownCommitment === "string" && typeof fund.outputMask === "string", "x402Pay relayed ownCommitment + outputMask (refund recovery path)");
  log(`fund result: ${JSON.stringify(fund)}`);

  // 3. The merchant's wallet signs the claim (sign-only) -- REAL popup approval click again.
  const secret = await jfetch(`${SERVICE_URL}/merchant/state`);
  const preimageHex = secret.preimageHex as string;
  assert(typeof preimageHex === "string" && preimageHex.length === 64, "merchant service exposed its claim preimage to its own wallet");
  const signedClaim = await requestWithApproval(
    merchant,
    merchantPage,
    { kind: "x402SignClaim", envelope: quote, preimageHex, htlcOutputCommitmentHex: fund.ownCommitment, conditions: fund.conditions },
    "x402SignClaim (sign-only)"
  );
  assert(typeof signedClaim.signedPayloadHex === "string" && signedClaim.signedPayloadHex.length > 0, "merchant wallet returned the sealed claim (signedPayloadHex)");
  assert(signedClaim.validUntilEpoch === quote.refundEpoch - 1, `signedClaim.validUntilEpoch == refundEpoch - 1 (${signedClaim.validUntilEpoch})`);
  log(`signed claim: txHash(localDigest)=${signedClaim.txHash} commitment=${signedClaim.htlcOutputCommitment} refundEpoch=${signedClaim.refundEpoch}`);

  // 4. The merchant service settles: facilitator validates + HOLDS, then serves, then (unless
  //    frozen) confirms settle -> broadcast.
  const claimResp = await jfetch(`${SERVICE_URL}/merchant/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signedClaim, conditions: fund.conditions, claimantViewKeyHex: merchantViewKeyHex }),
  });
  assert(
    claimResp.status === "held" || claimResp.status === "broadcast",
    `facilitator accepted the claim (status ${claimResp.status}, localDigest ${claimResp.localDigest})`
  );

  // 5. The resource is served while the payload is held (the spec's hold-then-broadcast ordering).
  const served = await payerPage.evaluate(async () => {
    const res = await fetch("/protected");
    return { status: res.status, body: await res.json() };
  });
  assert(served.status === 200, `resource served after settlement (HTTP ${served.status})`);
  log(`resource served: ${JSON.stringify(served.body)}`);

  return { quote, fund, signedClaim, claimResp, resource: served.body };
}

// ─── Chain reads (real esmeralda indexer, via the same SDK the facilitator uses) ──────────────

let provider: Awaited<ReturnType<typeof IndexerProvider.connect>> | null = null;
async function getProvider() {
  if (!provider) provider = await IndexerProvider.connect({ url: INDEXER_URL, network: toOotleNetwork(NETWORK) });
  return provider;
}

/** null/Down substate = the HTLC output no longer exists unspent = it was spent on-chain. */
async function htlcOutputSpent(commitmentHex: string): Promise<boolean> {
  const p = await getProvider();
  const sub = await p.getStealthUtxo(TARI_RESOURCE_ADDRESS, fromHex(commitmentHex));
  if (sub === null) return true; // gone from the live UTXO set
  const state = (sub as any).state;
  return state !== null && typeof state === "object" && !("up" in state); // Down = spent
}

async function txFinalizedCommit(transactionId: string): Promise<any> {
  const p = await getProvider();
  const { result } = (await p.getTransactionResult(transactionId)) as any;
  if (result === "Pending") return null;
  return result;
}

// ─── Scenario 1: happy path ─────────────────────────────────────────────────────────────────

interface SeedInfo {
  walletAddress: string;
  viewSecretHex: string;
}

async function scenarioHappy(seedIndex: number, payerInfo: SeedInfo, merchantInfo: SeedInfo): Promise<void> {
  log("=== SCENARIO: happy path (pay -> sign-only claim -> settle -> hold -> serve -> broadcast -> confirmed) ===");
  const facilitator = spawnChild(
    "facilitator",
    "npx",
    ["tsx", "e2e/facilitator/server.ts"],
    { X402_FACILITATOR_PORT: String(FACILITATOR_PORT), X402_INDEXER_URL: INDEXER_URL, X402_NETWORK: NETWORK }
  );
  const service = spawnChild("service", "node", ["e2e/harness/service.mjs"], {
    X402_SERVICE_PORT: String(SERVICE_PORT),
    X402_INDEXER_URL: INDEXER_URL,
    X402_FACILITATOR_URL: FACILITATOR_URL,
    X402_SERVICE_FREEZE_BROADCAST: "0",
    X402_SERVICE_WIRE_DIALECT: WIRE_DIALECT,
    X402_SERVICE_REFUND_EPOCH_OFFSET: String(HAPPY_REFUND_EPOCHS),
  });
  try {
    await waitHttpUp(`${FACILITATOR_URL}/x402/none`, "facilitator", 90_000);
    await waitHttpUp(`${SERVICE_URL}/merchant/state`, "service", 30_000);

    const payerSeed = await deriveMnemonic("payer", seedIndex);
    const merchantSeed = await deriveMnemonic("merchant", seedIndex);
    const payer = await launchWallet(`payer-happy`, payerSeed.mnemonic);
    const merchant = await launchWallet(`merchant-happy`, merchantSeed.mnemonic);
    try {
      const payerPage = await connectDapp(payer);
      const merchantPage = await connectDapp(merchant);
      await fundWallet(payer, payerInfo.walletAddress, payerPage);
      await fundWallet(merchant, merchantInfo.walletAddress, merchantPage, { payer, payerPage });
      const purchase = await runPurchaseLeg(payer, merchant, payerPage, merchantPage, merchantInfo.viewSecretHex);

      // Poll the settlement through the merchant service (which proxies the facilitator),
      // logging every status transition verbatim with its chain tx id.
      let last = "";
      const settled = await pollUntil(
        "settlement confirmed",
        async () => {
          const s = await jfetch(`${SERVICE_URL}/merchant/settlement`);
          const key = `${s.status}:${s.chainTxId ?? ""}`;
          if (key !== last) {
            log(`settlement status: ${s.status}${s.chainTxId ? ` (chainTxId ${s.chainTxId})` : ""}`);
            last = key;
          }
          return s.status === "confirmed" ? s : null;
        },
        10 * 60_000
      );
      const chainTxId = settled.chainTxId as string;
      assert(typeof chainTxId === "string" && chainTxId.length > 0, `settlement reached CONFIRMED with chain tx id ${chainTxId}`);

      // Chain evidence: the facilitator's tx really finalized, and the claimed output is spent.
      const final = await pollUntil("claim tx Finalized Commit on esmeralda", () => txFinalizedCommit(chainTxId).then((r) => (r && "Finalized" in r && r.Finalized.final_decision === "Commit" ? r : null)), 5 * 60_000);
      log(`claim tx ${chainTxId} Finalized: ${JSON.stringify(final).slice(0, 200)}`);
      assert(await htlcOutputSpent(purchase.fund.ownCommitment), "claimed HTLC output is spent on esmeralda");
      log("HAPPY PATH SCENARIO: PASS");
    } finally {
      await payer.ctx.close().catch(() => {});
      await merchant.ctx.close().catch(() => {});
    }
  } finally {
    facilitator.kill("SIGTERM");
    service.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ─── Scenario 2: refund path (frozen facilitator) ────────────────────────────────────────────

async function scenarioRefund(seedIndex: number, payerInfo: SeedInfo, merchantInfo: SeedInfo): Promise<void> {
  log("=== SCENARIO: refund path (hold, never broadcast; refundEpoch passes; funder refunds via outputMask) ===");
  const facilitator = spawnChild(
    "facilitator",
    "npx",
    ["tsx", "e2e/facilitator/server.ts"],
    { X402_FACILITATOR_PORT: String(FACILITATOR_PORT), X402_INDEXER_URL: INDEXER_URL, X402_NETWORK: NETWORK }
  );
  const service = spawnChild("service", "node", ["e2e/harness/service.mjs"], {
    X402_SERVICE_PORT: String(SERVICE_PORT),
    X402_INDEXER_URL: INDEXER_URL,
    X402_FACILITATOR_URL: FACILITATOR_URL,
    X402_SERVICE_FREEZE_BROADCAST: "1", // the freeze: held, never broadcast
    X402_SERVICE_WIRE_DIALECT: WIRE_DIALECT,
    X402_SERVICE_REFUND_EPOCH_OFFSET: String(REFUND_REFUND_EPOCHS),
  });
  try {
    await waitHttpUp(`${FACILITATOR_URL}/x402/none`, "facilitator", 90_000);
    await waitHttpUp(`${SERVICE_URL}/merchant/state`, "service", 30_000);

    const payerSeed = await deriveMnemonic("payer", seedIndex);
    const merchantSeed = await deriveMnemonic("merchant", seedIndex);
    const payer = await launchWallet(`payer-refund`, payerSeed.mnemonic);
    const merchant = await launchWallet(`merchant-refund`, merchantSeed.mnemonic);
    // The refund wallets are fresh (per-run seeds), so neither the on-chain faucet (dry) nor the
    // view-key scan can fund the refund payer. The happy scenario's payer (seedIndex-1) is a known
    // funded deterministic wallet: launch it as a sponsor and relay through it -- sponsor sends
    // privately to the refund payer (commitment claimed out of band), then the refund payer relays
    // to the refund merchant like any other target.
    const sponsorSeed = await deriveMnemonic("payer", seedIndex - 1);
    const sponsor = await launchWallet(`sponsor-refund`, sponsorSeed.mnemonic);
    try {
      const payerPage = await connectDapp(payer);
      const merchantPage = await connectDapp(merchant);
      const sponsorPage = await connectDapp(sponsor);
      await fundWallet(payer, payerInfo.walletAddress, payerPage, { payer: sponsor, payerPage: sponsorPage });
      await fundWallet(merchant, merchantInfo.walletAddress, merchantPage, { payer, payerPage });
      const purchase = await runPurchaseLeg(payer, merchant, payerPage, merchantPage, merchantInfo.viewSecretHex);
      assert(purchase.claimResp.frozen === true, "facilitator FROZEN: claim held, broadcast never confirmed");

      // Wait for the chain's own epoch to pass refundEpoch (poll, no fixed sleeps).
      // Margin of +1: the wallet's dry-run epoch source can lag the indexer probe across the
      // boundary (runT: probe said 12754, wallet dry-run executed at 12753 -> AfterEpoch rejected),
      // and AfterEpoch(N) may only be satisfied strictly after N depending on the builtin.
      const p = await getProvider();
      const refundEpoch = purchase.quote.refundEpoch;
      const refundEpochSafe = refundEpoch + 1;
      log(`waiting for chain epoch >= ${refundEpochSafe} (budget ${EPOCH_WAIT_MINUTES} min)`);
      let firstObserved = await p.getCurrentEpoch();
      const waitStart = Date.now();
      await pollUntil(
        `chain epoch >= ${refundEpoch}`,
        async () => {
          const epoch = await p.getCurrentEpoch();
          if (epoch !== firstObserved) {
            log(`chain epoch: ${epoch}`);
            firstObserved = epoch;
          }
          return epoch >= refundEpochSafe ? epoch : null;
        },
        EPOCH_WAIT_MINUTES * 60_000,
        20_000
      );
      log(`refundEpoch ${refundEpoch} passed (${((Date.now() - waitStart) / 1000).toFixed(0)}s of epoch wait)`);

      // The facilitator must now report the held payload as expired -- stable terminal answer.
      const expired = await pollUntil(
        "settlement expired",
        async () => {
          const s = await jfetch(`${SERVICE_URL}/merchant/settlement`);
          log(`settlement status: ${s.status}`);
          return s.status === "expired" ? s : null;
        },
        5 * 60_000,
        5_000
      );
      assert(expired.status === "expired", `settlement reports EXPIRED (never broadcast; chainTxId absent: ${expired.chainTxId ?? "none"})`);

      // The funder's refund, through the outputMask path -- REAL popup approval click.
      // Retry on epoch-predicate rejections: the wallet's dry-run epoch source can still lag
      // the harness probe across the boundary (runT died once on AfterEpoch(12754) at 12753).
      let refund: Awaited<ReturnType<typeof requestWithApproval>> | null = null;
      for (let attempt = 1; ; attempt++) {
        try {
          refund = await requestWithApproval(
            payer,
            payerPage,
            {
              kind: "htlcRefund",
              resourceAddress: purchase.quote.resourceAddress,
              commitment: purchase.fund.ownCommitment,
              conditions: purchase.fund.conditions,
              amount: purchase.quote.amount,
              outputMask: purchase.fund.outputMask,
            },
            "htlcRefund (funder recovery)"
          );
          break;
        } catch (err) {
          const msg = String((err as any)?.message ?? err);
          if (attempt < 10 && /AfterEpoch\(\d+\)|Spend condition not met/.test(msg)) {
            log(`refund attempt ${attempt}: epoch predicate not satisfied yet -- retrying in 60s`);
            await new Promise((r) => setTimeout(r, 60_000));
            continue;
          }
          throw err;
        }
      }
      const refundTxId = refund.transactionId;
      assert(typeof refundTxId === "string" && refundTxId.length > 0, `refund tx submitted to esmeralda (${refundTxId})`);
      log(`refund result: ${JSON.stringify(refund).slice(0, 300)}`);

      const final = await pollUntil("refund tx Finalized Commit on esmeralda", () => txFinalizedCommit(refundTxId).then((r) => (r && "Finalized" in r && r.Finalized.final_decision === "Commit" ? r : null)), 5 * 60_000);
      log(`refund tx ${refundTxId} Finalized: ${JSON.stringify(final).slice(0, 200)}`);

      assert(await htlcOutputSpent(purchase.fund.ownCommitment), "HTLC output refunded (spent) on esmeralda");

      // Best-effort evidence the payer actually recovered the funds: the wallet's own UTXO scan.
      try {
        const recovered = await payerPage.evaluate(async () => {
          await (window as any).tari.request({ method: "tari_scanForOwnedUtxos", params: {} });
          const balances = await (window as any).tari.request({ method: "tari_getPrivateBalances", params: undefined });
          return balances;
        });
        log(`payer private balances after refund scan: ${JSON.stringify(recovered).slice(0, 400)}`);
      } catch (e) {
        log(`(best-effort payer balance check unavailable: ${e instanceof Error ? e.message : e})`);
      }
      log("REFUND SCENARIO: PASS");
    } finally {
      await payer.ctx.close().catch(() => {});
      await merchant.ctx.close().catch(() => {});
      await sponsor.ctx.close().catch(() => {});
    }
  } finally {
    facilitator.kill("SIGTERM");
    service.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  log(`x402 e2e harness: scenarios=[${SCENARIOS.join(",")}] runIndex=${RUN_INDEX} network=${NETWORK} indexer=${INDEXER_URL}`);
  log(`extension dir: ${DIST}`);
  if (!existsSync(path.join(DIST, "manifest.json"))) {
    throw new Error(`${DIST} has no manifest.json -- run \`pnpm run build\` first (see e2e/harness/README.md)`);
  }

  let exit = 0;
  for (let i = 0; i < SCENARIOS.length; i++) {
    const scenario = SCENARIOS[i]!;
    // Unique seed index per scenario AND per rerun: reruns must not collide with spent outputs.
    const seedIndex = RUN_INDEX * 10 + i;
    // Wallet addresses and the merchant's TEST view key are derived offline from the
    // deterministic seeds (the facilitator stand-in's documented claimantViewKeyHex deviation).
    const merchantInfo = await deriveAccountInfo((await deriveMnemonic("merchant", seedIndex)).entropy);
    const payerInfo = await deriveAccountInfo((await deriveMnemonic("payer", seedIndex)).entropy);
    log(`scenario ${scenario}: seedIndex ${seedIndex}, payer wallet ${payerInfo.walletAddress}`);
    log(`scenario ${scenario}: seedIndex ${seedIndex}, merchant wallet ${merchantInfo.walletAddress}`);
    process.env.X402_SERVICE_CLAIMANT_ADDRESS = merchantInfo.walletAddress;
    try {
      if (scenario === "happy") await scenarioHappy(seedIndex, payerInfo, merchantInfo);
      else if (scenario === "refund") await scenarioRefund(seedIndex, payerInfo, merchantInfo);
      else throw new Error(`Unknown scenario "${scenario}" (want happy|refund)`);
    } catch (e) {
      if (e instanceof Escalation) {
        log(`ESCALATION (${scenario}): ${e.message}`);
        log(`State at escalation: see ${LOG_FILE}; children were stopped, contexts closed.`);
        return 2;
      }
      log(`SCENARIO ${scenario} FAILED: ${e instanceof Error ? e.message : String(e)}`);
      if (e instanceof Error && e.stack) log(e.stack.split("\n").slice(0, 8).join("\n"));
      exit = 1;
    }
  }
  if (exit === 0) log("ALL SCENARIOS PASSED");
  return exit;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    log(`HARNESS CRASHED: ${e instanceof Error ? e.message : String(e)}`);
    if (e instanceof Error && e.stack) log(e.stack.split("\n").slice(0, 12).join("\n"));
    process.exit(2);
  });
