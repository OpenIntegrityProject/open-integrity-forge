import type { Passkeys, RequestContext } from "passkey-cloudflare";
import type { OperatorLog } from "./operator-log.ts";

/** One request, as a route handler sees it. */
export interface Call {
  request: Request;
  env: Env;
  passkeys: Passkeys;
  ctx: RequestContext;
  body: any;
  /** The operator log, under the app's storage prefix. */
  log: () => DurableObjectStub<OperatorLog>;
}

export type Handler = (call: Call) => Promise<Response>;

/**
 * A POST route, and whether it acts only on the caller's own session. The
 * Origin check guards against cross-site request forgery, which rides on the
 * cookie a browser attaches by itself. A browser never attaches a bearer header
 * on its own, so a bearer-only request to an own-session route skips the check;
 * on every other route it is checked like a cookie request.
 */
export interface PostRoute {
  handler: Handler;
  ownSession: boolean;
}

/** A route every POST reaches only from the site's origin, bearer-only or not. */
export function originChecked(handler: Handler): PostRoute {
  return { handler, ownSession: false };
}

/** A route that acts on the caller's own session, which a bearer-only request reaches without an Origin. */
export function ownSession(handler: Handler): PostRoute {
  return { handler, ownSession: true };
}

export function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(value), { ...init, headers });
}

export function error(status: number, message: string): Response {
  return json({ error: message }, { status });
}
