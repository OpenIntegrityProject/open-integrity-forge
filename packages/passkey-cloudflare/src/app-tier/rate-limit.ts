import { DurableObject } from "cloudflare:workers";
import { prefixedInstance } from "../storage-prefix.ts";

// Sliding-window rate limits, one Durable Object per bucket.

export interface Limit {
  limit: number;
  windowMs: number;
}

export interface RateLimits {
  /** Every ceremony completion from one source address. */
  ceremonyPerSource: Limit;
  /** Anonymous ceremony completions (register, login, recover, rebind) from everywhere. */
  ceremonyGlobal: Limit;
  /** Anonymous ceremony options from one source address. */
  optionsPerSource: Limit;
  /** Member-name availability checks from one source address. */
  nameCheckPerSource: Limit;
  /** Recovery attempts from one source address. */
  recoverPerSource: Limit;
  /** Recovery attempts from everywhere. */
  recoverGlobal: Limit;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export const DEFAULT_RATE_LIMITS: RateLimits = {
  ceremonyPerSource: { limit: 30, windowMs: MINUTE },
  ceremonyGlobal: { limit: 6000, windowMs: MINUTE },
  optionsPerSource: { limit: 60, windowMs: MINUTE },
  nameCheckPerSource: { limit: 60, windowMs: MINUTE },
  recoverPerSource: { limit: 10, windowMs: HOUR },
  recoverGlobal: { limit: 1000, windowMs: HOUR },
};

export class RateLimiter<Env = unknown> extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS hits (at INTEGER NOT NULL)");
  }

  /** Count one hit. Returns false, without counting it, if the bucket is already full. */
  hit(limit: Limit, now: number): boolean {
    this.sql.exec("DELETE FROM hits WHERE at <= ?", now - limit.windowMs);
    const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM hits").one().n;
    if (count >= limit.limit) return false;
    this.sql.exec("INSERT INTO hits (at) VALUES (?)", now);
    return true;
  }
}

/** The rate limiter for a bucket, under `storagePrefix`. */
export function rateLimiters(binding: DurableObjectNamespace<RateLimiter>, storagePrefix?: string) {
  return (bucket: string) => prefixedInstance(binding, storagePrefix, bucket);
}
