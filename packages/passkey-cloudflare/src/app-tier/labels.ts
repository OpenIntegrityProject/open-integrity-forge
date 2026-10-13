import { DurableObject } from "cloudflare:workers";
import { bytewordsIdentifier, bytewordToken } from "../gordian/bytewords.ts";
import { LABEL_BYTES, labelDraws } from "./label-draws.ts";
import type { RecordId } from "../identity/secrets.ts";
import { prefixedInstance } from "../storage-prefix.ts";

// A per-record namespace of credential labels. A label is minted when a
// ceremony starts, bound to a credential before the record commits it, and
// retired when the credential is revoked. A credential with no label is given
// one when it is next listed. Labels are never reused within a record.
//
// A label is three random bytes, stored as those bytes. It is spelled as
// Bytewords with no checksum, lower case and hyphenated, `wand-meow-nail`,
// wherever it is shown or typed, and this module's methods take and return
// that spelling. It names a passkey; it is not a Bytewords encoding.

/** Draws before minting gives up. At half full, all of them are taken about once in 10^19 mints. */
const MINT_TRIES = 64;

/**
 * A label drawn at random and not checked against any namespace. A label that
 * turns out to be taken when it is bound refuses the ceremony.
 */
export function randomLabel(): string {
  return bytesToLabel(labelDraws.draw());
}

/**
 * The label a person typed, spelled as this library shows it, or null if it is not one:
 * any case, words separated by spaces or hyphens, each word whole or as its
 * first and last letters. Three-letter tokens are refused: twelve are one
 * word's first three letters and another's last three (`wan` is wand or
 * swan), and a label has no CRC32 to catch the wrong pick.
 */
export function parseLabel(text: string): string | null {
  const bytes = labelBytes(text);
  return bytes && bytesToLabel(bytes);
}

/** The bytes of a label in any form `parseLabel` reads, or null if it is not one. */
function labelBytes(text: string): Uint8Array | null {
  const tokens = text.trim().split(/[ -]+/);
  if (tokens.some((t) => t.length === 3)) return null;
  const bytes = tokens.map(bytewordToken);
  if (bytes.length !== LABEL_BYTES || bytes.some((b) => b === null)) return null;
  return Uint8Array.from(bytes as number[]);
}

/** The bytes of a label this library spelled, which is always one. */
function labelToBytes(label: string): Uint8Array {
  const bytes = labelBytes(label);
  if (!bytes) throw new Error("not a credential label");
  return bytes;
}

function bytesToLabel(bytes: Uint8Array): string {
  return bytewordsIdentifier(bytes, "-");
}

export class CredentialLabels<Env = unknown> extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS labels (
      label BLOB PRIMARY KEY,
      credential_id TEXT UNIQUE,
      minted_at INTEGER NOT NULL,
      retired_at INTEGER
    )`);
  }

  /**
   * Mint a label never used in this namespace. Throws after MINT_TRIES draws
   * that are all taken, rather than searching a namespace that may be full.
   */
  mint(now: number): string {
    for (let tries = 0; tries < MINT_TRIES; tries++) {
      const bytes = labelDraws.draw();
      const taken = this.sql.exec("SELECT 1 FROM labels WHERE label = ?", bytes).toArray().length > 0;
      if (!taken) {
        this.sql.exec("INSERT INTO labels (label, minted_at) VALUES (?, ?)", bytes, now);
        return bytesToLabel(bytes);
      }
    }
    throw new Error(`no free credential label after ${MINT_TRIES} tries`);
  }

  /**
   * Bind a label to a credential, returning whether the credential now holds
   * it. A label minted elsewhere is recorded here first. A label taken by
   * another credential or retired is not bound, and a credential that already
   * has a label keeps it.
   */
  bind(label: string, credentialId: string, now: number): boolean {
    const held = this.labelOf(credentialId);
    if (held !== null) return held === label;
    this.sql.exec(
      `INSERT INTO labels (label, credential_id, minted_at) VALUES (?, ?, ?)
       ON CONFLICT (label) DO UPDATE SET credential_id = excluded.credential_id
       WHERE labels.credential_id IS NULL AND labels.retired_at IS NULL`,
      labelToBytes(label),
      credentialId,
      now,
    );
    return this.labelOf(credentialId) === label;
  }

  /** The label a credential has or had. A credential has at most one, retired or not. */
  private labelOf(credentialId: string): string | null {
    const row = this.sql
      .exec<{ label: ArrayBuffer }>("SELECT label FROM labels WHERE credential_id = ?", credentialId)
      .toArray()[0];
    return row ? bytesToLabel(new Uint8Array(row.label)) : null;
  }

  /** The credential an active label names. */
  resolve(label: string): string | null {
    const row = this.sql
      .exec<{ credential_id: string | null }>(
        "SELECT credential_id FROM labels WHERE label = ? AND retired_at IS NULL",
        labelToBytes(label),
      )
      .toArray()[0];
    return row?.credential_id ?? null;
  }

  retire(label: string, now: number): void {
    this.sql.exec("UPDATE labels SET retired_at = ? WHERE label = ?", now, labelToBytes(label));
  }

  /**
   * The label of each credential, minting one for any credential that never
   * had one. A credential revoked since its caller
   * listed it keeps its retired label rather than gaining an active one.
   */
  labelEach(credentialIds: readonly string[], now: number): Record<string, string> {
    const out: Record<string, string> = {};
    for (const credentialId of credentialIds) {
      let label = this.labelOf(credentialId);
      if (label === null) {
        label = this.mint(now);
        this.bind(label, credentialId, now);
      }
      out[credentialId] = label;
    }
    return out;
  }
}

/** A record's credential labels, under `storagePrefix`. */
export function credentialLabels(binding: DurableObjectNamespace<CredentialLabels>, storagePrefix?: string) {
  return (recordId: RecordId) => prefixedInstance(binding, storagePrefix, recordId);
}
