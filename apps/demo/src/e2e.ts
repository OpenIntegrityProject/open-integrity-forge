import { createApp } from "./app.ts";
import { E2E_RATE_LIMITS } from "./e2e-rate-limits.ts";
import { operatorRolesFromSecretOrMemberNames } from "./operator-member-names.ts";

// The demo as Playwright runs it (playwright.config.ts), never deployed. Its
// operators can be named by member name, through the OPERATOR_MEMBER_NAMES var,
// so the browser tests drive a real operator, and its per-source rate limits
// are high enough that back-to-back runs from one address are not refused.

export default createApp({ operatorRoles: operatorRolesFromSecretOrMemberNames, rateLimits: E2E_RATE_LIMITS });

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
