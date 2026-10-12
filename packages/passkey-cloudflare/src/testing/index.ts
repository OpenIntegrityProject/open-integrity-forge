// Test-only tooling. Nothing exported here belongs in production code.
export { SoftwareAuthenticator } from "./authenticator.ts";
export type { Algorithm, AuthenticatorOptions, StoredCredential, Tamper } from "./authenticator.ts";
export { encodeCbor } from "./cbor.ts";
// The label-draw seam the library itself draws through, exported so a test can replace it.
export { labelDraws } from "../app-tier/label-draws.ts";
// The RP IDs this isolate has seen match their stored one, exported so a test can clear it.
export { relyingPartyMatches } from "../identity/relying-party-matches.ts";
