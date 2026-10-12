import { concatBytes as concat } from "../encoding.ts";

// Deterministic CBOR (dCBOR) encoding, as far as this library needs it:
// unsigned integers, byte strings, text, tags, arrays and maps. Each function
// returns the encoded bytes of one data item, so larger items are built from
// smaller encoded ones. dCBOR fixes every choice CBOR leaves open: the
// shortest head, map keys in the byte order of their encodings with no
// duplicates, and text in Unicode Normalization Form C.

function head(major: number, value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`not an unsigned integer: ${value}`);
  const m = major << 5;
  if (value < 24) return Uint8Array.of(m | value);
  if (value < 0x100) return Uint8Array.of(m | 24, value);
  if (value < 0x10000) return Uint8Array.of(m | 25, value >> 8, value & 0xff);
  if (value < 0x100000000) {
    return Uint8Array.of(m | 26, value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  }
  const out = new Uint8Array(9);
  out[0] = m | 27;
  new DataView(out.buffer).setBigUint64(1, BigInt(value));
  return out;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

export function encodeUint(value: number): Uint8Array {
  return head(0, value);
}

export function encodeBytes(bytes: Uint8Array): Uint8Array {
  return concat(head(2, bytes.length), bytes);
}

export function encodeText(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text.normalize("NFC"));
  return concat(head(3, bytes.length), bytes);
}

export function encodeArray(items: readonly Uint8Array[]): Uint8Array {
  return concat(head(4, items.length), ...items);
}

/** A map from encoded keys to encoded values, its entries sorted by key bytes. */
export function encodeMap(entries: readonly (readonly [key: Uint8Array, value: Uint8Array])[]): Uint8Array {
  const sorted = [...entries].sort(([a], [b]) => compareBytes(a, b));
  for (let i = 1; i < sorted.length; i++) {
    if (compareBytes(sorted[i - 1]![0], sorted[i]![0]) === 0) throw new Error("duplicate map key");
  }
  return concat(head(5, sorted.length), ...sorted.flat());
}

export function encodeTag(tag: number, content: Uint8Array): Uint8Array {
  return concat(head(6, tag), content);
}

export { compareBytes };
