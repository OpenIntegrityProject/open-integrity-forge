// The sign-in pane: Continue, then register and recover when Continue ends
// without a passkey, or a rebind link's passkey. No requests: the member-name
// check is the caller's, handed in.

import {
  CAPITAL_NUDGE_MESSAGE,
  canFindWithoutSheet,
  MEMBER_NAME_RULES,
  needsCapitalNudge,
} from "passkey-cloudflare/browser";
import { $, closePane, input, openPane, pane, paneStatus } from "./dom.ts";

const CHOICES_GUIDANCE = "If you do not have a passkey here yet, register; if you lost yours, recover.";

export class SignInPane {
  private availabilityTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    input("register-name").minLength = MEMBER_NAME_RULES.minLength;
    // No maxLength: it counts a decomposed name before the input handler composes
    // it, and would cut a pasted name short. The pattern holds the upper bound.
    input("register-name").pattern = MEMBER_NAME_RULES.pattern;
    $("name-rules").textContent = MEMBER_NAME_RULES.description;
  }

  /**
   * Open at `step`: Continue and the choices, or a rebind link's passkey.
   * A browser without immediate mediation cannot say "no passkey here" without a
   * sheet to cancel, so register and recover show at once; with it, they wait
   * for Continue to end without a passkey. With the choices showing, the pane
   * opens on the member-name field, where autofill offers a passkey only once
   * the field has focus; otherwise on its step's button.
   */
  async open(step: "entry" | "rebind" = "entry") {
    $("sign-in-status").textContent = "";
    $("entry").hidden = step !== "entry";
    $("rebind").hidden = step !== "rebind";
    const choicesAtOnce = step === "entry" && !(await canFindWithoutSheet());
    if (choicesAtOnce) this.revealChoices(CHOICES_GUIDANCE);
    else if (step === "entry") $("choices").hidden = true;
    openPane("sign-in");
    if (choicesAtOnce) input("register-name").focus();
  }

  close() {
    closePane("sign-in");
  }

  get isOpen() {
    return pane("sign-in").open;
  }

  /** Let the member-name field offer passkeys in its autofill. */
  offerAutofill() {
    input("register-name").autocomplete = "username webauthn";
  }

  /**
   * The autofill request now waits. Safari offers its passkey only to a focus
   * that comes after that, so a member-name field focused since the pane
   * opened is focused again; focus the person moved elsewhere stays there.
   */
  autofillWaiting() {
    const name = input("register-name");
    if (!this.isOpen || document.activeElement !== name) return;
    name.blur();
    name.focus();
  }

  /**
   * Continue used no passkey: no passkey here, or a dismissed picker, so the message says only that none was used.
   * Says nothing once the pane has closed, as it has when another request signed in.
   */
  noPasskeyUsed() {
    if (!this.isOpen) return;
    this.revealChoices(`No passkey was used. ${CHOICES_GUIDANCE}`);
  }

  /** Says nothing once the pane has closed, as it has when another request signed in. */
  notAccepted() {
    if (!this.isOpen) return;
    paneStatus("sign-in", "That passkey was not accepted.");
    this.revealChoices("You can register, or recover with a recovery code.");
  }

  /** Reveal register and recover. Never registers anyone by itself. */
  private revealChoices(reason: string) {
    $("choices-reason").textContent = reason;
    $("choices").hidden = false;
  }

  /** Compose the typed member name and, once typing pauses on a valid one, show whether `available` says it is free. */
  nameTyped(event: Event, available: (name: string) => Promise<boolean | null>) {
    clearTimeout(this.availabilityTimer);
    // The rules' pattern checks composed text, which the server stores; leave
    // text an input method is still composing alone.
    const name = input("register-name").value.normalize("NFC");
    if (!(event as InputEvent).isComposing && name !== input("register-name").value)
      input("register-name").value = name;
    $("name-availability").textContent = "";
    $("capital-nudge").hidden = true;
    if (!input("register-name").checkValidity()) return;
    this.availabilityTimer = setTimeout(async () => {
      // A refused check says nothing either way; registering still reports a taken name.
      const free = await available(name);
      if (free === null || input("register-name").value !== name) return;
      $("name-availability").textContent = free ? "Available" : "Taken";
    }, 300);
  }

  /** Nudge toward a capital letter, once: true when the nudge shows now and registering waits for a second press. */
  nudged(memberName: string): boolean {
    if (!needsCapitalNudge(memberName) || !$("capital-nudge").hidden) return false;
    $("capital-nudge").textContent = `${CAPITAL_NUDGE_MESSAGE} Register again to keep ${memberName} as typed.`;
    $("capital-nudge").hidden = false;
    return true;
  }
}
