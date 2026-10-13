// An approval as a Gordian Envelope (BCR-2024-003): the subject is the exact
// payload text, with 'isA': "ForgeApproval" and one assertion for each part of
// the WebAuthn assertion. Its digest commits to all of it. The elided form
// keeps the payload and the credential id and replaces the WebAuthn parts with
// their digests, so it has the same root digest and can be shared as proof of
// what was approved without the authenticator data. The repository still
// stores the approval as a commit trailer; this is a view of the same facts.
//
// It uses the library's hand-written encoders. Its tests compare the bytes
// with vectors made by the reference bc-envelope-cli (ADR 0005).

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

/** The parts of the WebAuthn assertion that the elided form leaves out. */
const ELIDED = new Set(["authenticatorData", "clientDataJSON", "signature"]);

export interface ApprovalEnvelope {
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
    // An elided element is its digest as a byte string; its digest stays the same.
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
