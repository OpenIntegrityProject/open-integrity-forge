// The demo's client for its own routes: each ceremony's options -> passkey ->
// verify sequence, the reads and calls on the signed-in record and the
// operator's, the step-up a session-gated request may need, and the answers
// the app tells apart, returned as outcomes. The demo's browser code and its
// tests both use it. It belongs to the demo, not the library, whose browser
// module makes no requests (ADR 0006).
//
// The browser bundles it, the Workers tests import it and Node loads it
// through scripts/measure-refusals.ts, so it imports only types and declares
// its fields explicitly.

import type {
  CreateResult,
  FindResult,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialHint,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "passkey-cloudflare/browser";
import type {
  IssuedCodes,
  Me,
  MemberView,
  OperatorActed,
  PasskeyListing,
  Recovered,
  Registered,
  Revoked,
  SessionListing,
} from "../src/responses.ts";

/** Where the client sends its requests. */
export interface Target {
  /** The origin the app is loaded from; also the base of every request URL. */
  origin: string;
  fetch(request: Request): Promise<Response>;
}

/**
 * How a get asks for a passkey: `find` to log in, which may end without a
 * sheet where the browser can; `use` for a step-up, through the browser's
 * ordinary sheet; `autofill` to log in with a passkey the person picks from a
 * field's autofill, until its signal aborts the request.
 */
export type GetMode = "find" | "use" | { autofill: AbortSignal };

/** How the client asks for a passkey, in the library's browser results. */
export interface Authenticator {
  create(options: PublicKeyCredentialCreationOptionsJSON): Promise<CreateResult>;
  get(options: PublicKeyCredentialRequestOptionsJSON, mode: GetMode): Promise<FindResult>;
}

/** The person declined the passkey: dismissed the sheet, or had none to use. A declined step-up ends here too. */
export type Cancelled = { result: "cancelled" };
/** The authenticator already holds a passkey for this record. */
export type AlreadyRegistered = { result: "already-registered" };
/** Refused for a reason no caller tells apart; `response` is the server's answer, unread. */
export type Refused = { result: "refused"; response: Response };
/** A rebind link the server will not start a ceremony from; `response` is its answer. */
export type InvalidLink = { result: "invalid-link"; response: Response };
/** A ceremony's final request, made and ready to send. */
export type Prepared = { result: "prepared"; path: string; body: unknown };

type Ok<T = {}> = { result: "ok" } & T;
type NoPasskey = Cancelled | AlreadyRegistered;

export type OperatorAction = "rebind" | "suspend" | "resume" | "remove" | "allow-name";

const OPERATOR_PATHS: Record<OperatorAction, string> = {
  rebind: "/operator/rebind-links",
  suspend: "/operator/suspend",
  resume: "/operator/resume",
  remove: "/operator/remove",
  "allow-name": "/operator/allow-name",
};

const CANCELLED: Cancelled = { result: "cancelled" };

const refused = (response: Response): Refused => ({ result: "refused", response });

async function read<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** The `error` a refusal names, read from a copy so the response stays unread. */
async function errorOf(response: Response): Promise<unknown> {
  try {
    return (await read<{ error?: unknown }>(response.clone())).error;
  } catch {
    return undefined;
  }
}

export class DemoClient {
  readonly target: Target;
  readonly authenticator: Authenticator;

  constructor(target: Target, authenticator: Authenticator) {
    this.target = target;
    this.authenticator = authenticator;
  }

  // --- ceremonies -----------------------------------------------------------

  async register(memberName: string): Promise<Ok<Registered> | { result: "name-unavailable" } | NoPasskey | Refused> {
    const options = await this.post("/auth/register/options", { memberName });
    if (options.status === 409) return { result: "name-unavailable" };
    const prepared = await this.created(options, "/auth/register/verify", (response) => ({ response }));
    return prepared.result === "prepared" ? this.send<Registered>(prepared) : prepared;
  }

  /** The login's verify request, with a passkey found for it, or picked from autofill. */
  async loginRequest(mode: Exclude<GetMode, "use"> = "find"): Promise<Prepared | Cancelled | Refused> {
    const options = await this.post("/auth/login/options");
    if (!options.ok) return refused(options);
    const found = await this.authenticator.get(await read(options), mode);
    if (found.result === "not-found") return CANCELLED;
    return { result: "prepared", path: "/auth/login/verify", body: { response: found.response } };
  }

  async login(): Promise<Ok<{ recordId: string }> | Cancelled | Refused> {
    const prepared = await this.loginRequest();
    return prepared.result === "prepared" ? this.send<{ recordId: string }>(prepared) : prepared;
  }

  async stepUp(): Promise<Ok | Cancelled | Refused> {
    const options = await this.post("/auth/step-up/options");
    if (!options.ok) return refused(options);
    const used = await this.authenticator.get(await read(options), "use");
    if (used.result === "not-found") return CANCELLED;
    const verified = await this.post("/auth/step-up/verify", { response: used.response });
    return verified.ok ? { result: "ok" } : refused(verified);
  }

  /**
   * Add a passkey to the signed-in record. Steps up first if the session needs it.
   * `hint` steers where the browser offers to save it.
   */
  async enrol(hint?: PublicKeyCredentialHint): Promise<Ok<{ label: string }> | NoPasskey | Refused> {
    const options = await this.gated("/me/credentials/enrol/options", hint ? { hint } : {});
    if (!(options instanceof Response)) return options;
    const prepared = await this.created(options, "/me/credentials/enrol/verify", (response) => ({ response }));
    return prepared.result === "prepared" ? this.send<{ label: string }>(prepared) : prepared;
  }

  /** The recovery request, with a passkey made for it. */
  async recoverRequest(memberName: string, code: string): Promise<Prepared | NoPasskey | Refused> {
    const options = await this.post("/auth/recover/options", { memberName });
    return this.created(options, "/auth/recover", (response) => ({ memberName, code, response }));
  }

  async recover(memberName: string, code: string): Promise<Ok<Recovered> | NoPasskey | Refused> {
    const prepared = await this.recoverRequest(memberName, code);
    return prepared.result === "prepared" ? this.send<Recovered>(prepared) : prepared;
  }

  /** The rebind request for a rebind link's fragment, with a passkey made for it. */
  async rebindRequest(link: string): Promise<Prepared | InvalidLink | NoPasskey | Refused> {
    const options = await this.post("/auth/rebind/options", { link });
    if (!options.ok) return { result: "invalid-link", response: options };
    return this.created(options, "/auth/rebind/verify", (response) => ({ link, response }));
  }

  /** Bind a new passkey with a rebind link's fragment. */
  async rebind(link: string): Promise<Ok<{ recordId: string }> | InvalidLink | NoPasskey | Refused> {
    const prepared = await this.rebindRequest(link);
    return prepared.result === "prepared" ? this.send<{ recordId: string }>(prepared) : prepared;
  }

  // --- the signed-in record -------------------------------------------------

  /** Who is signed in, or null when nobody is. */
  async me(): Promise<Me | null> {
    const response = await this.get("/me");
    if (response.status === 401) return null;
    return this.json<Me>(response, "/me");
  }

  async credentials(): Promise<PasskeyListing[]> {
    return (await this.json<{ credentials: PasskeyListing[] }>(await this.get("/me/credentials"), "/me/credentials"))
      .credentials;
  }

  async sessions(): Promise<SessionListing[]> {
    return (await this.json<{ sessions: SessionListing[] }>(await this.get("/me/sessions"), "/me/sessions")).sessions;
  }

  /** Whether a member name is free to register; null when the check was refused, which says nothing either way. */
  async memberNameAvailable(name: string): Promise<boolean | null> {
    const response = await this.get(`/auth/member-name?name=${encodeURIComponent(name)}`);
    return response.ok ? (await read<{ available: boolean }>(response)).available : null;
  }

  async revoke(label: string): Promise<Ok<Revoked> | { result: "only-passkey" } | Cancelled | Refused> {
    const response = await this.gated("/me/credentials/revoke", { label });
    if (!(response instanceof Response)) return response;
    if (response.status === 409) return { result: "only-passkey" };
    return this.answer<Revoked>(response);
  }

  async rotateRecoveryCodes(): Promise<Ok<IssuedCodes> | Cancelled | Refused> {
    const response = await this.gated("/me/recovery-codes/rotate");
    return response instanceof Response ? this.answer<IssuedCodes>(response) : response;
  }

  async logout(): Promise<void> {
    await this.post("/auth/logout");
  }

  async logoutEverywhere(): Promise<void> {
    await this.post("/auth/logout-everywhere");
  }

  /** End every session but this one. */
  async logoutElsewhere(): Promise<Ok | Cancelled | Refused> {
    const response = await this.gated("/auth/logout-elsewhere");
    if (!(response instanceof Response)) return response;
    return response.ok ? { result: "ok" } : refused(response);
  }

  // --- operator -------------------------------------------------------------

  async lookUpMember(memberName: string): Promise<Ok<MemberView> | { result: "no-such-member" } | Cancelled | Refused> {
    const response = await this.gated("/operator/lookup", { memberName });
    if (!(response instanceof Response)) return response;
    if (response.status === 404) return { result: "no-such-member" };
    return this.answer<MemberView>(response);
  }

  /** Act on a member a lookup found. An operator's own record cannot be removed: `operator-record`. */
  async operatorAction(
    action: OperatorAction,
    member: { memberName: string; recordId: string },
  ): Promise<Ok<OperatorActed> | { result: "operator-record" } | Cancelled | Refused> {
    // Allowing acts on the name, which no longer resolves to the removed record afterwards.
    const body = action === "allow-name" ? { memberName: member.memberName } : { recordId: member.recordId };
    const response = await this.gated(OPERATOR_PATHS[action], body);
    if (!(response instanceof Response)) return response;
    if (!response.ok && (await errorOf(response)) === "operator record") return { result: "operator-record" };
    return this.answer<OperatorActed>(response);
  }

  // --- requests -------------------------------------------------------------

  private post(path: string, body: unknown = {}): Promise<Response> {
    return this.target.fetch(
      new Request(this.target.origin + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  private get(path: string): Promise<Response> {
    return this.target.fetch(new Request(this.target.origin + path));
  }

  /** A read the app answers for anyone it serves; any refusal is a bug, thrown. */
  private async json<T>(response: Response, path: string): Promise<T> {
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return read<T>(response);
  }

  /** The server's answer as an outcome: its JSON when it accepted, else refused. */
  private async answer<T>(response: Response): Promise<Ok<T> | Refused> {
    return response.ok ? { result: "ok", ...(await read<T>(response)) } : refused(response);
  }

  /** Send a ceremony's final request, made by one of the `...Request` calls. */
  async send<T>(prepared: Prepared): Promise<Ok<T> | Refused> {
    return this.answer<T>(await this.post(prepared.path, prepared.body));
  }

  /** Make a passkey from creation options the server answered, and the request that verifies it. */
  private async created(
    options: Response,
    path: string,
    body: (response: RegistrationResponseJSON) => unknown,
  ): Promise<Prepared | NoPasskey | Refused> {
    if (!options.ok) return refused(options);
    const created = await this.authenticator.create(await read(options));
    if (created.result === "not-created") return CANCELLED;
    if (created.result === "already-registered") return { result: "already-registered" };
    return { result: "prepared", path, body: body(created.response) };
  }

  /**
   * POST a session-gated request. Refused for want of a fresh step-up, it
   * steps up once and sends the request again; a step-up declined or refused
   * ends the action there, undone.
   */
  private async gated(path: string, body: unknown = {}): Promise<Response | Cancelled | Refused> {
    const response = await this.post(path, body);
    if (response.status !== 403 || (await errorOf(response)) !== "step-up-required") return response;
    const steppedUp = await this.stepUp();
    return steppedUp.result === "ok" ? this.post(path, body) : steppedUp;
  }
}
