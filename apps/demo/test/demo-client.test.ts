import { describe, expect, it } from "vitest";
import { DemoClient } from "../browser/demo-client.ts";
import { softwareAuthenticator, type Browser } from "./browser.ts";
import { testApp, uniqueName } from "./harness.ts";

/** A client on `browser` that records the path of every request it sends; with `decline`, every passkey sheet is dismissed. */
function watchedClient(browser: Browser, { decline = false } = {}) {
  const paths: string[] = [];
  const software = softwareAuthenticator(browser.authenticator);
  const client = new DemoClient(
    {
      origin: browser.app.origin,
      fetch: (request) => {
        paths.push(new URL(request.url).pathname);
        return browser.send(request);
      },
    },
    decline ? { create: software.create, get: async () => ({ result: "not-found" }) } : software,
  );
  return { client, paths };
}

describe("the demo client", () => {
  it("steps up once and retries a session-gated call refused for want of a step-up", async () => {
    const app = testApp();
    const browser = app.browser();
    const { recoveryCodes } = await browser.register(uniqueName());
    const { client, paths } = watchedClient(browser);

    const rotated = await client.rotateRecoveryCodes();

    expect(rotated).toMatchObject({ result: "ok", recoveryCodes: expect.any(Array) });
    if (rotated.result !== "ok") throw new Error(rotated.result);
    expect(rotated.recoveryCodes).not.toContain(recoveryCodes[0]);
    expect(paths).toEqual([
      "/me/recovery-codes/rotate",
      "/auth/step-up/options",
      "/auth/step-up/verify",
      "/me/recovery-codes/rotate",
    ]);
  });

  it("sends a session-gated call once when the session has stepped up", async () => {
    const app = testApp();
    const browser = app.browser();
    await browser.register(uniqueName());
    await browser.stepUp();
    const { client, paths } = watchedClient(browser);

    expect((await client.rotateRecoveryCodes()).result).toBe("ok");
    expect(paths).toEqual(["/me/recovery-codes/rotate"]);
  });

  it("leaves the action undone when the step-up is declined", async () => {
    const app = testApp();
    const browser = app.browser();
    const name = uniqueName();
    const { recoveryCodes } = await browser.register(name);
    const { client, paths } = watchedClient(browser, { decline: true });

    expect(await client.rotateRecoveryCodes()).toEqual({ result: "cancelled" });

    expect(paths).toEqual(["/me/recovery-codes/rotate", "/auth/step-up/options"]);
    // The codes were not replaced: the first still recovers the record.
    expect((await app.browser().recover(name, recoveryCodes[0]!)).result).toBe("ok");
  });
});
