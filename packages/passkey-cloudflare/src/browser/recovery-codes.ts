// A fresh set of recovery codes as text to copy and keep. The codes belong to
// the identity record and outlive the passkey that issued them, so the text
// names no passkey.

export interface RecoveryCodesText {
  /** The site the codes recover at: the RP ID, or a friendlier name the application chooses. */
  site: string;
  memberName: string;
  /** When the server issued the set, in milliseconds since the epoch. Shown in UTC, to the minute. */
  issuedAt: number;
  codes: string[];
}

/** The header's lines: the site, the member name and the issue time. */
export function recoveryCodesHeader({ site, memberName, issuedAt }: Omit<RecoveryCodesText, "codes">): string[] {
  const iso = new Date(issuedAt).toISOString();
  return [
    `Recovery codes for ${site}`,
    `Member name: ${memberName}`,
    `Issued: ${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`,
  ];
}

/**
 * The header, the codes numbered one per line, and how to use them. A whole
 * numbered line pasted where a code is asked for is accepted as that code.
 */
export function formatRecoveryCodes(text: RecoveryCodesText): string {
  const { site, codes } = text;
  return [
    ...recoveryCodesHeader(text),
    "",
    ...codes.map((code, i) => `${i + 1}. ${code}`),
    "",
    `Each code works once. Recover at ${site} with your member name and one code.`,
    "",
  ].join("\n");
}
