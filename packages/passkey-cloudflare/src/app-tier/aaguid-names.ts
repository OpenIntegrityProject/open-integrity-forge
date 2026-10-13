import table from "./aaguid-names.json";

// A curated table of AAGUIDs to the password manager or platform that holds the
// passkey, bundled at build time from the community-maintained list named in
// aaguid-names.json. An all-zero AAGUID, which many authenticators send, has no
// name.

const NAMES: Record<string, string> = table.names;

export function providerName(aaguid: string): string | null {
  return NAMES[aaguid.toLowerCase()] ?? null;
}
