// The member names the e2e Worker (src/e2e.ts) treats as operators, which
// playwright.config.ts passes to wrangler dev as OPERATOR_MEMBER_NAMES. The run
// id is drawn once, in the Playwright runner before it starts its workers,
// which inherit it, so every process names the same operators. It differs per
// run because wrangler dev keeps its storage between runs, and a name can be
// registered only once. Each operator test registers its own name: a passkey
// copied between test pages would need its sign counter copied back too.

process.env.E2E_OPERATOR_RUN ??= `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const run = process.env.E2E_OPERATOR_RUN;

export const OPERATORS = {
  info: `Infoop${run}`,
  lookup: `Lookupop${run}`,
  remove: `Removeop${run}`,
  allow: `Allowop${run}`,
  layout: `Layoutop${run}`,
  rebind: `Rebindop${run}`,
};
