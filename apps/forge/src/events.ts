import { repoIndex } from "./repo-index.ts";

// Artifacts push events, from a queue. A push that the forge did not make,
// such as a person who pushes to a fork from a laptop, still gets verified:
// a push to a fork branch becomes or updates a proposal, and a push to main
// of the project repository is checked against the policy at once.
//
// Each repository needs its own subscription for `pushed` events; see
// scripts/subscribe-pushes.ts.

export interface PushedEvent {
  type: "cf.artifacts.repo.pushed";
  source: { type: "artifacts.repo"; namespace: string; repoName: string };
  payload: { ref: string; before: string; after: string };
}

function isPushed(body: unknown): body is PushedEvent {
  const e = body as PushedEvent;
  return (
    e?.type === "cf.artifacts.repo.pushed" &&
    typeof e.source?.repoName === "string" &&
    typeof e.payload?.ref === "string" &&
    /^[0-9a-f]{40}$/.test(e.payload?.after ?? "")
  );
}

/** Handle one push event. Returns what it did, for the logs and the tests. */
export async function onPushed(env: Env, event: PushedEvent): Promise<string> {
  const entry = await repoIndex(env).get(event.source.repoName);
  if (!entry) return "ignored: not a forge repository";
  if (!event.payload.ref.startsWith("refs/heads/")) return "ignored: not a branch";
  const branch = event.payload.ref.slice("refs/heads/".length);
  const project = env.PROJECTS.get(env.PROJECTS.idFromName(entry.projectId));
  if (entry.agentId === null) return branch === "main" ? project.mainPushed(event.payload.after) : "ignored: not main";
  return project.forkPushed(entry.agentId, branch, event.payload.after);
}

export async function handleRepoEvents(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    if (!isPushed(message.body)) {
      message.ack();
      continue;
    }
    try {
      console.log(`push to ${message.body.source.repoName} ${message.body.payload.ref}: ${await onPushed(env, message.body)}`);
      message.ack();
    } catch (error) {
      console.error(error);
      message.retry();
    }
  }
}
