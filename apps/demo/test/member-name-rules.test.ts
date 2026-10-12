import * as main from "passkey-cloudflare";
import {
  CAPITAL_NUDGE_MESSAGE,
  MEMBER_NAME_RULES,
  isValidMemberName,
  memberNameKey,
  needsCapitalNudge,
} from "passkey-cloudflare/browser";
import { describe, expect, it } from "vitest";

const nfd = (name: string) => name.normalize("NFD");

const ACCEPTED = [
  "Ada",
  "José",
  nfd("José"),
  "Zoë_Ångström",
  "Straße",
  "Łukasz",
  "Þórunn",
  "Đorđe",
  "Søren-Kierkegaard",
  "ÆTHELRED",
  "Nguyễn",
  "a-b_c",
  "r2d2",
  "abc",
  "a".repeat(32),
];

const REFUSED = [
  "2pac", // a digit first
  "_ada", // a separator first
  "ada-", // a trailing separator
  "ada_",
  "ad--a", // two separators in a row
  "ad-_a",
  "a.da", // a dot
  "ada lovelace", // a space
  "ab", // 2 characters
  "a".repeat(33), // 33 characters
  "Аda", // Cyrillic А
  "adaа", // Cyrillic а at the end
  "Ｊose", // fullwidth J
  "ﬁona", // a ligature
  "ſam", // long s
  "ħana", // a stroked letter with no fold
  "Ǉubljana", // a compatibility digraph
  "é́ve", // a mark with no precomposed letter
  "ada​", // a zero-width space
  "",
];

describe("member-name rules", () => {
  it.each(ACCEPTED)("accepts %j", (name) => {
    expect(isValidMemberName(name)).toBe(true);
  });

  it.each(REFUSED)("refuses %j", (name) => {
    expect(isValidMemberName(name)).toBe(false);
  });

  it("refuses what is not a string", () => {
    for (const value of [undefined, null, 42, ["Ada"], { name: "Ada" }]) expect(isValidMemberName(value)).toBe(false);
  });

  it("counts characters as typed, not as keyed", () => {
    // ß keys as ss, so this name's key is 33 characters long.
    expect(isValidMemberName(`${"a".repeat(31)}ß`)).toBe(true);
    // A decomposed é is one character once normalized.
    expect(isValidMemberName(nfd(`${"a".repeat(31)}é`))).toBe(true);
  });

  it("keys a name ignoring case and accents", () => {
    expect(memberNameKey("José")).toBe("jose");
    expect(memberNameKey(nfd("JOSÉ"))).toBe("jose");
    expect(memberNameKey("Straße")).toBe("strasse");
    expect(memberNameKey("STRAẞE")).toBe("strasse");
    expect(memberNameKey("Søren")).toBe("soren");
    expect(memberNameKey("Æthelred")).toBe("aethelred");
    expect(memberNameKey("Łukasz")).toBe("lukasz");
    expect(memberNameKey("Þórunn")).toBe("thorunn");
    expect(memberNameKey("Đorđe")).toBe("dorde");
    expect(memberNameKey("Nguyễn")).toBe("nguyen");
    expect(memberNameKey("a-b_c")).not.toBe(memberNameKey("a_b-c"));
  });

  it("gives the HTML pattern the same answer as the validator", () => {
    // How a browser compiles a pattern attribute.
    const attribute = new RegExp(`^(?:${MEMBER_NAME_RULES.pattern})$`, "v");
    for (const name of [...ACCEPTED, ...REFUSED]) {
      expect(attribute.test(name.normalize("NFC")), name).toBe(isValidMemberName(name));
    }
  });

  it("admits exactly the Latin letters whose key is plain a-z", () => {
    const pattern = new RegExp(`^(?:${MEMBER_NAME_RULES.pattern})$`, "v");
    const mismatches: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const letter = String.fromCodePoint(cp);
      const latin = /^[\p{L}&&\p{Script=Latin}]$/v.test(letter) && letter.normalize("NFC") === letter;
      const expected = latin && /^[a-z]+$/.test(memberNameKey(letter));
      if (pattern.test(`${letter}aa`) !== expected) mismatches.push(`U+${cp.toString(16)}`);
    }
    expect(mismatches).toEqual([]);
  });

  it("gives the form its lengths and a plain description", () => {
    expect(MEMBER_NAME_RULES.minLength).toBe(3);
    expect(MEMBER_NAME_RULES.maxLength).toBe(32);
    expect(MEMBER_NAME_RULES.description).toMatch(/^[^\n]+\.$/);
  });

  it.each(["ada", "josé", nfd("josé"), "r2d2", "straße", "a-b_c"])("nudges %j toward a capital", (name) => {
    expect(needsCapitalNudge(name)).toBe(true);
  });

  it.each(["Ada", "José", nfd("José"), "R2d2", "ÆTHELRED", "adA", "a-B_c"])("leaves %j alone", (name) => {
    expect(needsCapitalNudge(name)).toBe(false);
  });

  it("says why a capital helps, in one plain sentence or two", () => {
    expect(CAPITAL_NUDGE_MESSAGE).toMatch(/^[^\n]+\.$/);
    expect(CAPITAL_NUDGE_MESSAGE).toMatch(/capital/);
  });

  it("exports the same rules from the main entry", () => {
    expect(main.MEMBER_NAME_RULES).toBe(MEMBER_NAME_RULES);
    expect(main.isValidMemberName).toBe(isValidMemberName);
    expect(main.memberNameKey).toBe(memberNameKey);
    expect(main.needsCapitalNudge).toBe(needsCapitalNudge);
    expect(main.CAPITAL_NUDGE_MESSAGE).toBe(CAPITAL_NUDGE_MESSAGE);
  });
});
