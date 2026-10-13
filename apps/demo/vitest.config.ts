import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Refusals answer at once, as in Playwright; "no distinguishable ceremony failure" sets its own floor.
      miniflare: { bindings: { REFUSAL_FLOOR_MS: "0" } },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
