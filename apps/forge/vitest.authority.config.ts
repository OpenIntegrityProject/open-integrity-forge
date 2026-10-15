import { defineConfig } from "vitest/config";

// The authority module, the scripts and the `*.node.test.ts` files in src need no Workers runtime, so their tests run in Node.
export default defineConfig({
  test: {
    include: ["authority/**/*.test.ts", "scripts/**/*.test.ts", "src/**/*.node.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
