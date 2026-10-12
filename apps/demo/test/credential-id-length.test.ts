import { describe, expect, it } from "vitest";
import { dumpDurableState } from "./durable-state.ts";
import { failuresOn, globalFailuresFrom } from "./failure-log.ts";
import { refusal, testApp, uniqueName, type Browser, type TestApp } from "./harness.ts";

// WebAuthn Level 3, section 7.1: a credential ID longer than 1023 bytes should
// fail the registration ceremony. Every ceremony that registers a credential
// refuses one, before the credential is bound to the index or the record.

const REFUSAL = '{"error":"ceremony refused"}';
const FLOOR = 100;
const TOO_LONG = { credentialIdLength: 1024 };

function flooredApp(): TestApp {
  return testApp({ vars: { REFUSAL_FLOOR_MS: String(FLOOR) } });
}

/** The id of the credential the browser's authenticator made last. */
function lastCredentialId(browser: Browser): string {
  return browser.authenticator.credentials.at(-1)!.id;
}

/** What the identity layer holds at rest: every record and the credential index. */
function identityState(): Promise<string> {
  return dumpDurableState(["IDENTITY_RECORDS", "CREDENTIAL_INDEX"]);
}

/** Send a ceremony and answer its response and how long the server took. */
async function timed(send: () => Promise<Response>): Promise<{ response: Response; ms: number }> {
  const started = Date.now();
  const response = await send();
  return { response, ms: Date.now() - started };
}

async function expectUniformRefusal({ response, ms }: { response: Response; ms: number }) {
  expect(response.status).toBe(400);
  expect(await response.text()).toBe(REFUSAL);
  expect(ms).toBeGreaterThanOrEqual(FLOOR);
}

describe("a credential ID over 1023 bytes is refused as credential-id-too-long", () => {
  it("at registration", async () => {
    const app = flooredApp();
    const browser = app.browser();
    const options = await browser.json(browser.post("/auth/register/options", { memberName: uniqueName() }));
    const response = await browser.authenticator.create(options, TOO_LONG);

    const refused = await timed(() => browser.post("/auth/register/verify", { response }));

    await expectUniformRefusal(refused);
    expect(browser.session).toBeUndefined();
    expect(await globalFailuresFrom(app.storagePrefix, browser)).toContainEqual({
      ceremony: "register",
      cause: "credential-id-too-long",
    });
    expect(await identityState()).not.toContain(lastCredentialId(browser));
  });

  it("when adding a passkey", async () => {
    const app = flooredApp();
    const browser = app.browser();
    const { recordId } = await browser.register(uniqueName());
    await browser.stepUp();
    const options = await browser.json(browser.post("/me/credentials/enrol/options"));
    const response = await browser.authenticator.create(options, TOO_LONG);

    const refused = await timed(() => browser.post("/me/credentials/enrol/verify", { response }));

    await expectUniformRefusal(refused);
    expect(await failuresOn(app.storagePrefix, recordId)).toContainEqual({
      ceremony: "enrol",
      cause: "credential-id-too-long",
    });
    expect(await identityState()).not.toContain(lastCredentialId(browser));
  });

  it("when recovering", async () => {
    const app = flooredApp();
    const name = uniqueName();
    const { recordId, recoveryCodes } = await app.browser().register(name);
    const newDevice = app.browser();

    const refused = await timed(async () =>
      refusal(await newDevice.clientAnswering({ tamper: TOO_LONG }).recover(name, recoveryCodes[0]!)),
    );

    await expectUniformRefusal(refused);
    expect(newDevice.session).toBeUndefined();
    expect(await failuresOn(app.storagePrefix, recordId)).toContainEqual({
      ceremony: "recover",
      cause: "credential-id-too-long",
    });
    expect(await identityState()).not.toContain(lastCredentialId(newDevice));
  });

  it("when rebinding", async () => {
    const app = flooredApp();
    const operator = app.browser();
    const { recordId: operatorId } = await operator.register(uniqueName("operator"));
    app.vars.OPERATOR_RECORD_IDS = operatorId;
    await operator.stepUp();
    const { recordId } = await app.browser().register(uniqueName("person"));
    const { link } = await operator.json(operator.post("/operator/rebind-links", { recordId }));
    const newDevice = app.browser();

    const refused = await timed(async () =>
      refusal(await newDevice.clientAnswering({ tamper: TOO_LONG }).rebind(new URL(link).hash.slice(1))),
    );

    await expectUniformRefusal(refused);
    expect(newDevice.session).toBeUndefined();
    expect(await failuresOn(app.storagePrefix, recordId)).toContainEqual({
      ceremony: "rebind",
      cause: "credential-id-too-long",
    });
    expect(await identityState()).not.toContain(lastCredentialId(newDevice));
  });
});

describe("a credential ID of exactly 1023 bytes", () => {
  it("registers and logs in", async () => {
    const browser = testApp().browser();
    const options = await browser.json(browser.post("/auth/register/options", { memberName: uniqueName() }));
    const response = await browser.authenticator.create(options, { credentialIdLength: 1023 });

    const registered = await browser.post("/auth/register/verify", { response });

    expect(registered.status).toBe(200);
    expect(await identityState()).toContain(lastCredentialId(browser));
    browser.session = undefined;
    await browser.login();
  });
});
