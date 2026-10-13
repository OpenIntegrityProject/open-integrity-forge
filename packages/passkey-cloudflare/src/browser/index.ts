// The browser half of each ceremony (ADR 0006): takes the WebAuthn options
// JSON the application fetched and returns the response JSON it posts back.
// It makes no requests. It declares the little of the WebAuthn API it uses
// rather than depend on the DOM library, so it typechecks in any program.

import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialHint,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

import { fromBase64Url, toBase64Url } from "../base64url.ts";

export { fromBase64Url, toBase64Url };
export {
  CAPITAL_NUDGE_MESSAGE,
  MEMBER_NAME_RULES,
  isValidMemberName,
  memberNameKey,
  needsCapitalNudge,
} from "../member-name-rules.ts";
export { formatRecoveryCodes, recoveryCodesHeader, type RecoveryCodesText } from "./recovery-codes.ts";
export type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialHint,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
};

interface WebAuthnGlobals {
  navigator: {
    credentials: {
      create(options: { publicKey: unknown }): Promise<unknown>;
      get(options: { publicKey: unknown; mediation?: string; uiMode?: string; signal?: unknown }): Promise<unknown>;
    };
  };
  PublicKeyCredential?: {
    getClientCapabilities?(): Promise<Record<string, boolean | undefined>>;
    isConditionalMediationAvailable?(): Promise<boolean>;
    signalUnknownCredential?(passkey: UnknownPasskey): Promise<void>;
  };
}

const webAuthn = () => globalThis as unknown as WebAuthnGlobals;

/** The options `navigator.credentials.create` takes, from their JSON. */
export function creationOptionsFromJSON(json: PublicKeyCredentialCreationOptionsJSON) {
  return {
    ...json,
    challenge: fromBase64Url(json.challenge),
    user: { ...json.user, id: fromBase64Url(json.user.id) },
    excludeCredentials: (json.excludeCredentials ?? []).map((c) => ({ ...c, id: fromBase64Url(c.id) })),
  };
}

/** The options `navigator.credentials.get` takes, from their JSON. */
export function requestOptionsFromJSON(json: PublicKeyCredentialRequestOptionsJSON) {
  return {
    ...json,
    challenge: fromBase64Url(json.challenge),
    allowCredentials: (json.allowCredentials ?? []).map((c) => ({ ...c, id: fromBase64Url(c.id) })),
  };
}

/**
 * Whether a find can end without a sheet: with immediate mediation, a browser
 * with no passkey here for the site answers at once. Without it, the only way
 * to learn there is none is a sheet the person must cancel.
 */
export async function canFindWithoutSheet(): Promise<boolean> {
  try {
    const capabilities = await webAuthn().PublicKeyCredential?.getClientCapabilities?.();
    return capabilities?.immediateGet === true;
  } catch {
    return false;
  }
}

/**
 * Whether the browser can offer this site's passkeys in a form field's
 * autofill (conditional mediation), for `autofillPasskey`. Asks
 * `getClientCapabilities` where the browser has it, and the older
 * `isConditionalMediationAvailable` where not.
 */
export async function canAutofillPasskey(): Promise<boolean> {
  try {
    const credential = webAuthn().PublicKeyCredential;
    if (credential?.getClientCapabilities) {
      return (await credential.getClientCapabilities()).conditionalGet === true;
    }
    return (await credential?.isConditionalMediationAvailable?.()) === true;
  } catch {
    return false;
  }
}

/** A passkey as the Signals API names it: the RP ID it was made for and its credential ID, base64url. */
export interface UnknownPasskey {
  rpId: string;
  credentialId: string;
}

/**
 * Tell the password manager a revoked passkey is gone, so it stops offering
 * it, where the browser has the Signals API. Call it only after a revoke the
 * server confirmed, never after a refused login: there it would tell the
 * browser the cause the uniform refusal hides. A manager may ignore the
 * signal, so the application still tells the person to delete the passkey.
 * Never throws.
 */
export async function signalRevokedPasskey(revoked: UnknownPasskey): Promise<void> {
  try {
    await webAuthn().PublicKeyCredential?.signalUnknownCredential?.({
      rpId: revoked.rpId,
      credentialId: revoked.credentialId,
    });
  } catch {
    // The signal is advice; the revoke has already happened.
  }
}

export type FindResult = { result: "found"; response: AuthenticationResponseJSON } | { result: "not-found" };

// The two ways a browser may spell an immediate request: the proposal's
// mediation value, and Chrome's `uiMode`, which rejects the other as a TypeError.
const IMMEDIATE_SPELLINGS = [{ mediation: "immediate" }, { uiMode: "immediate" }];

/**
 * Ask for any passkey this site knows, with immediate mediation where the
 * browser supports it. An immediate request needs the click's user activation
 * and rejects at once with no sheet when there is no passkey here for the
 * site, and with the same error when the person dismisses the picker, so
 * not-found cannot tell the two apart. A browser that rejects every spelling
 * as malformed falls back to an ordinary request.
 */
export async function findPasskey(options: PublicKeyCredentialRequestOptionsJSON): Promise<FindResult> {
  if (await canFindWithoutSheet()) {
    for (const spelling of IMMEDIATE_SPELLINGS) {
      try {
        return await get(options, spelling);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }
    }
  }
  return get(options);
}

/** Ask for a passkey through the browser's ordinary sheet, as step-up does. */
export async function usePasskey(options: PublicKeyCredentialRequestOptionsJSON): Promise<FindResult> {
  return get(options);
}

/**
 * Offer this site's passkeys in the autofill of an input whose autocomplete
 * includes `webauthn`, until the person picks one or `signal` aborts the
 * request. Browsers allow one WebAuthn request at a time, so abort this one
 * before starting any other. Returns not-found when aborted.
 */
export async function autofillPasskey(
  options: PublicKeyCredentialRequestOptionsJSON,
  signal: AbortSignal,
): Promise<FindResult> {
  return get(options, { mediation: "conditional", signal });
}

/** One get; a TypeError is thrown for findPasskey to try the next spelling. */
async function get(options: PublicKeyCredentialRequestOptionsJSON, spelling = {}): Promise<FindResult> {
  let credential;
  try {
    credential = await webAuthn().navigator.credentials.get({ publicKey: requestOptionsFromJSON(options), ...spelling });
  } catch (error) {
    if (declined(error)) return { result: "not-found" };
    throw error;
  }
  return { result: "found", response: credentialToJSON(credential) as AuthenticationResponseJSON };
}

/** What a browser's PublicKeyCredential holds, as far as its JSON needs. */
interface BrowserCredential {
  id: string;
  rawId: ArrayBuffer;
  type: RegistrationResponseJSON["type"];
  response: {
    clientDataJSON: ArrayBuffer;
    attestationObject?: ArrayBuffer;
    getTransports?(): string[];
    authenticatorData?: ArrayBuffer;
    signature?: ArrayBuffer;
    userHandle?: ArrayBuffer | null;
  };
  getClientExtensionResults(): RegistrationResponseJSON["clientExtensionResults"];
  authenticatorAttachment?: RegistrationResponseJSON["authenticatorAttachment"] | null;
  toJSON?(): RegistrationResponseJSON | AuthenticationResponseJSON;
}

/**
 * The JSON a server verifies, from the credential a browser returned. Uses the
 * browser's own toJSON where it has one, and builds the same shape where not.
 */
export function credentialToJSON(credential: unknown): RegistrationResponseJSON | AuthenticationResponseJSON {
  const c = credential as BrowserCredential | null;
  if (!c) throw new Error("no public-key credential returned");
  if (typeof c.toJSON === "function") return c.toJSON();
  const r = c.response;
  const clientDataJSON = toBase64Url(new Uint8Array(r.clientDataJSON));
  const common = {
    id: c.id,
    rawId: toBase64Url(new Uint8Array(c.rawId)),
    type: c.type,
    clientExtensionResults: c.getClientExtensionResults(),
    authenticatorAttachment: c.authenticatorAttachment ?? undefined,
  };
  if (r.attestationObject) {
    const transports = r.getTransports?.() ?? [];
    return { ...common, response: { clientDataJSON, attestationObject: toBase64Url(new Uint8Array(r.attestationObject)), transports } };
  }
  if (!r.authenticatorData || !r.signature) throw new Error("credential response is neither an attestation nor an assertion");
  return {
    ...common,
    response: {
      clientDataJSON,
      authenticatorData: toBase64Url(new Uint8Array(r.authenticatorData)),
      signature: toBase64Url(new Uint8Array(r.signature)),
      ...(r.userHandle ? { userHandle: toBase64Url(new Uint8Array(r.userHandle)) } : {}),
    },
  };
}

export type CreateResult =
  | { result: "created"; response: RegistrationResponseJSON }
  | { result: "not-created" }
  | { result: "already-registered" };

/** Make a passkey, for registration, recovery, rebinding or enrolment. */
export async function createPasskey(options: PublicKeyCredentialCreationOptionsJSON): Promise<CreateResult> {
  let credential;
  try {
    credential = await webAuthn().navigator.credentials.create({ publicKey: creationOptionsFromJSON(options) });
  } catch (error) {
    if (declined(error)) return { result: "not-created" };
    // The authenticator holds one of the options' excludeCredentials.
    if (errorName(error) === "InvalidStateError") return { result: "already-registered" };
    throw error;
  }
  return { result: "created", response: credentialToJSON(credential) as RegistrationResponseJSON };
}

const errorName = (error: unknown) => (error as { name?: unknown } | null | undefined)?.name;

/** Browsers give these whether the person dismissed the sheet or there was nothing to use. */
const declined = (error: unknown) => errorName(error) === "NotAllowedError" || errorName(error) === "AbortError";
