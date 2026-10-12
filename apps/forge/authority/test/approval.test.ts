import { describe, expect, it } from "vitest";
import { approvalIn, trailerLine, verifyApproval, withTrailer, type Approval } from "../approval.ts";
import { fromBase64Url, toBase64Url } from "../bytes.ts";
import { approvalPayload } from "../make.ts";
import type { Policy } from "../policy.ts";
import { ORIGIN, RP_ID, testPromoter } from "./promoter.ts";

const tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function policyFor(...promoters: Policy["promoters"]): Policy {
  return { version: 1, webauthn: { rpId: RP_ID, origin: ORIGIN }, promoters, authors: [] };
}

const payload = () => approvalPayload({ repo: "a".repeat(40), action: "policy", parents: ["b".repeat(40)], tree, summary: "Admit Ada", at: 1 });

describe("approvals", () => {
  for (const algorithm of ["ES256", "Ed25519"] as const) {
    it(`verify an ${algorithm} passkey assertion over the payload`, async () => {
      const leo = await testPromoter("leo", algorithm);
      const { bytes } = payload();
      const check = await verifyApproval(await leo.approve(bytes), policyFor(leo.entry));
      expect(check).toMatchObject({ ok: true, promoter: { id: "leo" }, payload: { summary: "Admit Ada" } });
    });
  }

  it("round-trip through a commit message trailer", async () => {
    const leo = await testPromoter();
    const approval = await leo.approve(payload().bytes);
    const message = withTrailer("Admit Ada\n\nBody.\n", approval);
    expect(message.trimEnd().endsWith(trailerLine(approval))).toBe(true);
    expect(approvalIn(message)).toEqual(approval);
    expect(approvalIn("No trailer\n")).toBeNull();
    expect(approvalIn("Forge-Approval: not-base64-json\n")).toBeNull();
  });

  const refusals: [string, (a: Approval) => Approval | Promise<Approval>, RegExp][] = [
    ["a flipped signature byte", (a) => {
      const sig = fromBase64Url(a.signature);
      sig[sig.length - 1] = sig[sig.length - 1]! ^ 1;
      return { ...a, signature: toBase64Url(sig) };
    }, /does not verify|does not decode/],
    ["another payload", (a) => ({ ...a, payload: toBase64Url(payload().bytes.map((b, i) => (i === 10 ? b ^ 1 : b))) }), /different payload|does not decode/],
  ];
  for (const [what, tamper, reason] of refusals) {
    it(`refuse ${what}`, async () => {
      const leo = await testPromoter();
      const check = await verifyApproval(await tamper(await leo.approve(payload().bytes)), policyFor(leo.entry));
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.reason).toMatch(reason);
    });
  }

  it("refuse an assertion without user verification", async () => {
    const leo = await testPromoter();
    const check = await verifyApproval(await leo.approve(payload().bytes, { userUnverified: true }), policyFor(leo.entry));
    expect(check).toMatchObject({ ok: false, reason: "The authenticator did not verify the person." });
  });

  it("refuse another origin and another relying party", async () => {
    const leo = await testPromoter();
    const origin = await verifyApproval(await leo.approve(payload().bytes, { origin: "https://evil.example" }), policyFor(leo.entry));
    expect(origin).toMatchObject({ ok: false, reason: expect.stringContaining("evil.example") });
    const rp = await verifyApproval(await leo.approve(payload().bytes, { rpId: "evil.example" }), policyFor(leo.entry));
    expect(rp).toMatchObject({ ok: false, reason: `The approval is not for ${RP_ID}.` });
  });

  it("refuse a passkey the policy does not list", async () => {
    const leo = await testPromoter();
    const mallory = await testPromoter("mallory");
    const check = await verifyApproval(await mallory.approve(payload().bytes), policyFor(leo.entry));
    expect(check).toMatchObject({ ok: false, reason: expect.stringContaining("does not list") });
  });

  it("refuse a listed credential id with another key behind it", async () => {
    const leo = await testPromoter();
    const mallory = await testPromoter("mallory");
    const approval = await mallory.approve(payload().bytes);
    const check = await verifyApproval({ ...approval, credentialId: leo.entry.credentialId }, policyFor(leo.entry));
    expect(check).toMatchObject({ ok: false, reason: "The approval signature does not verify." });
  });
});
