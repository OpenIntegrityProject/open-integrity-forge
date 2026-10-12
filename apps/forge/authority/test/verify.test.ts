import { describe, expect, it } from "vitest";
import { approvalIn, withTrailer } from "../approval.ts";
import { changeFiles, commitTree, readCommit } from "../git.ts";
import { POLICY_PATH, renderPolicy } from "../policy.ts";
import { verifyHistory, verifyProposal, type CommitReport, type RuleId } from "../verify.ts";
import { history, T0, testAuthor, who } from "./history.ts";
import { testPromoter } from "./promoter.ts";

function rule(report: CommitReport | undefined, id: RuleId) {
  return report?.rules.find((r) => r.rule === id);
}

describe("an honest history", () => {
  it("verifies from the root to a promotion of two agents' work", async () => {
    const h = await history();
    const adaWork = await h.work(h.ada, h.admitted, { "CHANGELOG.md": "# Changelog\n\n- Ada was here.\n" });
    const boWork = await h.work(h.bo, h.admitted, { "README.es.md": "# Notas Gordian\n" });
    const ada = await verifyProposal(h.repo, h.admitted, adaWork);
    expect(ada.ok, ada.summary).toBe(true);
    const first = await h.promote(h.admitted, adaWork);
    const bo = await verifyProposal(h.repo, first, boWork);
    expect(bo.ok, bo.summary).toBe(true);
    const second = await h.promote(first, boWork);
    const report = await verifyHistory(h.repo, second);
    expect(report.ok, JSON.stringify(report.commits.filter((c) => !c.ok), null, 1)).toBe(true);
    expect(report.repoId).toBe(h.repoId);
    expect(report.commits.map((c) => c.role)).toEqual(["inception", "main", "merged", "main", "merged", "main"]);
    expect(rule(report.commits[2], "R3")?.reason).toContain("author ada");
  });
});

describe("each rule", () => {
  it("R0: a root whose approval comes from a key not in its own policy fails", async () => {
    const h = await history();
    const mallory = await testPromoter("mallory");
    const root = await readCommit(h.repo, h.repoId);
    const approval = await mallory.approve(new Uint8Array([1]));
    const forged = await commitTree(h.repo, { tree: root.tree, parents: [], message: withTrailer("Root\n", approval), author: who("M", T0) });
    const report = await verifyHistory(h.repo, forged);
    expect(report.ok).toBe(false);
    expect(report.repoId).toBeNull();
    expect(rule(report.commits[0], "R0")?.ok).toBe(false);
  });

  it("R0: a pinned repository id that differs fails", async () => {
    const h = await history();
    const report = await verifyHistory(h.repo, h.admitted, { repoId: "f".repeat(40) });
    expect(report.ok).toBe(false);
  });

  it("R1: a merge on main without an approval fails", async () => {
    const h = await history();
    const work = await h.work(h.ada, h.admitted, { "a.md": "a\n" });
    const tree = (await readCommit(h.repo, work)).tree;
    const merge = await commitTree(h.repo, { tree, parents: [h.admitted, work], message: "Merge without approval\n", author: who("Platform", T0) });
    const report = await verifyHistory(h.repo, merge);
    expect(rule(report.commits.at(-1), "R1")).toMatchObject({ ok: false, reason: "Main moved without an approval from a promoter." });
  });

  it("R1: an approval from a promoter added by the same commit fails", async () => {
    const h = await history();
    const mallory = await testPromoter("mallory");
    const tree = await changeFiles(h.repo, (await readCommit(h.repo, h.admitted)).tree, {
      [POLICY_PATH]: renderPolicy({ ...h.policy, promoters: [...h.policy.promoters, mallory.entry] }),
    });
    const oid = await h.approve({ action: "policy", parents: [h.admitted], tree, summary: "Mallory admits herself", by: mallory });
    const report = await verifyHistory(h.repo, oid);
    expect(rule(report.commits.at(-1), "R1")?.ok).toBe(false);
    expect(rule(report.commits.at(-1), "R2")?.ok).toBe(false);
  });

  it("R2: an author key that adds itself as a promoter is rejected, and stays rejected if promoted anyway", async () => {
    const h = await history();
    const rogue = { ...h.policy, promoters: [...h.policy.promoters, { id: "bo-promoter", kind: "ssh-ed25519" as const, publicKey: h.bo.entry.publicKey }] };
    const work = await h.work(h.bo, h.admitted, { [POLICY_PATH]: renderPolicy(rogue) });
    const proposal = await verifyProposal(h.repo, h.admitted, work);
    expect(proposal.ok).toBe(false);
    expect(rule(proposal.commits[0], "R3")?.ok).toBe(true);
    expect(rule(proposal.commits[0], "R2")?.reason).toContain("a key can never authorize itself");
    const promoted = await h.promote(h.admitted, work);
    const report = await verifyHistory(h.repo, promoted);
    expect(report.ok).toBe(false);
    expect(report.commits.find((c) => c.oid === work)?.ok).toBe(false);
  });

  it("R3: an unsigned commit and a commit by an unknown key fail", async () => {
    const h = await history();
    const unsigned = await h.work(h.ada, h.admitted, { "a.md": "a\n" }, { unsigned: true });
    expect(rule((await verifyProposal(h.repo, h.admitted, unsigned)).commits[0], "R3")).toMatchObject({ ok: false, reason: "The commit is not signed." });
    const eve = await testAuthor("eve");
    const unknown = await h.work(eve, h.admitted, { "a.md": "a\n" });
    expect(rule((await verifyProposal(h.repo, h.admitted, unknown)).commits[0], "R3")?.reason).toContain("does not list");
  });

  it("R4: an approval moved to another change, or made for another repository, fails", async () => {
    const h = await history();
    const work = await h.work(h.ada, h.admitted, { "a.md": "a\n" });
    const good = await h.promote(h.admitted, work);
    const approval = approvalIn((await readCommit(h.repo, good)).message)!;
    const other = await h.work(h.ada, h.admitted, { "b.md": "b\n" });
    const tree = (await readCommit(h.repo, other)).tree;
    const moved = await commitTree(h.repo, { tree, parents: [h.admitted, other], message: withTrailer("Moved\n", approval), author: who("P", T0) });
    expect(rule((await verifyHistory(h.repo, moved)).commits.at(-1), "R4")).toMatchObject({ ok: false, reason: "The approval names a different parents, tree." });

    const merged = (await readCommit(h.repo, good)).tree;
    const foreign = await h.approve({ action: "promote", parents: [h.admitted, work], tree: merged, summary: "Elsewhere", repoId: "e".repeat(40) });
    expect(rule((await verifyHistory(h.repo, foreign)).commits.at(-1), "R4")?.reason).toContain("repository");
  });

  it("R5: a commit outside the key's window fails", async () => {
    const h = await history();
    const late = await h.work(h.ada, h.admitted, { "a.md": "a\n" }, { at: T0 + 2 * 3600_000 });
    expect(rule((await verifyProposal(h.repo, h.admitted, late)).commits[0], "R5")?.ok).toBe(false);
  });

  it("M: two proposals that change the same line conflict once one is promoted", async () => {
    const h = await history();
    const a = await h.work(h.ada, h.admitted, { "README.md": "# Ada's notes\n" });
    const b = await h.work(h.bo, h.admitted, { "README.md": "# Bo's notes\n" });
    const promoted = await h.promote(h.admitted, a);
    const report = await verifyProposal(h.repo, promoted, b);
    expect(report.merge).toMatchObject({ ok: false });
    expect(report.merge.reason).toContain("README.md");
  });
});

describe("revocation", () => {
  it("R6: a revoked key's later commits fail, and its earlier ones still verify", async () => {
    const { withRevoked, POLICY_PATH: path, renderPolicy: render } = await import("../policy.ts");
    const h = await history();
    const before = await h.work(h.bo, h.admitted, { "a.md": "a\n" }, { at: T0 + 5 * 60_000 });
    const revokedPolicy = withRevoked(h.policy, "bo", new Date(T0 + 10 * 60_000));
    const tree = await changeFiles(h.repo, (await readCommit(h.repo, h.admitted)).tree, { [path]: render(revokedPolicy) });
    const revoked = await h.approve({ action: "policy", parents: [h.admitted], tree, summary: "Revoke Bo's key" });
    const after = await h.work(h.bo, revoked, { "b.md": "b\n" }, { at: T0 + 20 * 60_000 });
    const late = await verifyProposal(h.repo, revoked, after);
    expect(rule(late.commits[0], "R6")).toMatchObject({ ok: false });
    expect(rule(late.commits[0], "R5")).toMatchObject({ ok: true });
    const early = await verifyProposal(h.repo, revoked, before);
    expect(rule(early.commits[0], "R6")).toMatchObject({ ok: true });
    expect(early.ok).toBe(true);
    expect((await verifyHistory(h.repo, revoked)).ok).toBe(true);
  });
});

describe("merges only", () => {
  it("R7: under mergesOnly, a squash onto main fails, and merges and policy commits pass", async () => {
    const { POLICY_PATH: path, renderPolicy: render } = await import("../policy.ts");
    const h = await history();
    const strict = { ...h.policy, mergesOnly: true };
    const strictTree = await changeFiles(h.repo, (await readCommit(h.repo, h.admitted)).tree, { [path]: render(strict) });
    const base = await h.approve({ action: "policy", parents: [h.admitted], tree: strictTree, summary: "Merges only" });
    const work = await h.work(h.ada, base, { "a.md": "a\n" });
    // A squash: the work's tree on main with one parent, approved by the promoter.
    const squash = await h.approve({ action: "policy", parents: [base], tree: (await readCommit(h.repo, work)).tree, summary: "Squash" });
    const squashed = await verifyHistory(h.repo, squash);
    expect(rule(squashed.commits.at(-1), "R7")).toMatchObject({ ok: false });
    expect(squashed.ok).toBe(false);
    const merged = await verifyHistory(h.repo, await h.promote(base, work));
    expect(merged.ok, merged.summary).toBe(true);
    expect(rule(merged.commits.find((c) => c.oid === base), "R7")).toBeUndefined();
  });
});

describe("releases", () => {
  it("R8: a release tag needs approvals of that tag from as many promoters as the policy asks", async () => {
    const { approvalPayload: release, tagApproved } = await import("../make.ts");
    const { POLICY_PATH: path, renderPolicy: render } = await import("../policy.ts");
    const { testPromoter: promoter } = await import("./promoter.ts");
    const h = await history();
    const main = await readCommit(h.repo, h.admitted);
    const approve = async (by: typeof h.leo, name: string, target = main) => {
      const p = release({ repo: h.repoId, action: "release", parents: [target.oid], tree: target.tree, summary: `Release ${name}`, at: T0, ref: `refs/tags/${name}` });
      return by.approve(p.bytes);
    };
    const tagger = who("Leo", T0);
    // One promoter, the default: one approval releases.
    await tagApproved(h.repo, { name: "v1.0.0", target: main.oid, message: "Release v1.0.0", approvals: [await approve(h.leo, "v1.0.0")], tagger });
    let report = await verifyHistory(h.repo, h.admitted);
    expect(report.tags).toMatchObject([{ name: "v1.0.0", ok: true, approvedBy: ["leo"] }]);
    expect(report.ok).toBe(true);

    // The policy asks for two promoters: one approval no longer releases, two do.
    const ana = await promoter("ana");
    const two = { ...h.policy, promoters: [...h.policy.promoters, ana.entry], releaseApprovals: 2 };
    const tree = await changeFiles(h.repo, main.tree, { [path]: render(two) });
    const strict = await readCommit(h.repo, await h.approve({ action: "policy", parents: [h.admitted], tree, summary: "Two promoters for a release" }));
    await tagApproved(h.repo, { name: "v2.0.0", target: strict.oid, message: "Release v2.0.0", approvals: [await approve(h.leo, "v2.0.0", strict)], tagger });
    await tagApproved(h.repo, { name: "v2.0.1", target: strict.oid, message: "Release v2.0.1", approvals: [await approve(h.leo, "v2.0.1", strict), await approve(ana, "v2.0.1", strict)], tagger });
    // An approval made for another tag, and a tag of a commit that is not on main.
    await tagApproved(h.repo, { name: "v2.0.2", target: strict.oid, message: "Release v2.0.2", approvals: [await approve(h.leo, "v9", strict), await approve(ana, "v2.0.2", strict)], tagger });
    const side = await readCommit(h.repo, await h.work(h.ada, strict.oid, { "x.md": "x\n" }));
    await tagApproved(h.repo, { name: "v3.0.0", target: side.oid, message: "Release v3.0.0", approvals: [await approve(h.leo, "v3.0.0", side)], tagger });

    report = await verifyHistory(h.repo, strict.oid);
    const tag = (name: string) => report.tags.find((t) => t.name === name)!;
    expect(tag("v2.0.0").rules[0]).toMatchObject({ ok: false, reason: expect.stringContaining("1 of the 2") });
    expect(tag("v2.0.1")).toMatchObject({ ok: true, approvedBy: ["leo", "ana"] });
    expect(tag("v2.0.2").rules[0]?.reason).toContain("names a different release");
    expect(tag("v3.0.0").rules[0]?.reason).toContain("not a commit of main");
    expect(report.ok).toBe(false);
  });
});
