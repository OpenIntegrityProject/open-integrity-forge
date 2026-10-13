// SSH signatures made by a passkey: OpenSSH's webauthn-sk-ecdsa format, which
// holds a WebAuthn assertion whose challenge is the SSHSIG data to be signed.
// `ssh-keygen -Y verify` and `git verify-commit` check these with no change.
// Specification: PROTOCOL.u2f and PROTOCOL.sshsig in the OpenSSH source.

import { concat, equalBytes, fromBase64, fromBase64Url, fromUtf8, sha256, toBase64, toBase64Url, utf8 } from "./bytes.ts";
import type { PublicJwk } from "./policy.ts";
import { armor, BEGIN, END, MAGIC, Reader, signedData, sshString, uint32 } from "./sshsig.ts";

export const SK_KEY_TYPE = "sk-ecdsa-sha2-nistp256@openssh.com";
export const WEBAUTHN_SIG_TYPE = "webauthn-sk-ecdsa-sha2-nistp256@openssh.com";
const HASH = "sha512";
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;

/**
 * A P-256 passkey as an OpenSSH security key: the curve point and the
 * application, which is the relying party ID, since OpenSSH compares its
 * SHA-256 with the authenticator data's rpIdHash.
 */
export function skPublicKeyBlob(jwk: PublicJwk, rpId: string): Uint8Array<ArrayBuffer> {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.y) throw new Error("an SSH signature needs a P-256 passkey");
  const point = concat(new Uint8Array([4]), fromBase64Url(jwk.x), fromBase64Url(jwk.y));
  return concat(sshString(SK_KEY_TYPE), sshString("nistp256"), sshString(point), sshString(rpId));
}

/** `sk-ecdsa-sha2-nistp256@openssh.com AAAA...`, as an allowed signers file lists it. */
export function skPublicKeyText(blob: Uint8Array): string {
  return `${SK_KEY_TYPE} ${toBase64(blob)}`;
}

/** The fingerprint ssh-keygen shows for a key blob. */
export async function blobFingerprint(blob: Uint8Array): Promise<string> {
  return "SHA256:" + toBase64(await sha256(blob)).replace(/=+$/, "");
}

/** The WebAuthn challenge that makes a passkey sign `message` as an SSH signature: the SSHSIG data, base64url. */
export async function sshChallenge(message: Uint8Array | string, namespace = "git"): Promise<string> {
  return toBase64Url(await signedData(namespace, typeof message === "string" ? utf8(message) : message));
}

/** An ASN.1 DER ECDSA signature as its two integers. */
function derIntegers(der: Uint8Array): [Uint8Array, Uint8Array] {
  if (der[0] !== 0x30) throw new Error("not a DER signature");
  let offset = der[1]! < 0x80 ? 2 : 2 + (der[1]! & 0x7f);
  const part = () => {
    if (der[offset] !== 0x02) throw new Error("not a DER signature");
    const length = der[offset + 1]!;
    const value = der.slice(offset + 2, offset + 2 + length);
    offset += 2 + length;
    return value;
  };
  return [part(), part()];
}

/** An SSH mpint: no leading zeros, and one zero byte where the high bit is set. */
function mpint(value: Uint8Array): Uint8Array {
  let i = 0;
  while (i < value.length - 1 && value[i] === 0) i++;
  const trimmed = value.slice(i);
  return sshString(trimmed[0]! & 0x80 ? concat(new Uint8Array([0]), trimmed) : trimmed);
}

/**
 * The armored SSH signature for a passkey assertion over the SSHSIG data of a
 * message. Each binary field of the assertion is base64url, as the browser's
 * JSON gives it. clientDataJSON is kept byte for byte: the signature covers it.
 */
export function webauthnSignature(
  keyBlob: Uint8Array,
  assertion: { authenticatorData: string; clientDataJSON: string; signature: string },
  namespace = "git",
): string {
  const authData = fromBase64Url(assertion.authenticatorData);
  const clientData = fromBase64Url(assertion.clientDataJSON);
  const origin = String(JSON.parse(fromUtf8(clientData)).origin);
  const [r, s] = derIntegers(fromBase64Url(assertion.signature));
  const signature = concat(
    sshString(WEBAUTHN_SIG_TYPE),
    sshString(concat(mpint(r), mpint(s))),
    authData.slice(32, 33),
    authData.slice(33, 37),
    sshString(origin),
    sshString(clientData),
    sshString(authData.slice(37)),
  );
  return armor(
    concat(MAGIC, uint32(1), sshString(keyBlob), sshString(namespace), sshString(""), sshString(HASH), sshString(signature)),
  );
}

/** A 32-byte big-endian integer from an SSH mpint body. */
function fixed32(value: Uint8Array): Uint8Array {
  let i = 0;
  while (i < value.length && value[i] === 0) i++;
  const trimmed = value.slice(i);
  if (trimmed.length > 32) throw new Error("bad ECDSA signature");
  const out = new Uint8Array(32);
  out.set(trimmed, 32 - trimmed.length);
  return out;
}

/**
 * The WebAuthn assertion inside a webauthn-sk signature, as the browser gave
 * it: authenticator data, clientDataJSON and the DER signature, base64url.
 * Null when the signature is not of this kind.
 */
export async function webauthnAssertion(armored: string): Promise<{ authenticatorData: string; clientDataJSON: string; signature: string } | null> {
  try {
    const text = armored.trim();
    const reader = new Reader(fromBase64(text.slice(BEGIN.length, -END.length)));
    reader.take(10);
    const key = new Reader(reader.string());
    reader.string();
    reader.string();
    reader.string();
    const sig = new Reader(reader.string());
    if (key.text() !== SK_KEY_TYPE || sig.text() !== WEBAUTHN_SIG_TYPE) return null;
    key.string();
    key.string();
    const rpId = key.text();
    const ecdsa = new Reader(sig.string());
    const [r, s] = [ecdsa.string(), ecdsa.string()];
    const flagsAndCounter = sig.take(5);
    sig.string();
    const clientData = sig.string();
    const extensions = sig.string();
    const der = (n: Uint8Array) => concat(new Uint8Array([0x02, n.length]), n);
    const body = concat(der(r), der(s));
    return {
      authenticatorData: toBase64Url(concat(await sha256(rpId), flagsAndCounter, extensions)),
      clientDataJSON: toBase64Url(clientData),
      signature: toBase64Url(concat(new Uint8Array([0x30, body.length]), body)),
    };
  } catch {
    return null;
  }
}

export type WebauthnCheck =
  | { ok: true; keyBlob: Uint8Array; fingerprint: string; rpId: string; origin: string; flags: number }
  | { ok: false; reason: string };

/**
 * Check an armored webauthn-sk signature over `message`, as OpenSSH does, and
 * also require that the person was present and verified. It returns the key
 * that made it; the caller decides whether it trusts that key.
 */
export async function verifyWebauthn(armored: string, message: Uint8Array | string, namespace = "git"): Promise<WebauthnCheck> {
  const no = (reason: string): WebauthnCheck => ({ ok: false, reason });
  try {
    const text = armored.trim();
    if (!text.startsWith(BEGIN) || !text.endsWith(END)) return no("The signature is not an SSH signature.");
    const reader = new Reader(fromBase64(text.slice(BEGIN.length, -END.length)));
    if (!equalBytes(reader.take(6), MAGIC) || reader.uint32() !== 1) return no("The signature is not an SSH signature.");
    const keyBlob = reader.string();
    const sigNamespace = reader.text();
    reader.string();
    const hash = reader.text();
    const sig = new Reader(reader.string());
    if (sigNamespace !== namespace) return no(`The signature is for ${sigNamespace}, not ${namespace}.`);
    if (hash !== "sha512" && hash !== "sha256") return no("The signature uses an unknown hash.");

    const key = new Reader(keyBlob);
    if (key.text() !== SK_KEY_TYPE || key.text() !== "nistp256") return no("The signature is not from a P-256 passkey.");
    const point = key.string();
    const rpId = key.text();
    if (sig.text() !== WEBAUTHN_SIG_TYPE) return no("The signature is not a WebAuthn signature.");
    const ecdsa = new Reader(sig.string());
    const r = fixed32(ecdsa.string());
    const s = fixed32(ecdsa.string());
    const flags = sig.take(1)[0]!;
    const counter = sig.take(4);
    const origin = sig.text();
    const clientDataBytes = sig.string();
    const extensions = sig.string();

    const bytes = typeof message === "string" ? utf8(message) : message;
    const digest =
      hash === "sha512" ? await crypto.subtle.digest("SHA-512", bytes as Uint8Array<ArrayBuffer>) : await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
    const data = concat(MAGIC, sshString(namespace), sshString(""), sshString(hash), sshString(new Uint8Array(digest)));
    const clientData = JSON.parse(fromUtf8(clientDataBytes));
    if (clientData.type !== "webauthn.get") return no("The signature is not a WebAuthn assertion.");
    if (clientData.challenge !== toBase64Url(data)) return no("The passkey signed a different message.");
    if (clientData.origin !== origin) return no("The signature names two different origins.");
    if (clientData.crossOrigin === true || clientData.topOrigin !== undefined) return no("The passkey signed in a frame.");
    if (!(flags & FLAG_UP)) return no("The authenticator did not see the person.");
    if (!(flags & FLAG_UV)) return no("The authenticator did not verify the person.");

    const authData = concat(await sha256(rpId), new Uint8Array([flags]), counter, extensions);
    const signed = concat(authData, await sha256(clientDataBytes));
    const publicKey = await crypto.subtle.importKey("raw", point as Uint8Array<ArrayBuffer>, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, concat(r, s), signed);
    if (!ok) return no("The passkey signature does not verify.");
    return { ok: true, keyBlob, fingerprint: await blobFingerprint(keyBlob), rpId, origin, flags };
  } catch {
    return no("The signature does not decode.");
  }
}
