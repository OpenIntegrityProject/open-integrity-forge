import { REBIND_LINK_LIFETIME_MS, RECOVERY_CODE_COUNT, SESSION_LIFETIME_MS } from "passkey-cloudflare";
import { describe, expect, it } from "vitest";
import page from "../public/index.html?raw";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The text of the page's paragraph with this id. */
function paragraph(id: string): string {
  const match = page.match(new RegExp(`<p id="${id}"[^>]*>([^<]*)</p>`));
  if (!match) throw new Error(`no paragraph #${id} in index.html`);
  return match[1]!.replace(/\s+/g, " ").trim();
}

describe("info texts on the demo page", () => {
  it("state the library's recovery code count", () => {
    expect(paragraph("codes-info")).toContain(`a fresh set of ${RECOVERY_CODE_COUNT},`);
  });

  it("state the library's session lifetime", () => {
    expect(paragraph("sessions-info")).toContain(`signed in for ${SESSION_LIFETIME_MS / DAY_MS} days.`);
  });

  it("state the library's rebind link lifetime", () => {
    expect(paragraph("operator-info")).toContain(`within ${REBIND_LINK_LIFETIME_MS / HOUR_MS} hours,`);
  });
});
