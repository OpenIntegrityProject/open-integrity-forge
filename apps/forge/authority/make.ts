// Helpers that make what the verifier checks: approval payloads, inception
// commits, approved commits of main, signed commits of an author and release
// tags. The forge Worker and the tests use them. The verifier does not.

import { encodePayload, MAIN_REF, trailerLine, withFacts, withTrailer, type Approval, type ApprovalAction, type ApprovalPayload } from "./approval.ts";
import { commitTree, memoryRepo, writeFiles, writeTag, type Identity, type Repo } from "./git.ts";
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

/** A commit of main that a promoter's passkey signs as a whole: its payload, its message and who made it. */
export interface PasskeyCommitInput {
  payload: ApprovalPayload;
  message: string;
  committer: Identity;
}

/** Write a commit of main whose SSH signature, from `sign`, is its approval. It does not move a ref. */
export function commitPasskeySigned(repo: Repo, input: PasskeyCommitInput, sign: (payload: string) => Promise<string>): Promise<string> {
  return commitTree(repo, {
    tree: input.payload.tree,
    parents: input.payload.parents,
    message: withFacts(input.message, encodePayload(input.payload)),
    author: input.committer,
    sign,
  });
}

/** The exact text a passkey signs for such a commit: the commit without its signature. */
export async function passkeyCommitPayload(input: PasskeyCommitInput): Promise<string> {
  let payload = "";
  await commitPasskeySigned(await memoryRepo(), input, async (text) => {
    payload = text;
    return "-----BEGIN SSH SIGNATURE-----\n-----END SSH SIGNATURE-----\n";
  });
  return payload;
}

/** An empty inception commit: who made it, and its message. Its committer name is the fingerprint of the key that signs it. */
export interface InceptionInput {
  author: Identity;
  committer: Identity;
  message: string;
}

/** Write an empty inception commit that `sign` signs. It does not move a ref. */
export async function commitInception(repo: Repo, input: InceptionInput, sign: (payload: string) => Promise<string>): Promise<string> {
  const tree = await writeFiles(repo, {});
  return commitTree(repo, { tree, parents: [], message: input.message, author: input.author, committer: input.committer, sign });
}

/** The exact text the key signs for an inception commit: the commit without its signature. */
export async function inceptionPayload(input: InceptionInput): Promise<string> {
  let payload = "";
  await commitInception(await memoryRepo(), input, async (text) => {
    payload = text;
    return "-----BEGIN SSH SIGNATURE-----\n-----END SSH SIGNATURE-----\n";
  });
  return payload;
}

/** Write a commit that an author key signs. It does not move a ref. */
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

/** A copy of the policy with these authors added. A new author replaces an old author with the same id. */
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
