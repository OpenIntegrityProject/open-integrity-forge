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

export function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(value), { ...init, headers });
}

export function error(status: number, message: string): Response {
  return json({ error: message }, { status });
}
