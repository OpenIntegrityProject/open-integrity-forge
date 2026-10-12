import { describe, expect, it } from "vitest";
import type { RevocationEvent } from "passkey-cloudflare";
import { testApp, uniqueName } from "./harness.ts";

const DAY = 24 * 60 * 60 * 1000;

describe("sessions", () => {
  it("last seven days from login, however active the person is", async () => {
    let now = Date.now();
    const browser = testApp({ clock: () => now }).browser();
    await browser.register(uniqueName());
    const start = now;

    now = start + 7 * DAY - 1;
    expect((await browser.get("/me")).status).toBe(200);
    now = start + 7 * DAY;
    expect((await browser.get("/me")).status).toBe(401);
  });

  it("are listed with when they started and from what browser", async () => {
    const app = testApp();
    const phone = app.browser();
    phone.userAgent = "PhoneBrowser/2.0";
    await phone.register(uniqueName());
    const laptop = app.browser();
    laptop.authenticator.credentials.push(...phone.authenticator.credentials);
    laptop.userAgent = "LaptopBrowser/3.0";
    await laptop.login();

    const { sessions } = await laptop.json(laptop.get("/me/sessions"));

    expect(sessions).toHaveLength(2);
    expect(sessions.map((s: any) => s.userAgent).sort()).toEqual(["LaptopBrowser/3.0", "PhoneBrowser/2.0"]);
    expect(sessions.find((s: any) => s.current).userAgent).toBe("LaptopBrowser/3.0");
    for (const s of sessions) {
      expect(typeof s.createdAt).toBe("number");
      expect(s.expiresAt - s.createdAt).toBe(7 * DAY);
    }
  });

  it("end on logout, leaving the person's other sessions alone", async () => {
    const app = testApp();
    const phone = app.browser();
    await phone.register(uniqueName());
    const laptop = app.browser();
    laptop.authenticator.credentials.push(...phone.authenticator.credentials);
    await laptop.login();
    const laptopSession = laptop.session;

    const out = await laptop.post("/auth/logout");

    expect(out.headers.get("Set-Cookie")).toMatch(/^__Host-session=;.*Max-Age=0/);
    expect(laptop.session).toBeUndefined();
    laptop.session = laptopSession;
    expect((await laptop.get("/me")).status).toBe(401);
    expect((await phone.get("/me")).status).toBe(200);
  });

  it("all end on logout everywhere, refused on the very next request", async () => {
    const app = testApp();
    const phone = app.browser();
    await phone.register(uniqueName());
    const laptop = app.browser();
    laptop.authenticator.credentials.push(...phone.authenticator.credentials);
    await laptop.login();
    expect((await phone.get("/me")).status).toBe(200);

    await laptop.post("/auth/logout-everywhere");

    expect((await phone.get("/me")).status).toBe(401);
    expect((await laptop.get("/me")).status).toBe(401);
  });

  it("but this one end on logout everywhere else, after a fresh step-up", async () => {
    const app = testApp();
    const phone = app.browser();
    await phone.register(uniqueName());
    const laptop = app.browser();
    laptop.authenticator.credentials.push(...phone.authenticator.credentials);
    await laptop.login();

    const refused = await laptop.post("/auth/logout-elsewhere");
    expect({ status: refused.status, body: await refused.json() }).toEqual({
      status: 403,
      body: { error: "step-up-required" },
    });
    expect((await phone.get("/me")).status).toBe(200);

    await laptop.stepUp();
    const out = await laptop.post("/auth/logout-elsewhere");

    expect(out.status).toBe(200);
    expect(out.headers.get("Set-Cookie")).toBeNull();
    expect((await phone.get("/me")).status).toBe(401);
    const { sessions } = await laptop.json(laptop.get("/me/sessions"));
    expect(sessions.map((s: any) => s.current)).toEqual([true]);
  });

  it("can be presented as a bearer header", async () => {
    const browser = testApp().browser();
    const { recordId } = await browser.register(uniqueName());
    const value = browser.session!;
    browser.session = undefined;

    const me = await browser.json(browser.get("/me", { Authorization: `Bearer ${value}` }));

    expect(me.recordId).toBe(recordId);
  });

  it("the cookie is __Host-session, Secure, HttpOnly and SameSite=Lax", async () => {
    const browser = testApp().browser();
    const options = await browser.json(browser.post("/auth/register/options", { memberName: uniqueName() }));
    const response = await browser.post("/auth/register/verify", {
      response: await browser.authenticator.create(options),
    });

    const cookie = response.headers.get("Set-Cookie")!;
    expect(cookie).toMatch(/^__Host-session=[0-9a-f-]{36}\.[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Domain");
  });
});

describe("revocation hook", () => {
  it("fires within the same request for logout and logout everywhere", async () => {
    const events: RevocationEvent[] = [];
    const app = testApp({ onRevoke: (event) => void events.push(event) });
    const browser = app.browser();
    const { recordId } = await browser.register(uniqueName());
    const { sessions } = await browser.json(browser.get("/me/sessions"));

    await browser.post("/auth/logout");
    expect(events).toEqual([{ reason: "logout", recordId, sessionIds: [sessions[0].id] }]);

    await browser.login();
    await browser.login();
    await browser.post("/auth/logout-everywhere");
    expect(events[1]).toMatchObject({ reason: "logout-everywhere", recordId });
    expect(events[1]!.sessionIds).toHaveLength(2);
  });

  it("fires for logout everywhere else with only the sessions it ended", async () => {
    const events: RevocationEvent[] = [];
    const app = testApp({ onRevoke: (event) => void events.push(event) });
    const phone = app.browser();
    const { recordId } = await phone.register(uniqueName());
    const laptop = app.browser();
    laptop.authenticator.credentials.push(...phone.authenticator.credentials);
    await laptop.login();
    await phone.login();
    const { sessions } = await laptop.json(laptop.get("/me/sessions"));
    const others = sessions.filter((s: any) => !s.current).map((s: any) => s.id);
    expect(others).toHaveLength(2);

    await laptop.stepUp();
    await laptop.post("/auth/logout-elsewhere");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reason: "logout-elsewhere", recordId });
    expect(events[0]!.sessionIds.sort()).toEqual(others.sort());
  });

  it("does not fire for logout everywhere else when no other session exists", async () => {
    const events: RevocationEvent[] = [];
    const browser = testApp({ onRevoke: (event) => void events.push(event) }).browser();
    await browser.register(uniqueName());
    await browser.stepUp();

    const out = await browser.post("/auth/logout-elsewhere");

    expect(out.status).toBe(200);
    expect(events).toEqual([]);
    expect((await browser.get("/me")).status).toBe(200);
  });
});
