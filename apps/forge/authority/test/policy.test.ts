import { describe, expect, it } from "vitest";
import { allowedSigners, parsePolicy, PolicyError, renderPolicy, type Policy } from "../policy.ts";

const valid: Policy = {
  version: 1,
  webauthn: { rpId: "forge.example", origin: "https://forge.example" },
  promoters: [
    { id: "leo", kind: "webauthn", credentialId: "AQID", alg: -7, publicKey: { kty: "EC", crv: "P-256", x: "AA", y: "AA" }, since: "2026-10-12T10:00:00.000Z" },
  ],
  authors: [
    {
      id: "ada",
      kind: "ssh-ed25519",
      publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA==",
      fingerprint: "SHA256:x",
      controller: "leo",
      validAfter: "2026-10-12T10:05:00.000Z",
      validBefore: "2026-10-12T11:05:00.000Z",
    },
  ],
};

describe("the policy", () => {
  it("round-trips", () => {
    expect(parsePolicy(renderPolicy(valid))).toEqual(valid);
  });

  const bad: [string, unknown, RegExp][] = [
    ["not JSON", "{", /not JSON/],
    ["no promoters", { ...valid, promoters: [] }, /at least one/],
    ["an unknown version", { ...valid, version: 2 }, /version/],
    ["a bad time", { ...valid, authors: [{ ...valid.authors[0], validBefore: "soon" }] }, /validBefore/],
    ["a duplicate id", { ...valid, authors: [{ ...valid.authors[0], id: "leo" }] }, /unique/],
    ["an ES256 key that is not P-256", { ...valid, promoters: [{ ...valid.promoters[0], publicKey: { kty: "OKP", crv: "Ed25519", x: "AA" } }] }, /P-256/],
  ];
  for (const [what, value, message] of bad) {
    it(`refuses ${what}`, () => {
      const source = typeof value === "string" ? value : JSON.stringify(value);
      expect(() => parsePolicy(source)).toThrow(PolicyError);
      expect(() => parsePolicy(source)).toThrow(message);
    });
  }

  it("gives an OpenSSH allowed signers file with each window", () => {
    expect(allowedSigners(valid)).toContain(
      'ada namespaces="git",valid-after="20261012100500Z",valid-before="20261012110500Z" ssh-ed25519 AAAA',
    );
  });
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sshPublicKeyOfJwk } from "../policy.ts";
import { testPromoter } from "./promoter.ts";
import { testAuthor } from "./history.ts";
import { sign } from "../sshsig.ts";

describe("passkey keys in OpenSSH form", () => {
  for (const algorithm of ["ES256", "Ed25519"] as const) {
    it(`are read by ssh-keygen for ${algorithm}`, async () => {
      const leo = await testPromoter("leo", algorithm);
      const line = sshPublicKeyOfJwk(leo.entry.publicKey);
      expect(line).toMatch(algorithm === "ES256" ? /^ecdsa-sha2-nistp256 AAAA/ : /^ssh-ed25519 AAAA/);
      const dir = mkdtempSync(join(tmpdir(), "forge-sshkey-"));
      writeFileSync(join(dir, "key.pub"), `${line} leo\n`);
      expect(execFileSync("ssh-keygen", ["-l", "-f", join(dir, "key.pub")]).toString()).toMatch(algorithm === "ES256" ? /\(ECDSA\)/ : /\(ED25519\)/);
      // ssh-keygen reads the whole file, passkey lines included, and checks an agent's signature with it.
      const ada = await testAuthor("ada", Date.now() - 60_000, Date.now() + 3600_000);
      const file = allowedSigners({ ...valid, promoters: [leo.entry], authors: [ada.entry] });
      expect(file).toContain(`leo namespaces="forge-approval" ${line}`);
      writeFileSync(join(dir, "allowed"), file);
      const message = "a commit payload\n";
      writeFileSync(join(dir, "msg.sig"), await sign(message, ada.privateKey, ada.publicKey));
      const out = execFileSync("ssh-keygen", ["-Y", "verify", "-f", join(dir, "allowed"), "-I", "ada", "-n", "git", "-s", join(dir, "msg.sig")], { input: message });
      expect(out.toString()).toContain('Good "git" signature for ada');
    });
  }
});
