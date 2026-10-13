import { DurableObject } from "cloudflare:workers";
import type { RecordId } from "./secrets.ts";
import { prefixedInstance } from "../storage-prefix.ts";

// The one global lookup on the login path: credential id to record id. A
// Durable Object rather than KV, because KV is eventually consistent.
//
// It also holds the RP ID the indexed credentials were made for, stored with
// the first credential and dropped with the last, so that a deployment whose
// RP ID changes can be told why its passkeys stopped working.

export class CredentialIndex<Env = unknown> extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS credentials (credential_id TEXT PRIMARY KEY, record_id TEXT NOT NULL)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS relying_party (id INTEGER PRIMARY KEY CHECK (id = 0), rp_id TEXT NOT NULL)",
    );
  }

  /**
   * Bind a credential id to a record, made for `rpId`, which is stored if no
   * RP ID is yet. Refuses an id that is already bound.
   */
  put(credentialId: string, recordId: RecordId, rpId: string): boolean {
    const existing = this.sql
      .exec("SELECT 1 FROM credentials WHERE credential_id = ?", credentialId)
      .toArray();
    if (existing.length > 0) return false;
    this.sql.exec("INSERT INTO credentials (credential_id, record_id) VALUES (?, ?)", credentialId, recordId);
    this.sql.exec("INSERT OR IGNORE INTO relying_party (id, rp_id) VALUES (0, ?)", rpId);
    return true;
  }

  /** The RP ID the indexed credentials were made for, or null while there are none. */
  rpId(): string | null {
    const row = this.sql.exec<{ rp_id: string }>("SELECT rp_id FROM relying_party").toArray()[0];
    return row?.rp_id ?? null;
  }

  get(credentialId: string): RecordId | null {
    const row = this.sql
      .exec<{ record_id: RecordId }>("SELECT record_id FROM credentials WHERE credential_id = ?", credentialId)
      .toArray()[0];
    return row?.record_id ?? null;
  }

  /** Unbind a credential id. Removing the last one drops the stored RP ID. */
  delete(credentialId: string): void {
    this.sql.exec("DELETE FROM credentials WHERE credential_id = ?", credentialId);
    this.sql.exec("DELETE FROM relying_party WHERE NOT EXISTS (SELECT 1 FROM credentials)");
  }
}

/** The one credential index, under `storagePrefix`. */
export function credentialIndex(binding: DurableObjectNamespace<CredentialIndex>, storagePrefix?: string) {
  return () => prefixedInstance(binding, storagePrefix, "global");
}
