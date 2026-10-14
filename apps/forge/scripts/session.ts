// A person at a live forge, for the scripts: a software authenticator,
// cookies, the demo client and the forge client. The software authenticator
// is test-only code: it signs all data that it gets.

import type { RegistrationResponseJSON } from "passkey-cloudflare/browser";
import { SoftwareAuthenticator } from "passkey-cloudflare/testing";
import { DemoClient, type Authenticator } from "../../demo/browser/demo-client.ts";
import { Browser } from "../../demo/test/browser.ts";
import { ForgeClient, type Outcome } from "../browser/forge-client.ts";
import type { ProjectState } from "../src/state.ts";

export function must<T>(outcome: Outcome<T>, what: string): T {
  if (outcome.result === "ok") return outcome.value;
  throw new Error(`${what}: ${outcome.result === "refused" ? `${outcome.status} ${outcome.refusal.reason}` : "cancelled"}`);
}

export function session(origin: string, edge: boolean) {
  const authenticator = new SoftwareAuthenticator({ origin });
  const browser = new Browser({ origin, edge, fetch: (request) => fetch(request) }, authenticator);
  let created: RegistrationResponseJSON | null = null;
  const passkeys: Authenticator = {
    async create(options) {
      created = await authenticator.create(options);
      return { result: "created", response: created };
    },
    async get(options) {
      return { result: "found", response: await authenticator.get(options) };
    },
  };
  const target = { origin, fetch: (request: Request) => browser.send(request) };
  const demo = new DemoClient(target, passkeys);
  const forge = new ForgeClient(target, demo, {
    approve: async (options) => ({ result: "found", response: await authenticator.get(options) }),
  });

  return {
    demo,
    forge,
    /** Register a new person and make the new passkey the promoter key, as the page does. */
    async register(memberName: string) {
      const registered = await demo.register(memberName);
      if (registered.result !== "ok") throw new Error(`register: ${registered.result}`);
      must(await forge.setPromoterKey(created), "promoter key");
    },
    /** Poll the project until `ready` is true. */
    async waitFor(id: string, ready: (s: ProjectState) => boolean, what: string, ms = 120_000): Promise<ProjectState> {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const state = must(await forge.state(id), "state");
        if (ready(state)) return state;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error(`timed out waiting for ${what}`);
    },
  };
}
