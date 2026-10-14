// Secrets that each deployment sets with `wrangler secret put`. `wrangler types`
// cannot see them in wrangler.jsonc.
interface Env {
  /** Identity record ids that hold the operator role, separated by commas. The operator routes of the demo read it. */
  OPERATOR_RECORD_IDS?: string;
  /** A Cloudflare API token that may create and delete event subscriptions (Queues edit). */
  CF_API_TOKEN?: string;
  /** An Anthropic API key: with it, agents can write notes with Claude (src/llm.ts). */
  ANTHROPIC_API_KEY?: string;
  /** A GitHub token that may create repositories of MIRROR_OWNER and push to them. */
  GITHUB_TOKEN?: string;
  /** Only the test entry points of the demo read it. Never set it here. */
  OPERATOR_MEMBER_NAMES?: string;
}
