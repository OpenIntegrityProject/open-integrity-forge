// The signer policy: the keys a repository trusts and what each key may do.
// It lives in the repository at POLICY_PATH. A commit is checked against the
// policy of its first parent, so a commit cannot change the rules it obeys.

import { concat, fromBase64Url, toBase64, utf8 } from "./bytes.ts";
import { skPublicKeyBlob, skPublicKeyText } from "./webauthn-sshsig.ts";

export const POLICY_PATH = ".repo/config/verification/policy.json";
export const ALLOWED_SIGNERS_PATH = ".repo/config/verification/allowed_commit_signers";

/** A public key in JWK form, as WebCrypto imports it. */
export interface PublicJwk {
  kty: "EC" | "OKP";
  crv: "P-256" | "Ed25519";
  x: string;
  y?: string;
}

/** A key that may approve a change to main or to the policy. */
export type Promoter = WebAuthnPromoter | SshPromoter;

/** A passkey. Its approvals are WebAuthn assertions over an approval payload. */
export interface WebAuthnPromoter {
  id: string;
  kind: "webauthn";
  /** The credential ID, base64url. */
  credentialId: string;
  /** The COSE algorithm: -7 for ES256, -8 for EdDSA. */
  alg: -7 | -8;
  /** The public key as a JWK: EC P-256 for ES256, OKP Ed25519 for EdDSA. */
  publicKey: PublicJwk;
  /** The passkey label, as the password manager shows it. */
  label?: string;
  since: string;
}

/** An SSH key. The verifier knows this kind, but no approval of this kind exists yet. */
export interface SshPromoter {
  id: string;
  kind: "ssh-ed25519";
  publicKey: string;
  since?: string;
}

/** A key that may sign work. It may not approve, and it may not change the policy. */
export interface Author {
  id: string;
  kind: "ssh-ed25519";
  /** The OpenSSH public key text, `ssh-ed25519 AAAA...`. */
  publicKey: string;
  /** `SHA256:` and the unpadded Base64 of the key blob digest, as ssh-keygen shows it. */
  fingerprint: string;
  /** The promoter that admitted this key. */
  controller: string;
  /** ISO 8601. The key signs nothing before this time. */
  validAfter: string;
  /** ISO 8601. The key signs nothing after this time. */
  validBefore: string;
  /** ISO 8601. Set by a promoter's policy change: the key signs nothing after this time (R6). */
  revokedAt?: string;
}

export interface Policy {
  version: 1;
  /** The relying party that WebAuthn approvals must name. */
  webauthn: { rpId: string; origin: string };
  promoters: Promoter[];
  authors: Author[];
  /**
   * When true, a commit of main with one parent may change only .repo/ (R7).
   * Work then reaches main only as a merge of signed commits, so no squash
   * can drop the authors' signatures.
   */
  mergesOnly?: boolean;
  /** How many distinct promoters must approve a release tag (R8). One when absent. */
  releaseApprovals?: number;
}

export class PolicyError extends Error {}

function fail(message: string): never {
  throw new PolicyError(message);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") fail(`${field} must be a non-empty string`);
  return value;
}

function time(value: unknown, field: string): string {
  const t = text(value, field);
  if (Number.isNaN(Date.parse(t))) fail(`${field} must be an ISO 8601 time`);
  return t;
}

function promoter(value: any, index: number): Promoter {
  const at = `promoters[${index}]`;
  if (typeof value !== "object" || value === null) fail(`${at} must be an object`);
  const id = text(value.id, `${at}.id`);
  if (value.kind === "webauthn") {
    if (value.alg !== -7 && value.alg !== -8) fail(`${at}.alg must be -7 or -8`);
    const jwk = value.publicKey;
    if (typeof jwk !== "object" || jwk === null || typeof jwk.x !== "string") fail(`${at}.publicKey must be a JWK`);
    if (value.alg === -7 && (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.y !== "string")) {
      fail(`${at}.publicKey must be an EC P-256 key`);
    }
    if (value.alg === -8 && (jwk.kty !== "OKP" || jwk.crv !== "Ed25519")) fail(`${at}.publicKey must be an Ed25519 key`);
    return {
      id,
      kind: "webauthn",
      credentialId: text(value.credentialId, `${at}.credentialId`),
      alg: value.alg,
      publicKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, ...(jwk.y === undefined ? {} : { y: jwk.y }) },
      ...(value.label === undefined ? {} : { label: text(value.label, `${at}.label`) }),
      since: time(value.since, `${at}.since`),
    };
  }
  if (value.kind === "ssh-ed25519") {
    return { id, kind: "ssh-ed25519", publicKey: text(value.publicKey, `${at}.publicKey`) };
  }
  return fail(`${at}.kind must be webauthn or ssh-ed25519`);
}

function author(value: any, index: number): Author {
  const at = `authors[${index}]`;
  if (typeof value !== "object" || value === null) fail(`${at} must be an object`);
  if (value.kind !== "ssh-ed25519") fail(`${at}.kind must be ssh-ed25519`);
  return {
    id: text(value.id, `${at}.id`),
    kind: "ssh-ed25519",
    publicKey: text(value.publicKey, `${at}.publicKey`),
    fingerprint: text(value.fingerprint, `${at}.fingerprint`),
    controller: text(value.controller, `${at}.controller`),
    validAfter: time(value.validAfter, `${at}.validAfter`),
    validBefore: time(value.validBefore, `${at}.validBefore`),
    ...(value.revokedAt === undefined ? {} : { revokedAt: time(value.revokedAt, `${at}.revokedAt`) }),
  };
}

function releaseApprovals(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1) fail("releaseApprovals must be a whole number of 1 or more");
  return value as number;
}

/** Parse and check a policy file. Throws a PolicyError that names the bad field. */
export function parsePolicy(source: string): Policy {
  let value: any;
  try {
    value = JSON.parse(source);
  } catch {
    fail("the policy is not JSON");
  }
  if (typeof value !== "object" || value === null) fail("the policy must be an object");
  if (value.version !== 1) fail("version must be 1");
  const webauthn = value.webauthn;
  if (typeof webauthn !== "object" || webauthn === null) fail("webauthn must be an object");
  if (!Array.isArray(value.promoters) || value.promoters.length === 0) fail("promoters must list at least one key");
  if (!Array.isArray(value.authors)) fail("authors must be a list");
  const policy: Policy = {
    version: 1,
    webauthn: { rpId: text(webauthn.rpId, "webauthn.rpId"), origin: text(webauthn.origin, "webauthn.origin") },
    promoters: value.promoters.map(promoter),
    authors: value.authors.map(author),
    ...(value.mergesOnly === undefined ? {} : { mergesOnly: value.mergesOnly === true }),
    ...(value.releaseApprovals === undefined ? {} : { releaseApprovals: releaseApprovals(value.releaseApprovals) }),
  };
  const ids = [...policy.promoters, ...policy.authors].map((k) => k.id);
  if (new Set(ids).size !== ids.length) fail("each key id must be unique");
  return policy;
}

/** The policy as the repository stores it. */
export function renderPolicy(policy: Policy): string {
  return JSON.stringify(policy, null, 2) + "\n";
}

/** A copy of the policy with the author key `id` revoked at `at`. */
export function withRevoked(policy: Policy, id: string, at: Date): Policy {
  return { ...policy, authors: policy.authors.map((a) => (a.id === id ? { ...a, revokedAt: at.toISOString() } : a)) };
}

/** The policy key with this id, or undefined. */
export function keyById(policy: Policy, id: string): Promoter | Author | undefined {
  return [...policy.promoters, ...policy.authors].find((k) => k.id === id);
}

/** A time as OpenSSH writes it in an allowed signers file: YYYYMMDDHHMMSSZ. */
function sshTime(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z";
}

function sshString(bytes: Uint8Array): Uint8Array {
  const n = bytes.length;
  return concat(new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]), bytes);
}

/**
 * A passkey's public key in OpenSSH form: `ecdsa-sha2-nistp256 AAAA...` for
 * ES256, `ssh-ed25519 AAAA...` for EdDSA. It names the same key; it does not
 * make the passkey sign SSH signatures.
 */
export function sshPublicKeyOfJwk(jwk: PublicJwk): string {
  if (jwk.kty === "EC" && jwk.crv === "P-256" && jwk.y) {
    const point = concat(new Uint8Array([4]), fromBase64Url(jwk.x), fromBase64Url(jwk.y));
    return `ecdsa-sha2-nistp256 ${toBase64(concat(sshString(utf8("ecdsa-sha2-nistp256")), sshString(utf8("nistp256")), sshString(point)))}`;
  }
  if (jwk.kty === "OKP" && jwk.crv === "Ed25519") {
    return `ssh-ed25519 ${toBase64(concat(sshString(utf8("ssh-ed25519")), sshString(fromBase64Url(jwk.x))))}`;
  }
  throw new Error("not a P-256 or Ed25519 key");
}

/**
 * The SSH keys of the policy in OpenSSH allowed signers format. Point
 * `gpg.ssh.allowedSignersFile` at it, and `git verify-commit` checks the
 * author signatures and a P-256 passkey's signature of the inception commit.
 * This file gives R3 and R5 only. The other rules need the forge verifier.
 */
export function allowedSigners(policy: Policy): string {
  const lines = [
    "# Generated from policy.json. The forge verifier reads policy.json, not this file.",
    "# A P-256 passkey promoter is listed as the OpenSSH security key it signs Git commits with.",
    "# Its approvals in commit trailers are WebAuthn assertions, which git does not check.",
  ];
  for (const p of policy.promoters) {
    const id = p.id.replace(/\s+/g, "_");
    if (p.kind === "ssh-ed25519") lines.push(`${id} namespaces="git" ${p.publicKey}`);
    else if (p.alg === -7) lines.push(`${id} namespaces="git" ${skPublicKeyText(skPublicKeyBlob(p.publicKey, policy.webauthn.rpId))}`);
    else lines.push(`${id} namespaces="forge-approval" ${sshPublicKeyOfJwk(p.publicKey)}`);
  }
  for (const a of policy.authors) {
    // A revoked key's window ends at its revocation, so git checks R6 too.
    const end = a.revokedAt && Date.parse(a.revokedAt) < Date.parse(a.validBefore) ? a.revokedAt : a.validBefore;
    lines.push(`${a.id} namespaces="git",valid-after="${sshTime(a.validAfter)}",valid-before="${sshTime(end)}" ${a.publicKey}`);
  }
  return lines.join("\n") + "\n";
}
