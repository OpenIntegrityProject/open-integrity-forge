import { env, runInDurableObject } from "cloudflare:test";
import {
  credentialIndex,
  credentialLabels,
  identityRecords,
  type CredentialLabels,
  type RecordId,
} from "passkey-cloudflare";
import { formatRecoveryCodes } from "passkey-cloudflare/browser";
import { decodeTypedBytewords, encodeBytewords } from "passkey-cloudflare/gordian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { counting, overriding } from "./failing-namespaces.ts";
import { prepared, refusal, testApp, uniqueName } from "./harness.ts";
import { PINNED_LABEL, PINNED_LABEL_BYTES, pinLabelDraws, savedLabel } from "./label-draws.ts";

const HOUR = 60 * 60 * 1000;
// Well-formed recovery codes that are never issued.
const WRONG_CODE = "ur:seed/oyadgdinaauyatsojkdmflfdfrfxtpbkvyfrzmcwntvdta";
const OTHER_WRONG_CODE = "tuna next jazz obey acid good iron aqua ugly aunt solo junk drum fuel fund fair flux trip back very fair zoom skew exam eyes epic";

/** A record's labels, in the storage of the app with this prefix. */
const labelsOf = (storagePrefix: string, recordId: string) =>
  credentialLabels(env.CREDENTIAL_LABELS, storagePrefix)(recordId as RecordId);

async function labelRows(storagePrefix: string, recordId: string): Promise<number> {
  return runInDurableObject(
    labelsOf(storagePrefix, recordId),
    (_instance, state) => state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM labels").one().n,
  );
}

/** A record's own object, in the storage of the app with this prefix. */
const recordOf = (storagePrefix: string, recordId: string) =>
  identityRecords(env.IDENTITY_RECORDS, storagePrefix)(recordId as RecordId);

/** Every failure cause recorded on one record, read from its own object. */
function failureCausesOn(storagePrefix: string, recordId: string) {
  return runInDurableObject(recordOf(storagePrefix, recordId), (_instance, state) =>
    state.storage.sql
      .exec<{ cause: string }>("SELECT cause FROM failures")
      .toArray()
      .map((r) => r.cause),
  );
}

/** The record a credential id is indexed to, or null. */
function indexedRecord(storagePrefix: string, credentialId: string) {
  return credentialIndex(env.CREDENTIAL_INDEX, storagePrefix)().get(credentialId);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recovery", () => {
  it("binds a new passkey to the existing record and logs the person in", async () => {
    const app = testApp();
    const name = uniqueName();
    const { recordId, recoveryCodes } = await app.browser().register(name);
    const newDevice = app.browser();

    const recovered = await newDevice.recover(name, recoveryCodes[3]!);

    expect(recovered).toMatchObject({ result: "ok", recordId });
    expect(await newDevice.json(newDevice.get("/me"))).toMatchObject({ recordId, memberName: name });
    newDevice.session = undefined;
    expect((await newDevice.login()).recordId).toBe(recordId);
  });

  it("accepts a code in the word form the page shows for reading aloud", async () => {
    const app = testApp();
    const name = uniqueName();
    const { recordId, recoveryCodes, recoveryCodeWords } = await app.browser().register(name);
    expect(recoveryCodeWords).toHaveLength(recoveryCodes.length);
    for (const words of recoveryCodeWords) expect(words).toMatch(/^[a-z]{4}( [a-z]{4}){22}$/);

    const recovered = await app.browser().recover(name, recoveryCodeWords[2]!);

    expect(recovered).toMatchObject({ result: "ok", recordId });
    // Both forms name one code, so the UR is spent with it.
    expect(refusal(await app.browser().recover(name, recoveryCodes[2]!)).status).toBe(400);
  });

  it("accepts a whole line pasted from the copied codes", async () => {
    const app = testApp();
    const name = uniqueName();
    const { recordId, recoveryCodes, issuedAt } = await app.browser().register(name);
    const text = formatRecoveryCodes({ site: "passkeydemo.gordianstack.com", memberName: name, issuedAt, codes: recoveryCodes });
    const line = text.split("\n").find((l) => l.includes(recoveryCodes[4]!))!;

    const recovered = await app.browser().recover(name, ` ${line}\n`);

    expect(recovered).toMatchObject({ result: "ok", recordId });
    expect(refusal(await app.browser().recover(name, recoveryCodes[4]!)).status).toBe(400);
  });

  it("reports how many unused codes are left after each recovery", async () => {
    const app = testApp();
    const name = uniqueName();
    const { recoveryCodes } = await app.browser().register(name);
    expect(recoveryCodes).toHaveLength(8);

    const first = await app.browser().recover(name, recoveryCodes[0]!);
    expect(first).toMatchObject({ result: "ok", codesLeft: 7 });

    const second = await app.browser().recover(name, recoveryCodes[5]!);
    expect(second).toMatchObject({ result: "ok", codesLeft: 6 });
  });

  it("accepts a code typed in capitals and without its ur:seed/ prefix", async () => {
    const app = testApp();
    const name = uniqueName();
    const { recoveryCodes } = await app.browser().register(name);

    const recovered = await app.browser().recover(name, recoveryCodes[0]!.slice("ur:seed/".length).toUpperCase());

    expect(recovered.result).toBe("ok");
  });

  it("accepts a code read out as words, and spends it in that form too", async () => {
    const app = testApp();
    const name = uniqueName();
    const { recoveryCodes } = await app.browser().register(name);
    const body = decodeTypedBytewords(recoveryCodes[2]!.slice("ur:seed/".length))!;
    const words = encodeBytewords(body, "standard");

    expect((await app.browser().recover(name, words)).result).toBe("ok");
    expect(refusal(await app.browser().recover(name, recoveryCodes[2]!)).status).toBe(400);
  });

  it("refuses text that is no code like a wrong code", async () => {
    const app = testApp();
    const name = uniqueName();
    await app.browser().register(name);

    const refused = refusal(await app.browser().recover(name, "eeee-eeee-eeee-eeee-eeee-eeee"));

    expect(refused.status).toBe(400);
    expect(await refused.text()).toBe('{"error":"ceremony refused"}');
  });

  it("accepts each code only once", async () => {
    const app = testApp();
    const name = uniqueName();
    const { recoveryCodes } = await app.browser().register(name);
    await app.browser().recover(name, recoveryCodes[0]!);

    const again = refusal(await app.browser().recover(name, recoveryCodes[0]!));

    expect(again.status).toBe(400);
  });

  it("refuses a wrong code and binds nothing", async () => {
    const app = testApp();
    const name = uniqueName();
    await app.browser().register(name);
    const attacker = app.browser();

    const refused = refusal(await attacker.recover(name, WRONG_CODE));

    expect(refused.status).toBe(400);
    expect(attacker.session).toBeUndefined();
    const options = await attacker.json(attacker.post("/auth/login/options"));
    const login = await attacker.post("/auth/login/verify", { response: await attacker.authenticator.get(options) });
    expect(login.status).toBe(400);
  });

  it("stops accepting codes replaced by a rotation", async () => {
    const app = testApp();
    const name = uniqueName();
    const person = app.browser();
    const { recoveryCodes } = await person.register(name);
    await person.stepUp();
    await person.post("/me/recovery-codes/rotate");

    const refused = refusal(await app.browser().recover(name, recoveryCodes[0]!));

    expect(refused.status).toBe(400);
  });

  it("allows five attempts per hour for a record", async () => {
    let now = Date.now();
    const app = testApp({ clock: () => now });
    const name = uniqueName();
    const { recoveryCodes } = await app.browser().register(name);
    for (let i = 0; i < 5; i++) {
      expect(refusal(await app.browser().recover(name, OTHER_WRONG_CODE)).status).toBe(400);
    }

    expect(refusal(await app.browser().recover(name, recoveryCodes[0]!)).status).toBe(400);
    now += HOUR + 1;
    expect((await app.browser().recover(name, recoveryCodes[0]!)).result).toBe("ok");
  });

  it("counts a successful recovery once against the record's attempts", async () => {
    const app = testApp();
    const name = uniqueName();
    const { recoveryCodes } = await app.browser().register(name);
    expect((await app.browser().recover(name, recoveryCodes[0]!)).result).toBe("ok");
    for (let i = 0; i < 3; i++) {
      expect(refusal(await app.browser().recover(name, OTHER_WRONG_CODE)).status).toBe(400);
    }

    expect((await app.browser().recover(name, recoveryCodes[1]!)).result).toBe("ok");
    expect(refusal(await app.browser().recover(name, recoveryCodes[2]!)).status).toBe(400);
  });

  it("finds a name typed without its accents or capitals", async () => {
    const app = testApp();
    const suffix = uniqueName("");
    const { recordId, recoveryCodes } = await app.browser().register(`José${suffix}`);
    const newDevice = app.browser();

    const recovered = await newDevice.recover(`jose${suffix}`, recoveryCodes[0]!);

    expect(recovered.result).toBe("ok");
    expect(await newDevice.json(newDevice.get("/me"))).toMatchObject({ recordId, memberName: `José${suffix}` });
  });

  it("refuses an unknown member name like any other refusal", async () => {
    const app = testApp();

    const refused = refusal(await app.browser().recover(uniqueName(), WRONG_CODE));

    expect(refused.status).toBe(400);
    expect(await refused.text()).toBe('{"error":"ceremony refused"}');
  });

  it("stores no label for options on a known member name", async () => {
    const app = testApp();
    const name = uniqueName();
    const { recordId } = await app.browser().register(name);
    const before = await labelRows(app.storagePrefix, recordId);

    for (let i = 0; i < 5; i++) {
      const device = app.browser();
      expect((await device.post("/auth/recover/options", { memberName: name })).status).toBe(200);
    }

    expect(await labelRows(app.storagePrefix, recordId)).toBe(before);
  });

  it("completes on a record whose label namespace is full, where minting gives up", async () => {
    const app = testApp();
    const name = uniqueName();
    const { recordId, recoveryCodes } = await app.browser().register(name);
    const countLabelDraws = pinLabelDraws();
    const device = app.browser();
    const recovery = prepared(await device.client.recoverRequest(name, recoveryCodes[0]!));
    expect(device.authenticator.credentials[0]!.userName).toBe(`${name} (${PINNED_LABEL})`);
    await runInDurableObject(labelsOf(app.storagePrefix, recordId), (_instance, state) => {
      state.storage.sql.exec(
        "INSERT OR IGNORE INTO labels (label, minted_at) VALUES (?, ?)",
        PINNED_LABEL_BYTES,
        Date.now(),
      );
    });

    const drawsBefore = countLabelDraws();
    await runInDurableObject(labelsOf(app.storagePrefix, recordId), (instance) => {
      expect(() => (instance as CredentialLabels).mint(Date.now())).toThrow(/label/);
    });
    const tries = countLabelDraws() - drawsBefore;
    expect(tries).toBeGreaterThan(1);
    expect(tries).toBeLessThanOrEqual(1000);

    const recovered = await device.post(recovery.path, recovery.body);
    expect(recovered.status).toBe(200);
    expect((await recovered.json<any>()).recordId).toBe(recordId);
  });
});

describe("a refused recovery attempt", () => {
  it("with a wrong code, writes no index entry, label or session", async () => {
    const app = testApp();
    const name = uniqueName();
    const { recordId } = await app.browser().register(name);
    const labelsBefore = await labelRows(app.storagePrefix, recordId);
    const indexCalls = counting(env.CREDENTIAL_INDEX);
    app.vars.CREDENTIAL_INDEX = indexCalls.namespace;
    const attacker = app.browser();

    const refused = refusal(await attacker.recover(name, WRONG_CODE));

    expect(refused.status).toBe(400);
    expect(await failureCausesOn(app.storagePrefix, recordId)).toContain("wrong-recovery-code");
    expect(attacker.session).toBeUndefined();
    expect(await labelRows(app.storagePrefix, recordId)).toBe(labelsBefore);
    expect(indexCalls.calls).not.toContain("put");
    expect(await indexedRecord(app.storagePrefix, attacker.authenticator.credentials[0]!.id)).toBeNull();
  });

  it("once the record is throttled, binds no label even for a right code", async () => {
    const app = testApp();
    const name = uniqueName();
    const { recordId, recoveryCodes } = await app.browser().register(name);
    for (let i = 0; i < 5; i++) {
      expect(refusal(await app.browser().recover(name, WRONG_CODE)).status).toBe(400);
    }
    const labelsBefore = await labelRows(app.storagePrefix, recordId);
    const device = app.browser();

    const refused = refusal(await device.recover(name, recoveryCodes[0]!));

    expect(refused.status).toBe(400);
    expect(await failureCausesOn(app.storagePrefix, recordId)).toContain("recovery-throttled");
    expect(await indexedRecord(app.storagePrefix, device.authenticator.credentials[0]!.id)).toBeNull();
    expect(await labelRows(app.storagePrefix, recordId)).toBe(labelsBefore);
  });

  it("racing another recovery with the same code, loses with its passkey neither indexed nor listed", async () => {
    const app = testApp();
    const name = uniqueName();
    const { recordId, recoveryCodes } = await app.browser().register(name);
    const code = recoveryCodes[0]!;
    // Hold the first commit until a second recovery with the same code has
    // finished, so that both pass the code check before either commits.
    let reachedCommit!: () => void;
    const firstAtCommit = new Promise<void>((resolve) => (reachedCommit = resolve));
    let releaseCommit!: () => void;
    const secondDone = new Promise<void>((resolve) => (releaseCommit = resolve));
    let recoverCalls = 0;
    app.vars.IDENTITY_RECORDS = overriding(env.IDENTITY_RECORDS, {
      recover: async (input) => {
        if (recoverCalls++ === 0) {
          reachedCommit();
          await secondDone;
        }
        return recordOf(app.storagePrefix, recordId).recover(input);
      },
    });
    const first = app.browser();
    const second = app.browser();

    const firstAttempt = first.recover(name, code);
    await firstAtCommit;
    const won = await second.recover(name, code);
    releaseCommit();
    const lost = await firstAttempt;

    expect(won.result).toBe("ok");
    expect(refusal(lost).status).toBe(400);
    expect(await failureCausesOn(app.storagePrefix, recordId)).toContain("wrong-recovery-code");
    expect(first.session).toBeUndefined();
    expect(await indexedRecord(app.storagePrefix, first.authenticator.credentials[0]!.id)).toBeNull();
    const { credentials } = await second.json(second.get("/me/credentials"));
    expect(credentials).toHaveLength(2);
    expect(credentials.map((c: any) => c.label)).not.toContain(savedLabel(first.authenticator.credentials[0]!));
  });
});
