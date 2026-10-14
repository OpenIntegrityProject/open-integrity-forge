import { DurableObject } from "cloudflare:workers";
import type { PromoterKey, ProjectListing } from "./state.ts";

// What the forge keeps about one person, by identity record id: their
// promoter key, their projects and their recent approval requests. The
// identity layer keeps the rest.

const PREPARES_PER_MINUTE = 30;

export class Person extends DurableObject {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS promoter (id INTEGER PRIMARY KEY CHECK (id = 0), key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS prepares (at INTEGER NOT NULL);
    `);
  }

  promoter(): PromoterKey | null {
    const row = this.sql.exec<{ key: string }>("SELECT key FROM promoter").toArray()[0];
    return row ? (JSON.parse(row.key) as PromoterKey) : null;
  }

  setPromoter(key: PromoterKey): void {
    this.sql.exec("INSERT OR REPLACE INTO promoter (id, key) VALUES (0, ?)", JSON.stringify(key));
  }

  projects(): ProjectListing[] {
    return this.sql
      .exec<{ id: string; name: string; created_at: number }>("SELECT id, name, created_at FROM projects ORDER BY created_at DESC")
      .toArray()
      .map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at }));
  }

  addProject(listing: ProjectListing): void {
    this.sql.exec("INSERT OR REPLACE INTO projects (id, name, created_at) VALUES (?, ?, ?)", listing.id, listing.name, listing.createdAt);
  }

  removeProject(id: string): void {
    this.sql.exec("DELETE FROM projects WHERE id = ?", id);
  }

  /** Count one approval request. Returns false when the person made too many in the last minute. */
  allowPrepare(now: number): boolean {
    this.sql.exec("DELETE FROM prepares WHERE at <= ?", now - 60_000);
    const n = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM prepares").one().n;
    if (n >= PREPARES_PER_MINUTE) return false;
    this.sql.exec("INSERT INTO prepares (at) VALUES (?)", now);
    return true;
  }
}
