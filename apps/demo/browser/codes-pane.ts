// The codes pane: a fresh set of recovery codes, shown once, as codes, as
// BIP39 words or as Bytewords, until the person says they saved them. No
// requests.

import { $, button, closePane, input, openPane, pane } from "./dom.ts";
import type { CodeForm, CodesView } from "./flows.ts";

export class CodesPane {
  private shown: CodesView = {
    forms: { code: [], bip39: [], bytewords: [] },
    header: [],
    text: { code: "", bip39: "", bytewords: "" },
  };
  private form: CodeForm = "code";
  // The pane stays open until the person says they saved the codes.
  private saved = false;

  show(codes: CodesView) {
    this.shown = codes;
    $("codes-header").textContent = codes.header.join("\n");
    this.choose("code");
    // The codes are shown once, so Continue waits for the person to say they saved them.
    input("codes-saved").checked = false;
    button("codes-done").disabled = true;
    $("codes-status").textContent = "";
    this.saved = false;
    openPane("codes");
  }

  /**
   * Show each code as its UR, as its secret's 12 BIP39 words, or as the UR
   * body in Bytewords, for reading aloud or writing down. Each form recovers.
   */
  choose(form: CodeForm) {
    this.form = form;
    input(`codes-form-${form}`).checked = true;
    $("code-list").replaceChildren(
      ...this.shown.forms[form].map((code) => {
        const li = document.createElement("li");
        li.textContent = code;
        return li;
      }),
    );
  }

  /** The codes as text to keep, in the form shown. */
  get text() {
    return this.shown.text[this.form];
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
}
