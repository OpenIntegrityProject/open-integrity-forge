import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { identityRecords, type RecordId } from "passkey-cloudflare";
import { dumpDurableState } from "./durable-state.ts";
import { failuresOn, globalFailuresFrom } from "./failure-log.ts";
import { refusal, testApp, uniqueName, type TestApp } from "./harness.ts";

// WebAuthn Level 3, section 6.1.3: a credential that is not backup eligible
// cannot be backed up, so the pair BS set with BE clear is invalid.
// @simplewebauthn/server throws on it, and registration and assertion turn
// that into a refusal. These tests keep a dependency upgrade that stopped
// throwing from passing the suite.

const REFUSAL = '{"error":"ceremony refused"}';
const TAMPER = { backedUpWithoutEligibility: true };

/** The stored sign counter and last flags of each of a record's credentials. */
function credentialRows(app: TestApp, recordId: string) {
  return runInDurableObject(
    identityRecords(env.IDENTITY_RECORDS, app.storagePrefix)(recordId as RecordId),
    (_instance, state) =>
      state.storage.sql
        .exec<{ sign_count: number; last_flags: number | null }>("SELECT sign_count, last_flags FROM credentials")
        .toArray(),
  );
}

describe("a response that sets backed up without backup eligibility", () => {
  it("is refused at registration", async () => {
    const app = testApp();
    const browser = app.browser();

    const response = refusal(await browser.clientAnswering({ tamper: TAMPER }).register(uniqueName()));

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(REFUSAL);
    expect(browser.session).toBeUndefined();
    expect(await globalFailuresFrom(app.storagePrefix, browser)).toContainEqual({
      ceremony: "register",
      cause: "verification-failed",
    });
    const credentialId = browser.authenticator.credentials.at(-1)!.id;
    expect(await dumpDurableState(["IDENTITY_RECORDS", "CREDENTIAL_INDEX"])).not.toContain(credentialId);
  });

  it("is refused at login", async () => {
    const app = testApp();
    const browser = app.browser();
    const { recordId } = await browser.register(uniqueName());
    const before = await credentialRows(app, recordId);
    browser.session = undefined;

    const response = refusal(await browser.clientAnswering({ tamper: TAMPER }).login());

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(REFUSAL);
    expect(browser.session).toBeUndefined();
    expect(await failuresOn(app.storagePrefix, recordId)).toContainEqual({
      ceremony: "login",
      cause: "verification-failed",
    });
    expect(await credentialRows(app, recordId)).toEqual(before);
  });
});
