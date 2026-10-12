import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fromHex } from "./hex.ts";
import { toBase64Url, utf8 } from "../bytes.ts";
import { approvalEnvelopes } from "../envelope.ts";

const vector = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "envelope-approval.json"), "utf8"));

describe("an approval as a Gordian Envelope", () => {
  it("matches the reference CLI byte for byte, in full and elided", async () => {
    const { full, elided } = await approvalEnvelopes({
      payload: toBase64Url(utf8(vector.payload)),
      credentialId: toBase64Url(fromHex(vector.credentialId)),
      authenticatorData: toBase64Url(fromHex(vector.authenticatorData)),
      clientDataJSON: toBase64Url(fromHex(vector.clientDataJSON)),
      signature: toBase64Url(fromHex(vector.signature)),
    });
    expect(full).toEqual({ ur: vector.ur, cbor: vector.cbor, digest: vector.digest });
    expect(elided).toEqual({ ur: vector.elided.ur, cbor: vector.elided.cbor, digest: vector.elided.digest });
    expect(elided.digest).toBe(full.digest);
  });
});
