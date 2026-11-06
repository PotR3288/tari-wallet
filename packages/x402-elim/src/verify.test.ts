import { describe, expect, it } from "vitest";
import { verifyBody } from "./index.js";
import { OTHER_SHA, RESOURCE_SHA } from "./test-utils.js";

const BODY = new TextEncoder().encode("the paid-for article body");

describe("verifyBody", () => {
  it("matches the pinned resourceSha256", async () => {
    // Sanity: the fixture really is the body's SHA-256.
    const digest = await crypto.subtle.digest("SHA-256", BODY);
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(hex).toBe(RESOURCE_SHA);

    await expect(verifyBody(BODY, RESOURCE_SHA)).resolves.toBe(true);
  });

  it("reports a mismatch", async () => {
    await expect(verifyBody(BODY, OTHER_SHA)).resolves.toBe(false);
  });

  it("passes when the quote pinned no hash (nothing to verify)", async () => {
    await expect(verifyBody(BODY)).resolves.toBe(true);
    await expect(verifyBody(BODY, undefined)).resolves.toBe(true);
  });

  it("rejects a malformed pin loudly", async () => {
    await expect(verifyBody(BODY, "not-hex")).rejects.toThrow(/64 lowercase hex/);
  });
});
