import { decodeTypedBytewords, encodeBytewords } from "./bytewords.ts";
import { encodeBytes, encodeMap, encodeTag, encodeUint } from "./dcbor.ts";

// A seed (BCR-2020-006) holding only its secret, `40300({1: secret})`, the
// form a recovery code takes. Its text form is the single-part UR
// `ur:seed/` + minimal Bytewords of the untagged seed.

export const SEED_LENGTH = 16;
const TAG_SEED = 40300;
const UR_PREFIX = "ur:seed/";

/** `{1: secret}`: the seed without its tag, the body of its UR. */
export function untaggedSeed(secret: Uint8Array): Uint8Array {
  return encodeMap([[encodeUint(1), encodeBytes(secret)]]);
}

/** `40300({1: secret})`. */
export function taggedSeed(secret: Uint8Array): Uint8Array {
  return encodeTag(TAG_SEED, untaggedSeed(secret));
}

export function seedUr(secret: Uint8Array): string {
  return UR_PREFIX + encodeBytewords(untaggedSeed(secret), "minimal");
}

/**
 * A recovery code as words to read aloud or write down: the body of its UR in
 * standard Bytewords. Takes the code in any form `seedSecretFromTyped` accepts.
 */
export function seedWords(code: string): string {
  const secret = seedSecretFromTyped(code);
  if (!secret) throw new Error("seedWords: not a recovery code");
  return encodeBytewords(untaggedSeed(secret), "standard");
}

/**
 * The 16-byte secret in what a person typed, or null. Accepts the UR with or
 * without its prefix, and the tagged seed, the untagged seed or the bare
 * secret in any Bytewords style, in any case.
 */
export function seedSecretFromTyped(text: string): Uint8Array | null {
  let t = text.trim().toLowerCase();
  if (t.startsWith(UR_PREFIX)) t = t.slice(UR_PREFIX.length);
  const payload = decodeTypedBytewords(t);
  if (!payload) return null;
  const zeros = new Uint8Array(SEED_LENGTH);
  for (const prefix of [taggedSeed(zeros).slice(0, -SEED_LENGTH), untaggedSeed(zeros).slice(0, -SEED_LENGTH), new Uint8Array()]) {
    if (payload.length === prefix.length + SEED_LENGTH && startsWith(payload, prefix)) {
      return payload.slice(prefix.length);
    }
  }
  return null;
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  return prefix.every((b, i) => bytes[i] === b);
}
