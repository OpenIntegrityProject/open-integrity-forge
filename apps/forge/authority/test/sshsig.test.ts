import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { utf8 } from "../bytes.ts";
import { fingerprint, generateKey, parsePublicKeyText, publicKeyText, sign, verify } from "../sshsig.ts";

const message = "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor A <a@x> 1 +0000\n\nhello\n";

describe("SSH signatures", () => {
  it("verify what they sign, and nothing else", async () => {
    const key = await generateKey();
    const armored = await sign(message, key.privateKey, key.publicKey);
    expect(armored).toMatch(/^-----BEGIN SSH SIGNATURE-----\n/);
    expect((await verify(armored, message))?.publicKey).toEqual(key.publicKey);
    expect(await verify(armored, message + "x")).toBeNull();
    expect(await verify(armored, message, "file")).toBeNull();
  });

  it("are accepted by ssh-keygen -Y verify", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-sshsig-"));
    const key = await generateKey();
    writeFileSync(join(dir, "msg"), message);
    writeFileSync(join(dir, "msg.sig"), await sign(message, key.privateKey, key.publicKey));
    writeFileSync(join(dir, "allowed"), `ada namespaces="git" ${publicKeyText(key.publicKey)}\n`);
    const out = execFileSync(
      "ssh-keygen",
      ["-Y", "verify", "-f", join(dir, "allowed"), "-I", "ada", "-n", "git", "-s", join(dir, "msg.sig")],
      { input: message },
    ).toString();
    expect(out).toContain('Good "git" signature for ada');
  });

  it("verify what ssh-keygen -Y sign makes, and agree on the fingerprint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-sshsig-"));
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(dir, "key")]);
    writeFileSync(join(dir, "msg"), message);
    execFileSync("ssh-keygen", ["-Y", "sign", "-q", "-f", join(dir, "key"), "-n", "git", join(dir, "msg")]);
    const armored = readFileSync(join(dir, "msg.sig"), "utf8");
    const publicKey = parsePublicKeyText(readFileSync(join(dir, "key.pub"), "utf8"));
    expect((await verify(armored, utf8(message)))?.publicKey).toEqual(publicKey);
    const listed = execFileSync("ssh-keygen", ["-l", "-f", join(dir, "key.pub")]).toString();
    expect(listed).toContain(await fingerprint(publicKey));
  });
});
