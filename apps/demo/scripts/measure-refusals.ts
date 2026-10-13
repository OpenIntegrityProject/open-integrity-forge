// Time every refusal arm against a deployed measurement Worker and recommend a
// refusal timing floor. The method, and the last run's results, are in
// docs/refusal-floor.md.
//
//   node scripts/measure-refusals.ts https://<measurement host> [rounds] [--floor <ms>]
//
// Run it from apps/demo. It deploys wrangler.measure.jsonc to the host, with
// the relying party set to it, a random member name as its operator and, with
// --floor, that refusal timing floor; so wrangler must be logged in to the
// account that owns the Worker.

import { execFileSync } from "node:child_process";
import { SoftwareAuthenticator } from "passkey-cloudflare/testing";
import { Browser, type Target } from "../test/browser.ts";
import { awaitNewVersion } from "../test/new-version.ts";
import { refusalArms } from "../test/refusal-arms.ts";
import { recommendFloor, summarize, type ArmSummary } from "../test/refusal-timing.ts";

const REFUSAL = '{"error":"ceremony refused"}';
const BASELINE = "(baseline: unknown route)";

const USAGE = "usage: node scripts/measure-refusals.ts https://<measurement host> [rounds] [--floor <ms>]";

const args = process.argv.slice(2);
const floorAt = args.indexOf("--floor");
const floor = floorAt === -1 ? undefined : args.splice(floorAt, 2)[1];
const [originArg, roundsArg = "150"] = args;
if (!originArg?.startsWith("https://") || (floorAt !== -1 && !/^\d+$/.test(floor ?? ""))) {
  console.error(USAGE);
  process.exit(2);
}
const origin: string = originArg;
const rounds = Number(roundsArg);

const target: Target = { origin, fetch: (request) => fetch(request), edge: true };
const browser = () => new Browser(target, new SoftwareAuthenticator({ origin }));

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 1000));

/**
 * Deploy the measurement Worker with a new operator name, register that name,
 * and wait until the new version answers. Only the new version lists the name,
 * so its operator answers come from it; the previous version, which may still
 * answer for a while, may have no relying party for the host at all.
 */
async function deployWithOperator(): Promise<Browser> {
  const memberName = `Measureop${crypto.randomUUID().slice(0, 8)}`;
  const host = new URL(origin).host;
  const vars = [`RP_ID:${host}`, `ORIGIN:${origin}`, `OPERATOR_MEMBER_NAMES:${memberName}`];
  if (floor !== undefined) vars.push(`REFUSAL_FLOOR_MS:${floor}`);
  execFileSync("npx", ["wrangler", "deploy", "-c", "wrangler.measure.jsonc", ...vars.flatMap((v) => ["--var", v])], {
    stdio: ["ignore", "ignore", "inherit"],
  });

  const operator = browser();
  for (let attempt = 0; ; attempt++) {
    try {
      await operator.register(memberName);
      break;
    } catch (e) {
      // A taken name will not free up: an earlier attempt registered it but its answer was lost, or the name was reused.
      if (attempt === 30 || String(e).includes("name-unavailable")) {
        throw new Error(`could not register the operator: ${e}`);
      }
      await pause();
    }
  }
  await awaitNewVersion(async () => (await operator.json(operator.get("/me"))).operator, { attempts: 60, pause });
  await operator.stepUp();
  return operator;
}

/** Wall time of one POST, in milliseconds, with the response it got. */
async function timed(path: string, body: unknown) {
  const request = new Request(origin + path, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const started = performance.now();
  const response = await fetch(request);
  const text = await response.text();
  return { ms: performance.now() - started, status: response.status, text };
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0]! % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const operator = await deployWithOperator();
const arms = await refusalArms({
  browser,
  suspend: async (recordId) => void (await operator.json(operator.post("/operator/suspend", { recordId }))),
});

const samples: Record<string, number[]> = { [BASELINE]: [] };
for (const arm of Object.keys(arms)) samples[arm] = [];

// Round 0 warms the Worker and its Durable Objects and is not counted.
for (let round = 0; round <= rounds; round++) {
  for (const [arm, prepare] of shuffle(Object.entries(arms))) {
    const { path, body } = await prepare();
    const { ms, status, text } = await timed(path, body);
    if (status !== 400 || text !== REFUSAL) throw new Error(`${arm}: expected the refusal, got ${status} ${text}`);
    if (round > 0) samples[arm]!.push(ms);
  }
  const baseline = await timed("/auth/not-a-route", {});
  if (round > 0) samples[BASELINE]!.push(baseline.ms);
  process.stderr.write(`round ${round}/${rounds}\r`);
}

const { [BASELINE]: baseline, ...armSamples } = samples;
const summaries = summarize(armSamples);
const [base] = summarize({ [BASELINE]: baseline! });
const row = (s: ArmSummary) =>
  `| ${s.arm} | ${s.n} | ${Math.round(s.p50)} | ${Math.round(s.p95)} | ${Math.round(s.p99)} | ${Math.round(s.max)} |`;

console.log(`Measured ${new Date().toISOString().slice(0, 10)} against ${origin}, ${rounds} rounds.\n`);
console.log("| Arm | n | p50 ms | p95 ms | p99 ms | max ms |\n|---|---|---|---|---|---|");
for (const s of [...summaries, base!]) console.log(row(s));
console.log(`\nRecommended REFUSAL_FLOOR_MS: ${recommendFloor(summaries)}`);
