// Secrets set per deployment with `wrangler secret put`, and vars set only
// with `--var` on non-production Workers, neither of which `wrangler types`
// can see in wrangler.jsonc.
interface Env {
  /** Identity record ids holding the operator role, separated by commas. */
  OPERATOR_RECORD_IDS?: string;
  /**
   * Member names holding the operator role, separated by commas. Read only by
   * the non-production entry points (src/operator-member-names.ts); never set
   * it in wrangler.jsonc.
   */
  OPERATOR_MEMBER_NAMES?: string;
}
