import { env, runInDurableObject } from "cloudflare:test";
import { ceremonyFailures, identityRecords, type RecordId } from "passkey-cloudflare";
import type { Browser } from "./harness.ts";

/** Every failure recorded on one record, read from its own object in the storage of the app with this prefix. */
export function failuresOn(storagePrefix: string, recordId: string) {
  return runInDurableObject(
    identityRecords(env.IDENTITY_RECORDS, storagePrefix)(recordId as RecordId),
    (_instance, state) =>
      state.storage.sql.exec<{ ceremony: string; cause: string }>("SELECT ceremony, cause FROM failures").toArray(),
  );
}

async function sourceHash(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`source:${ip}`));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The failures recorded globally from one source address, in the storage of the app with this prefix. */
export async function globalFailuresFrom(storagePrefix: string, browser: Browser) {
  const hash = await sourceHash(browser.ip);
  return runInDurableObject(ceremonyFailures(env.CEREMONY_FAILURES, storagePrefix)(), (_instance, state) =>
    state.storage.sql
      .exec<{ ceremony: string; cause: string }>("SELECT ceremony, cause FROM failures WHERE source_hash = ?", hash)
      .toArray(),
  );
}
