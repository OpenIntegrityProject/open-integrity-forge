import { listFrom, operatorRolesFromSecret, type OperatorRoles } from "./operator.ts";
import type { Call } from "./http.ts";

// Operators named by member name, for Workers that are never the deployed
// demo: the one Playwright starts (src/e2e.ts) and the measurement Worker
// (src/measure.ts). Their member names are known before anyone registers, so a
// test or script can make an operator without a secret. Only those entry
// points import this file; src/index.ts must not, directly or through anything
// it imports, and scripts/check-production-bundle.ts fails if this code
// reaches the production bundle.

/** The operator role as the `OPERATOR_MEMBER_NAMES` var grants it: a comma-separated list of member names. */
function operatorRolesFromMemberNames({ env, passkeys }: Call): OperatorRoles {
  const memberNames = listFrom(env.OPERATOR_MEMBER_NAMES);
  return {
    isOperator: async (recordId) =>
      (await Promise.all(memberNames.map((name) => passkeys.resolveMemberName(name)))).includes(recordId),
  };
}

/** The operator role from either the `OPERATOR_RECORD_IDS` secret or the `OPERATOR_MEMBER_NAMES` var. */
export function operatorRolesFromSecretOrMemberNames(call: Call): OperatorRoles {
  const bySecret = operatorRolesFromSecret(call);
  const byMemberName = operatorRolesFromMemberNames(call);
  return {
    isOperator: async (recordId) => (await bySecret.isOperator(recordId)) || byMemberName.isOperator(recordId),
  };
}
