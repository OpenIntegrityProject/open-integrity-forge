import { describe, expect, it } from "vitest";
import { operatorRolesFromSecretOrMemberNames } from "../src/operator-member-names.ts";
import { testApp, uniqueName, type HarnessOptions } from "./harness.ts";

/** One person registered under `memberName`, stepped up, and whether the app treats them as an operator. */
async function operatorStatus(options: HarnessOptions, memberName: string) {
  const app = testApp(options);
  const person = app.browser();
  await person.register(memberName);
  await person.stepUp();
  const me = await person.json(person.get("/me"));
  const lookup = await person.post("/operator/lookup", { memberName });
  return { operator: me.operator, lookupStatus: lookup.status };
}

describe("operators named by member name", () => {
  it("are not operators on the production entry, which ignores OPERATOR_MEMBER_NAMES", async () => {
    const memberName = uniqueName("listed");

    const result = await operatorStatus({ vars: { OPERATOR_MEMBER_NAMES: memberName } }, memberName);

    expect(result.operator).toBe(false);
    expect(result.lookupStatus).toBe(403);
  });

  it("are operators on a non-production entry when their name is listed", async () => {
    const memberName = uniqueName("listed");

    const result = await operatorStatus(
      {
        operatorRoles: operatorRolesFromSecretOrMemberNames,
        vars: { OPERATOR_MEMBER_NAMES: ` ${uniqueName("other")} , ${memberName} ,` },
      },
      memberName,
    );

    expect(result.operator).toBe(true);
    expect(result.lookupStatus).toBe(200);
  });

  it("are not operators on a non-production entry when their name is not listed", async () => {
    const result = await operatorStatus(
      { operatorRoles: operatorRolesFromSecretOrMemberNames, vars: { OPERATOR_MEMBER_NAMES: uniqueName("other") } },
      uniqueName("unlisted"),
    );

    expect(result.operator).toBe(false);
    expect(result.lookupStatus).toBe(403);
  });

  it("leave the secret working on a non-production entry", async () => {
    const app = testApp({ operatorRoles: operatorRolesFromSecretOrMemberNames });
    const person = app.browser();
    const memberName = uniqueName("bysecret");
    const { recordId } = await person.register(memberName);
    app.vars.OPERATOR_RECORD_IDS = recordId;
    await person.stepUp();

    expect(await person.json(person.get("/me"))).toMatchObject({ operator: true });
    expect((await person.post("/operator/lookup", { memberName })).status).toBe(200);
  });
});
