// Bytewords (BCR-2020-012): each byte as one of 256 four-letter words, with a
// CRC32 of the payload appended as four more. Three styles spell the same
// bytes: standard (words and spaces), URI (words and hyphens) and minimal
// (each word's first and last letters, run together). An identifier is words
// with no CRC32, a name rather than an encoding.

const WORDS = `
  able acid also apex aqua arch atom aunt away axis back bald barn belt beta bias
  blue body brag brew bulb buzz calm cash cats chef city claw code cola cook cost
  crux curl cusp cyan dark data days deli dice diet door down draw drop drum dull
  duty each easy echo edge epic even exam exit eyes fact fair fern figs film fish
  fizz flap flew flux foxy free frog fuel fund gala game gear gems gift girl glow
  good gray grim guru gush gyro half hang hard hawk heat help high hill holy hope
  horn huts iced idea idle inch inky into iris iron item jade jazz join jolt jowl
  judo jugs jump junk jury keep keno kept keys kick kiln king kite kiwi knob lamb
  lava lazy leaf legs liar limp lion list logo loud love luau luck lung main many
  math maze memo menu meow mild mint miss monk nail navy need news next noon note
  numb obey oboe omit onyx open oval owls paid part peck play plus poem pool pose
  puff puma purr quad quiz race ramp real redo rich road rock roof ruby ruin runs
  rust safe saga scar sets silk skew slot soap solo song stub surf swan taco task
  taxi tent tied time tiny toil tomb toys trip tuna twin ugly undo unit urge user
  vast very veto vial vibe view visa void vows wall wand warm wasp wave waxy webs
  what when whiz wolf work yank yawn yell yoga yurt zaps zero zest zinc zone zoom
`.trim().split(/\s+/);

const minimalOf = (word: string) => word[0]! + word[3]!;
const BY_WORD = new Map(WORDS.map((w, i) => [w, i]));
const BY_MINIMAL = new Map(WORDS.map((w, i) => [minimalOf(w), i]));
const BY_FIRST_THREE = new Map(WORDS.map((w, i) => [w.slice(0, 3), i]));
const BY_LAST_THREE = new Map(WORDS.map((w, i) => [w.slice(1), i]));

export type BytewordsStyle = "standard" | "uri" | "minimal";

export type BytewordsErrorKind = "invalid checksum" | "invalid word" | "invalid length" | "non-ascii";

export class BytewordsError extends Error {
  constructor(readonly kind: BytewordsErrorKind) {
    super(`bytewords: ${kind}`);
  }
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

/** CRC-32 (ISO-HDLC), the checksum Bytewords appends. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function withCrc(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 4);
  out.set(payload);
  new DataView(out.buffer).setUint32(payload.length, crc32(payload));
  return out;
}

function spell(bytes: Uint8Array, style: BytewordsStyle): string {
  const words = Array.from(bytes, (b) => WORDS[b]!);
  if (style === "minimal") return words.map(minimalOf).join("");
  return words.join(style === "uri" ? "-" : " ");
}

export function encodeBytewords(payload: Uint8Array, style: BytewordsStyle): string {
  return spell(withCrc(payload), style);
}

/** Decode one style exactly, as the reference does: lower case, no stray separators. */
export function decodeBytewords(text: string, style: BytewordsStyle): Uint8Array {
  if (!/^[\x00-\x7f]*$/.test(text)) throw new BytewordsError("non-ascii");
  let bytes: number[];
  if (style === "minimal") {
    if (text.length % 2 !== 0) throw new BytewordsError("invalid length");
    bytes = (text.match(/../g) ?? []).map((pair) => lookup(BY_MINIMAL, pair));
  } else {
    bytes = text.split(style === "uri" ? "-" : " ").map((word) => lookup(BY_WORD, word));
  }
  return checked(Uint8Array.from(bytes));
}

function lookup(table: Map<string, number>, key: string): number {
  const byte = table.get(key);
  if (byte === undefined) throw new BytewordsError("invalid word");
  return byte;
}

function checked(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4) throw new BytewordsError("invalid checksum");
  const payload = bytes.slice(0, -4);
  const crc = new DataView(bytes.buffer, bytes.byteOffset + payload.length, 4).getUint32(0);
  if (crc !== crc32(payload)) throw new BytewordsError("invalid checksum");
  return payload;
}

/**
 * The byte a typed token names: a whole word, its first and last letters, or
 * its first or last three letters, in any case. Null if it names none.
 */
export function bytewordToken(token: string): number | null {
  const t = token.toLowerCase();
  const byte =
    t.length === 4 ? BY_WORD.get(t)
    : t.length === 2 ? BY_MINIMAL.get(t)
    : t.length === 3 ? (BY_FIRST_THREE.get(t) ?? BY_LAST_THREE.get(t))
    : undefined;
  return byte ?? null;
}

/**
 * Decode what a person typed: any case, words separated by spaces or hyphens
 * (each a token as `bytewordToken` reads it) or minimal letter pairs, with the
 * CRC32 checked. Null if it is not a valid encoding.
 */
export function decodeTypedBytewords(text: string): Uint8Array | null {
  const t = text.trim().toLowerCase();
  if (!/^[a-z -]+$/.test(t)) return null;
  try {
    if (!/[ -]/.test(t)) return decodeBytewords(t, "minimal");
    const bytes = t.split(/[ -]+/).map(bytewordToken);
    if (bytes.some((b) => b === null)) return null;
    return checked(Uint8Array.from(bytes as number[]));
  } catch (error) {
    if (error instanceof BytewordsError) return null;
    throw error;
  }
}

/** Bytes spelled as words with no CRC32, joined by `separator`. */
export function bytewordsIdentifier(bytes: Uint8Array, separator: string): string {
  return Array.from(bytes, (b) => WORDS[b]!).join(separator);
}
