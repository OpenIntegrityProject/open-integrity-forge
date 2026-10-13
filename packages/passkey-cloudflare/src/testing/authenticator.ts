import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { concatBytes, fromBase64Url, randomBytes, sha256, toBase64Url } from "../encoding.ts";
import { encodeCbor } from "./cbor.ts";

// A software authenticator for tests. It generates real ES256 and Ed25519 keys
// and produces real attestation and assertion responses, and it can be told to
// produce malformed ones. Never use it as a real authenticator: its private
// keys live in memory and it performs no user verification.

export type Algorithm = "ES256" | "Ed25519";

const COSE_ALG: Record<Algorithm, number> = { ES256: -7, Ed25519: -8 };

export interface AuthenticatorOptions {
  /** The origin written into clientDataJSON. */
  origin: string;
  /** Preferred algorithm; it must be offered by the relying party. Default ES256. */
  algorithm?: Algorithm;
  /** Report credentials as backup eligible (synced). Default false. */
  backupEligible?: boolean;
  /** AAGUID as 16 bytes. Default all zeros. */
  aaguid?: Uint8Array;
  /** The transports a registration reports, as the browser's `getTransports()` returns them. Default `["internal"]`. */
  transports?: string[];
}

/** Ways to make a single response wrong. */
export interface Tamper {
  challenge?: string;
  origin?: string;
  rpId?: string;
  type?: string;
  badSignature?: boolean;
  signCount?: number;
  /** Clear the user-present flag. */
  userAbsent?: boolean;
  /** Clear the user-verified flag, as an authenticator that did not verify the person sets it. */
  userUnverified?: boolean;
  /** The client data's `crossOrigin`, as a browser sets it for a ceremony in a cross-origin frame. Default false. */
  crossOrigin?: boolean;
  /** A `topOrigin` in the client data, which a browser adds for a ceremony in a frame. Default absent. */
  topOrigin?: string;
  /** The length in bytes of the credential ID a registration mints. Default 32. */
  credentialIdLength?: number;
  /**
   * Report the backup-eligible bit as given, whatever the authenticator was
   * created with: true sets it and the backed-up bit, as a synced passkey
   * does; false clears both, as a device-bound one does.
   */
  backupEligible?: boolean;
  /**
   * Set the backed-up bit and clear the backup-eligible bit, a pair no
   * authenticator should report. Overrides `backupEligible`.
   */
  backedUpWithoutEligibility?: boolean;
  /**
   * The credential ID a registration mints, as base64url, such as one another
   * record already holds. Overrides `credentialIdLength`. Default random.
   */
  credentialId?: string;
}

export interface StoredCredential {
  id: string;
  rpId: string;
  userHandle: string;
  /** The name the relying party asked to save the passkey under, as a password manager shows it. */
  userName: string;
  algorithm: Algorithm;
  privateKey: CryptoKey;
  signCount: number;
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

function uint32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

// WebCrypto ECDSA signatures are raw r||s; WebAuthn wants ASN.1 DER.
function derFromRawEcdsa(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array): Uint8Array => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    let body = bytes.slice(start);
    if (body[0]! & 0x80) body = concatBytes(new Uint8Array([0]), body);
    return concatBytes(new Uint8Array([0x02, body.length]), body);
  };
  const r = integer(raw.slice(0, 32));
  const s = integer(raw.slice(32));
  return concatBytes(new Uint8Array([0x30, r.length + s.length]), r, s);
}

export class SoftwareAuthenticator {
  readonly credentials: StoredCredential[] = [];
  private readonly origin: string;
  private readonly algorithm: Algorithm;
  private readonly backupEligible: boolean;
  private readonly aaguid: Uint8Array;
  private readonly transports: string[];

  constructor(options: AuthenticatorOptions) {
    this.origin = options.origin;
    this.algorithm = options.algorithm ?? "ES256";
    this.backupEligible = options.backupEligible ?? false;
    this.aaguid = options.aaguid ?? new Uint8Array(16);
    if (this.aaguid.length !== 16) throw new Error("AAGUID must be 16 bytes");
    this.transports = options.transports ?? ["internal"];
  }

  private flags(tamper: Tamper, attested: boolean): number {
    let flags = 0;
    if (!tamper.userAbsent) flags |= FLAG_UP;
    if (!tamper.userUnverified) flags |= FLAG_UV;
    if (tamper.backedUpWithoutEligibility) flags |= FLAG_BS;
    else if (tamper.backupEligible ?? this.backupEligible) flags |= FLAG_BE | FLAG_BS;
    if (attested) flags |= FLAG_AT;
    return flags;
  }

  private clientData(type: string, challenge: string, tamper: Tamper): Uint8Array {
    return new TextEncoder().encode(
      JSON.stringify({
        type: tamper.type ?? type,
        challenge: tamper.challenge ?? challenge,
        origin: tamper.origin ?? this.origin,
        crossOrigin: tamper.crossOrigin ?? false,
        ...(tamper.topOrigin === undefined ? {} : { topOrigin: tamper.topOrigin }),
      }),
    );
  }

  async create(
    options: PublicKeyCredentialCreationOptionsJSON,
    tamper: Tamper = {},
  ): Promise<RegistrationResponseJSON> {
    const alg = COSE_ALG[this.algorithm];
    if (!options.pubKeyCredParams.some((p) => p.alg === alg)) {
      throw new Error(`relying party does not offer ${this.algorithm}`);
    }
    const rpId = options.rp.id;
    if (!rpId) throw new Error("options carry no RP ID");

    let privateKey: CryptoKey;
    let coseKey: Map<number, number | Uint8Array>;
    if (this.algorithm === "ES256") {
      const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
      ])) as CryptoKeyPair;
      privateKey = pair.privateKey;
      const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
      coseKey = new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, raw.slice(1, 33)],
        [-3, raw.slice(33, 65)],
      ]);
    } else {
      const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
        "sign",
        "verify",
      ])) as CryptoKeyPair;
      privateKey = pair.privateKey;
      const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
      coseKey = new Map<number, number | Uint8Array>([
        [1, 1],
        [3, -8],
        [-1, 6],
        [-2, raw],
      ]);
    }

    const credentialId =
      tamper.credentialId === undefined
        ? randomBytes(tamper.credentialIdLength ?? 32)
        : fromBase64Url(tamper.credentialId);
    const signCount = tamper.signCount ?? 0;
    const authData = concatBytes(
      await sha256(tamper.rpId ?? rpId),
      new Uint8Array([this.flags(tamper, true)]),
      uint32(signCount),
      this.aaguid,
      new Uint8Array([credentialId.length >> 8, credentialId.length & 0xff]),
      credentialId,
      encodeCbor(coseKey),
    );
    const attestationObject = encodeCbor({ fmt: "none", attStmt: {}, authData });
    const clientDataJSON = this.clientData("webauthn.create", options.challenge, tamper);

    const id = toBase64Url(credentialId);
    this.credentials.push({
      id,
      rpId,
      userHandle: options.user.id,
      userName: options.user.name,
      algorithm: this.algorithm,
      privateKey,
      signCount,
    });

    return {
      id,
      rawId: id,
      type: "public-key",
      response: {
        clientDataJSON: toBase64Url(clientDataJSON),
        attestationObject: toBase64Url(attestationObject),
        transports: [...this.transports],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /**
   * Answer an assertion request. With an empty allow-list the authenticator
   * chooses a discoverable credential for the RP: `credentialId` if given,
   * otherwise the most recently created one.
   */
  async get(
    options: PublicKeyCredentialRequestOptionsJSON,
    tamper: Tamper = {},
    credentialId?: string,
  ): Promise<AuthenticationResponseJSON> {
    const rpId = options.rpId;
    if (!rpId) throw new Error("options carry no RP ID");
    const allowed = options.allowCredentials?.map((c) => c.id) ?? [];
    const candidates = this.credentials.filter(
      (c) => c.rpId === rpId && (allowed.length === 0 || allowed.includes(c.id)),
    );
    const credential = credentialId
      ? candidates.find((c) => c.id === credentialId)
      : candidates[candidates.length - 1];
    if (!credential) throw new Error("NotAllowedError: no credential for this RP");

    if (tamper.signCount !== undefined) credential.signCount = tamper.signCount;
    else if (!this.backupEligible) credential.signCount += 1;

    const authData = concatBytes(
      await sha256(tamper.rpId ?? rpId),
      new Uint8Array([this.flags(tamper, false)]),
      uint32(credential.signCount),
    );
    const clientDataJSON = this.clientData("webauthn.get", options.challenge, tamper);
    const signed = concatBytes(authData, await sha256(clientDataJSON));
    let signature =
      credential.algorithm === "ES256"
        ? derFromRawEcdsa(
            new Uint8Array(
              await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, credential.privateKey, signed),
            ),
          )
        : new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, credential.privateKey, signed));
    if (tamper.badSignature) {
      signature = signature.slice();
      signature[signature.length - 1]! ^= 0x01;
    }

    return {
      id: credential.id,
      rawId: credential.id,
      type: "public-key",
      response: {
        clientDataJSON: toBase64Url(clientDataJSON),
        authenticatorData: toBase64Url(authData),
        signature: toBase64Url(signature),
        userHandle: credential.userHandle,
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** Forget a credential, as when a device is lost. */
  lose(credentialId: string): void {
    const i = this.credentials.findIndex((c) => c.id === credentialId);
    if (i >= 0) this.credentials.splice(i, 1);
  }
}

