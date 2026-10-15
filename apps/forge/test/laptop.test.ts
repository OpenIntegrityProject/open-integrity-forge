import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { changeFiles, memoryRepo, readCommit, resolve, setRef } from "../authority/git.ts";
import { commitSigned } from "../authority/make.ts";
import { generateKey, publicKeyText } from "../authority/sshsig.ts";
import { onPushed } from "../src/events.ts";
import { repoHost } from "../src/repo-host.ts";
import { must, Person, testForge, uniqueName, createProject } from "./harness.ts";

describe("a person's laptop key", () => {
  it("is admitted under a passkey approval, and a signed push to its fork verifies like an agent's", async () => {
    const app = testForge();
    const leo = new Person(app);
    const name = uniqueName("Leo");
    await leo.register(name);
    const id = must(await createProject(leo, "laptop")).id;
    expect(await leo.forge.preparePerson(id, "not a key")).toMatchObject({ result: "refused", status: 400 });

    const laptop = await generateKey();
    const request = must(await leo.forge.preparePerson(id, publicKeyText(laptop.publicKey)));
    expect(request.summary).toContain("Admit your laptop's SSH key");
    let state = must(await leo.forge.approve(request));
    const person = state.agents.find((a) => a.kind === "person")!;
    expect(person.id).toBe(`${name.toLowerCase()}-laptop`);
    expect(state.policy!.authors.find((a) => a.id === person.id)!.publicKey).toBe(publicKeyText(laptop.publicKey));
    expect(await leo.forge.preparePerson(id, publicKeyText(laptop.publicKey))).toMatchObject({ result: "refused", status: 409 });
    // Push access needs Artifacts. The local deployment has no Git server that accepts a push.
    expect(await leo.forge.pushAccess(id, person.id)).toMatchObject({ result: "refused", refusal: { error: "local" } });
    expect(await leo.forge.tempt(id, person.id)).toMatchObject({ result: "refused", status: 404 });

    // What git on the laptop does: clone the fork, commit with the laptop key, push a branch.
    const host = repoHost(env as Env);
    const transport = await host.transport(person.fork, await host.token(person.fork, "write", 120));
    const repo = await memoryRepo();
    await transport.clone(repo);
    const main = (await resolve(repo, "refs/heads/main"))!;
    const tree = await changeFiles(repo, (await readCommit(repo, main)).tree, { "notes/laptop.md": "# From a laptop\n" });
    const head = await commitSigned(repo, {
      tree,
      parents: [main],
      message: "Add a note from my laptop\n",
      author: { name, email: "leo@example.com", timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 },
      key: laptop,
    });
    await setRef(repo, "refs/heads/my-change", head);
    await transport.push(repo, "refs/heads/my-change", "refs/heads/my-change", null);
    const event = { type: "cf.artifacts.repo.pushed" as const, source: { type: "artifacts.repo" as const, namespace: "forge-demo", repoName: person.fork }, payload: { ref: "refs/heads/my-change", before: "0".repeat(40), after: head } };
    expect(await onPushed(env as Env, event)).toBe("verified: ready");

    state = must(await leo.forge.state(id));
    const proposal = state.proposals.find((p) => p.head === head)!;
    expect(proposal.title).toBe(`my-change, pushed from ${person.name}`);
    expect(proposal.report!.commits[0]!.rules.find((r) => r.rule === "R3")!.reason).toContain(`author ${person.id}`);
    state = must(await leo.forge.approve(must(await leo.forge.preparePromotion(id, proposal.id))));
    expect(state.history?.ok, state.history?.summary).toBe(true);
  });
});
