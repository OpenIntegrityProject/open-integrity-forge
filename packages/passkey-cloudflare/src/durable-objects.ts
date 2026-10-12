import { CeremonyFailures } from "./app-tier/ceremony-failures.ts";
import { ChallengeStore } from "./app-tier/challenges.ts";
import { CredentialLabels } from "./app-tier/labels.ts";
import { MemberNameRegistry } from "./app-tier/member-names.ts";
import { RateLimiter } from "./app-tier/rate-limit.ts";
import { CredentialIndex } from "./identity/credential-index.ts";
import { IdentityRecord } from "./identity/record.ts";

/**
 * Every Durable Object the library needs, by the binding name it expects. An
 * application binds each one in its wrangler config under that name, to the
 * class of the same name, and exports the class from its entry point.
 */
export const PASSKEY_DURABLE_OBJECTS = {
  IDENTITY_RECORDS: IdentityRecord,
  CREDENTIAL_INDEX: CredentialIndex,
  CHALLENGES: ChallengeStore,
  MEMBER_NAMES: MemberNameRegistry,
  CREDENTIAL_LABELS: CredentialLabels,
  RATE_LIMITS: RateLimiter,
  CEREMONY_FAILURES: CeremonyFailures,
} as const;

/** The namespaces `createPasskeys` takes, one for each of `PASSKEY_DURABLE_OBJECTS`. */
export type PasskeyBindings = {
  -readonly [Binding in keyof typeof PASSKEY_DURABLE_OBJECTS]: DurableObjectNamespace<
    InstanceType<(typeof PASSKEY_DURABLE_OBJECTS)[Binding]>
  >;
};
