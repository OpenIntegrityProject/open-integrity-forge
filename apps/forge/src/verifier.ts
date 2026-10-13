import { sha256, toHex } from "../authority/bytes.ts";

// The verifier as one file, public/forge-verify.mjs, which the build bundles
// from scripts/forge-verify.ts. The forge serves it, and a new repository's
// GitHub workflow pins its SHA-256 digest. The promoter approves that pin with
// the inception commit, so the repository itself says which verifier to trust.

export const VERIFIER_PATH = "/forge-verify.mjs";

export interface Verifier {
  url: string;
  sha256: string;
}

let known: Promise<Verifier | null> | undefined;

/** The URL and digest of the verifier this deployment serves, or null if the build left it out. */
export function verifier(env: Env): Promise<Verifier | null> {
  known ??= (async () => {
    const response = await env.ASSETS.fetch(new Request(env.ORIGIN + VERIFIER_PATH));
    if (!response.ok) return null;
    return { url: env.ORIGIN + VERIFIER_PATH, sha256: toHex(await sha256(new Uint8Array(await response.arrayBuffer()))) };
  })();
  return known;
}
