import { defineConfig } from "vitest/config";

// The authority module needs no Workers runtime, so its tests run in Node.
export default defineConfig({
  test: {
    include: ["authority/**/*.test.ts", "scripts/**/*.test.ts", "src/**/*.node.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
