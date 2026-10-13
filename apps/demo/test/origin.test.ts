import { describe, expect, it } from "vitest";
import { GET_ROUTES, POST_ROUTES } from "../src/app.ts";
import { ORIGIN, testApp, uniqueName, type Browser } from "./harness.ts";

// Every state-changing request is checked against the site's origin, and only
// POST changes state. The routes come from the app's own tables, so a route
// added later is covered here without editing this file.

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
