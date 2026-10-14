import { describe, expect, it } from "vitest";
import { must, Person, testForge, uniqueName, waitFor } from "./harness.ts";

describe("the whole journey", () => {
  it("creates a project, runs two agents, rejects the rogue key, promotes, and verifies from a fresh clone", async () => {
    const app = testForge();
    const leo = new Person(app);
    const key = await leo.register(uniqueName("Leo"));
    expect(key.label).toMatch(/^[a-z]{4}-[a-z]{4}-[a-z]{4}$/);

    // Touch ID #1: the passkey signs the empty inception commit as an SSH signature.
    const inception = must(await leo.forge.prepareProject("gordian notes"));
    expect(inception.payload).toMatchObject({ action: "incept", repo: null, parents: [], tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" });
    expect(inception.options.allowCredentials).toEqual([{ id: key.credentialId, type: "public-key" }]);
    expect(inception.changes).toEqual([]);
    const signed = must(await leo.forge.approve(inception));
    expect(signed.repoId).toMatch(/^[0-9a-f]{40}$/);
    expect(signed.mainHead).toBe(signed.repoId);
    expect(signed.policy).toBeNull();
    expect(signed.history?.ok).toBe(true);
    expect(signed.history?.commits[0]?.rules[0]?.reason).toContain("Root of trust: an empty commit signed by the passkey");
    const id = signed.id;

    // Touch ID #2: the same passkey approves the first policy.
    const first = must(await leo.forge.prepareInception(id));
    expect(first.payload).toMatchObject({ action: "incept", repo: signed.repoId, parents: [signed.repoId] });
    expect(first.changes.map((c) => c.path)).toContain(".repo/config/verification/policy.json");
    expect(first.changes.map((c) => c.path)).toContain(".github/workflows/verify.yml");
    const created = must(await leo.forge.approve(first));
    expect(created.history?.ok).toBe(true);
    expect(created.policy?.promoters.map((p) => p.id)).toEqual([key.id]);
    expect(await leo.forge.prepareInception(id)).toMatchObject({ result: "refused", status: 409 });

    // Touch ID #3: admit two author keys.
    const admission = must(await leo.forge.prepareAgents(id, ["Ada", "Bo"]));
    expect(admission.payload).toMatchObject({ action: "policy", repo: created.repoId, parents: [created.mainHead] });
    must(await leo.forge.approve(admission));

    // Both agents work at the same time in their own forks, and the verifier accepts both proposals.
    let state = await waitFor(leo, id, (s) => s.proposals.filter((p) => p.status === "ready").length === 2, "two ready proposals");
    expect(state.policy?.authors.map((a) => a.id)).toEqual(["ada", "bo"]);
    expect(state.agents.map((a) => a.fork)).toEqual([`${state.repo.name}-ada`, `${state.repo.name}-bo`]);
    for (const agent of state.agents) {
      expect(agent.tasks[0]?.events.map((e) => e.text.split(" ")[0])).toEqual(["Started", "Cloned", "Edited", "Signed", "Pushed", "Proposed"]);
    }

    // The rogue task: Bo lists his own key as a promoter. R2 rejects it.
    must(await leo.forge.tempt(id, "bo"));
    state = await waitFor(leo, id, (s) => s.proposals.some((p) => p.taskId === "permanent-key" && p.status === "rejected"), "the rogue proposal");
    const rogue = state.proposals.find((p) => p.taskId === "permanent-key")!;
    const r2 = rogue.report!.commits[0]!.rules.find((r) => r.rule === "R2")!;
    expect(r2.ok).toBe(false);
    expect(r2.reason).toContain("a key can never authorize itself");
    expect(rogue.report!.commits[0]!.rules.find((r) => r.rule === "R3")!.ok).toBe(true);
    const refusedRogue = await leo.forge.preparePromotion(id, rogue.id);
    expect(refusedRogue).toMatchObject({ result: "refused", status: 409 });

    // Touch ID #4: promote Ada. The honest proposal of Bo becomes stale, and the forge verifies it again on the new main.
    const ada = state.proposals.find((p) => p.agentId === "ada")!;
    const promotion = must(await leo.forge.preparePromotion(id, ada.id));
    expect(promotion.payload.parents).toEqual([state.mainHead, ada.head]);
    expect(promotion.changes).toEqual([{ path: "CHANGELOG.md", change: "modified" }]);
    expect(promotion.message).toContain(`Promote "Add a changelog entry" from Ada`);
    state = must(await leo.forge.approve(promotion));
    expect(state.proposals.find((p) => p.id === ada.id)?.status).toBe("promoted");
    const bo = state.proposals.find((p) => p.agentId === "bo" && p.taskId === "readme-es")!;
    expect(bo.status).toBe("ready");
    expect(bo.base).toBe(state.mainHead);

    // Touch ID #5 also promotes the honest change of Bo.
    state = must(await leo.forge.approve(must(await leo.forge.preparePromotion(id, bo.id))));
    expect(state.history?.ok).toBe(true);
    expect(state.history?.commits.map((c) => c.role)).toEqual(["inception", "main", "main", "merged", "main", "merged", "main"]);

    // A new clone, with the repository id fixed, gives the same result.
    const fresh = must(await leo.forge.verifyFresh(id));
    expect(fresh.report.ok).toBe(true);
    expect(fresh.report.repoId).toBe(state.repoId);
    expect(fresh.report.commits.some((c) => c.oid === rogue.head)).toBe(false);

    // The commit sheet reads commits from main and from forks, with their proof.
    const root = must(await leo.forge.commit(id, state.repoId!));
    expect(root.approval).toBeNull();
    expect(root.signature).toContain("BEGIN SSH SIGNATURE");
    expect(root.committer.name).toMatch(/^SHA256:/);
    expect(root.report?.rules[0]?.rule).toBe("R0");
    expect(root.changes).toEqual([]);
    const policyCommit = must(await leo.forge.commit(id, created.mainHead!));
    expect(policyCommit.approval?.payload).toMatchObject({ action: "incept", repo: state.repoId, parents: [state.repoId] });
    expect(policyCommit.changes.map((c) => c.path)).toContain(".repo/config/verification/policy.json");
    expect(policyCommit.message).not.toContain("Forge-Approval");
    // The passkey signs the whole promotion commit. Git can check this SSH signature. The commit also has its approval and Envelope.
    const promoted = must(await leo.forge.commit(id, state.mainHead!));
    expect(promoted.signature).toContain("BEGIN SSH SIGNATURE");
    expect(promoted.approval?.payload).toMatchObject({ action: "promote", repo: state.repoId });
    expect(promoted.approval?.envelope.full.ur).toMatch(/^ur:envelope\//);
    expect(promoted.report?.rules.find((r) => r.rule === "R1")?.reason).toMatch(/^Signed as a whole by the passkey of promoter /);
    expect(promoted.message).not.toContain("Forge-Approval");
    const rogueCommit = must(await leo.forge.commit(id, rogue.head));
    expect(rogueCommit.signature).toContain("BEGIN SSH SIGNATURE");
    expect(rogueCommit.approval).toBeNull();
    expect(rogueCommit.report?.ok).toBe(false);
    const policyDiff = rogue.changes.find((c) => c.path.endsWith("policy.json"))!;
    expect(policyDiff.lines?.some((l) => l.kind === "+" && l.text.includes('"kind": "ssh-ed25519"'))).toBe(true);
    expect(policyDiff.lines?.some((l) => l.kind === "+" && l.text.includes("2099-12-31"))).toBe(true);
    expect(await leo.forge.commit(id, "f".repeat(40))).toMatchObject({ result: "refused", status: 404 });

    const outside = must(await leo.forge.outside(id));
    expect(outside.commands[0]).toContain(`/forge/git/${state.repo.name}.git`);
    expect(outside.commands[1]).toMatch(/forge-verify\.mjs && echo "[0-9a-f]{64}  forge-verify\.mjs"/);
    expect(outside.commands[2]).toContain(`--repo ${state.repoId}`);
    // This test deployment has no mirror.
    expect(state.mirror).toMatchObject({ available: false, last: null });
    expect(await leo.forge.mirror(id)).toMatchObject({ result: "refused", status: 409, refusal: { error: "no-mirror" } });
  });
});
