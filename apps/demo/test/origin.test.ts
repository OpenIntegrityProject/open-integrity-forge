import { describe, expect, it } from "vitest";
import { DemoClient } from "../browser/demo-client.ts";
import { GET_ROUTES, OWN_SESSION_ROUTES, POST_ROUTES } from "../src/app.ts";
import { softwareAuthenticator } from "./browser.ts";
import { ORIGIN, testApp, uniqueName, type Browser } from "./harness.ts";

// Only POST changes state, and every POST is checked against the site's
// origin, with one exception. The check stops cross-site request forgery,
// which rides on the session cookie a browser attaches by itself. A browser
// never attaches an `Authorization: Bearer` header on its own, so a POST that
// carries one and no cookie skips the check on the routes that act on the
// caller's own session (log out, step up, add or revoke a passkey, rotate
// codes): a non-browser client sends no Origin. Anonymous ceremonies and
// operator routes check it for every request, and a POST carrying both a
// bearer header and a cookie is refused, since the library would take the
// bearer one. The routes come from the app's own tables, so a route added
// later is covered here without editing this file.

/** Query strings that read routes need in order to answer. */
const QUERIES: Record<string, string> = { "/auth/member-name": "?name=someone" };

const READ_ROUTES = GET_ROUTES.map((path) => path + (QUERIES[path] ?? ""));

/**
 * A stepped-up operator with two passkeys, a person, and a removed member
 * whose name is retired, so that any route that got past the origin check
 * would have something to change: the operator's session and passkeys, the
 * person's standing, the retired name, the operator log.
 */
async function deployment() {
  const app = testApp();
  const operator = app.browser();
  const { recordId: operatorId } = await operator.register(uniqueName("operator"));
  app.vars.OPERATOR_RECORD_IDS = operatorId;
  await operator.stepUp();
  const { label } = await operator.enrol();
  const person = app.browser();
  const personName = uniqueName("person");
  const { recordId: personId } = await person.register(personName);
  const retiredName = uniqueName("retired");
  const { recordId: retiredId } = await app.browser().register(retiredName);
  expect((await operator.post("/operator/remove", { recordId: retiredId })).status).toBe(200);
  // Enough for any route to act on: whose passkey, whose record.
  const body = { label, memberName: personName, recordId: personId };
  // Routes that change something only for another target.
  const targetedBodies: Record<string, unknown> = { "/operator/allow-name": { memberName: retiredName } };
  const bodyFor = (path: string) => targetedBodies[path] ?? body;
  return { operator, person, personName, retiredName, bodyFor };
}

/**
 * A request with the browser's session cookie and the given Origin header, or
 * none. `Browser.request` always sends one on a POST, so it cannot send this.
 */
function send(browser: Browser, method: string, path: string, origin: string | null, body?: unknown) {
  const headers = new Headers({
    "CF-Connecting-IP": browser.ip,
    Cookie: `__Host-session=${browser.session}`,
  });
  if (origin !== null) headers.set("Origin", origin);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return browser.app.fetch(
    new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
  );
}

/** A POST as a non-browser client sends it: a bearer header, perhaps a cookie too, and no Origin unless given. */
function sendBearer(
  browser: Browser,
  path: string,
  body: unknown,
  { cookie = false, origin = null as string | null } = {},
) {
  const headers = new Headers({
    "CF-Connecting-IP": browser.ip,
    "Content-Type": "application/json",
    Authorization: `Bearer ${browser.session}`,
  });
  if (cookie) headers.set("Cookie", `__Host-session=${browser.session}`);
  if (origin !== null) headers.set("Origin", origin);
  return browser.app.fetch(new Request(ORIGIN + path, { method: "POST", headers, body: JSON.stringify(body) }));
}

/**
 * The demo client as a non-browser client holding `browser`'s session would
 * run it: every request carries the session as a bearer header, with no cookie
 * and no Origin. It records the paths it posted to and the status of each.
 */
function bearerClient(browser: Browser) {
  const value = browser.session!;
  const posted: { path: string; status: number }[] = [];
  const fetch = async (request: Request) => {
    const headers = new Headers(request.headers);
    headers.delete("Origin");
    headers.delete("Cookie");
    headers.set("Authorization", `Bearer ${value}`);
    headers.set("CF-Connecting-IP", browser.ip);
    const response = await browser.app.fetch(new Request(request, { headers }));
    if (request.method === "POST") posted.push({ path: new URL(request.url).pathname, status: response.status });
    return response;
  };
  const client = new DemoClient({ origin: ORIGIN, fetch }, softwareAuthenticator(browser.authenticator));
  return { client, posted };
}

/**
 * Nothing the routes could have changed has changed. The app's operator log
 * holds only this deployment's entries, so it is read whole, before the lookup
 * below logs one of its own.
 */
async function expectUnchanged({ operator, person, retiredName }: Awaited<ReturnType<typeof deployment>>) {
  expect((await operator.get("/me")).status).toBe(200);
  const { credentials } = await operator.json(operator.get("/me/credentials"));
  expect(credentials).toHaveLength(2);
  const { sessions } = await operator.json(operator.get("/me/sessions"));
  expect(sessions).toHaveLength(1);
  expect((await person.get("/me")).status).toBe(200);
  expect((await person.json(person.get("/me/credentials"))).credentials).toHaveLength(1);
  const { entries } = await operator.json(operator.get("/operator/log"));
  expect(entries.map((e: any) => e.action)).toEqual(["remove"]);
  // Read whatever the lookup answers: once the name is allowed, it no longer finds the member.
  expect(await (await operator.post("/operator/lookup", { memberName: retiredName })).json()).toMatchObject({
    retired: true,
  });
}

describe("a state-changing request", () => {
  const cases: [string, string | null][] = [
    ["from another origin", "https://evil.example"],
    ["with no Origin header", null],
  ];
  for (const [name, origin] of cases) {
    it(`${name} is refused on every route, before anything changes`, async () => {
      const setup = await deployment();

      for (const path of POST_ROUTES) {
        const response = await send(setup.operator, "POST", path, origin, setup.bodyFor(path));
        expect({ path, status: response.status, body: await response.text() }).toEqual({
          path,
          status: 403,
          body: '{"error":"origin not allowed"}',
        });
      }

      await expectUnchanged(setup);
    });
  }
});

describe("a GET or HEAD", () => {
  it("changes no state: read routes answer, and every state-changing route refuses it", async () => {
    const setup = await deployment();

    for (const method of ["GET", "HEAD"]) {
      for (const path of READ_ROUTES) {
        const response = await send(setup.operator, method, path, ORIGIN);
        expect({ method, path, status: response.status }).toEqual({ method, path, status: 200 });
      }
      for (const path of POST_ROUTES) {
        const response = await send(setup.operator, method, path, ORIGIN);
        expect({ method, path, status: response.status }).toEqual({ method, path, status: 404 });
      }
    }

    await expectUnchanged(setup);
  });
});

describe("a bearer-only POST with no Origin", () => {
  it("does its work on each route that acts on the caller's own session", async () => {
    const app = testApp();
    const browser = app.browser();
    const { recordId, recoveryCodes } = await browser.register(uniqueName());
    const passkey = browser.authenticator.credentials[0]!.id;
    const { client, posted } = bearerClient(browser);

    // Step up and add a passkey: the step-up and enrol ceremonies.
    expect(await client.stepUp()).toEqual({ result: "ok" });
    const enrolled = await client.enrol();
    if (enrolled.result !== "ok") throw new Error(enrolled.result);
    expect(await client.credentials()).toHaveLength(2);

    const revoked = await client.revoke(enrolled.label);
    expect(revoked.result).toBe("ok");
    expect(await client.credentials()).toHaveLength(1);

    const rotated = await client.rotateRecoveryCodes();
    if (rotated.result !== "ok") throw new Error(rotated.result);
    expect(rotated.recoveryCodes).toHaveLength(recoveryCodes.length);
    expect(rotated.recoveryCodes).not.toContain(recoveryCodes[0]);

    // Log out elsewhere ends another session and keeps this one.
    const laptop = app.browser();
    laptop.authenticator.credentials.push(...browser.authenticator.credentials);
    await laptop.login(passkey);
    expect(await client.logoutElsewhere()).toEqual({ result: "ok" });
    expect((await laptop.get("/me")).status).toBe(401);
    expect((await client.me())?.recordId).toBe(recordId);

    // Log out ends this session.
    await client.logout();
    expect(await client.me()).toBeNull();

    // Log out everywhere ends this session and every other.
    await browser.login(passkey);
    await laptop.login(passkey);
    const everywhere = bearerClient(browser);
    await everywhere.client.logoutEverywhere();
    expect(await everywhere.client.me()).toBeNull();
    expect((await laptop.get("/me")).status).toBe(401);

    const all = [...posted, ...everywhere.posted];
    expect(all.filter((p) => p.status !== 200)).toEqual([]);
    expect(new Set(all.map((p) => p.path))).toEqual(new Set(OWN_SESSION_ROUTES));
  });

  it("is refused on every anonymous ceremony and operator route, before anything changes", async () => {
    const setup = await deployment();
    const checked = POST_ROUTES.filter((path) => !OWN_SESSION_ROUTES.includes(path));
    expect(checked.filter((path) => path.startsWith("/operator/")).length).toBeGreaterThan(0);
    expect(checked.filter((path) => path.startsWith("/auth/")).length).toBeGreaterThan(0);

    for (const path of checked) {
      const response = await sendBearer(setup.operator, path, setup.bodyFor(path));
      expect({ path, status: response.status, body: await response.text() }).toEqual({
        path,
        status: 403,
        body: '{"error":"origin not allowed"}',
      });
    }

    await expectUnchanged(setup);
  });
});

describe("a POST with both a bearer header and a session cookie", () => {
  it("is refused on every route, from the site's origin too, before anything changes", async () => {
    const setup = await deployment();

    for (const origin of [ORIGIN, null]) {
      for (const path of POST_ROUTES) {
        const response = await sendBearer(setup.operator, path, setup.bodyFor(path), { cookie: true, origin });
        expect({ path, status: response.status, body: await response.text() }).toEqual({
          path,
          status: 400,
          body: '{"error":"bearer header and session cookie both sent"}',
        });
      }
    }

    await expectUnchanged(setup);
  });
});
