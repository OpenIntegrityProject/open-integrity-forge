import { describe, expect, it } from "vitest";
import { must, Person, testForge, uniqueName, waitFor, createProject } from "./harness.ts";

describe("a conflict", () => {
  it("rejects the second of two edits to the same line, and a redo on the new main merges", async () => {
    const app = testForge();
    const leo = new Person(app);
    await leo.register(uniqueName("Leo"));
    const created = must(await createProject(leo, "conflict"));
    expect(created.policy?.mergesOnly).toBe(true);
    const id = created.id;
    must(await leo.forge.approve(must(await leo.forge.prepareAgents(id, ["Ada", "Bo"]))));
    await waitFor(leo, id, (s) => s.proposals.filter((p) => p.status === "ready").length === 2, "the first proposals");

    // Without an Anthropic API key, agents cannot write with Claude, and the page is told so.
    expect(created.llm).toBe(false);
    expect(await leo.forge.give(id, "ada", "llm-note", "key rotation")).toMatchObject({ result: "refused", status: 409, refusal: { error: "no-llm" } });

    must(await leo.forge.give(id, "ada", "readme-title"));
    must(await leo.forge.give(id, "bo", "readme-title"));
    let state = await waitFor(leo, id, (s) => s.proposals.filter((p) => p.taskId === "readme-title" && p.status === "ready").length === 2, "two retitles");
    const ada = state.proposals.find((p) => p.taskId === "readme-title" && p.agentId === "ada")!;
    state = must(await leo.forge.approve(must(await leo.forge.preparePromotion(id, ada.id))));
    const bo = state.proposals.find((p) => p.taskId === "readme-title" && p.agentId === "bo")!;
    expect(bo.status).toBe("rejected");
    expect(bo.report!.merge).toMatchObject({ ok: false, reason: expect.stringContaining("README.md") });
    expect(bo.report!.commits.every((c) => c.ok)).toBe(true);
    expect(await leo.forge.redo(id, ada.id)).toMatchObject({ result: "refused", status: 409 });

    must(await leo.forge.redo(id, bo.id));
    state = await waitFor(leo, id, (s) => s.proposals.some((p) => p.branch === "bo/readme-title-2" && p.status === "ready"), "the redo");
    expect(state.proposals.find((p) => p.id === bo.id)!.redoneAt).not.toBeNull();
    const redo = state.proposals.find((p) => p.branch === "bo/readme-title-2")!;
    state = must(await leo.forge.approve(must(await leo.forge.preparePromotion(id, redo.id))));
    expect(state.history?.ok, state.history?.summary).toBe(true);
    const policyCommits = state.history!.commits.filter((c) => c.role === "main" && c.action === "policy");
    expect(policyCommits.every((c) => c.rules.some((r) => r.rule === "R7" && r.ok))).toBe(true);
  });
});
