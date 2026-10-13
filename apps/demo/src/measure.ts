import { DEFAULT_RATE_LIMITS, type RateLimits } from "passkey-cloudflare";
import { createApp } from "./app.ts";
import { operatorRolesFromSecretOrMemberNames } from "./operator-member-names.ts";

// The demo as deployed only to measure refusal timing (wrangler.measure.jsonc,
// docs/refusal-floor.md). Every rate limit keeps its window and its per-request
// work, but is too high to refuse, so a measurement run from one address
// times the ceremonies rather than the throttle. Its operator is named by
// member name, through the OPERATOR_MEMBER_NAMES var the measurement script
// deploys it with.

const MEASURE_LIMIT = 1_000_000;

const rateLimits = Object.fromEntries(
  Object.entries(DEFAULT_RATE_LIMITS).map(([name, limit]) => [name, { ...limit, limit: MEASURE_LIMIT }]),
) as RateLimits;

export default createApp({ rateLimits, operatorRoles: operatorRolesFromSecretOrMemberNames });

export {
  ChallengeStore,
  CredentialIndex,
  CeremonyFailures,
  CredentialLabels,
  IdentityRecord,
  MemberNameRegistry,
  RateLimiter,
} from "passkey-cloudflare";

export { OperatorLog } from "./operator-log.ts";
