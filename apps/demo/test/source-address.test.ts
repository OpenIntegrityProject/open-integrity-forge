import { env } from "cloudflare:test";
import { SoftwareAuthenticator, missingSourceWarning, relyingPartyMatches } from "passkey-cloudflare/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { counting } from "./failing-namespaces.ts";
import { globalFailures } from "./failure-log.ts";
import { Browser, ORIGIN, prepared, refusal, testApp, uniqueName, type TestApp } from "./harness.ts";

// Every per-source rate limit keys on the request's source address, which the
// app names with `sourceOf` (by default, CF-Connecting-IP). A request with no
// source address would share every per-source limit with every other one, so
// each ceremony and each options request without one is refused, and the
// misconfiguration is logged once per isolate.

const REFUSAL = '{"error":"ceremony refused"}';
const HOUR = 60 * 60 * 1000;

afterEach(() => {
  vi.restoreAllMocks();
  missingSourceWarning.logged = false;
});

/**
 * A browser reaching the app through something that rewrites its requests'
 * headers on the way, such as a proxy or a Worker in front.
 */
function browserBehind(app: TestApp, rewrite: (headers: Headers, ip: string) => void): Browser {
  const browser: Browser = new Browser(
    {
      origin: app.origin,
      fetch: (request) => {
        const headers = new Headers(request.headers);
        rewrite(headers, browser.ip);
        return app.fetch(new Request(request, { headers }));
      },
    },
    new SoftwareAuthenticator({ origin: ORIGIN }),
  );
  return browser;
}

/** A browser whose requests reach the app with no CF-Connecting-IP. */
function browserWithoutSource(app: TestApp): Browser {
  return browserBehind(app, (headers) => headers.delete("CF-Connecting-IP"));
}

describe("a source address named by sourceOf", () => {
  it("gives browsers with different forwarded addresses separate per-source limits", async () => {
    const app = testApp({
      sourceOf: (request) => request.headers.get("X-Forwarded-For"),
      rateLimits: { optionsPerSource: { limit: 1, windowMs: HOUR } },
    });
    const forwarded = (headers: Headers, ip: string) => {
      headers.delete("CF-Connecting-IP");
      headers.set("X-Forwarded-For", ip);
    };
    const first = browserBehind(app, forwarded);
    const second = browserBehind(app, forwarded);
    expect((await first.post("/auth/login/options")).status).toBe(200);

    const refused = await first.post("/auth/login/options");

    expect(refused.status).toBe(400);
    expect(await refused.text()).toBe(REFUSAL);
    expect((await second.post("/auth/login/options")).status).toBe(200);
  });
});

describe("a request with no source address", () => {
  it("refuses a login with the uniform refusal and records a configuration cause", async () => {
    const app = testApp();
    const browser = app.browser();
    await browser.register(uniqueName());
    const login = prepared(await browser.client.loginRequest());
    vi.spyOn(console, "error").mockImplementation(() => {});

    const refused = await browserWithoutSource(app).post(login.path, login.body);

    expect(refused.status).toBe(400);
    expect(await refused.text()).toBe(REFUSAL);
    expect(await globalFailures(app.storagePrefix)).toEqual([{ ceremony: "login", cause: "source-unknown" }]);
  });

  it("refuses a login before any Durable Object call but the failure log's", async () => {
    const app = testApp();
    const browser = app.browser();
    await browser.register(uniqueName());
    const login = prepared(await browser.client.loginRequest());
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Forget the RP ID match, so a ceremony that got past the source check would read the credential index.
    relyingPartyMatches.clear();
    const bindings = ["IDENTITY_RECORDS", "CREDENTIAL_INDEX", "CHALLENGES", "RATE_LIMITS"] as const;
    const counted = bindings.map((binding) => {
      const { namespace, calls } = counting(env[binding]);
      app.vars[binding] = namespace as never;
      return calls;
    });

    const refused = await browserWithoutSource(app).post(login.path, login.body);

    expect(refused.status).toBe(400);
    expect(counted.flat()).toEqual([]);
  });

  it("refuses login options with the uniform refusal and records nothing", async () => {
    const app = testApp();
    vi.spyOn(console, "error").mockImplementation(() => {});

    const refused = refusal(await browserWithoutSource(app).client.loginRequest());

    expect(refused.status).toBe(400);
    expect(await refused.text()).toBe(REFUSAL);
    expect(await globalFailures(app.storagePrefix)).toEqual([]);
  });

  it("refuses a member-name check, and records nothing", async () => {
    const app = testApp();
    vi.spyOn(console, "error").mockImplementation(() => {});

    const refused = await browserWithoutSource(app).get(`/auth/member-name?name=${uniqueName()}`);

    expect(refused.status).toBe(400);
    expect(await refused.text()).toBe(REFUSAL);
    expect(await globalFailures(app.storagePrefix)).toEqual([]);
  });

  it("is logged once per isolate", async () => {
    const app = testApp();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const browser = browserWithoutSource(app);

    await browser.post("/auth/login/options");
    await browser.post("/auth/login/options");

    const sourceErrors = logged.mock.calls.filter(([message]) => String(message).includes("source address"));
    expect(sourceErrors).toHaveLength(1);
  });

  it("leaves a read route that is not rate limited unaffected", async () => {
    const app = testApp();
    const browser = app.browser();
    await browser.register(uniqueName());
    const unsourced = browserWithoutSource(app);
    unsourced.session = browser.session;

    expect((await unsourced.get("/me")).status).toBe(200);
  });
});
