/**
 * The storage prefixes and RP IDs this isolate has seen match the RP ID their
 * credential index stores, each keyed by `relyingPartyMatch`. A stored RP ID
 * never changes while it has credentials under it, so once a deployment's
 * matches, its ceremonies skip reading it again. A mismatch is never kept, so
 * a refused ceremony reads it every time. It lives apart from the index so
 * that `passkey-cloudflare/testing` can export it, for a test to clear.
 */
export const relyingPartyMatches = new Set<string>();

/** The key `relyingPartyMatches` holds for an RP ID under a storage prefix. */
export function relyingPartyMatch(storagePrefix: string | undefined, rpId: string): string {
  return `${storagePrefix ?? ""}\n${rpId}`;
}
