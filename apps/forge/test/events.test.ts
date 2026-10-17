import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { changeFiles, commitTree, memoryRepo, readCommit, resolve, setRef } from "../authority/git.ts";
import { commitSigned } from "../authority/make.ts";
import { fingerprint, generateKey } from "../authority/sshsig.ts";
import { onPushed, type PushedEvent } from "../src/events.ts";
import { repoHost } from "../src/repo-host.ts";
import type { ProjectState } from "../src/state.ts";
import { must, Person, testForge, uniqueName, waitFor, createProject } from "./harness.ts";

async function withAgents() {
  const app = testForge();
  const leo = new Person(app);
  await leo.register(uniqueName("Leo"));
  const created = must(await createProject(leo, "pushes"));
  must(await leo.forge.approve(must(await leo.forge.prepareAgents(created.id, ["Ada", "Bo"]))));
  const state = await waitFor(leo, created.id, (s) => s.proposals.filter((p) => p.status === "ready").length === 2, "two proposals");
  return { app, leo, id: created.id, state };
}

const pushed = (repoName: string, ref: string, after: string): PushedEvent => ({
  type: "cf.artifacts.repo.pushed",
  source: { type: "artifacts.repo", namespace: "forge-demo", repoName },
  payload: { ref, before: "0".repeat(40), after },
});

/** Clone a repository with a write token, as a person outside the forge can do with that token. */
async function cloneWithToken(name: string) {
  const host = repoHost(env as Env);
  const token = await host.token(name, "write", 120);
  const transport = await host.transport(name, token);
  const repo = await memoryRepo();
  await transport.clone(repo);
  return { repo, transport, main: (await resolve(repo, "refs/heads/main"))! };
}

describe("push events", () => {
  it("ignore the agents' own pushes, which the agents propose", async () => {
    const { state } = await withAgents();
    const ada = state.agents.find((a) => a.id === "ada")!;
    const head = ada.tasks[0]!.head!;
    expect(await onPushed(env as Env, pushed(ada.fork, `refs/heads/${ada.tasks[0]!.branch}`, head))).toBe(
      "ignored: the agent proposes its own push",
    );
    expect(await onPushed(env as Env, pushed("not-a-forge-repo", "refs/heads/main", head))).toBe("ignored: not a forge repository");
  });

  it("turn a push to a fork from outside the forge into a verified proposal", async () => {
    const { leo, id, state } = await withAgents();
    const bo = state.agents.find((a) => a.id === "bo")!;
    const { repo, transport, main } = await cloneWithToken(bo.fork);
    // A laptop key that the policy does not list.
    const laptop = await generateKey();
    const tree = await changeFiles(repo, (await readCommit(repo, main)).tree, { "notes/laptop.md": "# From a laptop\n" });
    const head = await commitSigned(repo, {
      tree,
      parents: [main],
      message: "Work from a laptop\n",
      author: { name: "Someone", email: "someone@example.com", timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 },
      key: laptop,
    });
    await setRef(repo, "refs/heads/laptop", head);
    await transport.push(repo, "refs/heads/laptop", "refs/heads/laptop", null);
    expect(await onPushed(env as Env, pushed(bo.fork, "refs/heads/laptop", head))).toBe("verified: rejected");
    const after = must(await leo.forge.state(id));
    const outside = after.proposals.find((p) => p.taskId === "outside")!;
    expect(outside.title).toBe("Push to laptop from outside the forge");
    const r3 = outside.report!.commits[0]!.rules.find((r) => r.rule === "R3")!;
    expect(r3).toMatchObject({ ok: false });
    expect(r3.reason).toContain(await fingerprint(laptop.publicKey));
  });

  it("flag a push to main that the forge did not make", async () => {
    const { leo, id, state } = await withAgents();
    const { repo, transport, main } = await cloneWithToken(state.repo.name);
    const tree = await changeFiles(repo, (await readCommit(repo, main)).tree, { "README.md": "# Taken over\n" });
    const head = await commitTree(repo, {
      tree,
      parents: [main],
      message: "Push straight to main\n",
      author: { name: "Leaked token", email: "x@example.com", timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 },
    });
    await setRef(repo, "refs/heads/main", head);
    await transport.push(repo, "refs/heads/main", "refs/heads/main", main);
    expect(await onPushed(env as Env, pushed(state.repo.name, "refs/heads/main", head))).toBe("verified: main is not valid");
    const after = must(await leo.forge.state(id));
    expect(after.history?.ok).toBe(false);
    expect(after.history?.commits.at(-1)?.rules.find((r) => r.rule === "R1")).toMatchObject({ ok: false });
    expect(after.events.at(-1)?.text).toContain("outside the forge");
  });
});

describe("the state routes", () => {
  it("answer a poll that finds nothing new with 304", async () => {
    const { leo, id } = await withAgents();
    const first = await leo.browser.get(`/forge/projects/${id}`);
    const etag = first.headers.get("ETag")!;
    expect(etag).toMatch(/^W\/"\d+"$/);
    const again = await leo.browser.get(`/forge/projects/${id}`, { "If-None-Match": etag });
    expect(again.status).toBe(304);
    must(await leo.forge.tempt(id, "bo"));
    const changed = await leo.browser.get(`/forge/projects/${id}`, { "If-None-Match": etag });
    expect(changed.status).toBe(200);
    // The state carries the count its ETag names, so a page can tell an older state from a newer one.
    const before = (await first.json()) as ProjectState;
    const after = (await changed.json()) as ProjectState;
    expect(etag).toBe(`W/"${before.version}"`);
    expect(after.version).toBeGreaterThan(before.version);
    // Let Bo's task finish before the test ends, so the runtime does not close while the agent is still working.
    await waitFor(leo, id, (s) => s.proposals.some((p) => p.agentId === "bo" && p.taskId === "permanent-key" && p.status === "rejected"), "Bo's rogue proposal");
  });

  it("stream the state as server-sent events", async () => {
    const { leo, id } = await withAgents();
    const response = await leo.browser.get(`/forge/projects/${id}/stream`);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    let text = "";
    while (!text.includes("event: state")) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    expect(text).toContain("retry: 1000");
    expect(text).toMatch(/event: state\nid: \d+\ndata: \{/);
  });
});
