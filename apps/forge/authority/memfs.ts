// An in-memory file system with the promise API that isomorphic-git uses.
// A Worker has no disk, so each Git operation works in one of these.

type Entry =
  | { kind: "file"; data: Uint8Array; mtimeMs: number }
  | { kind: "dir"; mtimeMs: number }
  | { kind: "symlink"; target: string; mtimeMs: number };

function fsError(code: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return "/" + parts.join("/");
}

function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

let inode = 1;

class Stats {
  readonly type: "file" | "dir" | "symlink";
  readonly mode: number;
  readonly size: number;
  readonly ino = inode++;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly uid = 1;
  readonly gid = 1;
  readonly dev = 1;

  constructor(entry: Entry) {
    this.type = entry.kind;
    this.mode = entry.kind === "dir" ? 0o40755 : entry.kind === "symlink" ? 0o120000 : 0o100644;
    this.size = entry.kind === "file" ? entry.data.length : 0;
    this.mtimeMs = entry.mtimeMs;
    this.ctimeMs = entry.mtimeMs;
  }

  isFile() {
    return this.type === "file";
  }

  isDirectory() {
    return this.type === "dir";
  }

  isSymbolicLink() {
    return this.type === "symlink";
  }
}

export class MemoryFS {
  private readonly entries = new Map<string, Entry>([["/", { kind: "dir", mtimeMs: 0 }]]);

  private entry(path: string): Entry {
    const entry = this.entries.get(normalize(path));
    if (!entry) throw fsError("ENOENT", path);
    return entry;
  }

  private ensureDir(path: string): void {
    const p = normalize(path);
    const entry = this.entries.get(p);
    if (entry?.kind === "dir") return;
    if (entry) throw fsError("ENOTDIR", path);
    this.ensureDir(parentOf(p));
    this.entries.set(p, { kind: "dir", mtimeMs: Date.now() });
  }

  /** Every file path under `dir`, for the local repo host. */
  filesUnder(dir: string): string[] {
    const prefix = normalize(dir) + "/";
    return [...this.entries].filter(([p, e]) => e.kind === "file" && p.startsWith(prefix)).map(([p]) => p);
  }

  readonly promises = {
    readFile: async (path: string, options?: string | { encoding?: string }) => {
      const entry = this.entry(path);
      if (entry.kind !== "file") throw fsError("EISDIR", path);
      const encoding = typeof options === "string" ? options : options?.encoding;
      return encoding ? new TextDecoder().decode(entry.data) : entry.data.slice();
    },
    writeFile: async (path: string, data: string | Uint8Array, _options?: unknown) => {
      const p = normalize(path);
      if (this.entries.get(p)?.kind === "dir") throw fsError("EISDIR", path);
      this.ensureDir(parentOf(p));
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
      this.entries.set(p, { kind: "file", data: bytes, mtimeMs: Date.now() });
    },
    unlink: async (path: string) => {
      const entry = this.entry(path);
      if (entry.kind === "dir") throw fsError("EISDIR", path);
      this.entries.delete(normalize(path));
    },
    readdir: async (path: string) => {
      const p = normalize(path);
      const entry = this.entry(p);
      if (entry.kind !== "dir") throw fsError("ENOTDIR", path);
      const prefix = p === "/" ? "/" : p + "/";
      const names: string[] = [];
      for (const key of this.entries.keys()) {
        if (key !== p && key.startsWith(prefix) && !key.slice(prefix.length).includes("/")) {
          names.push(key.slice(prefix.length));
        }
      }
      return names.sort();
    },
    mkdir: async (path: string, _options?: unknown) => {
      const p = normalize(path);
      if (this.entries.has(p)) throw fsError("EEXIST", path);
      const parent = this.entries.get(parentOf(p));
      if (!parent) throw fsError("ENOENT", path);
      if (parent.kind !== "dir") throw fsError("ENOTDIR", path);
      this.entries.set(p, { kind: "dir", mtimeMs: Date.now() });
    },
    rmdir: async (path: string) => {
      const p = normalize(path);
      const entry = this.entry(p);
      if (entry.kind !== "dir") throw fsError("ENOTDIR", path);
      if ((await this.promises.readdir(p)).length > 0) throw fsError("ENOTEMPTY", path);
      this.entries.delete(p);
    },
    stat: async (path: string) => new Stats(this.entry(path)),
    lstat: async (path: string) => new Stats(this.entry(path)),
    readlink: async (path: string) => {
      const entry = this.entry(path);
      if (entry.kind !== "symlink") throw fsError("EINVAL", path);
      return entry.target;
    },
    symlink: async (target: string, path: string) => {
      const p = normalize(path);
      if (this.entries.has(p)) throw fsError("EEXIST", path);
      this.ensureDir(parentOf(p));
      this.entries.set(p, { kind: "symlink", target, mtimeMs: Date.now() });
    },
    chmod: async (_path: string, _mode: number) => {},
  };
}
