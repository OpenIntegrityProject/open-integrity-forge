import { describe, expect, it } from "vitest";
import * as e2eEntry from "../src/e2e.ts";
import * as indexEntry from "../src/index.ts";
import * as measureEntry from "../src/measure.ts";
import wranglerConfig from "../wrangler.jsonc?raw";
import measureConfig from "../wrangler.measure.jsonc?raw";
import { DEMO_DURABLE_OBJECTS } from "./durable-state.ts";

interface WranglerConfig {
  main?: string;
  durable_objects?: { bindings?: { name: string; class_name: string }[] };
  migrations?: { new_sqlite_classes?: string[] }[];
}

/** JSON with comments and trailing commas, as wrangler reads it. */
function parseJsonc(text: string): WranglerConfig {
  const quotedString = /"(?:\\.|[^"\\])*"/.source;
  const withoutComments = text.replace(
    new RegExp(`(${quotedString})|//[^\\n]*|/\\*[\\s\\S]*?\\*/`, "g"),
    (_match, quoted) => quoted ?? "",
  );
  const withoutTrailingCommas = withoutComments.replace(
    new RegExp(`(${quotedString})|,(\\s*[}\\]])`, "g"),
    (_match, quoted, close) => quoted ?? close,
  );
  return JSON.parse(withoutTrailingCommas) as WranglerConfig;
}

describe.each([
  { file: "wrangler.jsonc", text: wranglerConfig, main: "src/index.ts", entry: indexEntry },
  { file: "wrangler.measure.jsonc", text: measureConfig, main: "src/measure.ts", entry: measureEntry },
])("$file", ({ file, text, main, entry }) => {
  const config = parseJsonc(text);
  const bindings = new Map((config.durable_objects?.bindings ?? []).map((b) => [b.name, b.class_name]));
  const sqliteClasses = new Set((config.migrations ?? []).flatMap((m) => m.new_sqlite_classes ?? []));

  it("binds every Durable Object to its class", () => {
    for (const [binding, cls] of Object.entries(DEMO_DURABLE_OBJECTS)) {
      expect(bindings.get(binding), `${file} binds ${binding} to ${cls.name}`).toBe(cls.name);
    }
    expect([...bindings.keys()].sort(), `${file} binds only the demo's Durable Objects`).toEqual(
      Object.keys(DEMO_DURABLE_OBJECTS).sort(),
    );
  });

  it("creates every Durable Object class with SQLite storage", () => {
    for (const cls of Object.values(DEMO_DURABLE_OBJECTS)) {
      expect(sqliteClasses.has(cls.name), `${file} migrations create ${cls.name}`).toBe(true);
    }
  });

  it("names an entry point that exports every Durable Object class", () => {
    expect(config.main).toBe(main);
    const exports: Record<string, unknown> = entry;
    for (const cls of Object.values(DEMO_DURABLE_OBJECTS)) {
      expect(exports[cls.name], `${file}'s entry point exports ${cls.name}`).toBe(cls);
    }
  });
});

describe("src/e2e.ts, which Playwright runs with wrangler.jsonc's bindings", () => {
  it("exports every Durable Object class", () => {
    const exports: Record<string, unknown> = e2eEntry;
    for (const cls of Object.values(DEMO_DURABLE_OBJECTS)) {
      expect(exports[cls.name], `src/e2e.ts exports ${cls.name}`).toBe(cls);
    }
  });
});
