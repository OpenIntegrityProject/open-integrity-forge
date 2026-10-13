// Where the forge keeps repositories: Cloudflare Artifacts, or the LocalRepo
// Durable Object for local development and tests. The platform code sees only
// this interface. Both hosts give repo-scoped tokens with a scope and an
// expiry, so an agent gets a token for its own fork and for nothing else.

import http from "isomorphic-git/http/web";
import { cloneHttp, fetchHttp, pushHttp, reachableObjects, resolve, setRef, type Repo } from "../authority/git.ts";
import type { MemoryFS } from "../authority/memfs.ts";
import type { RepoDump } from "./local-repo.ts";

export interface RepoToken {
  secret: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

/** Git operations on one remote repository with one token. */
export interface Transport {
  /** Fill an empty in-memory repository with every branch of the remote. Main becomes refs/heads/main. */
  clone(repo: MemRepo): Promise<void>;
  /** Fetch one branch and keep it at `into`. Returns its commit id. */
  fetch(repo: MemRepo, branch: string, into: string): Promise<string>;
  /**
   * Push `localRef` to `remoteRef`. `expected` is the value the remote ref
   * holds now, or null for a new branch. The local host checks it; Artifacts
   * refuses any push that is not a fast-forward.
   */
  push(repo: MemRepo, localRef: string, remoteRef: string, expected: string | null): Promise<void>;
}

export type MemRepo = Repo & { fs: MemoryFS };

export interface RepoHost {
  readonly kind: "artifacts" | "local";
  create(name: string): Promise<void>;
  fork(source: string, name: string): Promise<void>;
  remove(name: string): Promise<void>;
  token(name: string, scope: "read" | "write", ttlSeconds: number): Promise<RepoToken>;
  /** Stop a token working before it expires. */
  revokeToken(name: string, secret: string): Promise<void>;
  /** The URL a Git client clones from. */
  remote(name: string): Promise<string>;
  transport(name: string, token: RepoToken): Promise<Transport>;
}

/** The repo host that `REPO_HOST` names. */
export function repoHost(env: Env): RepoHost {
  if (env.REPO_HOST === "local") return new LocalHost(env.LOCAL_REPOS, env.ORIGIN);
  if (!("ARTIFACTS" in env)) throw new Error("REPO_HOST is artifacts, but there is no ARTIFACTS binding");
  return new ArtifactsHost((env as Env & { ARTIFACTS: Artifacts }).ARTIFACTS);
}

// --- Cloudflare Artifacts ----------------------------------------------------------

const RETRY_CODES = new Set(["FORK_IN_PROGRESS", "CREATE_IN_PROGRESS", "IMPORT_IN_PROGRESS"]);

class ArtifactsHost implements RepoHost {
  readonly kind = "artifacts" as const;
  private readonly remotes = new Map<string, string>();

  constructor(private readonly artifacts: Artifacts) {}

  /** Run `fn` with a repo handle, and wait while a new repo or fork is not yet ready. */
  private async withRepo<T>(name: string, fn: (repo: ArtifactsRepo) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let repo: ArtifactsRepo;
      try {
        repo = await this.artifacts.get(name);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code && RETRY_CODES.has(code) && attempt < 40) {
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }
        throw error;
      }
      try {
        return await fn(repo);
      } finally {
        // The handle is an RPC stub: release it. Symbol.dispose is not in the ES2024 types.
        const dispose = (Symbol as { dispose?: symbol }).dispose;
        if (dispose) (repo as unknown as Record<symbol, (() => void) | undefined>)[dispose]?.();
      }
    }
  }

  async create(name: string): Promise<void> {
    const created = await this.artifacts.create(name, { setDefaultBranch: "main", description: "forge demo project" });
    this.remotes.set(name, created.remote);
  }

  async fork(source: string, name: string): Promise<void> {
    const forked = await this.withRepo(source, (repo) => repo.fork(name, { defaultBranchOnly: false }));
    this.remotes.set(name, forked.remote);
  }

  async remove(name: string): Promise<void> {
    await this.artifacts.delete(name);
  }

  async token(name: string, scope: "read" | "write", ttlSeconds: number): Promise<RepoToken> {
    // Artifacts accepts a TTL of 60 seconds at least.
    const token = await this.withRepo(name, (repo) => repo.createToken(scope, Math.max(60, ttlSeconds)));
    return { secret: token.plaintext, expiresAt: Date.parse(token.expiresAt) };
  }

  async revokeToken(name: string, secret: string): Promise<void> {
    await this.withRepo(name, (repo) => repo.revokeToken(secret));
  }

  async remote(name: string): Promise<string> {
    let remote = this.remotes.get(name);
    if (!remote) {
      remote = (await this.withRepo(name, (repo) => repo.info())).remote;
      this.remotes.set(name, remote);
    }
    return remote;
  }

  async transport(name: string, token: RepoToken): Promise<Transport> {
    const remote = { http, url: await this.remote(name), token: token.secret };
    return {
      clone: (repo) => cloneHttp(repo, remote),
      fetch: (repo, branch, into) => fetchHttp(repo, remote, branch, into),
      push: (repo, localRef, remoteRef) => pushHttp(repo, remote, localRef, remoteRef),
    };
  }
}

// --- LocalRepo Durable Objects -----------------------------------------------------

class LocalHost implements RepoHost {
  readonly kind = "local" as const;

  constructor(
    private readonly namespace: DurableObjectNamespace<import("./local-repo.ts").LocalRepo>,
    private readonly origin: string,
  ) {}

  private stub(name: string) {
    return this.namespace.get(this.namespace.idFromName(name));
  }

  async create(name: string): Promise<void> {
    if (!(await this.stub(name).create(name))) throw new Error(`the repository ${name} exists`);
  }

  async fork(source: string, name: string): Promise<void> {
    const dump = (await this.stub(source).dump()) as unknown as RepoDump;
    if (!(await this.stub(name).create(name, dump))) throw new Error(`the repository ${name} exists`);
  }

  async remove(name: string): Promise<void> {
    await this.stub(name).destroy();
  }

  async token(name: string, scope: "read" | "write", ttlSeconds: number): Promise<RepoToken> {
    return this.stub(name).mintToken(scope, ttlSeconds);
  }

  async revokeToken(name: string, secret: string): Promise<void> {
    await this.stub(name).revokeToken(secret);
  }

  async remote(name: string): Promise<string> {
    return `${this.origin}/forge/git/${name}.git`;
  }

  async transport(name: string, token: RepoToken): Promise<Transport> {
    const stub = this.stub(name);
    const download = async (repo: MemRepo) => {
      const dump = (await stub.download(token.secret)) as unknown as RepoDump | null;
      if (!dump) throw new Error(`the token does not allow a read of ${name}`);
      for (const [oid, data] of dump.objects) {
        await repo.fs.promises.writeFile(`${repo.gitdir}/objects/${oid.slice(0, 2)}/${oid.slice(2)}`, data);
      }
      return dump.refs;
    };
    return {
      async clone(repo) {
        const refs = await download(repo);
        for (const [ref, oid] of Object.entries(refs)) {
          if (ref.startsWith("refs/tags/")) await setRef(repo, ref, oid);
          if (!ref.startsWith("refs/heads/")) continue;
          await setRef(repo, `refs/remotes/origin/${ref.slice("refs/heads/".length)}`, oid);
          if (ref === "refs/heads/main") await setRef(repo, ref, oid);
        }
      },
      async fetch(repo, branch, into) {
        const refs = await download(repo);
        const oid = refs[`refs/heads/${branch}`];
        if (!oid) throw new Error(`${name} has no branch ${branch}`);
        await setRef(repo, into, oid);
        return oid;
      },
      async push(repo, localRef, remoteRef, expected) {
        const oid = await resolve(repo, localRef);
        if (!oid) throw new Error(`there is no ${localRef}`);
        // Send what the ref reaches, as a Git push does, and not every object the workspace holds.
        const wanted = await reachableObjects(repo, oid);
        const objects: [string, Uint8Array][] = [];
        const prefix = `${repo.gitdir}/objects/`;
        for (const path of repo.fs.filesUnder(`${repo.gitdir}/objects`)) {
          const rest = path.slice(prefix.length);
          if (!/^[0-9a-f]{2}\/[0-9a-f]{38}$/.test(rest)) continue;
          const objectId = rest.replace("/", "");
          if (wanted.has(objectId)) objects.push([objectId, (await repo.fs.promises.readFile(path)) as Uint8Array]);
        }
        const result = await stub.upload(token.secret, objects, [{ ref: remoteRef, old: expected, new: oid }]);
        if (!result.ok) throw new Error(`push refused: ${result.error}`);
      },
    };
  }
}
