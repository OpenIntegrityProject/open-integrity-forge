import type { AuthenticationResponseJSON, PublicKeyCredentialHint, RegistrationResponseJSON } from "@simplewebauthn/server";
import { ceremonyFailures } from "./app-tier/ceremony-failures.ts";
import { CHALLENGE_LIFETIME_MS, challengeStores } from "./app-tier/challenges.ts";
import { providerName } from "./app-tier/aaguid-names.ts";
import { credentialLabels, parseLabel, randomLabel } from "./app-tier/labels.ts";
import { memberNameRegistry } from "./app-tier/member-names.ts";
import { isValidMemberName, memberNameKey } from "./member-name-rules.ts";
import { DEFAULT_RATE_LIMITS, rateLimiters, type Limit, type RateLimits } from "./app-tier/rate-limit.ts";
import { credentialBinding } from "./credential-binding.ts";
import type { PasskeyBindings } from "./durable-objects.ts";
import { sha256Hex, toBase64Url } from "./encoding.ts";
import { credentialIndex } from "./identity/credential-index.ts";
import { relyingPartyMatch, relyingPartyMatches } from "./identity/relying-party-matches.ts";
import {
  identityRecords,
  type Principal,
  type RecordSummary,
  type SessionCause,
  type SessionSummary,
} from "./identity/record.ts";
import {
  hashRecoveryCode,
  mintRebindToken,
  mintRecoveryCodes,
  mintSession,
  newRecordId,
  parseRecordToken,
  type RecordId,
} from "./identity/secrets.ts";
import {
  claimedChallenge,
  creationOptions,
  isUserVerified,
  newChallenge,
  requestOptions,
  verifyAssertion,
  verifyRegistration,
  type RelyingParty,
} from "./identity/webauthn.ts";
import { CeremonyRefusal, uniformRefusal, type Ceremony } from "./refusal.ts";

// The ceremonies, composed from the identity layer (records, credential index,
// verification) and the application-tier building blocks (challenges, member
// names, labels, uniform refusal). This is the module an application calls.

export interface PasskeyConfig {
  rp: RelyingParty;
  /** Minimum time before any ceremony refusal is returned, in milliseconds. */
  refusalFloorMs: number;
  /** Source of the current time. Defaults to `Date.now`. */
  clock?: () => number;
  /** Overrides for the per-source and global rate limits. */
  rateLimits?: Partial<RateLimits>;
  /**
   * Called within the same request whenever sessions end by logout, logout
   * everywhere, logout everywhere else, suspension or removal, so the
   * application can close live connections.
   */
  onRevoke?: (event: RevocationEvent) => void | Promise<void>;
  /**
   * A prefix on the name of every Durable Object instance the stores address,
   * so applications with different prefixes share no storage. Empty or absent,
   * every instance keeps its unprefixed name. Set it in code only, never from a
   * var or secret, so a deploy setting cannot point the app at other storage.
   */
  storagePrefix?: string;
}

export interface RevocationEvent {
  reason: "logout" | "logout-everywhere" | "logout-elsewhere" | "suspension" | "removal";
  recordId: RecordId;
  sessionIds: string[];
}

/** What a ceremony needs to know about the request that carries it. */
export interface RequestContext {
  startedAt: number;
  now: number;
  sourceIp: string;
  userAgent: string;
}

export type CeremonyOutcome<T> = { ok: true; value: T } | { ok: false; response: Response };

/** A refusal that is not a ceremony refusal, and may say why. */
export type PasskeyErrorCode =
  | "not-logged-in"
  | "step-up-required"
  | "not-found"
  | "last-credential"
  | "member-name-unavailable";

export class PasskeyError extends Error {
  constructor(readonly code: PasskeyErrorCode) {
    super(code);
  }
}

function isSessionCause(cause: string): cause is SessionCause {
  return cause === "not-logged-in" || cause === "step-up-required";
}

/** The name a passkey is saved under in a password manager. */
function passkeyName(memberName: string, label: string): string {
  return `${memberName} (${label})`;
}
const ANONYMOUS_CEREMONIES = new Set<Ceremony>(["register", "login", "recover", "rebind"]);

/** What a running ceremony has learned: the record a refusal is recorded on, once known. */
interface Trail {
  recordId?: RecordId;
}

export interface CredentialListing {
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  /** The password manager that holds the passkey, where its AAGUID is known. */
  provider: string | null;
  backupEligible: boolean;
  backedUp: boolean;
}

export interface RevokedPasskey {
  /** The entry the password manager still shows for the revoked passkey. */
  passkeyName: string;
  /** The password manager that holds that entry, where its AAGUID is known. */
  provider: string | null;
  /** The revoked credential's ID, base64url, for the browser to signal as unknown. */
  credentialId: string;
  /** The RP ID the credential was made for. */
  rpId: string;
}

export function createPasskeys(bindings: PasskeyBindings, config: PasskeyConfig) {
  const clock = config.clock ?? Date.now;
  const limits: RateLimits = { ...DEFAULT_RATE_LIMITS, ...config.rateLimits };
  const revoked = async (event: RevocationEvent) => {
    await config.onRevoke?.(event);
  };

  const record = identityRecords(bindings.IDENTITY_RECORDS, config.storagePrefix);
  const index = credentialIndex(bindings.CREDENTIAL_INDEX, config.storagePrefix);
  const names = memberNameRegistry(bindings.MEMBER_NAMES, config.storagePrefix);
  const labels = credentialLabels(bindings.CREDENTIAL_LABELS, config.storagePrefix);
  const challenges = challengeStores(bindings.CHALLENGES, config.storagePrefix);
  const failures = ceremonyFailures(bindings.CEREMONY_FAILURES, config.storagePrefix);
  const limiter = rateLimiters(bindings.RATE_LIMITS, config.storagePrefix);
  const bindNewCredential = credentialBinding({ index, labels, rpId: config.rp.id });

  /** Count a hit against a rate-limit bucket; refuse the ceremony if it is full. */
  async function throttle(bucket: string, limit: Limit, now: number) {
    if (!(await limiter(bucket).hit(limit, now))) throw new CeremonyRefusal("rate-limited");
  }

  /**
   * Refuse the ceremony if the deployment's credentials were made for another
   * RP ID: none of them can work under this one, and the operator needs to be
   * told why. A deployment with no credentials has no RP ID stored yet.
   */
  async function checkRelyingParty(ceremony: Ceremony) {
    const match = relyingPartyMatch(config.storagePrefix, config.rp.id);
    if (relyingPartyMatches.has(match)) return;
    const stored = await index().rpId();
    if (stored === null) return;
    if (stored === config.rp.id) {
      relyingPartyMatches.add(match);
      return;
    }
    console.error(
      `passkey ${ceremony} refused: the RP ID is ${config.rp.id}, but this deployment's passkeys were made for ${stored}`,
    );
    throw new CeremonyRefusal("rp-id-changed");
  }

  /** Run `run` within a per-source limit. Past the limit, the uniform refusal. */
  async function withinSourceLimit<T>(
    ctx: RequestContext,
    bucket: string,
    limit: Limit,
    run: () => Promise<T>,
  ): Promise<CeremonyOutcome<T>> {
    const sourceHash = await sha256Hex(`source:${ctx.sourceIp}`);
    try {
      await throttle(`${bucket}:${sourceHash}`, limit, ctx.now);
    } catch (error) {
      if (!(error instanceof CeremonyRefusal)) throw error;
      return { ok: false, response: await uniformRefusal(ctx.startedAt, config.refusalFloorMs) };
    }
    return { ok: true, value: await run() };
  }

  /**
   * Run a ceremony within its throttles. Any refusal, and any unexpected
   * error, is recorded with its cause (on the record once the ceremony has
   * named one in `trail`, otherwise globally) and becomes the one uniform
   * response, returned no sooner than the refusal floor. A PasskeyError, which
   * is meant to tell the person why, passes through.
   */
  async function runCeremony<T>(
    ctx: RequestContext,
    ceremony: Ceremony,
    run: (trail: Trail) => Promise<T>,
  ): Promise<CeremonyOutcome<T>> {
    const sourceHash = await sha256Hex(`source:${ctx.sourceIp}`);
    const trail: Trail = {};
    let cause: string;
    try {
      // First, so that a ceremony refused for its RP ID writes nothing but its failure.
      await checkRelyingParty(ceremony);
      await throttle(`ceremony:${sourceHash}`, limits.ceremonyPerSource, ctx.now);
      if (ANONYMOUS_CEREMONIES.has(ceremony)) await throttle("ceremony:global", limits.ceremonyGlobal, ctx.now);
      if (ceremony === "recover") {
        await throttle(`recover:${sourceHash}`, limits.recoverPerSource, ctx.now);
        await throttle("recover:global", limits.recoverGlobal, ctx.now);
      }
      return { ok: true, value: await run(trail) };
    } catch (error) {
      if (error instanceof PasskeyError) throw error;
      if (error instanceof CeremonyRefusal) {
        cause = error.reason;
      } else {
        console.error(`passkey ${ceremony} failed; refusing it`, error);
        cause = "internal-error";
      }
    }
    const failure = { ceremony, cause, at: ctx.now, sourceHash };
    try {
      if (trail.recordId) await record(trail.recordId).recordFailure(failure);
      else await failures().record(failure);
    } catch (error) {
      console.error("passkey ceremony failure not recorded", error);
    }
    return { ok: false, response: await uniformRefusal(ctx.startedAt, config.refusalFloorMs) };
  }

  /** Issue options for an anonymous ceremony, within the per-source limit. */
  function anonymousOptions<T>(ctx: RequestContext, issue: () => Promise<T>): Promise<CeremonyOutcome<T>> {
    return withinSourceLimit(ctx, "options", limits.optionsPerSource, issue);
  }

  /**
   * Free a member name left claimed by a registration that never completed:
   * a claim whose record holds no person, older than a challenge's lifetime,
   * so that no ceremony can still commit to it. Answers whether it was freed.
   */
  async function freeStaleClaim(name: string, now: number): Promise<boolean> {
    const recordId = await names().claimBefore(name, now - CHALLENGE_LIFETIME_MS);
    if (!recordId || (await record(recordId).summary(now)) !== null) return false;
    await names().release(name, recordId, now);
    return true;
  }

  async function isMemberNameAvailable(name: string, now: number): Promise<boolean> {
    if (!isValidMemberName(name)) return false;
    return (await names().isAvailable(name)) || (await freeStaleClaim(name, now));
  }

  /** Claim a member name for a new record, freeing a stale claim on it first if need be. */
  async function claimMemberName(name: string, recordId: RecordId, now: number): Promise<boolean> {
    if (await names().claim(name, recordId, now)) return true;
    return (await freeStaleClaim(name, now)) && (await names().claim(name, recordId, now));
  }

  async function issueChallenge(purpose: Ceremony, payload: unknown, now: number) {
    const challenge = newChallenge();
    const hash = await sha256Hex(toBase64Url(challenge));
    await challenges(hash).issue(hash, purpose, payload, now);
    return challenge;
  }

  async function consumeChallenge<P>(purpose: Ceremony, response: unknown, now: number) {
    const challenge = claimedChallenge(response);
    const hash = await sha256Hex(challenge);
    const taken = await challenges(hash).consume(hash, purpose, now);
    if (taken === null) throw new CeremonyRefusal("unknown-challenge");
    return { challenge, payload: JSON.parse(taken) as P };
  }

  /**
   * Verify an assertion by any credential the site knows. Returns the record
   * it belongs to and what the record must accept. A ceremony that has not yet
   * named a record names this one.
   */
  async function verifyKnownAssertion(trail: Trail, response: AuthenticationResponseJSON, challenge: string) {
    const credentialId = typeof response?.id === "string" ? response.id : "";
    const recordId = credentialId ? await index().get(credentialId) : null;
    if (!recordId) throw new CeremonyRefusal("unknown-credential");
    trail.recordId ??= recordId;
    const stored = await record(recordId).credentialForAssertion(credentialId);
    if (!stored) throw new CeremonyRefusal("unknown-credential");
    const verified = await verifyAssertion(response, {
      rp: config.rp,
      challenge,
      credential: { id: credentialId, ...stored },
    });
    return { recordId, credentialId, ...verified };
  }

  // A session-gated method whose first object call is the identity record
  // passes the session's token hash to it, and the record applies the gate and
  // acts in that one call. Only a method that must call another object before
  // the record checks the gate first, with `liveSession` or `steppedUpSession`.

  /** The presented session's record and token hash, unchecked. */
  async function presentedSession(sessionValue: string | null | undefined) {
    const parsed = await parseRecordToken(sessionValue);
    if (!parsed) throw new PasskeyError("not-logged-in");
    return parsed;
  }

  /** The presented session, which must be live. */
  async function liveSession(sessionValue: string | null | undefined, now: number) {
    const parsed = await presentedSession(sessionValue);
    const principal = await record(parsed.recordId).authenticate(parsed.tokenHash, now);
    if (!principal) throw new PasskeyError("not-logged-in");
    return { ...parsed, sessionId: principal.sessionId };
  }

  /** The presented session, which must be live and recently stepped up. */
  async function steppedUpSession(sessionValue: string | null | undefined, now: number) {
    const parsed = await presentedSession(sessionValue);
    const check = await record(parsed.recordId).checkStepUp(parsed.tokenHash, now);
    if (!check.ok) throw new PasskeyError(check.cause);
    return { ...parsed, sessionId: check.sessionId };
  }

  /** Turn a record's refusal into the right kind of error. */
  function refuse(cause: string): never {
    if (isSessionCause(cause)) throw new PasskeyError(cause);
    throw new CeremonyRefusal(cause);
  }

  /**
   * Mint a session: the value for the client, and the row for the record's
   * object. `flags` is the authenticator data flags byte of the ceremony that
   * starts it, which records whether that ceremony was user-verified.
   */
  async function newSession(recordId: RecordId, ctx: RequestContext, flags: number) {
    const minted = await mintSession(recordId);
    return {
      value: minted.value,
      row: {
        id: minted.id,
        tokenHash: minted.tokenHash,
        userAgent: ctx.userAgent,
        userVerified: isUserVerified(flags),
      },
    };
  }

  return {
    context(request: Request): RequestContext {
      const now = clock();
      return {
        startedAt: Date.now(),
        now,
        sourceIp: request.headers.get("CF-Connecting-IP") ?? "unknown",
        userAgent: (request.headers.get("User-Agent") ?? "").slice(0, 256),
      };
    },

    /**
     * Whether a member name is free to register, within the per-source limit.
     * Past the limit, the uniform refusal.
     */
    async checkMemberName(ctx: RequestContext, name: string): Promise<CeremonyOutcome<boolean>> {
      return withinSourceLimit(ctx, "name-check", limits.nameCheckPerSource, () =>
        isMemberNameAvailable(name, ctx.now),
      );
    },

    async memberName(recordId: RecordId): Promise<string | null> {
      return names().nameOf(recordId);
    },

    /** Options for registering a member name, within the per-source limit. */
    async registrationOptions(ctx: RequestContext, typedName: string) {
      return anonymousOptions(ctx, async () => {
        if (!(await isMemberNameAvailable(typedName, ctx.now))) throw new PasskeyError("member-name-unavailable");
        const memberName = typedName.normalize("NFC");
        const label = randomLabel();
        const challenge = await issueChallenge("register", { memberName, label }, ctx.now);
        return creationOptions({ rp: config.rp, challenge, userName: passkeyName(memberName, label) });
      });
    },

    /** Complete registration: a new record, its first credential, recovery codes (with when they were issued) and a session. */
    async register(ctx: RequestContext, response: RegistrationResponseJSON) {
      return runCeremony(ctx, "register", async () => {
        const { challenge, payload } = await consumeChallenge<{ memberName: string; label: string }>(
          "register",
          response,
          ctx.now,
        );
        const credential = await verifyRegistration(response, { rp: config.rp, challenge });
        const recordId = newRecordId();
        if (!(await claimMemberName(payload.memberName, recordId, ctx.now))) {
          throw new CeremonyRefusal("member-name-taken");
        }
        return bindNewCredential({
          recordId,
          credentialId: credential.id,
          label: payload.label,
          now: ctx.now,
          undo: () => names().release(payload.memberName, recordId, ctx.now),
          commit: async () => {
            const session = await newSession(recordId, ctx, credential.registrationFlags);
            const recovery = await mintRecoveryCodes();
            const created = await record(recordId).createPerson({
              recordId,
              credential,
              recoveryCodeHashes: recovery.hashes,
              session: session.row,
              now: ctx.now,
            });
            if (!created.ok) throw new CeremonyRefusal(created.cause);
            return { recordId, session: session.value, recoveryCodes: recovery.codes, issuedAt: ctx.now };
          },
        });
      });
    },

    /** Options for logging in, within the per-source limit. */
    async loginOptions(ctx: RequestContext) {
      return anonymousOptions(ctx, async () => {
        const challenge = await issueChallenge("login", {}, ctx.now);
        return requestOptions({ rp: config.rp, challenge });
      });
    },

    /** Complete a login with any of the site's passkeys, minting a session. */
    async login(ctx: RequestContext, response: AuthenticationResponseJSON) {
      return runCeremony(ctx, "login", async (trail) => {
        const { challenge } = await consumeChallenge("login", response, ctx.now);
        const assertion = await verifyKnownAssertion(trail, response, challenge);
        const session = await newSession(assertion.recordId, ctx, assertion.flags);
        const done = await record(assertion.recordId).completeLogin({
          credentialId: assertion.credentialId,
          signCount: assertion.signCount,
          flags: assertion.flags,
          session: session.row,
          now: ctx.now,
        });
        if (!done.ok) throw new CeremonyRefusal(done.cause);
        return { recordId: assertion.recordId, session: session.value };
      });
    },

    /** End the presented session. */
    async logout(sessionValue: string | null | undefined): Promise<void> {
      const parsed = await parseRecordToken(sessionValue);
      if (!parsed) return;
      const sessionId = await record(parsed.recordId).revokeSession(parsed.tokenHash);
      if (sessionId) await revoked({ reason: "logout", recordId: parsed.recordId, sessionIds: [sessionId] });
    },

    /** End every session of the presented session's record, which must be live. */
    async logoutEverywhere(sessionValue: string | null | undefined): Promise<void> {
      const parsed = await parseRecordToken(sessionValue);
      if (!parsed) throw new PasskeyError("not-logged-in");
      const sessionIds = await record(parsed.recordId).revokeAllSessions(parsed.tokenHash, clock());
      if (!sessionIds) throw new PasskeyError("not-logged-in");
      await revoked({ reason: "logout-everywhere", recordId: parsed.recordId, sessionIds });
    },

    /**
     * End every session of the presented session's record but that one. Needs
     * a fresh step-up, so a stolen session cannot shut the owner out.
     */
    async logoutElsewhere(sessionValue: string | null | undefined): Promise<void> {
      const parsed = await parseRecordToken(sessionValue);
      if (!parsed) throw new PasskeyError("not-logged-in");
      const done = await record(parsed.recordId).revokeOtherSessions(parsed.tokenHash, clock());
      if (!done.ok) throw new PasskeyError(done.cause);
      if (done.sessionIds.length > 0) {
        await revoked({ reason: "logout-elsewhere", recordId: parsed.recordId, sessionIds: done.sessionIds });
      }
    },

    /** The live sessions of the presented session's record, which must be live. */
    async sessions(sessionValue: string | null | undefined): Promise<SessionSummary[]> {
      const parsed = await parseRecordToken(sessionValue);
      const sessions = parsed ? await record(parsed.recordId).listSessions(parsed.tokenHash, clock()) : null;
      if (!sessions) throw new PasskeyError("not-logged-in");
      return sessions;
    },

    async stepUpOptions(ctx: RequestContext, sessionValue: string | null | undefined) {
      const presented = await presentedSession(sessionValue);
      const found = await record(presented.recordId).credentialDescriptors(presented.tokenHash, ctx.now, "live");
      if (!found.ok) throw new PasskeyError(found.cause);
      const challenge = await issueChallenge(
        "step-up",
        { recordId: presented.recordId, sessionId: found.sessionId },
        ctx.now,
      );
      return requestOptions({ rp: config.rp, challenge, allowCredentials: found.descriptors });
    },

    /** Prove control of one of the record's passkeys again, on this session. */
    async stepUp(ctx: RequestContext, sessionValue: string | null | undefined, response: AuthenticationResponseJSON) {
      return runCeremony(ctx, "step-up", async (trail) => {
        // Gated here, before the challenge is consumed.
        const session = await liveSession(sessionValue, ctx.now);
        trail.recordId = session.recordId;
        const { challenge, payload } = await consumeChallenge<{ recordId: RecordId; sessionId: string }>(
          "step-up",
          response,
          ctx.now,
        );
        if (payload.recordId !== session.recordId) throw new CeremonyRefusal("wrong-session");
        const assertion = await verifyKnownAssertion(trail, response, challenge);
        if (assertion.recordId !== session.recordId) throw new CeremonyRefusal("wrong-record");
        const done = await record(session.recordId).completeStepUp({
          tokenHash: session.tokenHash,
          sessionId: payload.sessionId,
          credentialId: assertion.credentialId,
          signCount: assertion.signCount,
          flags: assertion.flags,
          now: ctx.now,
        });
        if (!done.ok) refuse(done.cause);
      });
    },

    /**
     * Options to add a passkey to the stepped-up session's record. `hint`
     * steers where the browser offers to save it.
     */
    async enrolOptions(ctx: RequestContext, sessionValue: string | null | undefined, hint?: PublicKeyCredentialHint) {
      const presented = await presentedSession(sessionValue);
      // The record gates first, so that a refused session mints no label.
      const found = await record(presented.recordId).credentialDescriptors(presented.tokenHash, ctx.now, "stepped-up");
      if (!found.ok) throw new PasskeyError(found.cause);
      const [label, memberName] = await Promise.all([
        labels(presented.recordId).mint(ctx.now),
        names().nameOf(presented.recordId),
      ]);
      const challenge = await issueChallenge(
        "enrol",
        { recordId: presented.recordId, sessionId: found.sessionId, label },
        ctx.now,
      );
      return creationOptions({
        rp: config.rp,
        challenge,
        userName: passkeyName(memberName ?? presented.recordId, label),
        excludeCredentials: found.descriptors,
        hint,
      });
    },

    /** Add a passkey to the stepped-up session's record. Returns its label. */
    async enrol(ctx: RequestContext, sessionValue: string | null | undefined, response: RegistrationResponseJSON) {
      return runCeremony(ctx, "enrol", async (trail) => {
        // Gated here, before the challenge is consumed and the credential index written.
        const session = await liveSession(sessionValue, ctx.now);
        trail.recordId = session.recordId;
        const { challenge, payload } = await consumeChallenge<{ recordId: RecordId; sessionId: string; label: string }>(
          "enrol",
          response,
          ctx.now,
        );
        if (payload.recordId !== session.recordId) throw new CeremonyRefusal("wrong-session");
        const credential = await verifyRegistration(response, { rp: config.rp, challenge });
        return bindNewCredential({
          recordId: session.recordId,
          credentialId: credential.id,
          label: payload.label,
          now: ctx.now,
          commit: async () => {
            const added = await record(session.recordId).addCredential({
              tokenHash: session.tokenHash,
              sessionId: payload.sessionId,
              credential,
              now: ctx.now,
            });
            if (!added.ok) refuse(added.cause);
            return { label: payload.label };
          },
        });
      });
    },

    /** The record's passkeys. One with no label is given one here. */
    async credentials(ctx: RequestContext, sessionValue: string | null | undefined): Promise<CredentialListing[]> {
      const presented = await presentedSession(sessionValue);
      const listed = await record(presented.recordId).listCredentials(presented.tokenHash, ctx.now);
      if (!listed.ok) throw new PasskeyError(listed.cause);
      const rows = listed.credentials;
      const byCredential = await labels(presented.recordId).labelEach(
        rows.map((row) => row.id),
        ctx.now,
      );
      return rows.map((row) => ({
        label: byCredential[row.id]!,
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
        provider: providerName(row.aaguid),
        backupEligible: row.backupEligible,
        backedUp: row.backedUp,
      }));
    },

    /**
     * Revoke the passkey with this label, typed in any form `parseLabel`
     * reads. The last passkey cannot be revoked. Returns the dead entry as
     * the password manager shows it, that password manager where its AAGUID
     * is known, and the credential ID and RP ID the browser needs to tell the
     * password manager the passkey is gone.
     */
    async revokeCredential(
      ctx: RequestContext,
      sessionValue: string | null | undefined,
      typed: string,
    ): Promise<RevokedPasskey> {
      const label = typeof typed === "string" ? parseLabel(typed) : null;
      // Gated here, before the label is resolved.
      const session = await steppedUpSession(sessionValue, ctx.now);
      const credentialId = label === null ? null : await labels(session.recordId).resolve(label);
      if (label === null || !credentialId) throw new PasskeyError("not-found");
      const memberName = await names().nameOf(session.recordId);
      const done = await record(session.recordId).revokeCredential({
        tokenHash: session.tokenHash,
        credentialId,
        now: ctx.now,
      });
      if (!done.ok) throw new PasskeyError(done.cause);
      await index().delete(credentialId);
      await labels(session.recordId).retire(label, ctx.now);
      return {
        passkeyName: passkeyName(memberName ?? session.recordId, label),
        provider: providerName(done.aaguid),
        credentialId,
        rpId: config.rp.id,
      };
    },

    /** Replace every recovery code. Returns the new codes, shown once, and when they were issued. */
    async rotateRecoveryCodes(ctx: RequestContext, sessionValue: string | null | undefined) {
      const presented = await presentedSession(sessionValue);
      const recovery = await mintRecoveryCodes();
      const done = await record(presented.recordId).rotateRecoveryCodes({
        tokenHash: presented.tokenHash,
        codeHashes: recovery.hashes,
        now: ctx.now,
      });
      if (!done.ok) throw new PasskeyError(done.cause);
      return { recoveryCodes: recovery.codes, issuedAt: ctx.now };
    },

    /**
     * Options for recovering onto a new passkey. An unknown member name still
     * gets options, so that it is refused only at the end, like any other refusal.
     * Nobody has authenticated yet, so the label is drawn unchecked and stores
     * nothing, as at registration.
     */
    async recoverOptions(ctx: RequestContext, memberName: string) {
      return anonymousOptions(ctx, async () => {
        if (!isValidMemberName(memberName)) throw new PasskeyError("not-found");
        const recordId = await names().resolve(memberName);
        const label = randomLabel();
        const shownName = recordId ? await names().nameOf(recordId) : memberName.normalize("NFC");
        const challenge = await issueChallenge("recover", { memberName, recordId, label }, ctx.now);
        return creationOptions({ rp: config.rp, challenge, userName: passkeyName(shownName ?? memberName, label) });
      });
    },

    /**
     * Recover with a member name, a recovery code and a new passkey, in one
     * request. Returns how many unused recovery codes the record has left.
     */
    async recover(ctx: RequestContext, memberName: string, code: string, response: RegistrationResponseJSON) {
      return runCeremony(ctx, "recover", async (trail) => {
        const { challenge, payload } = await consumeChallenge<{
          memberName: string;
          recordId: RecordId | null;
          label: string;
        }>("recover", response, ctx.now);
        if (typeof memberName !== "string" || memberNameKey(memberName) !== memberNameKey(payload.memberName)) {
          throw new CeremonyRefusal("wrong-member-name");
        }
        const recordId = await names().resolve(memberName);
        if (!recordId || recordId !== payload.recordId) throw new CeremonyRefusal("unknown-member-name");
        trail.recordId = recordId;
        if (typeof code !== "string") throw new CeremonyRefusal("wrong-recovery-code");
        const codeHash = await hashRecoveryCode(code);
        // Checked before the passkey is verified or bound, so that a throttled
        // or wrong-code attempt writes nothing but its count: binding first
        // would burn a label on the record for every refused attempt.
        const checked = await record(recordId).checkRecoveryAttempt({ codeHash, now: ctx.now });
        if (!checked.ok) throw new CeremonyRefusal(checked.cause);
        const credential = await verifyRegistration(response, { rp: config.rp, challenge });
        return bindNewCredential({
          recordId,
          credentialId: credential.id,
          label: payload.label,
          now: ctx.now,
          commit: async () => {
            const session = await newSession(recordId, ctx, credential.registrationFlags);
            const done = await record(recordId).recover({
              codeHash,
              credential,
              session: session.row,
              now: ctx.now,
            });
            if (!done.ok) throw new CeremonyRefusal(done.cause);
            return { recordId, session: session.value, codesLeft: done.codesLeft };
          },
        });
      });
    },

    /** The presented session, if it is live and stepped up within the window; otherwise a PasskeyError. */
    async requireStepUp(ctx: RequestContext, sessionValue: string | null | undefined) {
      const session = await steppedUpSession(sessionValue, ctx.now);
      return { recordId: session.recordId, sessionId: session.sessionId };
    },

    async resolveMemberName(memberName: string): Promise<RecordId | null> {
      return isValidMemberName(memberName) ? names().resolve(memberName) : null;
    },

    /** Whether a member name was retired when its member was removed. */
    async isRetiredMemberName(memberName: string): Promise<boolean> {
      return isValidMemberName(memberName) && names().isRetired(memberName);
    },

    /**
     * Let anyone register a retired member name again, on a new record; the
     * removed record stays removed. Answers the removed record, or null when
     * the name is not retired. Who may do this is the application's decision.
     */
    async allowRetiredMemberName(memberName: string): Promise<RecordId | null> {
      return isValidMemberName(memberName) ? names().allowRetired(memberName) : null;
    },

    /**
     * Create a single-use, expiring rebind link value for a record. Who may do
     * this is the application's decision.
     */
    async createRebindLink(ctx: RequestContext, recordId: RecordId): Promise<string> {
      const token = await mintRebindToken(recordId);
      const done = await record(recordId).createRebindToken(token.tokenHash, ctx.now);
      if (!done.ok) throw new PasskeyError("not-found");
      return token.value;
    },

    /**
     * A record's state and counts, read without the member's session. Who may
     * call this is the application's decision.
     *
     * It returns counts and state only, to keep small what an operator sees day
     * to day. The device detail (passkey providers, last use, session browsers)
     * still exists in storage, so this is no privacy guarantee against an
     * operator, who runs the deployment and can read its storage directly. A
     * member's privacy from an operator rests on trusting the operator, not on
     * the software.
     */
    async recordSummary(recordId: RecordId): Promise<RecordSummary> {
      const summary = await record(recordId).summary(clock());
      if (!summary) throw new PasskeyError("not-found");
      return summary;
    },

    /**
     * Options for redeeming a rebind link, within the per-source limit. The
     * link proves the record, so the options exclude its passkeys: a device
     * that already holds one is refused by the authenticator rather than
     * given a second (ADR 0008).
     */
    async rebindOptions(ctx: RequestContext, link: string) {
      return anonymousOptions(ctx, async () => {
        const parsed = await parseRecordToken(typeof link === "string" ? link : "");
        const descriptors = parsed ? await record(parsed.recordId).rebindDescriptors(parsed.tokenHash, ctx.now) : null;
        const memberName = parsed && descriptors ? await names().nameOf(parsed.recordId) : null;
        if (!parsed || !descriptors || !memberName) throw new PasskeyError("not-found");
        const label = await labels(parsed.recordId).mint(ctx.now);
        const challenge = await issueChallenge("rebind", { recordId: parsed.recordId, label }, ctx.now);
        return creationOptions({
          rp: config.rp,
          challenge,
          userName: passkeyName(memberName, label),
          excludeCredentials: descriptors,
        });
      });
    },

    /** Redeem a rebind link with a new passkey, minting a session. */
    async rebind(ctx: RequestContext, link: string, response: RegistrationResponseJSON) {
      return runCeremony(ctx, "rebind", async (trail) => {
        const { challenge, payload } = await consumeChallenge<{ recordId: RecordId; label: string }>(
          "rebind",
          response,
          ctx.now,
        );
        const parsed = await parseRecordToken(typeof link === "string" ? link : "");
        if (!parsed || parsed.recordId !== payload.recordId) throw new CeremonyRefusal("bad-rebind-link");
        const recordId = parsed.recordId;
        trail.recordId = recordId;
        const credential = await verifyRegistration(response, { rp: config.rp, challenge });
        return bindNewCredential({
          recordId,
          credentialId: credential.id,
          label: payload.label,
          now: ctx.now,
          commit: async () => {
            const session = await newSession(recordId, ctx, credential.registrationFlags);
            const done = await record(recordId).rebind({
              tokenHash: parsed.tokenHash,
              credential,
              session: session.row,
              now: ctx.now,
            });
            if (!done.ok) throw new CeremonyRefusal(done.cause);
            return { recordId, session: session.value };
          },
        });
      });
    },

    /** Suspend a principal: its sessions end now and its logins are refused. */
    async suspend(ctx: RequestContext, recordId: RecordId): Promise<void> {
      const done = await record(recordId).suspend(ctx.now);
      if (!done.ok) throw new PasskeyError("not-found");
      await revoked({ reason: "suspension", recordId, sessionIds: done.sessionIds });
    },

    /**
     * Remove a principal, for good: its sessions end now, every ceremony is
     * refused, and its member name is retired. Removing it again retires a
     * name that a failed earlier removal left unretired.
     */
    async remove(ctx: RequestContext, recordId: RecordId): Promise<void> {
      const done = await record(recordId).remove(ctx.now);
      if (!done.ok) throw new PasskeyError("not-found");
      await revoked({ reason: "removal", recordId, sessionIds: done.sessionIds });
      await names().retire(recordId, ctx.now);
    },

    /** Lift a suspension. A removed principal stays removed. */
    async resume(recordId: RecordId): Promise<void> {
      const done = await record(recordId).resume();
      if (!done.ok) throw new PasskeyError("not-found");
    },

    /** The principal a session value proves, checked against its record on every call. */
    async authenticate(sessionValue: string | null | undefined): Promise<Principal | null> {
      const parsed = await parseRecordToken(sessionValue);
      if (!parsed) return null;
      return record(parsed.recordId).authenticate(parsed.tokenHash, clock());
    },
  };
}

export type Passkeys = ReturnType<typeof createPasskeys>;
