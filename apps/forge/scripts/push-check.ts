#!/usr/bin/env node
// Check push events end to end on a deployed forge with Artifacts. A person
// outside the forge pushes to the fork of an agent with plain git. Artifacts
// sends the `pushed` event to the queue of the forge, and the forge verifies
// the push as a new proposal. The commit has no signature, so the forge must
// reject it (R3).
//
//   node scripts/push-check.ts https://<host> [--namespace forge-demo] [--queue forge-artifacts-events] [--keep]
//
// It needs a `wrangler login` session for the account of the forge. If the
// forge does not subscribe its repositories itself (no CF_API_TOKEN secret),
// the script subscribes the fork. At the end, it deletes its subscription. It
// also deletes the project, unless you give --keep.

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { must, session } from "./session.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    namespace: { type: "string", default: "forge-demo" },
    queue: { type: "string", default: "forge-artifacts-events" },
    keep: { type: "boolean", default: false },
  },
});
if (positionals.length !== 1) {
  console.error("usage: node scripts/push-check.ts https://<host> [--namespace forge-demo] [--queue forge-artifacts-events] [--keep]");
  process.exit(2);
}
const origin = positionals[0]!.replace(/\/+$/, "");
const wrangler = (args: string[]) => execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const step = (text: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${text}`);

type Subscription = { id: string; name: string; source?: { repo_name?: string } };
const subscriptions = (): Subscription[] => JSON.parse(wrangler(["queues", "subscription", "list", values.queue!, "--json", "--per-page", "100"]));

const { forge, register, waitFor } = session(origin, true);
await register(`Push${Date.now().toString(36)}`);
const signed = must(await forge.approve(must(await forge.prepareProject("push-check"), "prepare")), "sign inception");
const created = must(await forge.approve(must(await forge.prepareInception(signed.id), "prepare first policy")), "approve first policy");
const id = created.id;
must(await forge.approve(must(await forge.prepareAgents(id, ["Ada", "Bo"]), "prepare agents")), "approve agents");
let state = await waitFor(id, (s) => s.proposals.filter((p) => p.status === "ready").length === 2, "the agents' proposals");
const bo = state.agents.find((a) => a.id === "bo")!;
step(`project ${state.repo.name}, Bo's fork ${bo.fork}`);

const mine: string[] = [];
try {
  if (!subscriptions().some((s) => s.source?.repo_name === bo.fork)) {
    const out = wrangler([
      "queues", "subscription", "create", values.queue!, "--source", "artifacts.repo", "--events", "pushed",
      "--source-namespace", values.namespace!, "--source-repo-name", bo.fork, "--name", `forge-check-${bo.fork}`.slice(0, 63),
    ]);
    const made = subscriptions().find((s) => s.source?.repo_name === bo.fork);
    if (!made) throw new Error(`no subscription after create: ${out}`);
    mine.push(made.id);
    step(`subscribed the queue to ${bo.fork}`);
  } else step(`the forge already subscribed ${bo.fork}`);

  // A token for the fork, as a person who works on the fork from a laptop gets it.
  const token = JSON.parse(wrangler(["artifacts", "repos", "issue-token", bo.fork, "--namespace", values.namespace!, "--scope", "write", "--ttl", "600", "--json"]));
  const secret: string = token.plaintext ?? token.token ?? token.result?.plaintext;
  const remote = state.repo.remote!.replace(`/${state.repo.name}.git`, `/${bo.fork}.git`);
  const dir = mkdtempSync(join(tmpdir(), "forge-push-"));
  const git = (args: string[]) => execFileSync("git", ["-c", `http.extraHeader=Authorization: Bearer ${secret}`, ...args], { cwd: dir, stdio: "pipe" });
  git(["clone", "-q", remote, "."]);
  git(["checkout", "-q", "-b", "laptop"]);
  git(["-c", "user.name=Someone", "-c", "user.email=someone@example.com", "commit", "-q", "--allow-empty", "-m", "Work from a laptop, unsigned"]);
  git(["push", "-q", "origin", "laptop"]);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();
  step(`pushed ${head.slice(0, 7)} to ${bo.fork} laptop with git`);

  state = await waitFor(id, (s) => s.proposals.some((p) => p.taskId === "outside" && p.head === head && p.status !== "verifying"), "the push event", 180_000);
  const proposal = state.proposals.find((p) => p.taskId === "outside" && p.head === head)!;
  const r3 = proposal.report?.commits[0]?.rules.find((r) => r.rule === "R3");
  step(`the forge made "${proposal.title}": ${proposal.status}; R3: ${r3?.reason}`);
  if (proposal.status !== "rejected" || r3?.ok !== false) throw new Error("the push was not rejected at R3");
  console.log("push-check: passed");
} finally {
  for (const sub of mine) wrangler(["queues", "subscription", "delete", values.queue!, "--id", sub, "--force"]);
  if (!values.keep) must(await forge.reset(id), "delete the project");
  step(values.keep ? `kept project ${id}` : "deleted the project and the check's subscription");
}
