// Fail if test-only code gets into the deployed forge. That code is the
// software authenticator of the library, which signs all data that it gets,
// the test harness, and the test Git server. The script bundles the Worker as
// `wrangler deploy` does, with wrangler.jsonc. Then it searches the bundle for
// names that only that code holds.
//
//   node scripts/check-production-bundle.ts
//
// Run it from apps/forge. `npm test` runs it. The bundle must also hold names
// that the production code uses. If not, the search proves nothing.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FORBIDDEN: [name: string, from: string][] = [
  ["SoftwareAuthenticator", "passkey-cloudflare/testing"],
  ["createExecutionContext", "cloudflare:test (test/harness.ts)"],
  ["git http-backend", "authority/test/git-server.ts"],
];
const EXPECTED = ["OPERATOR_RECORD_IDS", "forge-verify.mjs", "cf.artifacts.repo.pushed"];

const outdir = mkdtempSync(join(tmpdir(), "forge-bundle-"));
try {
  execFileSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", outdir, "-c", "wrangler.jsonc"], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  const files = readdirSync(outdir).filter((file) => file.endsWith(".js"));
  const bundle = files.map((file) => readFileSync(join(outdir, file), "utf8")).join("\n");
  for (const name of EXPECTED) {
    if (!bundle.includes(name)) {
      console.error(`production bundle check: ${name} is not in the bundle (${files.join(", ")}), so it was not built from src/index.ts`);
      process.exit(1);
    }
  }
  for (const [name, from] of FORBIDDEN) {
    if (bundle.includes(name)) {
      console.error(`production bundle check: ${name} is in the production bundle; src/index.ts must not import ${from}`);
      process.exit(1);
    }
    console.log(`production bundle check: ${name} is not in the production bundle`);
  }
} finally {
  rmSync(outdir, { recursive: true, force: true });
}
