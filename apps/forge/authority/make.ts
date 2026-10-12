// Helpers that make what the verifier checks: approval payloads, approved
// commits of main and signed commits of an author. The forge Worker and the
// tests use them. The verifier does not.

import { encodePayload, MAIN_REF, trailerLine, withTrailer, type Approval, type ApprovalAction, type ApprovalPayload } from "./approval.ts";
import { commitTree, writeTag, type Identity, type Repo } from "./git.ts";
import type { Author, Policy } from "./policy.ts";
import { sign } from "./sshsig.ts";

/** An approval payload for a change of main, or of another ref such as a release tag. */
export function approvalPayload(input: {
  repo: string | null;
  action: ApprovalAction;
  parents: string[];
  tree: string;
  summary: string;
  at: number;
  ref?: string;
}): { payload: ApprovalPayload; bytes: Uint8Array<ArrayBuffer> } {
  const payload: ApprovalPayload = { v: 1, ...input, ref: input.ref ?? MAIN_REF };
  return { payload, bytes: encodePayload(payload) };
}

/** Write a commit of main that carries an approval. It does not move a ref. */
export function commitApproved(
  repo: Repo,
  input: { payload: ApprovalPayload; approval: Approval; message: string; committer: Identity },
): Promise<string> {
  return commitTree(repo, {
    tree: input.payload.tree,
    parents: input.payload.parents,
    message: withTrailer(input.message, input.approval),
    author: input.committer,
  });
}

/** An author key: the private key, and its entry for the policy. */
export interface AuthorKey {
  privateKey: CryptoKey;
  publicKey: Uint8Array;
  entry: Author;
}

/** Write a commit signed with an author key. It does not move a ref. */
export function commitSigned(
  repo: Repo,
  input: { tree: string; parents: string[]; message: string; author: Identity; key: { privateKey: CryptoKey; publicKey: Uint8Array } },
): Promise<string> {
  return commitTree(repo, {
    tree: input.tree,
    parents: input.parents,
    message: input.message,
    author: input.author,
    sign: (payload) => sign(payload, input.key.privateKey, input.key.publicKey),
  });
}

/** A copy of the policy with these authors added, or replaced where the id is the same. */
export function withAuthors(policy: Policy, authors: Author[]): Policy {
  const ids = new Set(authors.map((a) => a.id));
  return { ...policy, authors: [...policy.authors.filter((a) => !ids.has(a.id)), ...authors] };
}

/** Write a release tag for `target` whose message carries each approval. Returns the tag object id. */
export function tagApproved(
  repo: Repo,
  input: { name: string; target: string; message: string; approvals: Approval[]; tagger: Identity },
): Promise<string> {
  const trailers = input.approvals.map(trailerLine).join("\n");
  return writeTag(repo, { name: input.name, target: input.target, message: `${input.message.trimEnd()}\n\n${trailers}\n`, tagger: input.tagger });
}
