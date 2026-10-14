// Git helpers over isomorphic-git, for an in-memory repository or a clone on
// disk. This module parses commits from their raw objects, because
// isomorphic-git finds the signed payload only for PGP signatures. It does not
// find it for SSH signatures.

import git, { Errors, type HttpClient, type PromiseFsClient, type ReadTreeResult } from "isomorphic-git";
import { fromUtf8, utf8 } from "./bytes.ts";
import { MemoryFS } from "./memfs.ts";

export type Fs = PromiseFsClient;

/** A repository for the helpers. */
export interface Repo {
  fs: Fs;
  dir: string;
  gitdir: string;
  cache: object;
}

/** A person or agent as a commit names them. */
export interface Identity {
  name: string;
  email: string;
  /** Seconds since the epoch. */
  timestamp: number;
  /** Minutes, with the sign of `Date.getTimezoneOffset`, as isomorphic-git uses them. */
  timezoneOffset: number;
}

export interface Commit {
  oid: string;
  tree: string;
  parents: string[];
  author: Identity;
  committer: Identity;
  message: string;
  /** The armored signature from the gpgsig header, or null. */
  signature: string | null;
  /** The text that the signature covers: the commit without its gpgsig header. */
  payload: string;
}

/** A new empty repository in memory, with main as its default branch. */
export async function memoryRepo(): Promise<Repo & { fs: MemoryFS }> {
  const fs = new MemoryFS();
  const repo = { fs, dir: "/work", gitdir: "/work/.git", cache: {} };
  await git.init({ fs, dir: repo.dir, gitdir: repo.gitdir, defaultBranch: "main" });
  return repo;
}

/** A repository on disk, given a Node fs module and the path of its work tree. */
export function diskRepo(fs: Fs, dir: string, gitdir = `${dir}/.git`): Repo {
  return { fs, dir, gitdir, cache: {} };
}

function parseIdentity(text: string): Identity {
  const match = /^(.*) <([^>]*)> (\d+) ([+-])(\d\d)(\d\d)$/.exec(text);
  if (!match) throw new Error(`bad identity line: ${text}`);
  const minutes = Number(match[5]) * 60 + Number(match[6]);
  return {
    name: match[1]!,
    email: match[2]!,
    timestamp: Number(match[3]),
    // isomorphic-git uses the sign of Date.getTimezoneOffset, which is the opposite of the sign git writes.
    timezoneOffset: match[4] === "-" ? minutes : -minutes,
  };
}

/** Parse a raw commit object. */
export function parseCommit(oid: string, raw: string): Commit {
  const split = raw.indexOf("\n\n");
  const head = split < 0 ? raw : raw.slice(0, split);
  const message = split < 0 ? "" : raw.slice(split + 2);
  const kept: string[] = [];
  const signature: string[] = [];
  let inSignature = false;
  let tree = "";
  const parents: string[] = [];
  let author: Identity | undefined;
  let committer: Identity | undefined;
  for (const line of head.split("\n")) {
    if (inSignature && line.startsWith(" ")) {
      signature.push(line.slice(1));
      continue;
    }
    inSignature = false;
    if (line.startsWith("gpgsig ")) {
      inSignature = true;
      signature.push(line.slice("gpgsig ".length));
      continue;
    }
    kept.push(line);
    if (line.startsWith("tree ")) tree = line.slice(5);
    else if (line.startsWith("parent ")) parents.push(line.slice(7));
    else if (line.startsWith("author ")) author = parseIdentity(line.slice(7));
    else if (line.startsWith("committer ")) committer = parseIdentity(line.slice(10));
  }
  if (!tree || !author || !committer) throw new Error(`commit ${oid} is not complete`);
  return {
    oid,
    tree,
    parents,
    author,
    committer,
    message,
    signature: signature.length > 0 ? signature.join("\n") + "\n" : null,
    payload: kept.join("\n") + "\n\n" + message,
  };
}

/** Read and parse a commit. */
export async function readCommit(repo: Repo, oid: string): Promise<Commit> {
  const { object, type } = await git.readObject({ ...repo, oid, format: "content" });
  if (type !== "commit") throw new Error(`${oid} is a ${type}, not a commit`);
  return parseCommit(oid, fromUtf8(object as Uint8Array));
}

/** The first line of a commit message. */
export function subjectOf(commit: Commit): string {
  return commit.message.split("\n", 1)[0] ?? "";
}

/** The text of the file at `path` in a commit or tree, or null if there is no such file. */
export async function readText(repo: Repo, oid: string, path: string): Promise<string | null> {
  try {
    const { blob } = await git.readBlob({ ...repo, oid, filepath: path });
    return fromUtf8(blob);
  } catch (error) {
    if (error instanceof Errors.NotFoundError) return null;
    throw error;
  }
}

/** The text of a blob, or null when it is not UTF-8. */
export async function readBlobText(repo: Repo, oid: string): Promise<string | null> {
  const { object } = await git.readObject({ ...repo, oid, format: "content" });
  try {
    return fromUtf8(object as Uint8Array);
  } catch {
    return null;
  }
}

/** The object id of the tree at `path` in a commit or tree, or null if there is none. */
export async function subtree(repo: Repo, oid: string, path: string): Promise<string | null> {
  try {
    return (await git.readTree({ ...repo, oid, filepath: path })).oid;
  } catch (error) {
    if (error instanceof Errors.NotFoundError) return null;
    throw error;
  }
}

/** The entries at the top of a tree, by name, with their object ids. */
export async function topEntries(repo: Repo, tree: string): Promise<Map<string, string>> {
  return new Map((await git.readTree({ ...repo, oid: tree })).tree.map((e) => [e.path, e.oid]));
}

/** Every file in a tree, by path, with its blob id. */
export async function listFiles(repo: Repo, tree: string, prefix = ""): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const { tree: entries }: ReadTreeResult = await git.readTree({ ...repo, oid: tree });
  for (const entry of entries) {
    const path = prefix + entry.path;
    if (entry.type === "tree") for (const [p, oid] of await listFiles(repo, entry.oid, path + "/")) out.set(p, oid);
    else out.set(path, entry.oid);
  }
  return out;
}

export interface Change {
  path: string;
  change: "added" | "modified" | "deleted";
}

/** The files that differ between two trees. */
export async function diffTrees(repo: Repo, from: string | null, to: string): Promise<Change[]> {
  const before = from ? await listFiles(repo, from) : new Map<string, string>();
  const after = await listFiles(repo, to);
  const changes: Change[] = [];
  for (const [path, oid] of after) {
    if (!before.has(path)) changes.push({ path, change: "added" });
    else if (before.get(path) !== oid) changes.push({ path, change: "modified" });
  }
  for (const path of before.keys()) if (!after.has(path)) changes.push({ path, change: "deleted" });
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

type FileTree = { [name: string]: FileTree | string };

/** Write a tree from blob ids by path, and return its id. */
async function writeTreeFrom(repo: Repo, blobs: Map<string, string>): Promise<string> {
  const root: FileTree = {};
  for (const [path, oid] of blobs) {
    const parts = path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const next = node[part];
      if (typeof next === "string") throw new Error(`${path} is under a file`);
      node = (node[part] = next ?? {}) as FileTree;
    }
    node[parts.at(-1)!] = oid;
  }
  const write = async (node: FileTree): Promise<string> => {
    const tree = [];
    for (const [path, value] of Object.entries(node)) {
      if (typeof value === "string") tree.push({ mode: "100644", path, oid: value, type: "blob" as const });
      else tree.push({ mode: "040000", path, oid: await write(value), type: "tree" as const });
    }
    return git.writeTree({ ...repo, tree });
  };
  return write(root);
}

/** Write files as a new tree. Returns the tree id. */
export async function writeFiles(repo: Repo, files: Record<string, string>): Promise<string> {
  const blobs = new Map<string, string>();
  for (const [path, text] of Object.entries(files)) blobs.set(path, await git.writeBlob({ ...repo, blob: utf8(text) }));
  return writeTreeFrom(repo, blobs);
}

/** Write a copy of the tree `base` with the files in `changes`. A null value removes the file. Returns the tree id. */
export async function changeFiles(repo: Repo, base: string, changes: Record<string, string | null>): Promise<string> {
  const blobs = await listFiles(repo, base);
  for (const [path, text] of Object.entries(changes)) {
    if (text === null) blobs.delete(path);
    else blobs.set(path, await git.writeBlob({ ...repo, blob: utf8(text) }));
  }
  return writeTreeFrom(repo, blobs);
}

/** Makes an armored signature over a commit payload. */
type CommitSigner = (payload: string) => Promise<string>;

/** Write a commit with a given tree and parents. If the options have a `ref`, move that ref to the commit. Returns its id. */
export async function commitTree(
  repo: Repo,
  options: { tree: string; parents: string[]; message: string; author: Identity; committer?: Identity; sign?: CommitSigner; ref?: string },
): Promise<string> {
  const { sign } = options;
  return git.commit({
    ...repo,
    tree: options.tree,
    parent: options.parents,
    message: options.message,
    author: options.author,
    committer: options.committer ?? options.author,
    ...(options.ref ? { ref: options.ref } : { noUpdateBranch: true }),
    ...(sign ? { signingKey: "ssh", onSign: async ({ payload }: { payload: string }) => ({ signature: await sign(payload) }) } : {}),
  });
}

export async function resolve(repo: Repo, ref: string): Promise<string | null> {
  try {
    return await git.resolveRef({ ...repo, ref });
  } catch (error) {
    if (error instanceof Errors.NotFoundError) return null;
    throw error;
  }
}

export async function setRef(repo: Repo, ref: string, oid: string): Promise<void> {
  await git.writeRef({ ...repo, ref, value: oid, force: true });
}

type MergeOutcome = { ok: true; tree: string } | { ok: false; conflicts: string[] };

/**
 * The tree of a merge of `theirs` into `ours`, both commit ids. Writes the
 * merged objects and keeps no ref. The same inputs give the same tree.
 */
export async function mergeTree(repo: Repo, ours: string, theirs: string): Promise<MergeOutcome> {
  await setRef(repo, "refs/heads/forge-merge-ours", ours);
  await setRef(repo, "refs/heads/forge-merge-theirs", theirs);
  const who = { name: "forge", email: "forge@invalid", timestamp: 0, timezoneOffset: 0 };
  try {
    const result = await git.merge({
      ...repo,
      ours: "forge-merge-ours",
      theirs: "forge-merge-theirs",
      fastForward: false,
      noUpdateBranch: true,
      author: who,
      committer: who,
      message: "merge",
    });
    if (result.alreadyMerged) return { ok: true, tree: (await readCommit(repo, ours)).tree };
    if (!result.tree) throw new Error("the merge gave no tree");
    return { ok: true, tree: result.tree };
  } catch (error) {
    if (error instanceof Errors.MergeConflictError) return { ok: false, conflicts: error.data.filepaths };
    if (error instanceof Errors.MergeNotSupportedError) return { ok: false, conflicts: ["(a change git cannot merge)"] };
    throw error;
  } finally {
    await git.deleteRef({ ...repo, ref: "refs/heads/forge-merge-ours" });
    await git.deleteRef({ ...repo, ref: "refs/heads/forge-merge-theirs" });
  }
}

/** Every commit that `head` reaches, `head` included. The walk stops at each commit in `stop` and does not include it. */
export async function reachable(repo: Repo, head: string, stop: ReadonlySet<string> = new Set()): Promise<Commit[]> {
  const seen = new Set<string>();
  const out: Commit[] = [];
  const queue = [head];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid) || stop.has(oid)) continue;
    seen.add(oid);
    const commit = await readCommit(repo, oid);
    out.push(commit);
    queue.push(...commit.parents);
  }
  return out;
}

interface Tag {
  oid: string;
  name: string;
  /** The commit the tag names. */
  target: string;
  message: string;
}

/** Read and parse an annotated tag object. */
async function readTagObject(repo: Repo, oid: string): Promise<Tag> {
  const { object, type } = await git.readObject({ ...repo, oid, format: "content" });
  if (type !== "tag") throw new Error(`${oid} is a ${type}, not a tag`);
  const raw = fromUtf8(object as Uint8Array);
  const split = raw.indexOf("\n\n");
  const head = raw.slice(0, split < 0 ? raw.length : split);
  const field = (name: string) => head.split("\n").find((l) => l.startsWith(`${name} `))?.slice(name.length + 1) ?? "";
  return { oid, name: field("tag"), target: field("object"), message: split < 0 ? "" : raw.slice(split + 2) };
}

/** Every annotated tag of the repository, by name. The list does not include lightweight tags, because they carry no approval. */
export async function annotatedTags(repo: Repo): Promise<Tag[]> {
  const out: Tag[] = [];
  for (const name of await git.listTags(repo)) {
    const oid = await resolve(repo, `refs/tags/${name}`);
    if (!oid) continue;
    const { type } = await git.readObject({ ...repo, oid, format: "content" });
    if (type === "tag") out.push(await readTagObject(repo, oid));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Write an annotated tag object for `target`, and set refs/tags/<name> to it. Returns the tag object id. */
export async function writeTag(repo: Repo, input: { name: string; target: string; message: string; tagger: Identity }): Promise<string> {
  await git.annotatedTag({ ...repo, ref: input.name, object: input.target, message: input.message, tagger: input.tagger });
  return (await resolve(repo, `refs/tags/${input.name}`))!;
}

/** Every object that `head` reaches: its commits, their trees and their blobs. `head` can also be a tag object. */
export async function reachableObjects(repo: Repo, head: string): Promise<Set<string>> {
  const out = new Set<string>();
  // For a tag object, include the tag and every object that its commit reaches.
  const { type } = await git.readObject({ ...repo, oid: head, format: "content" });
  if (type === "tag") {
    out.add(head);
    for (const oid of await reachableObjects(repo, (await readTagObject(repo, head)).target)) out.add(oid);
    return out;
  }
  const addTree = async (oid: string): Promise<void> => {
    if (out.has(oid)) return;
    out.add(oid);
    for (const entry of (await git.readTree({ ...repo, oid })).tree) {
      if (entry.type === "tree") await addTree(entry.oid);
      else out.add(entry.oid);
    }
  };
  for (const commit of await reachable(repo, head)) {
    out.add(commit.oid);
    await addTree(commit.tree);
  }
  return out;
}

/** The first-parent chain from `head` to the root, newest first. */
export async function firstParentChain(repo: Repo, head: string): Promise<Commit[]> {
  const out: Commit[] = [];
  let oid: string | undefined = head;
  while (oid) {
    const commit = await readCommit(repo, oid);
    out.push(commit);
    oid = commit.parents[0];
  }
  return out;
}

// --- Git over HTTPS -------------------------------------------------------------

/** A smart HTTP remote. The client sends the token as the password of HTTP Basic authentication. */
interface HttpRemote {
  http: HttpClient;
  url: string;
  /** The token. The client removes a `?expires=` suffix, as Artifacts adds it, before use. */
  token?: string;
}

function onAuth(remote: HttpRemote) {
  return remote.token ? () => ({ username: "x", password: remote.token!.split("?expires=")[0]! }) : undefined;
}

/** Clone every branch of a remote into an empty repository, with no work tree. */
export async function cloneHttp(repo: Repo, remote: HttpRemote, ref = "main"): Promise<void> {
  await git.clone({ ...repo, http: remote.http, url: remote.url, ref, noCheckout: true, onAuth: onAuth(remote) });
}

/** Fetch one branch of a remote, and set the ref `into` to it. Returns its commit id. */
export async function fetchHttp(repo: Repo, remote: HttpRemote, branch: string, into: string): Promise<string> {
  const result = await git.fetch({
    ...repo,
    http: remote.http,
    url: remote.url,
    ref: branch,
    singleBranch: true,
    tags: false,
    onAuth: onAuth(remote),
  });
  if (!result.fetchHead) throw new Error(`the remote has no branch ${branch}`);
  await setRef(repo, into, result.fetchHead);
  return result.fetchHead;
}

/**
 * Push a local ref to a branch of a remote. The remote refuses a push that is
 * not a fast-forward, unless `force` is true, as for a mirror.
 */
export async function pushHttp(repo: Repo, remote: HttpRemote, localRef: string, remoteRef: string, force = false): Promise<void> {
  const result = await git.push({
    ...repo,
    http: remote.http,
    url: remote.url,
    ref: localRef,
    remoteRef,
    force,
    onAuth: onAuth(remote),
  });
  if (!result.ok) throw new Error(`push refused: ${result.error ?? JSON.stringify(result.refs)}`);
}
