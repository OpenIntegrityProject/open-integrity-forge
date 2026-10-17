import { sha256 } from "../encoding.ts";
import { BIP39_ENGLISH } from "./bip39-english.ts";

// BIP39 mnemonics for a 16-byte secret, the length of a recovery code: its
// 128 bits followed by a 4-bit checksum, the first bits of its SHA-256, read
// 11 bits at a time as 12 words of the English list. Only that length is
// supported. The checksum is computed with WebCrypto, so both directions are
// async.

export const BIP39_WORDS: readonly string[] = BIP39_ENGLISH.split(" ");

const ENTROPY_LENGTH = 16;
const WORD_COUNT = 12;
const CHECKSUM_BITS = 4n;
const INDEX = new Map(BIP39_WORDS.map((word, i) => [word, i]));
// Every word of the list is fixed by its first four letters, so those alone
// are accepted for a word of four letters or more.
const PREFIX = new Map(BIP39_WORDS.filter((word) => word.length > 4).map((word) => [word.slice(0, 4), INDEX.get(word)!]));

async function checksum(entropy: Uint8Array): Promise<bigint> {
  return BigInt((await sha256(entropy))[0]! >> (8 - Number(CHECKSUM_BITS)));
}

/** The 12 words, separated by single spaces, for 16 bytes of entropy. */
export async function encodeBip39(entropy: Uint8Array): Promise<string> {
  if (entropy.length !== ENTROPY_LENGTH) throw new Error(`encodeBip39: needs ${ENTROPY_LENGTH} bytes`);
  let bits = 0n;
  for (const byte of entropy) bits = (bits << 8n) | BigInt(byte);
  bits = (bits << CHECKSUM_BITS) | (await checksum(entropy));
  const words: string[] = [];
  for (let i = WORD_COUNT - 1; i >= 0; i--) words.push(BIP39_WORDS[Number((bits >> BigInt(11 * i)) & 0x7ffn)]!);
  return words.join(" ");
}

/**
 * The 16 bytes of entropy in 12 BIP39 words, or null when the text is not
 * that or its checksum fails. Words may be in any case, separated by any
 * whitespace, and each may be given by its first four letters.
 */
export async function decodeBip39(text: string): Promise<Uint8Array | null> {
  const words = text.trim().toLowerCase().split(/\s+/);
  if (words.length !== WORD_COUNT) return null;
  let bits = 0n;
  for (const word of words) {
    const index = INDEX.get(word) ?? (word.length === 4 ? PREFIX.get(word) : undefined);
    if (index === undefined) return null;
    bits = (bits << 11n) | BigInt(index);
  }
  const entropy = new Uint8Array(ENTROPY_LENGTH);
  let body = bits >> CHECKSUM_BITS;
  for (let i = ENTROPY_LENGTH - 1; i >= 0; i--) {
    entropy[i] = Number(body & 0xffn);
    body >>= 8n;
  }
  return (bits & ((1n << CHECKSUM_BITS) - 1n)) === (await checksum(entropy)) ? entropy : null;
}
