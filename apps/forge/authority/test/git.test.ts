import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { commitSigned } from "../make.ts";
import { allowedSigners } from "../policy.ts";
import { changeFiles, diskRepo, parseCommit, readCommit, setRef, writeFiles } from "../git.ts";
import { verifyHistory } from "../verify.ts";
import { history, testAuthor, who } from "./history.ts";

describe("git on disk", () => {
  it("accepts our trees, our commits and our SSH signatures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-git-"));
    const repo = diskRepo(fs, dir);
    await git.init({ fs, dir, defaultBranch: "main" });
    const ada = await testAuthor("ada", Date.parse("2026-01-01T00:00:00Z"), Date.parse("2030-01-01T00:00:00Z"));
    const tree = await writeFiles(repo, { "README.md": "# Notes\n", "docs/a/b.md": "deep\n", "docs/c.md": "c\n" });
    const first = await commitSigned(repo, { tree, parents: [], message: "First\n", author: who("ada", Date.now()), key: ada });
    const next = await changeFiles(repo, tree, { "docs/c.md": null, "z.md": "z\n" });
    const second = await commitSigned(repo, { tree: next, parents: [first], message: "Second\n", author: who("ada", Date.now()), key: ada });
    await setRef(repo, "refs/heads/main", second);
    writeFileSync(join(dir, "allowed"), allowedSigners({ version: 1, webauthn: { rpId: "x", origin: "x" }, promoters: [], authors: [ada.entry] }));

    execFileSync("git", ["fsck", "--strict"], { cwd: dir });
    const out = execFileSync(
      "git",
      ["-c", "gpg.format=ssh", "-c", `gpg.ssh.allowedSignersFile=${join(dir, "allowed")}`, "verify-commit", "-v", "HEAD"],
      { cwd: dir, stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(out).toBeDefined();
    expect(execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: dir }).toString().trim().split("\n")).toEqual([
      "README.md",
      "docs/a/b.md",
      "z.md",
    ]);
    // Our parser gives the same payload that git signs. `git cat-file` shows the raw object.
    const raw = execFileSync("git", ["cat-file", "commit", second], { cwd: dir }).toString();
    expect(parseCommit(second, raw).payload).toBe((await readCommit(repo, second)).payload);
    expect(raw).toContain("gpgsig -----BEGIN SSH SIGNATURE-----");
  });

  it("verifies a history that git itself cloned", async () => {
    const h = await history();
    const work = await h.work(h.ada, h.admitted, { "CHANGELOG.md": "# Changelog\n\n- one\n" });
    const promoted = await h.promote(h.admitted, work);
    await setRef(h.repo, "refs/heads/main", promoted);
    // Copy the memory repository to disk as loose objects, then let git clone it.
    const src = mkdtempSync(join(tmpdir(), "forge-src-"));
    for (const path of (h.repo.fs as any).filesUnder("/work/.git")) {
      const target = join(src, path.slice("/work/".length));
      fs.mkdirSync(join(target, ".."), { recursive: true });
      fs.writeFileSync(target, await (h.repo.fs as any).promises.readFile(path));
    }
    const clone = mkdtempSync(join(tmpdir(), "forge-clone-"));
    execFileSync("git", ["clone", "-q", src, clone]);
    const report = await verifyHistory(diskRepo(fs, clone), execFileSync("git", ["rev-parse", "HEAD"], { cwd: clone }).toString().trim());
    expect(report.ok, report.summary).toBe(true);
    expect(report.repoId).toBe(h.repoId);
  });
});
