import { env, runInDurableObject } from "cloudflare:test";
import {
  IdentityRecord,
  identityRecords,
  MemberNameRegistry,
  memberNameRegistry,
  type RecordId,
} from "passkey-cloudflare";
import { describe, expect, it } from "vitest";
import { testApp, uniqueName } from "./harness.ts";

// A deployed object keeps the tables it was created with: CREATE TABLE IF NOT
// EXISTS does not add a column the schema gained later. These tests take a
// column away, as storage created before it would lack it, then start the
// object again and use it through HTTP.

describe("storage created before a column was added", () => {
  it("still serves an identity record that lacks removed_at", async () => {
    const app = testApp();
    const browser = app.browser();
    const { recordId } = await browser.register(uniqueName("old"));
    const stub = identityRecords(env.IDENTITY_RECORDS, app.storagePrefix)(recordId as RecordId);

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("ALTER TABLE record DROP COLUMN removed_at");
      new IdentityRecord(state, env);
    });

    expect(await browser.json(browser.get("/me"))).toMatchObject({ recordId });
  });

  it("still serves a member-name registry whose history lacks retired_at", async () => {
    const app = testApp();
    const operator = app.browser();
    const operatorName = uniqueName("operator");
    const { recordId: operatorId } = await operator.register(operatorName);
    app.vars.OPERATOR_RECORD_IDS = operatorId;
    await operator.stepUp();

    await runInDurableObject(memberNameRegistry(env.MEMBER_NAMES, app.storagePrefix)(), (_instance, state) => {
      state.storage.sql.exec("ALTER TABLE name_history DROP COLUMN retired_at");
      new MemberNameRegistry(state, env);
    });

    const lookup = await operator.post("/operator/lookup", { memberName: operatorName });
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toMatchObject({ recordId: operatorId, retired: false });
  });
});
