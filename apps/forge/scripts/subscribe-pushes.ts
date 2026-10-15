#!/usr/bin/env node
// Subscribe the queue of the forge to `pushed` events of each forge
// repository. Artifacts sends repository events only to a subscription for
// that one repository, so each new project and fork needs a subscription. A
// forge with a CF_API_TOKEN secret subscribes its repositories itself. For a
// forge without that secret, run this script after the policy admits the
// agents, with a `wrangler login` session for the account of the forge.
//
//   node scripts/subscribe-pushes.ts [--dry-run] [--namespace forge-demo] [--queue forge-artifacts-events] [repo ...]
//
// With no repository names, it subscribes every repository in the namespace.
// It uses only documented wrangler commands.

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    namespace: { type: "string", default: "forge-demo" },
    queue: { type: "string", default: "forge-artifacts-events" },
    "dry-run": { type: "boolean", default: false },
  },
});

function wrangler(args: string[]): string {
  if (values["dry-run"]) {
    console.log(`npx wrangler ${args.join(" ")}`);
    return "";
  }
  return execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

let repos = positionals;
if (repos.length === 0) {
  const listed = wrangler(["artifacts", "repos", "list", "--namespace", values.namespace!, "--json"]);
  const parsed = listed ? (JSON.parse(listed) as { repos?: { name: string }[] } | { name: string }[]) : [];
  repos = (Array.isArray(parsed) ? parsed : (parsed.repos ?? [])).map((r) => r.name);
}
for (const repo of repos) {
  wrangler([
    "queues",
    "subscription",
    "create",
    values.queue!,
    "--source",
    "artifacts.repo",
    "--events",
    "pushed",
    "--source-namespace",
    values.namespace!,
    "--source-repo-name",
    repo,
    "--name",
    `forge-${repo}`.slice(0, 63),
  ]);
}
if (!values["dry-run"]) console.log(`Subscribed ${values.queue} to pushes of ${repos.length} repositories.`);
