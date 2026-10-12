import { DurableObject } from "cloudflare:workers";
import { changeFiles, listFiles, memoryRepo, readCommit, readText, resolve, setRef } from "../authority/git.ts";
import { commitSigned } from "../authority/make.ts";
import { fingerprint, generateKey, parsePublicKeyText, publicKeyText } from "../authority/sshsig.ts";
import { repoHost, type RepoToken } from "./repo-host.ts";
import type { AgentState, TaskEvent, TaskState } from "./state.ts";
import { noteMessage, taskById } from "./tasks.ts";
import { noteClient, writeNote } from "./llm.ts";

// One agent of one project. It holds the agent's Ed25519 key, which never
// leaves this object, and a write token for the agent's own fork, which the
// project gives it. It runs its tasks one at a time from an alarm: clone the
// fork, edit, sign, commit, push, propose. Each step is an event that the
// page shows as it happens.

export interface AgentIdentity {
  projectId: string;
  agentId: string;
  name: string;
  controller: string;
  validAfter: string;
  validBefore: string;
}

export interface AgentKey {
  publicKey: string;
  fingerprint: string;
}

type TaskRow = {
  seq: number;
  args: string | null;
  task_id: string;
  title: string;
  branch: string;
  rogue: number;
  status: TaskState["status"];
  head: string | null;
  proposal_id: string | null;
  error: string | null;
};

export class AgentRun extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.schema();
  }

  /** Create the tables. It runs again after deleteAll, which drops them while this instance stays in memory. */
  private schema(): void {
    this.migrate = true;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS agent (id INTEGER PRIMARY KEY CHECK (id = 0), identity TEXT NOT NULL, private_key TEXT NOT NULL,
        public_key TEXT NOT NULL, fingerprint TEXT NOT NULL, fork TEXT, token TEXT);
      CREATE TABLE IF NOT EXISTS tasks (seq INTEGER PRIMARY KEY AUTOINCREMENT, args TEXT, task_id TEXT NOT NULL, title TEXT NOT NULL,
        branch TEXT NOT NULL, rogue INTEGER NOT NULL, status TEXT NOT NULL, head TEXT, proposal_id TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, task_seq INTEGER NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL);
    `);
  }

  private row() {
    return this.sql
      .exec<{ identity: string; private_key: string; public_key: string; fingerprint: string; fork: string | null; token: string | null }>(
        "SELECT identity, private_key, public_key, fingerprint, fork, token FROM agent",
      )
      .toArray()[0];
  }

  /** Make the agent's key. Returns the public half for the policy. A second call gives the same key. */
  async init(identity: AgentIdentity): Promise<AgentKey> {
    const existing = this.row();
    if (existing) return { publicKey: existing.public_key, fingerprint: existing.fingerprint };
    const key = await generateKey();
    const jwk = await crypto.subtle.exportKey("jwk", key.privateKey);
    const publicKey = publicKeyText(key.publicKey);
    const fp = await fingerprint(key.publicKey);
    this.sql.exec(
      "INSERT INTO agent (id, identity, private_key, public_key, fingerprint) VALUES (0, ?, ?, ?, ?)",
      JSON.stringify(identity),
      JSON.stringify(jwk),
      publicKey,
      fp,
    );
    return { publicKey, fingerprint: fp };
  }

  /** Queue a task on the agent's fork with a write token for that fork, and start it. */
  private migrate = false;

  /** Add the args column to a tasks table made before it existed. */
  private columns(): void {
    if (!this.migrate) return;
    this.migrate = false;
    const names = this.sql.exec<{ name: string }>("PRAGMA table_info(tasks)").toArray().map((c) => c.name);
    if (!names.includes("args")) this.sql.exec("ALTER TABLE tasks ADD COLUMN args TEXT");
  }

  async assign(fork: string, token: RepoToken, taskId: string, args: { topic?: string } = {}): Promise<void> {
    this.columns();
    const row = this.row();
    if (!row) throw new Error("the agent has no key");
    const identity = JSON.parse(row.identity) as AgentIdentity;
    const task = taskById(identity.agentId, taskId);
    this.sql.exec("UPDATE agent SET fork = ?, token = ?", fork, JSON.stringify(token));
    // The same task again goes to a new branch: an existing branch is never pushed over.
    const before = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE task_id = ?", task.id).one().n;
    this.sql.exec(
      "INSERT INTO tasks (task_id, title, branch, rogue, status, args) VALUES (?, ?, ?, ?, 'queued', ?)",
      task.id,
      args.topic ? `${task.title}: ${args.topic}` : task.title,
      `${identity.agentId}/${task.branch}${before > 0 ? `-${before + 1}` : ""}`,
      task.rogue ? 1 : 0,
      JSON.stringify(args),
    );
    await this.ctx.storage.setAlarm(Date.now());
  }

  /**
   * The key was revoked: stop each task that has not started, forget the fork
   * token, and return it so the project can revoke it at the repo host.
   */
  revoke(): string | null {
    const row = this.row();
    if (!row) return null;
    for (const t of this.sql.exec<{ seq: number }>("SELECT seq FROM tasks WHERE status = 'queued'").toArray()) {
      this.sql.exec("UPDATE tasks SET status = 'failed', error = 'the key was revoked' WHERE seq = ?", t.seq);
      this.event(t.seq, "Stopped: a promoter revoked this agent's key.");
    }
    this.sql.exec("UPDATE agent SET token = NULL");
    return row.token ? (JSON.parse(row.token) as RepoToken).secret : null;
  }

  /** Whether one of this agent's tasks made the commit `head`. */
  madeHead(head: string): boolean {
    return this.sql.exec("SELECT 1 FROM tasks WHERE head = ?", head).toArray().length > 0;
  }

  /** Record the proposal a task opened. */
  linked(seq: number, proposalId: string): void {
    this.sql.exec("UPDATE tasks SET proposal_id = ? WHERE seq = ?", proposalId, seq);
  }

  private event(seq: number, text: string): void {
    this.sql.exec("INSERT INTO events (task_seq, at, text) VALUES (?, ?, ?)", seq, Date.now(), text);
    // Tell the project, so that the page sees the step.
    const identity = JSON.parse(this.row()!.identity) as AgentIdentity;
    this.ctx.waitUntil(this.env.PROJECTS.get(this.env.PROJECTS.idFromName(identity.projectId)).touch());
  }

  private async pause(): Promise<void> {
    const ms = Number(this.env.AGENT_STEP_MS ?? 0);
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
  }

  async alarm(): Promise<void> {
    this.columns();
    const next = this.sql.exec<TaskRow>("SELECT * FROM tasks WHERE status = 'queued' ORDER BY seq LIMIT 1").toArray()[0];
    if (!next) return;
    this.sql.exec("UPDATE tasks SET status = 'working' WHERE seq = ?", next.seq);
    try {
      await this.run(next);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sql.exec("UPDATE tasks SET status = 'failed', error = ? WHERE seq = ?", message, next.seq);
      this.event(next.seq, `Stopped: ${message}`);
    }
    if (this.sql.exec("SELECT 1 FROM tasks WHERE status = 'queued'").toArray().length > 0) {
      await this.ctx.storage.setAlarm(Date.now());
    }
  }

  private async run(task: TaskRow): Promise<void> {
    const row = this.row()!;
    const identity = JSON.parse(row.identity) as AgentIdentity;
    const fork = row.fork!;
    const token = JSON.parse(row.token!) as RepoToken;
    const host = repoHost(this.env);
    const script = taskById(identity.agentId, task.task_id);
    const shortFp = row.fingerprint.slice(0, 15);

    this.event(task.seq, `Started "${task.title}" with key ${shortFp}…`);
    await this.pause();
    const repo = await memoryRepo();
    const transport = await host.transport(fork, token);
    await transport.clone(repo);
    const base = await resolve(repo, "refs/heads/main");
    if (!base) throw new Error(`fork ${fork} has no main`);
    this.event(task.seq, `Cloned fork ${fork} at ${base.slice(0, 7)}.`);
    await this.pause();

    const baseCommit = await readCommit(repo, base);
    const client = noteClient(this.env);
    const changes = await script.edit({
      agentId: identity.agentId,
      agentName: identity.name,
      publicKey: row.public_key,
      read: (path) => readText(repo, baseCommit.tree, path),
      list: async (dir) => [...(await listFiles(repo, baseCommit.tree))].map(([p]) => p).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)),
      args: task.args ? (JSON.parse(task.args) as { topic?: string }) : {},
      say: (text) => this.event(task.seq, text),
      ...(client ? { writeNote: (input) => writeNote(client, input) } : {}),
    });
    const tree = await changeFiles(repo, baseCommit.tree, changes);
    this.event(task.seq, `Edited ${Object.keys(changes).join(", ")}.`);
    await this.pause();

    const privateKey = await crypto.subtle.importKey("jwk", JSON.parse(row.private_key), { name: "Ed25519" }, false, ["sign"]);
    const now = Date.now();
    const author = {
      name: `${identity.name} (agent of ${identity.controller})`,
      email: `${identity.agentId}@agents.forge.invalid`,
      timestamp: Math.floor(now / 1000),
      timezoneOffset: 0,
    };
    const head = await commitSigned(repo, {
      tree,
      parents: [base],
      message: script.id === "llm-note" ? noteMessage(identity.agentId) : script.message,
      author,
      key: { privateKey, publicKey: parsePublicKeyText(row.public_key) },
    });
    this.sql.exec("UPDATE tasks SET head = ? WHERE seq = ?", head, task.seq);
    this.event(task.seq, `Signed commit ${head.slice(0, 7)} with ${shortFp}….`);
    await this.pause();

    await setRef(repo, `refs/heads/${task.branch}`, head);
    await transport.push(repo, `refs/heads/${task.branch}`, `refs/heads/${task.branch}`, null);
    this.event(task.seq, `Pushed ${task.branch} to fork ${fork}.`);
    await this.pause();

    const project = this.env.PROJECTS.get(this.env.PROJECTS.idFromName(identity.projectId));
    const proposalId = await project.propose({
      agentId: identity.agentId,
      taskSeq: task.seq,
      taskId: task.task_id,
      title: task.title,
      branch: task.branch,
      head,
    });
    this.sql.exec("UPDATE tasks SET status = 'proposed', proposal_id = ? WHERE seq = ?", proposalId, task.seq);
    this.event(task.seq, `Proposed ${task.branch} for main.`);
  }

  snapshot(): Pick<AgentState, "publicKey" | "fingerprint" | "tokenExpiresAt" | "tasks"> | null {
    this.columns();
    const row = this.row();
    if (!row) return null;
    const events = this.sql.exec<{ task_seq: number; at: number; text: string }>("SELECT task_seq, at, text FROM events ORDER BY seq").toArray();
    const tasks = this.sql.exec<TaskRow>("SELECT * FROM tasks ORDER BY seq").toArray();
    return {
      publicKey: row.public_key,
      fingerprint: row.fingerprint,
      tokenExpiresAt: row.token ? (JSON.parse(row.token) as RepoToken).expiresAt : null,
      tasks: tasks.map((t) => ({
        id: t.task_id,
        title: t.title,
        branch: t.branch,
        rogue: t.rogue === 1,
        status: t.status,
        events: events.filter((e) => e.task_seq === t.seq).map((e): TaskEvent => ({ at: e.at, text: e.text })),
        head: t.head,
        proposalId: t.proposal_id,
        error: t.error,
      })),
    };
  }

  async destroy(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.schema();
  }
}
