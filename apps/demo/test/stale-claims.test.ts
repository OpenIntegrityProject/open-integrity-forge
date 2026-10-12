import { env, runInDurableObject } from "cloudflare:test";
import { CHALLENGE_LIFETIME_MS as CHALLENGE_LIFETIME, memberNameKey, memberNameRegistry } from "passkey-cloudflare";
import { describe, expect, it } from "vitest";
import { testApp, uniqueName, type Browser } from "./harness.ts";

// A registration claims its member name before its record commits. One that
// never completes (the Worker died between the two) leaves the name claimed
// by a record that holds no person. Once no ceremony can still commit to that
// claim, the next check or claim of the name frees it.

const MINUTE = 60 * 1000;

/** The member-name registry, in the storage of the app with this prefix. */
const registry = (storagePrefix: string) => memberNameRegistry(env.MEMBER_NAMES, storagePrefix)();

/** Leave `name` claimed by a new record that holds no person, claimed `age` ago. */
async function claimWithoutPerson(storagePrefix: string, name: string, age: number) {
  await runInDurableObject(registry(storagePrefix), (_instance, state) => {
    const recordId = crypto.randomUUID();
    state.storage.sql.exec(
      "INSERT INTO names (key, name, record_id) VALUES (?, ?, ?)",
      memberNameKey(name),
      name,
      recordId,
    );
    state.storage.sql.exec(
      "INSERT INTO name_history (record_id, name, claimed_at) VALUES (?, ?, ?)",
      recordId,
      name,
      Date.now() - age,
    );
  });
}

/** Move back when a registered member's name was claimed. */
async function ageClaim(storagePrefix: string, name: string, age: number) {
  await runInDurableObject(registry(storagePrefix), (_instance, state) => {
    state.storage.sql.exec("UPDATE name_history SET claimed_at = ? WHERE name = ?", Date.now() - age, name);
  });
}

async function available(browser: Browser, name: string): Promise<boolean> {
  const { available } = await browser.json(browser.get(`/auth/member-name?name=${encodeURIComponent(name)}`));
  return available;
}

describe("a member name claimed by a registration that never completed", () => {
  it("is freed once the claim is older than a challenge's lifetime", async () => {
    const app = testApp();
    const browser = app.browser();
    const name = uniqueName();
    await claimWithoutPerson(app.storagePrefix, name, CHALLENGE_LIFETIME + MINUTE);

    expect(await available(browser, name)).toBe(true);
    await browser.register(name);
    expect(await browser.json(browser.get("/me"))).toMatchObject({ memberName: name });
  });

  it("is freed when registration claims it", async () => {
    const app = testApp();
    const browser = app.browser();
    const name = uniqueName();
    const options = await browser.json(browser.post("/auth/register/options", { memberName: name }));
    const response = await browser.authenticator.create(options);
    await claimWithoutPerson(app.storagePrefix, name, CHALLENGE_LIFETIME + MINUTE);

    expect((await browser.post("/auth/register/verify", { response })).status).toBe(200);
    expect(await browser.json(browser.get("/me"))).toMatchObject({ memberName: name });
  });

  it("is not freed while a ceremony could still commit to it", async () => {
    const app = testApp();
    const browser = app.browser();
    const name = uniqueName();
    await claimWithoutPerson(app.storagePrefix, name, CHALLENGE_LIFETIME - MINUTE);

    expect(await available(browser, name)).toBe(false);
    expect((await browser.post("/auth/register/options", { memberName: name })).status).toBe(409);
  });
});

describe("a member name whose record holds a person", () => {
  it("is not freed however old its claim", async () => {
    const app = testApp();
    const name = uniqueName();
    await app.browser().register(name);
    await ageClaim(app.storagePrefix, name, CHALLENGE_LIFETIME + MINUTE);
    const browser = app.browser();

    expect(await available(browser, name)).toBe(false);
    expect((await browser.post("/auth/register/options", { memberName: name })).status).toBe(409);
  });
});
