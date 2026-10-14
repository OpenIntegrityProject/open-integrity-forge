#!/usr/bin/env node
// forge-verify: check a forge repository against its own policy, with no
// server. It reads a clone or a bare repository on disk, or clones a remote
// into memory. It uses the same verifier as the forge Worker. Node 23.6 or
// later runs this TypeScript file with no build step.
//
//   node scripts/forge-verify.ts <path or URL> [--repo <inception id>] [--ref main] [--token <token>] [--json]
//
// It exits with 0 when the history verifies, 1 when it does not, and 2 on an error.

import * as fs from "node:fs";
import { resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";
import http from "isomorphic-git/http/web";
import { cloneHttp, diskRepo, memoryRepo, resolve, type Repo } from "../authority/git.ts";
import { verifyHistory, type HistoryReport } from "../authority/verify.ts";

const USAGE = "usage: forge-verify <path or URL> [--repo <inception id>] [--ref main] [--token <token>] [--json]";

async function open(source: string, token: string | undefined): Promise<Repo> {
  if (/^https?:\/\//.test(source)) {
    const repo = await memoryRepo();
    await cloneHttp(repo, { http, url: source, ...(token ? { token } : {}) });
    return repo;
  }
  const dir = resolvePath(source);
  if (fs.existsSync(`${dir}/.git`)) return diskRepo(fs, dir);
  if (fs.existsSync(`${dir}/HEAD`)) return diskRepo(fs, dir, dir);
  throw new Error(`${source} is not a Git repository`);
}

async function head(repo: Repo, ref: string): Promise<string> {
  for (const candidate of [`refs/heads/${ref}`, `refs/remotes/origin/${ref}`, ref]) {
    const oid = await resolve(repo, candidate);
    if (oid) return oid;
  }
  throw new Error(`there is no ${ref}`);
}

function print(report: HistoryReport): void {
  const mark = (ok: boolean) => (ok ? "✓" : "✗");
  for (const c of report.commits) {
    const indent = c.role === "merged" ? "    " : "";
    console.log(`${indent}${mark(c.ok)} ${c.oid.slice(0, 7)} ${c.role.padEnd(9)} ${c.subject}`);
    for (const r of c.rules) {
      if (!r.ok || process.env.FORGE_VERIFY_VERBOSE) console.log(`${indent}    ${mark(r.ok)} ${r.rule} ${r.reason}`);
    }
  }
  for (const t of report.tags) {
    console.log(`${mark(t.ok)} ${t.oid.slice(0, 7)} release   ${t.name} on ${t.target.slice(0, 7)}`);
    for (const r of t.rules) if (!r.ok || process.env.FORGE_VERIFY_VERBOSE) console.log(`    ${mark(r.ok)} ${r.rule} ${r.reason}`);
  }
  console.log("");
  if (report.repoId) console.log(`Repository id: ${report.repoId}`);
  console.log(`${mark(report.ok)} ${report.summary}`);
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      ref: { type: "string", default: "main" },
      token: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || positionals.length !== 1) {
    console.error(USAGE);
    return values.help ? 0 : 2;
  }
  const repo = await open(positionals[0]!, values.token);
  const report = await verifyHistory(repo, await head(repo, values.ref!), values.repo ? { repoId: values.repo } : {});
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else print(report);
  return report.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`forge-verify: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  },
);
