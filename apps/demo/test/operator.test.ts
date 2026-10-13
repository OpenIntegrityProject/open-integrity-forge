import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { RECOVERY_CODE_COUNT, type RecordId, type RevocationEvent } from "passkey-cloudflare";
import { operatorLog, type OperatorLog } from "../src/operator-log.ts";
import { rejecting } from "./failing-namespaces.ts";
import { refusal, testApp, uniqueName, type Browser, type HarnessOptions, type TestApp } from "./harness.ts";

const HOUR = 60 * 60 * 1000;

/** An app with one stepped-up operator and one ordinary person. */
async function deployment(options: HarnessOptions = {}) {
  const app = testApp(options);
  const operator = app.browser();
  const { recordId: operatorId } = await operator.register(uniqueName("operator"));
  app.vars.OPERATOR_RECORD_IDS = `${crypto.randomUUID()}, ${operatorId}`;
  await operator.stepUp();
  const person = app.browser();
  const personName = uniqueName("person");
  const { recordId: personId, recoveryCodes } = await person.register(personName);
  return { app, operator, operatorId, person, personName, personId, recoveryCodes };
}

/** The status a rebind link's options are refused with, before any passkey ceremony starts. */
async function linkRefusal(device: Browser, link: string): Promise<number> {
  const rebound = await device.rebind(link);
  if (rebound.result !== "invalid-link") throw new Error(`expected an invalid link, got ${rebound.result}`);
  return rebound.response.status;
}

describe("operator role", () => {
  it("is shown to the operator and to no one else", async () => {
    const { operator, person } = await deployment();

    expect(await operator.json(operator.get("/me"))).toMatchObject({ operator: true });
    expect(await person.json(person.get("/me"))).toMatchObject({ operator: false });
  });
});

describe("operator rebind", () => {
  it("binds a new passkey to a person who lost everything, through a link", async () => {
    const { app, operator, personName, personId } = await deployment();

    const { link } = await operator.json(operator.post("/operator/rebind-links", { recordId: personId }));
    const newDevice = app.browser();
    const rebound = await newDevice.rebind(link);

    expect(link).toMatch(/^https:\/\/passkeydemo\.gordianstack\.com\/rebind#/);
    expect(rebound.result).toBe("ok");
    expect(await newDevice.json(newDevice.get("/me"))).toMatchObject({ recordId: personId });
    newDevice.session = undefined;
    expect((await newDevice.login()).recordId).toBe(personId);
  });

  it("options exclude the record's passkeys, which recover options for the same member name do not", async () => {
    const { app, operator, person, personName, personId } = await deployment();
    await person.stepUp();
    await person.enrol();
    const { link } = await operator.json(operator.post("/operator/rebind-links", { recordId: personId }));
    const device = app.browser();

    const rebind = await device.json(device.post("/auth/rebind/options", { link: new URL(link).hash.slice(1) }));
    const recover = await device.json(device.post("/auth/recover/options", { memberName: personName }));

    const ids = person.authenticator.credentials.map((c) => c.id);
    expect(ids).toHaveLength(2);
    expect(rebind.excludeCredentials.map((c: { id: string }) => c.id)).toEqual(ids);
    expect(recover.excludeCredentials).toEqual([]);
  });

  it("links work once", async () => {
    const { app, operator, personId } = await deployment();
    const { link } = await operator.json(operator.post("/operator/rebind-links", { recordId: personId }));
    await app.browser().rebind(link);

    // Refused before any passkey ceremony starts.
    expect(await linkRefusal(app.browser(), link)).toBe(404);
  });

  it("links expire after a day", async () => {
    let now = Date.now();
    const { app, operator, personId } = await deployment({ clock: () => now });
    const { link } = await operator.json(operator.post("/operator/rebind-links", { recordId: personId }));

    now += 24 * HOUR + 1;

    expect(await linkRefusal(app.browser(), link)).toBe(404);
  });

  it("options are refused for a link whose token is wrong, revealing nothing", async () => {
    const { app, personName, personId } = await deployment();
    const device = app.browser();

    const response = await device.post("/auth/rebind/options", { link: `${personId}.${"A".repeat(43)}` });

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(personName);
  });

  it("only an operator can create links", async () => {
    const { person, personId } = await deployment();
    await person.stepUp();

    expect((await person.post("/operator/rebind-links", { recordId: personId })).status).toBe(403);
  });

  it("an operator must have stepped up", async () => {
    let now = Date.now();
    const { operator, personId } = await deployment({ clock: () => now });
    now += 11 * 60 * 1000;

    expect((await operator.post("/operator/rebind-links", { recordId: personId })).status).toBe(403);
  });
});

describe("suspension", () => {
  it("ends the principal's sessions at once and refuses its logins, until resumed", async () => {
    const events: RevocationEvent[] = [];
    const { operator, person, personName, personId } = await deployment({
      onRevoke: (event) => void events.push(event),
    });

    expect((await operator.post("/operator/suspend", { recordId: personId })).status).toBe(200);

    expect(events).toEqual([{ reason: "suspension", recordId: personId, sessionIds: [expect.any(String)] }]);
    expect((await person.get("/me")).status).toBe(401);
    const options = await person.json(person.post("/auth/login/options"));
    const refused = await person.post("/auth/login/verify", { response: await person.authenticator.get(options) });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toBe('{"error":"ceremony refused"}');

    expect((await operator.post("/operator/resume", { recordId: personId })).status).toBe(200);
    expect((await person.login()).recordId).toBe(personId);
  });
});

describe("suspension of a principal with no live sessions", () => {
  it("still calls the revocation hook", async () => {
    const events: RevocationEvent[] = [];
    const { operator, person, personName, personId } = await deployment({
      onRevoke: (event) => void events.push(event),
    });
    await person.post("/auth/logout");
    events.length = 0;

    await operator.post("/operator/suspend", { recordId: personId });

    expect(events).toEqual([{ reason: "suspension", recordId: personId, sessionIds: [] }]);
  });
});

/** Complete a login ceremony, answering with the raw response so a refusal can be read. */
async function attemptLogin(device: Browser) {
  const options = await device.json(device.post("/auth/login/options"));
  return device.post("/auth/login/verify", { response: await device.authenticator.get(options) });
}

async function expectCeremonyRefused(response: Response) {
  expect(response.status).toBe(400);
  expect(await response.text()).toBe('{"error":"ceremony refused"}');
}

describe("removal", () => {
  it("ends the member's sessions and fires the revocation hook in the same request, and refuses their logins", async () => {
    const events: RevocationEvent[] = [];
    const { operator, person, personId } = await deployment({ onRevoke: (event) => void events.push(event) });

    expect((await operator.post("/operator/remove", { recordId: personId })).status).toBe(200);

    expect(events).toEqual([{ reason: "removal", recordId: personId, sessionIds: [expect.any(String)] }]);
    expect((await person.get("/me")).status).toBe(401);
    await expectCeremonyRefused(await attemptLogin(person));
  });

  it("refuses recovery with an unused recovery code", async () => {
    const { app, operator, personName, personId, recoveryCodes } = await deployment();
    await operator.post("/operator/remove", { recordId: personId });

    await expectCeremonyRefused(refusal(await app.browser().recover(personName, recoveryCodes[0]!)));
  });

  it("refuses a rebind link created before the removal", async () => {
    const { app, operator, personId } = await deployment();
    const { link } = await operator.json(operator.post("/operator/rebind-links", { recordId: personId }));
    await operator.post("/operator/remove", { recordId: personId });

    await expectCeremonyRefused(refusal(await app.browser().rebind(link)));
  });

  it("refuses a step-up begun before the removal", async () => {
    const { operator, person, personId } = await deployment();
    const options = await person.json(person.post("/auth/step-up/options"));
    await operator.post("/operator/remove", { recordId: personId });

    const refused = await person.post("/auth/step-up/verify", { response: await person.authenticator.get(options) });

    expect(refused.status).toBe(401);
  });

  it("refuses an enrolment begun on a session that predates the removal", async () => {
    const { operator, person, personId } = await deployment();
    await person.stepUp();
    const options = await person.json(person.post("/me/credentials/enrol/options"));
    await operator.post("/operator/remove", { recordId: personId });

    const refused = await person.post("/me/credentials/enrol/verify", {
      response: await person.authenticator.create(options),
    });

    expect(refused.status).toBe(401);
  });

  it("is final: Resume leaves the member refused", async () => {
    const { operator, person, personId } = await deployment();
    await operator.post("/operator/suspend", { recordId: personId });
    await operator.post("/operator/remove", { recordId: personId });

    expect((await operator.post("/operator/resume", { recordId: personId })).status).toBe(200);

    await expectCeremonyRefused(await attemptLogin(person));
  });

  it("retires the member name: nobody can register it again", async () => {
    const { app, operator, personName, personId } = await deployment();
    await operator.post("/operator/remove", { recordId: personId });

    const device = app.browser();
    const typedAnotherWay = personName.toUpperCase();
    expect(await device.json(device.get(`/auth/member-name?name=${typedAnotherWay}`))).toEqual({ available: false });
    expect((await device.post("/auth/register/options", { memberName: typedAnotherWay })).status).toBe(409);
  });

  it("leaves a lookup of the name answering \"retired\" with the removed record, read-only", async () => {
    const now = Date.now();
    const { operator, operatorId, personName, personId } = await deployment({ clock: () => now });
    await operator.post("/operator/remove", { recordId: personId });

    const response = await operator.post("/operator/lookup", { memberName: personName });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      recordId: personId,
      retired: true,
      summary: { removedAt: now, sessions: 0, passkeys: 1 },
      entries: [
        { operatorId, action: "remove", targetId: personId, at: now },
        { operatorId, action: "lookup", targetId: personId, at: now },
      ],
    });
  });

  it("is refused, like the other operator routes, to a non-operator and to an operator who has not stepped up", async () => {
    let now = Date.now();
    const { app, operator, person } = await deployment({ clock: () => now });
    await person.stepUp();
    const target = app.browser();
    const targetName = uniqueName("target");
    const { recordId: targetId } = await target.register(targetName);

    const byMember = await person.post("/operator/remove", { recordId: targetId });
    expect(byMember.status).toBe(403);
    expect(await byMember.json()).toEqual({ error: "not an operator" });

    now += 11 * 60 * 1000;
    const stale = await operator.post("/operator/remove", { recordId: targetId });
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({ error: "step-up-required" });

    expect((await target.get("/me")).status).toBe(200);
    await operator.stepUp();
    const member = await operator.json(operator.post("/operator/lookup", { memberName: targetName }));
    expect(member).toMatchObject({ retired: false, summary: { removedAt: null } });
    expect(member.entries.filter((e: any) => e.action === "remove")).toEqual([]);
  });

  it("is refused for an operator's record, the operator's own included, and changes nothing", async () => {
    const { app, operator, operatorId } = await deployment();
    const other = app.browser();
    const otherName = uniqueName("operator");
    const { recordId: otherOperatorId } = await other.register(otherName);
    app.vars.OPERATOR_RECORD_IDS = `${operatorId}, ${otherOperatorId}`;
    const { memberName: ownName } = await operator.json(operator.get("/me"));

    for (const [device, recordId, memberName] of [
      [operator, operatorId, ownName],
      [other, otherOperatorId, otherName],
    ] as const) {
      const refused = await operator.post("/operator/remove", { recordId });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ error: "operator record" });

      expect((await device.get("/me")).status).toBe(200);
      const member = await operator.json(operator.post("/operator/lookup", { memberName }));
      expect(member).toMatchObject({ retired: false, summary: { removedAt: null, sessions: 1 } });
      expect(member.entries.filter((e: any) => e.action === "remove")).toEqual([]);
    }
  });
});

describe("allowing a retired name", () => {
  it("lets anyone register the name again, on a new record, and leaves the removed member removed", async () => {
    const { app, operator, person, personName, personId } = await deployment();
    await operator.post("/operator/remove", { recordId: personId });

    expect((await operator.post("/operator/allow-name", { memberName: personName })).status).toBe(200);

    const newcomer = app.browser();
    const typedAnotherWay = personName.toUpperCase();
    expect(await newcomer.json(newcomer.get(`/auth/member-name?name=${typedAnotherWay}`))).toEqual({ available: true });
    const { recordId: newcomerId } = await newcomer.register(typedAnotherWay);
    expect(newcomerId).not.toBe(personId);
    expect(await newcomer.json(newcomer.get("/me"))).toMatchObject({ memberName: typedAnotherWay });
    expect(await operator.json(operator.post("/operator/lookup", { memberName: personName }))).toMatchObject({
      recordId: newcomerId,
      retired: false,
      summary: { removedAt: null },
    });
    await expectCeremonyRefused(await attemptLogin(person));
  });

  it("is logged against the removed record, and answers with that record as it now stands", async () => {
    const now = Date.now();
    const { operator, operatorId, personName, personId } = await deployment({ clock: () => now });
    await operator.post("/operator/remove", { recordId: personId });

    const response = await operator.post("/operator/allow-name", { memberName: personName });

    expect(await response.json()).toMatchObject({
      ok: true,
      member: {
        recordId: personId,
        retired: false,
        summary: { removedAt: now },
        entries: [
          { operatorId, action: "remove", targetId: personId, at: now },
          { operatorId, action: "allow-name", targetId: personId, at: now },
        ],
      },
    });
  });

  it("is refused for a name a live member holds, and changes nothing", async () => {
    const { app, operator, person, personName } = await deployment();

    const refused = await operator.post("/operator/allow-name", { memberName: personName });

    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "name not retired" });
    const device = app.browser();
    expect(await device.json(device.get(`/auth/member-name?name=${personName}`))).toEqual({ available: false });
    expect((await person.get("/me")).status).toBe(200);
    const member = await operator.json(operator.post("/operator/lookup", { memberName: personName }));
    expect(member.entries.filter((e: any) => e.action === "allow-name")).toEqual([]);
  });

  it("answers 404 for a name nobody holds, or one that is not a valid member name", async () => {
    const { operator } = await deployment();

    for (const memberName of [uniqueName("nobody"), "", 42]) {
      const refused = await operator.post("/operator/allow-name", { memberName });
      expect(refused.status).toBe(404);
    }
  });

  it("is refused, like the other operator routes, to a non-operator and to an operator who has not stepped up", async () => {
    let now = Date.now();
    const { app, operator, personName, personId } = await deployment({ clock: () => now });
    await operator.post("/operator/remove", { recordId: personId });
    const member = app.browser();
    await member.register(uniqueName("member"));
    await member.stepUp();

    const byMember = await member.post("/operator/allow-name", { memberName: personName });
    expect(byMember.status).toBe(403);
    expect(await byMember.json()).toEqual({ error: "not an operator" });

    now += 11 * 60 * 1000;
    const stale = await operator.post("/operator/allow-name", { memberName: personName });
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({ error: "step-up-required" });

    const device = app.browser();
    expect(await device.json(device.get(`/auth/member-name?name=${personName}`))).toEqual({ available: false });
  });

  it("leaves the name with its new member when the removed record is removed again", async () => {
    const { app, operator, personName, personId } = await deployment();
    await operator.post("/operator/remove", { recordId: personId });
    await operator.post("/operator/allow-name", { memberName: personName });
    const { recordId: newcomerId } = await app.browser().register(personName);

    const again = await operator.json(operator.post("/operator/remove", { recordId: personId }));

    // The removed record no longer holds a name, so there is none to allow.
    expect(again.member).toMatchObject({ recordId: personId, retired: false });

    expect(await operator.json(operator.post("/operator/lookup", { memberName: personName }))).toMatchObject({
      recordId: newcomerId,
      retired: false,
    });
  });
});

describe("operator targets", () => {
  it("can be named by record id, which must be a well-formed one", async () => {
    const { operator, person, personId } = await deployment();

    expect((await operator.post("/operator/suspend", { recordId: "not-a-record-id" })).status).toBe(404);
    expect((await operator.post("/operator/suspend", { recordId: personId })).status).toBe(200);
    expect((await person.get("/me")).status).toBe(401);
  });

  it("are named only by record id for every action but lookup and allow-name, and a refusal logs nothing", async () => {
    const { operator, operatorId, person, personName, personId } = await deployment();
    await operator.post("/operator/rebind-links", { recordId: personId });

    for (const path of ["/operator/rebind-links", "/operator/suspend", "/operator/resume", "/operator/remove"]) {
      const refused = await operator.post(path, { memberName: personName });
      expect(refused.status).toBe(404);
      expect(await refused.json()).toEqual({ error: "not found" });
    }
    expect((await operator.post("/operator/suspend", { recordId: crypto.randomUUID() })).status).toBe(404);

    expect((await person.get("/me")).status).toBe(200);
    const member = await operator.json(operator.post("/operator/lookup", { memberName: personName }));
    expect(member.summary).toMatchObject({ suspendedAt: null, removedAt: null, rebindLinkOutstanding: true });
    expect(member.entries.filter((e: any) => e.action !== "lookup")).toEqual([
      expect.objectContaining({ operatorId, action: "create-rebind-link" }),
    ]);
  });
});

describe("operator log", () => {
  it("records every operator action with who, what, whom and when", async () => {
    let now = Date.now();
    const { operator, operatorId, personName, personId } = await deployment({ clock: () => now });

    await operator.post("/operator/rebind-links", { recordId: personId });
    await operator.post("/operator/suspend", { recordId: personId });
    await operator.post("/operator/resume", { recordId: personId });

    const { entries } = await operator.json(operator.get("/operator/log"));
    expect(entries).toEqual([
      { operatorId, action: "create-rebind-link", targetId: personId, at: now },
      { operatorId, action: "suspend", targetId: personId, at: now },
      { operatorId, action: "resume", targetId: personId, at: now },
    ]);
  });
});

describe("operator lookup", () => {
  it("shows a member's state and counts, and no device detail", async () => {
    const now = Date.now();
    const { operator, operatorId, personName, personId } = await deployment({ clock: () => now });

    const response = await operator.post("/operator/lookup", { memberName: personName });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      recordId: personId,
      retired: false,
      summary: {
        createdAt: now,
        suspendedAt: null,
        removedAt: null,
        passkeys: 1,
        sessions: 1,
        recoveryCodesLeft: RECOVERY_CODE_COUNT,
        rebindLinkOutstanding: false,
      },
      // A lookup is logged before it reads, so it shows its own entry.
      entries: [{ operatorId, action: "lookup", targetId: personId, at: now }],
    });
  });

  it("answers 404 for a name no member holds, or one that is not a valid member name, and logs nothing", async () => {
    const { operator, operatorId } = await deployment();

    for (const memberName of [uniqueName("nobody"), "not a member name!", 42]) {
      const response = await operator.post("/operator/lookup", { memberName });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "no such member" });
    }
    const { entries } = await operator.json(operator.get("/operator/log"));
    expect(entries).toEqual([]);
  });

  it("is refused, like the other operator routes, to a non-operator and to an operator who has not stepped up, and logs nothing", async () => {
    let now = Date.now();
    const { operator, operatorId, person, personName, personId } = await deployment({ clock: () => now });
    await person.stepUp();
    // Reading the log logs nothing, and the app's log holds only this test's entries.
    const log = async () => (await operator.json(operator.get("/operator/log"))).entries;

    const byPerson = await person.post("/operator/lookup", { memberName: personName });
    expect(byPerson.status).toBe(403);
    expect(await byPerson.json()).toEqual({ error: "not an operator" });
    expect(await log()).toEqual([]);

    now += 11 * 60 * 1000;
    const stale = await operator.post("/operator/lookup", { memberName: personName });
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({ error: "step-up-required" });
    await operator.stepUp();
    expect(await log()).toEqual([]);
    // A lookup that is let through is logged.
    await operator.json(operator.post("/operator/lookup", { memberName: personName }));
    expect(await log()).toEqual([{ operatorId, action: "lookup", targetId: personId, at: now }]);
  });

  it("logs each lookup once, and shows every earlier entry for that member, however old", async () => {
    let now = Date.now();
    const { app, operator, operatorId, personName, personId } = await deployment({ clock: () => now });
    const first = now;
    await operator.post("/operator/suspend", { recordId: personId });
    await operator.post("/operator/lookup", { memberName: personName });
    // Enough later entries for other members to push this member's out of the recent list.
    const floodTargets = Array.from({ length: 200 }, () => crypto.randomUUID() as RecordId);
    await runInDurableObject(operatorLog(env.OPERATOR_LOG, app.storagePrefix)(), async (log: OperatorLog) => {
      for (const targetId of floodTargets) {
        log.append({ operatorId: operatorId as RecordId, action: "suspend", targetId, at: first });
      }
    });
    now += 1000;

    const { entries } = await operator.json(operator.post("/operator/lookup", { memberName: personName }));

    expect(entries).toEqual([
      { operatorId, action: "suspend", targetId: personId, at: first },
      { operatorId, action: "lookup", targetId: personId, at: first },
      { operatorId, action: "lookup", targetId: personId, at: now },
    ]);
    const recent = (await operator.json(operator.get("/operator/log"))).entries;
    expect(recent.filter((e: any) => e.targetId === personId)).toEqual([
      { operatorId, action: "lookup", targetId: personId, at: now },
    ]);
  });
});

describe("operator actions on a looked-up member", () => {
  it("answer with the member's updated state and log one entry each", async () => {
    const now = Date.now();
    const { operator, operatorId, personId } = await deployment({ clock: () => now });

    const linked = await operator.json(operator.post("/operator/rebind-links", { recordId: personId }));
    expect(linked.link).toMatch(/\/rebind#/);
    expect(linked.member).toMatchObject({ recordId: personId, summary: { rebindLinkOutstanding: true } });

    const suspended = await operator.json(operator.post("/operator/suspend", { recordId: personId }));
    expect(suspended.member).toMatchObject({ recordId: personId, summary: { suspendedAt: now, sessions: 0 } });

    const resumed = await operator.json(operator.post("/operator/resume", { recordId: personId }));
    expect(resumed.member.summary).toMatchObject({ suspendedAt: null });
    expect(resumed.member.entries).toEqual([
      { operatorId, action: "create-rebind-link", targetId: personId, at: now },
      { operatorId, action: "suspend", targetId: personId, at: now },
      { operatorId, action: "resume", targetId: personId, at: now },
    ]);

    const removed = await operator.json(operator.post("/operator/remove", { recordId: personId }));
    // Removing retires the name, which the operator can then allow again.
    expect(removed.member).toMatchObject({ recordId: personId, retired: true, summary: { removedAt: now } });
    expect(removed.member.entries.at(-1)).toEqual({ operatorId, action: "remove", targetId: personId, at: now });
  });
});

describe("an operator action whose log entry cannot be written", () => {
  /** Whether the request was refused: answered with an error, or failed outright. */
  async function refused(request: Promise<Response>): Promise<boolean> {
    return request.then(
      (response) => !response.ok,
      () => true,
    );
  }

  function breakLogAppends(app: TestApp) {
    app.vars.OPERATOR_LOG = rejecting(env.OPERATOR_LOG, "append");
  }

  function restoreLogAppends(app: TestApp) {
    delete app.vars.OPERATOR_LOG;
  }

  it("is refused for suspend and remove, leaving the member as they were", async () => {
    const { app, operator, person, personName, personId } = await deployment();
    breakLogAppends(app);

    expect(await refused(operator.post("/operator/suspend", { recordId: personId }))).toBe(true);
    expect(await refused(operator.post("/operator/remove", { recordId: personId }))).toBe(true);

    restoreLogAppends(app);
    expect((await person.get("/me")).status).toBe(200);
    const member = await operator.json(operator.post("/operator/lookup", { memberName: personName }));
    expect(member).toMatchObject({
      recordId: personId,
      retired: false,
      summary: { suspendedAt: null, removedAt: null },
    });
    expect(member.entries.filter((e: any) => e.action !== "lookup")).toEqual([]);
  });

  it("is refused for allow-name, leaving the name retired", async () => {
    const { app, operator, personName, personId } = await deployment();
    await operator.post("/operator/remove", { recordId: personId });
    breakLogAppends(app);

    expect(await refused(operator.post("/operator/allow-name", { memberName: personName }))).toBe(true);

    restoreLogAppends(app);
    const device = app.browser();
    expect(await device.json(device.get(`/auth/member-name?name=${personName}`))).toEqual({ available: false });
    const member = await operator.json(operator.post("/operator/lookup", { memberName: personName }));
    expect(member).toMatchObject({ recordId: personId, retired: true });
    expect(member.entries.map((e: any) => e.action)).toEqual(["remove", "lookup"]);
  });
});
