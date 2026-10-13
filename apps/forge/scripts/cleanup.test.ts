import { describe, expect, it } from "vitest";
import { deleteCommands, repoNames } from "./cleanup-artifacts.ts";

describe("the Artifacts cleanup", () => {
  it("reads either listing shape, and deletes only the names with the prefix", () => {
    const names = repoNames(JSON.stringify({ repos: [{ name: "notes-1a2b3c4d" }, { name: "notes-1a2b3c4d-ada" }, { name: "other" }], total: 3 }));
    expect(names).toEqual(["notes-1a2b3c4d", "notes-1a2b3c4d-ada", "other"]);
    expect(repoNames(JSON.stringify([{ name: "x" }]))).toEqual(["x"]);
    expect(deleteCommands(names, "forge-demo", "notes-")).toEqual([
      ["artifacts", "repos", "delete", "notes-1a2b3c4d", "--namespace", "forge-demo", "--force"],
      ["artifacts", "repos", "delete", "notes-1a2b3c4d-ada", "--namespace", "forge-demo", "--force"],
    ]);
  });
});
