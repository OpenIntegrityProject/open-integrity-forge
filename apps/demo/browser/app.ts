// The demo's app shell: a placeholder where an app built on the library would go, a sign-in pane,
// a settings pane for passkeys and sessions, and a pane for fresh recovery codes.
// Bundled into public/app.js by esbuild; see build.command in wrangler.jsonc.
//
// This file connects events to flows and flows to panes. The flows (flows.ts)
// make the requests and touch no DOM; the panes render and make no requests.
// One passkey action runs at a time.

import type { PublicKeyCredentialHint } from "passkey-cloudflare/browser";
import type { OperatorAction } from "./demo-client.ts";
import { CodesPane } from "./codes-pane.ts";
import { $, input, lendPage, pane, paneStatus, status, type PaneId } from "./dom.ts";
import { pageFlows, type CodeForm, type Told } from "./flows.ts";
import { OperatorPane } from "./operator-pane.ts";
import { SettingsPane } from "./settings-pane.ts";
import { showApp } from "./shell.ts";
import { SignInPane } from "./sign-in-pane.ts";

const flows = pageFlows(location, lendPage);

const signIn = new SignInPane();
const codes = new CodesPane();
const settings = new SettingsPane();
const operator = new OperatorPane();

/** Tell `told` in pane `id`, unless the pane closed while the action ran. */
const tellIn = (id: PaneId, told: Told) => paneStatus(id, told.message);

function guard<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  return (...args: A) =>
    void fn(...args).catch((error) => {
      console.error(error);
      status("Something went wrong.");
    });
}

/** Whether a passkey action, one that may ask for a passkey, is running. */
let passkeyActionRunning = false;

/**
 * Guard a passkey action, and start it only when no other is running. A second
 * press while a passkey request waits on a picker would start a second
 * request, and a password manager may answer both, the one it was not picked
 * for with a refusal.
 */
function passkeyAction<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  return guard(async (...args: A) => {
    if (passkeyActionRunning) return;
    passkeyActionRunning = true;
    try {
      await fn(...args);
    } finally {
      passkeyActionRunning = false;
    }
  });
}

/** Draw the app for whoever is signed in. */
async function refreshApp() {
  showApp(await flows.me());
}

/** Fill the settings pane from the server and open it; a lapsed session leaves for the signed-out app. */
async function showSettings() {
  const me = await flows.me();
  showApp(me);
  if (!me) return settings.close();
  settings.show(await flows.settings(me), passkeyAction(revokePasskey));
}

async function signedOut() {
  settings.close();
  await refreshApp();
}

// --- sign-in pane -----------------------------------------------------------

async function openSignIn() {
  // The app bar takes clicks while a passkey request runs; its autofill request would start beside that one.
  if (passkeyActionRunning) return;
  await signIn.open();
  await autofill();
}

/**
 * Where Continue would need a sheet, offer passkeys in the member-name field's
 * autofill from when the pane opens until it closes or another passkey request
 * starts. A stopped request ends here quietly.
 */
async function autofill() {
  // Closed while the capabilities were checked: closing stopped nothing yet, so start nothing.
  if (!(await flows.offersAutofill()) || !signIn.isOpen) return;
  signIn.offerAutofill();
  const loggedIn = await flows.autofill(() => signIn.autofillWaiting());
  if (loggedIn.result === "no-passkey") return;
  if (loggedIn.result === "not-accepted") return signIn.notAccepted();
  signIn.close();
  await refreshApp();
}

async function continueWithPasskey() {
  status("");
  const loggedIn = await flows.continueWithPasskey();
  if (loggedIn.result === "no-passkey") return signIn.noPasskeyUsed();
  if (loggedIn.result === "not-accepted") return signIn.notAccepted();
  signIn.close();
  await refreshApp();
}

async function register(event: SubmitEvent) {
  event.preventDefault();
  const memberName = String(new FormData(event.target as HTMLFormElement).get("memberName"));
  // An all-lowercase name registers on the second press, once the nudge has shown.
  if (signIn.nudged(memberName)) return;
  const registered = await flows.register(memberName);
  if (registered.result === "told") return tellIn("sign-in", registered);
  signIn.close();
  await refreshApp();
  codes.show(await flows.codes(registered));
}

async function recover(event: SubmitEvent) {
  event.preventDefault();
  const form = new FormData(event.target as HTMLFormElement);
  const recovered = await flows.recover(String(form.get("memberName")), String(form.get("code")));
  if (recovered.result === "told") return tellIn("sign-in", recovered);
  signIn.close();
  await refreshApp();
  // Recovery ends in settings, where the prompt to replace the codes waits at the top.
  settings.promptRotate(recovered.codesLeft);
  await showSettings();
}

async function rebind() {
  const rebound = await flows.rebind(location.hash.slice(1));
  if (rebound.result === "told") return tellIn("sign-in", rebound);
  history.replaceState(null, "", "/");
  signIn.close();
  await refreshApp();
}

/** Leave the codes for where the person was: settings after a replacement, else the app. */
async function leaveCodes() {
  codes.leave();
  if (settings.isOpen) await showSettings();
}

// --- settings pane ----------------------------------------------------------

/** Tell the outcome of a settings action, and redraw settings unless the person declined it or closed it meanwhile. */
async function settled(told: Told) {
  if (!settings.isOpen) return;
  tellIn("settings", told);
  if (!told.declined) await showSettings();
}

async function addPasskey(hint: PublicKeyCredentialHint) {
  await settled(await flows.addPasskey(hint));
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
  if (action === "remove" && !confirm(`Remove ${memberName}? This can't be undone, and their name will be retired.`)) return;
  if (action === "allow-name" && !confirm(`Let anyone register ${memberName} again? The removed member stays removed.`)) return;
  const acted = await flows.operatorAction(action, member);
  if (!settings.isOpen) return;
  if (acted.result === "told") return tellIn("settings", acted);
  operator.acted(acted);
}

// --- wiring -----------------------------------------------------------------

$("open-sign-in").addEventListener("click", guard(openSignIn));
$("open-settings").addEventListener("click", guard(async () => {
  settings.clearStatus();
  await showSettings();
}));
for (const close of document.querySelectorAll<HTMLButtonElement>("dialog .close")) {
  close.addEventListener("click", () => close.closest("dialog")!.close());
}
pane("codes").addEventListener("cancel", (event) => event.preventDefault());
pane("codes").addEventListener("close", () => codes.closed());
pane("sign-in").addEventListener("close", () => flows.stopAutofill());
$("continue").addEventListener("click", passkeyAction(continueWithPasskey));
for (const toggle of document.querySelectorAll<HTMLButtonElement>(".info-toggle")) {
  const controls = toggle.getAttribute("aria-controls");
  if (!controls) throw new Error(`#${toggle.id} names no aria-controls`);
  const info = $(controls);
  toggle.addEventListener("click", () => {
    const open = info.hidden;
    info.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
  });
}
$("register-name").addEventListener("input", (event) =>
  signIn.nameTyped(event, (name) => flows.memberNameAvailable(name)),
);
$("register-form").addEventListener("submit", passkeyAction((event: Event) => register(event as SubmitEvent)));
$("recover-form").addEventListener("submit", passkeyAction((event: Event) => recover(event as SubmitEvent)));
$("rebind-button").addEventListener("click", passkeyAction(rebind));
input("codes-saved").addEventListener("change", () => codes.savedChanged());
$("codes-done").addEventListener("click", guard(leaveCodes));
$("codes-form").addEventListener("change", (event) => codes.choose((event.target as HTMLInputElement).value as CodeForm));
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
$("logout-elsewhere").addEventListener("click", passkeyAction(async () => {
  await settled(await flows.logoutElsewhere());
}));
$("operator-form").addEventListener("submit", passkeyAction((event: Event) => lookUpMember(event as SubmitEvent)));
$("operator-form").addEventListener("input", () => operator.clear());
for (const action of operator.actions()) {
  action.addEventListener("click", passkeyAction(() => operatorAction(action.value as OperatorAction)));
}

// A rebind link opens the sign-in pane at its passkey; anything else shows the app.
if (location.pathname === "/rebind" && location.hash.length > 1) {
  guard(async () => {
    await refreshApp();
    await signIn.open("rebind");
  })();
} else {
  guard(refreshApp)();
}
