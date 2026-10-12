import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { rejecting } from "./failing-namespaces.ts";
import { refusal, testApp, uniqueName, type Browser, type TestApp } from "./harness.ts";
import { savedLabel } from "./label-draws.ts";

// A label is bound before the record commits the ceremony's credential, so
// that every passkey the record holds is listed under the label its password
// manager saved it under. These tests make that bind fail and check that the
// ceremony is refused and leaves nothing it would have spent. The failure is
// faked at the binding because a thrown bind is the behaviour under test.

/** The labels namespace, with every bind failing as an unreachable object would. */
function labelsThatRefuseToBind(): Env["CREDENTIAL_LABELS"] {
  return rejecting(env.CREDENTIAL_LABELS, "bind");
}

function breakLabelBinds(app: TestApp) {
  app.vars.CREDENTIAL_LABELS = labelsThatRefuseToBind();
}

function restoreLabelBinds(app: TestApp) {
  delete app.vars.CREDENTIAL_LABELS;
}

async function listedLabels(browser: Browser): Promise<string[]> {
  const { credentials } = await browser.json(browser.get("/me/credentials"));
  return credentials.map((c: any) => c.label);
}

describe("a ceremony whose label bind fails is refused", () => {
  it("at registration, leaving the member name free", async () => {
    const app = testApp();
    const browser = app.browser();
    const name = uniqueName();
    const options = await browser.json(browser.post("/auth/register/options", { memberName: name }));
    const response = await browser.authenticator.create(options);
    breakLabelBinds(app);

    const refused = await browser.post("/auth/register/verify", { response });

    expect(refused.status).toBe(400);
    expect(browser.session).toBeUndefined();
    restoreLabelBinds(app);
    const retry = app.browser();
    await retry.register(name);
    expect(await listedLabels(retry)).toEqual([savedLabel(retry.authenticator.credentials[0]!)]);
  });

  it("when adding a passkey, which then cannot log in", async () => {
    const app = testApp();
    const browser = app.browser();
    await browser.register(uniqueName());
    await browser.stepUp();
    const options = await browser.json(browser.post("/me/credentials/enrol/options"));
    const response = await browser.authenticator.create(options);
    breakLabelBinds(app);

    const refused = await browser.post("/me/credentials/enrol/verify", { response });

    expect(refused.status).toBe(400);
    restoreLabelBinds(app);
    expect(await listedLabels(browser)).toHaveLength(1);
    const [, second] = browser.authenticator.credentials;
    const login = await browser.json(browser.post("/auth/login/options"));
    const assertion = await browser.authenticator.get(login, {}, second!.id);
    expect((await browser.post("/auth/login/verify", { response: assertion })).status).toBe(400);
  });

  it("when recovering, leaving the recovery code unused", async () => {
    const app = testApp();
    const name = uniqueName();
    const { recordId, recoveryCodes } = await app.browser().register(name);
    const newDevice = app.browser();
    breakLabelBinds(app);

    const refused = refusal(await newDevice.recover(name, recoveryCodes[0]!));

    expect(refused.status).toBe(400);
    restoreLabelBinds(app);
    const retry = app.browser();
    expect((await retry.recover(name, recoveryCodes[0]!)).result).toBe("ok");
    expect(await retry.json(retry.get("/me"))).toMatchObject({ recordId });
    const labels = await listedLabels(retry);
    expect(labels).toHaveLength(2);
    expect(labels[1]).toBe(savedLabel(retry.authenticator.credentials[0]!));
    await retry.stepUp();
    const revoked = await retry.json(retry.post("/me/credentials/revoke", { label: labels[1] }));
    expect(revoked.passkeyName).toBe(retry.authenticator.credentials[0]!.userName);
  });

  it("when rebinding, leaving the link usable", async () => {
    const app = testApp();
    const operator = app.browser();
    const { recordId: operatorId } = await operator.register(uniqueName("operator"));
    app.vars.OPERATOR_RECORD_IDS = operatorId;
    await operator.stepUp();
    const name = uniqueName("person");
    const { recordId } = await app.browser().register(name);
    const { link } = await operator.json(operator.post("/operator/rebind-links", { recordId }));
    breakLabelBinds(app);

    const refused = refusal(await app.browser().rebind(link));

    expect(refused.status).toBe(400);
    restoreLabelBinds(app);
    const retry = app.browser();
    expect((await retry.rebind(link)).result).toBe("ok");
    expect(await retry.json(retry.get("/me"))).toMatchObject({ recordId });
    const labels = await listedLabels(retry);
    expect(labels).toHaveLength(2);
    expect(labels[1]).toBe(savedLabel(retry.authenticator.credentials[0]!));
  });
});
