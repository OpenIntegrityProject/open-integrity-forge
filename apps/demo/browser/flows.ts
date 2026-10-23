// The demo's flows: what each thing a person can do asks of the server,
// through the demo client, and the outcome a pane shows. Flows touch no
// DOM; the panes render their outcomes, and app.ts connects the two.

import {
  autofillPasskey,
  canAutofillPasskey,
  canFindWithoutSheet,
  createPasskey,
  findPasskey,
  formatRecoveryCodes,
  recoveryCodesHeader,
  SECURITY_KEY,
  signalRevokedPasskey,
  usePasskey,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialHint,
  type PublicKeyCredentialRequestOptionsJSON,
} from "passkey-cloudflare/browser";
import type { IssuedCodes, Me, MemberView, PasskeyListing, SessionListing } from "../src/responses.ts";
import {
  DemoClient,
  type AlreadyRegistered,
  type Authenticator,
  type Cancelled,
  type GetMode,
  type OperatorAction,
  type Refused,
} from "./demo-client.ts";

/**
 * A message for the status line of the pane in front. `declined` when the
 * person made or used no passkey, so nothing changed and nothing needs redrawing.
 */
export type Told = { result: "told"; message: string; declined: boolean };

const told = (message: string, declined = false): Told => ({ result: "told", message, declined });

const CANCELLED = told("Cancelled.", true);

export const ALREADY_REGISTERED =
  "This device already has a passkey for you. Use it to log in, or add one on another device.";

/** What a person is told when the page had no focus to ask for a passkey from: press `button` again. Not a decline. */
const notFocused = (button: string) => told(`The page was not ready for a passkey. Press ${button} again.`);

/**
 * What a person is told when an action did not go ahead: declined (a sheet
 * dismissed, a step-up declined, or no passkey to use), already registered on
 * this device, or refused. Every flow ends a non-`ok` outcome here.
 */
function notDone(outcome: Cancelled | AlreadyRegistered | Refused, refused: string, cancelled = "Cancelled."): Told {
  if (outcome.result === "already-registered") return told(ALREADY_REGISTERED, true);
  return outcome.result === "cancelled" ? told(cancelled, true) : told(refused);
}

/** A form the codes pane shows the codes in: the UR, the secret's BIP39 words, or the UR body in Bytewords. All name the same code. */
export type CodeForm = "code" | "bip39" | "bytewords";

/** A fresh set of recovery codes as the codes pane shows them: each code in each form, a header, and the text to keep in each form. */
export interface CodesView {
  forms: Record<CodeForm, string[]>;
  header: string[];
  text: Record<CodeForm, string>;
}

/** The signed-in record's settings. */
export interface Settings {
  me: Me;
  credentials: PasskeyListing[];
  sessions: SessionListing[];
}

/** A member an operator looked up: the name looked up and what the server answered. */
export type FoundMember = MemberView & { memberName: string };

const refusedNote = (refused: Refused) => ({ result: "noted", note: `Refused (${refused.response.status}).` }) as const;

/** What an operator lookup or action shows: the member and a note, a note alone, or a message. */
export type OperatorOutcome =
  { result: "member"; member: FoundMember; note: string } | { result: "noted"; note: string } | Told;

/**
 * The page's one autofill request: `start` aborts any earlier one and gives the
 * signal a new one runs under, and `waiting` tells its `onWaiting` once the
 * browser holds it; `stop` aborts it.
 */
export class AutofillRequests {
  private current = new AbortController();
  private onWaiting = () => {};

  start(onWaiting = () => {}): AbortSignal {
    this.current.abort();
    this.current = new AbortController();
    this.onWaiting = onWaiting;
    return this.current.signal;
  }

  waiting() {
    this.onWaiting();
  }

  stop() {
    this.current.abort();
  }
}

export class Flows {
  readonly client: DemoClient;
  /** The site recovery codes are for: the demo's RP ID, its host name. */
  readonly site: string;
  readonly autofillRequests: AutofillRequests;
  /**
   * Whether a Continue on this page has used no passkey. An immediate request
   * sees only the passkeys the browser itself holds, so after one finds none,
   * Continue asks through the browser's sheet, which also offers a password
   * manager, a phone and a security key.
   */
  private continueUsedNone = false;

  constructor(client: DemoClient, site: string, autofillRequests = new AutofillRequests()) {
    this.client = client;
    this.site = site;
    this.autofillRequests = autofillRequests;
  }

  /** Who is signed in, or null. */
  me(): Promise<Me | null> {
    return this.client.me();
  }

  // --- signing in -----------------------------------------------------------

  /**
   * Log in with a passkey found on this device, or after a Continue that used
   * none, with one picked from the browser's sheet. `no-passkey` covers both no
   * passkey here and a dismissed picker, which browsers do not tell apart.
   */
  async continueWithPasskey(): Promise<LoggedIn> {
    const outcome = loggedIn(await this.client.login(this.continueUsedNone ? "use" : "find"));
    if (outcome.result === "no-passkey") this.continueUsedNone = true;
    return outcome;
  }

  /**
   * Whether to offer passkeys in the member-name field's autofill: only where
   * the browser can, and Continue cannot find a passkey without a sheet.
   */
  async offersAutofill(): Promise<boolean> {
    return !(await canFindWithoutSheet()) && (await canAutofillPasskey());
  }

  /**
   * Log in with a passkey the person picks from the member-name field's
   * autofill. `no-passkey` also when the request was stopped, by `stopAutofill`
   * or by any other passkey request on the page, and when the login options
   * were refused: the person asked for nothing, so there is nothing to tell.
   * `onWaiting` runs once the browser holds the request.
   */
  async autofill(onWaiting?: () => void): Promise<LoggedIn> {
    const prepared = await this.client.loginRequest({ autofill: this.autofillRequests.start(onWaiting) });
    if (prepared.result !== "prepared") return { result: "no-passkey" };
    return loggedIn(await this.client.send(prepared));
  }

  stopAutofill() {
    this.autofillRequests.stop();
  }

  /** Whether a member name is free to register; null when the check was refused, which says nothing either way. */
  memberNameAvailable(name: string): Promise<boolean | null> {
    return this.client.memberNameAvailable(name);
  }

  async register(memberName: string): Promise<({ result: "registered" } & IssuedCodes) | Told> {
    const registered = await this.client.register(memberName);
    if (registered.result === "name-unavailable") return told(`The member name ${memberName} is not available.`);
    if (registered.result === "not-focused") return notFocused("Register with a passkey");
    if (registered.result !== "ok") return notDone(registered, "Registration was refused.", "Registration cancelled.");
    return { ...registered, result: "registered" };
  }

  /** Recover with a recovery code; `codesLeft` is how many unused codes the record has after this one. */
  async recover(memberName: string, code: string): Promise<{ result: "recovered"; codesLeft: number } | Told> {
    const recovered = await this.client.recover(memberName, code);
    if (recovered.result === "not-focused") return notFocused("Recover with a new passkey");
    if (recovered.result !== "ok") return notDone(recovered, "Recovery was refused.", "Recovery cancelled.");
    return { result: "recovered", codesLeft: recovered.codesLeft };
  }

  /** Bind a new passkey with a rebind link's fragment. */
  async rebind(link: string): Promise<{ result: "rebound" } | Told> {
    const rebound = await this.client.rebind(link);
    if (rebound.result === "invalid-link") return told("This link is not valid.");
    if (rebound.result === "not-focused") return notFocused("Create a passkey");
    if (rebound.result !== "ok")
      return notDone(rebound, "This link was refused. It may have been used or have expired.");
    return { result: "rebound" };
  }

  // --- settings -------------------------------------------------------------

  /** The settings of `me`, the signed-in record. */
  async settings(me: Me): Promise<Settings> {
    const [credentials, sessions] = await Promise.all([this.client.credentials(), this.client.sessions()]);
    return { me, credentials, sessions };
  }

  /** Add a passkey, with a hint for where the browser should offer to save it. */
  async addPasskey(hint?: PublicKeyCredentialHint): Promise<Told> {
    const enrolled = await this.client.enrol(hint);
    // What leaves the page without focus here is the step-up's sheet, just closed.
    if (enrolled.result === "not-focused") return told("Step-up done. Press the Add a passkey button again.");
    if (enrolled.result !== "ok") return notDone(enrolled, "Adding the passkey was refused.");
    return told(`Added passkey ${enrolled.label}.`);
  }

  async revoke(label: string): Promise<Told> {
    const revoked = await this.client.revoke(label);
    if (revoked.result === "only-passkey") return told("You cannot revoke your only passkey. Add another first.");
    if (revoked.result !== "ok") return notDone(revoked, "Could not revoke that passkey.");
    const { passkeyName, provider } = revoked;
    // Where the password manager takes the signal it drops the passkey; the message covers those that do not,
    // and does not wait on it.
    void signalRevokedPasskey(revoked);
    const holder = provider === SECURITY_KEY ? "your security key" : (provider ?? "your password manager");
    return told(`Revoked ${label}. Delete '${passkeyName}' from ${holder} too; it no longer logs in.`);
  }

  /** Replace the record's recovery codes with a fresh set. */
  async rotateCodes(): Promise<({ result: "rotated" } & IssuedCodes) | Told> {
    const rotated = await this.client.rotateRecoveryCodes();
    if (rotated.result !== "ok") return notDone(rotated, "Could not replace your recovery codes.");
    return { ...rotated, result: "rotated" };
  }

  logout(): Promise<void> {
    return this.client.logout();
  }

  logoutEverywhere(): Promise<void> {
    return this.client.logoutEverywhere();
  }

  async logoutElsewhere(): Promise<Told> {
    const done = await this.client.logoutElsewhere();
    if (done.result !== "ok") return notDone(done, "Could not log out everywhere else.");
    return told("Logged out everywhere else.");
  }

  // --- operator -------------------------------------------------------------

  async lookUpMember(memberName: string): Promise<OperatorOutcome> {
    const member = await this.client.lookUpMember(memberName);
    if (member.result === "cancelled") return CANCELLED;
    if (member.result === "no-such-member") return { result: "noted", note: "No such member" };
    if (member.result !== "ok") return refusedNote(member);
    const { result: _, ...view } = member;
    return { result: "member", member: { ...view, memberName }, note: view.retired ? "Retired name" : "" };
  }

  /** Act on a member a lookup found. */
  async operatorAction(
    action: OperatorAction,
    member: { memberName: string; recordId: string },
  ): Promise<OperatorOutcome> {
    const { memberName } = member;
    const acted = await this.client.operatorAction(action, member);
    if (acted.result === "cancelled") return CANCELLED;
    if (acted.result === "operator-record") {
      return { result: "noted", note: "Operators can't be removed. Take them off OPERATOR_RECORD_IDS first." };
    }
    if (acted.result !== "ok") return refusedNote(acted);
    const note = acted.link
      ? `Send this link to ${memberName}: ${acted.link}`
      : action === "remove"
        ? "Removed. Their name is retired."
        : action === "allow-name"
          ? `Anyone can now register ${memberName}.`
          : "Done.";
    return { result: "member", member: { ...acted.member, memberName }, note };
  }

  // --- codes ----------------------------------------------------------------

  /** A fresh set, as the server returns it with when it was issued, as the codes pane shows it to the signed-in member. */
  async codes({ recoveryCodes, recoveryCodeBip39, recoveryCodeWords, issuedAt }: IssuedCodes): Promise<CodesView> {
    const memberName = (await this.client.me())?.memberName ?? "";
    const about = { site: this.site, memberName, issuedAt };
    const forms = { code: recoveryCodes, bip39: recoveryCodeBip39, bytewords: recoveryCodeWords };
    const text = (codes: string[]) => formatRecoveryCodes({ ...about, codes });
    return {
      forms,
      header: recoveryCodesHeader(about),
      text: { code: text(forms.code), bip39: text(forms.bip39), bytewords: text(forms.bytewords) },
    };
  }
}

/** How a login ended: `no-passkey` covers both no passkey used and a dismissed picker. */
type LoggedIn = { result: "signed-in" | "no-passkey" | "not-accepted" };

function loggedIn(outcome: { result: "ok" | "cancelled" | "refused" }): LoggedIn {
  if (outcome.result === "ok") return { result: "signed-in" };
  return { result: outcome.result === "cancelled" ? "no-passkey" : "not-accepted" };
}

/** Runs a passkey request the person answers, with the page ready for that; see `lendPage` in dom.ts. */
export type RunPasskeyRequest = <T>(request: () => Promise<T>) => Promise<T>;

/**
 * The browser's passkeys, for the page. Browsers allow one WebAuthn request at
 * a time, so every other request first aborts the autofill one. Each request
 * but autofill goes through `run`.
 */
class PagePasskeys implements Authenticator {
  readonly autofillRequests = new AutofillRequests();
  private readonly run: RunPasskeyRequest;

  constructor(run: RunPasskeyRequest) {
    this.run = run;
  }

  create(options: PublicKeyCredentialCreationOptionsJSON) {
    this.autofillRequests.stop();
    return this.run(() => createPasskey(options));
  }

  get(options: PublicKeyCredentialRequestOptionsJSON, mode: GetMode) {
    if (typeof mode === "object") {
      // A signal stopped while the options were on their way rejects at once.
      const found = autofillPasskey(options, mode.autofill);
      this.autofillRequests.waiting();
      return found;
    }
    this.autofillRequests.stop();
    return this.run(() => (mode === "find" ? findPasskey(options) : usePasskey(options)));
  }
}

/**
 * The flows of the page at `page` (its `location`): requests to its own
 * origin, passkeys from the browser, each request run by `run`.
 */
export function pageFlows(page: { origin: string; hostname: string }, run: RunPasskeyRequest): Flows {
  const passkeys = new PagePasskeys(run);
  return new Flows(
    new DemoClient({ origin: page.origin, fetch: (request) => fetch(request) }, passkeys),
    // The demo's RP ID is its host name.
    page.hostname,
    passkeys.autofillRequests,
  );
}
