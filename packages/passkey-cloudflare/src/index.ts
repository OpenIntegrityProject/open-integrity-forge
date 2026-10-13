// Identity layer
export {
  IdentityRecord,
  identityRecords,
  REBIND_LINK_LIFETIME_MS,
  SESSION_LIFETIME_MS,
  type Principal,
  type RecordCause,
  type RecordSummary,
  type SessionCause,
  type SessionSummary,
} from "./identity/record.ts";
export { isRecordId, RECOVERY_CODE_COUNT, type RecordId } from "./identity/secrets.ts";
export { CredentialIndex, credentialIndex } from "./identity/credential-index.ts";
export { CEREMONY_POLICY, type RelyingParty } from "./identity/webauthn.ts";

// Application-tier building blocks
export { ChallengeStore, challengeStores, CHALLENGE_LIFETIME_MS } from "./app-tier/challenges.ts";
export { MemberNameRegistry, memberNameRegistry } from "./app-tier/member-names.ts";
export {
  CAPITAL_NUDGE_MESSAGE,
  MEMBER_NAME_RULES,
  isValidMemberName,
  memberNameKey,
  needsCapitalNudge,
} from "./member-name-rules.ts";
export { CredentialLabels, credentialLabels, parseLabel } from "./app-tier/labels.ts";
export { RateLimiter, rateLimiters, DEFAULT_RATE_LIMITS, type Limit, type RateLimits } from "./app-tier/rate-limit.ts";
export { CeremonyFailures, ceremonyFailures } from "./app-tier/ceremony-failures.ts";
export type { CeremonyFailure } from "./failures.ts";
export { REFUSAL_BODY, REFUSAL_STATUS, type Ceremony } from "./refusal.ts";
export { SESSION_COOKIE, clearedSessionCookie, sessionCookie, sessionValueFrom } from "./http.ts";

// The Durable Objects an application binds, and the prefix on their instance names
export { PASSKEY_DURABLE_OBJECTS, type PasskeyBindings } from "./durable-objects.ts";
export { prefixedInstance, prefixedName } from "./storage-prefix.ts";

// Ceremonies
export {
  createPasskeys,
  PasskeyError,
  type CeremonyOutcome,
  type CredentialListing,
  type PasskeyConfig,
  type PasskeyErrorCode,
  type Passkeys,
  type RequestContext,
  type RevocationEvent,
  type RevokedPasskey,
} from "./passkeys.ts";
