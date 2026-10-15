// The demo's sign-in, codes and settings panes, connected as on the demo page,
// with these changes. Sign in asks for a passkey at once. The sign-in pane
// opens only when that request does not sign in, so that the person can try
// again or recover. Register opens the same pane with only the register form.
// After the page makes a passkey, that passkey can become the promoter key
// (see `passkeyMade`). An operator, named by OPERATOR_RECORD_IDS, also gets the
// demo's operator section in settings, with the forge's own confirm sheet.

import type { PublicKeyCredentialHint } from "passkey-cloudflare/browser";
import { CodesPane } from "../../demo/browser/codes-pane.ts";
import { $, input, openPane, pane, paneStatus, status, type PaneId } from "../../demo/browser/dom.ts";
import type { OperatorAction } from "../../demo/browser/demo-client.ts";
import type { Flows, Told } from "../../demo/browser/flows.ts";
import { OperatorPane } from "../../demo/browser/operator-pane.ts";
import { SettingsPane } from "../../demo/browser/settings-pane.ts";
import { SignInPane } from "../../demo/browser/sign-in-pane.ts";
import { ask } from "./ask.ts";
import { copy } from "./copy.ts";

interface PaneHooks {
  flows: Flows;
  /** Run a passkey action, one at a time. */
  passkeyAction<A extends unknown[]>(fn: (...args: A) => Promise<unknown>): (...args: A) => void;
  guard<A extends unknown[]>(fn: (...args: A) => Promise<unknown>): (...args: A) => void;
  /** The panes call this when the signed-in person possibly changed. */
  refresh(): Promise<void>;
  /** The panes call this after the page makes a passkey. */
  passkeyMade(): Promise<void>;
  signedOut(): Promise<void>;
}

export function wirePanes(hooks: PaneHooks) {
  const { flows, passkeyAction, guard } = hooks;
  const signIn = new SignInPane();
  const codes = new CodesPane();
  const settings = new SettingsPane();
  const operator = new OperatorPane();
  const tellIn = (id: PaneId, told: Told) => paneStatus(id, told.message);

  async function showSettings() {
    const who = await flows.me();
    if (!who) return settings.close();
    settings.show(await flows.settings(who), passkeyAction(revokePasskey));
  }

  /**
   * Open the sign-in pane in `mode`. In "sign-in" mode, it says `reason` and
   * offers to try the passkey again or to recover. In "register" mode, it
   * shows only the register form.
   */
  function openAs(mode: "sign-in" | "register", reason = "") {
    pane("sign-in").dataset.mode = mode;
    $("sign-in-title").textContent = mode === "register" ? "Register" : "Sign in";
    $("sign-in-status").textContent = "";
    $("choices-reason").textContent = reason;
    $("entry").hidden = false;
    $("choices").hidden = false;
    $("rebind").hidden = true;
    openPane("sign-in");
    (mode === "register" ? input("register-name") : $("continue")).focus();
  }

  /** Sign in with a passkey at once. Only when no passkey signs in, open the pane. */
  async function signInNow() {
    status("");
    const loggedIn = await flows.continueWithPasskey();
    if (loggedIn.result === "signed-in") {
      signIn.close();
      await hooks.refresh();
      return;
    }
    if (loggedIn.result === "no-passkey") {
      openAs("sign-in", "No passkey was used. If you have a passkey for this site, try again. If you lost yours, recover with a recovery code.");
      return;
    }
    openAs("sign-in", "Try again with another passkey, or recover with a recovery code.");
    paneStatus("sign-in", "That passkey was not accepted.");
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
    const revoking = await ask({ title: `Revoke the passkey ${label}?`, message: "It will no longer sign in.", confirm: "Revoke", danger: true });
    if (!revoking) return;
    await settled(await flows.revoke(label));
  }

  async function rotateCodes() {
    const replacing = await ask({
      title: "Replace your recovery codes?",
      message: "You get a fresh set of 8, shown once. The old ones stop working at once.",
      confirm: "Replace them",
    });
    if (!replacing) return;
    const rotated = await flows.rotateCodes();
    if (rotated.result === "told") return tellIn("settings", rotated);
    settings.hideRotatePrompt();
    codes.show(await flows.codes(rotated));
  }

  async function lookUpMember(event: SubmitEvent) {
    event.preventDefault();
    const memberName = String(new FormData(event.target as HTMLFormElement).get("memberName"));
    operator.clear();
    const found = await flows.lookUpMember(memberName);
    if (!settings.isOpen) return;
    if (found.result === "told") return tellIn("settings", found);
    operator.lookedUp(found);
  }

  async function operatorAction(action: OperatorAction) {
    const member = operator.member;
    if (!member) return;
    const { memberName } = member;
    if (action === "remove") {
      const removing = await ask({ title: `Remove ${memberName}?`, message: "This can't be undone, and their name will be retired.", confirm: "Remove", danger: true });
      if (!removing) return;
    }
    if (action === "allow-name") {
      const allowing = await ask({ title: `Let anyone register ${memberName} again?`, message: "The removed member stays removed.", confirm: "Allow the name" });
      if (!allowing) return;
    }
    const acted = await flows.operatorAction(action, member);
    if (!settings.isOpen) return;
    if (acted.result === "told") return tellIn("settings", acted);
    operator.acted(acted);
  }

  async function signedOut() {
    settings.close();
    await hooks.signedOut();
  }

  const signInAction = passkeyAction(signInNow);
  const openRegister = () => openAs("register");
  $("open-sign-in").addEventListener("click", signInAction);
  $("open-register").addEventListener("click", openRegister);
  $("switch-to-register").addEventListener("click", openRegister);
  $("switch-to-sign-in").addEventListener("click", signInAction);
  $("open-settings").addEventListener("click", guard(async () => {
    settings.clearStatus();
    await showSettings();
  }));
  for (const close of document.querySelectorAll<HTMLButtonElement>("#sign-in .close, #settings .close")) {
    close.addEventListener("click", () => close.closest("dialog")!.close());
  }
  // A new message in the status line of a pane scrolls into view, so the person sees it.
  for (const id of ["sign-in-status", "codes-status", "settings-status"]) {
    const line = $(id);
    new MutationObserver(() => {
      if (line.textContent) line.scrollIntoView({ block: "nearest" });
    }).observe(line, { childList: true, characterData: true, subtree: true });
  }
  pane("codes").addEventListener("cancel", (event) => event.preventDefault());
  pane("codes").addEventListener("close", () => codes.closed());
  pane("sign-in").addEventListener("close", () => flows.stopAutofill());
  $("continue").addEventListener("click", signInAction);
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
    await copy($<HTMLButtonElement>("codes-copy"), codes.text);
  }));
  $("copy-record-id").addEventListener("click", guard(async () => {
    await copy($<HTMLButtonElement>("copy-record-id"), settings.recordId);
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
  $("operator-form").addEventListener("submit", passkeyAction((event: Event) => lookUpMember(event as SubmitEvent)));
  $("operator-form").addEventListener("input", () => operator.clear());
  for (const action of operator.actions()) {
    action.addEventListener("click", passkeyAction(() => operatorAction(action.value as OperatorAction)));
  }

  return { signIn: signInAction, openRegister };
}
