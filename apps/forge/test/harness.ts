import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import type { PublicKeyCredentialCreationOptionsJSON, RegistrationResponseJSON } from "passkey-cloudflare/browser";
import { SoftwareAuthenticator, type Tamper } from "passkey-cloudflare/testing";
import { DemoClient, type Authenticator } from "../../demo/browser/demo-client.ts";
import { Browser } from "../../demo/test/browser.ts";
import { ForgeClient, type Outcome } from "../browser/forge-client.ts";
import { createForge } from "../src/forge.ts";
import type { ProjectState } from "../src/state.ts";

export const ORIGIN = "http://localhost:8787";

/** The forge Worker as a test drives it, with its own storage prefix for the passkey records. */
export function testForge() {
  const storagePrefix = crypto.randomUUID();
  const clock = { offsetMs: 0 };
  const app = createForge({ storagePrefix, rateLimits: {}, clock: () => Date.now() + clock.offsetMs });
  return {
    origin: ORIGIN,
    storagePrefix,
    /** Move the identity layer's clock, as for a step-up that lapses. */
    clock,
    async fetch(request: Request): Promise<Response> {
      const ctx = createExecutionContext();
      const response = await app.fetch(request, env as Env, ctx);
      await waitOnExecutionContext(ctx);
      return response;
    },
  };
}

export type TestForge = ReturnType<typeof testForge>;

/** A person at a browser: cookies, a software authenticator, the demo client and the forge client. */
export class Person {
  readonly browser: Browser;
  readonly authenticator: SoftwareAuthenticator;
  readonly demo: DemoClient;
  readonly forge: ForgeClient;
  /** The registration response of the last passkey made, as the page keeps it. */
  created: RegistrationResponseJSON | null = null;
  /** How the next approval is bent, for a test that expects a refusal. */
  tamper: Tamper | undefined;

  constructor(app: TestForge) {
    this.authenticator = new SoftwareAuthenticator({ origin: app.origin });
    this.browser = new Browser(app, this.authenticator);
    const self = this;
    const authenticator: Authenticator = {
      async create(options: PublicKeyCredentialCreationOptionsJSON) {
        self.created = await self.authenticator.create(options);
        return { result: "created", response: self.created };
      },
      async get(options) {
        return { result: "found", response: await self.authenticator.get(options) };
      },
    };
    const target = { origin: app.origin, fetch: (request: Request) => this.browser.send(request) };
    this.demo = new DemoClient(target, authenticator);
    this.forge = new ForgeClient(target, this.demo, {
      approve: async (options) => ({ result: "found", response: await self.authenticator.get(options, self.tamper) }),
    });
  }

  /** Register, and make the new passkey the promoter key, as the page does. */
  async register(memberName: string) {
    const registered = await this.demo.register(memberName);
    if (registered.result !== "ok") throw new Error(`registration: ${registered.result}`);
    const key = must(await this.forge.setPromoterKey(this.created));
    return key;
  }
}

/** Create a project as the page does: sign the empty inception commit, then approve the first policy. */
export async function createProject(person: Person, name: string): Promise<Outcome<ProjectState>> {
  const prepared = await person.forge.prepareProject(name);
  if (prepared.result !== "ok") return prepared;
  const signed = await person.forge.approve(prepared.value);
  if (signed.result !== "ok") return signed;
  const first = await person.forge.prepareInception(signed.value.id);
  if (first.result !== "ok") return first;
  return person.forge.approve(first.value);
}

export function must<T>(outcome: Outcome<T>): T {
  if (outcome.result === "ok") return outcome.value;
  throw new Error(outcome.result === "cancelled" ? "cancelled" : `${outcome.status} ${outcome.refusal.error}: ${outcome.refusal.reason}`);
}

let names = 0;
export const uniqueName = (prefix: string) => `${prefix}${Date.now().toString(36)}${++names}`;

/** Poll the project until `ready` holds, as the page does. */
export async function waitFor(person: Person, projectId: string, ready: (s: ProjectState) => boolean, what: string, ms = 30_000) {
  const until = Date.now() + ms;
  let last: ProjectState | undefined;
  while (Date.now() < until) {
    last = must(await person.forge.state(projectId));
    if (ready(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last?.agents.map((a) => a.tasks), null, 1)}`);
}
