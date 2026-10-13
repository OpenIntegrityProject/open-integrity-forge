// An automated accessibility audit with axe, against WCAG 2.1 A and AA, of
// each view: signed out, the start, the stage with agents and a rejection, the
// approval sheet, the commit sheet, in light and dark. A screen reader
// run-through by a person is still needed; axe finds only what code can.

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

test.skip(Boolean(process.env.FORGE_URL), "the audit runs locally; it makes projects it does not delete");

async function audit(page: Page, view: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const found = results.violations.map((v) => `${view}: ${v.id} (${v.impact}) ${v.help}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 4).join(", ")}`);
  expect(found, found.join("\n")).toEqual([]);
}

for (const scheme of ["light", "dark"] as const) {
  test(`every view passes axe in ${scheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await audit(page, "signed out");

    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await page.getByRole("button", { name: "Continue with passkey" }).click();
    await page.locator("#register-name").fill(`Axe${Date.now().toString(36)}`);
    await page.getByRole("button", { name: "Register with a passkey" }).click();
    await page.getByRole("checkbox", { name: "I have saved my recovery codes" }).check();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Start a project" })).toBeVisible();
    await page.waitForTimeout(7000); // the toast has gone
    await audit(page, "start");

    await page.getByRole("button", { name: "Create with passkey" }).click();
    await expect(page.locator("#approval")).toContainText("Sign the inception commit");
    await audit(page, "signing sheet");
    await page.locator("#approval").getByRole("button", { name: "Approve with passkey" }).click();
    await expect(page.locator("#approval")).toContainText("Main is now at");
    await audit(page, "inception signed");
    await page.locator("#approval").getByRole("button", { name: "Done" }).click();
    await expect(page.locator("#approval")).toContainText("Approve the first policy", { timeout: 30_000 });
    await audit(page, "approval sheet");
    await page.locator("#approval").getByRole("button", { name: "Approve with passkey" }).click();
    await expect(page.locator("#approval")).toContainText("Main is now at");
    await audit(page, "approval signed");
    await page.locator("#approval").getByRole("button", { name: "Done" }).click();

    await page.getByRole("button", { name: "Admit Ada and Bo" }).click();
    await page.locator("#approval").getByRole("button", { name: "Approve with passkey" }).click();
    await page.locator("#approval").getByRole("button", { name: "Done" }).click();
    await expect(page.locator(".proposal-ready")).toHaveCount(2, { timeout: 60_000 });
    await page.getByRole("button", { name: /make its own key a promoter/ }).click();
    await expect(page.locator(".proposal-rejected")).toHaveCount(1, { timeout: 60_000 });
    await page.locator(".proposal-rejected .why > summary").click();
    await page.getByRole("button", { name: "Verify from a fresh clone" }).click();
    await expect(page.locator(".fresh")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Show the commands" }).click();
    await expect(page.locator(".commands")).toBeVisible();
    await page.waitForTimeout(7000);
    await audit(page, "stage");

    await page.locator(".graph .node").nth(1).click();
    await expect(page.locator("#commit")).toContainText("Approved by a passkey", { timeout: 30_000 });
    await audit(page, "commit sheet");
  });
}
