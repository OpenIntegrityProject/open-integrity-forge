// A promoter for tests: a software authenticator with one passkey, and its
// policy entry. The software authenticator is test-only code from the library.

import { SoftwareAuthenticator, type Algorithm, type Tamper } from "passkey-cloudflare/testing";
import { approvalFrom, approvalRequestOptions, type Approval } from "../approval.ts";
import { toBase64Url } from "../bytes.ts";
import type { WebAuthnPromoter } from "../policy.ts";
import { keyFromRegistration } from "../../src/promoter-key.ts";

export const RP_ID = "forge.example";
export const ORIGIN = "https://forge.example";

export interface TestPromoter {
  authenticator: SoftwareAuthenticator;
  entry: WebAuthnPromoter;
  approve(payload: Uint8Array, tamper?: Tamper): Promise<Approval>;
}

export async function testPromoter(id = "leo", algorithm: Algorithm = "ES256", origin = ORIGIN): Promise<TestPromoter> {
  const authenticator = new SoftwareAuthenticator({ origin, algorithm });
  const created = await authenticator.create({
    rp: { id: RP_ID, name: "Forge" },
    user: { id: toBase64Url(new Uint8Array(16)), name: id, displayName: id },
    challenge: toBase64Url(new Uint8Array(32)),
    pubKeyCredParams: [
      { type: "public-key", alg: -7 },
      { type: "public-key", alg: -8 },
    ],
  });
  const key = await keyFromRegistration(created, RP_ID);
  const entry: WebAuthnPromoter = {
    id,
    kind: "webauthn",
    credentialId: key.credentialId,
    alg: key.alg,
    publicKey: key.publicKey,
    label: "able-acid-also",
    since: "2026-10-12T10:00:00.000Z",
  };
  return {
    authenticator,
    entry,
    async approve(payload, tamper) {
      const options = await approvalRequestOptions(payload, entry, RP_ID);
      const response = await authenticator.get(options as any, tamper);
      return approvalFrom(payload, response as any);
    },
  };
}
