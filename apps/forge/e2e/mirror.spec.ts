// The GitHub mirror, with a local `git http-backend` in GitHub's place. After
// a promotion, the forge force-pushes main to the mirror. Then this test runs
// what the mirror's workflow runs: it fetches the verifier, checks the digest
// the repository pins, and runs it in an empty folder. A commit pushed to the
// mirror by hand fails the check; a second mirror push restores main.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startGitServer, type GitServer } from "../authority/test/git-server.ts";
import { MIRROR_PORT } from "../playwright.config.ts";

test.skip(Boolean(process.env.FORGE_URL), "the mirror test needs its local Git server in GitHub's place");

let server: GitServer;
const root = mkdtempSync(join(tmpdir(), "forge-mirror-"));

test.beforeAll(async () => {
  server = await startGitServer(root, "ghp_e2e_token", MIRROR_PORT);
});
test.afterAll(() => server?.close());

async function addAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
}

async function approve(page: Page) {
  const sheet = page.locator("#approval");
  await sheet.getByRole("button", { name: "Approve with passkey" }).click();
  await sheet.getByRole("button", { name: "Done" }).click({ timeout: 30_000 });
}

/** What the workflow does, in an empty folder: fetch the verifier, check the pinned digest, run it on `clone`. */
function runWorkflow(clone: string): { status: number; output: string } {
  const workflow = readFileSync(join(clone, ".github/workflows/verify.yml"), "utf8");
  const url = /VERIFIER_URL: (\S+)/.exec(workflow)![1]!;
  const pinned = /VERIFIER_SHA256: ([0-9a-f]{64})/.exec(workflow)![1]!;
  const folder = mkdtempSync(join(tmpdir(), "forge-runner-"));
  const bytes = execFileSync("curl", ["-fsSL", url]);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(pinned);
  writeFileSync(join(folder, "forge-verify.mjs"), bytes);
  const run = spawnSync("node", [join(folder, "forge-verify.mjs"), clone, "--ref", "main"], { cwd: folder, encoding: "utf8" });
  return { status: run.status ?? -1, output: run.stdout + run.stderr };
}

function cloneOf(bare: string): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-mirror-clone-"));
  execFileSync("git", ["clone", "-q", bare, dir]);
  return dir;
}

test("a promoted history mirrors to GitHub, where the pinned verifier passes it and catches a commit pushed by hand", async ({ page }) => {
  await addAuthenticator(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await page.getByRole("button", { name: "Continue with passkey" }).click();
  await page.locator("#register-name").fill(`Leo${Date.now().toString(36)}`);
  await page.getByRole("button", { name: "Register with a passkey" }).click();
  await page.getByRole("checkbox", { name: "I have saved my recovery codes" }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  await page.getByRole("button", { name: "Create with passkey" }).click();
  await approve(page); // the inception commit
  await approve(page); // the first policy
  await page.getByRole("button", { name: "Admit Ada and Bo" }).click();
  await approve(page);
  await expect(page.locator(".proposal-ready")).toHaveCount(2, { timeout: 60_000 });
  await page.locator(".proposal", { hasText: "Add a changelog entry" }).getByRole("button", { name: "Promote with passkey" }).click();
  await approve(page);

  const state = await page.evaluate(async () => (await fetch(`/forge/projects/${location.hash.slice(4)}`)).json());
  const bare = join(root, "forge-mirror", `${state.repo.name}.git`);
  mkdirSync(bare, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["config", "http.receivepack", "true"], { cwd: bare });

  await page.getByRole("button", { name: "Mirror to GitHub" }).click();
  await expect(page.locator(".mirror")).toContainText(`is on forge-mirror/${state.repo.name}`, { timeout: 30_000 });
  expect(execFileSync("git", ["rev-parse", "main"], { cwd: bare }).toString().trim()).toBe(state.mainHead);

  const clone = cloneOf(bare);
  execFileSync("actionlint", [join(clone, ".github/workflows/verify.yml")]);
  const green = runWorkflow(clone);
  expect(green.output).toContain("✓ All 5 commits verify");
  expect(green.status).toBe(0);

  // Someone with push access to the mirror adds a commit by hand.
  execFileSync("git", ["-c", "user.name=Mallory", "-c", "user.email=m@example.com", "commit", "-q", "--allow-empty", "-m", "Pushed by hand"], { cwd: clone });
  execFileSync("git", ["push", "-q", "--force", "origin", "main"], { cwd: clone });
  const red = runWorkflow(cloneOf(bare));
  expect(red.status).toBe(1);
  expect(red.output).toContain("R1 Main moved without an approval from a promoter.");
  await expect(page.locator(".mirror")).toContainText(state.mainHead.slice(0, 7));

  // A second mirror push restores main as the forge holds it.
  await page.getByRole("button", { name: "Mirror to GitHub again" }).click();
  await expect.poll(() => execFileSync("git", ["rev-parse", "main"], { cwd: bare }).toString().trim(), { timeout: 30_000 }).toBe(state.mainHead);
  expect(runWorkflow(cloneOf(bare)).status).toBe(0);
});
