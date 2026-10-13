import {
  autofillPasskey,
  canAutofillPasskey,
  canFindWithoutSheet,
  createPasskey,
  creationOptionsFromJSON,
  findPasskey,
  fromBase64Url,
  requestOptionsFromJSON,
  signalRevokedPasskey,
  toBase64Url,
  usePasskey,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "passkey-cloudflare/browser";
import { afterEach, describe, expect, it, vi } from "vitest";

// The browser module runs in a page; here navigator.credentials and
// PublicKeyCredential are stubs that record what the module asked for.

const creationOptions: PublicKeyCredentialCreationOptionsJSON = {
  rp: { id: "example.test", name: "Example" },
  user: { id: "AQID", name: "ada", displayName: "ada" },
  challenge: "BAUG",
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  excludeCredentials: [{ id: "BwgJ", type: "public-key" }],
};

const requestOptions: PublicKeyCredentialRequestOptionsJSON = {
  challenge: "BAUG",
  rpId: "example.test",
  allowCredentials: [{ id: "BwgJ", type: "public-key" }],
};

const authenticationJSON = {
  id: "Cgs",
  rawId: "Cgs",
  type: "public-key",
  response: { clientDataJSON: "DA", authenticatorData: "DQ", signature: "Dg" },
  clientExtensionResults: {},
};

const registrationJSON = {
  id: "Cgs",
  rawId: "Cgs",
  type: "public-key",
  response: { clientDataJSON: "DA", attestationObject: "DQ", transports: ["internal"] },
  clientExtensionResults: {},
};

function stubCredentials(credentials: { create?: (options: unknown) => Promise<unknown>; get?: (options: unknown) => Promise<unknown> }) {
  vi.stubGlobal("navigator", { credentials });
}

function stubCapabilities(getClientCapabilities?: () => Promise<Record<string, boolean>>) {
  vi.stubGlobal("PublicKeyCredential", { getClientCapabilities });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createPasskey", () => {
  it("returns the new credential's response JSON", async () => {
    stubCredentials({ create: async () => ({ toJSON: () => registrationJSON }) });
    expect(await createPasskey(creationOptions)).toEqual({ result: "created", response: registrationJSON });
  });

  it.each(["NotAllowedError", "AbortError"])("returns not-created when the browser rejects with %s", async (name) => {
    stubCredentials({ create: () => Promise.reject(new DOMException("no", name)) });
    expect(await createPasskey(creationOptions)).toEqual({ result: "not-created" });
  });

  it("returns already-registered when the authenticator already holds an excluded passkey", async () => {
    stubCredentials({ create: () => Promise.reject(new DOMException("excluded", "InvalidStateError")) });
    expect(await createPasskey(creationOptions)).toEqual({ result: "already-registered" });
  });

  it("throws any other error, as the application's bug", async () => {
    const error = new DOMException("bad rp", "SecurityError");
    stubCredentials({ create: () => Promise.reject(error) });
    await expect(createPasskey(creationOptions)).rejects.toBe(error);
  });
});

describe("usePasskey", () => {
  it("asks through the ordinary sheet and returns the assertion's response JSON", async () => {
    const asked: unknown[] = [];
    stubCredentials({
      get: async (options) => {
        asked.push(options);
        return { toJSON: () => authenticationJSON };
      },
    });
    expect(await usePasskey(requestOptions)).toEqual({ result: "found", response: authenticationJSON });
    expect(asked).toHaveLength(1);
    expect(Object.keys(asked[0] as object)).toEqual(["publicKey"]);
  });

  it.each(["NotAllowedError", "AbortError"])("returns not-found when the browser rejects with %s", async (name) => {
    stubCredentials({ get: () => Promise.reject(new DOMException("no", name)) });
    expect(await usePasskey(requestOptions)).toEqual({ result: "not-found" });
  });

  it("throws any other error", async () => {
    const error = new DOMException("stale", "InvalidStateError");
    stubCredentials({ get: () => Promise.reject(error) });
    await expect(usePasskey(requestOptions)).rejects.toBe(error);
  });
});

describe("canFindWithoutSheet", () => {
  it("is true when the browser reports immediate get", async () => {
    stubCapabilities(async () => ({ immediateGet: true }));
    expect(await canFindWithoutSheet()).toBe(true);
  });

  it("is false when the browser reports no immediate get", async () => {
    stubCapabilities(async () => ({ conditionalGet: true }));
    expect(await canFindWithoutSheet()).toBe(false);
  });

  it("is false when the browser cannot report its capabilities", async () => {
    stubCapabilities(undefined);
    expect(await canFindWithoutSheet()).toBe(false);
  });

  it("is false when asking for capabilities fails", async () => {
    stubCapabilities(() => Promise.reject(new DOMException("no", "NotSupportedError")));
    expect(await canFindWithoutSheet()).toBe(false);
  });

  it("is false with no WebAuthn at all", async () => {
    vi.stubGlobal("PublicKeyCredential", undefined);
    expect(await canFindWithoutSheet()).toBe(false);
  });
});

describe("canAutofillPasskey", () => {
  it("is true when the browser reports conditional get", async () => {
    stubCapabilities(async () => ({ immediateGet: false, conditionalGet: true }));
    expect(await canAutofillPasskey()).toBe(true);
  });

  it("is false when the browser's capabilities leave conditional get out", async () => {
    stubCapabilities(async () => ({ immediateGet: false }));
    expect(await canAutofillPasskey()).toBe(false);
  });

  it("asks isConditionalMediationAvailable where the browser cannot report its capabilities", async () => {
    vi.stubGlobal("PublicKeyCredential", { isConditionalMediationAvailable: async () => true });
    expect(await canAutofillPasskey()).toBe(true);
    vi.stubGlobal("PublicKeyCredential", { isConditionalMediationAvailable: async () => false });
    expect(await canAutofillPasskey()).toBe(false);
  });

  it("is false when asking fails, or with no WebAuthn at all", async () => {
    stubCapabilities(() => Promise.reject(new DOMException("no", "NotSupportedError")));
    expect(await canAutofillPasskey()).toBe(false);
    vi.stubGlobal("PublicKeyCredential", undefined);
    expect(await canAutofillPasskey()).toBe(false);
  });
});

describe("autofillPasskey", () => {
  it("asks with conditional mediation and the signal, and returns the passkey picked", async () => {
    const asked: Record<string, unknown>[] = [];
    stubCredentials({
      get: async (options) => {
        asked.push(options as Record<string, unknown>);
        return { toJSON: () => authenticationJSON };
      },
    });
    const { signal } = new AbortController();

    expect(await autofillPasskey(requestOptions, signal)).toEqual({ result: "found", response: authenticationJSON });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.mediation).toBe("conditional");
    expect(asked[0]!.signal).toBe(signal);
  });

  it("returns not-found when the request is aborted", async () => {
    // As browsers do: the pending request rejects with the signal's reason, an AbortError.
    stubCredentials({
      get: (options) =>
        new Promise((_, reject) => {
          const { signal } = options as { signal: AbortSignal };
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    });
    const controller = new AbortController();

    const autofilled = autofillPasskey(requestOptions, controller.signal);
    controller.abort();

    expect(await autofilled).toEqual({ result: "not-found" });
  });

  it("throws any other error", async () => {
    const error = new DOMException("bad rp", "SecurityError");
    stubCredentials({ get: () => Promise.reject(error) });
    await expect(autofillPasskey(requestOptions, new AbortController().signal)).rejects.toBe(error);
  });
});

describe("signalRevokedPasskey", () => {
  const revoked = { rpId: "example.test", credentialId: "Cgs" };

  it("tells the password manager the credential is unknown", async () => {
    const signalUnknownCredential = vi.fn(async () => {});
    vi.stubGlobal("PublicKeyCredential", { signalUnknownCredential });

    await signalRevokedPasskey(revoked);

    expect(signalUnknownCredential).toHaveBeenCalledWith({ rpId: "example.test", credentialId: "Cgs" });
  });

  it("does nothing where the browser has no signal", async () => {
    stubCapabilities();
    await expect(signalRevokedPasskey(revoked)).resolves.toBeUndefined();
    vi.stubGlobal("PublicKeyCredential", undefined);
    await expect(signalRevokedPasskey(revoked)).resolves.toBeUndefined();
  });

  it("swallows a rejected signal", async () => {
    vi.stubGlobal("PublicKeyCredential", {
      signalUnknownCredential: async () => {
        throw Object.assign(new Error("bad"), { name: "SecurityError" });
      },
    });

    await expect(signalRevokedPasskey(revoked)).resolves.toBeUndefined();
  });
});

describe("findPasskey", () => {
  /** A get that records each request's spelling (its keys other than publicKey) and answers from `answers` in turn. */
  function stubGet(...answers: (() => Promise<unknown>)[]) {
    const spellings: Record<string, unknown>[] = [];
    stubCredentials({
      get: (options) => {
        const { publicKey: _, ...spelling } = options as Record<string, unknown>;
        spellings.push(spelling);
        const answer = answers.shift();
        if (!answer) throw new Error("unexpected get");
        return answer();
      },
    });
    return spellings;
  }
  const found = async () => ({ toJSON: () => authenticationJSON });
  const malformed = () => Promise.reject(new TypeError("unknown member"));

  it("asks with immediate mediation where the browser supports it", async () => {
    stubCapabilities(async () => ({ immediateGet: true }));
    const spellings = stubGet(found);
    expect(await findPasskey(requestOptions)).toEqual({ result: "found", response: authenticationJSON });
    expect(spellings).toEqual([{ mediation: "immediate" }]);
  });

  it("falls through to the second immediate spelling when the first is a TypeError", async () => {
    stubCapabilities(async () => ({ immediateGet: true }));
    const spellings = stubGet(malformed, found);
    expect(await findPasskey(requestOptions)).toEqual({ result: "found", response: authenticationJSON });
    expect(spellings).toEqual([{ mediation: "immediate" }, { uiMode: "immediate" }]);
  });

  it("falls back to a plain get when both immediate spellings are rejected", async () => {
    stubCapabilities(async () => ({ immediateGet: true }));
    const spellings = stubGet(malformed, malformed, found);
    expect(await findPasskey(requestOptions)).toEqual({ result: "found", response: authenticationJSON });
    expect(spellings).toEqual([{ mediation: "immediate" }, { uiMode: "immediate" }, {}]);
  });

  it("goes straight to a plain get without immediate support", async () => {
    stubCapabilities(async () => ({ immediateGet: false }));
    const spellings = stubGet(found);
    expect(await findPasskey(requestOptions)).toEqual({ result: "found", response: authenticationJSON });
    expect(spellings).toEqual([{}]);
  });

  it("returns not-found when an immediate request finds none, without asking again", async () => {
    stubCapabilities(async () => ({ immediateGet: true }));
    const spellings = stubGet(() => Promise.reject(new DOMException("none", "NotAllowedError")));
    expect(await findPasskey(requestOptions)).toEqual({ result: "not-found" });
    expect(spellings).toEqual([{ mediation: "immediate" }]);
  });

  it("returns not-found when a plain get is dismissed", async () => {
    stubCapabilities(undefined);
    stubGet(() => Promise.reject(new DOMException("dismissed", "AbortError")));
    expect(await findPasskey(requestOptions)).toEqual({ result: "not-found" });
  });

  it("throws any other error from an immediate request", async () => {
    stubCapabilities(async () => ({ immediateGet: true }));
    const error = new DOMException("bad rp", "SecurityError");
    stubGet(() => Promise.reject(error));
    await expect(findPasskey(requestOptions)).rejects.toBe(error);
  });
});

describe("JSON and buffers", () => {
  const bytes = (buffer: unknown) => [...new Uint8Array(buffer as Uint8Array)];

  it.each([
    [[], ""],
    [[0xfb], "-w"],
    [[0xfb, 0xff], "-_8"],
    [[0xfb, 0xff, 0xbf], "-_-_"],
    [[1, 2, 3, 4], "AQIDBA"],
  ])("%j is %j in base64url, without padding, both ways", (input, text) => {
    expect(toBase64Url(new Uint8Array(input))).toBe(text);
    expect(bytes(fromBase64Url(text))).toEqual(input);
  });

  it("turns creation options' challenge, user id and excluded ids into buffers", () => {
    const options = creationOptionsFromJSON(creationOptions);
    expect(bytes(options.challenge)).toEqual([4, 5, 6]);
    expect(bytes(options.user.id)).toEqual([1, 2, 3]);
    expect(options.user.name).toBe("ada");
    expect(options.excludeCredentials.map((c) => bytes(c.id))).toEqual([[7, 8, 9]]);
    expect(options.rp).toEqual(creationOptions.rp);
  });

  it("turns request options' challenge and allowed ids into buffers", () => {
    const options = requestOptionsFromJSON(requestOptions);
    expect(bytes(options.challenge)).toEqual([4, 5, 6]);
    expect(options.allowCredentials.map((c) => bytes(c.id))).toEqual([[7, 8, 9]]);
    expect(options.rpId).toBe("example.test");
  });

  it("hands the browser buffers, not base64url text", async () => {
    const asked: { publicKey: { challenge: unknown } }[] = [];
    stubCredentials({
      create: async (options) => {
        asked.push(options as (typeof asked)[number]);
        return { toJSON: () => registrationJSON };
      },
    });
    await createPasskey(creationOptions);
    expect(bytes(asked[0]!.publicKey.challenge)).toEqual([4, 5, 6]);
  });

  const buffer = (...values: number[]) => new Uint8Array(values).buffer;

  it("builds a registration's JSON where the browser has no toJSON", async () => {
    stubCredentials({
      create: async () => ({
        id: "Cgs",
        rawId: buffer(10, 11),
        type: "public-key",
        response: { clientDataJSON: buffer(12), attestationObject: buffer(13), getTransports: () => ["internal"] },
        getClientExtensionResults: () => ({}),
        authenticatorAttachment: "platform",
      }),
    });
    expect(await createPasskey(creationOptions)).toEqual({
      result: "created",
      response: { ...registrationJSON, authenticatorAttachment: "platform" },
    });
  });

  it("builds an assertion's JSON where the browser has no toJSON", async () => {
    stubCapabilities(undefined);
    stubCredentials({
      get: async () => ({
        id: "Cgs",
        rawId: buffer(10, 11),
        type: "public-key",
        response: { clientDataJSON: buffer(12), authenticatorData: buffer(13), signature: buffer(14), userHandle: buffer(15) },
        getClientExtensionResults: () => ({}),
        authenticatorAttachment: null,
      }),
    });
    expect(await findPasskey(requestOptions)).toEqual({
      result: "found",
      response: { ...authenticationJSON, response: { ...authenticationJSON.response, userHandle: "Dw" } },
    });
  });
});
