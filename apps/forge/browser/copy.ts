// Copy buttons, with the same behaviour on all of the page. A press copies the
// text, and the button shows "Copied" for a short time. An icon button shows a
// check mark in place of its copy icon for the same time. A hidden live region
// tells a screen reader the same. The stage draws its buttons again for each
// new state. Thus a new button for text that the person copied a short time
// ago also shows "Copied". An open modal dialog hides the rest of the page from
// a screen reader, so each dialog has a live region of its own.

import { byId, h, svg } from "./h.ts";

const SHOWN_MS = 1600;

/** The time at which the "Copied" label ends, for each copied text. */
const recent = new Map<string, number>();

/** Forget the copies whose "Copied" label has ended, so the map holds only recent ones. */
function forgetEnded(now: number) {
  for (const [text, until] of recent) if (until <= now) recent.delete(text);
}

/** A hidden live region in each dialog, made once, before any copy, so that its first announcement is heard. */
for (const dialog of document.querySelectorAll("dialog")) dialog.append(h("p", { class: "copy-live visually-hidden", "aria-live": "polite" }));

/** The live region that a screen reader hears for `button`: its dialog's, or the page's. */
function liveRegion(button: HTMLButtonElement): HTMLElement {
  return button.closest("dialog")?.querySelector<HTMLElement>(":scope > .copy-live") ?? byId("copy-live");
}

/** The copy icon: two sheets, one on top of the other. */
const copyIcon = () =>
  svg(
    "svg",
    { viewBox: "0 0 16 16", width: 16, height: 16, "aria-hidden": "true", focusable: "false" },
    svg("rect", { x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.5 }),
    svg("path", { d: "M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H3.5A1.5 1.5 0 0 0 2 3v5.5A1.5 1.5 0 0 0 3.5 10h.5" }),
  );

/** The check mark that an icon button shows after a copy. */
const checkIcon = () => svg("svg", { viewBox: "0 0 16 16", width: 16, height: 16, "aria-hidden": "true", focusable: "false" }, svg("path", { d: "M3 8.5l3.2 3L13 4.5" }));

/** Show "Copied" on `button` for `ms` milliseconds. Then show its own label again. */
function showCopied(button: HTMLButtonElement, ms: number) {
  const icon = button.classList.contains("copy-icon");
  const label = button.dataset.label ?? button.textContent ?? "Copy";
  if (!icon) button.dataset.label = label;
  button.dataset.copied = "";
  if (icon) button.replaceChildren(checkIcon());
  else button.textContent = "Copied ✓";
  clearTimeout(Number(button.dataset.timer));
  button.dataset.timer = String(
    setTimeout(() => {
      delete button.dataset.copied;
      if (icon) button.replaceChildren(copyIcon());
      else button.textContent = label;
    }, ms),
  );
}

/** Copy `text`, and show "Copied" on `button`. */
export async function copy(button: HTMLButtonElement, text: string) {
  await navigator.clipboard.writeText(text);
  forgetEnded(Date.now());
  recent.set(text, Date.now() + SHOWN_MS);
  showCopied(button, SHOWN_MS);
  const live = liveRegion(button);
  live.textContent = "";
  live.textContent = "Copied.";
}

/** A copy button for `text` that shows only an icon, for a line of text. `label` names it for a screen reader. */
export function copyIconButton(text: string, label: string): HTMLButtonElement {
  const button: HTMLButtonElement = h("button", { type: "button", class: "copy-icon", "aria-label": label, title: label, onclick: () => void copy(button, text) }, copyIcon());
  const left = (recent.get(text) ?? 0) - Date.now();
  if (left > 0) showCopied(button, left);
  return button;
}

/** A Copy button for `text`. */
export function copyButton(text: string, label = "Copy", attrs: Record<string, unknown> = {}): HTMLButtonElement {
  const button: HTMLButtonElement = h("button", { type: "button", class: "copy", ...attrs, onclick: () => void copy(button, text) }, label);
  const left = (recent.get(text) ?? 0) - Date.now();
  if (left > 0) showCopied(button, left);
  return button;
}
