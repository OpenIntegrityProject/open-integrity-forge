import type { SoftwareAuthenticator, Tamper } from "passkey-cloudflare/testing";
import type { PublicKeyCredentialHint } from "passkey-cloudflare/browser";
import {
  DemoClient,
  type Authenticator,
  type Prepared,
  type Target as ClientTarget,
} from "../browser/demo-client.ts";

// A browser as the tests drive one, against anything that answers requests:
// the demo app in the Workers runtime, or a deployed Worker over the network.
// Nothing here may depend on the Workers test runtime.

/** Where a browser sends its requests. */
export interface Target extends ClientTarget {
  /**
   * True for a real Cloudflare edge, which sets CF-Connecting-IP itself and
   * refuses a request that already carries one.
   */
  edge?: boolean;
}

/** How a software authenticator answers: tampered, or choosing a credential to log in with. */
export interface Answering {
  tamper?: Tamper;
  credentialId?: string;
}

/** A software authenticator behind the client's authenticator seam. It has no sheet, so it never declines. */
export function softwareAuthenticator(authenticator: SoftwareAuthenticator, answering: Answering = {}): Authenticator {
  return {
    create: async (options) => ({ result: "created", response: await authenticator.create(options, answering.tamper) }),
    get: async (options) => ({
      result: "found",
      response: await authenticator.get(options, answering.tamper, answering.credentialId),
    }),
  };
}

/** What a test expects to succeed: its answer, or an error naming the outcome. */
async function accepted<T>(outcome: ({ result: "ok" } & T) | { result: string; response?: Response }): Promise<T> {
  if (outcome.result === "ok") return outcome as T;
  const response = "response" in outcome ? outcome.response : undefined;
  throw new Error(response ? `${response.status} ${await response.text()}` : outcome.result);
}

let ipCounter = 0;

/** One browser: a cookie jar, a source address and an authenticator. */
export class Browser {
  session: string | undefined;
  // Unique per browser, so each has its own rate-limit buckets and failure-log source within an app.
  readonly ip = `2001:db8::${(++ipCounter).toString(16)}`;
  userAgent = "TestBrowser/1.0";

  readonly app: Target;
  readonly authenticator: SoftwareAuthenticator;
  /** The demo client, sending through this browser's cookie jar and source address. */
  readonly client: DemoClient;

  // Plain fields, not parameter properties, so that Node can strip the types
  // when a script imports this file.
  constructor(app: Target, authenticator: SoftwareAuthenticator) {
    this.app = app;
    this.authenticator = authenticator;
    this.client = this.clientAnswering();
  }

  /** A demo client on this browser, its authenticator answering as `answering` says. */
  clientAnswering(answering: Answering = {}): DemoClient {
    return new DemoClient(
      { origin: this.app.origin, fetch: (request) => this.send(request) },
      softwareAuthenticator(this.authenticator, answering),
    );
  }

  /** Send a request as this browser: from its source address, with its session cookie, keeping any it is given. */
  async send(request: Request): Promise<Response> {
    const h = new Headers(request.headers);
    if (!this.app.edge && !h.has("CF-Connecting-IP")) h.set("CF-Connecting-IP", this.ip);
    if (!h.has("User-Agent")) h.set("User-Agent", this.userAgent);
    if (request.method !== "GET" && !h.has("Origin")) h.set("Origin", this.app.origin);
    if (this.session && !h.has("Authorization")) h.set("Cookie", `__Host-session=${this.session}`);
    const response = await this.app.fetch(new Request(request, { headers: h }));
    const setCookie = response.headers.get("Set-Cookie");
    if (setCookie?.startsWith("__Host-session=")) {
      const value = setCookie.slice("__Host-session=".length).split(";")[0]!;
      this.session = value === "" ? undefined : value;
    }
    return response;
  }

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    return this.send(
      new Request(this.app.origin + path, {
        method,
        headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  }

  async post(path: string, body: unknown = {}, headers?: Record<string, string>) {
    return this.request("POST", path, body, headers);
  }

  async get(path: string, headers?: Record<string, string>) {
    return this.request("GET", path, undefined, headers);
  }

  async json<T = any>(response: Promise<Response> | Response): Promise<T> {
    const r = await response;
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return (await r.json()) as T;
  }

  async text(response: Promise<Response> | Response): Promise<string> {
    const r = await response;
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.text();
  }

  /** Register a new person and return what the server answered. */
  async register(memberName: string) {
    return accepted(await this.client.register(memberName));
  }

  async login(credentialId?: string) {
    return accepted(await this.clientAnswering({ credentialId }).login());
  }

  async stepUp() {
    return accepted(await this.client.stepUp());
  }

  /** Add a passkey, stepping up first if the session needs it. */
  async enrol(hint?: PublicKeyCredentialHint) {
    return accepted(await this.client.enrol(hint));
  }

  /** Recover onto this browser's authenticator with a member name and a code. */
  async recover(memberName: string, code: string) {
    return this.client.recover(memberName, code);
  }

  /** Bind a new passkey with a rebind link, as the operator gave it. */
  async rebind(link: string) {
    return this.client.rebind(new URL(link).hash.slice(1));
  }
}

/** A ceremony's prepared request, which the test sends itself; any other outcome fails the test. */
export function prepared(outcome: Prepared | { result: string }): { path: string; body: unknown } {
  if (outcome.result !== "prepared") throw new Error(`expected a prepared request, got ${outcome.result}`);
  const { path, body } = outcome as Prepared;
  return { path, body };
}

/** The server's answer to a ceremony the test expects refused; any other outcome fails the test. */
export function refusal(outcome: { result: string; response?: Response }): Response {
  if (outcome.result !== "refused" || !outcome.response) throw new Error(`expected a refusal, got ${outcome.result}`);
  return outcome.response;
}

let nameCounter = 0;
/**
 * A member name no other call returns. A test app holds every record its test
 * registers, and the scripts share a deployed Worker's storage across runs.
 */
export function uniqueName(prefix = "member"): string {
  return `${prefix}${Date.now().toString(36)}${++nameCounter}`;
}
