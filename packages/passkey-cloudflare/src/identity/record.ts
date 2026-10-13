import { DurableObject } from "cloudflare:workers";
import { FAILURE_SCHEMA, insertFailure, type CeremonyFailure } from "../failures.ts";
import { addColumnIfMissing } from "../sql.ts";
import type { RecordId } from "./secrets.ts";
import {
  FLAG_BACKED_UP,
  FLAG_BACKUP_ELIGIBLE,
  isUserVerified,
  type CredentialDescriptor,
  type VerifiedCredential,
} from "./webauthn.ts";
import { prefixedInstance } from "../storage-prefix.ts";

// One Durable Object per identity record. It holds the record, its credentials,
// sessions, recovery-code hashes, suspension and removal state and failure
// rows. It sees only ids and hashes: never a label, a member name, a session
// token or a code.

export const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export const STEP_UP_WINDOW_MS = 10 * 60 * 1000;
export const RECOVERY_ATTEMPTS_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;
export const REBIND_LINK_LIFETIME_MS = 24 * HOUR_MS;

export interface NewSession {
  id: string;
  tokenHash: string;
  userAgent: string;
  /** Whether the passkey ceremony that started the session was user-verified. */
  userVerified: boolean;
}

export interface Principal {
  recordId: RecordId;
  kind: "person" | "agent";
  sessionId: string;
}

export interface SessionSummary {
  id: string;
  createdAt: number;
  expiresAt: number;
  userAgent: string;
  current: boolean;
  /** Whether the passkey ceremony that started the session was user-verified. */
  userVerified: boolean;
  /** Whether the session's latest step-up was user-verified, or null if it has none. */
  stepUpUserVerified: boolean | null;
}

/** A record's state and counts, read without a session. */
export interface RecordSummary {
  createdAt: number;
  suspendedAt: number | null;
  removedAt: number | null;
  passkeys: number;
  sessions: number;
  recoveryCodesLeft: number;
  rebindLinkOutstanding: boolean;
}

export interface CredentialSummary {
  id: string;
  createdAt: number;
  lastUsedAt: number | null;
  aaguid: string;
  backupEligible: boolean;
  backedUp: boolean;
}

/** Why a session may not perform an action. */
export type SessionCause = "not-logged-in" | "step-up-required";

/** What a session-gated action needs of the presented session. */
export type SessionNeed = "live" | "stepped-up";

/** Why the record refused an operation. */
export type RecordCause =
  | SessionCause
  | "record-exists"
  | "unknown-record"
  | "suspended"
  | "removed"
  | "unknown-credential"
  | "counter-regressed"
  | "backup-eligibility-changed"
  | "wrong-session"
  | "not-found"
  | "last-credential"
  | "recovery-throttled"
  | "wrong-recovery-code"
  | "bad-rebind-link";

export type RecordResult<T = {}, C extends RecordCause = RecordCause> = ({ ok: true } & T) | { ok: false; cause: C };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS record (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('person', 'agent')),
  created_at INTEGER NOT NULL,
  suspended_at INTEGER,
  removed_at INTEGER
);
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  public_key BLOB NOT NULL,
  algorithm INTEGER NOT NULL,
  sign_count INTEGER NOT NULL,
  registration_flags INTEGER NOT NULL,
  last_flags INTEGER,
  aaguid TEXT NOT NULL,
  transports TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  prf_public_key BLOB
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT NOT NULL,
  user_verified INTEGER NOT NULL,
  step_up_at INTEGER,
  step_up_user_verified INTEGER
);
CREATE TABLE IF NOT EXISTS recovery_codes (
  code_hash TEXT PRIMARY KEY,
  issued_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS recovery_attempts (
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rebind_tokens (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
`;

type RecordRow = { id: RecordId; kind: "person" | "agent"; suspended_at: number | null; removed_at: number | null };

export class IdentityRecord<Env = unknown> extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
    this.sql.exec(FAILURE_SCHEMA);
    addColumnIfMissing(this.sql, "record", "removed_at", "INTEGER");
  }

  private recordRow(): RecordRow | undefined {
    return this.sql.exec<RecordRow>("SELECT id, kind, suspended_at, removed_at FROM record").toArray()[0];
  }

  private insertCredential(credential: VerifiedCredential, now: number): void {
    this.sql.exec(
      `INSERT INTO credentials (id, public_key, algorithm, sign_count, registration_flags, aaguid, transports, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      credential.id,
      credential.publicKey,
      credential.algorithm,
      credential.signCount,
      credential.registrationFlags,
      credential.aaguid,
      JSON.stringify(credential.transports),
      now,
    );
  }

  private insertSession(session: NewSession, now: number): void {
    this.sql.exec(
      "INSERT INTO sessions (id, token_hash, created_at, expires_at, user_agent, user_verified) VALUES (?, ?, ?, ?, ?, ?)",
      session.id,
      session.tokenHash,
      now,
      now + SESSION_LIFETIME_MS,
      session.userAgent,
      session.userVerified ? 1 : 0,
    );
  }

  /** Create a person's record with its first credential, recovery codes and a session, in one transaction. */
  createPerson(input: {
    recordId: RecordId;
    credential: VerifiedCredential;
    recoveryCodeHashes: string[];
    session: NewSession;
    now: number;
  }): RecordResult {
    if (this.recordRow()) return { ok: false, cause: "record-exists" };
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT INTO record (id, kind, created_at) VALUES (?, 'person', ?)",
        input.recordId,
        input.now,
      );
      this.insertCredential(input.credential, input.now);
      for (const hash of input.recoveryCodeHashes) {
        this.sql.exec("INSERT INTO recovery_codes (code_hash, issued_at) VALUES (?, ?)", hash, input.now);
      }
      this.insertSession(input.session, input.now);
    });
    return { ok: true };
  }

  /** What the Worker needs to verify an assertion by one of this record's credentials. */
  credentialForAssertion(
    credentialId: string,
  ): { publicKey: Uint8Array<ArrayBuffer>; signCount: number; enforceCounter: boolean } | null {
    const row = this.sql
      .exec<{ public_key: ArrayBuffer; sign_count: number; registration_flags: number }>(
        "SELECT public_key, sign_count, registration_flags FROM credentials WHERE id = ?",
        credentialId,
      )
      .toArray()[0];
    if (!row) return null;
    return {
      publicKey: new Uint8Array(row.public_key),
      signCount: row.sign_count,
      enforceCounter: (row.registration_flags & FLAG_BACKUP_ELIGIBLE) === 0,
    };
  }

  /**
   * Record a verified assertion: check its backup-eligible bit and sign
   * counter against the stored ones, then update the credential. Returns the
   * cause if the assertion must be refused. Runs inside the caller's
   * transaction.
   */
  private acceptAssertion(
    credentialId: string,
    signCount: number,
    flags: number,
    now: number,
  ): "unknown-credential" | "counter-regressed" | "backup-eligibility-changed" | null {
    const row = this.sql
      .exec<{ sign_count: number; registration_flags: number }>(
        "SELECT sign_count, registration_flags FROM credentials WHERE id = ?",
        credentialId,
      )
      .toArray()[0];
    if (!row) return "unknown-credential";
    // The backup-eligible bit decides counter enforcement, so it must not
    // change after registration (WebAuthn Level 3, section 7.2).
    if ((flags & FLAG_BACKUP_ELIGIBLE) !== (row.registration_flags & FLAG_BACKUP_ELIGIBLE)) {
      return "backup-eligibility-changed";
    }
    const enforce = (row.registration_flags & FLAG_BACKUP_ELIGIBLE) === 0;
    if (enforce && (signCount > 0 || row.sign_count > 0) && signCount <= row.sign_count) {
      return "counter-regressed";
    }
    this.sql.exec(
      "UPDATE credentials SET sign_count = ?, last_flags = ?, last_used_at = ? WHERE id = ?",
      Math.max(signCount, row.sign_count),
      flags,
      now,
      credentialId,
    );
    return null;
  }

  /** Why this record cannot take part in a ceremony now, or null if it can. */
  private unavailableCause(): "unknown-record" | "removed" | "suspended" | null {
    const record = this.recordRow();
    if (!record) return "unknown-record";
    if (record.removed_at !== null) return "removed";
    if (record.suspended_at !== null) return "suspended";
    return null;
  }

  /** Complete a login: accept the verified assertion and mint a session, in one transaction. */
  completeLogin(input: {
    credentialId: string;
    signCount: number;
    flags: number;
    session: NewSession;
    now: number;
  }): RecordResult {
    const refused = this.unavailableCause();
    if (refused) return { ok: false, cause: refused };
    return this.ctx.storage.transactionSync((): RecordResult => {
      const cause = this.acceptAssertion(input.credentialId, input.signCount, input.flags, input.now);
      if (cause) return { ok: false, cause };
      this.insertSession(input.session, input.now);
      return { ok: true };
    });
  }

  /** End one session. Returns its id, or null if it was not live. */
  revokeSession(tokenHash: string): string | null {
    const row = this.sql
      .exec<{ id: string }>("DELETE FROM sessions WHERE token_hash = ? RETURNING id", tokenHash)
      .toArray()[0];
    return row?.id ?? null;
  }

  /**
   * The session gate, and the one place its rules live. The presented session
   * passes as "live" if the record can take part in a ceremony and the session
   * has not expired, and as "stepped-up" if it is live and completed a step-up
   * within the window. Every session-gated method applies it before acting.
   */
  private gate(
    tokenHash: string,
    now: number,
    need: SessionNeed,
  ): RecordResult<{ principal: Principal }, SessionCause> {
    const record = this.recordRow();
    if (!record || this.unavailableCause() !== null) return { ok: false, cause: "not-logged-in" };
    const session = this.sql
      .exec<{ id: string; expires_at: number; step_up_at: number | null }>(
        "SELECT id, expires_at, step_up_at FROM sessions WHERE token_hash = ?",
        tokenHash,
      )
      .toArray()[0];
    if (!session || session.expires_at <= now) return { ok: false, cause: "not-logged-in" };
    if (need === "stepped-up" && (session.step_up_at === null || now - session.step_up_at > STEP_UP_WINDOW_MS)) {
      return { ok: false, cause: "step-up-required" };
    }
    return { ok: true, principal: { recordId: record.id, kind: record.kind, sessionId: session.id } };
  }

  /**
   * Whether the presented session may perform step-up-gated actions now. For
   * a caller that must check the gate before calling another object.
   */
  checkStepUp(tokenHash: string, now: number): RecordResult<{ sessionId: string }, SessionCause> {
    const gate = this.gate(tokenHash, now, "stepped-up");
    if (!gate.ok) return gate;
    return { ok: true, sessionId: gate.principal.sessionId };
  }

  /** The ids and stored transports of this record's credentials, for a session that passes the gate. */
  credentialDescriptors(
    tokenHash: string,
    now: number,
    need: SessionNeed,
  ): RecordResult<{ sessionId: string; descriptors: CredentialDescriptor[] }, SessionCause> {
    const gate = this.gate(tokenHash, now, need);
    if (!gate.ok) return gate;
    return { ok: true, sessionId: gate.principal.sessionId, descriptors: this.descriptors() };
  }

  private descriptors(): CredentialDescriptor[] {
    return this.sql
      .exec<{ id: string; transports: string }>("SELECT id, transports FROM credentials ORDER BY created_at")
      .toArray()
      .map((r) => ({ id: r.id, transports: JSON.parse(r.transports) as string[] }));
  }

  /** Complete a step-up on the session that asked for it. */
  completeStepUp(input: {
    tokenHash: string;
    sessionId: string;
    credentialId: string;
    signCount: number;
    flags: number;
    now: number;
  }): RecordResult {
    const gate = this.gate(input.tokenHash, input.now, "live");
    if (!gate.ok || gate.principal.sessionId !== input.sessionId) return { ok: false, cause: "wrong-session" };
    return this.ctx.storage.transactionSync((): RecordResult => {
      const cause = this.acceptAssertion(input.credentialId, input.signCount, input.flags, input.now);
      if (cause) return { ok: false, cause };
      this.sql.exec(
        "UPDATE sessions SET step_up_at = ?, step_up_user_verified = ? WHERE id = ?",
        input.now,
        isUserVerified(input.flags) ? 1 : 0,
        gate.principal.sessionId,
      );
      return { ok: true };
    });
  }

  /** Add a credential for a stepped-up session. */
  addCredential(input: { tokenHash: string; sessionId: string; credential: VerifiedCredential; now: number }): RecordResult {
    const gate = this.gate(input.tokenHash, input.now, "stepped-up");
    if (!gate.ok) return gate;
    if (gate.principal.sessionId !== input.sessionId) return { ok: false, cause: "wrong-session" };
    this.insertCredential(input.credential, input.now);
    return { ok: true };
  }

  /** This record's credentials, for a live session. */
  listCredentials(tokenHash: string, now: number): RecordResult<{ credentials: CredentialSummary[] }, SessionCause> {
    const gate = this.gate(tokenHash, now, "live");
    if (!gate.ok) return gate;
    const credentials = this.sql
      .exec<{
        id: string;
        created_at: number;
        last_used_at: number | null;
        aaguid: string;
        registration_flags: number;
        last_flags: number | null;
      }>("SELECT id, created_at, last_used_at, aaguid, registration_flags, last_flags FROM credentials ORDER BY created_at")
      .toArray()
      .map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
        aaguid: row.aaguid,
        backupEligible: (row.registration_flags & FLAG_BACKUP_ELIGIBLE) !== 0,
        backedUp: ((row.last_flags ?? row.registration_flags) & FLAG_BACKED_UP) !== 0,
      }));
    return { ok: true, credentials };
  }

  /**
   * Revoke a credential for a stepped-up session, returning its AAGUID. The
   * last credential is never revoked.
   */
  revokeCredential(input: {
    tokenHash: string;
    credentialId: string;
    now: number;
  }): RecordResult<{ aaguid: string }, SessionCause | "not-found" | "last-credential"> {
    const gate = this.gate(input.tokenHash, input.now, "stepped-up");
    if (!gate.ok) return gate;
    return this.ctx.storage.transactionSync((): RecordResult<{ aaguid: string }, "not-found" | "last-credential"> => {
      const [row] = this.sql
        .exec<{ aaguid: string }>("SELECT aaguid FROM credentials WHERE id = ?", input.credentialId)
        .toArray();
      if (!row) return { ok: false, cause: "not-found" };
      const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM credentials").one().n;
      if (count <= 1) return { ok: false, cause: "last-credential" };
      this.sql.exec("DELETE FROM credentials WHERE id = ?", input.credentialId);
      return { ok: true, aaguid: row.aaguid };
    });
  }

  /**
   * Check a recovery attempt before the ceremony binds anything: apply the
   * throttle, count the attempt, and check that the code is one of the
   * record's unused codes, without using it. Every attempt counts against the
   * throttle, whatever its outcome.
   */
  checkRecoveryAttempt(input: { codeHash: string; now: number }): RecordResult {
    const refused = this.unavailableCause();
    if (refused) return { ok: false, cause: refused };
    const recent = this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM recovery_attempts WHERE at > ?", input.now - HOUR_MS)
      .one().n;
    if (recent >= RECOVERY_ATTEMPTS_PER_HOUR) return { ok: false, cause: "recovery-throttled" };
    this.sql.exec("DELETE FROM recovery_attempts WHERE at <= ?", input.now - HOUR_MS);
    this.sql.exec("INSERT INTO recovery_attempts (at) VALUES (?)", input.now);
    const unused = this.sql
      .exec("SELECT 1 FROM recovery_codes WHERE code_hash = ? AND used_at IS NULL", input.codeHash)
      .toArray();
    if (unused.length === 0) return { ok: false, cause: "wrong-recovery-code" };
    return { ok: true };
  }

  /**
   * Recover with a recovery code that `checkRecoveryAttempt` accepted: mark
   * the code used, bind the new credential and mint a session, in one
   * transaction. The attempt was counted by the check, so it is not counted
   * again. A code used by a concurrent recovery since the check is refused.
   * Returns how many unused codes are left, counted in the same transaction.
   */
  recover(input: {
    codeHash: string;
    credential: VerifiedCredential;
    session: NewSession;
    now: number;
  }): RecordResult<{ codesLeft: number }> {
    const refused = this.unavailableCause();
    if (refused) return { ok: false, cause: refused };
    return this.ctx.storage.transactionSync((): RecordResult<{ codesLeft: number }> => {
      const used = this.sql
        .exec("UPDATE recovery_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL RETURNING 1", input.now, input.codeHash)
        .toArray();
      if (used.length === 0) return { ok: false, cause: "wrong-recovery-code" };
      this.insertCredential(input.credential, input.now);
      this.insertSession(input.session, input.now);
      const codesLeft = this.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM recovery_codes WHERE used_at IS NULL")
        .one().n;
      return { ok: true, codesLeft };
    });
  }

  /** Store a single-use rebind token for this record. */
  createRebindToken(tokenHash: string, now: number): RecordResult {
    if (!this.recordRow()) return { ok: false, cause: "unknown-record" };
    this.sql.exec(
      "INSERT INTO rebind_tokens (token_hash, created_at, expires_at) VALUES (?, ?, ?)",
      tokenHash,
      now,
      now + REBIND_LINK_LIFETIME_MS,
    );
    return { ok: true };
  }

  /**
   * The ids and stored transports of this record's credentials, when a rebind
   * token is live, without redeeming it; null when it is not. The live token
   * proves the record, so it may see its credentials.
   */
  rebindDescriptors(tokenHash: string, now: number): CredentialDescriptor[] | null {
    const live =
      this.sql
        .exec("SELECT 1 FROM rebind_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?", tokenHash, now)
        .toArray().length > 0;
    return live ? this.descriptors() : null;
  }

  /** Redeem a rebind token: bind the new credential and mint a session, in one transaction. */
  rebind(input: { tokenHash: string; credential: VerifiedCredential; session: NewSession; now: number }): RecordResult {
    const refused = this.unavailableCause();
    if (refused) return { ok: false, cause: refused };
    return this.ctx.storage.transactionSync((): RecordResult => {
      const used = this.sql
        .exec(
          "UPDATE rebind_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING 1",
          input.now,
          input.tokenHash,
          input.now,
        )
        .toArray();
      if (used.length === 0) return { ok: false, cause: "bad-rebind-link" };
      this.insertCredential(input.credential, input.now);
      this.insertSession(input.session, input.now);
      return { ok: true };
    });
  }

  /** Suspend the principal: end all its sessions and refuse its logins. Returns the sessions ended. */
  suspend(now: number): RecordResult<{ sessionIds: string[] }> {
    return this.markAndEndSessions("suspended_at", now);
  }

  /**
   * Remove the principal, for good: end all its sessions and refuse every
   * ceremony. Its credentials, codes and tokens stay, refused with it.
   * Returns the sessions ended.
   */
  remove(now: number): RecordResult<{ sessionIds: string[] }> {
    return this.markAndEndSessions("removed_at", now);
  }

  /** Set a state column, keeping an earlier time, and end every session, in one transaction. */
  private markAndEndSessions(column: "suspended_at" | "removed_at", now: number): RecordResult<{ sessionIds: string[] }> {
    if (!this.recordRow()) return { ok: false, cause: "unknown-record" };
    return this.ctx.storage.transactionSync(() => {
      this.sql.exec(`UPDATE record SET ${column} = COALESCE(${column}, ?)`, now);
      const sessionIds = this.sql.exec<{ id: string }>("DELETE FROM sessions RETURNING id").toArray().map((r) => r.id);
      return { ok: true as const, sessionIds };
    });
  }

  resume(): RecordResult {
    if (!this.recordRow()) return { ok: false, cause: "unknown-record" };
    this.sql.exec("UPDATE record SET suspended_at = NULL");
    return { ok: true };
  }

  /** Replace every recovery code for a stepped-up session. */
  rotateRecoveryCodes(input: {
    tokenHash: string;
    codeHashes: string[];
    now: number;
  }): RecordResult<{}, SessionCause> {
    const gate = this.gate(input.tokenHash, input.now, "stepped-up");
    if (!gate.ok) return gate;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM recovery_codes");
      for (const hash of input.codeHashes) {
        this.sql.exec("INSERT INTO recovery_codes (code_hash, issued_at) VALUES (?, ?)", hash, input.now);
      }
    });
    return { ok: true };
  }

  /** End every session of this record, if the presented one is live. Returns the ids ended. */
  revokeAllSessions(tokenHash: string, now: number): string[] | null {
    if (!this.authenticate(tokenHash, now)) return null;
    return this.sql.exec<{ id: string }>("DELETE FROM sessions RETURNING id").toArray().map((r) => r.id);
  }

  /** End every session of this record but the presented one, which must be stepped up. Returns the ids ended. */
  revokeOtherSessions(tokenHash: string, now: number): RecordResult<{ sessionIds: string[] }, SessionCause> {
    const gate = this.gate(tokenHash, now, "stepped-up");
    if (!gate.ok) return gate;
    const sessionIds = this.sql
      .exec<{ id: string }>("DELETE FROM sessions WHERE id != ? RETURNING id", gate.principal.sessionId)
      .toArray()
      .map((r) => r.id);
    return { ok: true, sessionIds };
  }

  /** The record's live sessions, if the presented one is live. */
  listSessions(tokenHash: string, now: number): SessionSummary[] | null {
    const principal = this.authenticate(tokenHash, now);
    if (!principal) return null;
    this.sql.exec("DELETE FROM sessions WHERE expires_at <= ?", now);
    return this.sql
      .exec<{
        id: string;
        created_at: number;
        expires_at: number;
        user_agent: string;
        user_verified: number;
        step_up_user_verified: number | null;
      }>(
        "SELECT id, created_at, expires_at, user_agent, user_verified, step_up_user_verified FROM sessions ORDER BY created_at",
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        userAgent: row.user_agent,
        current: row.id === principal.sessionId,
        userVerified: row.user_verified !== 0,
        stepUpUserVerified: row.step_up_user_verified === null ? null : row.step_up_user_verified !== 0,
      }));
  }

  /** The record's state and counts, with no session and no device detail. Null if there is no record. */
  summary(now: number): RecordSummary | null {
    const record = this.sql
      .exec<{ created_at: number; suspended_at: number | null; removed_at: number | null }>(
        "SELECT created_at, suspended_at, removed_at FROM record",
      )
      .toArray()[0];
    if (!record) return null;
    const count = (query: string, ...bindings: unknown[]) =>
      this.sql.exec<{ n: number }>(query, ...bindings).one().n;
    return {
      createdAt: record.created_at,
      suspendedAt: record.suspended_at,
      removedAt: record.removed_at,
      passkeys: count("SELECT COUNT(*) AS n FROM credentials"),
      sessions: count("SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?", now),
      recoveryCodesLeft: count("SELECT COUNT(*) AS n FROM recovery_codes WHERE used_at IS NULL"),
      rebindLinkOutstanding:
        count("SELECT COUNT(*) AS n FROM rebind_tokens WHERE used_at IS NULL AND expires_at > ?", now) > 0,
    };
  }

  /** Keep the cause of a refused ceremony that resolved to this record. */
  recordFailure(failure: CeremonyFailure): void {
    insertFailure(this.sql, failure);
  }

  /** Validate a session token hash. Called on every authenticated request; nothing is cached. */
  authenticate(tokenHash: string, now: number): Principal | null {
    const gate = this.gate(tokenHash, now, "live");
    return gate.ok ? gate.principal : null;
  }
}

/** The identity record object for a record id, under `storagePrefix`. */
export function identityRecords(binding: DurableObjectNamespace<IdentityRecord>, storagePrefix?: string) {
  return (recordId: RecordId) => prefixedInstance(binding, storagePrefix, recordId);
}
