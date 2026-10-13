import { describe, expect, it } from "vitest";
import type { Tamper } from "passkey-cloudflare/testing";
import { testApp, uniqueName, type Browser } from "./harness.ts";

// Whether a session's ceremonies were user-verified is recorded, never
// required: an authenticator that leaves UV unset is still accepted.

const unverified: Tamper = { userUnverified: true };

/** The presented session's own summary. */
async function currentSession(browser: Browser) {
  const { sessions } = await browser.json(browser.get("/me/sessions"));
  return sessions.find((s: any) => s.current);
}

/** An app with one person, and a stepped-up operator who can make rebind links. */
async function withOperator() {
  const app = testApp();
  const operator = app.browser();
  const { recordId: operatorId } = await operator.register(uniqueName("operator"));
  app.vars.OPERATOR_RECORD_IDS = operatorId;
  await operator.stepUp();
  const person = app.browser();
  const name = uniqueName("person");
  const { recordId, recoveryCodes } = await person.register(name);
  const rebindHash = async () => {
    const { link } = await operator.json(operator.post("/operator/rebind-links", { recordId }));
    return new URL(link).hash.slice(1);
  };
  return { app, name, recoveryCodes, rebindHash };
}

describe("a session records whether the ceremony that started it was user-verified", () => {
  for (const [name, tamper, verified] of [
    ["with UV", {}, true],
    ["without UV", unverified, false],
  ] as const) {
    it(`register, ${name}`, async () => {
      const browser = testApp().browser();
      const registered = await browser.clientAnswering({ tamper }).register(uniqueName());

      expect(registered.result).toBe("ok");
      expect((await currentSession(browser)).userVerified).toBe(verified);
    });

    it(`login, ${name}`, async () => {
      const app = testApp();
      const phone = app.browser();
      await phone.register(uniqueName());
      const laptop = app.browser();
      laptop.authenticator.credentials.push(...phone.authenticator.credentials);
      const loggedIn = await laptop.clientAnswering({ tamper }).login();

      expect(loggedIn.result).toBe("ok");
      expect((await currentSession(laptop)).userVerified).toBe(verified);
    });

    it(`recover, ${name}`, async () => {
      const { app, name: member, recoveryCodes } = await withOperator();
      const device = app.browser();
      const recovered = await device.clientAnswering({ tamper }).recover(member, recoveryCodes[0]!);

      expect(recovered.result).toBe("ok");
      expect((await currentSession(device)).userVerified).toBe(verified);
    });

    it(`rebind, ${name}`, async () => {
      const { app, rebindHash } = await withOperator();
      const device = app.browser();
      const rebound = await device.clientAnswering({ tamper }).rebind(await rebindHash());

      expect(rebound.result).toBe("ok");
      expect((await currentSession(device)).userVerified).toBe(verified);
    });
  }
});

describe("a session records whether its latest step-up was user-verified", () => {
  it("as null before any step-up", async () => {
    const browser = testApp().browser();
    await browser.register(uniqueName());

    expect((await currentSession(browser)).stepUpUserVerified).toBeNull();
  });

  it("as true, then false, as the step-ups set UV and then do not", async () => {
    const browser = testApp().browser();
    await browser.register(uniqueName());

    expect((await browser.clientAnswering().stepUp()).result).toBe("ok");
    expect((await currentSession(browser)).stepUpUserVerified).toBe(true);

    expect((await browser.clientAnswering({ tamper: unverified }).stepUp()).result).toBe("ok");
    expect((await currentSession(browser)).stepUpUserVerified).toBe(false);
  });

  it("on that session only", async () => {
    const app = testApp();
    const phone = app.browser();
    await phone.register(uniqueName());
    const laptop = app.browser();
    laptop.authenticator.credentials.push(...phone.authenticator.credentials);
    await laptop.login();

    await laptop.stepUp();

    const { sessions } = await laptop.json(laptop.get("/me/sessions"));
    expect(sessions.find((s: any) => s.current).stepUpUserVerified).toBe(true);
    expect(sessions.find((s: any) => !s.current).stepUpUserVerified).toBeNull();
  });
});
