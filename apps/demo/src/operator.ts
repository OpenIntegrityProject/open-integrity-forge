import { isRecordId, PasskeyError, sessionValueFrom, type RecordId } from "passkey-cloudflare";
import { error, json, type Call, type Handler } from "./http.ts";
import type { OperatorLogEntry } from "./operator-log.ts";
import type { MemberView, OperatorActed } from "./responses.ts";

/** An operator action's answer, as the routes send it. */
type Acted = OperatorActed & { ok: true };

// Every operator request, end to end: the operator role, step-up, the target,
// the action's checks, the log entry, then the action. The entry is written
// before the action, so nothing is done without one; if it cannot be written,
// the action is refused. The operator role belongs to this application, not
// to the identity layer (ADR 0003), and so does the log.

/** Who holds the operator role. */
export interface OperatorRoles {
  isOperator(recordId: RecordId): Promise<boolean>;
}

/** Who holds the operator role for one request. */
export type OperatorRolesFor = (call: Call) => OperatorRoles;

/** A comma-separated list from a var or secret, each item trimmed, empty items dropped. */
export function listFrom(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** The operator role as the `OPERATOR_RECORD_IDS` secret grants it: a comma-separated list of record ids. */
export function operatorRolesFromSecret({ env }: Call): OperatorRoles {
  const ids = new Set(listFrom(env.OPERATOR_RECORD_IDS));
  return { isOperator: async (recordId) => ids.has(recordId) };
}

/** What an operator sees of a member: the record's state and counts, and the operator log entries that target it. */
async function memberView(call: Call, recordId: RecordId): Promise<MemberView> {
  return {
    recordId,
    summary: await call.passkeys.recordSummary(recordId),
    entries: await call.log().listFor(recordId),
  };
}

/** The record named by `recordId` in the body, if it is one that exists. */
async function recordNamedById(call: Call): Promise<RecordId | null> {
  const recordId = call.body.recordId;
  if (!isRecordId(recordId)) return null;
  try {
    await call.passkeys.recordSummary(recordId);
    return recordId;
  } catch (e) {
    if (e instanceof PasskeyError && e.code === "not-found") return null;
    throw e;
  }
}

/** How the actions that act only on a verified record name it. */
const BY_RECORD_ID = { target: recordNamedById, missing: "not found" };

/** The record holding the member name in the body, retired or not. */
function recordNamedByMemberName(call: Call): Promise<RecordId | null> {
  return call.passkeys.resolveMemberName(call.body.memberName);
}

interface Action {
  /** How the request names its target. */
  target: (call: Call) => Promise<RecordId | null>;
  /** What a missing target is refused with. */
  missing: string;
  /** A refusal for this target, checked before anything is logged; null to go ahead. */
  check?: (call: Call, targetId: RecordId) => Promise<Response | null>;
  /** The action, carried out once its entry is logged, and its answer. */
  act: (call: Call, targetId: RecordId) => Promise<Response>;
}

/** The caller's record id, if they hold the operator role and have stepped up; otherwise the refusal. */
async function steppedUpOperator(roles: OperatorRolesFor, call: Call): Promise<RecordId | Response> {
  const principal = await call.passkeys.authenticate(sessionValueFrom(call.request));
  if (!principal) return error(401, "not logged in");
  if (!(await roles(call).isOperator(principal.recordId))) return error(403, "not an operator");
  await call.passkeys.requireStepUp(call.ctx, sessionValueFrom(call.request));
  return principal.recordId;
}

/** A route that runs one operator action in order. Each step's refusal stops it before the log entry. */
function operatorRoute(roles: OperatorRolesFor, logged: OperatorLogEntry["action"], action: Action): Handler {
  return async (call) => {
    const operatorId = await steppedUpOperator(roles, call);
    if (operatorId instanceof Response) return operatorId;
    const targetId = await action.target(call);
    if (!targetId) return error(404, action.missing);
    const refusal = await action.check?.(call, targetId);
    if (refusal) return refusal;
    await call.log().append({ operatorId, action: logged, targetId, at: call.ctx.now });
    return action.act(call, targetId);
  };
}

/** Answer an action with the member as it now stands, and anything else the action gives back. */
async function withMember(call: Call, targetId: RecordId, extra: Record<string, unknown> = {}) {
  return json({ ok: true, ...extra, member: await memberView(call, targetId) } satisfies Acted);
}

/** The operator routes, each answering a POST, given who holds the operator role. */
export function operatorRoutes(roles: OperatorRolesFor): Record<string, Handler> {
  const route = (logged: OperatorLogEntry["action"], action: Action) => operatorRoute(roles, logged, action);
  return {
    "/operator/lookup": route("lookup", {
      target: recordNamedByMemberName,
      missing: "no such member",
      act: async (call, targetId) =>
        json({
          ...(await memberView(call, targetId)),
          retired: await call.passkeys.isRetiredMemberName(call.body.memberName),
        } satisfies MemberView),
    }),

    "/operator/rebind-links": route("create-rebind-link", {
      ...BY_RECORD_ID,
      act: async (call, targetId) => {
        const link = await call.passkeys.createRebindLink(call.ctx, targetId);
        return withMember(call, targetId, { link: `${call.env.ORIGIN}/rebind#${link}` });
      },
    }),

    "/operator/suspend": route("suspend", {
      ...BY_RECORD_ID,
      act: async (call, targetId) => {
        await call.passkeys.suspend(call.ctx, targetId);
        return withMember(call, targetId);
      },
    }),

    "/operator/resume": route("resume", {
      ...BY_RECORD_ID,
      act: async (call, targetId) => {
        await call.passkeys.resume(targetId);
        return withMember(call, targetId);
      },
    }),

    "/operator/remove": route("remove", {
      ...BY_RECORD_ID,
      // An operator is taken off the role before they can be removed.
      check: async (call, targetId) =>
        (await roles(call).isOperator(targetId)) ? error(409, "operator record") : null,
      act: async (call, targetId) => {
        await call.passkeys.remove(call.ctx, targetId);
        // Removal retires the name the record holds, unless it was allowed again before.
        const memberName = await call.passkeys.memberName(targetId);
        const retired = memberName !== null && (await call.passkeys.isRetiredMemberName(memberName));
        return json({ ok: true, member: { ...(await memberView(call, targetId)), retired } } satisfies Acted);
      },
    }),

    "/operator/allow-name": route("allow-name", {
      target: recordNamedByMemberName,
      missing: "not found",
      check: async (call) =>
        (await call.passkeys.isRetiredMemberName(call.body.memberName)) ? null : error(409, "name not retired"),
      act: async (call, targetId) => {
        // The name can stop being retired between the check and here; the entry then stands for an undone action.
        if (!(await call.passkeys.allowRetiredMemberName(call.body.memberName))) return error(409, "name not retired");
        return json({ ok: true, member: { ...(await memberView(call, targetId)), retired: false } } satisfies Acted);
      },
    }),
  };
}

/** The operator log's recent entries, for an operator who has stepped up. */
export function operatorLogRoute(roles: OperatorRolesFor): Handler {
  return async (call) => {
    const caller = await steppedUpOperator(roles, call);
    if (caller instanceof Response) return caller;
    return json({ entries: await call.log().list() });
  };
}
