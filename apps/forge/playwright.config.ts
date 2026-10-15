import { defineConfig } from "@playwright/test";

// The forge page in Chromium with a virtual authenticator, against
// `wrangler dev` with the local configuration: repositories in LocalRepo
// objects, and the relying party on localhost. The tests need no Cloudflare
// login. The GitHub mirror uses a local Git server and does not use the GitHub
// API.
export const PORT = 8789;
/** The port of the local Git server that replaces GitHub in e2e/mirror.spec.ts. */
export const MIRROR_PORT = 8791;

/**
 * When FORGE_URL is set, the tests run against that forge, for example the
 * deployed forge with real Artifacts, and start no server. The mirror test and
 * the accessibility audit then skip themselves. The mirror test needs its local
 * Git server, and the audit makes projects that it does not delete.
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
