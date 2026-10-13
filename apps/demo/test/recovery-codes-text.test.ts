import { formatRecoveryCodes } from "passkey-cloudflare/browser";
import { describe, expect, it } from "vitest";

const codes = [
  "ur:seed/oyadgdinaauyatsojkdmflfdfrfxtpbkvyfrzmcwntvdta",
  "ur:seed/oyadgdtbhtwnrnehadcyhdcwmhecfpaordfnlpjztolbtpas",
];

describe("recovery codes as text", () => {
  it("names the site, the member and the issue time, then numbers the codes", () => {
    const text = formatRecoveryCodes({
      site: "passkeydemo.gordianstack.com",
      memberName: "José",
      issuedAt: Date.UTC(2026, 8, 27, 23, 30),
      codes,
    });

    expect(text).toBe(
      [
        "Recovery codes for passkeydemo.gordianstack.com",
        "Member name: José",
        "Issued: 2026-09-27 23:30 UTC",
        "",
        "1. ur:seed/oyadgdinaauyatsojkdmflfdfrfxtpbkvyfrzmcwntvdta",
        "2. ur:seed/oyadgdtbhtwnrnehadcyhdcwmhecfpaordfnlpjztolbtpas",
        "",
        "Each code works once. Recover at passkeydemo.gordianstack.com with your member name and one code.",
        "",
      ].join("\n"),
    );
  });

  it("uses the friendlier site name an application passes", () => {
    const text = formatRecoveryCodes({ site: "Gordian Stack", memberName: "Ada", issuedAt: 0, codes });

    expect(text.split("\n")[0]).toBe("Recovery codes for Gordian Stack");
    expect(text).toContain("Recover at Gordian Stack with your member name");
  });
});
