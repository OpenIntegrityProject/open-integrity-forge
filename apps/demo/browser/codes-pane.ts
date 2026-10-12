// The codes pane: a fresh set of recovery codes, shown once, as codes or as
// words, until the person says they saved them. No requests.

import { $, button, closePane, input, openPane, pane } from "./dom.ts";
import type { CodesView } from "./flows.ts";

export class CodesPane {
  private shown: CodesView = { recoveryCodes: [], recoveryCodeWords: [], header: [], text: "" };
  private showingWords = false;
  // The pane stays open until the person says they saved the codes.
  private saved = false;

  show(codes: CodesView) {
    this.shown = codes;
    $("codes-header").textContent = codes.header.join("\n");
    this.list(false);
    // The codes are shown once, so Continue waits for the person to say they saved them.
    input("codes-saved").checked = false;
    button("codes-done").disabled = true;
    $("codes-status").textContent = "";
    this.saved = false;
    openPane("codes");
  }

  /** Switch between each code as its UR and the same UR body in words, for reading aloud or writing down. */
  toggle() {
    this.list(!this.showingWords);
  }

  /** The codes as text to keep, always in their UR form. */
  get text() {
    return this.shown.text;
  }

  savedChanged() {
    button("codes-done").disabled = !input("codes-saved").checked;
  }

  /** Close for good, the person having saved the codes. */
  leave() {
    this.saved = true;
    closePane("codes");
  }

  /**
   * Esc does not leave codes that are shown once. Chrome may close a dialog on a
   * repeated Esc even so, and the pane opens again until the person has saved them.
   * Already open again when `lendPage` closed it for a passkey request.
   */
  closed() {
    if (!this.saved && !pane("codes").open) pane("codes").showModal();
  }

  private list(asWords: boolean) {
    this.showingWords = asWords;
    const codes = asWords ? this.shown.recoveryCodeWords : this.shown.recoveryCodes;
    $("code-list").replaceChildren(
      ...codes.map((code) => {
        const li = document.createElement("li");
        li.textContent = code;
        return li;
      }),
    );
    $("codes-toggle").textContent = asWords ? "Show as codes" : "Show as words";
  }
}
