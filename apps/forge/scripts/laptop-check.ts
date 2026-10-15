#!/usr/bin/env node
// Check the laptop flow of a person end to end on a deployed forge with
// Artifacts. Admit a new SSH key under a passkey approval, and take the push
// commands that the forge gives. Sign a commit with that key and push it with
// plain git. The forge gets the push event and verifies the push (R3 passes
// with the key of the person). Then a passkey approval promotes it.
//
//   node scripts/laptop-check.ts https://<host> [--namespace forge-demo] [--queue forge-artifacts-events] [--keep]
//
// It needs a `wrangler login` session for the account of the forge, to
// subscribe the fork when the forge does not do it itself. At the end, it
// deletes its subscription. It also deletes the project, unless you give
// --keep.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  console.error("usage: node scripts/laptop-check.ts https://<host> [--keep]");
  process.exit(2);
}
const origin = positionals[0]!.replace(/\/+$/, "");
const wrangler = (args: string[]) => execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const step = (text: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${text}`);

const work = mkdtempSync(join(tmpdir(), "forge-laptop-"));
execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "laptop-check", "-f", join(work, "key")]);
const publicKey = readFileSync(join(work, "key.pub"), "utf8").trim();

const { forge, register, waitFor } = session(origin, true);
await register(`Laptop${Date.now().toString(36)}`);
const signed = must(await forge.approve(must(await forge.prepareProject("laptop-check"), "prepare")), "sign inception");
const id = must(await forge.approve(must(await forge.prepareInception(signed.id), "prepare first policy")), "approve first policy").id;
let state = must(await forge.approve(must(await forge.preparePerson(id, publicKey), "prepare laptop key")), "approve laptop key");
const person = state.agents.find((a) => a.kind === "person")!;
step(`admitted ${person.fingerprint} as ${person.id}, fork ${person.fork}`);

const subscribed: string[] = [];
try {
  const access = must(await forge.pushAccess(id, person.id), "push access");
  if (!access.pushEvents) {
    wrangler([
      "queues", "subscription", "create", values.queue!, "--source", "artifacts.repo", "--events", "pushed",
      "--source-namespace", values.namespace!, "--source-repo-name", person.fork, "--name", `forge-check-${person.fork}`.slice(0, 63),
    ]);
    const list = JSON.parse(wrangler(["queues", "subscription", "list", values.queue!, "--json", "--per-page", "100"])) as { id: string; source?: { repo_name?: string } }[];
    subscribed.push(...list.filter((s) => s.source?.repo_name === person.fork).map((s) => s.id));
    step(`subscribed the queue to ${person.fork}`);
  }
  // The commands as the forge gave them, with the key path of this run.
  const shell = (command: string, cwd: string) => execFileSync("sh", ["-c", command], { cwd, stdio: "pipe" });
  shell(access.commands[0]!.replace(/ && cd .*$/, ""), work);
  const repo = join(work, person.fork);
  shell(access.commands[1]!.replace("~/.ssh/id_ed25519.pub", join(work, "key.pub")), repo);
  shell("git config user.name 'Laptop check' && git config user.email laptop@example.com", repo);
  shell(access.commands[2]!, repo);
  writeFileSync(join(repo, "notes", "laptop.md"), "# From a laptop\n\nSigned with the person's own key.\n");
  shell("git add notes/laptop.md && git commit -q -m 'Add a note from a laptop'", repo);
  shell(access.commands[4]!, repo);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
  step(`pushed signed commit ${head.slice(0, 7)} to ${person.fork} my-change`);

  state = await waitFor(id, (s) => s.proposals.some((p) => p.head === head && p.status !== "verifying"), "the push event", 180_000);
  const proposal = state.proposals.find((p) => p.head === head)!;
  const r3 = proposal.report?.commits[0]?.rules.find((r) => r.rule === "R3");
  step(`the forge made "${proposal.title}": ${proposal.status}; R3: ${r3?.reason}`);
  if (proposal.status !== "ready") throw new Error(`the push did not verify: ${proposal.report?.summary}`);
  state = must(await forge.approve(must(await forge.preparePromotion(id, proposal.id), "prepare promotion")), "promote");
  const fresh = must(await forge.verifyFresh(id), "verify");
  step(`promoted; fresh clone: ${fresh.report.summary}`);
  if (!fresh.report.ok) throw new Error("the history does not verify");
  console.log("laptop-check: passed");
} finally {
  for (const sub of subscribed) wrangler(["queues", "subscription", "delete", values.queue!, "--id", sub, "--force"]);
  if (!values.keep) must(await forge.reset(id), "delete the project");
  step(values.keep ? `kept project ${id}` : "deleted the project and the check's subscription");
}
