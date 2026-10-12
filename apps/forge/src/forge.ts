import {
  createPasskeys,
  credentialIndex,
  credentialLabels,
  PasskeyError,
  sessionValueFrom,
  type Passkeys,
  type Principal,
  type RecordId,
} from "passkey-cloudflare";
import { createApp, type AppOptions } from "../../demo/src/app.ts";
import { error, json } from "../../demo/src/http.ts";
import { localGitHttp } from "./local-git-http.ts";
import type { Result } from "./project.ts";
import { keyFromRegistration } from "./promoter-key.ts";
import type { PromoterKey, Refusal } from "./state.ts";

// The forge Worker. The demo app answers /auth/*, /me and /operator/*: the
// forge reuses its passkey sign-in as is. The forge answers /forge/*.
//
// Every /forge write needs a live session, and a project answers only its
// owner. A change of main also needs an approval: a fresh, user-verified
// passkey assertion over that exact change. That approval is the proof the
// repository keeps, so these routes need no separate step-up. A new
// promoter key and a reset need one.

export type ForgeOptions = AppOptions;

interface Call {
  request: Request;
  env: Env;
  passkeys: Passkeys;
  principal: Principal;
  body: any;
  params: string[];
  storagePrefix: string | undefined;
}

type Route = { method: "GET" | "POST"; pattern: RegExp; handler: (call: Call) => Promise<Response> };

function refusal(status: number, refused: Refusal): Response {
  return json(refused, { status });
}

function answer<T>(result: Result<T>): Response {
  return result.ok ? json(result.value) : refusal(result.status, { error: result.error, reason: result.reason });
}

const person = (env: Env, recordId: RecordId) => env.PEOPLE.get(env.PEOPLE.idFromName(recordId));
const project = (env: Env, id: string) => env.PROJECTS.get(env.PROJECTS.idFromName(id));

const PROJECT_ID = "([0-9a-f-]{36})";
const STREAM_MS = 60_000;

/** A text/event-stream response that `write` fills until it returns or the client disconnects. */
function stream(write: (send: (chunk: string) => Promise<void>) => Promise<void>): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = (chunk: string) => writer.write(encoder.encode(chunk));
  void (async () => {
    try {
      await send("retry: 1000\n\n");
      await write(send);
    } catch {
      // The client disconnected.
    } finally {
      await writer.close().catch(() => {});
    }
  })();
  return new Response(readable, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}
const NOT_FOUND: Refusal = { error: "no-project", reason: "There is no such project." };

/** The project named in the path, if the caller owns it. */
async function owned(call: Call) {
  const stub = project(call.env, call.params[0]!);
  return (await stub.owner()) === call.principal.recordId ? stub : null;
}

async function allowPrepare(call: Call): Promise<Response | null> {
  return (await person(call.env, call.principal.recordId).allowPrepare(Date.now()))
    ? null
    : refusal(429, { error: "slow-down", reason: "Too many approval requests in the last minute." });
}

const ROUTES: Route[] = [
  {
    method: "GET",
    pattern: /^\/forge\/me$/,
    async handler({ env, principal, passkeys }) {
      const p = person(env, principal.recordId);
      return json({
        recordId: principal.recordId,
        memberName: await passkeys.memberName(principal.recordId),
        promoter: await p.promoter(),
        projects: await p.projects(),
        repoHost: env.REPO_HOST,
      });
    },
  },
  {
    // The browser sends the registration response of a passkey it just made on this site.
    method: "POST",
    pattern: /^\/forge\/me\/promoter-key$/,
    async handler(call) {
      const { env, principal, passkeys, request, body, storagePrefix } = call;
      let captured;
      try {
        captured = await keyFromRegistration(body.response, env.RP_ID);
      } catch (e) {
        return refusal(400, { error: "bad-response", reason: `That is not a new passkey for this site: ${(e as Error).message}.` });
      }
      const holder = await credentialIndex(env.CREDENTIAL_INDEX, storagePrefix)().get(captured.credentialId);
      if (holder !== principal.recordId) {
        return refusal(403, { error: "not-yours", reason: "That passkey does not belong to the signed-in person." });
      }
      const p = person(env, principal.recordId);
      const current = await p.promoter();
      if (current && current.credentialId !== captured.credentialId) {
        await passkeys.requireStepUp(passkeys.context(request), sessionValueFrom(request));
      }
      const now = Date.now();
      const labels = await credentialLabels(env.CREDENTIAL_LABELS, storagePrefix)(principal.recordId).labelEach(
        [captured.credentialId],
        now,
      );
      const key: PromoterKey = {
        id: (await passkeys.memberName(principal.recordId)) ?? principal.recordId,
        ...captured,
        label: labels[captured.credentialId] ?? null,
        capturedAt: now,
      };
      await p.setPromoter(key);
      return json(key);
    },
  },
  {
    method: "GET",
    pattern: /^\/forge\/projects$/,
    async handler({ env, principal }) {
      return json({ projects: await person(env, principal.recordId).projects() });
    },
  },
  {
    method: "POST",
    pattern: /^\/forge\/projects\/prepare$/,
    async handler(call) {
      const { env, principal, body } = call;
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u.test(name)) {
        return refusal(400, { error: "bad-name", reason: "Give the project a name of up to 40 letters, digits, spaces, dots or dashes." });
      }
      const promoter = await person(env, principal.recordId).promoter();
      if (!promoter) {
        return refusal(409, { error: "no-promoter-key", reason: "Make one of your passkeys your promoter key first." });
      }
      const slow = await allowPrepare(call);
      if (slow) return slow;
      const id = crypto.randomUUID();
      const stub = project(env, id);
      await stub.create({ id, name, owner: principal.recordId, promoter, rp: { rpId: env.RP_ID, origin: env.ORIGIN } });
      await person(env, principal.recordId).addProject({ id, name, createdAt: Date.now() });
      return answer(await stub.prepareInception());
    },
  },
  {
    // The ETag is the project's change count, so a poll that finds nothing new costs one small call.
    method: "GET",
    pattern: new RegExp(`^/forge/projects/${PROJECT_ID}$`),
    async handler(call) {
      const stub = await owned(call);
      if (!stub) return refusal(404, NOT_FOUND);
      const etag = `W/"${await stub.version()}"`;
      if (call.request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
      return json(await stub.state(), { headers: { ETag: etag } });
    },
  },
  {
    // Server-sent events: the state each time it changes, for up to a minute. EventSource connects again by itself.
    method: "GET",
    pattern: new RegExp(`^/forge/projects/${PROJECT_ID}/stream$`),
    async handler(call) {
      const stub = await owned(call);
      if (!stub) return refusal(404, NOT_FOUND);
      return stream(async (send) => {
        let seen = -1;
        const until = Date.now() + STREAM_MS;
        while (Date.now() < until && !call.request.signal.aborted) {
          const version = await stub.version();
          if (version !== seen) {
            seen = version;
            await send(`event: state\nid: ${version}\ndata: ${JSON.stringify(await stub.state())}\n\n`);
          }
          await new Promise((r) => setTimeout(r, 400));
        }
      });
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/forge/projects/${PROJECT_ID}/inception/prepare$`),
    async handler(call) {
      const stub = await owned(call);
      if (!stub) return refusal(404, NOT_FOUND);
      return (await allowPrepare(call)) ?? answer(await stub.prepareInception());
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/forge/projects/${PROJECT_ID}/agents/prepare$`),
    async handler(call) {
      const stub = await owned(call);
      if (!stub) return refusal(404, NOT_FOUND);
      const names = Array.isArray(call.body.agents) ? call.body.agents.map(String) : ["Ada", "Bo"];
      return (await allowPrepare(call)) ?? answer(await stub.prepareAdmission(names));
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/forge/projects/${PROJECT_ID}/agents/([a-z0-9-]{1,32})/revoke/prepare$`),
    async handler(call) {
      const stub = await owned(call);
      if (!stub) return refusal(404, NOT_FOUND);
      return (await allowPrepare(call)) ?? answer(await stub.prepareRevocation(call.params[1]!));
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/forge/projects/${PROJECT_ID}/releases/prepare$`),
    async handler(call) {
      const stub = await owned(call);
      if (!stub) return refusal(404, NOT_FOUND);
      return (await allowPrepare(call)) ?? answer(await stub.prepareRelease(String(call.body.name ?? "")));
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/forge/projects/${PROJECT_ID}/proposals/([0-9a-f-]{36})/prepare$`),
    async handler(call) {
      const stub = await owned(call);
      if (!stub) return refusal(404, NOT_FOUND);
      return (await allowPrepare(call)) ?? answer(await stub.preparePromotion(call.params[1]!));
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/forge/projects/${PROJECT_ID}/approvals/([0-9a-f-]{36})$`),
    async handler(call) {
      const stub = await owned(call);
      if (!stub) return refusal(404, NOT_FOUND);
      return answer(await stub.approve(call.params[1]!, call.body.response));
    },
  },
  {
    method: "GET",
    pattern: new RegExp(`^/forge/projects/${PROJECT_ID}/commits/([0-9a-f]{40})$`),
    async handler(call) {
      const stub = await owned(call);
      return stub ? answer(await stub.commit(call.params[1]!)) : refusal(404, NOT_FOUND);
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/forge/projects/${PROJECT_ID}/agents/([a-z0-9-]{1,32})/tempt$`),
    async handler(call) {
      const stub = await owned(call);
      return stub ? answer(await stub.tempt(call.params[1]!)) : refusal(404, NOT_FOUND);
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/forge/projects/${PROJECT_ID}/agents/([a-z0-9-]{1,32})/tasks$`),
    async handler(call) {
      const stub = await owned(call);
      const args = typeof call.body.topic === "string" ? { topic: call.body.topic } : {};
      return stub ? answer(await stub.give(call.params[1]!, String(call.body.task ?? ""), args)) : refusal(404, NOT_FOUND);
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/forge/projects/${PROJECT_ID}/people/prepare$`),
    async handler(call) {
      const stub = await owned(call);
      if (!stub) return refusal(404, NOT_FOUND);
      return (await allowPrepare(call)) ?? answer(await stub.preparePersonAdmission(String(call.body.publicKey ?? "")));
    },
  },
  {
    // A write token: a fresh step-up first, as for any credential the forge hands out.
    method: "POST",
    pattern: new RegExp(`^/forge/projects/${PROJECT_ID}/people/([a-z0-9-]{1,63})/push-access$`),
    async handler(call) {
      const stub = await owned(call);
      if (!stub) return refusal(404, NOT_FOUND);
      await call.passkeys.requireStepUp(call.passkeys.context(call.request), sessionValueFrom(call.request));
      return answer(await stub.pushAccess(call.params[1]!));
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/forge/projects/${PROJECT_ID}/proposals/([0-9a-f-]{36})/redo$`),
    async handler(call) {
      const stub = await owned(call);
      return stub ? answer(await stub.redo(call.params[1]!)) : refusal(404, NOT_FOUND);
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/forge/projects/${PROJECT_ID}/verify$`),
    async handler(call) {
      const stub = await owned(call);
      return stub ? answer(await stub.verifyFresh()) : refusal(404, NOT_FOUND);
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/forge/projects/${PROJECT_ID}/outside$`),
    async handler(call) {
      const stub = await owned(call);
      return stub ? answer(await stub.outside()) : refusal(404, NOT_FOUND);
    },
  },
  {
    // A push to an outside repository with the deployment's token: a fresh step-up first.
    method: "POST",
    pattern: new RegExp(`^/forge/projects/${PROJECT_ID}/mirror$`),
    async handler(call) {
      const stub = await owned(call);
      if (!stub) return refusal(404, NOT_FOUND);
      await call.passkeys.requireStepUp(call.passkeys.context(call.request), sessionValueFrom(call.request));
      return answer(await stub.mirror());
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/forge/projects/${PROJECT_ID}/reset$`),
    async handler(call) {
      const stub = await owned(call);
      if (!stub) return refusal(404, NOT_FOUND);
      await call.passkeys.requireStepUp(call.passkeys.context(call.request), sessionValueFrom(call.request));
      await stub.reset();
      await person(call.env, call.principal.recordId).removeProject(call.params[0]!);
      return json({ ok: true });
    },
  },
];

/** The forge Worker: /forge/* here, everything else to the demo app. */
export function createForge(options: ForgeOptions = {}) {
  const demo = createApp(options);
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/forge/")) return demo.fetch(request, env, ctx);
      const git = await localGitHttp(request, env);
      if (git) return git;

      const route = ROUTES.find((r) => r.method === request.method && r.pattern.test(url.pathname));
      if (!route) return error(404, "not found");
      if (request.method === "POST" && request.headers.get("Origin") !== env.ORIGIN) return error(403, "origin not allowed");

      const passkeys = createPasskeys(env, {
        rp: { id: env.RP_ID, name: env.RP_NAME, origin: env.ORIGIN },
        refusalFloorMs: Number(env.REFUSAL_FLOOR_MS),
        clock: options.clock,
        rateLimits: options.rateLimits,
        storagePrefix: options.storagePrefix,
      });
      const principal = await passkeys.authenticate(sessionValueFrom(request));
      if (!principal) return error(401, "not logged in");
      let body: any = {};
      if (request.method === "POST") {
        try {
          const text = await request.text();
          body = text ? JSON.parse(text) : {};
        } catch {
          return error(400, "malformed JSON");
        }
        if (typeof body !== "object" || body === null) return error(400, "malformed JSON");
      }
      const params = route.pattern.exec(url.pathname)!.slice(1);
      try {
        return await route.handler({ request, env, passkeys, principal, body, params, storagePrefix: options.storagePrefix });
      } catch (e) {
        if (e instanceof PasskeyError) return error(e.code === "step-up-required" ? 403 : 401, e.code);
        throw e;
      }
    },
  };
}
