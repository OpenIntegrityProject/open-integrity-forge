import {
  clearedSessionCookie,
  createPasskeys,
  PasskeyError,
  sessionCookie,
  sessionValueFrom,
  type CeremonyOutcome,
  type PasskeyErrorCode,
  type Passkeys,
  type Principal,
  type RateLimits,
  type RequestContext,
  type RevocationEvent,
} from "passkey-cloudflare";
import { seedWords } from "passkey-cloudflare/gordian";
import { error, json, type Call, type Handler } from "./http.ts";
import { operatorLog } from "./operator-log.ts";
import type { IssuedCodes, Me, PasskeyListing, Recovered, Registered, Revoked, SessionListing } from "./responses.ts";
import { operatorLogRoute, operatorRolesFromSecret, operatorRoutes, type OperatorRolesFor } from "./operator.ts";

export interface AppOptions {
  /** Source of the current time, for tests. Defaults to `Date.now`. */
  clock?: () => number;
  /** Overrides for the library's rate limits. */
  rateLimits?: Partial<RateLimits>;
  /** Called when sessions end. The demo has no live connections yet, so by default it does nothing. */
  onRevoke?: (event: RevocationEvent) => void | Promise<void>;
  /**
   * The storage prefix the app and the library address their Durable Objects
   * under, for tests. Absent in production; never read from a var or secret.
   */
  storagePrefix?: string;
  /**
   * Who holds the operator role. Defaults to the `OPERATOR_RECORD_IDS` secret,
   * the only source the production entry uses.
   */
  operatorRoles?: OperatorRolesFor;
}

type AuthedHandler = (call: Call, principal: Principal) => Promise<Response>;

/** Fresh recovery codes, when they were issued, and each one's word form, which the page offers for reading aloud. */
function withWords({ recoveryCodes, issuedAt }: { recoveryCodes: string[]; issuedAt: number }): IssuedCodes {
  return { recoveryCodes, recoveryCodeWords: recoveryCodes.map(seedWords), issuedAt };
}

const STATUS: Record<PasskeyErrorCode, number> = {
  "not-logged-in": 401,
  "step-up-required": 403,
  "not-found": 404,
  "last-credential": 409,
  "member-name-unavailable": 409,
};

function optionsResponse(outcome: CeremonyOutcome<unknown>): Response {
  return outcome.ok ? json(outcome.value) : outcome.response;
}

function authed(handler: AuthedHandler): Handler {
  return async (call) => {
    const principal = await call.passkeys.authenticate(sessionValueFrom(call.request));
    if (!principal) return error(401, "not logged in");
    return handler(call, principal);
  };
}

interface Routes {
  POST: Record<string, Handler>;
  GET: Record<string, Handler>;
}

/** Every route the app answers, given who holds the operator role. */
function routes(roles: OperatorRolesFor): Routes {
  const POST: Record<string, Handler> = {
    "/auth/register/options": async ({ passkeys, ctx, body }) =>
      optionsResponse(await passkeys.registrationOptions(ctx, body.memberName)),

    "/auth/register/verify": async ({ passkeys, ctx, body }) => {
      const outcome = await passkeys.register(ctx, body.response);
      if (!outcome.ok) return outcome.response;
      const { recordId, session, ...codes } = outcome.value;
      return json({ recordId, ...withWords(codes) } satisfies Registered, {
        headers: { "Set-Cookie": sessionCookie(session) },
      });
    },

    "/auth/login/options": async ({ passkeys, ctx }) => optionsResponse(await passkeys.loginOptions(ctx)),

    "/auth/login/verify": async ({ passkeys, ctx, body }) => {
      const outcome = await passkeys.login(ctx, body.response);
      if (!outcome.ok) return outcome.response;
      const { recordId, session } = outcome.value;
      return json({ recordId }, { headers: { "Set-Cookie": sessionCookie(session) } });
    },

    "/auth/logout": async ({ passkeys, request }) => {
      await passkeys.logout(sessionValueFrom(request));
      return json({ ok: true }, { headers: { "Set-Cookie": clearedSessionCookie() } });
    },

    "/auth/logout-everywhere": async ({ passkeys, request }) => {
      await passkeys.logoutEverywhere(sessionValueFrom(request));
      return json({ ok: true }, { headers: { "Set-Cookie": clearedSessionCookie() } });
    },

    "/auth/logout-elsewhere": async ({ passkeys, request }) => {
      await passkeys.logoutElsewhere(sessionValueFrom(request));
      return json({ ok: true });
    },

    "/auth/recover/options": async ({ passkeys, ctx, body }) =>
      optionsResponse(await passkeys.recoverOptions(ctx, body.memberName)),

    "/auth/recover": async ({ passkeys, ctx, body }) => {
      const outcome = await passkeys.recover(ctx, body.memberName, body.code, body.response);
      if (!outcome.ok) return outcome.response;
      const { recordId, session, codesLeft } = outcome.value;
      return json({ recordId, codesLeft } satisfies Recovered, { headers: { "Set-Cookie": sessionCookie(session) } });
    },

    "/auth/rebind/options": async ({ passkeys, ctx, body }) =>
      optionsResponse(await passkeys.rebindOptions(ctx, body.link)),

    "/auth/rebind/verify": async ({ passkeys, ctx, body }) => {
      const outcome = await passkeys.rebind(ctx, body.link, body.response);
      if (!outcome.ok) return outcome.response;
      const { recordId, session } = outcome.value;
      return json({ recordId }, { headers: { "Set-Cookie": sessionCookie(session) } });
    },

    ...operatorRoutes(roles),

    "/auth/step-up/options": async ({ passkeys, ctx, request }) =>
      json(await passkeys.stepUpOptions(ctx, sessionValueFrom(request))),

    "/auth/step-up/verify": async ({ passkeys, ctx, request, body }) => {
      const outcome = await passkeys.stepUp(ctx, sessionValueFrom(request), body.response);
      return outcome.ok ? json({ ok: true }) : outcome.response;
    },

    "/me/credentials/enrol/options": async ({ passkeys, ctx, request, body }) =>
      json(await passkeys.enrolOptions(ctx, sessionValueFrom(request), body.hint)),

    "/me/credentials/enrol/verify": async ({ passkeys, ctx, request, body }) => {
      const outcome = await passkeys.enrol(ctx, sessionValueFrom(request), body.response);
      return outcome.ok ? json(outcome.value) : outcome.response;
    },

    "/me/credentials/revoke": async ({ passkeys, ctx, request, body }) => {
      const revoked = await passkeys.revokeCredential(ctx, sessionValueFrom(request), body.label);
      return json({ ok: true, ...revoked } satisfies Revoked & { ok: true });
    },

    "/me/recovery-codes/rotate": async ({ passkeys, ctx, request }) =>
      json(withWords(await passkeys.rotateRecoveryCodes(ctx, sessionValueFrom(request)))),
  };

  const GET: Record<string, Handler> = {
    "/auth/member-name": async ({ passkeys, ctx, request }) => {
      const name = new URL(request.url).searchParams.get("name") ?? "";
      const outcome = await passkeys.checkMemberName(ctx, name);
      return outcome.ok ? json({ available: outcome.value }) : outcome.response;
    },

    "/me": authed(async (call, principal) =>
      json({
        recordId: principal.recordId,
        memberName: await call.passkeys.memberName(principal.recordId),
        operator: await roles(call).isOperator(principal.recordId),
      } satisfies Me),
    ),

    "/me/credentials": async ({ passkeys, ctx, request }) =>
      json({ credentials: (await passkeys.credentials(ctx, sessionValueFrom(request))) satisfies PasskeyListing[] }),

    "/operator/log": operatorLogRoute(roles),

    "/me/sessions": async ({ passkeys, request }) =>
      json({ sessions: (await passkeys.sessions(sessionValueFrom(request))) satisfies SessionListing[] }),
  };

  return { POST, GET };
}

/** The route table, built only for its paths, which are the same whoever holds the operator role. */
const ROUTE_TABLE = routes(operatorRolesFromSecret);

/** The paths the app answers a POST on, each a state-changing route. */
export const POST_ROUTES: readonly string[] = Object.keys(ROUTE_TABLE.POST);

/** The paths the app answers a GET or HEAD on, each a read route. */
export const GET_ROUTES: readonly string[] = Object.keys(ROUTE_TABLE.GET);

export function createApp(options: AppOptions = {}) {
  const table = routes(options.operatorRoles ?? operatorRolesFromSecret);
  return {
    async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
      const passkeys = createPasskeys(env, {
        rp: { id: env.RP_ID, name: env.RP_NAME, origin: env.ORIGIN },
        refusalFloorMs: Number(env.REFUSAL_FLOOR_MS),
        clock: options.clock,
        onRevoke: options.onRevoke,
        rateLimits: options.rateLimits,
        storagePrefix: options.storagePrefix,
      });
      const ctx = passkeys.context(request);
      try {
        return await route(table, request, env, passkeys, ctx, operatorLog(env.OPERATOR_LOG, options.storagePrefix));
      } catch (e) {
        if (e instanceof PasskeyError) return error(STATUS[e.code], e.code);
        throw e;
      }
    },
  };
}

async function route(
  { POST, GET }: Routes,
  request: Request,
  env: Env,
  passkeys: Passkeys,
  ctx: RequestContext,
  log: Call["log"],
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "POST") {
    const handler = POST[url.pathname];
    if (!handler) return error(404, "not found");
    if (request.headers.get("Origin") !== env.ORIGIN) return error(403, "origin not allowed");
    let body: any;
    try {
      const text = await request.text();
      body = text ? JSON.parse(text) : {};
    } catch {
      return error(400, "malformed JSON");
    }
    if (typeof body !== "object" || body === null) return error(400, "malformed JSON");
    return handler({ request, env, passkeys, ctx, body, log });
  }
  if (request.method === "GET" || request.method === "HEAD") {
    const handler = GET[url.pathname];
    if (!handler) return error(404, "not found");
    return handler({ request, env, passkeys, ctx, body: {}, log });
  }
  return error(405, "method not allowed");
}
