// The public key of a new passkey, from its registration response. The
// browser sends the response that it posted to /auth/register/verify or to
// /me/credentials/enrol/verify. The attestation holds the COSE public key.

import { decodeAttestationObject, decodeCredentialPublicKey, parseAuthenticatorData } from "@simplewebauthn/server/helpers";
import { equalBytes, fromBase64Url, sha256, toBase64Url } from "../authority/bytes.ts";
import type { PublicJwk } from "../authority/policy.ts";

/** The JWK of a COSE public key. It accepts only ES256 (P-256) and EdDSA (Ed25519) keys. */
function coseToJwk(cose: Uint8Array): { alg: -7 | -8; jwk: PublicJwk } {
  // The helper gives the map a type with COSE key names. Read it as a plain map with number keys.
  const key = decodeCredentialPublicKey(cose as Uint8Array<ArrayBuffer>) as unknown as Map<number, unknown>;
  const alg = key.get(3);
  const x = key.get(-2);
  if (!(x instanceof Uint8Array)) throw new Error("the COSE key has no x coordinate");
  if (alg === -7) {
    const y = key.get(-3);
    if (key.get(-1) !== 1 || !(y instanceof Uint8Array)) throw new Error("the ES256 key is not on P-256");
    return { alg, jwk: { kty: "EC", crv: "P-256", x: toBase64Url(x), y: toBase64Url(y) } };
  }
  if (alg === -8) {
    if (key.get(-1) !== 6) throw new Error("the EdDSA key is not Ed25519");
    return { alg, jwk: { kty: "OKP", crv: "Ed25519", x: toBase64Url(x) } };
  }
  throw new Error(`the COSE algorithm ${String(alg)} is not ES256 or EdDSA`);
}

interface CapturedKey {
  credentialId: string;
  alg: -7 | -8;
  publicKey: PublicJwk;
}

/**
 * The credential id and public key in a registration response for `rpId`.
 * Throws an error when the response does not hold one, or holds one for
 * another relying party.
 */
export async function keyFromRegistration(response: unknown, rpId: string): Promise<CapturedKey> {
  const r = response as { id?: unknown; response?: { attestationObject?: unknown } } | null;
  if (typeof r?.id !== "string" || typeof r.response?.attestationObject !== "string") {
    throw new Error("not a registration response");
  }
  const authData = decodeAttestationObject(fromBase64Url(r.response.attestationObject)).get("authData");
  const parsed = parseAuthenticatorData(authData);
  if (!equalBytes(parsed.rpIdHash, await sha256(rpId))) throw new Error("the passkey is for another site");
  if (!parsed.credentialID || !parsed.credentialPublicKey) throw new Error("the response holds no new credential");
  const credentialId = toBase64Url(parsed.credentialID);
  if (credentialId !== r.id) throw new Error("the credential id does not match the attestation");
  const { alg, jwk } = coseToJwk(parsed.credentialPublicKey);
  return { credentialId, alg, publicKey: jwk };
}
