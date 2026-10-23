import { SECURITY_KEY } from "../security-key.ts";
import table from "./aaguid-names.json";

// A curated table of AAGUIDs to the password manager or platform that holds the
// passkey, bundled at build time from the community-maintained list named in
// aaguid-names.json. An all-zero AAGUID, which many authenticators send, has no
// name. Chrome sends one for a security key under attestation "none", so a
// passkey the table cannot name, whose transports are all roaming ones, is
// named as a security key.

const NAMES: Record<string, string> = table.names;
const ROAMING = new Set(["usb", "nfc", "ble", "smart-card"]);

export function providerName(aaguid: string, transports: string[]): string | null {
  const named = NAMES[aaguid.toLowerCase()];
  if (named) return named;
  return transports.length > 0 && transports.every((t) => ROAMING.has(t)) ? SECURITY_KEY : null;
}
