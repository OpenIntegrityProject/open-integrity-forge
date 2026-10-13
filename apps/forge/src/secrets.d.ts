// Secrets set per deployment with `wrangler secret put`, which `wrangler types`
// cannot see in wrangler.jsonc.
interface Env {
  /** Identity record ids that hold the operator role, separated by commas. Read by the demo's operator routes. */
  OPERATOR_RECORD_IDS?: string;
  /** A Cloudflare API token that may create and delete event subscriptions (Queues edit). */
  CF_API_TOKEN?: string;
  /** An Anthropic API key: with it, agents can write notes with Claude (src/llm.ts). */
  ANTHROPIC_API_KEY?: string;
  /** A GitHub token that may create repositories of MIRROR_OWNER and push to them. */
  GITHUB_TOKEN?: string;
  /** Read only by the demo's test entry points. Never set it here. */
  OPERATOR_MEMBER_NAMES?: string;
}
