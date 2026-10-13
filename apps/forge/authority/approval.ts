// Approvals: a promoter's passkey signs one specific change. The approval
// payload names the repository, the ref, the parents and the tree of the
// change. Its SHA-256 digest is the WebAuthn challenge, so the assertion is
// valid for that change only. The approval goes into the commit message as a
// trailer, and anyone with a clone can check it against the policy.

import { concat, equalBytes, fromBase64Url, fromUtf8, sha256, toBase64Url, utf8 } from "./bytes.ts";
import type { Policy, PublicJwk, WebAuthnPromoter } from "./policy.ts";

export const TRAILER = "Forge-Approval";
export const MAIN_REF = "refs/heads/main";

export type ApprovalAction = "incept" | "policy" | "promote" | "release";

/** What a promoter approves. */
export interface ApprovalPayload {
  v: 1;
  /** The repository id: its inception commit. Null for the inception commit itself. */
  repo: string | null;
  action: ApprovalAction;
  ref: string;
  /** The parents of the commit to make, in order. */
  parents: string[];
  /** The tree of the commit to make. */
  tree: string;
  /** When the payload was made, in milliseconds since the epoch. */
  at: number;
  /** One line that tells the promoter what the change does. */
  summary: string;
}

/** An approval as the commit trailer holds it. Each binary field is base64url. */
export interface Approval {
  /** The exact payload bytes. The challenge is their SHA-256 digest. */
  payload: string;
  credentialId: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
}

/** The payload as bytes, with its fields in a fixed order. */
export function encodePayload(payload: ApprovalPayload): Uint8Array<ArrayBuffer> {
  const { v, repo, action, ref, parents, tree, at, summary } = payload;
  return utf8(JSON.stringify({ v, repo, action, ref, parents, tree, at, summary }));
}

export function decodePayload(bytes: Uint8Array): ApprovalPayload {
  const value = JSON.parse(fromUtf8(bytes));
  if (value?.v !== 1) throw new Error("unknown approval payload version");
  return value as ApprovalPayload;
}

/** The WebAuthn challenge for a payload, base64url. */
export async function challengeFor(payload: Uint8Array): Promise<string> {
  return toBase64Url(await sha256(payload));
}

/** The request options a browser gives to `navigator.credentials.get` for this approval. */
export async function approvalRequestOptions(payload: Uint8Array, promoter: WebAuthnPromoter, rpId: string) {
  return {
    challenge: await challengeFor(payload),
    rpId,
    allowCredentials: [{ id: promoter.credentialId, type: "public-key" as const }],
    userVerification: "required" as const,
    timeout: 120_000,
  };
}

/** The approval made from a payload and the browser's assertion JSON. */
export function approvalFrom(
  payload: Uint8Array,
  assertion: { id: string; response: { authenticatorData: string; clientDataJSON: string; signature: string } },
): Approval {
  return {
    payload: toBase64Url(payload),
    credentialId: assertion.id,
    authenticatorData: assertion.response.authenticatorData,
    clientDataJSON: assertion.response.clientDataJSON,
    signature: assertion.response.signature,
  };
}

/** The trailer line for a commit message. */
export function trailerLine(approval: Approval): string {
  return `${TRAILER}: ${toBase64Url(utf8(JSON.stringify(approval)))}`;
}

/** Every approval in a message, in order. A release tag holds one for each promoter that approved it. */
export function approvalsIn(message: string): Approval[] {
  return message
    .trimEnd()
    .split("\n")
    .filter((l) => l.startsWith(`${TRAILER}: `))
    .map((l) => decodeTrailer(l))
    .filter((a): a is Approval => a !== null);
}

/** The approval in a commit message, or null if it has none. A trailer that does not decode gives null too. */
export function approvalIn(message: string): Approval | null {
  const lines = message.trimEnd().split("\n");
  const line = [...lines].reverse().find((l) => l.startsWith(`${TRAILER}: `));
  return line ? decodeTrailer(line) : null;
}

function decodeTrailer(line: string): Approval | null {
  try {
    const value = JSON.parse(fromUtf8(fromBase64Url(line.slice(TRAILER.length + 2).trim())));
    for (const field of ["payload", "credentialId", "authenticatorData", "clientDataJSON", "signature"]) {
      if (typeof value[field] !== "string") return null;
    }
    return value as Approval;
  } catch {
    return null;
  }
}

/**
 * The trailer of a commit that a passkey signs as a whole: the approval
 * payload alone, as base64url. The commit's SSH signature covers it, so the
 * signature is the approval and the trailer needs no assertion of its own.
 */
export function factsLine(payload: Uint8Array): string {
  return `${TRAILER}: ${toBase64Url(utf8(JSON.stringify({ payload: toBase64Url(payload) })))}`;
}

/** A commit message with the payload trailer at its end. */
export function withFacts(message: string, payload: Uint8Array): string {
  return `${message.trimEnd()}\n\n${factsLine(payload)}\n`;
}

/** The payload in a commit's trailer when the trailer holds a payload and no assertion, else null. */
export function factsIn(message: string): { payload: ApprovalPayload; bytes: string } | null {
  const line = [...message.trimEnd().split("\n")].reverse().find((l) => l.startsWith(`${TRAILER}: `));
  if (!line) return null;
  try {
    const value = JSON.parse(fromUtf8(fromBase64Url(line.slice(TRAILER.length + 2).trim())));
    if (typeof value?.payload !== "string" || "signature" in value) return null;
    return { payload: decodePayload(fromBase64Url(value.payload)), bytes: value.payload };
  } catch {
    return null;
  }
}

/** A commit message with the approval trailer at its end. */
export function withTrailer(message: string, approval: Approval): string {
  return `${message.trimEnd()}\n\n${trailerLine(approval)}\n`;
}

export type ApprovalCheck =
  | { ok: true; promoter: WebAuthnPromoter; payload: ApprovalPayload }
  | { ok: false; reason: string; payload?: ApprovalPayload };

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;

/** An ASN.1 DER ECDSA signature as the raw r||s form WebCrypto wants. */
function rawFromDer(der: Uint8Array): Uint8Array<ArrayBuffer> {
  if (der[0] !== 0x30) throw new Error("not a DER signature");
  let offset = 2;
  const part = () => {
    if (der[offset] !== 0x02) throw new Error("not a DER signature");
    const length = der[offset + 1]!;
    let value = der.slice(offset + 2, offset + 2 + length);
    offset += 2 + length;
    while (value.length > 32 && value[0] === 0) value = value.slice(1);
    if (value.length > 32) throw new Error("bad DER signature");
    const out = new Uint8Array(32);
    out.set(value, 32 - value.length);
    return out;
  };
  return concat(part(), part());
}

/** Import a public JWK. The cast lets the call typecheck under both the Node and the Workers types. */
function importJwk(jwk: PublicJwk, algorithm: object): Promise<CryptoKey> {
  const importKey = crypto.subtle.importKey.bind(crypto.subtle) as unknown as (
    format: "jwk",
    key: object,
    algorithm: object,
    extractable: boolean,
    usages: string[],
  ) => Promise<CryptoKey>;
  return importKey("jwk", jwk, algorithm, false, ["verify"]);
}

async function verifySignature(promoter: WebAuthnPromoter, signature: Uint8Array, data: Uint8Array<ArrayBuffer>) {
  if (promoter.alg === -7) {
    const key = await importJwk(promoter.publicKey, { name: "ECDSA", namedCurve: "P-256" });
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, rawFromDer(signature), data);
  }
  const key = await importJwk(promoter.publicKey, { name: "Ed25519" });
  return crypto.subtle.verify({ name: "Ed25519" }, key, signature as Uint8Array<ArrayBuffer>, data);
}

/**
 * Check an approval against a policy: the passkey is a promoter in it, the
 * person was present and verified, the relying party and origin match, the
 * challenge is the payload digest, and the signature verifies. It does not
 * check that the payload matches a commit; the caller does that.
 */
export async function verifyApproval(approval: Approval, policy: Policy): Promise<ApprovalCheck> {
  let payloadBytes: Uint8Array;
  let payload: ApprovalPayload;
  try {
    payloadBytes = fromBase64Url(approval.payload);
    payload = decodePayload(payloadBytes);
  } catch {
    return { ok: false, reason: "The approval payload does not decode." };
  }
  const promoter = policy.promoters.find(
    (p): p is WebAuthnPromoter => p.kind === "webauthn" && p.credentialId === approval.credentialId,
  );
  if (!promoter) return { ok: false, reason: "The approval is from a passkey the policy does not list as a promoter.", payload };
  try {
    const clientDataBytes = fromBase64Url(approval.clientDataJSON);
    const clientData = JSON.parse(fromUtf8(clientDataBytes));
    if (clientData.type !== "webauthn.get") return { ok: false, reason: "The approval is not a WebAuthn assertion.", payload };
    if (clientData.challenge !== (await challengeFor(payloadBytes))) {
      return { ok: false, reason: "The approval signs a different payload.", payload };
    }
    if (clientData.origin !== policy.webauthn.origin) {
      return { ok: false, reason: `The approval comes from ${clientData.origin}, not ${policy.webauthn.origin}.`, payload };
    }
    if (clientData.crossOrigin === true || clientData.topOrigin !== undefined) {
      return { ok: false, reason: "The approval was made in a frame.", payload };
    }
    const authData = fromBase64Url(approval.authenticatorData);
    if (authData.length < 37) return { ok: false, reason: "The authenticator data is too short.", payload };
    if (!equalBytes(authData.slice(0, 32), await sha256(policy.webauthn.rpId))) {
      return { ok: false, reason: `The approval is not for ${policy.webauthn.rpId}.`, payload };
    }
    const flags = authData[32]!;
    if (!(flags & FLAG_UP)) return { ok: false, reason: "The authenticator did not see the person.", payload };
    if (!(flags & FLAG_UV)) return { ok: false, reason: "The authenticator did not verify the person.", payload };
    const data = concat(authData, await sha256(clientDataBytes));
    const ok = await verifySignature(promoter, fromBase64Url(approval.signature), data);
    if (!ok) return { ok: false, reason: "The approval signature does not verify.", payload };
  } catch {
    return { ok: false, reason: "The approval does not decode.", payload };
  }
  return { ok: true, promoter, payload };
}
