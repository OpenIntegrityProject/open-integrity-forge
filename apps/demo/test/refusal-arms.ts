import type { Tamper } from "passkey-cloudflare/testing";
import { prepared, uniqueName, type Browser } from "./browser.ts";

// Every way a ceremony can be refused, each prepared as a request that the
// server must refuse. The invariant test uses them to check that refusals look
// alike; scripts/measure-refusals.ts uses them to time a deployed Worker.

/** A refused ceremony, ready to send: prepare it, then POST `body` to `path`. */
export type Arm = () => Promise<{ path: string; body: unknown }>;

export interface ArmSetup {
  /** A new browser against the target. */
  browser(): Browser;
  /** Suspend the principal with this record id, as an operator would. */
  suspend(recordId: string): Promise<void>;
}

/**
 * Register the people the arms need, then return the arms by name. Each arm
 * can be prepared again and again; the arms that need a fresh challenge or
 * device take one each time.
 */
export async function refusalArms(setup: ArmSetup): Promise<Record<string, Arm>> {
  const name = uniqueName();
  const person = setup.browser();
  await person.register(name);
  await person.login();
  const suspended = setup.browser();
  const { recordId: suspendedId } = await suspended.register(uniqueName());
  await setup.suspend(suspendedId);
  const stranger = setup.browser();
  await stranger.authenticator.create(
    await stranger.json(stranger.post("/auth/register/options", { memberName: uniqueName() })),
  );

  const loginAttempt = (browser: Browser, tamper: Tamper = {}): Arm => async () => {
    return prepared(await browser.clientAnswering({ tamper }).loginRequest());
  };
  // A well-formed recovery code that is never issued: the example secret in
  // the test vectors, as its seed UR.
  const WRONG_CODE = "ur:seed/oyadgdinaauyatsojkdmflfdfrfxtpbkvyfrzmcwntvdta";
  const recoverAttempt = (memberName: string): Arm => async () => {
    return prepared(await setup.browser().client.recoverRequest(memberName, WRONG_CODE));
  };
  const crossPurpose: Arm = async () => {
    const options = await person.json(person.post("/auth/register/options", { memberName: uniqueName() }));
    const login = await person.json(person.post("/auth/login/options"));
    return {
      path: "/auth/login/verify",
      body: { response: await person.authenticator.get({ ...login, challenge: options.challenge }) },
    };
  };

  const tooLongCredentialId: Arm = async () => {
    const browser = setup.browser();
    const options = await browser.json(browser.post("/auth/register/options", { memberName: uniqueName() }));
    return {
      path: "/auth/register/verify",
      body: { response: await browser.authenticator.create(options, { credentialIdLength: 1024 }) },
    };
  };

  return {
    "unknown challenge": loginAttempt(person, { challenge: "dW5rbm93bi1jaGFsbGVuZ2UtdW5rbm93bi1jaGFsbGVuZ2U" }),
    "wrong origin": loginAttempt(person, { origin: "https://evil.example" }),
    "cross origin": loginAttempt(person, { crossOrigin: true }),
    "credential ID too long": tooLongCredentialId,
    "wrong RP ID": loginAttempt(person, { rpId: "evil.example" }),
    "bad signature": loginAttempt(person, { badSignature: true }),
    "regressed sign count": loginAttempt(person, { signCount: 1 }),
    "backup eligibility changed": loginAttempt(person, { backupEligible: true }),
    "cross-purpose challenge": crossPurpose,
    "unknown credential": loginAttempt(stranger),
    "suspended principal": loginAttempt(suspended),
    // A new person each time: a record stops checking codes after a few
    // attempts an hour, and refuses as throttled instead.
    "wrong recovery code": async () => {
      const memberName = uniqueName();
      await setup.browser().register(memberName);
      return recoverAttempt(memberName)();
    },
    "unknown member name": () => recoverAttempt(uniqueName())(),
    "malformed response": async () => ({ path: "/auth/login/verify", body: { response: { id: 7 } } }),
  };
}
