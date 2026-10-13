// Fail if code only the test Workers import reaches the deployed demo: naming
// operators by member name, or the raised rate limits Playwright runs with.
// Bundles the production entry the way `wrangler deploy` does, with
// wrangler.jsonc, and searches the bundle for a name only that code holds.
//
//   node scripts/check-production-bundle.ts
//
// Run it from apps/demo; `npm test` does. The bundle must still hold the
// secret's name, which the production code reads, or the search proves nothing.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A name only each test-only file holds, and the file. */
const FORBIDDEN: [name: string, file: string][] = [
  ["OPERATOR_MEMBER_NAMES", "src/operator-member-names.ts"],
  ["E2E_RATE_LIMITS", "src/e2e-rate-limits.ts"],
];
const EXPECTED = "OPERATOR_RECORD_IDS";

const outdir = mkdtempSync(join(tmpdir(), "demo-bundle-"));
try {
  execFileSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", outdir, "-c", "wrangler.jsonc"], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  const files = readdirSync(outdir).filter((file) => file.endsWith(".js"));
  const bundle = files.map((file) => readFileSync(join(outdir, file), "utf8")).join("\n");
  if (!bundle.includes(EXPECTED)) {
    console.error(
      `production bundle check: ${EXPECTED} is not in the bundle (${files.join(", ")}), so it was not built from src/index.ts`,
    );
    process.exit(1);
  }
  for (const [name, file] of FORBIDDEN) {
    if (bundle.includes(name)) {
      console.error(
        `production bundle check: ${name} is in the production bundle; src/index.ts must not import ${file}`,
      );
      process.exit(1);
    }
    console.log(`production bundle check: ${name} is not in the production bundle`);
  }
} finally {
  rmSync(outdir, { recursive: true, force: true });
}
