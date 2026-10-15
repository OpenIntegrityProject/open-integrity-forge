#!/usr/bin/env node
// Run the full story against a live forge over HTTP, as a person with a
// software authenticator does, and measure the time of each step. Use it on
// `wrangler dev`, or on the deployed forge to check the real Artifacts service
// end to end.
//
//   node scripts/smoke.ts <origin> [--runs 2] [--keep] [--edge]
//
// `--edge` is for a deployed forge, where the Cloudflare edge sets the client
// address itself. `--keep` keeps the projects. By default, each run deletes
// its project, its repositories and its forks at the end. The software
// authenticator is test-only code: it signs all data that it gets.

import { parseArgs } from "node:util";
import { must, session } from "./session.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { runs: { type: "string", default: "1" }, keep: { type: "boolean", default: false }, edge: { type: "boolean", default: false } },
});
if (positionals.length !== 1) {
  console.error("usage: node scripts/smoke.ts <origin> [--runs 2] [--keep] [--edge]");
  process.exit(2);
}
const origin = positionals[0]!.replace(/\/+$/, "");

async function run(n: number): Promise<{ step: string; ms: number }[]> {
  const { forge, register, waitFor } = session(origin, values.edge!);
  const times: { step: string; ms: number }[] = [];
  const timed = async <T>(step: string, fn: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    const value = await fn();
    times.push({ step, ms: Math.round(performance.now() - start) });
    return value;
  };
  await timed("register", () => register(`Smoke${Date.now().toString(36)}${n}`));
  const project = await timed("inception (sign the root, approve the first policy)", async () => {
    const signed = must(await forge.approve(must(await forge.prepareProject(`smoke-${n}`), "prepare project")), "sign inception");
    return must(await forge.approve(must(await forge.prepareInception(signed.id), "prepare first policy")), "approve first policy");
  });
  const id = project.id;
  await timed("admit Ada and Bo", async () => must(await forge.approve(must(await forge.prepareAgents(id, ["Ada", "Bo"]), "prepare agents")), "approve agents"));
  let state = await timed("agents propose, both ready", () => waitFor(id, (s) => s.proposals.filter((p) => p.status === "ready").length === 2, "two ready proposals"));
  await timed("rogue task rejected", async () => {
    must(await forge.tempt(id, "bo"), "tempt");
    state = await waitFor(id, (s) => s.proposals.some((p) => p.taskId === "permanent-key" && p.status === "rejected"), "the rejection");
  });
  const rogue = state.proposals.find((p) => p.taskId === "permanent-key")!;
  if (!rogue.report?.summary.includes("a key can never authorize itself")) throw new Error(`unexpected rejection: ${rogue.report?.summary}`);
  const ada = state.proposals.find((p) => p.agentId === "ada")!;
  state = await timed("promote Ada", async () => must(await forge.approve(must(await forge.preparePromotion(id, ada.id), "prepare promotion")), "approve promotion"));
  await timed("release v1.0.0", async () => must(await forge.approve(must(await forge.prepareRelease(id, "v1.0.0"), "prepare release")), "approve release"));
  await timed("revoke Bo's key", async () => must(await forge.approve(must(await forge.prepareRevocation(id, "bo"), "prepare revocation")), "approve revocation"));
  const fresh = await timed("verify from a fresh clone", async () => must(await forge.verifyFresh(id), "verify"));
  if (!fresh.report.ok || fresh.report.repoId !== state.repoId) throw new Error(`fresh clone does not verify: ${fresh.report.summary}`);
  if (!fresh.report.tags.some((t) => t.name === "v1.0.0" && t.ok)) throw new Error("the release does not verify in a fresh clone");
  if (!values.keep) await timed("delete the project", async () => must(await forge.reset(id), "reset"));
  console.log(`run ${n}: ${fresh.report.summary} (project ${id}${values.keep ? ", kept" : ", deleted"})`);
  return times;
}

const runs = Number(values.runs);
const all: { step: string; ms: number }[][] = [];
for (let n = 1; n <= runs; n++) all.push(await run(n));
console.log("");
console.log(`| Step | ${all.map((_, i) => `Run ${i + 1} (ms)`).join(" | ")} |`);
console.log(`| --- | ${all.map(() => "---").join(" | ")} |`);
for (const [i, { step }] of all[0]!.entries()) console.log(`| ${step} | ${all.map((r) => r[i]?.ms ?? "").join(" | ")} |`);
