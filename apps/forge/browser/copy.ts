// Copy buttons, with the same behaviour on all of the page. A press copies the
// text, and the button shows "Copied" for a short time. A hidden live region
// tells a screen reader the same. The stage draws its buttons again for each
// new state. Thus a new button for text that the person copied a short time
// ago also shows "Copied".

import { byId, h } from "./h.ts";

const SHOWN_MS = 1600;

/** The time at which the "Copied" label ends, for each copied text. */
const recent = new Map<string, number>();

/** Show "Copied" on `button` for `ms` milliseconds. Then show its own label again. */
function showCopied(button: HTMLButtonElement, ms: number) {
  const label = button.dataset.label ?? button.textContent ?? "Copy";
  button.dataset.label = label;
  button.dataset.copied = "";
  button.textContent = "Copied ✓";
  clearTimeout(Number(button.dataset.timer));
  button.dataset.timer = String(
    setTimeout(() => {
      delete button.dataset.copied;
      button.textContent = label;
    }, ms),
  );
}

/** Copy `text`, and show "Copied" on `button`. */
export async function copy(button: HTMLButtonElement, text: string) {
  await navigator.clipboard.writeText(text);
  recent.set(text, Date.now() + SHOWN_MS);
  showCopied(button, SHOWN_MS);
  const live = byId("copy-live");
  live.textContent = "";
  live.textContent = "Copied.";
}

/** A Copy button for `text`. */
export function copyButton(text: string, label = "Copy", attrs: Record<string, unknown> = {}): HTMLButtonElement {
  const button: HTMLButtonElement = h("button", { type: "button", class: "copy", ...attrs, onclick: () => void copy(button, text) }, label);
  const left = (recent.get(text) ?? 0) - Date.now();
  if (left > 0) showCopied(button, left);
  return button;
}
