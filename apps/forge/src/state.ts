// The JSON the forge routes answer with. The browser code and the tests read
// these types. No Workers APIs here: the browser code compiles this file too.

import type { Change, Identity } from "../authority/git.ts";
import type { FileDiff } from "../authority/diff.ts";
import type { ApprovalPayload } from "../authority/approval.ts";
import type { Policy } from "../authority/policy.ts";
import type { CommitReport, HistoryReport, ProposalReport } from "../authority/verify.ts";

export type { Change, ApprovalPayload, Policy, HistoryReport, ProposalReport, CommitReport, FileDiff };

/** The promoter key of a person: the passkey whose approvals a project trusts. */
export interface PromoterKey {
  /** The member name, which is the key id in each policy. */
  id: string;
  credentialId: string;
  alg: -7 | -8;
  publicKey: { kty: "EC" | "OKP"; crv: "P-256" | "Ed25519"; x: string; y?: string };
  /** The passkey label, such as able-acid-also. */
  label: string | null;
  capturedAt: number;
}

export interface ProjectListing {
  id: string;
  name: string;
  createdAt: number;
}

/** What the browser needs to ask the promoter's passkey for one approval. */
export interface ApprovalRequest {
  approvalId: string;
  projectId: string;
  payload: ApprovalPayload;
  /** The commit message, for a change of main: the passkey signs the whole commit, this message included. */
  message?: string;
  /** The request options for `usePasskey`. For a commit that the passkey signs, the challenge is the SSHSIG data of that commit. For a release, it is the SHA-256 digest of the payload bytes. */
  options: {
    challenge: string;
    rpId: string;
    allowCredentials: { id: string; type: "public-key" }[];
    userVerification: "required";
    timeout: number;
  };
  /** The files the change adds, modifies or deletes. */
  changes: Change[];
  /** What the change does, in one line. */
  summary: string;
}

export type TaskStatus = "queued" | "working" | "proposed" | "failed";

export interface TaskEvent {
  at: number;
  text: string;
}

export interface TaskState {
  id: string;
  title: string;
  branch: string;
  /** A task that breaks the rules on purpose, for the demo. */
  rogue: boolean;
  status: TaskStatus;
  events: TaskEvent[];
  head: string | null;
  proposalId: string | null;
  error: string | null;
}

export interface AgentState {
  id: string;
  /** An agent works in the forge; a person works from a laptop with git. */
  kind: "agent" | "person";
  name: string;
  fork: string;
  publicKey: string;
  fingerprint: string;
  validAfter: string;
  validBefore: string;
  /** When the write token for the fork expires, in milliseconds since the epoch. */
  tokenExpiresAt: number | null;
  tasks: TaskState[];
}

export type ProposalStatus = "verifying" | "ready" | "rejected" | "stale" | "promoted";

export interface ProposalState {
  id: string;
  agentId: string;
  taskId: string;
  title: string;
  branch: string;
  head: string;
  /** Main at the last verification. */
  base: string;
  status: ProposalStatus;
  report: ProposalReport | null;
  /** What promotion would change in main, with line diffs of small text files. */
  changes: FileDiff[];
  /** When the agent began to redo this proposal on a newer main, after a conflict. */
  redoneAt: number | null;
  promotedAs: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectEvent {
  at: number;
  kind: "project" | "policy" | "agent" | "proposal" | "promotion" | "verify" | "refusal";
  text: string;
}

export interface FreshVerify {
  at: number;
  report: HistoryReport;
}

/** The GitHub mirror of a project, where the deployment has one. */
export interface MirrorState {
  /** Whether this forge can mirror: it has a mirror owner and a token. */
  available: boolean;
  /** owner/name of the mirror repository. */
  target: string | null;
  /** Where a person sees the mirror's checks, or the remote itself when it is not GitHub. */
  checksUrl: string | null;
  last: { at: number; head: string } | null;
}

export interface ProjectState {
  id: string;
  /** The project's change count when the state was read. A page keeps the state with the higher count. */
  version: number;
  name: string;
  createdAt: number;
  /** `missing` when the host no longer has the repository, for example after a cleanup outside the forge; the project can still be deleted. */
  repo: { name: string; host: "artifacts" | "local"; remote: string | null; missing: boolean };
  /** The id of the inception commit, when there is one. */
  repoId: string | null;
  mainHead: string | null;
  promoter: PromoterKey;
  policy: Policy | null;
  agents: AgentState[];
  proposals: ProposalState[];
  history: HistoryReport | null;
  freshVerify: FreshVerify | null;
  mirror: MirrorState;
  /** Whether agents can write with Claude here: the deployment has an Anthropic API key. */
  llm: boolean;
  events: ProjectEvent[];
}

/** A read token for the project repository, and the commands that verify it outside the forge. */
export interface Outside {
  remote: string;
  token: string;
  expiresAt: number;
  commands: string[];
}

/** A refusal that a person can read. `error` is stable for code; `reason` is one sentence. */
export interface Refusal {
  error: string;
  reason: string;
}

/** An approval as a Gordian Envelope (authority/envelope.ts makes it). */
export interface ApprovalEnvelope {
  ur: string;
  cbor: string;
  digest: string;
}

/** What a person needs to push to their fork from a laptop. */
export interface PushAccess {
  fork: string;
  remote: string;
  expiresAt: number;
  /** Whether the forge subscribes its repositories to push events itself. */
  pushEvents: boolean;
  commands: string[];
}

/** One commit, as the commit sheet shows it. */
export interface CommitDetail {
  oid: string;
  tree: string;
  parents: string[];
  author: Identity;
  committer: Identity;
  /** The message without the approval trailer. */
  message: string;
  /** The armored SSH signature, or null. */
  signature: string | null;
  /** The approval, decoded, or null. For a commit that the passkey signs, it is the trailer payload with the assertion from the signature. */
  approval: {
    payload: ApprovalPayload;
    credentialId: string;
    authenticatorData: string;
    clientDataJSON: string;
    signature: string;
    clientData: unknown;
    /** The approval as a Gordian Envelope, and an elided form with the same digest. */
    envelope: { full: ApprovalEnvelope; elided: ApprovalEnvelope };
  } | null;
  changes: FileDiff[];
  /** What the verifier said about this commit, from the last report that holds it. */
  report: CommitReport | null;
}

/** A project as an operator lists it. */
export interface ProjectSummary {
  id: string;
  name: string;
  owner: string;
  createdAt: number;
  repoName: string;
  /** The host no longer has the repository. */
  missing: boolean;
}

/** A project in the operator's list, with its owner's member name when the owner still has one. */
export type OperatorProject = ProjectSummary & { ownerName: string | null };
