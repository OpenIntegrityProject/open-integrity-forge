import { env } from "cloudflare:test";
import { createPasskeys } from "passkey-cloudflare";
import { afterEach, describe, expect, it, vi } from "vitest";
import { overriding, rejecting } from "./failing-namespaces.ts";
import { failuresOn, globalFailuresFrom } from "./failure-log.ts";
import { testApp, uniqueName, type Browser } from "./harness.ts";

// Each ceremony method applies its own throttles, failure record and refusal
// floor, so an application cannot skip them by how it calls the method. A
// server failure inside a ceremony ends in the uniform refusal, like any other.

const REFUSAL = '{"error":"ceremony refused"}';
const HOUR = 60 * 60 * 1000;

async function loginAttempt(browser: Browser) {
  const options = await browser.json(browser.post("/auth/login/options"));
  return browser.post("/auth/login/verify", { response: await browser.authenticator.get(options) });
}

describe("a server failure inside a ceremony", () => {
  it("gets the uniform refusal, recorded on the record as internal-error", async () => {
    const app = testApp();
    const browser = app.browser();
    const { recordId } = await browser.register(uniqueName());
    browser.session = undefined;
    app.vars.IDENTITY_RECORDS = rejecting(env.IDENTITY_RECORDS, "completeLogin");

    const refused = await loginAttempt(browser);

    expect(refused.status).toBe(400);
    expect(await refused.text()).toBe(REFUSAL);
    expect(browser.session).toBeUndefined();
    expect(await failuresOn(app.storagePrefix, recordId)).toContainEqual({
      ceremony: "login",
      cause: "internal-error",
    });
  });

  it("is refused no sooner than the refusal floor", async () => {
    const FLOOR = 200;
    const app = testApp({ vars: { REFUSAL_FLOOR_MS: String(FLOOR) } });
    const browser = app.browser();
    await browser.register(uniqueName());
    browser.session = undefined;
    const options = await browser.json(browser.post("/auth/login/options"));
    const response = await browser.authenticator.get(options);
    app.vars.IDENTITY_RECORDS = rejecting(env.IDENTITY_RECORDS, "completeLogin");

    const started = Date.now();
    const refused = await browser.post("/auth/login/verify", { response });

    expect(refused.status).toBe(400);
    expect(Date.now() - started).toBeGreaterThanOrEqual(FLOOR);
  });

  it("before any record is known, is recorded globally", async () => {
    const app = testApp();
    const browser = app.browser();
    const options = await browser.json(browser.post("/auth/register/options", { memberName: uniqueName() }));
    const response = await browser.authenticator.create(options);
    app.vars.MEMBER_NAMES = rejecting(env.MEMBER_NAMES, "claim");

    const refused = await browser.post("/auth/register/verify", { response });

    expect(refused.status).toBe(400);
    expect(await refused.text()).toBe(REFUSAL);
    expect(await globalFailuresFrom(app.storagePrefix, browser)).toContainEqual({
      ceremony: "register",
      cause: "internal-error",
    });
  });
});

describe("anonymous options past the per-source limit get the uniform refusal", () => {
  const routes: [string, unknown][] = [
    ["/auth/register/options", { memberName: uniqueName() }],
    ["/auth/login/options", {}],
    ["/auth/recover/options", { memberName: uniqueName() }],
    ["/auth/rebind/options", { link: "not-a-link" }],
  ];
  for (const [path, body] of routes) {
    it(path, async () => {
      const app = testApp({ rateLimits: { optionsPerSource: { limit: 1, windowMs: HOUR } } });
      const browser = app.browser();
      await browser.post("/auth/login/options");

      const refused = await browser.post(path, body);

      expect(refused.status).toBe(400);
      expect(await refused.text()).toBe(REFUSAL);
    });
  }
});

describe("without a live session", () => {
  it("logging out everywhere answers 401", async () => {
    expect((await testApp().browser().post("/auth/logout-everywhere")).status).toBe(401);
  });

  it("listing sessions answers 401", async () => {
    expect((await testApp().browser().get("/me/sessions")).status).toBe(401);
  });
});

describe("the passkeys interface", () => {
  it("has no ceremony wrapper to call or forget", () => {
    const passkeys = createPasskeys(env, {
      rp: { id: "example.com", name: "Example", origin: "https://example.com" },
      refusalFloorMs: 0,
    });

    expect(Object.keys(passkeys)).not.toContain("ceremony");
    expect(Object.keys(passkeys)).not.toContain("anonymousOptions");
  });
});

describe("a refused registration whose undo fails", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A registration verified up to its response, ready to send. */
  async function pendingRegistration() {
    const app = testApp();
    const browser = app.browser();
    const name = uniqueName();
    const options = await browser.json(browser.post("/auth/register/options", { memberName: name }));
    const response = await browser.authenticator.create(options);
    return { app, browser, name, response };
  }

  function loggedUndoFailure(errors: { mock: { calls: unknown[][] } }) {
    return errors.mock.calls.some(([message]) => String(message).includes("undo step failed"));
  }

  it("when the label bind fails, keeps its cause, frees the member name and logs the failed undo", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, browser, name, response } = await pendingRegistration();
    app.vars.CREDENTIAL_LABELS = rejecting(env.CREDENTIAL_LABELS, "bind");
    app.vars.CREDENTIAL_INDEX = rejecting(env.CREDENTIAL_INDEX, "delete");

    const refused = await browser.post("/auth/register/verify", { response });

    expect(await refused.text()).toBe(REFUSAL);
    expect(await globalFailuresFrom(app.storagePrefix, browser)).toContainEqual({
      ceremony: "register",
      cause: "label-unbound",
    });
    expect(loggedUndoFailure(errors)).toBe(true);
    app.vars = {};
    await app.browser().register(name);
  });

  it("when the record refuses to commit, keeps its cause, frees the member name and logs the failed undo", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, browser, name, response } = await pendingRegistration();
    app.vars.IDENTITY_RECORDS = overriding(env.IDENTITY_RECORDS, {
      createPerson: async () => ({ ok: false, cause: "record-exists" }),
    });
    app.vars.CREDENTIAL_INDEX = rejecting(env.CREDENTIAL_INDEX, "delete");

    const refused = await browser.post("/auth/register/verify", { response });

    expect(await refused.text()).toBe(REFUSAL);
    expect(await globalFailuresFrom(app.storagePrefix, browser)).toContainEqual({
      ceremony: "register",
      cause: "record-exists",
    });
    expect(loggedUndoFailure(errors)).toBe(true);
    app.vars = {};
    await app.browser().register(name);
  });
});
