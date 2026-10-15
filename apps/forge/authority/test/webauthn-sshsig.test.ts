import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fromBase64 } from "../bytes.ts";
import { blobFingerprint, skPublicKeyBlob, skPublicKeyText, sshChallenge, verifyWebauthn, webauthnSignature } from "../webauthn-sshsig.ts";
import { RP_ID, testPromoter } from "./promoter.ts";

const message = "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\n\nhello\n";
const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", "chrome-passkey", name));

/** Make a passkey signature over `text` with a software authenticator, as a browser does. */
async function passkeySigned(text: string, tamper = {}) {
  const leo = await testPromoter();
  const blob = skPublicKeyBlob(leo.entry.publicKey, RP_ID);
  const response = await leo.authenticator.get(
    { challenge: await sshChallenge(text), rpId: RP_ID, allowCredentials: [{ id: leo.entry.credentialId, type: "public-key" }], userVerification: "required" } as any,
    tamper,
  );
  return { blob, armored: webauthnSignature(blob, (response as any).response) };
}

describe("passkey SSH signatures", () => {
  it("verify what they sign, and nothing else", async () => {
    const { blob, armored } = await passkeySigned(message);
    const check = await verifyWebauthn(armored, message);
    expect(check).toMatchObject({ ok: true, rpId: RP_ID, fingerprint: await blobFingerprint(blob) });
    expect(await verifyWebauthn(armored, message + "x")).toMatchObject({ ok: false });
    expect(await verifyWebauthn(armored, message, "file")).toMatchObject({ ok: false });
  });

  it("need the person verified", async () => {
    const { armored } = await passkeySigned(message, { userUnverified: true });
    expect(await verifyWebauthn(armored, message)).toEqual({ ok: false, reason: "The authenticator did not verify the person." });
  });

  it("are accepted by ssh-keygen -Y verify, and a changed message is not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-webauthn-"));
    const { blob, armored } = await passkeySigned(message);
    writeFileSync(join(dir, "msg.sig"), armored);
    writeFileSync(join(dir, "allowed"), `leo namespaces="git" ${skPublicKeyText(blob)}\n`);
    const args = ["-Y", "verify", "-f", join(dir, "allowed"), "-I", "leo", "-n", "git", "-s", join(dir, "msg.sig")];
    expect(execFileSync("ssh-keygen", args, { input: message }).toString()).toContain('Good "git" signature for leo');
    expect(() => execFileSync("ssh-keygen", args, { input: message + "x", stdio: "pipe" })).toThrow();
  });

  it("verify a signature made by a real passkey in Chrome", async () => {
    const payload = fixture("payload");
    const armored = fixture("payload.sig").toString();
    const blob = fromBase64(fixture("passkey.pub").toString().trim().split(/\s+/)[1]!);
    const check = await verifyWebauthn(armored, payload);
    expect(check).toMatchObject({ ok: true, rpId: "localhost", origin: "http://localhost:8790", fingerprint: await blobFingerprint(blob) });
    const changed = Buffer.from(payload);
    changed[changed.length - 2] ^= 0x01;
    expect(await verifyWebauthn(armored, changed)).toMatchObject({ ok: false });
  });
});
