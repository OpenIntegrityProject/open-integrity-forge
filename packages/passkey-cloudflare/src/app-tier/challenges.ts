import { DurableObject } from "cloudflare:workers";
import type { Ceremony } from "../refusal.ts";
import { prefixedInstance } from "../storage-prefix.ts";

// Purpose-tagged, single-use challenges. Only the SHA-256 hash of a challenge
// is stored. Consuming a challenge removes it whatever the outcome, and a
// purpose mismatch is refused exactly like an unknown challenge.

export const CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;

export class ChallengeStore<Env = unknown> extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS challenges (
      hash TEXT PRIMARY KEY,
      purpose TEXT NOT NULL,
      payload TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`);
  }

  async issue(hash: string, purpose: Ceremony, payload: unknown, now: number): Promise<void> {
    const expiresAt = now + CHALLENGE_LIFETIME_MS;
    this.sql.exec(
      "INSERT INTO challenges (hash, purpose, payload, expires_at) VALUES (?, ?, ?, ?)",
      hash,
      purpose,
      JSON.stringify(payload ?? null),
      expiresAt,
    );
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + CHALLENGE_LIFETIME_MS);
    }
  }

  /**
   * Take a challenge. Returns its payload, as JSON text, only if it exists, has
   * this purpose and has not expired.
   */
  consume(hash: string, purpose: Ceremony, now: number): string | null {
    const row = this.sql
      .exec<{ purpose: string; payload: string; expires_at: number }>(
        "SELECT purpose, payload, expires_at FROM challenges WHERE hash = ?",
        hash,
      )
      .toArray()[0];
    this.sql.exec("DELETE FROM challenges WHERE hash = ?", hash);
    if (!row || row.purpose !== purpose || row.expires_at <= now) return null;
    return row.payload;
  }

  async alarm(): Promise<void> {
    this.sql.exec("DELETE FROM challenges WHERE expires_at <= ?", Date.now());
    const remaining = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM challenges").one().n;
    if (remaining > 0) await this.ctx.storage.setAlarm(Date.now() + CHALLENGE_LIFETIME_MS);
  }
}

/**
 * The challenge store that holds a challenge, by its hash, under `storagePrefix`.
 * Challenges are spread over sixteen objects by the first hex digit of their hash.
 */
export function challengeStores(binding: DurableObjectNamespace<ChallengeStore>, storagePrefix?: string) {
  return (hash: string) => prefixedInstance(binding, storagePrefix, `challenges-${hash[0]}`);
}
