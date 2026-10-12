import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialHint,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { decodeAttestationObject, decodeCredentialPublicKey, cose } from "@simplewebauthn/server/helpers";
import { fromBase64Url, randomBytes } from "../encoding.ts";
import { CeremonyRefusal } from "../refusal.ts";

// Every login-critical ceremony property is a constant here, never a parameter
// and never a library default.
export const CEREMONY_POLICY = {
  residentKey: "required",
  userVerification: "preferred",
  attestation: "none",
  /** EdDSA (-8) and ES256 (-7) only. */
  algorithms: [-8, -7],
  timeoutMs: 300_000,
} as const;

export interface RelyingParty {
  id: string;
  name: string;
  origin: string;
}

/** A credential as the identity layer stores it, after verification in the Worker. */
export interface VerifiedCredential {
  id: string;
  publicKey: Uint8Array;
  algorithm: number;
  signCount: number;
  /** The authenticator data flags byte from the registration ceremony. */
  registrationFlags: number;
  aaguid: string;
  transports: string[];
}

/** A credential as the options of a ceremony name it: its id and the transports stored at registration. */
export interface CredentialDescriptor {
  id: string;
  transports: string[];
}

/** WebAuthn's descriptor for a credential, leaving out `transports` when none were stored. */
function descriptor(credential: CredentialDescriptor) {
  return credential.transports.length === 0
    ? { id: credential.id }
    : { id: credential.id, transports: credential.transports };
}

export const FLAG_USER_VERIFIED = 0x04;
export const FLAG_BACKUP_ELIGIBLE = 0x08;
export const FLAG_BACKED_UP = 0x10;

/** Whether an authenticator data flags byte says the authenticator verified the person. */
export function isUserVerified(flags: number): boolean {
  return (flags & FLAG_USER_VERIFIED) !== 0;
}

export function newChallenge(): Uint8Array<ArrayBuffer> {
  return randomBytes(32);
}

const HINTS: readonly unknown[] = ["client-device", "hybrid", "security-key"] satisfies PublicKeyCredentialHint[];

/** Whether a value is a WebAuthn client hint: where the browser should offer to save a new passkey. */
function isHint(value: unknown): value is PublicKeyCredentialHint {
  return HINTS.includes(value);
}

export async function creationOptions(input: {
  rp: RelyingParty;
  challenge: Uint8Array<ArrayBuffer>;
  userName: string;
  excludeCredentials?: CredentialDescriptor[];
  /**
   * A client hint, sent as `hints: [hint]`. It only steers the browser's
   * prompt: `authenticatorSelection` stays the same and any destination is
   * accepted. A value from an untyped caller that is not a hint is ignored,
   * and no `hints` are sent.
   */
  hint?: PublicKeyCredentialHint;
}): Promise<PublicKeyCredentialCreationOptionsJSON> {
  // Not the library's preferredAuthenticatorType, which also sets authenticatorAttachment.
  const { hints: _, ...options } = await generateRegistrationOptions({
    rpName: input.rp.name,
    rpID: input.rp.id,
    // A fresh user handle for every ceremony, presented and never stored.
    userID: randomBytes(32),
    userName: input.userName,
    userDisplayName: input.userName,
    challenge: input.challenge,
    timeout: CEREMONY_POLICY.timeoutMs,
    attestationType: CEREMONY_POLICY.attestation,
    excludeCredentials: (input.excludeCredentials ?? []).map(descriptor),
    authenticatorSelection: {
      residentKey: CEREMONY_POLICY.residentKey,
      requireResidentKey: true,
      userVerification: CEREMONY_POLICY.userVerification,
    },
    supportedAlgorithmIDs: [...CEREMONY_POLICY.algorithms],
  });
  return isHint(input.hint) ? { ...options, hints: [input.hint] } : options;
}

export async function requestOptions(input: {
  rp: RelyingParty;
  challenge: Uint8Array<ArrayBuffer>;
  allowCredentials?: CredentialDescriptor[];
}): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: input.rp.id,
    challenge: input.challenge,
    timeout: CEREMONY_POLICY.timeoutMs,
    userVerification: CEREMONY_POLICY.userVerification,
    allowCredentials: (input.allowCredentials ?? []).map(descriptor),
  });
}

function decodeClientData(clientDataJSON: string) {
  return JSON.parse(new TextDecoder().decode(fromBase64Url(clientDataJSON)));
}

/** Read the challenge a client claims to answer, without trusting anything else in it. */
export function claimedChallenge(response: unknown): string {
  try {
    const clientDataJSON = (response as { response: { clientDataJSON: string } }).response.clientDataJSON;
    const clientData = decodeClientData(clientDataJSON);
    if (typeof clientData.challenge !== "string" || clientData.challenge.length === 0) throw new Error();
    return clientData.challenge;
  } catch {
    throw new CeremonyRefusal("malformed-response");
  }
}

/**
 * Refuse a ceremony the browser ran in a frame: crossOrigin true, or any
 * topOrigin. The library expects no framed ceremony, and `@simplewebauthn/server`
 * reads neither field at registration and accepts crossOrigin true without a
 * topOrigin at assertion. Client data that does not parse is left to it.
 */
function refuseFramed(clientDataJSON: string): void {
  let clientData: { crossOrigin?: unknown; topOrigin?: unknown };
  try {
    clientData = decodeClientData(clientDataJSON);
  } catch {
    return;
  }
  if (clientData?.crossOrigin === true || clientData?.topOrigin !== undefined) {
    throw new CeremonyRefusal("cross-origin");
  }
}

function causeOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/origin/i.test(message)) return "wrong-origin";
  if (/RP ID/i.test(message)) return "wrong-rp-id";
  if (/challenge/i.test(message)) return "wrong-challenge";
  if (/signature/i.test(message)) return "bad-signature";
  if (/counter/i.test(message)) return "counter-regressed";
  if (/type/i.test(message)) return "wrong-type";
  if (/user.*present/i.test(message)) return "user-not-present";
  return "verification-failed";
}

/** WebAuthn Level 3, section 7.1: a relying party should refuse a credential ID longer than this. */
const MAX_CREDENTIAL_ID_BYTES = 1023;

export async function verifyRegistration(
  response: RegistrationResponseJSON,
  expected: { rp: RelyingParty; challenge: string },
): Promise<VerifiedCredential> {
  refuseFramed(response.response.clientDataJSON);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: expected.challenge,
      expectedOrigin: expected.rp.origin,
      expectedRPID: expected.rp.id,
      expectedType: "webauthn.create",
      requireUserPresence: true,
      requireUserVerification: false,
      supportedAlgorithmIDs: [...CEREMONY_POLICY.algorithms],
    });
  } catch (error) {
    throw new CeremonyRefusal(causeOf(error));
  }
  if (!verification.verified) throw new CeremonyRefusal("verification-failed");
  const info = verification.registrationInfo;
  if (fromBase64Url(info.credential.id).length > MAX_CREDENTIAL_ID_BYTES) {
    throw new CeremonyRefusal("credential-id-too-long");
  }
  const attestation = decodeAttestationObject(fromBase64Url(response.response.attestationObject));
  const authData = attestation.get("authData");
  const algorithm = decodeCredentialPublicKey(info.credential.publicKey).get(cose.COSEKEYS.alg);
  if (typeof algorithm !== "number") throw new CeremonyRefusal("verification-failed");
  return {
    id: info.credential.id,
    publicKey: info.credential.publicKey,
    algorithm,
    signCount: info.credential.counter,
    registrationFlags: authData[32]!,
    aaguid: info.aaguid,
    transports: (response.response.transports ?? []) as string[],
  };
}

export async function verifyAssertion(
  response: AuthenticationResponseJSON,
  expected: {
    rp: RelyingParty;
    challenge: string;
    credential: { id: string; publicKey: Uint8Array<ArrayBuffer>; signCount: number; enforceCounter: boolean };
  },
): Promise<{ signCount: number; flags: number }> {
  refuseFramed(response.response.clientDataJSON);
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: expected.challenge,
      expectedOrigin: expected.rp.origin,
      expectedRPID: expected.rp.id,
      expectedType: "webauthn.get",
      requireUserVerification: false,
      credential: {
        id: expected.credential.id,
        publicKey: expected.credential.publicKey,
        // A zero stored counter disables the library's monotonic check, which is
        // what synced (backup-eligible) credentials need.
        counter: expected.credential.enforceCounter ? expected.credential.signCount : 0,
      },
    });
  } catch (error) {
    throw new CeremonyRefusal(causeOf(error));
  }
  // The library reports a signature that does not verify as unverified rather than as an error.
  if (!verification.verified) throw new CeremonyRefusal("bad-signature");
  const authData = fromBase64Url(response.response.authenticatorData);
  return { signCount: verification.authenticationInfo.newCounter, flags: authData[32]! };
}
