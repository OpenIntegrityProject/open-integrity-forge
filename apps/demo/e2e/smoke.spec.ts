import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { OPERATORS } from "./operators.ts";

const CAPITAL_NUDGE = "Member names display as typed, and most read best with a capital letter.";
const DEVICE_BOUND_NOTICE =
  "Each of your passkeys is held on one device and can't be copied to another. " +
  "If you lose that device, only a recovery code gets you back in. " +
  "Add a passkey on another device or a security key, and keep your recovery codes somewhere safe.";
const NO_PASSKEY_USED =
  "No passkey was used. To use a passkey from a password manager, a phone or a security key, continue again. If you do not have a passkey here yet, register; if you lost yours, recover.";

/**
 * Give the page a virtual authenticator; returns what reaches it over CDP.
 * Its passkeys are device-bound (BE=0) unless `synced`, as a password manager's would be.
 */
async function addAuthenticator(page: Page, { synced = false } = {}) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      defaultBackupEligibility: synced,
      defaultBackupState: synced,
    },
  });
  return { cdp, authenticatorId };
}

type Authenticator = Awaited<ReturnType<typeof addAuthenticator>>;

/** Put every passkey `from` holds on `to`, replacing `to`'s copies. */
async function copyCredentials(from: Authenticator, to: Authenticator) {
  const { credentials } = await from.cdp.send("WebAuthn.getCredentials", { authenticatorId: from.authenticatorId });
  const held = await to.cdp.send("WebAuthn.getCredentials", { authenticatorId: to.authenticatorId });
  for (const credential of credentials) {
    if (held.credentials.some((c) => c.credentialId === credential.credentialId)) {
      await to.cdp.send("WebAuthn.removeCredential", {
        authenticatorId: to.authenticatorId,
        credentialId: credential.credentialId,
      });
    }
    await to.cdp.send("WebAuthn.addCredential", { authenticatorId: to.authenticatorId, credential });
  }
}

/** Open the sign-in pane from the app bar. */
async function openSignIn(page: Page) {
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("#sign-in")).toBeVisible();
}

/** The app bar names the member once they are signed in, and the sign-in pane has closed. */
async function expectSignedIn(page: Page, memberName: string) {
  await expect(page.locator("#sign-in")).toBeHidden();
  await expect(page.locator("#member-name")).toHaveText(memberName);
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  await expect(page.locator("#open-sign-in")).toHaveCount(1);
  await expect(page.locator("#open-sign-in")).toBeHidden();
}

/** Open the settings pane from the app bar. */
async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.locator("#settings")).toBeVisible();
}

/** Log out from the app bar, closing settings first if it is open over the app. */
async function logOut(page: Page) {
  const settings = page.locator("#settings");
  if (await settings.isVisible()) await settings.getByRole("button", { name: "Close" }).click();
  await page.locator("header.app-bar").getByRole("button", { name: "Log out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Settings" })).toBeHidden();
}

/** Open settings' Account details, where the sessions and the log-out-all buttons are, unless it is open. */
async function openAccountDetails(page: Page) {
  const details = page.locator("#account-details");
  if ((await details.getAttribute("open")) === null) await page.getByText("Account details").click();
  await expect(details).toHaveAttribute("open");
}

/** Register a new member from the sign-in pane and leave the recovery codes. */
async function registerMember(page: Page, memberName: string) {
  await page.goto("/");
  await openSignIn(page);
  await page.getByRole("button", { name: "Continue with passkey" }).click();
  await page.locator("#register-name").fill(memberName);
  await page.getByRole("button", { name: "Register with a passkey" }).click();
  await page.getByRole("checkbox", { name: "I have saved my recovery codes" }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expectSignedIn(page, memberName);
}

test("the app opens signed out, with sign-in in a pane it can close", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Sign in to try passkeys.")).toBeVisible();
  await expect(page.locator("#sign-in")).toBeHidden();
  await expect(page.getByRole("button", { name: "Settings" })).toBeHidden();

  await openSignIn(page);
  await expect(page.getByRole("button", { name: "Continue with passkey" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#sign-in")).toBeHidden();
  await openSignIn(page);
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.locator("#sign-in")).toBeHidden();
});

test("without immediate mode, the sign-in pane opens on the member-name field", async ({ page }) => {
  await page.addInitScript(() => {
    PublicKeyCredential.getClientCapabilities = async () => ({ immediateGet: false, conditionalGet: true });
  });
  await page.goto("/");
  await openSignIn(page);
  // Autofill offers a passkey only in a focused field, so the pane starts there.
  await expect(page.locator("#register-name")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#sign-in")).toBeHidden();
});

test("with immediate mode, the sign-in pane opens on Continue with the choices hidden", async ({ page }) => {
  await page.addInitScript(() => {
    PublicKeyCredential.getClientCapabilities = async () => ({ immediateGet: true, conditionalGet: true });
  });
  await page.goto("/");
  await openSignIn(page);
  await expect(page.getByRole("button", { name: "Continue with passkey" })).toBeFocused();
  await expect(page.locator("#choices")).toHaveCount(1);
  await expect(page.locator("#choices")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.locator("#sign-in")).toBeHidden();
});

test("with immediate mode, Continue asks through the browser's sheet once it has used no passkey", async ({ page }) => {
  // Chrome's immediate request sees only the passkeys Chrome holds; one in another
  // password manager is found only through the sheet.
  await page.addInitScript(() => {
    const asked: string[] = [];
    (window as unknown as { asked: string[] }).asked = asked;
    PublicKeyCredential.getClientCapabilities = async () => ({ immediateGet: true, conditionalGet: true });
    navigator.credentials.get = async (options) => {
      const spelled = options as { mediation?: string; uiMode?: string };
      if (spelled.mediation === "conditional") return new Promise(() => {});
      asked.push(spelled.mediation === "immediate" || spelled.uiMode === "immediate" ? "immediate" : "sheet");
      throw new DOMException("No passkey.", "NotAllowedError");
    };
  });
  await page.goto("/");
  await openSignIn(page);

  await page.getByRole("button", { name: "Continue with passkey" }).click();
  await expect(page.getByText(NO_PASSKEY_USED)).toBeVisible();
  await page.getByRole("button", { name: "Continue with passkey" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { asked: string[] }).asked)).toEqual([
    "immediate",
    "sheet",
  ]);
});

test("register, log out and log back in with a passkey", async ({ page }) => {
  await addAuthenticator(page);
  const memberName = `Smoke${Date.now().toString(36)}`;

  const logins: number[] = [];
  const registrations: string[] = [];
  page.on("response", (r) => {
    if (r.url().endsWith("/auth/login/verify")) logins.push(r.status());
  });
  page.on("request", (r) => {
    if (r.url().includes("/auth/register")) registrations.push(r.url());
  });
  await page.goto("/");
  await openSignIn(page);
  await expect(page.getByRole("button", { name: "Continue with passkey" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "New here? Register" })).toBeHidden();

  // Immediate mode: a browser with no passkey here answers at once, with no sheet to cancel.
  // The same rejection covers a dismissed picker, so the message claims only that none was used.
  await page.getByRole("button", { name: "Continue with passkey" }).click();
  await expect(page.getByText(NO_PASSKEY_USED)).toBeVisible();
  await expect(page.getByRole("heading", { name: "New here? Register" })).toBeVisible();
  expect(registrations).toEqual([]);

  await page.locator("#register-name").fill(memberName);
  await page.getByRole("button", { name: "Register with a passkey" }).click();
  await expect(page.locator("#code-list li")).toHaveCount(8);
  const header = `Recovery codes for localhost\nMember name: ${memberName}\nIssued: `;
  const issued = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/;
  const headerText = (await page.locator("#codes-header").textContent())!;
  expect(headerText.startsWith(header)).toBe(true);
  expect(headerText.slice(header.length)).toMatch(issued);
  // Copy takes the codes as text to keep, in the form shown: the UR by default.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await expect(page.getByRole("radio", { name: "Code" })).toBeChecked();
  await page.getByRole("button", { name: "Copy" }).click();
  await expect(page.locator("#codes-status")).toHaveText("Copied your recovery codes.");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const codes = copied.split("\n").filter((line) => /^\d+\. /.test(line));
  expect(copied.startsWith(`${headerText}\n\n`)).toBe(true);
  expect(codes).toHaveLength(8);
  for (const line of codes) expect(line).toMatch(/^\d\. ur:seed\/[a-z]{46}$/);
  expect(copied).toContain("Each code works once. Recover at localhost with your member name and one code.");
  // The codes are shown once, so leaving them takes a deliberate tick first.
  const saved = page.getByRole("checkbox", { name: "I have saved my recovery codes" });
  const done = page.getByRole("button", { name: "Continue", exact: true });
  await expect(done).toBeDisabled();
  await saved.check();
  await expect(done).toBeEnabled();
  await saved.uncheck();
  await expect(done).toBeDisabled();
  // Esc does not leave codes that are shown once.
  await page.keyboard.press("Escape");
  await expect(page.locator("#codes")).toBeVisible();
  await saved.check();
  await done.click();
  await expect(page.locator("#codes")).toBeHidden();
  await expectSignedIn(page, memberName);

  // Log out sits in the app bar, one click from the app, with no settings to open.
  await expect(page.locator("#settings")).toBeHidden();
  await logOut(page);
  await expect(page.locator("#app-signed-out")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await openSignIn(page);
  await expect(page.getByRole("button", { name: "Continue with passkey" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "New here? Register" })).toBeHidden();

  await page.getByRole("button", { name: "Continue with passkey" }).click();
  await expectSignedIn(page, memberName);
  expect(logins).toEqual([200]);
});

test("without immediate mode, register and recover show from the start", async ({ page }) => {
  await page.addInitScript(() => {
    PublicKeyCredential.getClientCapabilities = async () => ({ immediateGet: false });
  });
  await addAuthenticator(page);

  const registrations: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/auth/register")) registrations.push(r.url());
  });
  await page.goto("/");
  await openSignIn(page);
  await expect(page.getByRole("button", { name: "Continue with passkey" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "New here? Register" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Lost your passkeys? Recover" })).toBeVisible();

  // Continue with no passkey here still ends at the choices, and never registers anyone.
  await page.getByRole("button", { name: "Continue with passkey" }).click();
  await expect(page.getByText(NO_PASSKEY_USED)).toBeVisible();
  expect(registrations).toEqual([]);
});

/**
 * From the page's next load, report `capabilities` and record each WebAuthn
 * request in `webAuthnOn`'s list: `conditional` for an autofill request, held
 * open until its signal aborts it (`aborted`), and `get` or `create` for any
 * other, which reaches the browser. Also counts capability checks, and records
 * the list's length at each focus on the member-name field (`nameFocuses`).
 */
async function recordWebAuthn(page: Page, capabilities: Record<string, boolean>) {
  await page.addInitScript((capabilities) => {
    const recorded = { log: [] as string[], capabilityChecks: 0, nameFocuses: [] as number[] };
    (window as unknown as { webAuthn: typeof recorded }).webAuthn = recorded;
    document.addEventListener("focusin", (event) => {
      if ((event.target as Element).id === "register-name") recorded.nameFocuses.push(recorded.log.length);
    });
    PublicKeyCredential.getClientCapabilities = async () => {
      recorded.capabilityChecks++;
      return capabilities;
    };
    const { credentials } = navigator;
    const get = credentials.get.bind(credentials);
    const create = credentials.create.bind(credentials);
    credentials.get = (options) => {
      if (options?.mediation !== "conditional") {
        recorded.log.push("get");
        return get(options);
      }
      recorded.log.push("conditional");
      return new Promise((_, reject) => {
        options.signal?.addEventListener("abort", () => {
          recorded.log.push("aborted");
          reject(options.signal!.reason);
        });
      });
    };
    credentials.create = (options) => {
      recorded.log.push("create");
      return create(options);
    };
  }, capabilities);
}

const webAuthnOn = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { webAuthn: { log: string[]; capabilityChecks: number; nameFocuses: number[] } }).webAuthn,
  );

/** Count the page's login options requests. */
function countLoginOptions(page: Page) {
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/auth/login/options")) requests.push(r.url());
  });
  return requests;
}

test("without immediate mode, the sign-in pane offers passkeys in the member-name autofill", async ({ page }) => {
  await recordWebAuthn(page, { immediateGet: false, conditionalGet: true });
  await addAuthenticator(page);
  const loginOptions = countLoginOptions(page);
  await page.goto("/");
  await expect(page.getByText("Sign in to try passkeys.")).toBeVisible();
  expect((await webAuthnOn(page)).log).toEqual([]);
  expect(loginOptions).toHaveLength(0);

  await openSignIn(page);
  await expect.poll(async () => (await webAuthnOn(page)).log).toEqual(["conditional"]);
  expect(loginOptions).toHaveLength(1);
  await expect(page.locator("#register-name")).toHaveAttribute("autocomplete", /\bwebauthn\b/);
  // Safari offers the passkey only to a focus that comes once the request waits.
  await expect.poll(async () => (await webAuthnOn(page)).nameFocuses.at(-1)).toBe(1);
  await expect(page.locator("#register-name")).toBeFocused();

  // Continue aborts the autofill request before it asks for a passkey itself.
  await page.getByRole("button", { name: "Continue with passkey" }).click();
  await expect(page.getByText(NO_PASSKEY_USED)).toBeVisible();
  expect((await webAuthnOn(page)).log).toEqual(["conditional", "aborted", "get"]);
  expect(loginOptions).toHaveLength(2);

  // Closing the pane aborts the request that opening it starts again.
  await page.getByRole("button", { name: "Close" }).click();
  await openSignIn(page);
  await expect.poll(async () => (await webAuthnOn(page)).log).toEqual(["conditional", "aborted", "get", "conditional"]);
  await page.getByRole("button", { name: "Close" }).click();
  await expect
    .poll(async () => (await webAuthnOn(page)).log)
    .toEqual(["conditional", "aborted", "get", "conditional", "aborted"]);
});

test("with immediate mode, the sign-in pane asks for no passkey until Continue", async ({ page }) => {
  await recordWebAuthn(page, { immediateGet: true, conditionalGet: true });
  const loginOptions = countLoginOptions(page);
  await page.goto("/");
  await expect(page.getByText("Sign in to try passkeys.")).toBeVisible();

  await openSignIn(page);
  // Opening checks the capabilities twice, for the choices and for autofill; the second decides.
  await expect.poll(async () => (await webAuthnOn(page)).capabilityChecks).toBe(2);
  expect((await webAuthnOn(page)).log).toEqual([]);
  expect(loginOptions).toHaveLength(0);
  await expect(page.locator("#register-name")).toHaveAttribute("autocomplete", "username");
});

/**
 * Let the test hold the page's passkey requests, other than autofill, as a
 * password manager's in-page picker holds them until the person picks:
 * `holdPasskeys` holds every later request, `releasePasskeys` lets them
 * through, and `passkeyRequests` counts them.
 */
async function gatePasskeys(page: Page) {
  await page.addInitScript(() => {
    let gate = Promise.resolve();
    const control = {
      requests: 0,
      release: () => {},
      hold() {
        gate = new Promise((resolve) => (control.release = resolve));
      },
    };
    (window as unknown as { passkeyGate: typeof control }).passkeyGate = control;
    const { credentials } = navigator;
    const get = credentials.get.bind(credentials);
    const create = credentials.create.bind(credentials);
    credentials.get = async (options) => {
      if (options?.mediation === "conditional") return get(options);
      control.requests++;
      await gate;
      return get(options);
    };
    credentials.create = async (options) => {
      control.requests++;
      await gate;
      return create(options);
    };
  });
}

type PasskeyGate = { requests: number; release: () => void; hold: () => void };
type Gated = { passkeyGate: PasskeyGate };
const holdPasskeys = (page: Page) => page.evaluate(() => (window as unknown as Gated).passkeyGate.hold());
const releasePasskeys = (page: Page) => page.evaluate(() => (window as unknown as Gated).passkeyGate.release());
const passkeyRequests = (page: Page) => page.evaluate(() => (window as unknown as Gated).passkeyGate.requests);

/**
 * Draw a button over the page, outside every pane, as a password manager draws
 * its passkey picker; it counts its clicks.
 */
async function addInPagePicker(page: Page) {
  await page.evaluate(() => {
    const picker = document.createElement("button");
    picker.id = "in-page-picker";
    picker.type = "button";
    picker.textContent = "Log in with a passkey";
    picker.dataset.clicks = "0";
    picker.style.cssText = "position: fixed; top: 0; left: 0; z-index: 2147483647";
    picker.addEventListener("click", () => (picker.dataset.clicks = String(Number(picker.dataset.clicks) + 1)));
    document.body.append(picker);
  });
  return page.locator("#in-page-picker");
}

const isModal = (page: Page, id: string) => page.locator(`#${id}`).evaluate((pane) => pane.matches(":modal"));

test("a picker drawn in the page takes clicks while Continue waits on it, and Continue starts no second login", async ({
  page,
}) => {
  await gatePasskeys(page);
  await addAuthenticator(page);
  const memberName = `Picker${Date.now().toString(36)}`;
  await registerMember(page, memberName);
  await logOut(page);
  const loginOptions = countLoginOptions(page);
  const picker = await addInPagePicker(page);

  await openSignIn(page);
  await holdPasskeys(page);
  const before = await passkeyRequests(page);
  await page.getByRole("button", { name: "Continue with passkey" }).click();
  await expect.poll(() => passkeyRequests(page)).toBeGreaterThan(before);
  await picker.click();
  await expect(picker).toHaveAttribute("data-clicks", "1");
  await page.getByRole("button", { name: "Continue with passkey" }).click();
  await releasePasskeys(page);

  await expectSignedIn(page, memberName);
  expect(loginOptions).toHaveLength(1);
  await expect(page.locator("#status")).toHaveText("");
});

test("a picker drawn in the page takes clicks while adding a passkey waits, and no other add starts", async ({
  page,
}) => {
  await gatePasskeys(page);
  await addAuthenticator(page);
  const options = postsTo(page, "/me/credentials/enrol/options");
  await registerMember(page, `PickerAdd${Date.now().toString(36)}`);
  await openSettings(page);
  const picker = await addInPagePicker(page);

  await holdPasskeys(page);
  const before = await passkeyRequests(page);
  const group = page.getByRole("group", { name: "Add a passkey on:" });
  // A step-up first, as nothing has stepped up yet: a request from settings all the same.
  await group.getByRole("button", { name: "This device" }).click();
  await expect.poll(() => passkeyRequests(page)).toBeGreaterThan(before);
  await picker.click();
  await expect(picker).toHaveAttribute("data-clicks", "1");
  await group.getByRole("button", { name: "Another device" }).click();
  await group.getByRole("button", { name: "Security key" }).click();
  await releasePasskeys(page);

  // The authenticator holds the record's passkey, so the one enrolment says so.
  await expect(page.locator("#settings-status")).toHaveText(
    "This device already has a passkey for you. Use it to log in, or add one on another device.",
  );
  expect(options).toEqual([{ hint: "client-device" }]);
  // Once the request ends, the pane is modal again, with focus back on the button: Escape closes it.
  expect(await isModal(page, "settings")).toBe(true);
  await expect(group.getByRole("button", { name: "This device" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#settings")).toBeHidden();
});

test("a login refused after another signed in leaves the signed-in page without a refusal", async ({ page }) => {
  // A password manager that answers every pending request with the passkey picked for one, autofill included,
  // although Continue aborted it.
  await page.addInitScript(() => {
    PublicKeyCredential.getClientCapabilities = async () => ({ immediateGet: false, conditionalGet: true });
    const { credentials } = navigator;
    const get = credentials.get.bind(credentials);
    const waiting: ((credential: Credential | null) => void)[] = [];
    let picked: Credential | null = null;
    credentials.get = async (options) => {
      if (options?.mediation === "conditional") return new Promise((resolve) => waiting.push(resolve));
      picked = await get(options);
      return picked;
    };
    (window as unknown as { answerLate: () => void }).answerLate = () => {
      for (const answer of waiting.splice(0)) answer(picked);
    };
  });
  await addAuthenticator(page);
  const memberName = `Late${Date.now().toString(36)}`;
  await registerMember(page, memberName);
  await logOut(page);

  await openSignIn(page);
  await expect(page.locator("#register-name")).toHaveAttribute("autocomplete", /\bwebauthn\b/);
  await page.getByRole("button", { name: "Continue with passkey" }).click();
  await expectSignedIn(page, memberName);

  const refused = page.waitForResponse((r) => r.url().endsWith("/auth/login/verify") && r.status() === 400);
  await page.evaluate(() => (window as unknown as { answerLate: () => void }).answerLate());
  await refused;
  // The page handles the refusal after its response arrives.
  await page.waitForTimeout(250);
  await expect(page.locator("#status")).toHaveText("");
  await expect(page.getByText("You're signed in with a passkey.")).toBeVisible();
});

test("the register form checks names by the library's rules and explains them", async ({ page }) => {
  await page.addInitScript(() => {
    PublicKeyCredential.getClientCapabilities = async () => ({ immediateGet: false });
  });
  await page.goto("/");
  await openSignIn(page);
  const name = page.locator("#register-name");
  const rules = page.getByText("A member name is 3 to 32 characters long and starts with a letter.", { exact: false });

  await expect(rules).toBeHidden();
  await page.getByRole("button", { name: "About member names" }).click();
  await expect(rules).toBeVisible();

  await name.fill("a.bc");
  expect(await name.evaluate((el: HTMLInputElement) => el.validity.patternMismatch)).toBe(true);

  // Typed decomposed, the name is composed in place and checked as available.
  const accented = `Zoë${Date.now().toString(36)}`;
  await name.fill(accented.normalize("NFD"));
  await expect(name).toHaveValue(accented.normalize("NFC"));
  expect(await name.evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(true);
  await expect(page.locator("#name-availability")).toHaveText("Available");
});

test("an all-lowercase name is nudged toward a capital once before it registers", async ({ page }) => {
  await addAuthenticator(page);
  const registrations: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/auth/register")) registrations.push(r.url());
  });
  await page.goto("/");
  await openSignIn(page);
  await page.getByRole("button", { name: "Continue with passkey" }).click();
  const name = page.locator("#register-name");
  const register = page.getByRole("button", { name: "Register with a passkey" });
  const nudge = page.getByText(CAPITAL_NUDGE);

  await name.fill(`nudge${Date.now().toString(36)}`);
  await register.click();
  await expect(nudge).toBeVisible();
  expect(registrations).toEqual([]);

  // Editing the name takes the nudge back; the next lowercase name is nudged afresh.
  const memberName = `nudged${Date.now().toString(36)}`;
  await name.fill(memberName);
  await expect(nudge).toBeHidden();
  await register.click();
  await expect(nudge).toBeVisible();
  expect(registrations).toEqual([]);

  await register.click();
  await expect(page.locator("#code-list li")).toHaveCount(8);
  await page.getByRole("checkbox", { name: "I have saved my recovery codes" }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expectSignedIn(page, memberName);
});

test("recover on a new device with a recovery code, and be prompted to replace the rest", async ({ page, browser }) => {
  await addAuthenticator(page);
  const memberName = `Recover${Date.now().toString(36)}`;
  await page.goto("/");
  await openSignIn(page);
  await page.getByRole("button", { name: "Continue with passkey" }).click();
  await page.locator("#register-name").fill(memberName);
  await page.getByRole("button", { name: "Register with a passkey" }).click();
  await expect(page.locator("#code-list li")).toHaveCount(8);
  const firstCode = page.locator("#code-list li").first();
  const ur = (await firstCode.textContent())!;
  expect(ur).toMatch(/^ur:seed\//);
  // The words are the same code, read aloud or written down; recover with them.
  await page.locator("#codes-form label", { hasText: "Bytewords" }).click();
  await expect(firstCode).toHaveText(/^[a-z]{4}( [a-z]{4}){22}$/);
  await page.locator("#codes-form label", { hasText: "Code" }).click();
  await expect(firstCode).toHaveText(ur);
  await page.locator("#codes-form label", { hasText: "BIP39 words" }).click();
  await expect(page.getByRole("radio", { name: "BIP39 words" })).toBeChecked();
  await expect(firstCode).toHaveText(/^[a-z]+( [a-z]+){11}$/);
  const code = (await firstCode.textContent())!;
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await page.getByRole("checkbox", { name: "I have saved my recovery codes" }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expectSignedIn(page, memberName);
  await openSettings(page);
  await expect(page.locator("#rotate-prompt")).toBeHidden();
  await logOut(page);

  // A new device: no session and no passkey, only the member name and a code.
  const device = await (await browser.newContext()).newPage();
  await addAuthenticator(device);
  await device.goto("/");
  await openSignIn(device);
  await device.getByRole("button", { name: "Continue with passkey" }).click();
  await expect(device.getByText(NO_PASSKEY_USED)).toBeVisible();
  const recoverForm = device.locator("#recover-form");
  // Recovery takes any spelling of the name, and never nudges it toward a capital.
  await recoverForm.getByLabel("Member name").fill(memberName.toLowerCase());
  await recoverForm.getByLabel("Recovery code").fill(code);
  await recoverForm.getByRole("button", { name: "Recover with a new passkey" }).click();

  // Recovery ends in settings, with the prompt to replace the codes at the top.
  await expect(device.locator("#sign-in")).toBeHidden();
  await expect(device.locator("#settings")).toBeVisible();
  await expect(device.locator("#member-name")).toHaveText(memberName);
  await expect(device.locator("#rotate-prompt")).toBeVisible();
  await expect(device.locator("#rotate-prompt")).toContainText("you have 7 codes left");
  await expect(device.getByText(CAPITAL_NUDGE)).toHaveCount(0);
  await expect(device.locator("#rotate-prompt")).toContainText("Replace your remaining codes now");

  // Replacing them shows the new set over settings, then returns there without the prompt.
  device.on("dialog", (d) => void d.accept());
  await device.getByRole("button", { name: "Replace them now" }).click();
  await expect(device.locator("#codes")).toBeVisible();
  await expect(device.locator("#code-list li")).toHaveCount(8);
  await device.getByRole("checkbox", { name: "I have saved my recovery codes" }).check();
  await device.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(device.locator("#codes")).toBeHidden();
  await expect(device.locator("#settings")).toBeVisible();
  await expect(device.locator("#rotate-prompt")).toBeHidden();
  await device.context().close();
});

/**
 * Replace the page's `PublicKeyCredential.signalUnknownCredential` from its
 * next load: with a recorder whose calls `signalsOn` reads, or, when `present`
 * is false, with nothing, as in a browser without the Signals API.
 */
async function stubSignal(page: Page, present = true) {
  await page.addInitScript((present) => {
    const pkc = PublicKeyCredential as unknown as Record<string, unknown>;
    const signals: unknown[] = [];
    (window as unknown as { signals: unknown[] }).signals = signals;
    if (present) pkc.signalUnknownCredential = async (options: unknown) => void signals.push(options);
    else delete pkc.signalUnknownCredential;
  }, present);
}

const signalsOn = (page: Page) => page.evaluate(() => (window as unknown as { signals: unknown[] }).signals);

/**
 * Register a member on `page` with two passkeys, both held by `authenticator`,
 * and return them. The second is enrolled while the first is off the
 * authenticator, which enrolment would otherwise refuse as already registered;
 * a step-up first means the enrolment needs no passkey to use.
 */
async function registerWithTwoPasskeys(page: Page, authenticator: Authenticator, memberName: string) {
  const { cdp, authenticatorId } = authenticator;
  await registerMember(page, memberName);
  await openSettings(page);
  await openAccountDetails(page);
  await page.getByRole("button", { name: "Log out everywhere else" }).click();
  await expect(page.locator("#settings-status")).toHaveText("Logged out everywhere else.");
  const [first] = (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials;
  await cdp.send("WebAuthn.removeCredential", { authenticatorId, credentialId: first!.credentialId });
  await page.getByRole("button", { name: "This device" }).click();
  await expect(page.locator("#credential-rows tr")).toHaveCount(2);
  const [second] = (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials;
  await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: first! });
  return { first: first!, second: second! };
}

/** Revoke the record's oldest passkey from settings, accepting the confirm; returns the server's answer. */
async function revokeOldest(page: Page) {
  const answer = page.waitForResponse((r) => r.url().endsWith("/me/credentials/revoke") && r.status() === 200);
  page.once("dialog", (dialog) => void dialog.accept());
  await page.locator("#credential-rows tr").first().getByRole("button", { name: "Revoke" }).click();
  const revoked = (await (await answer).json()) as { credentialId: string; rpId: string };
  await expect(page.locator("#credential-rows tr")).toHaveCount(1);
  await expect(page.locator("#settings-status")).toHaveText(
    /^Revoked [a-z]{4}-[a-z]{4}-[a-z]{4}\. Delete '.+' from your password manager too; it no longer logs in\.$/,
  );
  return revoked;
}

/** A CDP credential's ID, as base64url. */
const base64url = (credentialId: string) => Buffer.from(credentialId, "base64").toString("base64url");

test("revoking a passkey signals it unknown to the password manager, and a refused login signals nothing", async ({
  page,
}) => {
  await stubSignal(page);
  const authenticator = await addAuthenticator(page);
  const { first, second } = await registerWithTwoPasskeys(page, authenticator, `Signal${Date.now().toString(36)}`);

  const revoked = await revokeOldest(page);

  const revokedId = base64url(first.credentialId);
  expect(revoked).toMatchObject({ credentialId: revokedId, rpId: "localhost" });
  expect(await signalsOn(page)).toEqual([{ rpId: "localhost", credentialId: revokedId }]);

  // The authenticator still offers the revoked passkey; its login is refused, and the refusal signals nothing.
  const { cdp, authenticatorId } = authenticator;
  await cdp.send("WebAuthn.removeCredential", { authenticatorId, credentialId: second.credentialId });
  await logOut(page);
  await openSignIn(page);
  await page.getByRole("button", { name: "Continue with passkey" }).click();
  await expect(page.getByText("That passkey was not accepted.")).toBeVisible();
  expect(await signalsOn(page)).toEqual([{ rpId: "localhost", credentialId: revokedId }]);
});

test("revoking a passkey in a browser without the Signals API still revokes it and says to delete it", async ({
  page,
}) => {
  await stubSignal(page, false);
  const authenticator = await addAuthenticator(page);
  await registerWithTwoPasskeys(page, authenticator, `NoSignal${Date.now().toString(36)}`);

  await revokeOldest(page);

  expect(await page.evaluate(() => "signalUnknownCredential" in PublicKeyCredential)).toBe(false);
});

test("adding a passkey on a device that already has one says so, and adds nothing", async ({ page }) => {
  await addAuthenticator(page);
  const memberName = `Twice${Date.now().toString(36)}`;
  const enrolments: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/me/credentials/enrol/verify")) enrolments.push(r.url());
  });
  await registerMember(page, memberName);
  await openSettings(page);
  await expect(page.locator("#credential-rows tr")).toHaveCount(1);

  // The same authenticator holds this record's passkey, which enrolment excludes.
  await page.getByRole("button", { name: "This device" }).click();
  await expect(page.locator("#settings-status")).toHaveText(
    "This device already has a passkey for you. Use it to log in, or add one on another device.",
  );
  expect(enrolments).toEqual([]);
  await expect(page.locator("#credential-rows tr")).toHaveCount(1);
});

test("each add-passkey button sends its hint and adds a passkey", async ({ page }) => {
  const { cdp, authenticatorId } = await addAuthenticator(page);
  const options = postsTo(page, "/me/credentials/enrol/options");
  await registerMember(page, `Hints${Date.now().toString(36)}`);
  await openSettings(page);
  // Steps up, so that no enrolment needs a passkey to use.
  await openAccountDetails(page);
  await page.getByRole("button", { name: "Log out everywhere else" }).click();
  await expect(page.locator("#settings-status")).toHaveText("Logged out everywhere else.");

  const buttons = [
    ["This device", "client-device"],
    ["Another device", "hybrid"],
    ["Security key", "security-key"],
  ] as const;
  for (const [index, [name]] of buttons.entries()) {
    // Take the record's passkeys off the authenticator, so enrolment does not exclude it.
    await cdp.send("WebAuthn.clearCredentials", { authenticatorId });
    await page.getByRole("group", { name: "Add a passkey on:" }).getByRole("button", { name }).click();
    await expect(page.locator("#credential-rows tr")).toHaveCount(index + 2);
  }
  expect(options).toEqual(buttons.map(([, hint]) => ({ hint })));
});

test("settings suggest another passkey while every passkey is device-bound", async ({ page }) => {
  const deviceBound = await addAuthenticator(page);
  await registerMember(page, `Bound${Date.now().toString(36)}`);
  await openSettings(page);
  const notice = page.locator("#device-bound-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toHaveText(DEVICE_BOUND_NOTICE);

  // Steps up, so that neither the enrolment nor the revoke needs the device-bound passkey.
  await openAccountDetails(page);
  await page.getByRole("button", { name: "Log out everywhere else" }).click();
  await expect(page.locator("#settings-status")).toHaveText("Logged out everywhere else.");
  await deviceBound.cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: deviceBound.authenticatorId });
  await addAuthenticator(page, { synced: true });

  // One synced passkey beside the device-bound one hides the notice, without a reload.
  await page.getByRole("button", { name: "Another device" }).click();
  await expect(page.locator("#credential-rows tr")).toHaveCount(2);
  await expect(notice).toHaveCount(1);
  await expect(notice).toBeHidden();

  // Revoking the synced passkey shows it again.
  page.once("dialog", (dialog) => void dialog.accept());
  await page.locator("#credential-rows tr").nth(1).getByRole("button", { name: "Revoke" }).click();
  await expect(page.locator("#credential-rows tr")).toHaveCount(1);
  await expect(page.locator("#credential-rows tr td").nth(2)).toHaveText("no");
  await expect(notice).toBeVisible();
});

test("settings suggest no other passkey when the record's passkeys are synced", async ({ page }) => {
  await addAuthenticator(page, { synced: true });
  await registerMember(page, `Synced${Date.now().toString(36)}`);
  await openSettings(page);
  await expect(page.locator("#credential-rows tr")).toHaveCount(1);
  await expect(page.locator("#credential-rows tr td").nth(2)).toHaveText("yes");
  await expect(page.locator("#device-bound-notice")).toHaveCount(1);
  await expect(page.locator("#device-bound-notice")).toBeHidden();
});

test("log out everywhere else steps up, then leaves only this session", async ({ page, browser }) => {
  const laptop = await addAuthenticator(page);
  const memberName = `Elsewhere${Date.now().toString(36)}`;
  const statuses: number[] = [];
  page.on("response", (r) => {
    if (r.url().endsWith("/auth/logout-elsewhere")) statuses.push(r.status());
  });
  await registerMember(page, memberName);

  // A second device holding the same passkey logs in, so the record has two sessions.
  const phone = await (await browser.newContext()).newPage();
  const phoneAuthenticator = await addAuthenticator(phone);
  await copyCredentials(laptop, phoneAuthenticator);
  await phone.goto("/");
  await openSignIn(phone);
  await phone.getByRole("button", { name: "Continue with passkey" }).click();
  await expectSignedIn(phone, memberName);
  // The phone's login advanced the passkey's sign counter; the laptop takes that copy, as a synced passkey would.
  await copyCredentials(phoneAuthenticator, laptop);
  await page.reload();
  await openSettings(page);
  await expect(page.locator("#session-rows tr")).toHaveCount(2);

  await openAccountDetails(page);
  await page.getByRole("button", { name: "Log out everywhere else" }).click();

  await expect(page.locator("#settings-status")).toHaveText("Logged out everywhere else.");
  expect(statuses).toEqual([403, 200]);
  await expect(page.locator("#session-rows tr")).toHaveCount(1);
  await expect(page.locator("#session-rows tr")).toContainText("(this one)");
  await phone.reload();
  await expect(phone.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect(phone.getByRole("button", { name: "Settings" })).toBeHidden();
  await phone.context().close();
});

test("account details hold the record id, sessions and log out everywhere, collapsed", async ({ page }) => {
  await addAuthenticator(page);
  const memberName = `Details${Date.now().toString(36)}`;
  await registerMember(page, memberName);
  await expect(page.locator("#app-signed-in")).toHaveText("You're signed in with a passkey.");
  const { recordId } = await page.evaluate(() => fetch("/me").then((r) => r.json() as Promise<{ recordId: string }>));

  await openSettings(page);
  const settings = page.locator("#settings");
  await expect(settings.locator("#logout")).toHaveCount(0);
  const details = page.locator("#account-details");
  await expect(details).not.toHaveAttribute("open");
  await expect(page.locator("#record-id")).toBeHidden();
  await expect(page.locator("#session-rows")).toBeHidden();
  const logOutAll = [page.locator("#logout-everywhere"), page.locator("#logout-elsewhere")];
  for (const button of logOutAll) {
    await expect(button).toHaveCount(1);
    await expect(button).toBeHidden();
  }

  await page.getByText("Account details").click();
  await expect(page.locator("#record-id")).toHaveText(recordId);
  await expect(page.locator("#session-rows tr")).toHaveCount(1);
  await expect(page.locator("#session-rows tr")).toContainText("(this one)");
  // The rare, deliberate log-outs follow the sessions they end.
  const sessionsBottom = await page.locator("#session-rows").evaluate((rows) => rows.getBoundingClientRect().bottom);
  for (const name of ["Log out everywhere", "Log out everywhere else"]) {
    const button = details.getByRole("button", { name, exact: true });
    await expect(button).toBeVisible();
    expect((await button.boundingBox())!.y).toBeGreaterThanOrEqual(sessionsBottom);
  }

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy record id" }).click();
  await expect(page.locator("#settings-status")).toHaveText("Copied your record id.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(recordId);
});

/** Expect the element's box, which is what takes a click, to be at least 44 x 44 px. */
async function expectTargetSize(locator: Locator) {
  await expect(locator).toBeVisible();
  const box = (await locator.boundingBox())!;
  const button = await locator.evaluate((e) => e.outerHTML);
  expect(box.width, button).toBeGreaterThanOrEqual(44);
  expect(box.height, button).toBeGreaterThanOrEqual(44);
}

test("small buttons take a click over at least 44 x 44 px", async ({ page }) => {
  await addAuthenticator(page);
  await page.goto("/");
  await expectTargetSize(page.getByRole("button", { name: "Sign in", exact: true }));
  await openSignIn(page);
  await expectTargetSize(page.locator("#sign-in").getByRole("button", { name: "Close" }));
  await page.getByRole("button", { name: "Continue with passkey" }).click();
  await expectTargetSize(page.getByRole("button", { name: "About member names" }));

  await page.locator("#register-name").fill(`Targets${Date.now().toString(36)}`);
  await page.getByRole("button", { name: "Register with a passkey" }).click();
  await page.getByRole("checkbox", { name: "I have saved my recovery codes" }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const appBar = page.locator("header.app-bar");
  await expectTargetSize(appBar.getByRole("button", { name: "Settings" }));
  await expectTargetSize(appBar.getByRole("button", { name: "Log out", exact: true }));

  await openSettings(page);
  await openAccountDetails(page);
  await expectTargetSize(page.locator("#settings").getByRole("button", { name: "Close" }));
  for (const name of ["About passkeys", "About recovery codes", "About sessions", "About the record id"]) {
    await expectTargetSize(page.getByRole("button", { name, exact: true }));
  }
  await expectTargetSize(page.getByRole("button", { name: "Copy record id" }));
});

test("an operator's Remove stands apart, and settings fit a phone-width screen", async ({ page }) => {
  await addAuthenticator(page);
  await registerMember(page, OPERATORS.layout);
  await openSettings(page);
  await expectTargetSize(page.getByRole("button", { name: "About the operator actions" }));

  const actions = page.locator("#operator-actions button");
  await expect(actions).toHaveText(["Create rebind link", "Suspend", "Resume", "Allow name again", "Remove"]);
  await expect(actions.last()).toHaveClass(/\bdanger\b/);
  const boxes = await actions.evaluateAll((buttons) =>
    buttons.map((b) => b.getBoundingClientRect().toJSON() as DOMRect),
  );
  const gaps = boxes.slice(1).map((box, i) => box.left - boxes[i]!.right);
  // All on one row at this width, so each gap is the space between neighbours.
  for (const box of boxes) expect(box.top).toBe(boxes[0]!.top);
  for (const gap of gaps.slice(0, -1)) expect(gaps.at(-1)!).toBeGreaterThan(gap);

  await page.setViewportSize({ width: 375, height: 812 });
  const fits = () =>
    page.evaluate(() => {
      const settings = document.getElementById("settings")!;
      return {
        page: document.documentElement.scrollWidth <= innerWidth,
        settings: settings.scrollWidth <= settings.clientWidth,
      };
    });
  await openAccountDetails(page);
  expect(await fits()).toEqual({ page: true, settings: true });
  await page.locator("#settings").getByRole("button", { name: "Close" }).click();
  expect((await fits()).page).toBe(true);
  const appBar = page.locator("header.app-bar");
  for (const name of ["Settings", "Log out"]) {
    const button = appBar.getByRole("button", { name, exact: true });
    await expect(button).toBeInViewport({ ratio: 1 });
  }
  await expect(page.locator("#member-name")).toBeInViewport({ ratio: 1 });
  // The two buttons wrap together, not one under the other.
  const [settingsBox, logOutBox] = await Promise.all(
    ["Settings", "Log out"].map(
      async (name) => (await appBar.getByRole("button", { name, exact: true }).boundingBox())!,
    ),
  );
  expect(logOutBox!.y).toBe(settingsBox!.y);
});

test("a rebind link opens the sign-in pane at its passkey, and says when the link is not valid", async ({ page }) => {
  // Even where the entry step would open on the member-name field, the rebind step keeps focus on its button.
  await page.addInitScript(() => {
    PublicKeyCredential.getClientCapabilities = async () => ({ immediateGet: false, conditionalGet: true });
  });
  await page.goto("/rebind#not-a-link");
  await expect(page.locator("#sign-in")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create a passkey" })).toBeFocused();
  await expect(page.getByRole("button", { name: "Continue with passkey" })).toBeHidden();
  await page.getByRole("button", { name: "Create a passkey" }).click();
  await expect(page.locator("#sign-in-status")).toHaveText("This link is not valid.");
});

test("a rebind link opened on a device that already has the member's passkey says so, and adds nothing", async ({
  page,
  browser,
}) => {
  const memberName = `Rebound${Date.now().toString(36)}`;
  const { device } = await registerElsewhere(browser, memberName);
  await addAuthenticator(page);
  await registerMember(page, OPERATORS.rebind);
  await openSettings(page);
  await page.getByRole("textbox", { name: "Member name" }).fill(memberName);
  await page.getByRole("button", { name: "Look up" }).click();
  await page.locator("#operator").getByRole("button", { name: "Create rebind link", exact: true }).click();
  await expect(page.locator("#operator-result")).toContainText("/rebind#");
  const link = (await page.locator("#operator-result").textContent())!.split(": ")[1]!;

  const rebinds: string[] = [];
  device.on("request", (r) => {
    if (r.url().endsWith("/auth/rebind/verify")) rebinds.push(r.url());
  });
  // The member's own authenticator holds the record's passkey, which the rebind options exclude.
  await device.goto(`/rebind${new URL(link).hash}`);
  await device.getByRole("button", { name: "Create a passkey" }).click();
  await expect(device.locator("#sign-in-status")).toHaveText(
    "This device already has a passkey for you. Use it to log in, or add one on another device.",
  );
  expect(rebinds).toEqual([]);
  await device.getByRole("button", { name: "Close" }).click();
  await openSettings(device);
  await expect(device.locator("#credential-rows tr")).toHaveCount(1);
  await device.context().close();
});

const INFO = {
  passkeys:
    "Held by is the password manager or security key that stores the passkey, when it can be identified. Synced means that manager can copy the passkey to your other devices. Revoking a passkey stops it signing in, though sessions it already started stay open, and you can't revoke your only one.",
  codes:
    "Recovery codes let you add a new passkey if you lose all of yours, and each one works once. Replacing them gives you a fresh set of 8, shown only once, and every old code stops working straight away, including copies kept elsewhere or split into shares.",
  sessions:
    "A session keeps one browser signed in for 7 days. Log out ends this one, and Log out everywhere ends all of them, this one included. Log out everywhere else keeps this one and asks for your passkey first, so someone holding a stolen session can't shut you out.",
  recordId:
    "Your record id names your identity record and never changes, even if every passkey and code does. It isn't secret. To make yourself an operator on your own deployment, add it to the OPERATOR_RECORD_IDS secret.",
  operator:
    "A rebind link lets the member add a new passkey. Send it yourself once you've confirmed who they are; it works once, within 24 hours, and leaves their old passkeys, sessions and codes in place. Suspend signs the member out everywhere and blocks sign-in, recovery and rebind links until you Resume. Remove does the same for good and retires their member name, so nobody can register it again; it can't be undone, and it refuses an operator. Allow name again lets anyone register a retired name, on a new record; the removed member stays removed. Every action here is logged.",
};

/** Click an info button open and shut, checking its text and aria-expanded each time. */
async function expectInfoToggle(page: Page, name: string, text: string) {
  const toggle = page.getByRole("button", { name, exact: true });
  const info = page.locator(`#${await toggle.getAttribute("aria-controls")}`);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(info).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(info).toBeVisible();
  await expect(info).toHaveText(text);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(info).toBeHidden();
}

/** Register a member on a device of their own, in a new browser context. */
async function registerElsewhere(browser: Browser, memberName: string) {
  const device = await (await browser.newContext()).newPage();
  await addAuthenticator(device);
  await registerMember(device, memberName);
  const { recordId } = (await (await device.request.get("/me")).json()) as { recordId: string };
  return { device, recordId };
}

/** The JSON bodies the page posts to `path`, leaving out those refused for a step-up and sent again after it. */
function postsTo(page: Page, path: string): unknown[] {
  const bodies: unknown[] = [];
  page.on("response", (response) => {
    if (response.url().endsWith(path) && response.status() !== 403) bodies.push(response.request().postDataJSON());
  });
  return bodies;
}

test("info buttons in settings explain each section, and the operator's shows only to operators", async ({
  page,
  browser,
}) => {
  await addAuthenticator(page);
  await registerMember(page, `Info${Date.now().toString(36)}`);

  await openSettings(page);
  await expectInfoToggle(page, "About passkeys", INFO.passkeys);
  await expectInfoToggle(page, "About recovery codes", INFO.codes);
  await expectInfoToggle(page, "About sessions", INFO.sessions);
  await page.getByText("Account details").click();
  await expectInfoToggle(page, "About the record id", INFO.recordId);
  await expect(page.locator("#account-details")).toHaveAttribute("open");
  await expect(page.locator("#operator-info-toggle")).toHaveCount(1);
  await expect(page.locator("#operator-info-toggle")).toBeHidden();

  const { device: operator } = await registerElsewhere(browser, OPERATORS.info);
  await openSettings(operator);
  await expectInfoToggle(operator, "About the operator actions", INFO.operator);
  await operator.context().close();
});

test("an operator looks up a member, and the actions act on the member shown", async ({ page, browser }) => {
  const memberName = `Lookup${Date.now().toString(36)}`;
  const { device, recordId } = await registerElsewhere(browser, memberName);
  await addAuthenticator(page);
  await registerMember(page, OPERATORS.lookup);
  const lookups = postsTo(page, "/operator/lookup");
  const suspends = postsTo(page, "/operator/suspend");
  await openSettings(page);

  const name = page.getByRole("textbox", { name: "Member name" });
  const actions = ["Create rebind link", "Suspend", "Resume", "Remove"].map((label) =>
    page.locator("#operator").getByRole("button", { name: label, exact: true }),
  );
  for (const action of actions) await expect(action).toBeDisabled();

  await name.fill(`Nobody${Date.now().toString(36)}`);
  const nobody = await name.inputValue();
  await page.getByRole("button", { name: "Look up" }).click();
  await expect(page.locator("#operator-result")).toHaveText("No such member");
  await expect(page.locator("#operator-member")).toHaveCount(1);
  await expect(page.locator("#operator-member")).toBeHidden();

  await name.fill(memberName);
  await page.getByRole("button", { name: "Look up" }).click();
  const member = page.locator("#operator-member");
  await expect(member).toBeVisible();
  await expect(member).toContainText(recordId);
  await expect(member).toContainText("Active");
  await expect(page.locator("#operator-summary")).toContainText("Passkeys1");
  await expect(page.locator("#operator-summary")).toContainText("Sessions1");
  await expect(page.locator("#operator-summary")).toContainText("Recovery codes left8");
  await expect(page.locator("#operator-summary")).toContainText("Rebind linkNone");
  // The lookup itself is logged before it answers.
  await expect(page.locator("#operator-entries tr")).toHaveCount(1);
  await expect(page.locator("#operator-entries")).toContainText("lookup");
  for (const action of actions) await expect(action).toBeEnabled();

  // Acting on the shown member sends its record id, not the typed name, and shows the member as it now stands.
  await actions[1]!.click();
  await expect(page.locator("#operator-result")).toHaveText("Done.");
  expect(suspends).toEqual([{ recordId }]);
  await expect(member).toContainText("Suspended since");
  await expect(page.locator("#operator-summary")).toContainText("Sessions0");
  await expect(page.locator("#operator-entries tr")).toHaveCount(2);
  await device.reload();
  await expect(device.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();

  // Editing the name clears the result until the next lookup.
  await name.fill(memberName.slice(0, -1));
  await expect(member).toBeHidden();
  await expect(page.locator("#operator-result")).toHaveText("");
  for (const action of actions) await expect(action).toBeDisabled();
  expect(lookups).toEqual([{ memberName: nobody }, { memberName }]);
  await device.context().close();
});

test("an operator removes a member after confirming, and the name then looks up as retired, read-only", async ({
  page,
  browser,
}) => {
  const memberName = `Remove${Date.now().toString(36)}`;
  const { device, recordId } = await registerElsewhere(browser, memberName);
  await addAuthenticator(page);
  await registerMember(page, OPERATORS.remove);
  const { recordId: operatorId } = (await (await page.request.get("/me")).json()) as { recordId: string };
  const removes = postsTo(page, "/operator/remove");
  await openSettings(page);

  const name = page.getByRole("textbox", { name: "Member name" });
  const lookUp = page.getByRole("button", { name: "Look up" });
  const actions = ["Create rebind link", "Suspend", "Resume", "Remove"].map((label) =>
    page.locator("#operator").getByRole("button", { name: label, exact: true }),
  );
  const remove = actions[3]!;

  // An operator's record is refused, and the pane says why.
  await name.fill(OPERATORS.remove);
  await lookUp.click();
  await expect(page.locator("#operator-member")).toContainText(operatorId);
  page.once("dialog", (dialog) => void dialog.accept());
  await remove.click();
  await expect(page.locator("#operator-result")).toHaveText(
    "Operators can't be removed. Take them off OPERATOR_RECORD_IDS first.",
  );

  // Declining the confirmation sends nothing.
  await name.fill(memberName);
  await lookUp.click();
  await expect(page.locator("#operator-member")).toContainText(recordId);
  await expect(remove).toBeEnabled();
  page.once("dialog", (dialog) => void dialog.dismiss());
  await remove.click();
  expect(removes).toEqual([{ recordId: operatorId }]);

  page.once("dialog", (dialog) => {
    expect(dialog.message()).toBe(`Remove ${memberName}? This can't be undone, and their name will be retired.`);
    void dialog.accept();
  });
  await remove.click();
  await expect(page.locator("#operator-result")).toHaveText("Removed. Their name is retired.");
  expect(removes).toEqual([{ recordId: operatorId }, { recordId }]);
  await expect(page.locator("#operator-member")).toContainText("Removed since");
  for (const action of actions) await expect(action).toBeDisabled();
  await device.reload();
  await expect(device.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();

  await name.fill(memberName);
  await lookUp.click();
  await expect(page.locator("#operator-result")).toHaveText("Retired name");
  await expect(page.locator("#operator-member")).toBeVisible();
  await expect(page.locator("#operator-member")).toContainText(recordId);
  await expect(page.locator("#operator-entries")).toContainText("remove");
  for (const action of actions) await expect(action).toBeDisabled();
  await device.context().close();
});

test("an operator allows a retired name after confirming, and only a retired name", async ({ page, browser }) => {
  const memberName = `Allow${Date.now().toString(36)}`;
  const { device, recordId } = await registerElsewhere(browser, memberName);
  await device.context().close();
  await addAuthenticator(page);
  await registerMember(page, OPERATORS.allow);
  const allows = postsTo(page, "/operator/allow-name");
  await openSettings(page);

  const name = page.getByRole("textbox", { name: "Member name" });
  const lookUp = page.getByRole("button", { name: "Look up" });
  const allow = page.locator("#operator").getByRole("button", { name: "Allow name again", exact: true });
  const others = ["Create rebind link", "Suspend", "Resume", "Remove"].map((label) =>
    page.locator("#operator").getByRole("button", { name: label, exact: true }),
  );
  await expect(allow).toBeDisabled();

  // A live member's name is not retired, so it can't be allowed.
  await name.fill(memberName);
  await lookUp.click();
  await expect(page.locator("#operator-member")).toContainText("Active");
  await expect(allow).toBeDisabled();

  // Removing the member retires the name.
  page.once("dialog", (dialog) => void dialog.accept());
  await others[3]!.click();
  await expect(page.locator("#operator-result")).toHaveText("Removed. Their name is retired.");

  await name.fill(memberName);
  await lookUp.click();
  await expect(page.locator("#operator-result")).toHaveText("Retired name");
  await expect(page.locator("#operator-member")).toContainText(recordId);
  await expect(allow).toBeEnabled();
  for (const action of others) await expect(action).toBeDisabled();
  const entries = await page.locator("#operator-entries tr").count();

  // Declining the confirmation sends nothing.
  page.once("dialog", (dialog) => void dialog.dismiss());
  await allow.click();
  expect(allows).toEqual([]);

  page.once("dialog", (dialog) => {
    expect(dialog.message()).toBe(`Let anyone register ${memberName} again? The removed member stays removed.`);
    void dialog.accept();
  });
  await allow.click();
  await expect(page.locator("#operator-result")).toHaveText(`Anyone can now register ${memberName}.`);
  // The typed name is sent, since the name, not the removed record, is what is allowed.
  expect(allows).toEqual([{ memberName }]);
  await expect(page.locator("#operator-entries tr")).toHaveCount(entries + 1);
  await expect(page.locator("#operator-entries")).toContainText("allow-name");
  await expect(allow).toBeDisabled();
  for (const action of others) await expect(action).toBeDisabled();
});
