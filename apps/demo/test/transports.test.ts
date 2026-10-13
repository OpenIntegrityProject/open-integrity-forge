import { describe, expect, it } from "vitest";
import { testApp, uniqueName } from "./harness.ts";

// A credential descriptor carries the transports the browser reported at
// registration (WebAuthn Level 3, credential record), so that the browser can
// offer the right sheet for a security key or a phone.

describe("credential descriptors carry stored transports", () => {
  it("in the step-up allowCredentials and the enrol excludeCredentials", async () => {
    const app = testApp();
    const browser = app.browser({ transports: ["internal", "hybrid"] });
    await browser.register(uniqueName());
    const [credential] = browser.authenticator.credentials;

    const stepUp = await browser.json(browser.post("/auth/step-up/options"));
    expect(stepUp.allowCredentials).toEqual([
      { id: credential!.id, type: "public-key", transports: ["internal", "hybrid"] },
    ]);

    await browser.stepUp();
    const enrol = await browser.json(browser.post("/me/credentials/enrol/options"));
    expect(enrol.excludeCredentials).toEqual([
      { id: credential!.id, type: "public-key", transports: ["internal", "hybrid"] },
    ]);
  });

  it("with no transports field for a credential registered with none", async () => {
    const app = testApp();
    const browser = app.browser({ transports: [] });
    await browser.register(uniqueName());
    const [credential] = browser.authenticator.credentials;

    const stepUp = await browser.json(browser.post("/auth/step-up/options"));
    expect(stepUp.allowCredentials).toEqual([{ id: credential!.id, type: "public-key" }]);

    await browser.stepUp();
    const enrol = await browser.json(browser.post("/me/credentials/enrol/options"));
    expect(enrol.excludeCredentials).toEqual([{ id: credential!.id, type: "public-key" }]);
  });

  it("but login still sends an empty allowCredentials for a record with stored transports", async () => {
    const app = testApp();
    const browser = app.browser({ transports: ["internal", "hybrid"] });
    await browser.register(uniqueName());
    browser.session = undefined;

    const login = await browser.json(browser.post("/auth/login/options"));
    expect(login.allowCredentials).toEqual([]);
  });
});
