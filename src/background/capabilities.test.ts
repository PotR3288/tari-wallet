// The tari_getCapabilities flag table (background/capabilities.ts) -- pure, so every account-kind
// split is pinned here: a flag that silently flips for the wrong account kind is exactly the
// regression nothing else in this codebase would catch (background/index.ts has no harness).
// The load-bearing additions as the x402 work lands: `signOnly` must follow `htlcFund`/`scriptPathSpend`
// (the sign-only claim is the settlement half of the same stealth surface), not the both-kinds set.
import { describe, expect, it } from "vitest";
import { walletCapabilities } from "./capabilities";

describe("walletCapabilities", () => {
  it("reports the local-only stealth surface, signOnly included, for a seed-derived local account", () => {
    const caps = walletCapabilities(true, false, false);
    // The sign-only x402 claim needs the account's own view secret to decrypt the funded output,
    // so it rides with the rest of the local-only stealth surface.
    expect(caps.signOnly).toBe(true);
    expect(caps.htlcFund).toBe(true);
    expect(caps.scriptPathSpend).toBe(true);
    expect(caps.supportsPrivateFees).toBe(true);
    expect(caps.exactInputSelection).toBe(true);
    // The grant is per-site state, not an account property.
    expect(caps.privateViewGranted).toBe(false);
  });

  it("reports signOnly: false for a daemon-relayed account (no client-side view secret)", () => {
    const caps = walletCapabilities(false, true, false);
    expect(caps.signOnly).toBe(false);
    // The daemon-delegated subset still reports honestly.
    expect(caps.privateSpend).toBe(true);
    expect(caps.shieldFunds).toBe(true);
    expect(caps.privateBalanceView).toBe(true);
  });

  it("reflects the site's separate private-view grant in privateViewGranted, for either account kind", () => {
    expect(walletCapabilities(true, false, true).privateViewGranted).toBe(true);
    expect(walletCapabilities(false, true, true).privateViewGranted).toBe(true);
    expect(walletCapabilities(false, true, false).privateScan).toBe(false); // still local-only
  });
});
