// The verifier. It reads only the repository: the policy in it, the
// signatures on its commits and the approvals in their messages. It needs no
// server, so it gives the same answer on any clone, on any host.
//
// R0  The first commit of main is the root of trust, and its id is the
//     repository id. It is an empty commit. A passkey signs it with an SSH
//     signature that git can check, and its committer is the fingerprint of
//     that passkey. (An older form: a commit that holds the policy. Its
//     approval verifies against the promoter key in that policy.)
// R1  Each later commit of main carries an approval from a promoter in the
//     policy of its first parent. The commit after an empty root sets the
//     first policy, and the passkey that signed the root approves it.
// R2  Only a commit of main with such an approval changes .repo/. A key that a
//     commit adds has no say over that commit, so a key never authorizes itself.
// R3  Each other commit that main reaches carries a valid SSH signature from
//     an author key or a promoter key. That key is in the policy of the first
//     parent of the merge that adds the commit to main.
// R4  An approval names this repository, the ref, the parents and the tree of
//     its own commit. Thus it cannot move to another change or repository.
// R5  An author key signs only inside its validity window.
// R6  An author key that a promoter revoked signs nothing after its revocation.
//     Its earlier work still verifies.
// R7  Where the policy says mergesOnly, a commit of main with one parent
//     changes only .repo/. Work reaches main as a merge of signed commits, so
//     no squash drops the authors' signatures.
// R8  An annotated tag names a commit of main. It carries approvals of that
//     tag, commit and tree from distinct promoters. The policy of that commit
//     sets how many (releaseApprovals, one when absent).
// M   A proposal merges into main with no conflicts.

import { approvalIn, approvalsIn, factsIn, MAIN_REF, verifyApproval, type ApprovalPayload } from "./approval.ts";
import {
  annotatedTags,
  firstParentChain,
  mergeTree,
  reachable,
  readCommit,
  readText,
  subjectOf,
  subtree,
  topEntries,
  type Commit,
  type Repo,
} from "./git.ts";
import { parsePolicy, POLICY_PATH, type Author, type Policy, type Promoter, type WebAuthnPromoter } from "./policy.ts";
import { fingerprint, publicKeyText, verify as verifySsh } from "./sshsig.ts";
import { blobFingerprint, skPublicKeyBlob, verifyWebauthn } from "./webauthn-sshsig.ts";

/** The tree of a commit with no files. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export type RuleId = "R0" | "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8" | "M";

export interface RuleResult {
  rule: RuleId;
  ok: boolean;
  reason: string;
}

export type CommitRole = "inception" | "main" | "merged" | "proposed";

export interface Signer {
  kind: "promoter" | "author" | "unknown";
  id: string | null;
  fingerprint?: string;
}

export interface CommitReport {
  oid: string;
  subject: string;
  role: CommitRole;
  parents: string[];
  /** Committer time, seconds since the epoch. */
  at: number;
  signer: Signer | null;
  /** The approval action, for a commit of main. */
  action?: ApprovalPayload["action"];
  rules: RuleResult[];
  ok: boolean;
}

/** What the verifier says about one release tag. */
export interface TagReport {
  name: string;
  oid: string;
  target: string;
  /** The promoters whose approvals verify. */
  approvedBy: string[];
  rules: RuleResult[];
  ok: boolean;
}

export interface HistoryReport {
  ok: boolean;
  /** The R8 result for each annotated tag. */
  tags: TagReport[];
  /** The id of the inception commit, or null if main has no valid root. */
  repoId: string | null;
  head: string;
  /** Oldest first. */
  commits: CommitReport[];
  summary: string;
}

export interface ProposalReport {
  ok: boolean;
  base: string;
  head: string;
  /** The commits the proposal adds, oldest first. */
  commits: CommitReport[];
  merge: RuleResult;
  /** The tree of the merge, when it merges. */
  mergedTree: string | null;
  summary: string;
}

const pass = (rule: RuleId, reason: string): RuleResult => ({ rule, ok: true, reason });
const fail = (rule: RuleId, reason: string): RuleResult => ({ rule, ok: false, reason });

const short = (oid: string) => oid.slice(0, 7);

type PolicyAt = { policy: Policy } | { error: string };

/** Reads the policy of each tree once, and keeps the result. */
class Policies {
  private readonly byTree = new Map<string, Promise<PolicyAt>>();
  private readonly repo: Repo;

  constructor(repo: Repo) {
    this.repo = repo;
  }

  at(commit: Commit): Promise<PolicyAt> {
    let found = this.byTree.get(commit.tree);
    if (!found) {
      found = (async () => {
        const text = await readText(this.repo, commit.tree, POLICY_PATH);
        if (text === null) return { error: `There is no ${POLICY_PATH}.` };
        try {
          return { policy: parsePolicy(text) };
        } catch (error) {
          return { error: `The policy does not parse: ${(error as Error).message}.` };
        }
      })();
      this.byTree.set(commit.tree, found);
    }
    return found;
  }
}

/** Whether a commit changes anything outside .repo/ compared with its first parent. */
async function changesWork(repo: Repo, commit: Commit, parent: Commit): Promise<boolean> {
  const [a, b] = [await topEntries(repo, parent.tree), await topEntries(repo, commit.tree)];
  a.delete(".repo");
  b.delete(".repo");
  return a.size !== b.size || [...a].some(([path, oid]) => b.get(path) !== oid);
}

/** Whether a commit changes .repo/ compared with its first parent. */
async function changesPolicy(repo: Repo, commit: Commit, parent: Commit | null): Promise<boolean> {
  const after = await subtree(repo, commit.tree, ".repo");
  const before = parent ? await subtree(repo, parent.tree, ".repo") : null;
  return after !== before;
}

async function parentOf(repo: Repo, commit: Commit): Promise<Commit | null> {
  const oid = commit.parents[0];
  return oid ? readCommit(repo, oid) : null;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Who signed a commit with an SSH signature, by the policy, and whether the signature verifies. */
async function sshSigner(commit: Commit, policy: Policy): Promise<{ signer: Signer | null; key: Author | Promoter | null; reason: string }> {
  if (!commit.signature) return { signer: null, key: null, reason: "The commit is not signed." };
  const verified = await verifySsh(commit.signature, commit.payload);
  if (!verified) return { signer: null, key: null, reason: "The signature does not verify." };
  const text = publicKeyText(verified.publicKey);
  const fp = await fingerprint(verified.publicKey);
  const author = policy.authors.find((a) => a.publicKey.trim() === text);
  if (author) return { signer: { kind: "author", id: author.id, fingerprint: fp }, key: author, reason: "" };
  const promoter = policy.promoters.find((p) => p.kind === "ssh-ed25519" && p.publicKey.trim() === text);
  if (promoter) return { signer: { kind: "promoter", id: promoter.id, fingerprint: fp }, key: promoter, reason: "" };
  return {
    signer: { kind: "unknown", id: null, fingerprint: fp },
    key: null,
    reason: `Signed by ${fp}, a key the policy does not list.`,
  };
}

/** R3, R5, R6 and R2 for a commit that is not on the first-parent chain of main. */
async function checkWork(repo: Repo, commit: Commit, policy: Policy, role: CommitRole): Promise<CommitReport> {
  const rules: RuleResult[] = [];
  const { signer, key, reason } = await sshSigner(commit, policy);
  if (key) rules.push(pass("R3", `Signed by ${signer!.kind} ${key.id} (${signer!.fingerprint}).`));
  else rules.push(fail("R3", reason));

  if (key && "validAfter" in key) {
    const at = commit.committer.timestamp * 1000;
    if (at < Date.parse(key.validAfter) || at > Date.parse(key.validBefore)) {
      rules.push(fail("R5", `Committed at ${new Date(at).toISOString()}, outside the window of key ${key.id}.`));
    } else {
      rules.push(pass("R5", `Committed inside the window of key ${key.id}, which ends ${key.validBefore}.`));
    }
    if (key.revokedAt) {
      if (at > Date.parse(key.revokedAt)) rules.push(fail("R6", `Committed at ${new Date(at).toISOString()}, after a promoter revoked key ${key.id} at ${key.revokedAt}.`));
      else rules.push(pass("R6", `Committed before a promoter revoked key ${key.id} at ${key.revokedAt}.`));
    }
  }

  if (await changesPolicy(repo, commit, await parentOf(repo, commit))) {
    const by = signer?.kind === "author" ? `author key ${signer.id}` : "a key that is not a promoter approval";
    rules.push(
      fail(
        "R2",
        `This commit changes the policy, and it is signed by ${by}. Only a promoter approval on main changes the policy, so a key can never authorize itself.`,
      ),
    );
  } else {
    rules.push(pass("R2", "Leaves the policy unchanged."));
  }
  return {
    oid: commit.oid,
    subject: subjectOf(commit),
    role,
    parents: commit.parents,
    at: commit.committer.timestamp,
    signer,
    rules,
    ok: rules.every((r) => r.ok),
  };
}

/** The passkey that signed an empty root commit, as R0 checks it. */
interface InceptionKey {
  fingerprint: string;
  rpId: string;
  origin: string;
}

type InceptionCheck = { ok: true; key: InceptionKey } | { ok: false; reason: string };

/** R0 for an empty root: a passkey signed it, and its committer is that passkey's fingerprint. */
async function passkeyInception(commit: Commit): Promise<InceptionCheck> {
  if (!commit.signature) return { ok: false, reason: "The inception commit is not signed." };
  const check = await verifyWebauthn(commit.signature, commit.payload);
  if (!check.ok) return { ok: false, reason: check.reason };
  if (commit.committer.name !== check.fingerprint) {
    return { ok: false, reason: `The committer is ${commit.committer.name}, not ${check.fingerprint}, the passkey that signed the commit.` };
  }
  return { ok: true, key: { fingerprint: check.fingerprint, rpId: check.rpId, origin: check.origin } };
}

/**
 * The policy that governs the commit after an empty root: its own policy,
 * with only the promoter whose passkey signed the root. That passkey alone
 * chooses the first rules.
 */
async function firstPolicy(policies: Policies, commit: Commit, key: InceptionKey): Promise<PolicyAt> {
  const own = await policies.at(commit);
  if ("error" in own) return own;
  const { policy } = own;
  if (policy.webauthn.rpId !== key.rpId || policy.webauthn.origin !== key.origin) {
    return { error: `The first policy names ${policy.webauthn.origin}, but the inception passkey signed at ${key.origin}.` };
  }
  for (const p of policy.promoters) {
    if (p.kind !== "webauthn" || p.alg !== -7) continue;
    if ((await blobFingerprint(skPublicKeyBlob(p.publicKey, key.rpId))) === key.fingerprint) {
      return { policy: { version: 1, webauthn: policy.webauthn, promoters: [p], authors: [] } };
    }
  }
  return { error: `The first policy lists no promoter with the inception passkey ${key.fingerprint}.` };
}

type MainApproval = { ok: true; promoter: WebAuthnPromoter; payload: ApprovalPayload; signed: boolean } | { ok: false; reason: string; payload?: ApprovalPayload };

/**
 * Check a commit of main that the passkey of a promoter signs as a whole. Its
 * SSH signature must verify, and the key must be a P-256 passkey promoter of
 * the policy. The relying party and the origin must be those of the policy.
 * The trailer must hold the payload, which the signature covers.
 */
export async function passkeyApproval(commit: Commit, policy: Policy): Promise<MainApproval> {
  const facts = factsIn(commit.message);
  const payload = facts?.payload;
  if (!commit.signature || !facts) return { ok: false, reason: "The commit is not signed by a passkey.", ...(payload ? { payload } : {}) };
  const check = await verifyWebauthn(commit.signature, commit.payload);
  if (!check.ok) return { ok: false, reason: check.reason, payload: facts.payload };
  if (check.rpId !== policy.webauthn.rpId) return { ok: false, reason: `The passkey signed for ${check.rpId}, not ${policy.webauthn.rpId}.`, payload: facts.payload };
  if (check.origin !== policy.webauthn.origin) return { ok: false, reason: `The passkey signed at ${check.origin}, not ${policy.webauthn.origin}.`, payload: facts.payload };
  for (const p of policy.promoters) {
    if (p.kind !== "webauthn" || p.alg !== -7) continue;
    if ((await blobFingerprint(skPublicKeyBlob(p.publicKey, policy.webauthn.rpId))) === check.fingerprint) {
      return { ok: true, promoter: p, payload: facts.payload, signed: true };
    }
  }
  return { ok: false, reason: `Signed by the passkey ${check.fingerprint}, which the policy does not list as a promoter.`, payload: facts.payload };
}

/** The approval of a commit of main: its passkey signature, or an approval in its trailer. Null when it has neither. */
async function mainApproval(commit: Commit, policy: Policy): Promise<MainApproval | null> {
  if (commit.signature && factsIn(commit.message)) return passkeyApproval(commit, policy);
  const approval = approvalIn(commit.message);
  if (!approval) return null;
  const check = await verifyApproval(approval, policy);
  return check.ok ? { ...check, signed: false } : check;
}

/** R0, or R1, R4, R7 and R2, for a commit on the first-parent chain of main. */
async function checkMain(
  repo: Repo,
  policies: Policies,
  commit: Commit,
  parent: Commit | null,
  repoId: string | null,
  inception: InceptionKey | null = null,
): Promise<CommitReport> {
  const rules: RuleResult[] = [];
  const approval = approvalIn(commit.message);
  // The commit after an empty root sets the first policy, under the passkey that signed the root.
  const establishing = parent !== null && inception !== null && parent.parents.length === 0;
  const governing = establishing ? await firstPolicy(policies, commit, inception) : await policies.at(parent ?? commit);
  let signer: Signer | null = null;
  let action: ApprovalPayload["action"] | undefined;

  if (!parent && commit.parents.length === 0 && commit.tree === EMPTY_TREE) {
    const check = await passkeyInception(commit);
    if (!check.ok) rules.push(fail("R0", check.reason));
    else {
      signer = { kind: "promoter", id: null, fingerprint: check.key.fingerprint };
      rules.push(pass("R0", `Root of trust: an empty commit signed by the passkey ${check.key.fingerprint}, which its committer names. Repository id ${short(commit.oid)}.`));
    }
  } else if (!parent) {
    // The older root: its own policy governs it.
    if (commit.parents.length > 0) rules.push(fail("R0", "The first-parent chain of main does not end at a root commit."));
    else if ("error" in governing) rules.push(fail("R0", governing.error));
    else if (!approval) rules.push(fail("R0", "The first commit carries no inception approval."));
    else {
      const check = await verifyApproval(approval, governing.policy);
      if (!check.ok) rules.push(fail("R0", check.reason));
      else {
        const p = check.payload;
        signer = { kind: "promoter", id: check.promoter.id };
        action = p.action;
        if (p.action !== "incept" || p.repo !== null || p.parents.length !== 0 || p.tree !== commit.tree || p.ref !== MAIN_REF) {
          rules.push(fail("R0", "The inception approval names a different change."));
        } else {
          rules.push(pass("R0", `Root of trust, approved by promoter ${check.promoter.id} under its own policy. Repository id ${short(commit.oid)}.`));
        }
      }
    }
  } else if ("error" in governing) {
    rules.push(fail("R1", establishing ? governing.error : `The policy of the first parent is not usable. ${governing.error}`));
  } else {
    const check = await mainApproval(commit, governing.policy);
    if (!check) {
      rules.push(fail("R1", "Main moved without an approval from a promoter."));
      rules.push(fail("R4", "There is no approval to match against this commit."));
    } else if (!check.ok) rules.push(fail("R1", check.reason));
    else {
      signer = { kind: "promoter", id: check.promoter.id };
      const how = check.signed ? `signed as a whole by the passkey of promoter ${check.promoter.id}` : `approved by promoter ${check.promoter.id}`;
      rules.push(
        pass(
          "R1",
          establishing
            ? `Sets the first policy, ${how}, the passkey that signed the inception commit.`
            : `${how[0]!.toUpperCase()}${how.slice(1)}, under the policy of ${short(parent.oid)}.`,
        ),
      );
    }
    const p = check?.payload;
    if (!check) {
      // R1 and R4 failed above: there is no approval.
    } else if (!p) rules.push(fail("R4", "The approval payload does not decode."));
    else {
      action = p.action;
      const wrong: string[] = [];
      if (p.repo !== repoId) wrong.push("repository");
      if (p.ref !== MAIN_REF) wrong.push("ref");
      if (!sameList(p.parents, commit.parents)) wrong.push("parents");
      if (p.tree !== commit.tree) wrong.push("tree");
      if ((p.action === "incept") !== establishing || (!establishing && (p.action === "promote") !== commit.parents.length > 1)) wrong.push("action");
      if (wrong.length > 0) rules.push(fail("R4", `The approval names a different ${wrong.join(", ")}.`));
      else rules.push(pass("R4", "The approval names this repository, these parents and this tree."));
    }
  }

  if (parent && commit.parents.length === 1 && "policy" in governing && governing.policy.mergesOnly) {
    if (await changesWork(repo, commit, parent)) {
      rules.push(fail("R7", "This commit of main changes work outside .repo/ without a merge. Under mergesOnly, work reaches main only as a merge of signed commits."));
    } else {
      rules.push(pass("R7", "Changes only .repo/, as mergesOnly asks of a commit with one parent."));
    }
  }

  if (parent) {
    if (await changesPolicy(repo, commit, parent)) {
      const now = await policies.at(commit);
      const approved = rules.every((r) => r.ok);
      if ("error" in now) rules.push(fail("R2", now.error));
      else if (approved) rules.push(pass("R2", "Changes the policy, with a promoter approval."));
      else rules.push(fail("R2", "Changes the policy without a valid promoter approval."));
    } else {
      rules.push(pass("R2", "Leaves the policy unchanged."));
    }
  }

  return {
    oid: commit.oid,
    subject: subjectOf(commit),
    role: parent ? "main" : "inception",
    parents: commit.parents,
    at: commit.committer.timestamp,
    signer,
    ...(action ? { action } : {}),
    rules,
    ok: rules.every((r) => r.ok),
  };
}

/**
 * Verify all of main: the first-parent chain from `head` to the root, and
 * every commit that a merge on that chain adds to main. Also verify each
 * annotated tag (R8).
 */
export async function verifyHistory(repo: Repo, head: string, options: { repoId?: string } = {}): Promise<HistoryReport> {
  const policies = new Policies(repo);
  const chain = (await firstParentChain(repo, head)).reverse();
  const root = chain[0]!;
  const repoId = root.oid;
  const commits: CommitReport[] = [];

  const rootReport = await checkMain(repo, policies, root, null, null);
  const rootInception = root.tree === EMPTY_TREE && root.parents.length === 0 ? await passkeyInception(root) : null;
  const inception = rootInception?.ok ? rootInception.key : null;
  if (options.repoId && options.repoId !== repoId) {
    rootReport.rules.push(fail("R0", `The root is ${short(repoId)}, not the expected repository ${short(options.repoId)}.`));
    rootReport.ok = false;
  }
  commits.push(rootReport);

  const known = new Set<string>([root.oid]);
  for (let i = 1; i < chain.length; i++) {
    const commit = chain[i]!;
    const parent = chain[i - 1]!;
    const governing = await policies.at(parent);
    // A merge adds to main the commits of its other parents that main did not reach before.
    for (const other of commit.parents.slice(1)) {
      const brought = (await reachable(repo, other, known)).reverse();
      for (const c of brought) {
        known.add(c.oid);
        if ("error" in governing) {
          commits.push({
            oid: c.oid,
            subject: subjectOf(c),
            role: "merged",
            parents: c.parents,
            at: c.committer.timestamp,
            signer: null,
            rules: [fail("R3", governing.error)],
            ok: false,
          });
        } else {
          commits.push(await checkWork(repo, c, governing.policy, "merged"));
        }
      }
    }
    commits.push(await checkMain(repo, policies, commit, parent, repoId, inception));
    known.add(commit.oid);
    for (const c of await reachable(repo, commit.oid, known)) known.add(c.oid);
  }

  const failed = commits.filter((c) => !c.ok);
  const rootOk = rootReport.ok;
  const tags = await verifyTags(repo, policies, new Set(chain.map((c) => c.oid)), repoId);
  const badTags = tags.filter((t) => !t.ok);
  const tagNote = tags.length === 0 ? "" : badTags.length === 0 ? ` ${tags.length === 1 ? "Its release verifies" : `All ${tags.length} releases verify`} too.` : ` ${badTags.length} of ${tags.length} releases fail: ${badTags.map((t) => t.name).join(", ")}.`;
  return {
    ok: failed.length === 0 && badTags.length === 0,
    tags,
    repoId: rootOk ? repoId : null,
    head,
    commits,
    summary:
      (failed.length === 0
        ? `All ${commits.length} commits verify against the policy, from the root ${short(repoId)} to ${short(head)}.`
        : `${failed.length} of ${commits.length} commits fail: ${failed.map((c) => short(c.oid)).join(", ")}.`) + tagNote,
  };
}

/** R8 for each annotated tag of the repository. */
async function verifyTags(repo: Repo, policies: Policies, mainChain: ReadonlySet<string>, repoId: string): Promise<TagReport[]> {
  const out: TagReport[] = [];
  for (const tag of await annotatedTags(repo)) {
    const rules: RuleResult[] = [];
    const approvedBy = new Set<string>();
    if (!mainChain.has(tag.target)) {
      rules.push(fail("R8", `The tag names ${short(tag.target)}, which is not a commit of main.`));
    } else {
      const target = await readCommit(repo, tag.target);
      const governing = await policies.at(target);
      if ("error" in governing) rules.push(fail("R8", governing.error));
      else {
        const need = governing.policy.releaseApprovals ?? 1;
        const problems: string[] = [];
        for (const approval of approvalsIn(tag.message)) {
          const check = await verifyApproval(approval, governing.policy);
          if (!check.ok) {
            problems.push(check.reason);
            continue;
          }
          const p = check.payload;
          if (p.action !== "release" || p.repo !== repoId || p.ref !== `refs/tags/${tag.name}` || !sameList(p.parents, [tag.target]) || p.tree !== target.tree) {
            problems.push(`The approval by ${check.promoter.id} names a different release.`);
            continue;
          }
          approvedBy.add(check.promoter.id);
        }
        if (approvedBy.size >= need) {
          rules.push(pass("R8", `Released by ${[...approvedBy].join(" and ")}; the policy asks for ${need} ${need === 1 ? "promoter" : "promoters"}.`));
        } else {
          rules.push(fail("R8", `${approvedBy.size} of the ${need} promoter approvals the policy asks for.${problems.length ? ` ${problems[0]}` : ""}`));
        }
      }
    }
    out.push({ name: tag.name, oid: tag.oid, target: tag.target, approvedBy: [...approvedBy], rules, ok: rules.every((r) => r.ok) });
  }
  return out;
}

/** Verify a proposal: the commits `head` adds to main at `base`, checked against the policy of `base`, and the merge. */
export async function verifyProposal(repo: Repo, base: string, head: string): Promise<ProposalReport> {
  const policies = new Policies(repo);
  const governing = await policies.at(await readCommit(repo, base));
  const onMain = new Set((await reachable(repo, base)).map((c) => c.oid));
  const added = (await reachable(repo, head, onMain)).reverse();
  const commits: CommitReport[] = [];
  for (const c of added) {
    if ("error" in governing) {
      commits.push({ oid: c.oid, subject: subjectOf(c), role: "proposed", parents: c.parents, at: c.committer.timestamp, signer: null, rules: [fail("R3", governing.error)], ok: false });
    } else {
      commits.push(await checkWork(repo, c, governing.policy, "proposed"));
    }
  }

  let merge: RuleResult;
  let mergedTree: string | null = null;
  if (added.length === 0) merge = fail("M", "The proposal adds nothing to main.");
  else if (!added.some((c) => c.parents.some((p) => onMain.has(p)))) merge = fail("M", "The proposal shares no history with main.");
  else {
    const outcome = await mergeTree(repo, base, head);
    if (outcome.ok) {
      mergedTree = outcome.tree;
      merge = pass("M", `Merges into main at ${short(base)} with no conflicts.`);
    } else {
      merge = fail("M", `Conflicts with main in ${outcome.conflicts.join(", ")}.`);
    }
  }
  const failed = commits.filter((c) => !c.ok);
  const ok = failed.length === 0 && merge.ok;
  return {
    ok,
    base,
    head,
    commits,
    merge,
    mergedTree,
    summary: ok
      ? `${commits.length} signed ${commits.length === 1 ? "commit" : "commits"}, ready to promote.`
      : failed.length > 0
        ? `Rejected: ${failed[0]!.rules.find((r) => !r.ok)!.reason}`
        : `Rejected: ${merge.reason}`,
  };
}
