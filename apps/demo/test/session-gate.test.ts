import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { counting } from "./failing-namespaces.ts";
import { testApp, uniqueName, type TestApp } from "./harness.ts";

// The identity record applies the session gate (live, or stepped up) itself.
// A session-gated method whose first object call is the record makes that one
// call; a method that must touch another object first checks the gate before
// it, and touches nothing when the gate refuses.

/** Count every call the app makes to identity records from here on. */
function countRecordCalls(app: TestApp): string[] {
  const { namespace, calls } = counting(env.IDENTITY_RECORDS);
  app.vars.IDENTITY_RECORDS = namespace;
  return calls;
}

describe("a session-gated method whose first object is the record", () => {
  it("calls the record once to list a session's passkeys", async () => {
    const app = testApp();
    const browser = app.browser();
    await browser.register(uniqueName());
    const calls = countRecordCalls(app);

    expect((await browser.get("/me/credentials")).status).toBe(200);

    expect(calls).toHaveLength(1);
  });

  it("calls the record once for step-up options", async () => {
    const app = testApp();
    const browser = app.browser();
    await browser.register(uniqueName());
    const calls = countRecordCalls(app);

    expect((await browser.post("/auth/step-up/options")).status).toBe(200);

    expect(calls).toHaveLength(1);
  });

  it("calls the record once to rotate recovery codes", async () => {
    const app = testApp();
    const browser = app.browser();
    await browser.register(uniqueName());
    await browser.stepUp();
    const calls = countRecordCalls(app);

    expect((await browser.post("/me/recovery-codes/rotate")).status).toBe(200);

    expect(calls).toHaveLength(1);
  });

  it("calls the record once for enrol options, before the label is minted", async () => {
    const app = testApp();
    const browser = app.browser();
    await browser.register(uniqueName());
    await browser.stepUp();
    const calls = countRecordCalls(app);

    expect((await browser.post("/me/credentials/enrol/options")).status).toBe(200);

    expect(calls).toHaveLength(1);
  });
});

describe("a method that gates before another object", () => {
  it("mints no label for enrol options when the session is not stepped up", async () => {
    const app = testApp();
    const browser = app.browser();
    await browser.register(uniqueName());
    const labels = counting(env.CREDENTIAL_LABELS);
    app.vars.CREDENTIAL_LABELS = labels.namespace;

    const refused = await browser.post("/me/credentials/enrol/options");

    expect({ status: refused.status, body: await refused.json() }).toEqual({
      status: 403,
      body: { error: "step-up-required" },
    });
    expect(labels.calls).toEqual([]);
  });

  it("resolves no label to revoke when the session is not stepped up", async () => {
    const app = testApp();
    const browser = app.browser();
    await browser.register(uniqueName());
    const labels = counting(env.CREDENTIAL_LABELS);
    app.vars.CREDENTIAL_LABELS = labels.namespace;

    const refused = await browser.post("/me/credentials/revoke", { label: "able-able-able" });

    expect({ status: refused.status, body: await refused.json() }).toEqual({
      status: 403,
      body: { error: "step-up-required" },
    });
    expect(labels.calls).toEqual([]);
  });
});
