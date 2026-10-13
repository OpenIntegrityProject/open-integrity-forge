import { describe, expect, it } from "vitest";
import type { Tamper } from "passkey-cloudflare/testing";
import { refusal, testApp, uniqueName, type Browser } from "./harness.ts";

const REFUSAL = '{"error":"ceremony refused"}';
const HOUR = 60 * 60 * 1000;

async function loginWith(browser: Browser, tamper: Tamper) {
  const options = await browser.json(browser.post("/auth/login/options"));
  return browser.post("/auth/login/verify", { response: await browser.authenticator.get(options, tamper) });
}

async function registered() {
  const browser = testApp().browser();
  await browser.register(uniqueName());
  browser.session = undefined;
  return browser;
}

describe("a login is refused when the assertion", () => {
  const cases: [string, Tamper][] = [
    ["answers a challenge the server never issued", { challenge: "bm90LWEtY2hhbGxlbmdlLWZyb20tdGhpcy1zZXJ2ZXI" }],
    ["comes from another origin", { origin: "https://evil.example" }],
    ["was made for another relying party", { rpId: "evil.example" }],
    ["carries a bad signature", { badSignature: true }],
    ["claims the user was not present", { userAbsent: true }],
    ["is of the wrong ceremony type", { type: "webauthn.create" }],
  ];
  for (const [name, tamper] of cases) {
    it(name, async () => {
      const browser = await registered();

      const response = await loginWith(browser, tamper);

      expect(response.status).toBe(400);
      expect(await response.text()).toBe(REFUSAL);
      expect(browser.session).toBeUndefined();
    });
  }

  it("repeats or lowers the sign counter of a device-bound passkey", async () => {
    const browser = await registered();
    await browser.login(); // counter 1
    await browser.login(); // counter 2

    expect((await loginWith(browser, { signCount: 2 })).status).toBe(400);
    expect((await loginWith(browser, { signCount: 1 })).status).toBe(400);
    expect((await loginWith(browser, { signCount: 3 })).status).toBe(200);
  });
});

describe("the sign counter", () => {
  it("is not enforced for synced (backup-eligible) passkeys", async () => {
    const browser = testApp().browser({ backupEligible: true });
    await browser.register(uniqueName());

    await browser.login();
    await browser.login();

    expect((await browser.get("/me")).status).toBe(200);
  });
});

describe("a registration is refused when the attestation", () => {
  it("comes from another origin", async () => {
    const browser = testApp().browser();
    const options = await browser.json(browser.post("/auth/register/options", { memberName: uniqueName() }));

    const response = await browser.post("/auth/register/verify", {
      response: await browser.authenticator.create(options, { origin: "https://evil.example" }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(REFUSAL);
  });

  it("is presented a second time", async () => {
    const browser = testApp().browser();
    const options = await browser.json(browser.post("/auth/register/options", { memberName: uniqueName() }));
    const response = await browser.authenticator.create(options);
    await browser.post("/auth/register/verify", { response });

    expect((await browser.post("/auth/register/verify", { response })).status).toBe(400);
  });
});

describe("rate limits", () => {
  it("refuse recovery from one source address past its limit, but not from others", async () => {
    const app = testApp({ rateLimits: { recoverPerSource: { limit: 2, windowMs: HOUR } } });
    const name = uniqueName();
    const { recoveryCodes } = await app.browser().register(name);
    const attacker = app.browser();

    await attacker.recover(name, "cccc-cccc-cccc-cccc-cccc-cccc");
    await attacker.recover(name, "cccc-cccc-cccc-cccc-cccc-cccc");

    expect(refusal(await attacker.recover(name, recoveryCodes[0]!)).status).toBe(400);
    expect((await app.browser().recover(name, recoveryCodes[0]!)).result).toBe("ok");
  });

  it("refuse recovery globally past the global limit", async () => {
    const app = testApp({ rateLimits: { recoverGlobal: { limit: 1, windowMs: HOUR } } });
    const name = uniqueName();
    const { recoveryCodes } = await app.browser().register(name);
    // This recovery fills the app's global bucket.
    await app.browser().recover(name, "dddd-dddd-dddd-dddd-dddd-dddd");

    expect(refusal(await app.browser().recover(name, recoveryCodes[0]!)).status).toBe(400);
  });

  it("refuse anonymous ceremony options from one source address past its limit", async () => {
    const app = testApp({ rateLimits: { optionsPerSource: { limit: 2, windowMs: HOUR } } });
    const browser = app.browser();
    await browser.post("/auth/login/options");
    await browser.post("/auth/register/options", { memberName: uniqueName() });

    const refused = await browser.post("/auth/recover/options", { memberName: uniqueName() });

    expect(refused.status).toBe(400);
    expect(await refused.text()).toBe(REFUSAL);
    expect((await app.browser().post("/auth/login/options")).status).toBe(200);
  });

  it("refuse member-name checks from one source address past its limit", async () => {
    const app = testApp({ rateLimits: { nameCheckPerSource: { limit: 2, windowMs: HOUR } } });
    const browser = app.browser();
    const check = (device: Browser) => device.get(`/auth/member-name?name=${uniqueName()}`);
    await check(browser);
    await check(browser);

    const refused = await check(browser);

    expect(refused.status).toBe(400);
    expect(await refused.text()).toBe(REFUSAL);
    expect((await check(app.browser())).status).toBe(200);
  });

  it("refuse anonymous ceremonies globally past the global limit", async () => {
    const app = testApp({ rateLimits: { ceremonyGlobal: { limit: 1, windowMs: HOUR } } });
    const browser = app.browser();
    // This ceremony fills the app's global bucket.
    await browser.post("/auth/login/verify", {});

    const options = await browser.json(browser.post("/auth/register/options", { memberName: uniqueName() }));
    const response = await browser.post("/auth/register/verify", { response: await browser.authenticator.create(options) });

    expect(response.status).toBe(400);
  });

  it("refuse ceremonies from one source address past its limit", async () => {
    const app = testApp({ rateLimits: { ceremonyPerSource: { limit: 3, windowMs: HOUR } } });
    const browser = app.browser();
    await browser.register(uniqueName()); // 1
    await browser.login(); // 2
    await browser.login(); // 3

    expect((await loginWith(browser, {})).status).toBe(400);
  });
});
