const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Optional integrity check against a quote's `resourceSha256` pin: computes SHA-256 of
 * `body` (Web Crypto) and compares it to `expectedSha256`, lowercase-hex. With no pin
 * (`expectedSha256 === undefined`) there is nothing to verify — resolves `true`.
 * Resolves `false` on mismatch; never throws for a mismatch.
 */
export async function verifyBody(
  body: Uint8Array,
  expectedSha256?: string
): Promise<boolean> {
  if (expectedSha256 === undefined) return true;
  if (!HEX_64.test(expectedSha256)) {
    throw new TypeError(`verifyBody: expectedSha256 must be 64 lowercase hex characters, got '${expectedSha256}'.`);
  }
  const digest = await crypto.subtle.digest("SHA-256", body as unknown as BufferSource);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex === expectedSha256;
}
