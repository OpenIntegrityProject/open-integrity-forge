// An approval as a Gordian Envelope (BCR-2024-003). The subject is the exact
// payload text. The envelope has 'isA': "ForgeApproval" and one assertion for
// each part of the WebAuthn assertion. Its digest commits to all of it. The
// elided form keeps the payload and the credential id. It replaces the
// WebAuthn parts with their digests, so its root digest is the same. You can
// share it as proof of the approval without the authenticator data. The
// repository still keeps the approval as a commit trailer. The envelope is a
// different view of the same facts.
//
// It uses the hand-written encoders of the library. Its tests compare the
// bytes with vectors from the reference bc-envelope-cli (ADR 0005).

import {
  assertion,
  encodeBytes,
  encodeBytewords,
  encodeText,
  envelopeCbor,
  KNOWN,
  knownValue,
  leaf,
  node,
  type Envelope,
} from "passkey-cloudflare/gordian";
import type { Approval } from "./approval.ts";
import { fromBase64Url, fromUtf8, toHex } from "./bytes.ts";

/** The parts of the WebAuthn assertion that the elided form replaces with their digests. */
const ELIDED = new Set(["authenticatorData", "clientDataJSON", "signature"]);

interface ApprovalEnvelope {
  /** `ur:envelope/…`: the untagged Envelope in minimal Bytewords. */
  ur: string;
  /** The tagged Envelope, hex. */
  cbor: string;
  /** The root digest, hex. It is the same for the full and the elided form. */
  digest: string;
}

async function build(approval: Approval, elide: boolean): Promise<Envelope> {
  const field = async (name: string, bytes: Uint8Array) => {
    const a = await assertion(await leaf(encodeText(name)), await leaf(encodeBytes(bytes)));
    // An elided element is its digest as a byte string. Its digest does not change.
    return elide && ELIDED.has(name) ? { untagged: encodeBytes(a.digest), digest: a.digest } : a;
  };
  const subject = await leaf(encodeText(fromUtf8(fromBase64Url(approval.payload))));
  return node(subject, [
    await assertion(await knownValue(KNOWN.isA), await leaf(encodeText("ForgeApproval"))),
    await field("credentialId", fromBase64Url(approval.credentialId)),
    await field("authenticatorData", fromBase64Url(approval.authenticatorData)),
    await field("clientDataJSON", fromBase64Url(approval.clientDataJSON)),
    await field("signature", fromBase64Url(approval.signature)),
  ]);
}

function view(envelope: Envelope): ApprovalEnvelope {
  return {
    ur: `ur:envelope/${encodeBytewords(envelope.untagged, "minimal")}`,
    cbor: toHex(envelopeCbor(envelope)),
    digest: toHex(envelope.digest),
  };
}

/** The approval as an Envelope, and its elided form with the same digest. */
export async function approvalEnvelopes(approval: Approval): Promise<{ full: ApprovalEnvelope; elided: ApprovalEnvelope }> {
  return { full: view(await build(approval, false)), elided: view(await build(approval, true)) };
}
