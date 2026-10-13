// What a member name may be, and the key that makes two names the same name.
// Free of Workers APIs, so the browser entry exports it too and a form can
// check a name with the rules the server applies.

// Latin letters whose key is plain a-z: A-Z, the precomposed letters that
// decompose to one of them plus marks, and the six the key folds. A test
// rescans Unicode to keep this list exact.
const LATIN_LETTERS =
  "A-Za-z\\u{C0}-\\u{CF}\\u{D1}-\\u{D6}\\u{D8}-\\u{EF}\\u{F1}-\\u{F6}\\u{F8}-\\u{125}\\u{128}-\\u{130}" +
  "\\u{134}-\\u{137}\\u{139}-\\u{13E}\\u{141}-\\u{148}\\u{14C}-\\u{151}\\u{154}-\\u{165}\\u{168}-\\u{17E}" +
  "\\u{1A0}-\\u{1A1}\\u{1AF}-\\u{1B0}\\u{1CD}-\\u{1DC}\\u{1DE}-\\u{1E3}\\u{1E6}-\\u{1ED}\\u{1F0}\\u{1F4}-\\u{1F5}" +
  "\\u{1F8}-\\u{21B}\\u{21E}-\\u{21F}\\u{226}-\\u{233}\\u{1E00}-\\u{1E99}\\u{1E9E}\\u{1EA0}-\\u{1EF9}";

const MIN_LENGTH = 3;
const MAX_LENGTH = 32;

export const MEMBER_NAME_RULES = {
  minLength: MIN_LENGTH,
  maxLength: MAX_LENGTH,
  /** For an HTML `pattern` attribute, which compiles it with the `v` flag. */
  pattern: `(?=.{${MIN_LENGTH},${MAX_LENGTH}}$)[${LATIN_LETTERS}](?:[\\-_]?[${LATIN_LETTERS}0-9])*`,
  description:
    `A member name is ${MIN_LENGTH} to ${MAX_LENGTH} characters long and starts with a letter. ` +
    "After that it may use letters, digits, hyphens and underscores, but a hyphen or underscore " +
    "must sit between two letters or digits. Letters are A to Z and most accented Latin letters. " +
    "Names that differ only in capitals or accents count as the same name, so José and jose cannot both be taken.",
} as const;

const MEMBER_NAME = new RegExp(`^(?:${MEMBER_NAME_RULES.pattern})$`, "v");

/** Whether a name meets the rules, once normalized to NFC. */
export function isValidMemberName(name: unknown): name is string {
  return typeof name === "string" && MEMBER_NAME.test(name.normalize("NFC"));
}

// Letters with no decomposition, spelled as their nearest a-z.
const FOLDS: Record<string, string> = { ß: "ss", ø: "o", æ: "ae", ł: "l", þ: "th", đ: "d" };
const FOLDED = new RegExp(`[${Object.keys(FOLDS).join("")}]`, "g");

/** The key two names share when they differ only in case and accents. */
export function memberNameKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(FOLDED, (letter) => FOLDS[letter]!);
}

/** Words an application can show when a name has no capital letter. */
export const CAPITAL_NUDGE_MESSAGE = "Member names display as typed, and most read best with a capital letter.";

/** Whether a name has no capital letter, so an application might suggest one. */
export function needsCapitalNudge(name: string): boolean {
  return name === name.toLowerCase();
}
