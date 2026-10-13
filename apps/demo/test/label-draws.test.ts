import { afterEach, describe, expect, it, vi } from "vitest";
import { testApp, uniqueName } from "./harness.ts";
import { PINNED_LABEL, pinLabelDraws, savedLabel } from "./label-draws.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pinning label draws", () => {
  it("leaves other short random draws alone", () => {
    pinLabelDraws();

    // Four 3-byte draws, the length of a label, all zero by chance once in 2^96.
    const draws = Array.from({ length: 4 }, () => crypto.getRandomValues(new Uint8Array(3)));

    expect(draws.some((bytes) => bytes.some((b) => b !== 0))).toBe(true);
  });

  it("leaves session and challenge draws alone", async () => {
    const app = testApp();
    const draws = pinLabelDraws();
    const browsers = [app.browser(), app.browser()];

    const options = [];
    for (const browser of browsers) {
      const created = await browser.json(browser.post("/auth/register/options", { memberName: uniqueName() }));
      const response = await browser.authenticator.create(created);
      await browser.json(browser.post("/auth/register/verify", { response }));
      options.push(created);
    }

    expect(draws()).toBe(2);
    expect(browsers.map((b) => savedLabel(b.authenticator.credentials[0]!))).toEqual([PINNED_LABEL, PINNED_LABEL]);
    expect(options[0].challenge).not.toBe(options[1].challenge);
    expect(options[0].user.id).not.toBe(options[1].user.id);
    expect(browsers[0]!.session).toBeDefined();
    expect(browsers[0]!.session).not.toBe(browsers[1]!.session);
  });
});
