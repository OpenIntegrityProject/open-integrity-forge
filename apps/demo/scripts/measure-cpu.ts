// Run every successful ceremony against a deployed measurement Worker, so its
// CPU time per request can be read from Workers observability. The method, and
// the last run's results, are in docs/workers-free.md.
//
//   node scripts/measure-cpu.ts https://<measurement host> [rounds]
//
// Run it from apps/demo. It deploys wrangler.measure.jsonc to the host, with
// the relying party set to it and a relying party name no earlier deploy used,
// so wrangler must be logged in to the account that owns the Worker. Round 0
// then holds each ceremony's first verification on a new script version; the
// probes that wait for it have already called register options.

import { execFileSync } from "node:child_process";
import { SoftwareAuthenticator } from "passkey-cloudflare/testing";
import { Browser, uniqueName, type Target } from "../test/browser.ts";
import { awaitNewVersion } from "../test/new-version.ts";

const [originArg, roundsArg = "20"] = process.argv.slice(2);
if (!originArg?.startsWith("https://")) {
  console.error("usage: node scripts/measure-cpu.ts https://<measurement host> [rounds]");
  process.exit(2);
}
const origin: string = originArg;
const rounds = Number(roundsArg);

const target: Target = { origin, fetch: (request) => fetch(request), edge: true };
const browser = () => new Browser(target, new SoftwareAuthenticator({ origin }));

/**
 * Deploy the measurement Worker with a new relying party name, and wait until
 * the new version answers. Every deploy of the same code answers any other
 * request the same way, so only the name tells the new version from the last.
 */
async function deployNewVersion() {
  const rpName = `CPU measurement ${crypto.randomUUID().slice(0, 8)}`;
  const host = new URL(origin).host;
  const vars = [`RP_ID:${host}`, `ORIGIN:${origin}`, `RP_NAME:${rpName}`];
  execFileSync("npx", ["wrangler", "deploy", "-c", "wrangler.measure.jsonc", ...vars.flatMap((v) => ["--var", v])], {
    stdio: ["ignore", "ignore", "inherit"],
  });

  // Each probe asks for registration options for a new member name; the previous
  // version may refuse it, having no relying party for the host.
  const prober = browser();
  const answersNew = async () => {
    const response = await prober.post("/auth/register/options", { memberName: uniqueName("probe") });
    return response.ok && (await response.json<{ rp?: { name?: string } }>()).rp?.name === rpName;
  };
  const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 1000));
  return awaitNewVersion(answersNew, { attempts: 300, pause });
}

// The probes fall inside the window, as extra register options requests.
const started = new Date();
const probes = await deployNewVersion();
for (let round = 0; round <= rounds; round++) {
  const person = browser();
  const memberName = uniqueName("cpu");
  const { recoveryCodes } = await person.register(memberName);
  person.session = undefined;
  await person.login();
  await person.stepUp();
  await person.enrol();

  const recovered = await browser().recover(memberName, recoveryCodes[0]!);
  if (recovered.result !== "ok") throw new Error(`recovery not accepted: ${recovered.result}`);
  process.stderr.write(`round ${round}/${rounds}\r`);
}

// Observability is queried by this window and the request paths.
console.log(`Ran ${rounds + 1} rounds against ${origin}, after ${probes} probes for the new version`);
console.log(`from ${started.toISOString()} to ${new Date().toISOString()}`);
