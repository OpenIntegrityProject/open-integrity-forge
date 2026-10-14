// SSH signatures (the OpenSSH SSHSIG format) with Ed25519 keys, as
// `ssh-keygen -Y sign` makes them and `git verify-commit` checks them.
// Specification: PROTOCOL.sshsig in the OpenSSH source.

import { concat, equalBytes, fromBase64, fromUtf8, sha256, sha512, toBase64, utf8 } from "./bytes.ts";

export const MAGIC = utf8("SSHSIG");
const KEY_TYPE = "ssh-ed25519";
const HASH = "sha512";
export const BEGIN = "-----BEGIN SSH SIGNATURE-----";
export const END = "-----END SSH SIGNATURE-----";

export function uint32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

/** An SSH wire string: a 32-bit length, then the bytes. */
export function sshString(data: Uint8Array | string): Uint8Array {
  const bytes = typeof data === "string" ? utf8(data) : data;
  return concat(uint32(bytes.length), bytes);
}

// Plain fields, not parameter properties, so that Node can strip the types.
export class Reader {
  private offset = 0;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  take(n: number): Uint8Array {
    if (this.offset + n > this.bytes.length) throw new Error("the SSH data ends too soon");
    const out = this.bytes.slice(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  uint32(): number {
    const b = this.take(4);
    return ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  }

  string(): Uint8Array {
    return this.take(this.uint32());
  }

  text(): string {
    return fromUtf8(this.string());
  }

  done(): boolean {
    return this.offset === this.bytes.length;
  }
}

/** The SSH wire form of an Ed25519 public key. */
function publicKeyBlob(raw: Uint8Array): Uint8Array {
  if (raw.length !== 32) throw new Error("an Ed25519 public key has 32 bytes");
  return concat(sshString(KEY_TYPE), sshString(raw));
}

/** `ssh-ed25519 AAAA...`, as it appears in authorized_keys and allowed signers files. */
export function publicKeyText(raw: Uint8Array): string {
  return `${KEY_TYPE} ${toBase64(publicKeyBlob(raw))}`;
}

/** The 32 key bytes of an `ssh-ed25519 AAAA...` line. Throws an error on any other key type. */
export function parsePublicKeyText(text: string): Uint8Array {
  const [type, body] = text.trim().split(/\s+/);
  if (type !== KEY_TYPE || !body) throw new Error("not an ssh-ed25519 public key");
  return rawFromBlob(fromBase64(body));
}

function rawFromBlob(blob: Uint8Array): Uint8Array {
  const reader = new Reader(blob);
  if (reader.text() !== KEY_TYPE) throw new Error("not an ssh-ed25519 public key");
  const raw = reader.string();
  if (raw.length !== 32 || !reader.done()) throw new Error("bad ssh-ed25519 public key");
  return raw;
}

/** The fingerprint ssh-keygen shows: `SHA256:` and the unpadded Base64 of the key blob digest. */
export async function fingerprint(raw: Uint8Array): Promise<string> {
  return "SHA256:" + toBase64(await sha256(publicKeyBlob(raw))).replace(/=+$/, "");
}

/** The bytes the key signs: the magic, the namespace, the hash name and the message digest. */
export async function signedData(namespace: string, message: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return concat(MAGIC, sshString(namespace), sshString(""), sshString(HASH), sshString(await sha512(message)));
}

export function armor(blob: Uint8Array): string {
  const body = toBase64(blob).match(/.{1,70}/g)!.join("\n");
  return `${BEGIN}\n${body}\n${END}\n`;
}

/** A new Ed25519 key pair for SSH signatures. The private key is extractable, so a Durable Object can keep it. */
export async function generateKey(): Promise<{ privateKey: CryptoKey; publicKey: Uint8Array }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as { privateKey: CryptoKey; publicKey: CryptoKey };
  const publicKey = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return { privateKey: pair.privateKey, publicKey };
}

/** Sign `message` with an Ed25519 key. Returns the armored signature, as git stores it in a commit. */
export async function sign(
  message: Uint8Array | string,
  privateKey: CryptoKey,
  publicKey: Uint8Array,
  namespace = "git",
): Promise<string> {
  const bytes = typeof message === "string" ? utf8(message) : message;
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, privateKey, await signedData(namespace, bytes)),
  );
  const blob = concat(
    MAGIC,
    uint32(1),
    sshString(publicKeyBlob(publicKey)),
    sshString(namespace),
    sshString(""),
    sshString(HASH),
    sshString(concat(sshString(KEY_TYPE), sshString(signature))),
  );
  return armor(blob);
}

interface ParsedSignature {
  publicKey: Uint8Array;
  namespace: string;
  hash: string;
  signature: Uint8Array;
}

/** Read an armored SSH signature. Throws an error if it is not one, or if its key is not Ed25519. */
function parseSignature(armored: string): ParsedSignature {
  const text = armored.trim();
  if (!text.startsWith(BEGIN) || !text.endsWith(END)) throw new Error("not an SSH signature");
  const reader = new Reader(fromBase64(text.slice(BEGIN.length, -END.length)));
  if (!equalBytes(reader.take(6), MAGIC)) throw new Error("not an SSH signature");
  if (reader.uint32() !== 1) throw new Error("unknown SSH signature version");
  const publicKey = rawFromBlob(reader.string());
  const namespace = reader.text();
  reader.string();
  const hash = reader.text();
  const sig = new Reader(reader.string());
  if (sig.text() !== KEY_TYPE) throw new Error("not an Ed25519 signature");
  const signature = sig.string();
  if (signature.length !== 64) throw new Error("bad Ed25519 signature");
  return { publicKey, namespace, hash, signature };
}

/**
 * Check an armored signature over `message`. Returns the public key that
 * made it when it verifies, else null. The caller decides whether it trusts
 * that key.
 */
export async function verify(
  armored: string,
  message: Uint8Array | string,
  namespace = "git",
): Promise<{ publicKey: Uint8Array } | null> {
  let parsed: ParsedSignature;
  try {
    parsed = parseSignature(armored);
  } catch {
    return null;
  }
  if (parsed.namespace !== namespace) return null;
  if (parsed.hash !== "sha512" && parsed.hash !== "sha256") return null;
  const bytes = typeof message === "string" ? utf8(message) : message;
  const digest =
    parsed.hash === "sha512"
      ? await sha512(bytes)
      : new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  const data = concat(MAGIC, sshString(namespace), sshString(""), sshString(parsed.hash), sshString(digest));
  const key = await crypto.subtle.importKey("raw", parsed.publicKey as Uint8Array<ArrayBuffer>, { name: "Ed25519" }, false, [
    "verify",
  ]);
  const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, parsed.signature as Uint8Array<ArrayBuffer>, data);
  return ok ? { publicKey: parsed.publicKey } : null;
}
