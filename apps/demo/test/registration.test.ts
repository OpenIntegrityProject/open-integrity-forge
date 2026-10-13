import { describe, expect, it } from "vitest";
import { testApp, uniqueName } from "./harness.ts";

describe("registration", () => {
  it("creates a record, a passkey and a session in one step", async () => {
    const browser = testApp().browser();
    const name = uniqueName();

    const registered = await browser.register(name);

    expect(registered.recordId).toMatch(/^[0-9a-f-]{36}$/);
    expect(browser.session).toBeDefined();
    const me = await browser.json(browser.get("/me"));
    expect(me).toMatchObject({ recordId: registered.recordId, memberName: name });
  });

  it("shows eight distinct recovery codes once", async () => {
    const browser = testApp().browser();

    const { recoveryCodes } = await browser.register(uniqueName());

    expect(recoveryCodes).toHaveLength(8);
    expect(new Set(recoveryCodes).size).toBe(8);
    for (const code of recoveryCodes) expect(code).toMatch(/^ur:seed\/oyadgd[a-z]{40}$/);
    const me = await browser.text(browser.get("/me"));
    for (const code of recoveryCodes) expect(me).not.toContain(code);
  });

  it("says when the recovery codes were issued", async () => {
    const issuedAt = Date.UTC(2026, 8, 27, 12);
    const browser = testApp({ clock: () => issuedAt }).browser();

    expect((await browser.register(uniqueName())).issuedAt).toBe(issuedAt);
  });

  it("says a member name is taken before any ceremony starts", async () => {
    const app = testApp();
    const name = uniqueName();
    const first = app.browser();
    const second = app.browser();

    expect(await second.json(second.get(`/auth/member-name?name=${name}`))).toEqual({ available: true });
    await first.register(name);

    expect(await second.json(second.get(`/auth/member-name?name=${name.toUpperCase()}`))).toEqual({
      available: false,
    });
    const options = await second.post("/auth/register/options", { memberName: name });
    expect(options.status).toBe(409);
  });

  it("treats names that differ only in accents as one name", async () => {
    const app = testApp();
    const suffix = uniqueName("");
    const first = app.browser();
    const second = app.browser();
    await first.register(`Jose${suffix}`);

    for (const name of [`José${suffix}`, `josé${suffix}`, `JOSÉ${suffix}`]) {
      expect(await second.json(second.get(`/auth/member-name?name=${encodeURIComponent(name)}`)), name).toEqual({
        available: false,
      });
      expect((await second.post("/auth/register/options", { memberName: name })).status, name).toBe(409);
    }
  });

  it("treats ß and ss as one name", async () => {
    const app = testApp();
    const suffix = uniqueName("");
    await app.browser().register(`Strasse${suffix}`);
    const second = app.browser();

    expect((await second.post("/auth/register/options", { memberName: `Straße${suffix}` })).status).toBe(409);
  });

  it("stores a decomposed name as its composed form", async () => {
    const browser = testApp().browser();
    const name = `José${uniqueName("")}`;

    await browser.register(name.normalize("NFD"));

    expect(await browser.json(browser.get("/me"))).toMatchObject({ memberName: name.normalize("NFC") });
  });

  it("refuses a name that breaks the rules", async () => {
    const browser = testApp().browser();

    for (const memberName of [`a.${uniqueName()}`, `Аda${uniqueName("")}`]) {
      expect((await browser.post("/auth/register/options", { memberName })).status, memberName).toBe(409);
    }
  });

  it("names the passkey after the member and a distinct label", async () => {
    const browser = testApp().browser();
    const name = uniqueName();

    const options = await browser.json(browser.post("/auth/register/options", { memberName: name }));

    expect(options.user.name).toMatch(new RegExp(`^${name} \\([a-z]{4}-[a-z]{4}-[a-z]{4}\\)$`));
    expect(options.user.displayName).toBe(options.user.name);
  });

  it("accepts an Ed25519 passkey", async () => {
    const browser = testApp().browser({ algorithm: "Ed25519" });

    await browser.register(uniqueName());
    await browser.post("/auth/logout");
    await browser.login();

    expect((await browser.get("/me")).status).toBe(200);
  });
});

describe("login", () => {
  it("logs a returning person in with one passkey press", async () => {
    const browser = testApp().browser();
    const { recordId } = await browser.register(uniqueName());
    const first = browser.session;
    browser.session = undefined;

    const loggedIn = await browser.login();

    expect(loggedIn.recordId).toBe(recordId);
    expect(browser.session).toBeDefined();
    expect(browser.session).not.toBe(first);
    expect(await browser.json(browser.get("/me"))).toMatchObject({ recordId });
  });

  it("refuses a passkey the site has never seen", async () => {
    const app = testApp();
    const stranger = app.browser();
    await app.browser().register(uniqueName()); // a site with at least one person
    await stranger.authenticator.create(
      await stranger.json(stranger.post("/auth/register/options", { memberName: uniqueName() })),
    );

    const options = await stranger.json(stranger.post("/auth/login/options"));
    const response = await stranger.post("/auth/login/verify", {
      response: await stranger.authenticator.get(options),
    });

    expect(response.status).toBe(400);
    expect(stranger.session).toBeUndefined();
  });
});
