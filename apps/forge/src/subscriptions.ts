// Artifacts sends `pushed` events only to a subscription for one repository.
// With a Cloudflare API token, the forge subscribes its queue to each
// repository that it makes. It removes the subscription when it deletes the
// repository. Without the token, the forge makes no subscription, and
// scripts/subscribe-pushes.ts does the same work manually.

const API = "https://api.cloudflare.com/client/v4";

function enabled(env: Env): env is Env & { CF_API_TOKEN: string } {
  return env.REPO_HOST === "artifacts" && Boolean(env.CF_API_TOKEN) && Boolean(env.CF_ACCOUNT_ID);
}

async function call<T>(env: Env & { CF_API_TOKEN: string }, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}/accounts/${env.CF_ACCOUNT_ID}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
  });
  const body = (await response.json()) as { success: boolean; result: T; errors?: { message: string }[] };
  if (!response.ok || !body.success) throw new Error(`Cloudflare API ${path}: ${body.errors?.map((e) => e.message).join("; ") ?? response.status}`);
  return body.result;
}

let queueId: Promise<string> | undefined;

/** The id of the queue the forge consumes push events from. */
function pushQueue(env: Env & { CF_API_TOKEN: string }): Promise<string> {
  queueId ??= call<{ queue_id: string; queue_name: string }[]>(env, "/queues").then((queues) => {
    const found = queues.find((q) => q.queue_name === env.PUSH_QUEUE);
    if (!found) throw new Error(`there is no queue ${env.PUSH_QUEUE}`);
    return found.queue_id;
  });
  return queueId;
}

/** Subscribe the push queue to `pushed` events of one repository. Returns the subscription id, or null when the deployment cannot subscribe. */
export async function subscribePushes(env: Env, repoName: string): Promise<string | null> {
  if (!enabled(env)) return null;
  const created = await call<{ id: string }>(env, "/event_subscriptions/subscriptions", {
    method: "POST",
    body: JSON.stringify({
      name: `forge-${repoName}`.slice(0, 63),
      enabled: true,
      source: { type: "artifacts.repo", namespace: env.ARTIFACTS_NAMESPACE, repo_name: repoName },
      events: ["pushed"],
      destination: { type: "queues.queue", queue_id: await pushQueue(env) },
    }),
  });
  return created.id;
}

/** Remove a subscription. It logs a failure and does not throw it, because the repository is gone in all cases. */
export async function unsubscribe(env: Env, id: string): Promise<void> {
  if (!enabled(env)) return;
  await call(env, `/event_subscriptions/subscriptions/${id}`, { method: "DELETE" }).catch((error) => console.error(error));
}
