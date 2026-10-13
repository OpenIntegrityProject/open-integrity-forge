// The designed page in a real browser: a passkey from Chromium's virtual
// authenticator signs in and approves each change on the approval sheet.
// The first test drives the journey by hand, then git clones the repository
// over HTTP, and forge-verify and git itself check the clone on disk. The
// second plays the story autopilot to its end.

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

async function addAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

async function register(page: Page) {
  const memberName = `Leo${Date.now().toString(36)}`;
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await page.getByRole("button", { name: "Continue with passkey" }).click();
  await page.locator("#register-name").fill(memberName);
  await page.getByRole("button", { name: "Register with a passkey" }).click();
  await page.getByRole("checkbox", { name: "I have saved my recovery codes" }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.locator("#member-name")).toHaveText(memberName);
  return memberName;
}

/** Check the title of the approval sheet, approve what it shows, and close it. */
async function approve(page: Page, title: string) {
  const sheet = page.locator("#approval");
  await expect(sheet.getByRole("heading", { level: 2 })).toHaveText(title, { timeout: 30_000 });
  await sheet.getByRole("button", { name: "Approve with passkey" }).click();
  await expect(sheet.getByRole("heading", { name: title === "Sign the inception commit" ? "Signed" : "Approved" })).toBeVisible({ timeout: 30_000 });
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(sheet).toBeHidden();
}

/**
 * Locally, slow down the forge's answers, as the network to a deployed forge
 * does. A press that comes while an action ends, or while a project loads,
 * must wait for its button, not vanish.
 */
async function slowNetwork(page: Page) {
  if (process.env.FORGE_URL) return;
  await page.route(/\/forge\/(me|projects\/[0-9a-f-]{36}(\/stream)?)$/, async (route) => {
    await new Promise((r) => setTimeout(r, 800));
    await route.continue();
  });
}

/** On a deployed forge, delete what the test made, so no repositories are left in Artifacts. */
test.afterEach(async ({ page }) => {
  if (!process.env.FORGE_URL || !/^#\/p\//.test(new URL(page.url()).hash)) return;
  page.on("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Delete this project" }).click();
  await expect(page.locator("#status")).toContainText("The project is deleted.", { timeout: 60_000 });
});

test("a person creates a project, agents propose, the rogue key is rejected, and a clone verifies outside the forge", async ({ page }) => {
  await addAuthenticator(page);
  await slowNetwork(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agents may write. Only a person may promote." })).toBeVisible();
  const memberName = await register(page);
  await expect(page.locator("#promoter-badge")).toHaveText(/Promoter key [a-z]{4}-[a-z]{4}-[a-z]{4}/);

  // The inception commit: the passkey signs an empty root, then approves the first policy.
  await page.getByRole("button", { name: "Create with passkey" }).click();
  await expect(page.locator("#approval")).toContainText("None: this is the root of trust");
  await expect(page.locator("#approval")).toContainText("Sign the inception commit of gordian-notes");
  await approve(page, "Sign the inception commit");
  await expect(page.locator("#approval")).toContainText(`Set the first policy of gordian-notes, with ${memberName} as its only promoter`);
  await approve(page, "Approve the first policy");
  await expect(page.locator("#repo-meta")).toContainText(/Repository id [0-9a-f]{7}/);
  await expect(page.locator(".graph .node")).toHaveCount(2);

  // Two agents, two forks, two signed proposals.
  await page.getByRole("button", { name: "Admit Ada and Bo" }).click();
  await approve(page, "Approve the new rules");
  await expect(page.locator(".proposal-ready")).toHaveCount(2, { timeout: 60_000 });
  await expect(page.locator(".agent")).toHaveCount(2);

  // The rogue task is rejected by R2.
  await page.getByRole("button", { name: "Ask Bo to make its own key a promoter" }).click();
  const rogue = page.locator(".proposal-rejected");
  await expect(rogue).toContainText("a key can never authorize itself", { timeout: 60_000 });
  await rogue.locator(".why > summary").click();
  await expect(rogue).toContainText('"kind": "ssh-ed25519"');

  // Promote Ada's change.
  await page.locator(".proposal", { hasText: "Add a changelog entry" }).getByRole("button", { name: "Promote with passkey" }).click();
  await expect(page.locator("#approval")).toContainText("modified CHANGELOG.md");
  await approve(page, "Approve this promotion");
  await expect(page.locator(".proposal-promoted")).toContainText("Promoted as");
  await expect(page.locator(".proposal", { hasText: "Translate the README" })).toContainText("Ready to promote");

  // The graph is reachable from the keyboard, and a mark opens its commit.
  await page.locator(".graph .node").first().focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#commit")).toContainText("Root of trust", { timeout: 30_000 });
  await expect(page.locator("#commit")).toContainText("Signed by a passkey, as an SSH signature");
  await page.locator("#commit-close").click();
  await page.locator(".graph .node").nth(1).click();
  await expect(page.locator("#commit")).toContainText("Approved by a passkey", { timeout: 30_000 });
  await page.locator("#commit-close").click();

  await page.getByRole("button", { name: "Verify from a fresh clone" }).click();
  await expect(page.locator(".fresh")).toContainText("All 5 commits verify", { timeout: 30_000 });

  // Outside the forge: git clones over HTTP with a read token, and two other programs check the clone.
  await page.getByRole("button", { name: "Show the commands" }).click();
  await expect(page.locator(".commands pre")).toHaveCount(4);
  const commands = await page.locator(".commands pre").allTextContents();
  // Locally: the read-only Git endpoint with the token as password. Deployed: Artifacts with a Bearer header.
  expect(commands[0]).toMatch(/^git (clone http:\/\/x:[^@]+@[^ ]+\/forge\/git\/[a-z0-9-]+\.git|-c http\.extraHeader="Authorization: Bearer [^"]+" clone https:\/\/\S+\.git) [a-z0-9-]+$/);
  const work = mkdtempSync(join(tmpdir(), "forge-e2e-"));
  execFileSync("sh", ["-c", commands[0]!], { cwd: work, stdio: "pipe" });
  const dir = join(work, commands[0]!.split(" ").at(-1)!);
  // The verifier as one file, checked against the pinned digest, in a folder with nothing else in it.
  execFileSync("sh", ["-c", commands[1]!], { cwd: work, stdio: "pipe" });
  const repoId = /--repo ([0-9a-f]{40})/.exec(commands[2]!)![1]!;
  const verified = execFileSync("sh", ["-c", commands[2]!], { cwd: work }).toString();
  expect(verified).toContain(`Repository id: ${repoId}`);
  expect(verified).toMatch(/✓ All 5 commits verify/);
  // In UTC: during daylight saving time, git on macOS hands ssh-keygen a verify time an hour late, so a key
  // that expires within the hour reads as expired.
  const utc = { ...process.env, TZ: "UTC" };
  const log = execFileSync(
    "git",
    ["-C", dir, "-c", "gpg.ssh.allowedSignersFile=.repo/config/verification/allowed_commit_signers", "log", "--show-signature", "--format=%h %s"],
    { stdio: ["ignore", "pipe", "pipe"], env: utc },
  ).toString();
  expect(log).toContain('Good "git" signature for ada');
  // Stock git checks the inception commit, the passkey's own SSH signature, with the repository's allowed signers.
  const rootCheck = execFileSync(
    "git",
    ["-C", dir, "-c", "gpg.ssh.allowedSignersFile=.repo/config/verification/allowed_commit_signers", "log", "-1", "--format=%G? %GS", repoId],
    { env: utc },
  ).toString();
  expect(rootCheck.trim()).toBe(`G ${memberName}`);
});

test("the story plays from a new project to the commands, stopping only for approvals", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await addAuthenticator(page);
  await page.goto("/");
  await register(page);
  const started = Date.now();
  await page.getByRole("button", { name: "Play the story" }).click();
  const story = page.locator("#story");
  await approve(page, "Sign the inception commit");
  await approve(page, "Approve the first policy");
  await expect(story).toContainText("Step 2 of 9", { timeout: 30_000 });
  await approve(page, "Approve the new rules");
  await expect(story).toContainText("a key can never authorize itself", { timeout: 90_000 });
  await approve(page, "Approve this promotion");
  await expect(story).toContainText("The end", { timeout: 90_000 });
  expect(Date.now() - started).toBeLessThan(180_000);
  await expect(page.locator(".commands pre")).toHaveCount(4);
  await expect(page.locator(".fresh")).toContainText("verify");

  // At phone width the page does not scroll sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBe(0);
});
