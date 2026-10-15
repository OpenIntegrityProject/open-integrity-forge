#!/usr/bin/env node
// Delete the forge repositories in an Artifacts namespace, for example after
// the demo. Cloudflare bills Artifacts operations and storage from October
// 2026. For one project, prefer "Delete this project" in the forge, because it
// also clears the records of the forge. This script is for the repositories
// that stay after that.
//
//   node scripts/cleanup-artifacts.ts [--namespace forge-demo] [--prefix gordian-notes-] [--dry-run]
//
// It uses only documented wrangler commands, with a `wrangler login` session
// for the account of the forge. With --dry-run, it prints the commands and
// runs none of them.

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

/** The repository names in the JSON that `wrangler artifacts repos list --json` prints. */
export function repoNames(listing: string): string[] {
  const parsed = JSON.parse(listing) as { repos?: { name: string }[] } | { name: string }[];
  return (Array.isArray(parsed) ? parsed : (parsed.repos ?? [])).map((r) => r.name);
}

/** The wrangler arguments that delete each repository whose name starts with `prefix`. */
export function deleteCommands(names: string[], namespace: string, prefix = ""): string[][] {
  return names
    .filter((name) => name.startsWith(prefix))
    .map((name) => ["artifacts", "repos", "delete", name, "--namespace", namespace, "--force"]);
}

function wrangler(args: string[]): string {
  return execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      namespace: { type: "string", default: "forge-demo" },
      prefix: { type: "string", default: "" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const listed = wrangler(["artifacts", "repos", "list", "--namespace", values.namespace!, "--json"]);
  const commands = deleteCommands(repoNames(listed), values.namespace!, values.prefix);
  for (const args of commands) {
    if (values["dry-run"]) console.log(`npx wrangler ${args.join(" ")}`);
    else wrangler(args);
  }
  const left = repoNames(wrangler(["artifacts", "repos", "list", "--namespace", values.namespace!, "--json"])).filter((n) =>
    n.startsWith(values.prefix!),
  );
  const repos = (n: number) => `${n} ${n === 1 ? "repository" : "repositories"}`;
  console.log(
    values["dry-run"]
      ? `Would delete ${repos(commands.length)}.`
      : left.length === 0
        ? `Deleted ${repos(commands.length)}; none is left.`
        : `Deleted ${commands.length - left.length}; still there: ${left.join(", ")}`,
  );
  process.exitCode = !values["dry-run"] && left.length > 0 ? 1 : 0;
}
