// A minimal CBOR encoder (RFC 8949) for building authenticator data in tests.
// Deliberately independent of the CBOR code inside the WebAuthn library, so the
// two cannot agree by sharing a bug.

export type CborValue =
  | number
  | string
  | boolean
  | Uint8Array
  | CborValue[]
  | Map<number | string, CborValue>
  | { [key: string]: CborValue };

function head(major: number, length: number): number[] {
  if (length < 24) return [(major << 5) | length];
  if (length < 0x100) return [(major << 5) | 24, length];
  if (length < 0x10000) return [(major << 5) | 25, length >> 8, length & 0xff];
  return [
    (major << 5) | 26,
    (length >>> 24) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
  ];
}

export function encodeCbor(value: CborValue): Uint8Array {
  const out: number[] = [];
  const write = (v: CborValue): void => {
    if (typeof v === "number") {
      if (!Number.isInteger(v)) throw new Error("only integers are supported");
      out.push(...(v >= 0 ? head(0, v) : head(1, -1 - v)));
    } else if (typeof v === "string") {
      const bytes = new TextEncoder().encode(v);
      out.push(...head(3, bytes.length), ...bytes);
    } else if (typeof v === "boolean") {
      out.push(v ? 0xf5 : 0xf4);
    } else if (v instanceof Uint8Array) {
      out.push(...head(2, v.length), ...v);
    } else if (Array.isArray(v)) {
      out.push(...head(4, v.length));
      v.forEach(write);
    } else if (v instanceof Map) {
      out.push(...head(5, v.size));
      for (const [k, item] of v) {
        write(k);
        write(item);
      }
    } else {
      const entries = Object.entries(v);
      out.push(...head(5, entries.length));
      for (const [k, item] of entries) {
        write(k);
        write(item);
      }
    }
  };
  write(value);
  return new Uint8Array(out);
}
