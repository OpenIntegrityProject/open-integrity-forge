// The Git over HTTPS path the Artifacts host uses, against a real git server:
// `git http-backend` behind a small Node server that requires a token, as
// Artifacts does. Clone, fetch and push go through isomorphic-git's HTTP client.

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "isomorphic-git/http/web";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cloneHttp, fetchHttp, memoryRepo, pushHttp, readCommit, setRef } from "../git.ts";
import { verifyHistory, verifyProposal } from "../verify.ts";
import { verifyWebauthn } from "../webauthn-sshsig.ts";
import { startGitServer, type GitServer } from "./git-server.ts";
import { history } from "./history.ts";

const TOKEN = "art_v1_0123456789abcdef0123456789abcdef01234567";
let server: GitServer;
let base: string;
let root: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-http-"));
  for (const name of ["project", "fork"]) {
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", join(root, `${name}.git`)]);
    execFileSync("git", ["config", "http.receivepack", "true"], { cwd: join(root, `${name}.git`) });
  }
  server = await startGitServer(root, TOKEN);
  base = server.url;
});

afterAll(() => server?.close());

describe("Git over HTTP with a token", () => {
  it("refuses a request without the token", async () => {
    const repo = await memoryRepo();
    await expect(cloneHttp(repo, { http, url: `${base}/project.git`, token: "wrong" })).rejects.toThrow();
  });

  it("pushes a signed history, clones it back, and keeps every signature", async () => {
    const h = await history();
    const work = await h.work(h.ada, h.admitted, { "CHANGELOG.md": "# Changelog\n\n- one\n" });
    await setRef(h.repo, "refs/heads/main", h.admitted);
    await setRef(h.repo, "refs/heads/ada", work);
    const project = { http, url: `${base}/project.git`, token: `${TOKEN}?expires=1760000000` };
    const fork = { http, url: `${base}/fork.git`, token: TOKEN };
    await pushHttp(h.repo, project, "refs/heads/main", "refs/heads/main");
    await pushHttp(h.repo, fork, "refs/heads/ada", "refs/heads/main");

    // A fresh workspace, as the Worker has for each request.
    const fresh = await memoryRepo();
    await cloneHttp(fresh, project);
    const head = await fetchHttp(fresh, fork, "main", "refs/forks/ada");
    expect(head).toBe(work);
    expect((await verifyProposal(fresh, h.admitted, head)).ok).toBe(true);

    const promoted = await h.promote(h.admitted, work);
    await setRef(h.repo, "refs/heads/main", promoted);
    await pushHttp(h.repo, project, "refs/heads/main", "refs/heads/main");
    const again = await memoryRepo();
    await cloneHttp(again, project);
    // The promotion is signed as a whole by the passkey, and the signature survives the round trip.
    const back = await readCommit(again, promoted);
    expect((await verifyWebauthn(back.signature!, back.payload)).ok).toBe(true);
    expect((await readCommit(again, work)).signature).toContain("BEGIN SSH SIGNATURE");
    const report = await verifyHistory(again, promoted);
    expect(report.ok, report.summary).toBe(true);
    execFileSync("git", ["fsck", "--strict"], { cwd: join(root, "project.git") });
  });

  it("refuses a push that is not a fast-forward", async () => {
    const h = await history();
    const project = { http, url: `${base}/fork.git`, token: TOKEN };
    await setRef(h.repo, "refs/heads/other", h.repoId);
    await expect(pushHttp(h.repo, project, "refs/heads/other", "refs/heads/main")).rejects.toThrow();
  });
});
