import { defineConfig } from "vitest/config";

// The facilitator stand-in's tests run under the repo's own vitest (same environment), but
// NOT under the root `vitest.config.ts` include (`src/**/*.test.ts`): the extension and the
// client package are frozen, and so is that config. This minimal sibling config exists so
// `npx vitest run --config e2e/facilitator/vitest.config.ts` (see README.md) collects
// `e2e/facilitator/**/*.test.ts` without touching any frozen file.
export default defineConfig({
  test: {
    environment: "node",
    include: ["e2e/facilitator/**/*.test.ts"],
  },
});