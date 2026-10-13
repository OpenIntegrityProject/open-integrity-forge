import { env, runInDurableObject } from "cloudflare:test";
import { credentialIndex, type CredentialIndex } from "passkey-cloudflare";
import { relyingPartyMatches } from "passkey-cloudflare/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dumpDurableState } from "./durable-state.ts";
import { counting, rejecting } from "./failing-namespaces.ts";
import { globalFailuresFrom } from "./failure-log.ts";
import { ORIGIN, refusal, testApp, uniqueName, type Browser, type TestApp } from "./harness.ts";

// Every passkey is bound to the RP ID it was made for. A deployment stores the
// RP ID its first credential was bound under, and once one is stored, every
// ceremony under another RP ID is refused before it writes anything, with a
// cause and a logged error that name the change. A deployment with no
// credentials has nothing stored, so its RP ID can still change.

const REFUSAL = '{"error":"ceremony refused"}';
const DEMO_RP_ID = new URL(ORIGIN).hostname;
const OLD_RP_ID = "old.example";

afterEach(() => {
  vi.restoreAllMocks();
  relyingPartyMatches.clear();
});

/** The RP ID the app's credential index has stored, or null. */
function storedRpId(app: TestApp): Promise<string | null> {
  return runInDurableObject(credentialIndex(env.CREDENTIAL_INDEX, app.storagePrefix)(), (instance) =>
    (instance as CredentialIndex).rpId(),
  );
}

/**
 * Make the app's storage say its passkeys were made for `OLD_RP_ID`, while the
 * app and its passkeys go on using the demo's RP ID, so every ceremony would
 * otherwise succeed. Forgets every RP ID already seen to match, as a new
 * isolate would.
 */
async function pinOldRpId(app: TestApp) {
  await runInDurableObject(credentialIndex(env.CREDENTIAL_INDEX, app.storagePrefix)(), (_instance, state) => {
    state.storage.sql.exec("UPDATE relying_party SET rp_id = ?", OLD_RP_ID);
  });
  relyingPartyMatches.clear();
}

/** Everything at rest but the failure logs, which a refusal writes. */
async function storedState(): Promise<string> {
  const dump = await dumpDurableState([
    "IDENTITY_RECORDS",
    "CREDENTIAL_INDEX",
    "CREDENTIAL_LABELS",
    "MEMBER_NAMES",
    "CHALLENGES",
    "RATE_LIMITS",
  ]);
  return dump
    .split("\n")
    .filter((line) => !line.startsWith("IDENTITY_RECORDS failures "))
    .join("\n");
}

/**
 * Run the ceremony, whose final request to `verifyPath` must be refused: told
 * uniformly, writing nothing, and recorded and logged with its cause. The
 * state is read just before that request, after the ceremony's options.
 */
async function expectRefusedUnchanged(
  app: TestApp,
  browser: Browser,
  ceremony: string,
  verifyPath: string,
  run: () => Promise<Response>,
) {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const send = browser.send.bind(browser);
  let before: string | undefined;
  vi.spyOn(browser, "send").mockImplementation(async (request) => {
    if (new URL(request.url).pathname === verifyPath) before = await storedState();
    return send(request);
  });

  const response = await run();

  expect(response.status).toBe(400);
  expect(await response.text()).toBe(REFUSAL);
  expect(before).toBeDefined();
  expect(await storedState()).toBe(before);
  expect(await globalFailuresFrom(app.storagePrefix, browser)).toContainEqual({ ceremony, cause: "rp-id-changed" });
  const logged = errors.mock.calls.map((call) => call.join(" ")).filter((line) => line.includes(OLD_RP_ID));
  expect(logged).toHaveLength(1);
  expect(logged[0]).toContain(DEMO_RP_ID);
}

describe("the RP ID a deployment's passkeys were made for", () => {
  it("is stored when the first record is created, and later records leave it", async () => {
    const app = testApp();
    expect(await storedRpId(app)).toBeNull();

    await app.browser().register(uniqueName());
    expect(await storedRpId(app)).toBe(DEMO_RP_ID);

    app.vars.RP_ID = OLD_RP_ID;
    refusal(await app.browser().client.register(uniqueName()));
    expect(await storedRpId(app)).toBe(DEMO_RP_ID);
  });

  it("can change while the deployment has no records, and the one in use is stored", async () => {
    const app = testApp({ vars: { RP_ID: OLD_RP_ID } });
    const name = uniqueName();
    await app.browser().clientAnswering().memberNameAvailable(name);
    expect(await storedRpId(app)).toBeNull();

    app.vars.RP_ID = DEMO_RP_ID;
    await app.browser().register(name);

    expect(await storedRpId(app)).toBe(DEMO_RP_ID);
  });

  it("is not stored by a first registration that is refused after its credential is indexed", async () => {
    const app = testApp({ vars: { RP_ID: OLD_RP_ID } });
    app.vars.IDENTITY_RECORDS = rejecting(env.IDENTITY_RECORDS, "createPerson");
    vi.spyOn(console, "error").mockImplementation(() => {});

    refusal(await app.browser().client.register(uniqueName()));
    expect(await storedRpId(app)).toBeNull();

    delete app.vars.IDENTITY_RECORDS;
    app.vars.RP_ID = DEMO_RP_ID;
    await app.browser().register(uniqueName());
    expect(await storedRpId(app)).toBe(DEMO_RP_ID);
  });

  it("is read once per isolate while it matches, so later ceremonies make no call for it", async () => {
    const app = testApp();
    const browser = app.browser();
    await browser.register(uniqueName());
    browser.session = undefined;
    await browser.login();
    const index = counting(env.CREDENTIAL_INDEX);
    app.vars.CREDENTIAL_INDEX = index.namespace;

    browser.session = undefined;
    await browser.login();

    expect(index.calls).toEqual(["get"]);
  });

  it("is kept apart for apps with different storage prefixes", async () => {
    const first = testApp();
    const second = testApp({ vars: { RP_ID: OLD_RP_ID } });
    const firstBrowser = first.browser();
    const secondBrowser = second.browser();

    await firstBrowser.register(uniqueName());
    await secondBrowser.register(uniqueName());
    firstBrowser.session = undefined;
    secondBrowser.session = undefined;
    await firstBrowser.login();
    await secondBrowser.login();

    expect(await storedRpId(first)).toBe(DEMO_RP_ID);
    expect(await storedRpId(second)).toBe(OLD_RP_ID);
  });
});

describe("a ceremony under an RP ID other than the stored one is refused as rp-id-changed, writing nothing", () => {
  it("at registration", async () => {
    const app = testApp();
    await app.browser().register(uniqueName());
    const browser = app.browser();
    const name = uniqueName();
    await pinOldRpId(app);

    await expectRefusedUnchanged(app, browser, "register", "/auth/register/verify", async () =>
      refusal(await browser.client.register(name)),
    );
    expect(browser.session).toBeUndefined();
  });

  it("at login", async () => {
    const app = testApp();
    const browser = app.browser();
    await browser.register(uniqueName());
    browser.session = undefined;
    await pinOldRpId(app);

    await expectRefusedUnchanged(app, browser, "login", "/auth/login/verify", async () =>
      refusal(await browser.client.login()),
    );
    expect(browser.session).toBeUndefined();
  });

  it("at step-up", async () => {
    const app = testApp();
    const browser = app.browser();
    await browser.register(uniqueName());
    await pinOldRpId(app);

    await expectRefusedUnchanged(app, browser, "step-up", "/auth/step-up/verify", async () =>
      refusal(await browser.client.stepUp()),
    );
  });

  it("when adding a passkey", async () => {
    const app = testApp();
    const browser = app.browser();
    await browser.register(uniqueName());
    await browser.stepUp();
    await pinOldRpId(app);

    await expectRefusedUnchanged(app, browser, "enrol", "/me/credentials/enrol/verify", async () =>
      refusal(await browser.client.enrol()),
    );
  });

  it("when recovering", async () => {
    const app = testApp();
    const name = uniqueName();
    const { recoveryCodes } = await app.browser().register(name);
    const newDevice = app.browser();
    await pinOldRpId(app);

    await expectRefusedUnchanged(app, newDevice, "recover", "/auth/recover", async () =>
      refusal(await newDevice.client.recover(name, recoveryCodes[0]!)),
    );
    expect(newDevice.session).toBeUndefined();
  });

  it("when rebinding", async () => {
    const app = testApp();
    const operator = app.browser();
    const { recordId: operatorId } = await operator.register(uniqueName("operator"));
    app.vars.OPERATOR_RECORD_IDS = operatorId;
    await operator.stepUp();
    const { recordId } = await app.browser().register(uniqueName("person"));
    const { link } = await operator.json(operator.post("/operator/rebind-links", { recordId }));
    const newDevice = app.browser();
    await pinOldRpId(app);

    await expectRefusedUnchanged(app, newDevice, "rebind", "/auth/rebind/verify", async () =>
      refusal(await newDevice.client.rebind(new URL(link).hash.slice(1))),
    );
    expect(newDevice.session).toBeUndefined();
  });
});
