// The settings pane: the signed-in record's passkeys and sessions, its record
// id, the suggestion to add a passkey while every one is device-bound, and the
// prompt to replace recovery codes after a recovery. No requests.

import { $, closePane, openPane, pane, row, when } from "./dom.ts";
import type { Settings } from "./flows.ts";

export class SettingsPane {
  private shownRecordId = "";

  get isOpen() {
    return pane("settings").open;
  }

  /** Fill the pane and open it; `revoke` is called with the label of a passkey whose Revoke is pressed. */
  show({ me, credentials, sessions }: Settings, revoke: (label: string) => void) {
    $("credential-rows").replaceChildren(
      ...credentials.map((c) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "Revoke";
        button.addEventListener("click", () => revoke(c.label));
        return row(
          [c.label, c.provider ?? "unknown", c.backupEligible ? "yes" : "no", when(c.createdAt), when(c.lastUsedAt)],
          button,
        );
      }),
    );
    // One passkey a password manager can copy to another device is a spare; without one, suggest adding one.
    $("device-bound-notice").hidden = credentials.some((c) => c.backupEligible);
    $("session-rows").replaceChildren(
      ...sessions.map((s) =>
        row([`${s.userAgent}${s.current ? " (this one)" : ""}`, when(s.createdAt), when(s.expiresAt)]),
      ),
    );
    this.shownRecordId = me.recordId;
    $("record-id").textContent = me.recordId;
    $("operator").hidden = !me.operator;
    openPane("settings");
  }

  clearStatus() {
    $("settings-status").textContent = "";
  }

  /** Leave for the signed-out app. */
  close() {
    closePane("settings");
    this.hideRotatePrompt();
  }

  get recordId() {
    return this.shownRecordId;
  }

  /** Prompt, at the top of the pane, to replace the codes a recovery used one of. */
  promptRotate(codesLeft: number) {
    const left = codesLeft === 0 ? "none" : codesLeft === 1 ? "1 code" : `${codesLeft} codes`;
    $("rotate-message").textContent =
      `This recovery used one of your recovery codes; you have ${left} left. ` +
      "Replace your remaining codes now, in case the set was exposed. " +
      "Replacing them stops every old code working, including any you keep elsewhere or have split into shares.";
    $("rotate-prompt").hidden = false;
  }

  hideRotatePrompt() {
    $("rotate-prompt").hidden = true;
  }
}
