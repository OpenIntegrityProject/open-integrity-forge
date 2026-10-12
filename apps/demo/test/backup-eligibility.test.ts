import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { identityRecords, type RecordId } from "passkey-cloudflare";
import type { Tamper } from "passkey-cloudflare/testing";
import { failuresOn } from "./failure-log.ts";
import { refusal, testApp, uniqueName, type TestApp } from "./harness.ts";

// WebAuthn Level 3 section 7.2: a relying party that bases policy on the
// backup-eligible bit (here, exempting synced passkeys from the sign counter)
// refuses an assertion whose bit differs from the one stored at registration.

const REFUSAL = '{"error":"ceremony refused"}';

/** The stored sign counter and last flags of each of a record's credentials, read through its store's adapter. */
function credentialRows(app: TestApp, recordId: string) {
  return runInDurableObject(
    identityRecords(env.IDENTITY_RECORDS, app.storagePrefix)(recordId as RecordId),
    (_instance, state) =>
      state.storage.sql
        .exec<{ sign_count: number; last_flags: number | null }>("SELECT sign_count, last_flags FROM credentials")
        .toArray(),
  );
}

async function registered(app: TestApp, synced: boolean) {
  const browser = app.browser({ backupEligible: synced });
  const { recordId } = await browser.register(uniqueName());
  await browser.login();
  return { browser, recordId };
}

const flips: [string, boolean][] = [
  ["0 to 1", false],
  ["1 to 0", true],
];

describe("an assertion whose backup-eligible bit changed since registration", () => {
  for (const [direction, synced] of flips) {
    const tamper: Tamper = { backupEligible: !synced };
    it(`is refused at login when the bit flipped ${direction}`, async () => {
      const app = testApp();
      const { browser, recordId } = await registered(app, synced);
      const before = await credentialRows(app, recordId);
      browser.session = undefined;

      const response = refusal(await browser.clientAnswering({ tamper }).login());

      expect(response.status).toBe(400);
      expect(await response.text()).toBe(REFUSAL);
      expect(browser.session).toBeUndefined();
      expect(await failuresOn(app.storagePrefix, recordId)).toContainEqual({
        ceremony: "login",
        cause: "backup-eligibility-changed",
      });
      expect(await credentialRows(app, recordId)).toEqual(before);
    });

    it(`is refused at step-up when the bit flipped ${direction}`, async () => {
      const app = testApp();
      const { browser, recordId } = await registered(app, synced);
      const before = await credentialRows(app, recordId);

      const response = refusal(await browser.clientAnswering({ tamper }).stepUp());

      expect(response.status).toBe(400);
      expect(await response.text()).toBe(REFUSAL);
      expect((await browser.post("/me/recovery-codes/rotate")).status).toBe(403);
      expect(await failuresOn(app.storagePrefix, recordId)).toContainEqual({
        ceremony: "step-up",
        cause: "backup-eligibility-changed",
      });
      expect(await credentialRows(app, recordId)).toEqual(before);
    });
  }
});

describe("an assertion whose backup-eligible bit matches the stored one", () => {
  for (const [kind, synced] of [
    ["synced", true],
    ["device-bound", false],
  ] as const) {
    it(`logs in and steps up with a ${kind} passkey`, async () => {
      const app = testApp();
      const { browser } = await registered(app, synced);

      await browser.stepUp();
      browser.session = undefined;
      await browser.login();

      expect((await browser.get("/me")).status).toBe(200);
    });
  }
});
