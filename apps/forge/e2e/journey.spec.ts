// The designed page in a real browser. A passkey from the virtual
// authenticator of Chromium registers, signs in and approves each change on
// the approval sheet. The first test does the journey by hand. Then git clones
// the repository over HTTP, and forge-verify and git check the clone on disk.
// The second test plays the story to its end. The third test leaves the story
// while it plays, and the story waits until the person returns. The last test
// tries to sign in with no passkey, registers, and then signs in with the new
// passkey.

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
  await page.locator("#hero-register").click();
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
 * Locally, delay the answers of the forge, as the network to a deployed forge
 * does. A click that occurs while an action ends, or while a project loads,
 * must wait for its button. The click must not disappear.
 */
async function slowNetwork(page: Page) {
  if (process.env.FORGE_URL) return;
  await page.route(/\/forge\/(me|projects\/[0-9a-f-]{36}(\/stream)?)$/, async (route) => {
    await new Promise((r) => setTimeout(r, 800));
    await route.continue();
  });
}

/** On a deployed forge, delete the project that the test made, so that no repositories stay in Artifacts. */
test.afterEach(async ({ page }) => {
  if (!process.env.FORGE_URL || !/^#\/p\//.test(new URL(page.url()).hash)) return;
  await page.getByRole("button", { name: "Delete this project" }).click();
  await page.locator("#ask").getByRole("button", { name: "Delete the project" }).click();
  await expect(page.locator("#status")).toContainText("The project is deleted.", { timeout: 60_000 });
});

test("a person creates a project, agents propose, the rogue key is rejected, and a clone verifies outside the forge", async ({ page }) => {
  await addAuthenticator(page);
  await slowNetwork(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agents may write. Only a person may promote." })).toBeVisible();
  const memberName = await register(page);
  await expect(page.locator("#promoter-key-line")).toHaveText(/Promoter key [a-z]{4}-[a-z]{4}-[a-z]{4}/);

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

  // R2 rejects the rogue task.
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

  // The keyboard can reach the graph, and a node opens its commit.
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
  // The verifier as one file in an empty folder. The command checks the file against the pinned digest.
  execFileSync("sh", ["-c", commands[1]!], { cwd: work, stdio: "pipe" });
  const repoId = /--repo ([0-9a-f]{40})/.exec(commands[2]!)![1]!;
  const verified = execFileSync("sh", ["-c", commands[2]!], { cwd: work }).toString();
  expect(verified).toContain(`Repository id: ${repoId}`);
  expect(verified).toMatch(/✓ All 5 commits verify/);
  // Use UTC. During daylight saving time, git on macOS gives ssh-keygen a verify time that is one hour late.
  // Then a key that expires in less than one hour shows as expired.
  const utc = { ...process.env, TZ: "UTC" };
  const log = execFileSync(
    "git",
    ["-C", dir, "-c", "gpg.ssh.allowedSignersFile=.repo/config/verification/allowed_commit_signers", "log", "--show-signature", "--format=%h %s"],
    { stdio: ["ignore", "pipe", "pipe"], env: utc },
  ).toString();
  expect(log).toContain('Good "git" signature for ada');
  // Stock git uses the allowed signers of the repository to check the SSH signature of the passkey on the inception commit.
  const rootCheck = execFileSync(
    "git",
    ["-C", dir, "-c", "gpg.ssh.allowedSignersFile=.repo/config/verification/allowed_commit_signers", "log", "-1", "--format=%G? %GS", repoId],
    { env: utc },
  ).toString();
  expect(rootCheck.trim()).toBe(`G ${memberName}`);
  // Stock git accepts the signature of each commit of main: the root and each change that the passkey approved.
  const mainChecks = execFileSync(
    "git",
    ["-C", dir, "-c", "gpg.ssh.allowedSignersFile=.repo/config/verification/allowed_commit_signers", "log", "--first-parent", "--format=%G?"],
    { env: utc },
  ).toString().trim().split("\n");
  expect(mainChecks).toEqual(["G", "G", "G", "G"]);

  // Delete asks first, in a sheet of the page. Cancel keeps the project.
  if (process.env.FORGE_URL) return;
  const ask = page.locator("#ask");
  await page.getByRole("button", { name: "Delete this project" }).click();
  await expect(ask).toContainText("Its repositories, its forks and its agents go too.");
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(ask).toBeHidden();
  await expect(page.locator("#stage")).toBeVisible();
  await page.getByRole("button", { name: "Delete this project" }).click();
  await ask.getByRole("button", { name: "Delete the project" }).click();
  await expect(page.locator("#status")).toContainText("The project is deleted.", { timeout: 60_000 });
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

test("the story holds while the person is away from it, and shows its place again on return", async ({ page }) => {
  test.setTimeout(240_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await addAuthenticator(page);
  await page.goto("/");
  await register(page);
  await page.getByRole("button", { name: "Play the story" }).click();
  const story = page.locator("#story");
  await approve(page, "Sign the inception commit");
  await approve(page, "Approve the first policy");
  await approve(page, "Approve the new rules");
  await expect(story).toContainText("Step 3 of 9", { timeout: 30_000 });

  // A click on the wordmark shows the start view without a reload. The ribbon stays, and the story waits.
  await page.locator(".wordmark").click();
  await expect(page.locator("#start")).toBeVisible();
  await expect(story).toContainText("The story waits in its project");
  await page.waitForTimeout(6000);
  await expect(story).toContainText("Step 3 of 9");

  // When the person returns to the project, the story shows its place and moves the focus to that region.
  await story.getByRole("button", { name: "Go back to the story" }).click();
  await expect(page.locator("#stage")).toBeVisible();
  await expect(story).not.toContainText("The story waits in its project");
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toMatch(/^(agents|proposals)$/);

  // An open commit sheet also makes the story wait.
  await expect(story).toContainText("a key can never authorize itself", { timeout: 90_000 });
  await page.locator("#proposals .link-hash").first().click();
  await expect(page.locator("#commit")).toBeVisible();
  await page.waitForTimeout(8000);
  await expect(story).toContainText("a key can never authorize itself");
  await expect(page.locator("#approval")).toBeHidden();
  await page.locator("#commit-close").click();

  await approve(page, "Approve this promotion");
  await expect(story).toContainText("The end", { timeout: 90_000 });
});

test("sign in asks for a passkey at once, and the pane opens only to try again, recover or register", async ({ page }) => {
  await addAuthenticator(page);
  await page.goto("/");
  const pane = page.locator("#sign-in");

  // No passkey is here yet. The pane offers a new try or a recovery, and it shows a Register button.
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(pane).toBeVisible();
  await expect(pane).toContainText("No passkey was used");
  await expect(pane.getByRole("button", { name: "Continue with passkey" })).toBeVisible();
  await expect(pane.getByRole("button", { name: "Recover with a new passkey" })).toBeVisible();
  await expect(pane.getByRole("button", { name: "Register with a passkey" })).toBeHidden();

  // Register shows only the register form.
  await pane.getByRole("button", { name: "Register", exact: true }).click();
  await expect(pane.getByRole("heading", { name: "Register" })).toBeVisible();
  await expect(pane.getByRole("button", { name: "Continue with passkey" })).toBeHidden();
  const memberName = `Leo${Date.now().toString(36)}`;
  await page.locator("#register-name").fill(memberName);
  await pane.getByRole("button", { name: "Register with a passkey" }).click();
  await page.getByRole("checkbox", { name: "I have saved my recovery codes" }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.locator("#member-name")).toHaveText(memberName);

  // With a passkey here, sign in completes at once, and the pane does not open.
  await page.locator("#account-button").click();
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeVisible();
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.locator("#member-name")).toHaveText(memberName);
  await expect(pane).toBeHidden();
});
