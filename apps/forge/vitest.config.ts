import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.local.jsonc" },
      // Repositories are in LocalRepo objects, refusals have no delay, and agents do not pause.
      miniflare: { bindings: { REFUSAL_FLOOR_MS: "0", REPO_HOST: "local", AGENT_STEP_MS: "0" } },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
