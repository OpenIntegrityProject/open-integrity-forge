import type { Ceremony } from "./refusal.ts";

// The internal record of a refused ceremony. Outside, every refusal looks the
// same; here each keeps its cause. Stored in the record's object when the
// refusal resolved to a record, and in CeremonyFailures otherwise.

export interface CeremonyFailure {
  ceremony: Ceremony;
  cause: string;
  at: number;
  /** SHA-256 of the source address, never the address itself. */
  sourceHash: string;
}

export const FAILURE_SCHEMA = `CREATE TABLE IF NOT EXISTS failures (
  at INTEGER NOT NULL,
  ceremony TEXT NOT NULL,
  cause TEXT NOT NULL,
  source_hash TEXT NOT NULL
)`;

export function insertFailure(sql: SqlStorage, failure: CeremonyFailure): void {
  sql.exec(
    "INSERT INTO failures (at, ceremony, cause, source_hash) VALUES (?, ?, ?, ?)",
    failure.at,
    failure.ceremony,
    failure.cause,
    failure.sourceHash,
  );
}
