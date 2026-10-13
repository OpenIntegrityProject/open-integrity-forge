import { env, listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { PASSKEY_DURABLE_OBJECTS } from "passkey-cloudflare";
import { OperatorLog } from "../src/operator-log.ts";

// Reads every row of every table in every Durable Object of the given
// namespaces. Only the invariant tests use this: their promises are about what
// is at rest, so what is at rest is what they must look at.

/** Every Durable Object the demo runs: the library's, from its one list, and the demo's own. */
export const DEMO_DURABLE_OBJECTS = { ...PASSKEY_DURABLE_OBJECTS, OPERATOR_LOG: OperatorLog };

export type NamespaceName = keyof typeof DEMO_DURABLE_OBJECTS;

const ALL_NAMESPACES = Object.keys(DEMO_DURABLE_OBJECTS) as NamespaceName[];

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** One text line per row, with every blob rendered as UTF-8, hex and base64url. */
export async function dumpDurableState(namespaces: readonly NamespaceName[] = ALL_NAMESPACES): Promise<string> {
  const lines: string[] = [];
  for (const name of namespaces) {
    const namespace = env[name] as DurableObjectNamespace;
    for (const id of await listDurableObjectIds(namespace)) {
      const rows = await runInDurableObject(namespace.get(id), (_instance, state) => {
        const out: string[] = [];
        const tables = state.storage.sql
          .exec<{ name: string; sql: string }>(
            "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
          )
          .toArray();
        for (const table of tables) {
          out.push(`${name} schema ${table.sql}`);
          for (const row of state.storage.sql.exec(`SELECT * FROM "${table.name}"`)) {
            const cells = Object.entries(row).map(([column, value]) => {
              if (value instanceof ArrayBuffer) {
                const bytes = new Uint8Array(value);
                return `${column}=${new TextDecoder().decode(bytes)}|${hex(bytes)}|${base64url(bytes)}`;
              }
              return `${column}=${String(value)}`;
            });
            out.push(`${name} ${table.name} ${cells.join(" ")}`);
          }
        }
        return out;
      });
      lines.push(...rows);
    }
  }
  return lines.join("\n");
}
