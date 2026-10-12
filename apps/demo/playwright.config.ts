import { defineConfig } from "@playwright/test";
import { OPERATORS } from "./e2e/operators.ts";

// Browser smoke tests against the real demo page, served by `wrangler dev`
// with the relying party set to localhost. `--local-upstream` stops wrangler
// rewriting each request's Origin to the custom-domain route, which the Worker
// would refuse. It runs the e2e entry, src/e2e.ts, whose operators are named by
// member name (e2e/operators.ts), so the operator tests drive real operators.
const PORT = 8788;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  use: { baseURL: `http://localhost:${PORT}`, browserName: "chromium" },
  webServer: {
    command: `wrangler dev src/e2e.ts --port ${PORT} --local-upstream localhost:${PORT} --var RP_ID:localhost --var ORIGIN:http://localhost:${PORT} --var REFUSAL_FLOOR_MS:0 --var OPERATOR_MEMBER_NAMES:${Object.values(OPERATORS).join(",")} --persist-to .wrangler/e2e-state`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
