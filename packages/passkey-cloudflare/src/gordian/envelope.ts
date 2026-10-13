import { concatBytes as concat, sha256 } from "../encoding.ts";
import { compareBytes, encodeArray, encodeBytes, encodeMap, encodeTag, encodeText, encodeUint } from "./dcbor.ts";

// Gordian Envelope (BCR-2024-003), as far as this library needs it: leaves,
// known values, assertions and nodes, with their digests. An Envelope is kept
// as its untagged encoding plus its digest; `envelopeCbor` adds the outer tag.
//
// Digests: a leaf's is SHA-256 of its value's dCBOR, a known value's is
// SHA-256 of `40000(n)`, an assertion's is SHA-256 of its predicate's digest
// then its object's, and a node's is SHA-256 of its subject's digest then its
// assertions' digests in ascending order, the order they are encoded in.

const TAG_ENVELOPE = 200;
const TAG_LEAF = 201;
const TAG_KNOWN_VALUE = 40000;

export interface Envelope {
  /** The Envelope's encoding without the outer tag 200, as it appears inside another Envelope. */
  readonly untagged: Uint8Array;
  readonly digest: Uint8Array;
}

/** A leaf holding a dCBOR value, given encoded. */
export async function leaf(value: Uint8Array): Promise<Envelope> {
  return { untagged: encodeTag(TAG_LEAF, value), digest: await sha256(value) };
}

export async function knownValue(value: number): Promise<Envelope> {
  return { untagged: encodeUint(value), digest: await sha256(encodeTag(TAG_KNOWN_VALUE, encodeUint(value))) };
}

export async function assertion(predicate: Envelope, object: Envelope): Promise<Envelope> {
  return {
    untagged: encodeMap([[predicate.untagged, object.untagged]]),
    digest: await sha256(concat(predicate.digest, object.digest)),
  };
}

/** A subject with assertions. An assertion given twice appears once. */
export async function node(subject: Envelope, assertions: readonly Envelope[]): Promise<Envelope> {
  if (assertions.length === 0) return subject;
  const unique = [...new Map(assertions.map((a) => [a.digest.join(), a])).values()];
  unique.sort((a, b) => compareBytes(a.digest, b.digest));
  return {
    untagged: encodeArray([subject.untagged, ...unique.map((a) => a.untagged)]),
    digest: await sha256(concat(subject.digest, ...unique.map((a) => a.digest))),
  };
}

/** The Envelope as a dCBOR data item, tag 200. */
export function envelopeCbor(envelope: Envelope): Uint8Array {
  return encodeTag(TAG_ENVELOPE, envelope.untagged);
}

// Known values from the Blockchain Commons registry.
export const KNOWN = { isA: 1, note: 4, name: 11, date: 16, Seed: 200 } as const;

export interface SeedMetadata {
  /** Encoded as a dCBOR date, whole seconds since the epoch. */
  date?: Date;
  name?: string;
  note?: string;
}

/**
 * A seed Envelope (BCR-2023-009): the secret as a byte-string subject,
 * `'isA': 'Seed'`, and optional `'date'`, `'name'` and `'note'`.
 */
export async function seedEnvelope(secret: Uint8Array, metadata: SeedMetadata = {}): Promise<Envelope> {
  const assertions = [assertion(await knownValue(KNOWN.isA), await knownValue(KNOWN.Seed))];
  if (metadata.date) {
    const ms = metadata.date.getTime();
    if (ms % 1000 !== 0) throw new RangeError("a seed date must be whole seconds");
    assertions.push(assertion(await knownValue(KNOWN.date), await leaf(encodeTag(1, encodeUint(ms / 1000)))));
  }
  if (metadata.name) assertions.push(assertion(await knownValue(KNOWN.name), await leaf(encodeText(metadata.name))));
  if (metadata.note) assertions.push(assertion(await knownValue(KNOWN.note), await leaf(encodeText(metadata.note))));
  return node(await leaf(encodeBytes(secret)), await Promise.all(assertions));
}
