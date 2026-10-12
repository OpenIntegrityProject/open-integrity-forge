// The sample project the agents work on: a small notes repository. Its
// inception commit holds these files and the signer policy.

import { ALLOWED_SIGNERS_PATH, allowedSigners, POLICY_PATH, renderPolicy, type Policy } from "../authority/policy.ts";
import type { Verifier } from "./verifier.ts";

export const REPO_README = `# How to verify this repository

This repository carries its own rules. \`.repo/config/verification/policy.json\`
lists the keys it trusts:

- **Promoters** may approve a change of \`main\` or of \`.repo/\`. A promoter key
  is a passkey. Each approval is a WebAuthn assertion over one exact change:
  this repository, the parents and the tree. It is in the commit message, in
  the \`Forge-Approval\` trailer.
- **Authors** may sign work in their own forks, each with a short-lived SSH key.
  An author key cannot approve, and cannot change \`.repo/\`.

The first commit of \`main\` is the root of trust. Its id is the id of this
repository. Each later commit is checked against the policy of its first
parent, so a commit cannot change the rules it obeys, and a key can never
authorize itself.

To check it with no server, on any clone, with Node 22 or later:

    curl -fsSLO <forge>/forge-verify.mjs     # the digest is in .github/workflows/verify.yml
    node forge-verify.mjs . --repo <the id of the first commit>

To check the author signatures with git alone:

    git -c gpg.ssh.allowedSignersFile=.repo/config/verification/allowed_commit_signers log --show-signature
`;

export const WORKFLOW_PATH = ".github/workflows/verify.yml";

/**
 * The GitHub workflow that checks a mirror of the repository. It fetches the
 * verifier this forge serves and checks its digest before it runs it.
 */
export function workflow(verifier: Verifier): string {
  return `# Made by the forge with the first commit, so the promoter approved it.
# It checks each commit of main against .repo/config/verification/policy.json
# with the forge verifier, pinned by its SHA-256 digest.
name: Verify the repository's rules

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Fetch the verifier and check its digest
        env:
          VERIFIER_URL: ${verifier.url}
          VERIFIER_SHA256: ${verifier.sha256}
        run: |
          curl -fsSL "$VERIFIER_URL" -o "$RUNNER_TEMP/forge-verify.mjs"
          echo "$VERIFIER_SHA256  $RUNNER_TEMP/forge-verify.mjs" | sha256sum --check --strict
      - name: Verify each commit of main against the policy
        env:
          FORGE_REPO_ID: \${{ vars.FORGE_REPO_ID }}
        run: node "$RUNNER_TEMP/forge-verify.mjs" . --ref main \${FORGE_REPO_ID:+--repo "$FORGE_REPO_ID"}
`;
}

/**
 * The repository is also a tiny Worker that serves its notes. Connect it to
 * Workers Builds in the dashboard (Settings > Builds > Connect, with this
 * Artifacts repository), and each promotion to main deploys it: only a
 * person's passkey approval ships.
 */
function workerFiles(repoName: string): Record<string, string> {
  return {
    "wrangler.jsonc": `{
  // Deploys the notes as a static site. Workers Builds runs \`npx wrangler deploy\` on each push to main,
  // and only a promotion approved with a passkey moves main.
  "name": "${repoName}-notes",
  "compatibility_date": "2026-08-15",
  "assets": { "directory": "./notes", "html_handling": "auto-trailing-slash" }
}
`,
    "notes/index.html": `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Notes</title></head>
  <body>
    <h1>Notes</h1>
    <p>Each note here reached main through a merge that a person approved with a passkey. Read them as Markdown:</p>
    <ul><li><a href="independence.md">Independence</a></li><li><a href="resilience.md">Resilience</a></li></ul>
  </body>
</html>
`,
  };
}

export function templateFiles(name: string, policy: Policy, verifier: Verifier | null = null, repoName = "notes"): Record<string, string> {
  return {
    ...workerFiles(repoName),
    ...(verifier ? { [WORKFLOW_PATH]: workflow(verifier) } : {}),
    "README.md": `# ${name}\n\nShort notes on Gordian ideas, kept by people and their agents.\n\nSee [.repo/README.md](.repo/README.md) for who may change what, and how to check it.\n`,
    "CHANGELOG.md": "# Changelog\n\n- Created the repository and its signer policy.\n",
    "notes/independence.md":
      "# Independence\n\nNo identity provider, password or email address stands between a person and their account.\n",
    "notes/resilience.md": "# Resilience\n\nLosing one device does not lose the account.\n",
    ".repo/README.md": REPO_README,
    ...policyFiles(policy),
  };
}

/** The policy file and the allowed signers file made from it. */
export function policyFiles(policy: Policy): Record<string, string> {
  return { [POLICY_PATH]: renderPolicy(policy), [ALLOWED_SIGNERS_PATH]: allowedSigners(policy) };
}

export function inceptionMessage(name: string): string {
  return `Establish ${name} and its signer policy

This repository is governed by .repo/config/verification/policy.json.
Only a promoter listed there may change .repo/ or advance main.
Authors may sign work in their own forks. A key never authorizes itself.
`;
}
