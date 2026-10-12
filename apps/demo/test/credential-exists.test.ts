import { describe, expect, it } from "vitest";
import { dumpDurableState } from "./durable-state.ts";
import { failuresOn, globalFailuresFrom } from "./failure-log.ts";
import { refusal, testApp, uniqueName, type TestApp } from "./harness.ts";

// WebAuthn Level 3, section 7.1: if the credential ID is already known, the
// relying party should fail the registration ceremony. With attestation `none`
// a client can send a registration response for any credential ID it likes, so
// every ceremony that registers a credential refuses one another record holds,
// before anything is bound.

const REFUSAL = '{"error":"ceremony refused"}';

/** A person whose passkey's credential ID the tests present again. */
async function holder(app: TestApp) {
  const browser = app.browser();
  const { recordId } = await browser.register(uniqueName("holder"));
  return { browser, recordId, credentialId: browser.authenticator.credentials.at(-1)!.id };
}

/**
 * What the identity layer and the labels hold at rest, leaving out what a
 * refused ceremony writes without binding anything: the record's failure log
 * and recovery attempts, and labels minted for the ceremony that name no
 * credential.
 */
async function boundState(): Promise<string> {
  const dump = await dumpDurableState(["IDENTITY_RECORDS", "CREDENTIAL_INDEX", "CREDENTIAL_LABELS"]);
  return dump
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith("IDENTITY_RECORDS failures ") &&
        !line.startsWith("IDENTITY_RECORDS recovery_attempts ") &&
        !(line.startsWith("CREDENTIAL_LABELS labels ") && line.includes(" credential_id=null ")),
    )
    .join("\n");
}

/** The holder still logs in with the passkey, so its index entry still names the holder's record. */
async function expectHolderLogsIn(held: Awaited<ReturnType<typeof holder>>) {
  held.browser.session = undefined;
  const { recordId } = await held.browser.login(held.credentialId);
  expect(recordId).toBe(held.recordId);
}

describe("a credential ID another record holds is refused as credential-exists", () => {
  it("at registration", async () => {
    const app = testApp();
    const held = await holder(app);
    const name = uniqueName();
    const browser = app.browser();
    const before = await boundState();

    const response = refusal(
      await browser.clientAnswering({ tamper: { credentialId: held.credentialId } }).register(name),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(REFUSAL);
    expect(browser.session).toBeUndefined();
    expect(await globalFailuresFrom(app.storagePrefix, browser)).toContainEqual({
      ceremony: "register",
      cause: "credential-exists",
    });
    expect(await boundState()).toBe(before);
    expect(await browser.clientAnswering().memberNameAvailable(name)).toBe(true);
    await expectHolderLogsIn(held);
  });

  it("when adding a passkey", async () => {
    const app = testApp();
    const held = await holder(app);
    const browser = app.browser();
    const { recordId } = await browser.register(uniqueName());
    await browser.stepUp();
    const before = await boundState();

    const response = refusal(await browser.clientAnswering({ tamper: { credentialId: held.credentialId } }).enrol());

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(REFUSAL);
    expect(await failuresOn(app.storagePrefix, recordId)).toContainEqual({
      ceremony: "enrol",
      cause: "credential-exists",
    });
    expect(await boundState()).toBe(before);
    await expectHolderLogsIn(held);
  });

  it("when recovering", async () => {
    const app = testApp();
    const held = await holder(app);
    const name = uniqueName();
    const { recordId, recoveryCodes } = await app.browser().register(name);
    const newDevice = app.browser();
    const before = await boundState();

    const response = refusal(
      await newDevice.clientAnswering({ tamper: { credentialId: held.credentialId } }).recover(name, recoveryCodes[0]!),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(REFUSAL);
    expect(newDevice.session).toBeUndefined();
    expect(await failuresOn(app.storagePrefix, recordId)).toContainEqual({
      ceremony: "recover",
      cause: "credential-exists",
    });
    expect(await boundState()).toBe(before);
    await expectHolderLogsIn(held);
  });

  it("when rebinding", async () => {
    const app = testApp();
    const held = await holder(app);
    const operator = app.browser();
    const { recordId: operatorId } = await operator.register(uniqueName("operator"));
    app.vars.OPERATOR_RECORD_IDS = operatorId;
    await operator.stepUp();
    const { recordId } = await app.browser().register(uniqueName("person"));
    const { link } = await operator.json(operator.post("/operator/rebind-links", { recordId }));
    const newDevice = app.browser();
    const before = await boundState();

    const response = refusal(
      await newDevice
        .clientAnswering({ tamper: { credentialId: held.credentialId } })
        .rebind(new URL(link).hash.slice(1)),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(REFUSAL);
    expect(newDevice.session).toBeUndefined();
    expect(await failuresOn(app.storagePrefix, recordId)).toContainEqual({
      ceremony: "rebind",
      cause: "credential-exists",
    });
    expect(await boundState()).toBe(before);
    await expectHolderLogsIn(held);
  });
});
