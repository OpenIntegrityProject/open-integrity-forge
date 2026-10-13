import { describe, expect, it } from "vitest";
import { must, Person, testForge, uniqueName, waitFor, createProject } from "./harness.ts";

describe("revoking an agent's key", () => {
  it("is a policy change under a passkey approval; the agent stops, and its earlier work still verifies", async () => {
    const app = testForge();
    const leo = new Person(app);
    await leo.register(uniqueName("Leo"));
    const id = must(await createProject(leo, "revocation")).id;
    must(await leo.forge.approve(must(await leo.forge.prepareAgents(id, ["Ada", "Bo"]))));
    await waitFor(leo, id, (s) => s.proposals.filter((p) => p.status === "ready").length === 2, "two proposals");

    const request = must(await leo.forge.prepareRevocation(id, "bo"));
    expect(request.payload.action).toBe("policy");
    expect(request.summary).toContain("Revoke Bo's key");
    expect(request.changes.map((c) => c.path)).toContain(".repo/config/verification/policy.json");
    const state = must(await leo.forge.approve(request));

    const bo = state.policy!.authors.find((a) => a.id === "bo")!;
    expect(Date.parse(bo.revokedAt!)).toBeLessThanOrEqual(Date.now());
    expect(state.policy!.authors.find((a) => a.id === "ada")!.revokedAt).toBeUndefined();
    expect(state.agents.find((a) => a.id === "bo")!.tokenExpiresAt).toBeNull();
    expect(state.history?.ok).toBe(true);
    expect(state.history?.commits.at(-1)?.subject).toBe("Revoke the key of Bo");
    // Bo's proposal was signed before the revocation, so it still verifies, now with R6 in its report.
    const boProposal = state.proposals.find((p) => p.agentId === "bo")!;
    expect(boProposal.status).toBe("ready");
    expect(boProposal.report!.commits[0]!.rules.find((r) => r.rule === "R6")).toMatchObject({ ok: true });

    expect(await leo.forge.tempt(id, "bo")).toMatchObject({ result: "refused", status: 409, refusal: { error: "revoked" } });
    expect(await leo.forge.prepareRevocation(id, "bo")).toMatchObject({ result: "refused", status: 409 });
    must(await leo.forge.tempt(id, "ada"));
  });
});
