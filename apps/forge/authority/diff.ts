// A line diff of two small text files, for people to read: what a proposal
// or a commit changes. The verifier does not use it.

export interface DiffLine {
  kind: "+" | "-" | " ";
  text: string;
}

export interface FileDiff {
  path: string;
  change: "added" | "modified" | "deleted";
  /** The changed lines with up to `context` lines around them. Null when a file is too large or is not text. */
  lines: DiffLine[] | null;
}

const MAX_LINES = 400;

/** The lines of `after` against `before`, from a longest common subsequence. */
export function diffLines(before: string, after: string, context = 2): DiffLine[] | null {
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const b = after === "" ? [] : after.replace(/\n$/, "").split("\n");
  if (a.length > MAX_LINES || b.length > MAX_LINES) return null;
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const all: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      all.push({ kind: " ", text: a[i]! });
      i++;
      j++;
    } else if (i < a.length && (j === b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      // A removed line comes before the added line that replaces it, as in a unified diff.
      all.push({ kind: "-", text: a[i++]! });
    } else {
      all.push({ kind: "+", text: b[j++]! });
    }
  }
  // Keep the changed lines and their context. A gap between two hunks is one "…" line.
  const keep = all.map((line, n) => all.slice(Math.max(0, n - context), n + context + 1).some((l) => l.kind !== " "));
  const out: DiffLine[] = [];
  for (const [n, line] of all.entries()) {
    if (keep[n]) out.push(line);
    else if (keep[n - 1]) out.push({ kind: " ", text: "…" });
  }
  return out;
}
