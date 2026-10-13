import { DEFAULT_RATE_LIMITS, type RateLimits } from "passkey-cloudflare";

// Rate limits for the demo as Playwright runs it (src/e2e.ts), never deployed.
// Every test reaches the Worker from one source address and the state persists
// across runs, so the default limits count every test of every recent run
// together and refuse a test at random. Each limit keeps its window but is too
// high to refuse. Imported only by src/e2e.ts; scripts/check-production-bundle.ts
// keeps it out of src/index.ts.

const E2E_LIMIT = 1_000_000;

export const E2E_RATE_LIMITS = Object.fromEntries(
  Object.entries(DEFAULT_RATE_LIMITS).map(([name, limit]) => [name, { ...limit, limit: E2E_LIMIT }]),
) as RateLimits;
