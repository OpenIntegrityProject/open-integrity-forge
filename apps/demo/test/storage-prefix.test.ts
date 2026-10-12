import { env } from "cloudflare:test";
import {
  ceremonyFailures,
  challengeStores,
  credentialIndex,
  credentialLabels,
  DEFAULT_RATE_LIMITS,
  identityRecords,
  memberNameRegistry,
  prefixedName,
  rateLimiters,
  type RecordId,
} from "passkey-cloudflare";
import { describe, expect, it } from "vitest";
import { operatorLog } from "../src/operator-log.ts";
import { Browser, testApp, uniqueName } from "./harness.ts";

const recordId = crypto.randomUUID() as RecordId;
const hash = "c0ffee";

/** The name each adapter gives an instance under `storagePrefix`, read back from the stub's id. */
function instanceNames(storagePrefix?: string) {
  return {
    record: identityRecords(env.IDENTITY_RECORDS, storagePrefix)(recordId).id.name,
    index: credentialIndex(env.CREDENTIAL_INDEX, storagePrefix)().id.name,
    names: memberNameRegistry(env.MEMBER_NAMES, storagePrefix)().id.name,
    labels: credentialLabels(env.CREDENTIAL_LABELS, storagePrefix)(recordId).id.name,
    challenges: challengeStores(env.CHALLENGES, storagePrefix)(hash).id.name,
    rateLimit: rateLimiters(env.RATE_LIMITS, storagePrefix)("ceremony:global").id.name,
    failures: ceremonyFailures(env.CEREMONY_FAILURES, storagePrefix)().id.name,
    operatorLog: operatorLog(env.OPERATOR_LOG, storagePrefix)().id.name,
  };
}

describe("storage prefix", () => {
  it("leaves every instance its unprefixed name when no prefix is given", () => {
    const unprefixed = {
      record: recordId,
      index: "global",
      names: "global",
      labels: recordId,
      challenges: "challenges-c",
      rateLimit: "ceremony:global",
      failures: "global",
      operatorLog: "global",
    };

    expect(instanceNames()).toEqual(unprefixed);
    expect(instanceNames("")).toEqual(unprefixed);
  });

  it("puts every instance under a prefix's own name", () => {
    const names = Object.values(instanceNames("some-prefix"));
    const others = Object.values(instanceNames("other-prefix"));

    for (const name of names) expect(name).toMatch(/^some-prefix\//);
    for (const name of others) expect(names).not.toContain(name);
  });

  it("refuses to prefix a name that holds the separator, which could collide", () => {
    expect(() => prefixedName("some-prefix", "a/b")).toThrow();
    expect(prefixedName(undefined, "a/b")).toBe("a/b");
  });

  it("keeps a member name registered under one prefix available under another", async () => {
    const memberName = uniqueName("prefixed");
    await testApp().browser().register(memberName);

    const other = testApp().browser();
    await expect(other.register(memberName)).resolves.toMatchObject({ recordId: expect.any(String) });
  });

  it("keeps a full global rate-limit bucket under one prefix from refusing under another", async () => {
    const rateLimits = { ceremonyGlobal: { ...DEFAULT_RATE_LIMITS.ceremonyGlobal, limit: 1 } };
    const full = testApp({ rateLimits });
    // One completion, admitted or not, fills a bucket of one.
    await full
      .browser()
      .register(uniqueName("first"))
      .catch(() => {});
    await expect(full.browser().register(uniqueName("second"))).rejects.toThrow(/ceremony refused/);

    await expect(testApp({ rateLimits }).browser().register(uniqueName("elsewhere"))).resolves.toMatchObject({
      recordId: expect.any(String),
    });
  });

  it("shares storage between apps given the same prefix", async () => {
    const storagePrefix = crypto.randomUUID();
    const registering = testApp({ storagePrefix }).browser();
    const { recordId } = await registering.register(uniqueName("shared"));

    const elsewhere = new Browser(testApp({ storagePrefix }), registering.authenticator);
    expect(await elsewhere.login()).toMatchObject({ recordId });
  });
});
