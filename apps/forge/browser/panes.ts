// The demo's sign-in, codes and settings panes, wired as on the demo page.
// The forge adds one thing: after a passkey is made here, it may become the
// promoter key (see `passkeyMade`).

import type { PublicKeyCredentialHint } from "passkey-cloudflare/browser";
import { CodesPane } from "../../demo/browser/codes-pane.ts";
import { $, input, pane, paneStatus, status, type PaneId } from "../../demo/browser/dom.ts";
import type { Flows, Told } from "../../demo/browser/flows.ts";
import { SettingsPane } from "../../demo/browser/settings-pane.ts";
import { SignInPane } from "../../demo/browser/sign-in-pane.ts";

export interface PaneHooks {
  flows: Flows;
  /** Run a passkey action, one at a time. */
  passkeyAction<A extends unknown[]>(fn: (...args: A) => Promise<unknown>): (...args: A) => void;
  guard<A extends unknown[]>(fn: (...args: A) => Promise<unknown>): (...args: A) => void;
  isPasskeyActionRunning(): boolean;
  /** Called when the signed-in person may have changed. */
  refresh(): Promise<void>;
  /** Called after a passkey was made on this page. */
  passkeyMade(): Promise<void>;
  signedOut(): Promise<void>;
}

export function wirePanes(hooks: PaneHooks) {
  const { flows, passkeyAction, guard } = hooks;
  const signIn = new SignInPane();
  const codes = new CodesPane();
  const settings = new SettingsPane();
  const tellIn = (id: PaneId, told: Told) => paneStatus(id, told.message);

  async function showSettings() {
    const who = await flows.me();
    if (!who) return settings.close();
    settings.show(await flows.settings(who), passkeyAction(revokePasskey));
  }

  async function openSignIn() {
    if (hooks.isPasskeyActionRunning()) return;
    await signIn.open();
    await autofill();
  }

  async function autofill() {
    if (!(await flows.offersAutofill()) || !signIn.isOpen) return;
    signIn.offerAutofill();
    const loggedIn = await flows.autofill(() => signIn.autofillWaiting());
    if (loggedIn.result === "no-passkey") return;
    if (loggedIn.result === "not-accepted") return signIn.notAccepted();
    signIn.close();
    await hooks.refresh();
  }

  async function continueWithPasskey() {
    status("");
    const loggedIn = await flows.continueWithPasskey();
    if (loggedIn.result === "no-passkey") return signIn.noPasskeyUsed();
    if (loggedIn.result === "not-accepted") return signIn.notAccepted();
    signIn.close();
    await hooks.refresh();
  }

  async function register(event: SubmitEvent) {
    event.preventDefault();
    const memberName = String(new FormData(event.target as HTMLFormElement).get("memberName"));
    if (signIn.nudged(memberName)) return;
    const registered = await flows.register(memberName);
    if (registered.result === "told") return tellIn("sign-in", registered);
    signIn.close();
    await hooks.passkeyMade();
    await hooks.refresh();
    codes.show(await flows.codes(registered));
  }

  async function recover(event: SubmitEvent) {
    event.preventDefault();
    const form = new FormData(event.target as HTMLFormElement);
    const recovered = await flows.recover(String(form.get("memberName")), String(form.get("code")));
    if (recovered.result === "told") return tellIn("sign-in", recovered);
    signIn.close();
    await hooks.refresh();
    settings.promptRotate(recovered.codesLeft);
    await showSettings();
  }

  async function settled(told: Told) {
    if (!settings.isOpen) return;
    tellIn("settings", told);
    if (!told.declined) await showSettings();
  }

  async function addPasskey(hint: PublicKeyCredentialHint) {
    await settled(await flows.addPasskey(hint));
    await hooks.passkeyMade();
    await hooks.refresh();
  }

  async function revokePasskey(label: string) {
    if (!confirm(`Revoke the passkey ${label}? It will no longer log in.`)) return;
    await settled(await flows.revoke(label));
  }

  async function rotateCodes() {
    if (!confirm("Replace your recovery codes? The old ones will stop working.")) return;
    const rotated = await flows.rotateCodes();
    if (rotated.result === "told") return tellIn("settings", rotated);
    settings.hideRotatePrompt();
    codes.show(await flows.codes(rotated));
  }

  async function signedOut() {
    settings.close();
    await hooks.signedOut();
  }

  $("open-sign-in").addEventListener("click", guard(openSignIn));
  $("open-settings").addEventListener("click", guard(async () => {
    settings.clearStatus();
    await showSettings();
  }));
  for (const close of document.querySelectorAll<HTMLButtonElement>("#sign-in .close, #settings .close")) {
    close.addEventListener("click", () => close.closest("dialog")!.close());
  }
  pane("codes").addEventListener("cancel", (event) => event.preventDefault());
  pane("codes").addEventListener("close", () => codes.closed());
  pane("sign-in").addEventListener("close", () => flows.stopAutofill());
  $("continue").addEventListener("click", passkeyAction(continueWithPasskey));
  for (const toggle of document.querySelectorAll<HTMLButtonElement>(".info-toggle")) {
    const info = $(toggle.getAttribute("aria-controls")!);
    toggle.addEventListener("click", () => {
      const open = info.hidden;
      info.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
    });
  }
  $("register-name").addEventListener("input", (event) => signIn.nameTyped(event, (name) => flows.memberNameAvailable(name)));
  $("register-form").addEventListener("submit", passkeyAction((event: Event) => register(event as SubmitEvent)));
  $("recover-form").addEventListener("submit", passkeyAction((event: Event) => recover(event as SubmitEvent)));
  input("codes-saved").addEventListener("change", () => codes.savedChanged());
  $("codes-done").addEventListener("click", guard(async () => {
    codes.leave();
    if (settings.isOpen) await showSettings();
  }));
  $("codes-toggle").addEventListener("click", () => codes.toggle());
  $("codes-copy").addEventListener("click", guard(async () => {
    await navigator.clipboard.writeText(codes.text);
    status("Copied your recovery codes.");
  }));
  $("copy-record-id").addEventListener("click", guard(async () => {
    await navigator.clipboard.writeText(settings.recordId);
    status("Copied your record id.");
  }));
  for (const hint of ["client-device", "hybrid", "security-key"] as const) {
    $(`add-passkey-${hint}`).addEventListener("click", passkeyAction(() => addPasskey(hint)));
  }
  $("rotate-codes").addEventListener("click", passkeyAction(rotateCodes));
  $("rotate-now").addEventListener("click", passkeyAction(rotateCodes));
  $("logout").addEventListener("click", guard(async () => {
    await flows.logout();
    await signedOut();
  }));
  $("logout-everywhere").addEventListener("click", guard(async () => {
    await flows.logoutEverywhere();
    await signedOut();
  }));
  $("logout-elsewhere").addEventListener("click", passkeyAction(async () => settled(await flows.logoutElsewhere())));

  return { openSignIn: guard(openSignIn) };
}
