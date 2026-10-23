import {
  clearedSessionCookie,
  createPasskeys,
  PasskeyError,
  SESSION_COOKIE,
  sessionValueFrom,
  type CeremonyOutcome,
  type PasskeyErrorCode,
  type Passkeys,
  type Principal,
  type RateLimits,
  type RequestContext,
  type RevocationEvent,
} from "passkey-cloudflare";
import { seedBip39, seedWords } from "passkey-cloudflare/gordian";
import { error, json, originChecked, ownSession, type Call, type Handler, type PostRoute } from "./http.ts";
import { operatorLog } from "./operator-log.ts";
import type { IssuedCodes, Me, PasskeyListing, Recovered, Registered, Revoked, SessionListing } from "./responses.ts";
import { operatorLogRoute, operatorRolesFromSecret, operatorRoutes, type OperatorRolesFor } from "./operator.ts";

export interface AppOptions {
  /** Source of the current time, for tests. Defaults to `Date.now`. */
  clock?: () => number;
  /** How long sessions last, for tests. Defaults to the library's default lifetime. */
  sessionLifetimeMs?: number;
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
   * Where a request's source address comes from, for tests. Absent in
   * production, where the library reads CF-Connecting-IP.
   */
  sourceOf?: (request: Request) => string | null;
  /**
   * Who holds the operator role. Defaults to the `OPERATOR_RECORD_IDS` secret,
   * the only source the production entry uses.
   */
  operatorRoles?: OperatorRolesFor;
}

type AuthedHandler = (call: Call, principal: Principal) => Promise<Response>;

/** Fresh recovery codes, when they were issued, and each one's word forms, which the page offers for reading aloud or writing down. */
async function withWords({ recoveryCodes, issuedAt }: { recoveryCodes: string[]; issuedAt: number }): Promise<IssuedCodes> {
  const recoveryCodeBip39 = await Promise.all(recoveryCodes.map(seedBip39));
  return { recoveryCodes, recoveryCodeBip39, recoveryCodeWords: recoveryCodes.map(seedWords), issuedAt };
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
  POST: Record<string, PostRoute>;
  GET: Record<string, Handler>;
}

/** Every route the app answers, given who holds the operator role. */
function routes(roles: OperatorRolesFor): Routes {
  const POST: Record<string, PostRoute> = {
    "/auth/register/options": originChecked(async ({ passkeys, ctx, body }) =>
      optionsResponse(await passkeys.registrationOptions(ctx, body.memberName)),
    ),

    "/auth/register/verify": originChecked(async ({ passkeys, ctx, body }) => {
      const outcome = await passkeys.register(ctx, body.response);
      if (!outcome.ok) return outcome.response;
      const { recordId, session, ...codes } = outcome.value;
      return json({ recordId, ...(await withWords(codes)) } satisfies Registered, {
        headers: { "Set-Cookie": passkeys.sessionCookie(session) },
      });
    }),

    "/auth/login/options": originChecked(async ({ passkeys, ctx }) =>
      optionsResponse(await passkeys.loginOptions(ctx)),
    ),

    "/auth/login/verify": originChecked(async ({ passkeys, ctx, body }) => {
      const outcome = await passkeys.login(ctx, body.response);
      if (!outcome.ok) return outcome.response;
      const { recordId, session } = outcome.value;
      return json({ recordId }, { headers: { "Set-Cookie": passkeys.sessionCookie(session) } });
    }),

    "/auth/logout": ownSession(async ({ passkeys, request }) => {
      await passkeys.logout(sessionValueFrom(request));
      return json({ ok: true }, { headers: { "Set-Cookie": clearedSessionCookie() } });
    }),

    "/auth/logout-everywhere": ownSession(async ({ passkeys, request }) => {
      await passkeys.logoutEverywhere(sessionValueFrom(request));
      return json({ ok: true }, { headers: { "Set-Cookie": clearedSessionCookie() } });
    }),

    "/auth/logout-elsewhere": ownSession(async ({ passkeys, request }) => {
      await passkeys.logoutElsewhere(sessionValueFrom(request));
      return json({ ok: true });
    }),

    "/auth/recover/options": originChecked(async ({ passkeys, ctx, body }) =>
      optionsResponse(await passkeys.recoverOptions(ctx, body.memberName)),
    ),

    "/auth/recover": originChecked(async ({ passkeys, ctx, body }) => {
      const outcome = await passkeys.recover(ctx, body.memberName, body.code, body.response);
      if (!outcome.ok) return outcome.response;
      const { recordId, session, codesLeft } = outcome.value;
      return json({ recordId, codesLeft } satisfies Recovered, {
        headers: { "Set-Cookie": passkeys.sessionCookie(session) },
      });
    }),

    "/auth/rebind/options": originChecked(async ({ passkeys, ctx, body }) =>
      optionsResponse(await passkeys.rebindOptions(ctx, body.link)),
    ),

    "/auth/rebind/verify": originChecked(async ({ passkeys, ctx, body }) => {
      const outcome = await passkeys.rebind(ctx, body.link, body.response);
      if (!outcome.ok) return outcome.response;
      const { recordId, session } = outcome.value;
      return json({ recordId }, { headers: { "Set-Cookie": passkeys.sessionCookie(session) } });
    }),

    ...operatorRoutes(roles),

    "/auth/step-up/options": ownSession(async ({ passkeys, ctx, request }) =>
      optionsResponse(await passkeys.stepUpOptions(ctx, sessionValueFrom(request))),
    ),

    "/auth/step-up/verify": ownSession(async ({ passkeys, ctx, request, body }) => {
      const outcome = await passkeys.stepUp(ctx, sessionValueFrom(request), body.response);
      return outcome.ok ? json({ ok: true }) : outcome.response;
    }),

    "/me/credentials/enrol/options": ownSession(async ({ passkeys, ctx, request, body }) =>
      optionsResponse(await passkeys.enrolOptions(ctx, sessionValueFrom(request), body.hint)),
    ),

    "/me/credentials/enrol/verify": ownSession(async ({ passkeys, ctx, request, body }) => {
      const outcome = await passkeys.enrol(ctx, sessionValueFrom(request), body.response);
      return outcome.ok ? json(outcome.value) : outcome.response;
    }),

    "/me/credentials/revoke": ownSession(async ({ passkeys, ctx, request, body }) => {
      const revoked = await passkeys.revokeCredential(ctx, sessionValueFrom(request), body.label);
      return json({ ok: true, ...revoked } satisfies Revoked & { ok: true });
    }),

    "/me/recovery-codes/rotate": ownSession(async ({ passkeys, ctx, request }) =>
      json(await withWords(await passkeys.rotateRecoveryCodes(ctx, sessionValueFrom(request)))),
    ),
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

/** The POST paths that act on the caller's own session, which a bearer-only request reaches with no Origin. */
export const OWN_SESSION_ROUTES: readonly string[] = POST_ROUTES.filter((path) => ROUTE_TABLE.POST[path]!.ownSession);

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
        sessionLifetimeMs: options.sessionLifetimeMs,
        onRevoke: options.onRevoke,
        rateLimits: options.rateLimits,
        storagePrefix: options.storagePrefix,
        sourceOf: options.sourceOf,
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
    const entry = POST[url.pathname];
    if (!entry) return error(404, "not found");
    const bearer = request.headers.get("Authorization")?.startsWith("Bearer ") ?? false;
    // The library takes the bearer header over the cookie, so which session the caller meant is unclear.
    if (bearer && hasSessionCookie(request)) return error(400, "bearer header and session cookie both sent");
    if (!(bearer && entry.ownSession) && request.headers.get("Origin") !== env.ORIGIN) {
      return error(403, "origin not allowed");
    }
    let body: any;
    try {
      const text = await request.text();
      body = text ? JSON.parse(text) : {};
    } catch {
      return error(400, "malformed JSON");
    }
    if (typeof body !== "object" || body === null) return error(400, "malformed JSON");
    return entry.handler({ request, env, passkeys, ctx, body, log });
  }
  if (request.method === "GET" || request.method === "HEAD") {
    const handler = GET[url.pathname];
    if (!handler) return error(404, "not found");
    return handler({ request, env, passkeys, ctx, body: {}, log });
  }
  return error(405, "method not allowed");
}

function hasSessionCookie(request: Request): boolean {
  const cookie = request.headers.get("Cookie") ?? "";
  return cookie.split(";").some((part) => part.trim().split("=")[0] === SESSION_COOKIE);
}
