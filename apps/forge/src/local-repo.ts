import { DurableObject } from "cloudflare:workers";
import { sha256, toHex } from "../authority/bytes.ts";

// A Git repository in a Durable Object, for local development and tests,
// where no Artifacts namespace is available. It keeps the parts of the
// Artifacts contract that the demo uses. These are tokens for one repository
// with a scope and an expiry, and forks. A push must name the value of each
// ref that it replaces. It stores loose Git objects in the form that
// isomorphic-git writes. Thus a Git client can also clone it over the dumb
// HTTP protocol (see src/local-git-http.ts).

type Scope = "read" | "write";

export interface RepoDump {
  refs: Record<string, string>;
  objects: [string, Uint8Array][];
}

interface RefUpdate {
  ref: string;
  /** The value the pusher expects the ref to hold now, or null for a new ref. */
  old: string | null;
  new: string;
}

type UploadResult = { ok: true } | { ok: false; error: string };

export class LocalRepo extends DurableObject {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.schema();
  }

  /** Create the tables. It runs again after deleteAll, which drops them while this instance stays in memory. */
  private schema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS objects (oid TEXT PRIMARY KEY, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS refs (name TEXT PRIMARY KEY, oid TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, scope TEXT NOT NULL, expires_at INTEGER NOT NULL);
    `);
  }

  /** Whether the repository exists. */
  exists(): boolean {
    return this.sql.exec("SELECT 1 FROM meta WHERE key = 'created'").toArray().length > 0;
  }

  /** Create the repository, empty or from the dump of another one. Returns false if the repository exists. */
  create(name: string, from?: RepoDump): boolean {
    if (this.exists()) return false;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT INTO meta (key, value) VALUES ('created', ?), ('name', ?)", String(Date.now()), name);
      if (from) this.write(from.objects, Object.entries(from.refs));
    });
    return true;
  }

  private write(objects: [string, Uint8Array][], refs: [string, string][]): void {
    for (const [oid, data] of objects) this.sql.exec("INSERT OR IGNORE INTO objects (oid, data) VALUES (?, ?)", oid, data);
    for (const [name, oid] of refs) this.sql.exec("INSERT OR REPLACE INTO refs (name, oid) VALUES (?, ?)", name, oid);
  }

  /** Everything in the repository, for a fork. Platform code only: it needs no token. */
  dump(): RepoDump {
    return { refs: this.refs(), objects: this.allObjects() };
  }

  private refs(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const row of this.sql.exec<{ name: string; oid: string }>("SELECT name, oid FROM refs")) out[row.name] = row.oid;
    return out;
  }

  private allObjects(): [string, Uint8Array][] {
    return this.sql
      .exec<{ oid: string; data: ArrayBuffer }>("SELECT oid, data FROM objects")
      .toArray()
      .map((row) => [row.oid, new Uint8Array(row.data)]);
  }

  /** A new token for this repository. The secret has the Artifacts form, with an expiry suffix. */
  async mintToken(scope: Scope, ttlSeconds: number): Promise<{ secret: string; expiresAt: number }> {
    if (!this.exists()) throw new Error("no such repository");
    const raw = toHex(crypto.getRandomValues(new Uint8Array(20)));
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.sql.exec(
      "INSERT INTO tokens (hash, scope, expires_at) VALUES (?, ?, ?)",
      toHex(await sha256(raw)),
      scope,
      expiresAt,
    );
    return { secret: `lrt_v1_${raw}?expires=${Math.floor(expiresAt / 1000)}`, expiresAt };
  }

  /** Whether `secret` is a live token of this repository with at least scope `need`. */
  private async allows(secret: string, need: Scope): Promise<boolean> {
    if (!this.exists()) return false;
    const raw = secret.split("?expires=")[0]!.replace(/^lrt_v1_/, "");
    const row = this.sql
      .exec<{ scope: Scope; expires_at: number }>("SELECT scope, expires_at FROM tokens WHERE hash = ?", toHex(await sha256(raw)))
      .toArray()[0];
    if (!row || row.expires_at <= Date.now()) return false;
    return need === "read" || row.scope === "write";
  }

  async revokeToken(secret: string): Promise<void> {
    const raw = secret.split("?expires=")[0]!.replace(/^lrt_v1_/, "");
    this.sql.exec("DELETE FROM tokens WHERE hash = ?", toHex(await sha256(raw)));
  }

  async download(secret: string): Promise<RepoDump | null> {
    if (!(await this.allows(secret, "read"))) return null;
    return this.dump();
  }

  /** The refs alone, for the dumb HTTP protocol. */
  async listRefs(secret: string): Promise<Record<string, string> | null> {
    return (await this.allows(secret, "read")) ? this.refs() : null;
  }

  /** One loose object, as its file holds it, for the dumb HTTP protocol. */
  async object(secret: string, oid: string): Promise<Uint8Array | null> {
    if (!(await this.allows(secret, "read"))) return null;
    const row = this.sql.exec<{ data: ArrayBuffer }>("SELECT data FROM objects WHERE oid = ?", oid).toArray()[0];
    return row ? new Uint8Array(row.data) : null;
  }

  /** Store objects and move refs. Each ref moves only if it holds the value the pusher expects. */
  async upload(secret: string, objects: [string, Uint8Array][], updates: RefUpdate[]): Promise<UploadResult> {
    if (!(await this.allows(secret, "write"))) return { ok: false, error: "the token does not allow a push" };
    const refs = this.refs();
    for (const u of updates) {
      if ((refs[u.ref] ?? null) !== u.old) return { ok: false, error: `${u.ref} moved; fetch and try again` };
    }
    this.ctx.storage.transactionSync(() => this.write(objects, updates.map((u) => [u.ref, u.new])));
    return { ok: true };
  }

  async destroy(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.schema();
  }
}
