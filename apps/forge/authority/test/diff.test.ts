import { describe, expect, it } from "vitest";
import { diffLines } from "../diff.ts";

describe("line diffs", () => {
  it("show added and removed lines with their context", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n") + "\n";
    const after = ["a", "b", "c", "D", "e", "f", "g", "h", "i"].join("\n") + "\n";
    expect(diffLines(before, after, 1)).toEqual([
      { kind: " ", text: "c" },
      { kind: "-", text: "d" },
      { kind: "+", text: "D" },
      { kind: " ", text: "e" },
      { kind: " ", text: "…" },
      { kind: " ", text: "h" },
      { kind: "+", text: "i" },
    ]);
  });

  it("treat a new file as all added", () => {
    expect(diffLines("", "x\ny\n")).toEqual([
      { kind: "+", text: "x" },
      { kind: "+", text: "y" },
    ]);
  });
});
