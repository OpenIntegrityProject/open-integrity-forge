// The local configuration must bind the same Durable Objects, with the same
// migrations, as the deployed configuration. If not, local runs prove nothing
// about the deployed forge.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Parse JSONC: remove the comments outside strings, and each comma before a `]` or a `}`. */
export function readJsonc(path: string): any {
  const text: string = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", path), "utf8");
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

describe("the Worker configurations", () => {
  const deployed = readJsonc("wrangler.jsonc");
  const local = readJsonc("wrangler.local.jsonc");

  it("bind the same Durable Objects with the same migrations", () => {
    expect(local.durable_objects).toEqual(deployed.durable_objects);
    expect(local.migrations).toEqual(deployed.migrations);
    expect(local.compatibility_date).toBe(deployed.compatibility_date);
    expect(local.compatibility_flags).toEqual(deployed.compatibility_flags);
    expect(local.assets).toEqual(deployed.assets);
    expect(local.queues).toEqual(deployed.queues);
  });

  it("differ only where local runs need it", () => {
    expect(deployed.vars.REPO_HOST).toBe("artifacts");
    expect(deployed.artifacts).toEqual([{ binding: "ARTIFACTS", namespace: "forge-demo" }]);
    expect(local.vars.REPO_HOST).toBe("local");
    expect(local.artifacts).toBeUndefined();
    expect(Object.keys(local.vars).sort()).toEqual(Object.keys(deployed.vars).sort());
  });
});
