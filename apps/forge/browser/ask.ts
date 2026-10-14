// The ask sheet: a question before an action, in place of the browser's
// confirm(). The sheet tells what the action does. Then it waits until the
// person confirms or cancels. The focus starts on Cancel, so that a key press
// does not start the action.

import { byId, h } from "./h.ts";

interface Question {
  title: string;
  message: string;
  /** The label of the button that starts the action. */
  confirm: string;
  /** True for an action that the person cannot undo. */
  danger?: boolean;
}

/** Ask the person the question. True when the person confirms; false when the person cancels or closes the sheet. */
export function ask({ title, message, confirm, danger = false }: Question): Promise<boolean> {
  const dialog = byId<HTMLDialogElement>("ask");
  const go = h("button", { type: "button", class: danger ? "danger" : "primary" }, confirm);
  const cancel = h("button", { type: "button" }, "Cancel");
  dialog.replaceChildren(h("h2", { id: "ask-title" }, title), h("p", null, message), h("div", { class: "sheet-actions" }, cancel, go));
  return new Promise((resolve) => {
    const done = (yes: boolean) => {
      dialog.removeEventListener("close", closed);
      if (dialog.open) dialog.close();
      resolve(yes);
    };
    const closed = () => done(false);
    dialog.addEventListener("close", closed);
    go.addEventListener("click", () => done(true));
    cancel.addEventListener("click", () => done(false));
    dialog.showModal();
    cancel.focus();
  });
}
