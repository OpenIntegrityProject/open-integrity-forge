import { defineConfig } from "@playwright/test";

// The forge page in Chromium with a virtual authenticator, against
// `wrangler dev` with the local configuration: repositories in LocalRepo
// objects, the relying party on localhost. No Cloudflare login is needed. The
// GitHub mirror points at a local Git server, and skips the GitHub API.
export const PORT = 8789;
/** The local Git server that stands in for GitHub in e2e/mirror.spec.ts. */
export const MIRROR_PORT = 8791;

/**
 * With FORGE_URL set, the tests run against that forge instead, such as the
 * deployed one with real Artifacts, and start no server. The mirror test then
 * skips itself, since it needs its local Git server.
 */
const deployed = process.env.FORGE_URL;

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  use: { baseURL: deployed ?? `http://localhost:${PORT}`, browserName: "chromium" },
  webServer: deployed ? undefined : {
    command: `wrangler dev -c wrangler.local.jsonc --port ${PORT} --var RP_ID:localhost --var ORIGIN:http://localhost:${PORT} --var REFUSAL_FLOOR_MS:0 --var AGENT_STEP_MS:150 --var MIRROR_OWNER:forge-mirror --var MIRROR_GIT_BASE:http://127.0.0.1:${MIRROR_PORT} --var MIRROR_API: --var GITHUB_TOKEN:ghp_e2e_token --persist-to .wrangler/e2e-state`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
