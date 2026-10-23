import { DurableObject } from "cloudflare:workers";
import http from "isomorphic-git/http/web";
import {
  approvalFrom,
  approvalRequestOptions,
  encodePayload,
  verifyApproval,
  approvalIn,
  type Approval,
  type ApprovalPayload,
} from "../authority/approval.ts";
import { fromBase64Url, fromUtf8, toBase64Url } from "../authority/bytes.ts";
import { factsIn } from "../authority/approval.ts";
import {
  changeFiles,
  diffTrees,
  memoryRepo,
  readCommit,
  readText,
  listFiles,
  readBlobText,
  pushHttp,
  resolve,
  setRef,
  writeFiles,
  type Change,
  type Identity,
} from "../authority/git.ts";
import { approvalPayload, commitInception, commitPasskeySigned, inceptionPayload, passkeyCommitPayload, tagApproved, withAuthors, type InceptionInput } from "../authority/make.ts";
import { parsePolicy, POLICY_PATH, withRevoked, type Author, type Policy, type WebAuthnPromoter } from "../authority/policy.ts";
import { diffLines, type FileDiff } from "../authority/diff.ts";
import { approvalEnvelopes } from "../authority/envelope.ts";
import { EMPTY_TREE, passkeyApproval, verifyHistory, verifyProposal, type HistoryReport, type ProposalReport, type CommitReport } from "../authority/verify.ts";
import { blobFingerprint, skPublicKeyBlob, sshChallenge, webauthnAssertion, webauthnSignature } from "../authority/webauthn-sshsig.ts";
import type { AgentIdentity } from "./agent-run.ts";
import { repoHost, type MemRepo, type RepoHost, type Transport } from "./repo-host.ts";
import type {
  AgentState,
  ApprovalRequest,
  CommitDetail,
  MirrorState,
  PushAccess,
  FreshVerify,
  Outside,
  ProjectEvent,
  ProjectState,
  ProjectSummary,
  PromoterKey,
  ProposalState,
  ProposalStatus,
  Refusal,
} from "./state.ts";
import { repoIndex } from "./repo-index.ts";
import { subscribePushes, unsubscribe } from "./subscriptions.ts";
import { noteClient } from "./llm.ts";
import { firstTask, GIVEN_TASKS, PERMANENT_KEY, taskById } from "./tasks.ts";
import { inceptionMessage, policyFiles, rootMessage, templateFiles } from "./template.ts";
import { verifier } from "./verifier.ts";
import { fingerprint, parsePublicKeyText, publicKeyText } from "../authority/sshsig.ts";

// One project: its repository, its agents, their proposals, and the
// approvals that move main. The platform writes main only here, and only with
// an approval that verifies against the policy of the current head of main.
// The platform is a convenience: the repository itself says which commits are
// valid, and any clone can check that with the same verifier.

export type Result<T> = { ok: true; value: T } | ({ ok: false; status: number } & Refusal);

const refuse = (status: number, error: string, reason: string): { ok: false; status: number } & Refusal => ({
  ok: false,
  status,
  error,
  reason,
});

const APPROVAL_LIFETIME_MS = 5 * 60_000;
/** How long a person's laptop key may sign work. */
const PERSON_KEY_MS = 8 * 3600_000;
const AGENT_NAME = /^[A-Za-z][A-Za-z0-9 ._-]{0,23}$/;

interface ProjectRow {
  id: string;
  name: string;
  owner: string;
  createdAt: number;
  repoName: string;
  promoter: PromoterKey;
  rp: { rpId: string; origin: string };
  repoId: string | null;
  mainHead: string | null;
}

/** `sign` is the SSH signature of the passkey on the empty inception commit. `release` is an approval in the message of a tag. The others are commits of main that the passkey signs as a whole. */
type ApprovalKind = "sign" | "incept" | "admit" | "revoke" | "promote" | "release";

type AgentRow = {
  id: string;
  /** An agent works in its AgentRun; a person works from a laptop with git. */
  kind: "agent" | "person";
  name: string;
  fork: string;
  public_key: string;
  fingerprint: string;
  valid_after: string;
  valid_before: string;
};

type ProposalRow = {
  id: string;
  agent_id: string;
  task_seq: number;
  task_id: string;
  title: string;
  branch: string;
  head: string;
  base: string;
  status: ProposalStatus;
  report: string | null;
  promoted_as: string | null;
  created_at: number;
  updated_at: number;
  detail: string | null;
  redone_at: number | null;
};

interface Workspace {
  repo: MemRepo;
  transport: Transport;
  main: string;
}

/** A form of `name` that Artifacts accepts in a repository name. */
function slug(name: string): string {
  return (
    name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "project"
  );
}

function promoterEntry(key: PromoterKey): WebAuthnPromoter {
  return {
    id: key.id,
    kind: "webauthn",
    credentialId: key.credentialId,
    alg: key.alg,
    publicKey: key.publicKey,
    ...(key.label ? { label: key.label } : {}),
    since: new Date(key.capturedAt).toISOString(),
  };
}

/** A change of main as the passkey signed it: the payload and message of the commit, and the browser's assertion. */
interface Signed {
  payload: ApprovalPayload;
  message: string;
  response: { response: { authenticatorData: string; clientDataJSON: string; signature: string } };
}

function admitMessage(names: string): string {
  return `Admit author keys for ${names}\n\nEach key may sign work in its own fork until its window ends.\nIt may not approve, and it may not change .repo/.\n`;
}

function assertionShape(value: unknown): value is { id: string; response: { authenticatorData: string; clientDataJSON: string; signature: string } } {
  const v = value as any;
  return (
    typeof v?.id === "string" &&
    typeof v?.response?.authenticatorData === "string" &&
    typeof v?.response?.clientDataJSON === "string" &&
    typeof v?.response?.signature === "string"
  );
}

export class Project extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.schema();
  }

  /** Create the tables. It runs again after deleteAll, which drops them while this instance stays in memory. */
  private schema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS project (id INTEGER PRIMARY KEY CHECK (id = 0), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, fork TEXT NOT NULL, public_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL, valid_after TEXT NOT NULL, valid_before TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, task_seq INTEGER NOT NULL, task_id TEXT NOT NULL,
        title TEXT NOT NULL, branch TEXT NOT NULL, head TEXT NOT NULL, base TEXT NOT NULL, status TEXT NOT NULL, report TEXT,
        promoted_as TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, detail TEXT, redone_at INTEGER);
      CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, data TEXT NOT NULL,
        created_at INTEGER NOT NULL, used_at INTEGER);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS version (id INTEGER PRIMARY KEY CHECK (id = 0), n INTEGER NOT NULL);
    `);
    // Projects made before these columns existed get them here.
    const columns = this.sql.exec<{ name: string }>("PRAGMA table_info(proposals)").toArray().map((c) => c.name);
    if (!columns.includes("detail")) this.sql.exec("ALTER TABLE proposals ADD COLUMN detail TEXT");
    if (!columns.includes("redone_at")) this.sql.exec("ALTER TABLE proposals ADD COLUMN redone_at INTEGER");
    const agentColumns = this.sql.exec<{ name: string }>("PRAGMA table_info(agents)").toArray().map((c) => c.name);
    if (!agentColumns.includes("kind")) this.sql.exec("ALTER TABLE agents ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent'");
  }

  // --- storage ---------------------------------------------------------------------

  private project(): ProjectRow | null {
    const row = this.sql.exec<{ data: string }>("SELECT data FROM project").toArray()[0];
    return row ? (JSON.parse(row.data) as ProjectRow) : null;
  }

  private saveProject(row: ProjectRow): void {
    this.sql.exec("INSERT OR REPLACE INTO project (id, data) VALUES (0, ?)", JSON.stringify(row));
    this.touch();
  }

  /** Count one change of what `state` shows. Agents call it too, for each step they take. */
  touch(): void {
    this.sql.exec("INSERT INTO version (id, n) VALUES (0, 1) ON CONFLICT (id) DO UPDATE SET n = n + 1");
  }

  /** The number of changes until now. The state route uses it as an ETag. The stream route uses it to know when to send the state. */
  version(): number {
    return this.sql.exec<{ n: number }>("SELECT n FROM version").toArray()[0]?.n ?? 0;
  }

  private cached<T>(key: string): T | null {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM cache WHERE key = ?", key).toArray()[0];
    return row ? (JSON.parse(row.value) as T) : null;
  }

  private cache(key: string, value: unknown): void {
    this.sql.exec("INSERT OR REPLACE INTO cache (key, value) VALUES (?, ?)", key, JSON.stringify(value));
    this.touch();
  }

  private event(kind: ProjectEvent["kind"], text: string): void {
    this.sql.exec("INSERT INTO events (at, kind, text) VALUES (?, ?, ?)", Date.now(), kind, text);
    this.touch();
  }

  private agents(): AgentRow[] {
    return this.sql.exec<AgentRow>("SELECT * FROM agents ORDER BY rowid").toArray();
  }

  private proposal(id: string): ProposalRow | null {
    return this.sql.exec<ProposalRow>("SELECT * FROM proposals WHERE id = ?", id).toArray()[0] ?? null;
  }

  /** Run `fn` after every earlier exclusive call ends, so that two writes of main never occur at the same time. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private host(): RepoHost {
    return repoHost(this.env);
  }

  private run(agentId: string) {
    const project = this.project()!;
    return this.env.AGENT_RUNS.get(this.env.AGENT_RUNS.idFromName(`${project.id}/${agentId}`));
  }

  /** A fresh in-memory clone of the project repository. */
  private async workspace(scope: "read" | "write"): Promise<Workspace> {
    const project = this.project()!;
    const host = this.host();
    const repo = await memoryRepo();
    const transport = await host.transport(project.repoName, await host.token(project.repoName, scope, 120));
    await transport.clone(repo);
    const main = await resolve(repo, "refs/heads/main");
    if (!main) throw new Error("the project repository has no main");
    if (project.mainHead && main !== project.mainHead) {
      this.event("refusal", `Main is at ${main.slice(0, 7)}, which the forge did not write. The verifier decides whether it is valid.`);
      this.saveProject({ ...project, mainHead: main });
    }
    return { repo, transport, main };
  }

  private async policyAt(repo: MemRepo, commit: string): Promise<Policy> {
    const text = await readText(repo, (await readCommit(repo, commit)).tree, POLICY_PATH);
    if (text === null) throw new Error("main has no policy");
    return parsePolicy(text);
  }

  private promoterIdentity(now: number): Identity {
    const project = this.project()!;
    return { name: project.promoter.id, email: "promoter@forge.invalid", timestamp: Math.floor(now / 1000), timezoneOffset: 0 };
  }

  // --- creation ---------------------------------------------------------------------

  /** Record a new project. Refuses if this object already holds one. */
  create(input: { id: string; name: string; owner: string; promoter: PromoterKey; rp: { rpId: string; origin: string } }): boolean {
    if (this.project()) return false;
    this.saveProject({
      ...input,
      createdAt: Date.now(),
      repoName: `${slug(input.name)}-${input.id.slice(0, 8)}`,
      repoId: null,
      mainHead: null,
    });
    this.event("project", `Project ${input.name} prepared. Its root of trust is the passkey of ${input.promoter.id}.`);
    return true;
  }

  owner(): string | null {
    return this.project()?.owner ?? null;
  }

  /** What an operator sees of the project: its name, owner, repository, and whether the host still has it. Null once reset. */
  async summary(): Promise<ProjectSummary | null> {
    const project = this.project();
    if (!project) return null;
    const { id, name, owner, createdAt, repoName } = project;
    return { id, name, owner, createdAt, repoName, missing: project.repoId ? (await this.remote(project)) === null : false };
  }

  /** The repository's remote, or null when its host no longer has it. */
  private async remote(project: ProjectRow): Promise<string | null> {
    try {
      return await this.host().remote(project.repoName);
    } catch {
      return null;
    }
  }

  // --- approvals ----------------------------------------------------------------------

  private async request(
    kind: ApprovalKind,
    payload: ApprovalPayload,
    promoters: WebAuthnPromoter[],
    data: unknown,
    changes: Change[],
    challenge?: string,
  ): Promise<ApprovalRequest> {
    const project = this.project()!;
    const bytes = encodePayload(payload);
    const id = crypto.randomUUID();
    this.sql.exec(
      "INSERT INTO approvals (id, kind, payload, data, created_at) VALUES (?, ?, ?, ?, ?)",
      id,
      kind,
      toBase64Url(bytes),
      JSON.stringify(data),
      Date.now(),
    );
    const options = await approvalRequestOptions(bytes, promoters[0]!, project.rp.rpId);
    // A change of main is a commit the passkey signs as a whole: the challenge is that commit's SSHSIG data.
    const message = (data as { message?: string }).message;
    if (challenge) options.challenge = challenge;
    else if (message !== undefined) {
      options.challenge = await sshChallenge(await passkeyCommitPayload({ payload, message, committer: this.promoterIdentity(payload.at) }));
    }
    options.allowCredentials = promoters.map((p) => ({ id: p.credentialId, type: "public-key" as const }));
    return { approvalId: id, projectId: project.id, payload, options, changes, summary: payload.summary, ...(message !== undefined ? { message } : {}) };
  }

  /** The empty inception commit of a project: its author is the promoter, its committer the passkey's SSH fingerprint. */
  private async inceptionInput(project: ProjectRow, at: number): Promise<InceptionInput> {
    const fingerprint = await blobFingerprint(skPublicKeyBlob(project.promoter.publicKey, project.rp.rpId));
    const identity = this.promoterIdentity(at);
    return { author: identity, committer: { ...identity, name: fingerprint }, message: rootMessage(project.name, project.promoter.id, fingerprint) };
  }

  /**
   * Request the next step of the inception of a project. First, the passkey
   * signs an empty inception commit with an SSH signature. The id of that
   * commit becomes the repository id. Then, the passkey approves the first
   * policy commit: the template, with a policy that names that passkey as the
   * only promoter.
   */
  async prepareInception(): Promise<Result<ApprovalRequest>> {
    const project = this.project();
    if (!project) return refuse(404, "no-project", "There is no such project.");
    if (project.repoId && project.mainHead !== project.repoId) return refuse(409, "exists", "This project already has its inception commit.");
    if (project.promoter.alg !== -7) {
      return refuse(400, "passkey-algorithm", "Your promoter passkey uses EdDSA. A Git signature from a passkey needs a P-256 (ES256) passkey.");
    }
    if (!project.repoId) {
      const at = Date.now();
      const input = await this.inceptionInput(project, at);
      const { payload } = approvalPayload({
        repo: null,
        action: "incept",
        parents: [],
        tree: EMPTY_TREE,
        summary: `Sign the inception commit of ${project.name}: its id becomes the repository id`,
        at,
      });
      const challenge = await sshChallenge(await inceptionPayload(input));
      return { ok: true, value: await this.request("sign", payload, [promoterEntry(project.promoter)], { at }, [], challenge) };
    }
    const policy: Policy = {
      version: 1,
      webauthn: project.rp,
      promoters: [promoterEntry(project.promoter)],
      authors: [],
      mergesOnly: true,
    };
    const repo = await memoryRepo();
    const files = templateFiles(project.name, policy, await verifier(this.env), project.repoName);
    const tree = await writeFiles(repo, files);
    const { payload } = approvalPayload({
      repo: project.repoId,
      action: "incept",
      parents: [project.repoId],
      tree,
      summary: `Set the first policy of ${project.name}, with ${project.promoter.id} as its only promoter`,
      at: Date.now(),
    });
    const changes = Object.keys(files)
      .sort()
      .map((path): Change => ({ path, change: "added" }));
    return { ok: true, value: await this.request("incept", payload, policy.promoters as WebAuthnPromoter[], { policy, message: inceptionMessage(project.name) }, changes) };
  }

  /** Request an approval that admits author keys for new agents. */
  async prepareAdmission(names: string[]): Promise<Result<ApprovalRequest>> {
    const project = this.project();
    if (!project?.repoId) return refuse(409, "no-repository", "Create the project first.");
    if (project.mainHead === project.repoId) return refuse(409, "no-policy", "Approve the first policy first.");
    if (names.length === 0 || names.length > 4 || !names.every((n) => AGENT_NAME.test(n))) {
      return refuse(400, "bad-agents", "Name one to four agents, each a short name that starts with a letter.");
    }
    const ids = names.map((n) => slug(n));
    if (new Set(ids).size !== ids.length) return refuse(400, "bad-agents", "Give each agent a different name.");
    const known = new Set(this.agents().map((a) => a.id));
    const again = ids.find((id) => known.has(id));
    if (again) return refuse(409, "agent-exists", `An agent called ${again} is already admitted.`);

    const ws = await this.workspace("read");
    const policy = await this.policyAt(ws.repo, ws.main);
    const now = Date.now();
    const ttl = Number(this.env.AGENT_KEY_TTL_S ?? 3600) * 1000;
    const authors: Author[] = [];
    const agents: { id: string; name: string; fork: string }[] = [];
    for (const [i, id] of ids.entries()) {
      const identity: AgentIdentity = {
        projectId: project.id,
        agentId: id,
        name: names[i]!,
        controller: project.promoter.id,
        validAfter: new Date(now - 60_000).toISOString(),
        validBefore: new Date(now + ttl).toISOString(),
      };
      const run = this.env.AGENT_RUNS.get(this.env.AGENT_RUNS.idFromName(`${project.id}/${id}`));
      const key = await run.init(identity);
      authors.push({
        id,
        kind: "ssh-ed25519",
        publicKey: key.publicKey,
        fingerprint: key.fingerprint,
        controller: project.promoter.id,
        validAfter: identity.validAfter,
        validBefore: identity.validBefore,
      });
      agents.push({ id, name: names[i]!, fork: `${project.repoName}-${id}` });
    }
    const next = withAuthors(policy, authors);
    const mainTree = (await readCommit(ws.repo, ws.main)).tree;
    const tree = await changeFiles(ws.repo, mainTree, policyFiles(next));
    const { payload } = approvalPayload({
      repo: project.repoId,
      action: "policy",
      parents: [ws.main],
      tree,
      summary: `Admit author keys for ${names.join(" and ")}, valid for ${Math.round(ttl / 60_000)} minutes`,
      at: now,
    });
    const promoters = policy.promoters.filter((p): p is WebAuthnPromoter => p.kind === "webauthn");
    return {
      ok: true,
      value: await this.request("admit", payload, promoters, { policy: next, agents, message: admitMessage(names.join(" and ")) }, await diffTrees(ws.repo, mainTree, tree)),
    };
  }

  /**
   * Request an approval that admits the SSH key of a person. Then the person
   * can work from a laptop as the agents do. The person has a fork and signs
   * each commit, but has no control over main or the rules.
   */
  async preparePersonAdmission(publicKey: string): Promise<Result<ApprovalRequest>> {
    const project = this.project();
    if (!project?.repoId) return refuse(409, "no-repository", "Create the project first.");
    if (project.mainHead === project.repoId) return refuse(409, "no-policy", "Approve the first policy first.");
    let raw: Uint8Array;
    try {
      raw = parsePublicKeyText(publicKey);
    } catch {
      return refuse(400, "bad-key", "Paste an ssh-ed25519 public key, the one line from a .pub file.");
    }
    const id = `${slug(project.promoter.id)}-laptop`;
    if (this.agents().some((a) => a.id === id)) return refuse(409, "agent-exists", "Your laptop key is already admitted.");
    const ws = await this.workspace("read");
    const policy = await this.policyAt(ws.repo, ws.main);
    const now = Date.now();
    const author: Author = {
      id,
      kind: "ssh-ed25519",
      publicKey: publicKeyText(raw),
      fingerprint: await fingerprint(raw),
      controller: project.promoter.id,
      validAfter: new Date(now - 60_000).toISOString(),
      validBefore: new Date(now + PERSON_KEY_MS).toISOString(),
    };
    if (policy.authors.some((a) => a.publicKey === author.publicKey)) return refuse(409, "key-exists", "The policy already lists that key.");
    const next = withAuthors(policy, [author]);
    const mainTree = (await readCommit(ws.repo, ws.main)).tree;
    const tree = await changeFiles(ws.repo, mainTree, policyFiles(next));
    const { payload } = approvalPayload({
      repo: project.repoId,
      action: "policy",
      parents: [ws.main],
      tree,
      summary: `Admit your laptop's SSH key ${author.fingerprint.slice(0, 17)}… for 8 hours, with a fork of your own`,
      at: now,
    });
    const promoters = policy.promoters.filter((p): p is WebAuthnPromoter => p.kind === "webauthn");
    const agents = [{ id, name: `${project.promoter.id}'s laptop`, fork: `${project.repoName}-${id}`.slice(0, 63), person: true }];
    return { ok: true, value: await this.request("admit", payload, promoters, { policy: next, agents, message: admitMessage("a person's laptop") }, await diffTrees(ws.repo, mainTree, tree)) };
  }

  /** A write token for a person's fork, and the git commands that sign a commit and push it there. */
  async pushAccess(id: string): Promise<Result<PushAccess>> {
    const person = this.agents().find((a) => a.id === id && a.kind === "person");
    if (!person) return refuse(404, "no-person", "There is no such laptop key.");
    const host = this.host();
    if (host.kind !== "artifacts") return refuse(409, "local", "Pushing from a laptop needs the Artifacts host; this forge keeps repositories locally.");
    if (this.cached<Policy>("policy")?.authors.find((a) => a.id === id)?.revokedAt) return refuse(409, "revoked", "This key is revoked.");
    const token = await host.token(person.fork, "write", 3600);
    const remote = await host.remote(person.fork);
    const auth = `-c http.extraHeader="Authorization: Bearer ${token.secret}"`;
    return {
      ok: true,
      value: {
        fork: person.fork,
        remote,
        expiresAt: token.expiresAt,
        pushEvents: Boolean(this.env.CF_API_TOKEN),
        commands: [
          `git ${auth} clone ${remote} ${person.fork} && cd ${person.fork}`,
          `git config gpg.format ssh && git config user.signingkey ~/.ssh/id_ed25519.pub && git config commit.gpgsign true`,
          `git checkout -b my-change`,
          `# edit, then: git commit -am "Describe the change"`,
          `git ${auth} push origin my-change`,
        ],
      },
    };
  }

  /** Request an approval that revokes an agent's key: a policy change that sets its revocation time. */
  async prepareRevocation(agentId: string): Promise<Result<ApprovalRequest>> {
    const project = this.project();
    const agent = this.agents().find((a) => a.id === agentId);
    if (!project?.repoId || !agent) return refuse(404, "no-agent", "There is no such agent.");
    const ws = await this.workspace("read");
    const policy = await this.policyAt(ws.repo, ws.main);
    const author = policy.authors.find((a) => a.id === agentId);
    if (!author) return refuse(404, "no-agent", "The policy on main has no key for this agent.");
    if (author.revokedAt) return refuse(409, "revoked", `${agent.name}'s key is already revoked.`);
    const next = withRevoked(policy, agentId, new Date());
    const mainTree = (await readCommit(ws.repo, ws.main)).tree;
    const tree = await changeFiles(ws.repo, mainTree, policyFiles(next));
    const { payload } = approvalPayload({
      repo: project.repoId,
      action: "policy",
      parents: [ws.main],
      tree,
      summary: `Revoke ${agent.name}'s key: it signs nothing from now on, and its earlier work still counts`,
      at: Date.now(),
    });
    const promoters = policy.promoters.filter((p): p is WebAuthnPromoter => p.kind === "webauthn");
    return {
      ok: true,
      value: await this.request(
        "revoke",
        payload,
        promoters,
        { policy: next, agentId, message: `Revoke the key of ${agent.name}\n\nThe key signs nothing after ${next.authors.find((a) => a.id === agentId)?.revokedAt}.\nCommits it signed before then still verify.\n` },
        await diffTrees(ws.repo, mainTree, tree),
      ),
    };
  }

  /** Request an approval that releases main as it is now, as an annotated tag. */
  async prepareRelease(name: string): Promise<Result<ApprovalRequest>> {
    const project = this.project();
    if (!project?.repoId) return refuse(409, "no-repository", "Create the project first.");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(name) || name.includes("..")) {
      return refuse(400, "bad-name", "Name the release with letters, digits, dots and dashes, such as v1.0.0.");
    }
    const ws = await this.workspace("read");
    if (await resolve(ws.repo, `refs/tags/${name}`)) return refuse(409, "exists", `There is already a release ${name}.`);
    const policy = await this.policyAt(ws.repo, ws.main);
    if ((policy.releaseApprovals ?? 1) > 1) {
      return refuse(409, "two-promoters", `The policy asks ${policy.releaseApprovals} promoters to approve a release; this forge collects one approval for each release.`);
    }
    const tree = (await readCommit(ws.repo, ws.main)).tree;
    const { payload } = approvalPayload({
      repo: project.repoId,
      action: "release",
      parents: [ws.main],
      tree,
      summary: `Release main at ${ws.main.slice(0, 7)} as ${name}`,
      at: Date.now(),
      ref: `refs/tags/${name}`,
    });
    const promoters = policy.promoters.filter((p): p is WebAuthnPromoter => p.kind === "webauthn");
    return { ok: true, value: await this.request("release", payload, promoters, { name }, []) };
  }

  /** Request an approval that promotes a ready proposal into main. */
  async preparePromotion(proposalId: string): Promise<Result<ApprovalRequest>> {
    const project = this.project();
    const proposal = this.proposal(proposalId);
    if (!project?.repoId || !proposal) return refuse(404, "no-proposal", "There is no such proposal.");
    if (proposal.status === "promoted") return refuse(409, "promoted", "This proposal is already on main.");
    const ws = await this.workspace("read");
    const head = await this.fetchProposal(ws, proposal);
    const report = await verifyProposal(ws.repo, ws.main, head);
    await this.saveReport(ws.repo, proposal, ws.main, report);
    if (!report.ok || !report.mergedTree) return refuse(409, "rejected", report.summary);
    const agent = this.agents().find((a) => a.id === proposal.agent_id);
    const { payload } = approvalPayload({
      repo: project.repoId,
      action: "promote",
      parents: [ws.main, head],
      tree: report.mergedTree,
      summary: `Promote "${proposal.title}" from ${agent?.name ?? proposal.agent_id}`,
      at: Date.now(),
    });
    const policy = await this.policyAt(ws.repo, ws.main);
    const promoters = policy.promoters.filter((p): p is WebAuthnPromoter => p.kind === "webauthn");
    const mainTree = (await readCommit(ws.repo, ws.main)).tree;
    return {
      ok: true,
      value: await this.request(
        "promote",
        payload,
        promoters,
        {
          proposalId,
          message: `Promote "${proposal.title}" from ${agent?.name ?? proposal.agent_id}\n\nMerges ${proposal.branch} (${head.slice(0, 7)}) from fork ${agent?.fork ?? "?"}.\nSigned by author key ${agent?.fingerprint ?? "?"}.\n`,
        },
        await diffTrees(ws.repo, mainTree, report.mergedTree),
      ),
    };
  }

  /** Apply an approved change. The approval must verify against the policy that governs the change. */
  approve(approvalId: string, response: unknown): Promise<Result<ProjectState>> {
    return this.exclusive(async () => {
      const project = this.project();
      if (!project) return refuse(404, "no-project", "There is no such project.");
      const row = this.sql
        .exec<{ kind: ApprovalKind; payload: string; data: string; created_at: number; used_at: number | null }>(
          "SELECT kind, payload, data, created_at, used_at FROM approvals WHERE id = ?",
          approvalId,
        )
        .toArray()[0];
      if (!row || row.used_at !== null || row.created_at + APPROVAL_LIFETIME_MS < Date.now()) {
        return refuse(409, "approval-expired", "This approval request is used or expired. Ask again.");
      }
      if (!assertionShape(response)) return refuse(400, "bad-response", "The passkey response is not an assertion.");
      // Single use: mark it before anything can fail.
      this.sql.exec("UPDATE approvals SET used_at = ? WHERE id = ?", Date.now(), approvalId);
      if (row.kind === "sign") {
        try {
          await this.signInception(project, JSON.parse(row.data).at as number, response);
        } catch (error) {
          if (error instanceof Refused) {
            this.event("refusal", error.reason);
            return refuse(error.status, error.error, error.reason);
          }
          throw error;
        }
        return { ok: true, value: await this.state() };
      }
      const bytes = fromBase64Url(row.payload);
      const payload = JSON.parse(new TextDecoder().decode(bytes)) as ApprovalPayload;
      const data = JSON.parse(row.data);
      // A change of main: the passkey signed the commit itself. A release: an approval for the tag's message.
      const signed: Signed = { payload, message: data.message as string, response };
      try {
        if (row.kind === "incept") await this.incept(project, signed, data.policy as Policy);
        else if (row.kind === "admit") await this.admit(project, signed, data);
        else if (row.kind === "revoke") await this.revoke(project, signed, data);
        else if (row.kind === "release") await this.release(project, payload, approvalFrom(bytes, response), data.name as string);
        else await this.promote(project, signed, data.proposalId as string);
      } catch (error) {
        if (error instanceof Refused) {
          this.event("refusal", error.reason);
          return refuse(error.status, error.error, error.reason);
        }
        throw error;
      }
      return { ok: true, value: await this.state() };
    });
  }

  /**
   * Write the commit of main that the passkey signed. It uses the payload,
   * message and time of the request, and adds the signature. It refuses unless
   * the signature verifies as a promoter's under `policy`. It does not move a
   * ref.
   */
  private async commitMain(repo: MemRepo, signed: Signed, policy: Policy): Promise<{ oid: string; by: string }> {
    const project = this.project()!;
    const blob = skPublicKeyBlob(project.promoter.publicKey, project.rp.rpId);
    const oid = await commitPasskeySigned(
      repo,
      { payload: signed.payload, message: signed.message, committer: this.promoterIdentity(signed.payload.at) },
      async () => webauthnSignature(blob, signed.response.response),
    );
    const check = await passkeyApproval(await readCommit(repo, oid), policy);
    if (!check.ok) throw new Refused(403, "approval-refused", `The approval does not verify: ${check.reason}`);
    return { oid, by: check.promoter.id };
  }

  private async check(approval: Approval, policy: Policy): Promise<string> {
    const check = await verifyApproval(approval, policy);
    if (!check.ok) throw new Refused(403, "approval-refused", `The approval does not verify: ${check.reason}`);
    return check.promoter.id;
  }

  /** Write the empty inception commit with the passkey's SSH signature, and make it main of a new repository. */
  private async signInception(project: ProjectRow, at: number, response: { response: { authenticatorData: string; clientDataJSON: string; signature: string } }) {
    if (project.repoId) throw new Refused(409, "exists", "This project already has its inception commit.");
    const blob = skPublicKeyBlob(project.promoter.publicKey, project.rp.rpId);
    const repo = await memoryRepo();
    const oid = await commitInception(repo, await this.inceptionInput(project, at), async () => webauthnSignature(blob, response.response));
    const report = await verifyHistory(repo, oid);
    if (!report.ok) throw new Refused(403, "approval-refused", `The inception commit does not verify: ${report.commits[0]!.rules.find((r) => !r.ok)!.reason}`);
    await setRef(repo, "refs/heads/main", oid);
    const host = this.host();
    await host.create(project.repoName);
    const transport = await host.transport(project.repoName, await host.token(project.repoName, "write", 120));
    await transport.push(repo, "refs/heads/main", "refs/heads/main", null);
    await repoIndex(this.env).put(project.repoName, { projectId: project.id, agentId: null });
    await this.subscribe(project.repoName);
    this.saveProject({ ...project, repoId: oid, mainHead: oid });
    this.event("project", `Inception commit ${oid.slice(0, 7)} signed by the passkey of ${project.promoter.id}. It is the root of trust and the repository id.`);
    await this.recordHistory(repo, oid);
  }

  /** Write the commit that sets the first policy. Its parent is the inception commit. */
  private async incept(project: ProjectRow, signed: Signed, policy: Policy) {
    const { payload } = signed;
    if (!project.repoId || project.mainHead !== project.repoId) throw new Refused(409, "exists", "This project already has its first policy.");
    const ws = await this.workspace("write");
    if (payload.parents[0] !== ws.main || ws.main !== project.repoId) throw new Refused(409, "stale", "Main moved since this change was shown. Ask again.");
    const tree = await writeFiles(ws.repo, templateFiles(project.name, policy, await verifier(this.env), project.repoName));
    if (tree !== payload.tree) throw new Refused(409, "changed", "The template changed since the approval was asked for.");
    const { oid, by } = await this.commitMain(ws.repo, signed, policy);
    await setRef(ws.repo, "refs/heads/main", oid);
    await ws.transport.push(ws.repo, "refs/heads/main", "refs/heads/main", ws.main);
    this.saveProject({ ...project, mainHead: oid });
    this.cache("policy", policy);
    this.event("policy", `Policy commit ${oid.slice(0, 7)} approved by ${by}: the first rules of the repository.`);
    await this.recordHistory(ws.repo, oid);
  }

  private async admit(
    project: ProjectRow,
    signed: Signed,
    data: { policy: Policy; agents: { id: string; name: string; fork: string; person?: boolean }[] },
  ) {
    const { payload } = signed;
    const ws = await this.workspace("write");
    if (payload.parents[0] !== ws.main) throw new Refused(409, "stale", "Main moved since this change was shown. Ask again.");
    const tree = await changeFiles(ws.repo, (await readCommit(ws.repo, ws.main)).tree, policyFiles(data.policy));
    if (tree !== payload.tree) throw new Refused(409, "changed", "The policy change differs from the approved one.");
    const names = data.agents.map((a) => (a.person ? "a person's laptop" : a.name)).join(" and ");
    const { oid, by } = await this.commitMain(ws.repo, signed, await this.policyAt(ws.repo, ws.main));
    await setRef(ws.repo, "refs/heads/main", oid);
    await ws.transport.push(ws.repo, "refs/heads/main", "refs/heads/main", ws.main);
    this.saveProject({ ...project, mainHead: oid });
    this.cache("policy", data.policy);
    this.event("policy", `Policy commit ${oid.slice(0, 7)} approved by ${by}: admits author keys for ${names}.`);
    await this.recordHistory(ws.repo, oid);

    const host = this.host();
    const ttl = Number(this.env.FORK_TOKEN_TTL_S ?? 900);
    for (const agent of data.agents) {
      const author = data.policy.authors.find((a) => a.id === agent.id)!;
      await host.fork(project.repoName, agent.fork);
      await repoIndex(this.env).put(agent.fork, { projectId: project.id, agentId: agent.id });
      await this.subscribe(agent.fork);
      this.sql.exec(
        "INSERT OR REPLACE INTO agents (id, name, fork, public_key, fingerprint, valid_after, valid_before, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        agent.id,
        agent.name,
        agent.fork,
        author.publicKey,
        author.fingerprint,
        author.validAfter,
        author.validBefore,
        agent.person ? "person" : "agent",
      );
      if (agent.person) {
        this.event("agent", `${agent.name} may now sign work in fork ${agent.fork} and push it with git.`);
        continue;
      }
      const token = await host.token(agent.fork, "write", ttl);
      await this.run(agent.id).assign(agent.fork, token, firstTask(agent.id).id);
      this.event("agent", `${agent.name} works in fork ${agent.fork}, with a write token for that fork only.`);
    }
  }

  private async release(_project: ProjectRow, payload: ApprovalPayload, approval: Approval, name: string) {
    const ws = await this.workspace("write");
    if (payload.parents[0] !== ws.main) throw new Refused(409, "stale", "Main moved since this release was shown. Ask again.");
    const by = await this.check(approval, await this.policyAt(ws.repo, ws.main));
    if (payload.tree !== (await readCommit(ws.repo, ws.main)).tree || payload.ref !== `refs/tags/${name}`) {
      throw new Refused(409, "changed", "The release differs from the approved one.");
    }
    const tag = await tagApproved(ws.repo, {
      name,
      target: ws.main,
      message: `Release ${name}\n\nMain at ${ws.main.slice(0, 7)}, released with a passkey approval.\n`,
      approvals: [approval],
      tagger: this.promoterIdentity(Date.now()),
    });
    await ws.transport.push(ws.repo, `refs/tags/${name}`, `refs/tags/${name}`, null);
    this.event("promotion", `${by} released main at ${ws.main.slice(0, 7)} as ${name} (tag ${tag.slice(0, 7)}).`);
    await this.recordHistory(ws.repo, ws.main);
  }

  private async revoke(project: ProjectRow, signed: Signed, data: { policy: Policy; agentId: string }) {
    const { payload } = signed;
    const ws = await this.workspace("write");
    if (payload.parents[0] !== ws.main) throw new Refused(409, "stale", "Main moved since this change was shown. Ask again.");
    const tree = await changeFiles(ws.repo, (await readCommit(ws.repo, ws.main)).tree, policyFiles(data.policy));
    if (tree !== payload.tree) throw new Refused(409, "changed", "The policy change differs from the approved one.");
    const agent = this.agents().find((a) => a.id === data.agentId)!;
    const { oid, by } = await this.commitMain(ws.repo, signed, await this.policyAt(ws.repo, ws.main));
    await setRef(ws.repo, "refs/heads/main", oid);
    await ws.transport.push(ws.repo, "refs/heads/main", "refs/heads/main", ws.main);
    this.saveProject({ ...project, mainHead: oid });
    this.cache("policy", data.policy);
    this.event("policy", `Policy commit ${oid.slice(0, 7)} approved by ${by}: revokes the key of ${agent.name}.`);
    await this.recordHistory(ws.repo, oid);
    // Stop the agent, and make its fork token invalid.
    const secret = await this.run(agent.id).revoke();
    if (secret) await this.host().revokeToken(agent.fork, secret).catch((error) => console.error(error));
    this.event("agent", `${agent.name} is stopped, and its write token for ${agent.fork} no longer works.`);
    // Check each open proposal again under the new rules.
    for (const other of this.sql.exec<ProposalRow>("SELECT * FROM proposals WHERE status IN ('ready', 'stale')").toArray()) {
      const head = await this.fetchProposal(ws, other);
      await this.saveReport(ws.repo, other, oid, await verifyProposal(ws.repo, oid, head));
    }
  }

  private async promote(project: ProjectRow, signed: Signed, proposalId: string) {
    const { payload } = signed;
    const proposal = this.proposal(proposalId);
    if (!proposal) throw new Refused(404, "no-proposal", "There is no such proposal.");
    const ws = await this.workspace("write");
    if (payload.parents[0] !== ws.main) throw new Refused(409, "stale", "Main moved since this change was shown. Ask again.");
    const head = await this.fetchProposal(ws, proposal);
    if (payload.parents[1] !== head) throw new Refused(409, "changed", "The proposal moved since it was approved.");
    const report = await verifyProposal(ws.repo, ws.main, head);
    if (!report.ok || report.mergedTree !== payload.tree) {
      await this.saveReport(ws.repo, proposal, ws.main, report);
      throw new Refused(409, "rejected", report.ok ? "The merge differs from the approved tree." : report.summary);
    }
    const { oid, by } = await this.commitMain(ws.repo, signed, await this.policyAt(ws.repo, ws.main));
    await setRef(ws.repo, "refs/heads/main", oid);
    await ws.transport.push(ws.repo, "refs/heads/main", "refs/heads/main", ws.main);
    this.saveProject({ ...project, mainHead: oid });
    this.sql.exec(
      "UPDATE proposals SET status = 'promoted', promoted_as = ?, updated_at = ? WHERE id = ?",
      oid,
      Date.now(),
      proposal.id,
    );
    this.event("promotion", `${by} promoted "${proposal.title}" as ${oid.slice(0, 7)}.`);
    await this.recordHistory(ws.repo, oid);
    // Every other open proposal now has an older base: check it again on the new main.
    const open = this.sql.exec<ProposalRow>("SELECT * FROM proposals WHERE status IN ('ready', 'stale')").toArray();
    for (const other of open) {
      this.sql.exec("UPDATE proposals SET status = 'stale' WHERE id = ?", other.id);
      this.touch();
      const otherHead = await this.fetchProposal(ws, other);
      await this.saveReport(ws.repo, other, oid, await verifyProposal(ws.repo, oid, otherHead));
    }
  }

  // --- what changed ---------------------------------------------------------------------

  /** The files that differ between two trees, each with a line diff when it is small text. */
  private async fileDiffs(repo: MemRepo, from: string | null, to: string): Promise<FileDiff[]> {
    const before = from ? await listFiles(repo, from) : new Map<string, string>();
    const after = await listFiles(repo, to);
    const text = async (oid: string | undefined) => (oid ? readBlobText(repo, oid) : "");
    const out: FileDiff[] = [];
    for (const change of await diffTrees(repo, from, to)) {
      const a = await text(before.get(change.path));
      const b = await text(after.get(change.path));
      out.push({ ...change, lines: a === null || b === null ? null : diffLines(a, b) });
    }
    return out;
  }

  /**
   * One commit as the commit sheet shows it. The sheet shows its headers,
   * message, signature or approval, and the rules from the last report. It
   * also shows the files that the commit changes against its first parent. For a commit that is only in a fork, the forge
   * fetches it from the fork of the proposal that holds it.
   */
  async commit(oid: string): Promise<Result<CommitDetail>> {
    const project = this.project();
    if (!project?.repoId) return refuse(404, "no-commit", "There is no such commit.");
    const ws = await this.workspace("read");
    let found = await readCommit(ws.repo, oid).catch(() => null);
    let report: CommitReport | undefined = this.cached<HistoryReport>("history")?.commits.find((c) => c.oid === oid);
    // A commit that main does not reach: find the proposal that holds it, for its report and its fork.
    for (const p of report ? [] : this.sql.exec<ProposalRow>("SELECT * FROM proposals ORDER BY updated_at DESC").toArray()) {
      const inReport = p.report ? (JSON.parse(p.report) as ProposalReport).commits.find((c) => c.oid === oid) : undefined;
      if (!inReport) continue;
      report = inReport;
      if (!found) {
        await this.fetchProposal(ws, p);
        found = await readCommit(ws.repo, oid).catch(() => null);
      }
      break;
    }
    if (!found) return refuse(404, "no-commit", "There is no such commit.");
    let approval = approvalIn(found.message);
    // A commit the passkey signed as a whole: its approval is the trailer's payload with the signature's assertion.
    const facts = approval ? null : factsIn(found.message);
    const assertion = facts && found.signature ? await webauthnAssertion(found.signature) : null;
    if (facts && assertion) approval = { payload: facts.bytes, credentialId: this.project()!.promoter.credentialId, ...assertion };
    const parent = found.parents[0] ? (await readCommit(ws.repo, found.parents[0])).tree : null;
    let clientData: unknown = null;
    let payload: ApprovalPayload | null = null;
    if (approval) {
      try {
        clientData = JSON.parse(fromUtf8(fromBase64Url(approval.clientDataJSON)));
        payload = JSON.parse(fromUtf8(fromBase64Url(approval.payload))) as ApprovalPayload;
      } catch {
        // A trailer that does not decode shows as absent; the rules say why.
      }
    }
    return {
      ok: true,
      value: {
        oid,
        tree: found.tree,
        parents: found.parents,
        author: found.author,
        committer: found.committer,
        message: found.message.replace(/\n\nForge-Approval: .*\n?$/s, "\n"),
        signature: found.signature,
        approval: approval && payload ? { ...approval, payload, clientData, envelope: await approvalEnvelopes(approval) } : null,
        changes: await this.fileDiffs(ws.repo, parent, found.tree),
        report: report ?? null,
      },
    };
  }

  // --- proposals ----------------------------------------------------------------------

  private async fetchProposal(ws: Workspace, proposal: ProposalRow): Promise<string> {
    const agent = this.agents().find((a) => a.id === proposal.agent_id);
    if (!agent) throw new Refused(404, "no-agent", "The agent of this proposal is gone.");
    const host = this.host();
    const fork = await host.transport(agent.fork, await host.token(agent.fork, "read", 120));
    await fork.fetch(ws.repo, proposal.branch, `refs/forks/${agent.id}/${proposal.branch}`);
    // The proposal is the head the agent named, even if the branch moved later.
    await readCommit(ws.repo, proposal.head);
    return proposal.head;
  }

  /** Store a verification report, with the files the proposal would change in main and their line diffs. */
  private async saveReport(repo: MemRepo, proposal: ProposalRow, base: string, report: ProposalReport): Promise<void> {
    const status: ProposalStatus = report.ok ? "ready" : "rejected";
    const target = report.mergedTree ?? (await readCommit(repo, report.head)).tree;
    const detail = { changes: await this.fileDiffs(repo, (await readCommit(repo, base)).tree, target) };
    this.sql.exec(
      "UPDATE proposals SET status = ?, base = ?, report = ?, detail = ?, updated_at = ? WHERE id = ?",
      status,
      base,
      JSON.stringify(report),
      JSON.stringify(detail),
      Date.now(),
      proposal.id,
    );
    this.touch();
  }

  /** An agent proposes the head of a branch in its fork. Returns the proposal id after the forge verifies it. */
  propose(input: { agentId: string; taskSeq: number; taskId: string; title: string; branch: string; head: string }): Promise<string> {
    return this.exclusive(async () => {
      const project = this.project()!;
      const id = crypto.randomUUID();
      const now = Date.now();
      this.sql.exec(
        `INSERT INTO proposals (id, agent_id, task_seq, task_id, title, branch, head, base, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'verifying', ?, ?)`,
        id,
        input.agentId,
        input.taskSeq,
        input.taskId,
        input.title,
        input.branch,
        input.head,
        project.mainHead ?? "",
        now,
        now,
      );
      const proposal = this.proposal(id)!;
      const ws = await this.workspace("read");
      await this.fetchProposal(ws, proposal);
      const report = await verifyProposal(ws.repo, ws.main, input.head);
      await this.saveReport(ws.repo, proposal, ws.main, report);
      const agent = this.agents().find((a) => a.id === input.agentId);
      this.event(
        report.ok ? "proposal" : "refusal",
        report.ok
          ? `${agent?.name ?? input.agentId} proposed "${input.title}": every rule passes.`
          : `${agent?.name ?? input.agentId} proposed "${input.title}". ${report.summary}`,
      );
      return id;
    });
  }

  /**
   * A push event reports a push to a fork. The agents propose their own
   * pushes, so the forge ignores them here. Any other push to a branch
   * updates the open proposal of that branch, or opens a new one.
   */
  forkPushed(agentId: string, branch: string, head: string): Promise<string> {
    return this.exclusive(async () => {
      const agent = this.agents().find((a) => a.id === agentId);
      if (!agent) return "ignored: no such agent";
      if (branch === "main") return "ignored: the main of a fork";
      if (await this.run(agentId).madeHead(head)) return "ignored: the agent proposes its own push";
      const open = this.sql
        .exec<ProposalRow>("SELECT * FROM proposals WHERE agent_id = ? AND branch = ? AND status != 'promoted' ORDER BY created_at DESC LIMIT 1", agentId, branch)
        .toArray()[0];
      const now = Date.now();
      let proposal: ProposalRow;
      if (open) {
        if (open.head === head) return "ignored: already proposed";
        this.sql.exec("UPDATE proposals SET head = ?, status = 'verifying', updated_at = ? WHERE id = ?", head, now, open.id);
        proposal = this.proposal(open.id)!;
      } else {
        const id = crypto.randomUUID();
        this.sql.exec(
          `INSERT INTO proposals (id, agent_id, task_seq, task_id, title, branch, head, base, status, created_at, updated_at)
           VALUES (?, ?, -1, 'outside', ?, ?, ?, ?, 'verifying', ?, ?)`,
          id,
          agentId,
          agent.kind === "person" ? `${branch}, pushed from ${agent.name}` : `Push to ${branch} from outside the forge`,
          branch,
          head,
          this.project()!.mainHead ?? "",
          now,
          now,
        );
        proposal = this.proposal(id)!;
      }
      const ws = await this.workspace("read");
      await this.fetchProposal(ws, proposal);
      const report = await verifyProposal(ws.repo, ws.main, head);
      await this.saveReport(ws.repo, proposal, ws.main, report);
      this.event(
        report.ok ? "proposal" : "refusal",
        `A push to ${agent.fork} ${branch} came from outside the forge. ${report.ok ? "Every rule passes." : report.summary}`,
      );
      return report.ok ? "verified: ready" : "verified: rejected";
    });
  }

  /** A push event reports a push to main of the project repository. If the forge did not make it, verify main from a fresh clone. */
  mainPushed(head: string): Promise<string> {
    return this.exclusive(async () => {
      const project = this.project();
      if (!project?.repoId) return "ignored: no repository yet";
      if (head === project.mainHead) return "ignored: the forge made this push";
      const ws = await this.workspace("read");
      const report = await verifyHistory(ws.repo, ws.main, { repoId: project.repoId });
      this.cache("history", report);
      this.event(
        report.ok ? "verify" : "refusal",
        `Main moved to ${head.slice(0, 7)} outside the forge. ${report.ok ? report.summary : `The verifier rejects it: ${report.summary}`}`,
      );
      return report.ok ? "verified: main is valid" : "verified: main is not valid";
    });
  }

  /** Give an agent one of the tasks a person may give from the page. */
  async give(agentId: string, taskId: string, args: { topic?: string } = {}): Promise<Result<null>> {
    if (!(GIVEN_TASKS as readonly string[]).includes(taskId)) return refuse(400, "no-task", "There is no such task.");
    if (taskId === "llm-note") {
      if (!noteClient(this.env)) return refuse(409, "no-llm", "This forge has no Anthropic API key, so agents cannot write with Claude.");
      const topic = (args.topic ?? "").replace(/\s+/g, " ").trim();
      if (topic.length < 3 || topic.length > 120) return refuse(400, "bad-topic", "Give a topic of 3 to 120 characters.");
      args = { topic };
    }
    if (taskId === PERMANENT_KEY.id) return this.tempt(agentId);
    const agent = this.agents().find((a) => a.id === agentId && a.kind === "agent");
    if (!agent) return refuse(404, "no-agent", "There is no such agent.");
    if (this.cached<Policy>("policy")?.authors.find((a) => a.id === agentId)?.revokedAt) {
      return refuse(409, "revoked", `${agent.name}'s key is revoked, so it takes no more tasks.`);
    }
    const host = this.host();
    await this.run(agent.id).assign(agent.fork, await host.token(agent.fork, "write", Number(this.env.FORK_TOKEN_TTL_S ?? 900)), taskId, args);
    this.event("agent", `${agent.name} starts "${taskById(agentId, taskId).title}${args.topic ? `: ${args.topic}` : ""}".`);
    return { ok: true, value: null };
  }

  /**
   * A proposal that conflicts with main: move main of the agent's fork to
   * main of the project with a fast-forward push. Then give the agent the same
   * task again. The new work starts from main as it is now, so it merges.
   */
  redo(proposalId: string): Promise<Result<null>> {
    return this.exclusive(async () => {
      const proposal = this.proposal(proposalId);
      if (!proposal) return refuse(404, "no-proposal", "There is no such proposal.");
      const report = proposal.report ? (JSON.parse(proposal.report) as ProposalReport) : null;
      const onlyConflict = report && !report.merge.ok && report.commits.every((c) => c.ok);
      if (!onlyConflict) return refuse(409, "not-a-conflict", "Only a proposal that fails for a conflict, and passes every other rule, is redone.");
      if (proposal.redone_at) return refuse(409, "redone", "This proposal is already being redone.");
      const agent = this.agents().find((a) => a.id === proposal.agent_id)!;
      if (this.cached<Policy>("policy")?.authors.find((a) => a.id === agent.id)?.revokedAt) {
        return refuse(409, "revoked", `${agent.name}'s key is revoked, so it takes no more tasks.`);
      }
      const ws = await this.workspace("read");
      const host = this.host();
      const token = await host.token(agent.fork, "write", Number(this.env.FORK_TOKEN_TTL_S ?? 900));
      const fork = await host.transport(agent.fork, token);
      const old = await fork.fetch(ws.repo, "main", `refs/forks/${agent.id}/main`);
      await fork.push(ws.repo, "refs/heads/main", "refs/heads/main", old);
      this.sql.exec("UPDATE proposals SET redone_at = ? WHERE id = ?", Date.now(), proposal.id);
      await this.run(agent.id).assign(agent.fork, token, proposal.task_id);
      this.event("agent", `${agent.name} brings ${agent.fork} up to main at ${ws.main.slice(0, 7)} and does "${proposal.title}" again.`);
      return { ok: true, value: null };
    });
  }

  /** Give an agent the rogue task: list its own key as a promoter. */
  async tempt(agentId: string): Promise<Result<null>> {
    const agent = this.agents().find((a) => a.id === agentId && a.kind === "agent");
    if (!agent) return refuse(404, "no-agent", "There is no such agent.");
    if (this.cached<Policy>("policy")?.authors.find((a) => a.id === agentId)?.revokedAt) {
      return refuse(409, "revoked", `${agent.name}'s key is revoked, so it takes no more tasks.`);
    }
    const host = this.host();
    const token = await host.token(agent.fork, "write", Number(this.env.FORK_TOKEN_TTL_S ?? 900));
    await this.run(agent.id).assign(agent.fork, token, PERMANENT_KEY.id);
    this.event("agent", `${agent.name} starts "${PERMANENT_KEY.title}".`);
    return { ok: true, value: null };
  }

  // --- verification outside the platform's own records ------------------------------------

  private async recordHistory(repo: MemRepo, head: string): Promise<HistoryReport> {
    const report = await verifyHistory(repo, head);
    this.cache("history", report);
    return report;
  }

  /** Clone the repository again, from nothing, and verify all of main with the repository id pinned. */
  async verifyFresh(): Promise<Result<FreshVerify>> {
    const project = this.project();
    if (!project?.repoId) return refuse(409, "no-repository", "Create the project first.");
    const ws = await this.workspace("read");
    const report = await verifyHistory(ws.repo, ws.main, { repoId: project.repoId });
    const fresh: FreshVerify = { at: Date.now(), report };
    this.cache("fresh", fresh);
    this.event("verify", `A fresh clone verified: ${report.summary}`);
    return { ok: true, value: fresh };
  }

  /** A read token, and the commands that clone and verify the repository with no forge in the loop. */
  async outside(): Promise<Result<Outside>> {
    const project = this.project();
    if (!project?.repoId) return refuse(409, "no-repository", "Create the project first.");
    const host = this.host();
    const token = await host.token(project.repoName, "read", 3600);
    const remote = await host.remote(project.repoName);
    const dir = project.repoName;
    const tool = await verifier(this.env);
    const clone =
      host.kind === "artifacts"
        ? `git -c http.extraHeader="Authorization: Bearer ${token.secret}" clone ${remote} ${dir}`
        : `git clone ${remote.replace("://", `://x:${encodeURIComponent(token.secret.split("?")[0]!)}@`)} ${dir}`;
    return {
      ok: true,
      value: {
        remote,
        token: token.secret,
        expiresAt: token.expiresAt,
        commands: [
          clone,
          ...(tool
            ? [
                `curl -fsSLO ${tool.url} && echo "${tool.sha256}  forge-verify.mjs" | shasum -a 256 --check`,
                `node forge-verify.mjs ${dir} --repo ${project.repoId}`,
              ]
            : [`node apps/forge/scripts/forge-verify.ts ${dir} --repo ${project.repoId}`]),
          // TZ=UTC: under daylight saving time, git on macOS gives ssh-keygen a verify time an hour late.
          `TZ=UTC git -C ${dir} -c gpg.ssh.allowedSignersFile=.repo/config/verification/allowed_commit_signers log --show-signature --format="%h %s"`,
        ],
      },
    };
  }

  /** Subscribe the push queue to a new repository, where the deployment can. A failure is an event, not a refusal. */
  private async subscribe(repoName: string): Promise<void> {
    try {
      const id = await subscribePushes(this.env, repoName);
      if (id) this.cache("subscriptions", [...(this.cached<string[]>("subscriptions") ?? []), id]);
    } catch (error) {
      this.event("refusal", `Push events for ${repoName} are not on: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // --- the GitHub mirror ----------------------------------------------------------------

  private mirrorTarget(project: ProjectRow) {
    const owner = this.env.MIRROR_OWNER;
    if (!owner || !this.env.GITHUB_TOKEN) return null;
    const base = (this.env.MIRROR_GIT_BASE || "https://github.com").replace(/\/+$/, "");
    return {
      owner,
      name: project.repoName,
      remote: `${base}/${owner}/${project.repoName}.git`,
      checksUrl: base === "https://github.com" ? `${base}/${owner}/${project.repoName}/actions` : `${base}/${owner}/${project.repoName}.git`,
    };
  }

  private mirrorState(project: ProjectRow): MirrorState {
    const target = this.mirrorTarget(project);
    return {
      available: target !== null,
      target: target ? `${target.owner}/${target.name}` : null,
      checksUrl: target?.checksUrl ?? null,
      last: this.cached<{ at: number; head: string }>("mirror"),
    };
  }

  /** A call of the GitHub API with the deployment's token. */
  private github(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.env.MIRROR_API.replace(/\/+$/, "")}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.env.GITHUB_TOKEN}`,
        "User-Agent": "forge-demo",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
  }

  /** Make the mirror repository if it is not there, and tell its workflow the repository id to pin. */
  private async prepareGithub(owner: string, name: string, repoId: string): Promise<void> {
    if ((await this.github(`/repos/${owner}/${name}`)).status === 404) {
      const me = (await (await this.github("/user")).json()) as { login?: string };
      const path = me.login === owner ? "/user/repos" : `/orgs/${owner}/repos`;
      const created = await this.github(path, {
        method: "POST",
        body: JSON.stringify({ name, private: true, description: "A mirror of a forge demo repository. Its workflow checks every commit against the repository's own rules." }),
      });
      if (!created.ok) throw new Refused(502, "mirror-failed", `GitHub did not create ${owner}/${name}: ${created.status}.`);
    }
    const variable = JSON.stringify({ name: "FORGE_REPO_ID", value: repoId });
    const set = await this.github(`/repos/${owner}/${name}/actions/variables`, { method: "POST", body: variable });
    if (set.status === 409) await this.github(`/repos/${owner}/${name}/actions/variables/FORGE_REPO_ID`, { method: "PATCH", body: variable });
  }

  /**
   * Push main, as it is, to the mirror. A forced push: the mirror holds what
   * main holds, even if someone changed the mirror manually. Its workflow then
   * checks the rules with no forge in the loop.
   */
  mirror(): Promise<Result<MirrorState>> {
    return this.exclusive(async () => {
      const project = this.project();
      if (!project?.repoId) return refuse(409, "no-repository", "Create the project first.");
      const target = this.mirrorTarget(project);
      if (!target) return refuse(409, "no-mirror", "This forge has no GitHub mirror set up.");
      try {
        if (this.env.MIRROR_API) await this.prepareGithub(target.owner, target.name, project.repoId);
        const ws = await this.workspace("read");
        await pushHttp(ws.repo, { http, url: target.remote, token: this.env.GITHUB_TOKEN }, "refs/heads/main", "refs/heads/main", true);
        this.cache("mirror", { at: Date.now(), head: ws.main });
        this.event("verify", `Mirrored main at ${ws.main.slice(0, 7)} to ${target.owner}/${target.name}. Its workflow checks the rules there.`);
      } catch (error) {
        const reason = error instanceof Refused ? error.reason : `The mirror push failed: ${error instanceof Error ? error.message : String(error)}`;
        this.event("refusal", reason);
        return refuse(502, "mirror-failed", reason);
      }
      return { ok: true, value: this.mirrorState(project) };
    });
  }

  // --- reads and reset -------------------------------------------------------------------

  async state(): Promise<ProjectState> {
    const project = this.project();
    if (!project) throw new Error("no project");
    // Read before the rest, so the state holds at least the changes this count names.
    const version = this.version();
    const host = this.host();
    const agents: AgentState[] = [];
    for (const row of this.agents()) {
      const snapshot = await this.run(row.id).snapshot();
      agents.push({
        id: row.id,
        kind: row.kind,
        name: row.name,
        fork: row.fork,
        publicKey: row.public_key,
        fingerprint: row.fingerprint,
        validAfter: row.valid_after,
        validBefore: row.valid_before,
        tokenExpiresAt: snapshot?.tokenExpiresAt ?? null,
        tasks: snapshot?.tasks ?? [],
      });
    }
    const proposals = this.sql
      .exec<ProposalRow>("SELECT * FROM proposals ORDER BY created_at")
      .toArray()
      .map(
        (p): ProposalState => ({
          id: p.id,
          agentId: p.agent_id,
          taskId: p.task_id,
          title: p.title,
          branch: p.branch,
          head: p.head,
          base: p.base,
          status: p.status,
          report: p.report ? (JSON.parse(p.report) as ProposalReport) : null,
          changes: p.detail ? (JSON.parse(p.detail) as { changes: FileDiff[] }).changes : [],
          redoneAt: p.redone_at,
          promotedAs: p.promoted_as,
          createdAt: p.created_at,
          updatedAt: p.updated_at,
        }),
      );
    const remote = project.repoId ? await this.remote(project) : null;
    const events = this.sql
      .exec<{ at: number; kind: ProjectEvent["kind"]; text: string }>("SELECT at, kind, text FROM events ORDER BY seq DESC LIMIT 100")
      .toArray()
      .reverse();
    return {
      id: project.id,
      version,
      name: project.name,
      createdAt: project.createdAt,
      repo: {
        name: project.repoName,
        host: host.kind,
        remote,
        missing: project.repoId !== null && remote === null,
      },
      repoId: project.repoId,
      mainHead: project.mainHead,
      promoter: project.promoter,
      policy: this.cached<Policy>("policy"),
      agents,
      proposals,
      history: this.cached<HistoryReport>("history"),
      freshVerify: this.cached<FreshVerify>("fresh"),
      mirror: this.mirrorState(project),
      llm: noteClient(this.env) !== null,
      events: events.map((e) => ({ at: e.at, kind: e.kind, text: e.text })),
    };
  }

  /** Delete the repositories, the agents and every record of this project. */
  async reset(): Promise<void> {
    const project = this.project();
    if (!project) return;
    const host = this.host();
    for (const agent of this.agents()) {
      await host.remove(agent.fork).catch(() => {});
      await this.run(agent.id).destroy();
    }
    if (project.repoId) await host.remove(project.repoName).catch(() => {});
    await repoIndex(this.env).removeProject(project.id);
    for (const id of this.cached<string[]>("subscriptions") ?? []) await unsubscribe(this.env, id);
    await this.ctx.storage.deleteAll();
    this.schema();
  }
}

/** A refusal that a step throws. `approve` and `mirror` return it as a refusal. */
class Refused extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly reason: string,
  ) {
    super(reason);
  }
}

