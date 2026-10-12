import { describe, expect, it } from "vitest";
import type { Tamper } from "passkey-cloudflare/testing";
import { failuresOn, globalFailuresFrom } from "./failure-log.ts";
import { testApp, uniqueName } from "./harness.ts";

// The library expects no ceremony run in a frame. A browser marks one in the
// client data, with crossOrigin true or a topOrigin, and every ceremony that
// verifies a passkey refuses it.

const REFUSAL = '{"error":"ceremony refused"}';
const EMBEDDER = "https://embedder.example";

const framed: [string, Tamper][] = [
  ["crossOrigin true without topOrigin", { crossOrigin: true }],
  ["crossOrigin true with topOrigin", { crossOrigin: true, topOrigin: EMBEDDER }],
  ["topOrigin with crossOrigin false", { crossOrigin: false, topOrigin: EMBEDDER }],
];

describe("a ceremony framed in another origin is refused as cross-origin", () => {
  for (const [name, tamper] of framed) {
    it(`at registration, with ${name}`, async () => {
      const app = testApp();
      const browser = app.browser();
      const options = await browser.json(browser.post("/auth/register/options", { memberName: uniqueName() }));

      const refused = await browser.post("/auth/register/verify", {
        response: await browser.authenticator.create(options, tamper),
      });

      expect(refused.status).toBe(400);
      expect(await refused.text()).toBe(REFUSAL);
      expect(await globalFailuresFrom(app.storagePrefix, browser)).toContainEqual({
        ceremony: "register",
        cause: "cross-origin",
      });
    });

    it(`at login, with ${name}`, async () => {
      const app = testApp();
      const browser = app.browser();
      const { recordId } = await browser.register(uniqueName());
      browser.session = undefined;
      const options = await browser.json(browser.post("/auth/login/options"));

      const refused = await browser.post("/auth/login/verify", {
        response: await browser.authenticator.get(options, tamper),
      });

      expect(refused.status).toBe(400);
      expect(await refused.text()).toBe(REFUSAL);
      expect(browser.session).toBeUndefined();
      expect(await failuresOn(app.storagePrefix, recordId)).toContainEqual({
        ceremony: "login",
        cause: "cross-origin",
      });
    });

    it(`at step-up, with ${name}`, async () => {
      const app = testApp();
      const browser = app.browser();
      const { recordId } = await browser.register(uniqueName());
      const options = await browser.json(browser.post("/auth/step-up/options"));

      const refused = await browser.post("/auth/step-up/verify", {
        response: await browser.authenticator.get(options, tamper),
      });

      expect(refused.status).toBe(400);
      expect(await refused.text()).toBe(REFUSAL);
      expect(await failuresOn(app.storagePrefix, recordId)).toContainEqual({
        ceremony: "step-up",
        cause: "cross-origin",
      });
    });
  }
});

describe("a same-origin ceremony, with crossOrigin false and no topOrigin, still succeeds", () => {
  const sameOrigin: Tamper = { crossOrigin: false };

  it("registers, logs in and steps up", async () => {
    const browser = testApp().browser();
    const registration = await browser.json(browser.post("/auth/register/options", { memberName: uniqueName() }));
    const registered = await browser.post("/auth/register/verify", {
      response: await browser.authenticator.create(registration, sameOrigin),
    });
    expect(registered.status).toBe(200);

    const stepUp = await browser.json(browser.post("/auth/step-up/options"));
    const steppedUp = await browser.post("/auth/step-up/verify", {
      response: await browser.authenticator.get(stepUp, sameOrigin),
    });
    expect(steppedUp.status).toBe(200);

    browser.session = undefined;
    const login = await browser.json(browser.post("/auth/login/options"));
    const loggedIn = await browser.post("/auth/login/verify", {
      response: await browser.authenticator.get(login, sameOrigin),
    });
    expect(loggedIn.status).toBe(200);
  });
});
