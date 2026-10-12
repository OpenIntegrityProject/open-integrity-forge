// A whole forge history built in memory, for the verifier tests: an inception
// commit, a policy commit that admits two authors, their signed work, and
// promotions. Each step can be bent to make one rule fail.

import { changeFiles, commitTree, memoryRepo, mergeTree, readCommit, setRef, writeFiles, type Identity, type Repo } from "../git.ts";
import { approvalPayload, commitApproved, commitSigned, withAuthors } from "../make.ts";
import { POLICY_PATH, renderPolicy, type Author, type Policy } from "../policy.ts";
import { fingerprint, generateKey, publicKeyText } from "../sshsig.ts";
import { ORIGIN, RP_ID, testPromoter, type TestPromoter } from "./promoter.ts";

export const T0 = Date.parse("2026-10-12T10:00:00Z");

export function who(name: string, ms: number): Identity {
  return { name, email: `${name.toLowerCase()}@forge.invalid`, timestamp: Math.floor(ms / 1000), timezoneOffset: 0 };
}

export interface TestAuthor {
  privateKey: CryptoKey;
  publicKey: Uint8Array;
  entry: Author;
}

export async function testAuthor(id: string, validAfter = T0, validBefore = T0 + 3600_000): Promise<TestAuthor> {
  const key = await generateKey();
  return {
    ...key,
    entry: {
      id,
      kind: "ssh-ed25519",
      publicKey: publicKeyText(key.publicKey),
      fingerprint: await fingerprint(key.publicKey),
      controller: "leo",
      validAfter: new Date(validAfter).toISOString(),
      validBefore: new Date(validBefore).toISOString(),
    },
  };
}

export const TEMPLATE = {
  "README.md": "# Gordian notes\n",
  "CHANGELOG.md": "# Changelog\n",
};

export interface History {
  repo: Repo;
  leo: TestPromoter;
  ada: TestAuthor;
  bo: TestAuthor;
  repoId: string;
  /** Main after the authors are admitted. */
  admitted: string;
  policy: Policy;
  /** Approve and write a change of main; returns the new commit id. */
  approve(input: { action: "policy" | "promote"; parents: string[]; tree: string; summary: string; by?: TestPromoter; repoId?: string }): Promise<string>;
  /** Write a commit signed by an author on top of `parent`. */
  work(by: TestAuthor, parent: string, changes: Record<string, string | null>, options?: { at?: number; unsigned?: boolean }): Promise<string>;
  /** Approve a promotion of `head` into `base`, with the merged tree. */
  promote(base: string, head: string, by?: TestPromoter): Promise<string>;
}

export async function history(): Promise<History> {
  const repo = await memoryRepo();
  const leo = await testPromoter("leo");
  const ada = await testAuthor("ada");
  const bo = await testAuthor("bo");
  const base: Policy = { version: 1, webauthn: { rpId: RP_ID, origin: ORIGIN }, promoters: [leo.entry], authors: [] };

  const rootTree = await writeFiles(repo, { ...TEMPLATE, [POLICY_PATH]: renderPolicy(base) });
  const incept = approvalPayload({ repo: null, action: "incept", parents: [], tree: rootTree, summary: "Create gordian-notes", at: T0 });
  const repoId = await commitApproved(repo, {
    payload: incept.payload,
    approval: await leo.approve(incept.bytes),
    message: "Establish gordian-notes and its signer policy\n",
    committer: who("Leo", T0),
  });

  const h: History = {
    repo,
    leo,
    ada,
    bo,
    repoId,
    admitted: "",
    policy: withAuthors(base, [ada.entry, bo.entry]),
    async approve({ action, parents, tree, summary, by = leo, repoId: id = repoId }) {
      const p = approvalPayload({ repo: id, action, parents, tree, summary, at: T0 });
      return commitApproved(repo, { payload: p.payload, approval: await by.approve(p.bytes), message: `${summary}\n`, committer: who("Leo", T0 + 60_000) });
    },
    async work(by, parent, changes, options = {}) {
      const tree = await changeFiles(repo, (await readCommit(repo, parent)).tree, changes);
      const at = options.at ?? T0 + 10 * 60_000;
      const author = who(by.entry.id, at);
      if (options.unsigned) {
        return commitTree(repo, { tree, parents: [parent], message: `Work by ${by.entry.id}\n`, author });
      }
      return commitSigned(repo, { tree, parents: [parent], message: `Work by ${by.entry.id}\n`, author, key: by });
    },
    async promote(baseOid, head, by = leo) {
      const merged = await mergeTree(repo, baseOid, head);
      if (!merged.ok) throw new Error("conflict");
      return h.approve({ action: "promote", parents: [baseOid, head], tree: merged.tree, summary: "Promote work", by });
    },
  };
  const admitTree = await changeFiles(repo, rootTree, { [POLICY_PATH]: renderPolicy(h.policy) });
  h.admitted = await h.approve({ action: "policy", parents: [repoId], tree: admitTree, summary: "Admit Ada and Bo" });
  await setRef(repo, "refs/heads/main", h.admitted);
  return h;
}
