import { describe, expect, it } from "vitest";
import { testApp, uniqueName } from "./harness.ts";

// WebAuthn Level 3 client hints steer where the browser offers to save a new
// passkey. They are hints only: nothing enforces them, so the ceremony's
// authenticatorSelection stays the same and any destination is accepted.

const AUTHENTICATOR_SELECTION = {
  residentKey: "required",
  requireResidentKey: true,
  userVerification: "preferred",
};

async function steppedUp() {
  const browser = testApp().browser();
  await browser.register(uniqueName());
  await browser.stepUp();
  return browser;
}

describe("add-passkey hints", () => {
  for (const hint of ["client-device", "hybrid", "security-key"]) {
    it(`carry ${hint} when asked for it`, async () => {
      const browser = await steppedUp();

      const options = await browser.json(browser.post("/me/credentials/enrol/options", { hint }));

      expect(options.hints).toEqual([hint]);
      expect(options.authenticatorSelection).toEqual(AUTHENTICATOR_SELECTION);
    });
  }

  for (const [name, body] of [
    ["none is sent", {}],
    ["an unknown one is sent", { hint: "phone" }],
    ["a list is sent", { hint: ["security-key"] }],
  ] as const) {
    it(`are left out when ${name}`, async () => {
      const browser = await steppedUp();

      const options = await browser.json(browser.post("/me/credentials/enrol/options", body));

      expect(options).not.toHaveProperty("hints");
      expect(options.authenticatorSelection).toEqual(AUTHENTICATOR_SELECTION);
    });
  }

  it("do not enforce: a platform passkey is accepted after a security-key hint", async () => {
    const browser = await steppedUp();

    const { label } = await browser.enrol("security-key");

    expect(label).toMatch(/^[a-z]{4}-[a-z]{4}-[a-z]{4}$/);
    expect(browser.authenticator.credentials).toHaveLength(2);
  });

  it("are not sent by registration, login, step-up or recovery options", async () => {
    const browser = testApp().browser();
    const name = uniqueName();

    const registration = await browser.json(
      browser.post("/auth/register/options", { memberName: name, hint: "hybrid" }),
    );
    await browser.register(name);
    const stepUp = await browser.json(browser.post("/auth/step-up/options", { hint: "hybrid" }));
    const recover = await browser.json(browser.post("/auth/recover/options", { memberName: name, hint: "hybrid" }));
    browser.session = undefined;
    const login = await browser.json(browser.post("/auth/login/options", { hint: "hybrid" }));

    for (const options of [registration, stepUp, recover, login]) expect(options.hints ?? []).toEqual([]);
  });
});
