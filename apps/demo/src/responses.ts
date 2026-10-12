// The JSON the demo's routes answer with, where a caller reads it. The routes
// check their answers against these types, and the demo client returns
// them, so the browser code and the tests read the server's own shapes. No
// Workers APIs: the browser code compiles this file under the DOM lib.

/** Who is signed in, from `/me`. */
export interface Me {
  recordId: string;
  memberName: string | null;
  operator: boolean;
}

/** Fresh recovery codes, each with its word form, and when they were issued. */
export interface IssuedCodes {
  recoveryCodes: string[];
  recoveryCodeWords: string[];
  issuedAt: number;
}

/** A registration: the new record and its first recovery codes. */
export interface Registered extends IssuedCodes {
  recordId: string;
}

/** A recovery: the record recovered and how many unused codes it has left. */
export interface Recovered {
  recordId: string;
  codesLeft: number;
}

/** A passkey as its owner's settings list it. */
export interface PasskeyListing {
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  provider: string | null;
  backupEligible: boolean;
  backedUp: boolean;
}

/** A session as its owner's settings list it. */
export interface SessionListing {
  id: string;
  createdAt: number;
  expiresAt: number;
  userAgent: string;
  current: boolean;
  /** Whether the passkey ceremony that started the session was user-verified. */
  userVerified: boolean;
  /** Whether the session's latest step-up was user-verified, or null if it has none. */
  stepUpUserVerified: boolean | null;
}

/** A revoked passkey's entry, which its password manager still shows. */
export interface Revoked {
  passkeyName: string;
  provider: string | null;
  credentialId: string;
  rpId: string;
}

/** One operator action, as the operator log keeps it. */
export interface OperatorLogEntry {
  operatorId: string;
  action: "lookup" | "create-rebind-link" | "suspend" | "resume" | "remove" | "allow-name";
  targetId: string;
  at: number;
}

/** A record's state and counts, as an operator sees them. */
export interface MemberSummary {
  createdAt: number;
  suspendedAt: number | null;
  removedAt: number | null;
  passkeys: number;
  sessions: number;
  recoveryCodesLeft: number;
  rebindLinkOutstanding: boolean;
}

/** What an operator sees of a member: the record's summary and the log entries that target it. */
export interface MemberView {
  recordId: string;
  summary: MemberSummary;
  entries: OperatorLogEntry[];
  /** Whether the name the operator gave was retired with its member, where the answer says. */
  retired?: boolean;
}

/** An operator action's answer: the member as it now stands, and a rebind link where the action made one. */
export interface OperatorActed {
  member: MemberView;
  link?: string;
}
