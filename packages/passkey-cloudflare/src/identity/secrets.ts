import { concatBytes, randomBytes, sha256Hex, toBase64Url } from "../encoding.ts";
import { SEED_LENGTH, seedSecretFromTyped, seedUr } from "../gordian/seed.ts";

// Session tokens and recovery codes. Each is minted from the platform's secure
// generator and handed to the caller once; only its SHA-256 hash is stored.

const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The id of an identity record: a random UUID minted at registration and never changed. */
export type RecordId = string & { readonly __brand: "RecordId" };

export function isRecordId(value: unknown): value is RecordId {
  return typeof value === "string" && RECORD_ID.test(value);
}

export function newRecordId(): RecordId {
  return crypto.randomUUID() as RecordId;
}

export interface MintedSession {
  id: string;
  /** `recordId.token`, the value a client presents. */
  value: string;
  tokenHash: string;
}

export async function mintSession(recordId: RecordId): Promise<MintedSession> {
  const token = toBase64Url(randomBytes(32));
  return { id: toBase64Url(randomBytes(12)), value: `${recordId}.${token}`, tokenHash: await sha256Hex(token) };
}

/** A single-use rebind link token, `recordId.token`. */
export async function mintRebindToken(recordId: RecordId): Promise<{ value: string; tokenHash: string }> {
  const token = toBase64Url(randomBytes(32));
  return { value: `${recordId}.${token}`, tokenHash: await sha256Hex(token) };
}

/** Split a presented `recordId.token` value (a session or a rebind link) into its record id and token hash. */
export async function parseRecordToken(
  value: string | null | undefined,
): Promise<{ recordId: RecordId; tokenHash: string } | null> {
  if (!value) return null;
  const dot = value.indexOf(".");
  const recordId = value.slice(0, dot);
  const token = value.slice(dot + 1);
  if (dot < 0 || !isRecordId(recordId) || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return { recordId, tokenHash: await sha256Hex(token) };
}

export const RECOVERY_CODE_COUNT = 8;

// A recovery code is a 16-byte secret typed as a seed, `40300({1: secret})`,
// and shown as the seed's UR, `ur:seed/` + minimal Bytewords (54 characters).
// Gordian Seed Tool imports that form as a seed. Input also accepts the other
// Bytewords forms of the same secret, and a whole line of the numbered list
// `formatRecoveryCodes` makes; whichever form is typed, the hash is of the
// decoded secret.

function hashSecret(secret: Uint8Array): Promise<string> {
  return sha256Hex(concatBytes(new TextEncoder().encode("recovery-code:"), secret));
}

export async function hashRecoveryCode(code: string): Promise<string> {
  // Bytewords are letters only, so a leading list number is never part of a code.
  const secret = typeof code === "string" ? seedSecretFromTyped(code.replace(/^\s*\d+\.\s+/, "")) : null;
  // Input that is no code still gets a hash, one no stored code can have, so
  // it is refused where a wrong code is.
  return secret ? hashSecret(secret) : sha256Hex(`not-a-recovery-code:${String(code)}`);
}

export async function mintRecoveryCodes(): Promise<{ codes: string[]; hashes: string[] }> {
  const secrets = Array.from({ length: RECOVERY_CODE_COUNT }, () => randomBytes(SEED_LENGTH));
  return { codes: secrets.map(seedUr), hashes: await Promise.all(secrets.map(hashSecret)) };
}
