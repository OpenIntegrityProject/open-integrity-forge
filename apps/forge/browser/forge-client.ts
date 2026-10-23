// The client for the forge routes. Like the demo client, it sends the
// requests and returns outcomes. It does not touch the DOM. Tests also use it,
// with a software authenticator in place of the passkey.

import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from "passkey-cloudflare/browser";
import type { DemoClient, Target } from "../../demo/browser/demo-client.ts";
import type { ApprovalRequest, CommitDetail, FreshVerify, MirrorState, OperatorProject, PushAccess, Outside, ProjectListing, ProjectState, PromoterKey, Refusal } from "../src/state.ts";

export interface ForgeMe {
  recordId: string;
  memberName: string | null;
  promoter: PromoterKey | null;
  projects: ProjectListing[];
  repoHost: string;
}

/** The steps of a request that needs a fresh step-up, for a page that shows them: the passkey, then the request. */
export type GatedStep = "passkey" | "sending";

/** The forge's step-up window is 10 minutes. The page counts a shorter one, for clock skew. */
const STEP_UP_FRESH_MS = 9 * 60_000;

export type Outcome<T> = { result: "ok"; value: T } | { result: "refused"; status: number; refusal: Refusal } | { result: "cancelled" };

/** How the client asks the promoter's passkey for an approval. */
interface Approver {
  approve(options: PublicKeyCredentialRequestOptionsJSON): Promise<{ result: "found"; response: AuthenticationResponseJSON } | { result: "not-found" }>;
}

async function outcome<T>(response: Response): Promise<Outcome<T>> {
  if (response.ok) return { result: "ok", value: (await response.json()) as T };
  let refusal: Refusal;
  try {
    const body = (await response.json()) as Partial<Refusal> & { error?: string };
    refusal = { error: body.error ?? String(response.status), reason: body.reason ?? body.error ?? response.statusText };
  } catch {
    refusal = { error: String(response.status), reason: response.statusText };
  }
  return { result: "refused", status: response.status, refusal };
}

export class ForgeClient {
  readonly target: Target;
  readonly demo: DemoClient;
  readonly approver: Approver;

  constructor(target: Target, demo: DemoClient, approver: Approver) {
    this.target = target;
    this.demo = demo;
    this.approver = approver;
  }

  private request(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
    return this.target.fetch(
      new Request(this.target.origin + path, {
        method,
        ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) } : {}),
      }),
    );
  }

  /** Until when the session's step-up is fresh, as far as this page knows: it counts only the step-ups that it did. */
  private steppedUpUntil = 0;

  private async stepUp(step?: (s: GatedStep) => void): Promise<boolean> {
    step?.("passkey");
    const steppedUp = await this.demo.stepUp();
    if (steppedUp.result !== "ok") return false;
    this.steppedUpUntil = Date.now() + STEP_UP_FRESH_MS;
    return true;
  }

  /**
   * Send a POST request to a route that can require a fresh step-up. If the
   * forge asks for one, do it once and send the request again. With `always`,
   * for a route that requires one each time, do the step-up first when this
   * page did none lately, rather than wait for the refusal.
   */
  private async gated<T>(path: string, body?: unknown, step?: (s: GatedStep) => void, always = true): Promise<Outcome<T>> {
    if (always && Date.now() >= this.steppedUpUntil && !(await this.stepUp(step))) return { result: "cancelled" };
    step?.("sending");
    let response = await this.request("POST", path, body);
    const refused = (await response.clone().json().catch(() => ({}))) as { error?: string };
    if (response.status === 403 && refused.error === "step-up-required") {
      if (!(await this.stepUp(step))) return { result: "cancelled" };
      step?.("sending");
      response = await this.request("POST", path, body);
    }
    return outcome<T>(response);
  }

  async me(): Promise<ForgeMe | null> {
    const response = await this.request("GET", "/forge/me");
    if (response.status === 401) return null;
    const got = await outcome<ForgeMe>(response);
    if (got.result !== "ok") throw new Error(`/forge/me: ${response.status}`);
    return got.value;
  }

  /** Make the passkey of this registration response the promoter key. */
  setPromoterKey(response: unknown, step?: (s: GatedStep) => void): Promise<Outcome<PromoterKey>> {
    // Only a key that replaces another key needs a step-up, so the first key asks for none.
    return this.gated<PromoterKey>("/forge/me/promoter-key", { response }, step, false);
  }

  async state(projectId: string): Promise<Outcome<ProjectState>> {
    return outcome<ProjectState>(await this.request("GET", `/forge/projects/${projectId}`));
  }

  async prepareProject(name: string): Promise<Outcome<ApprovalRequest>> {
    return outcome<ApprovalRequest>(await this.request("POST", "/forge/projects/prepare", { name }));
  }

  async prepareInception(projectId: string): Promise<Outcome<ApprovalRequest>> {
    return outcome<ApprovalRequest>(await this.request("POST", `/forge/projects/${projectId}/inception/prepare`));
  }

  async prepareAgents(projectId: string, agents: string[]): Promise<Outcome<ApprovalRequest>> {
    return outcome<ApprovalRequest>(await this.request("POST", `/forge/projects/${projectId}/agents/prepare`, { agents }));
  }

  async prepareRevocation(projectId: string, agentId: string): Promise<Outcome<ApprovalRequest>> {
    return outcome<ApprovalRequest>(await this.request("POST", `/forge/projects/${projectId}/agents/${agentId}/revoke/prepare`));
  }

  async prepareRelease(projectId: string, name: string): Promise<Outcome<ApprovalRequest>> {
    return outcome<ApprovalRequest>(await this.request("POST", `/forge/projects/${projectId}/releases/prepare`, { name }));
  }

  async preparePromotion(projectId: string, proposalId: string): Promise<Outcome<ApprovalRequest>> {
    return outcome<ApprovalRequest>(await this.request("POST", `/forge/projects/${projectId}/proposals/${proposalId}/prepare`));
  }

  /** Ask the promoter's passkey to approve this exact change, and send the approval. `sending` runs when the passkey has signed, before the forge records it. */
  async approve(request: ApprovalRequest, sending?: () => void): Promise<Outcome<ProjectState>> {
    const found = await this.approver.approve(request.options as PublicKeyCredentialRequestOptionsJSON);
    if (found.result !== "found") return { result: "cancelled" };
    sending?.();
    return outcome<ProjectState>(
      await this.request("POST", `/forge/projects/${request.projectId}/approvals/${request.approvalId}`, { response: found.response }),
    );
  }

  async commit(projectId: string, oid: string): Promise<Outcome<CommitDetail>> {
    return outcome<CommitDetail>(await this.request("GET", `/forge/projects/${projectId}/commits/${oid}`));
  }

  async tempt(projectId: string, agentId: string): Promise<Outcome<null>> {
    return outcome<null>(await this.request("POST", `/forge/projects/${projectId}/agents/${agentId}/tempt`));
  }

  async preparePerson(projectId: string, publicKey: string): Promise<Outcome<ApprovalRequest>> {
    return outcome<ApprovalRequest>(await this.request("POST", `/forge/projects/${projectId}/people/prepare`, { publicKey }));
  }

  pushAccess(projectId: string, personId: string, step?: (s: GatedStep) => void): Promise<Outcome<PushAccess>> {
    return this.gated<PushAccess>(`/forge/projects/${projectId}/people/${personId}/push-access`, undefined, step);
  }

  async give(projectId: string, agentId: string, task: string, topic?: string): Promise<Outcome<null>> {
    return outcome<null>(await this.request("POST", `/forge/projects/${projectId}/agents/${agentId}/tasks`, { task, ...(topic ? { topic } : {}) }));
  }

  async redo(projectId: string, proposalId: string): Promise<Outcome<null>> {
    return outcome<null>(await this.request("POST", `/forge/projects/${projectId}/proposals/${proposalId}/redo`));
  }

  async verifyFresh(projectId: string): Promise<Outcome<FreshVerify>> {
    return outcome<FreshVerify>(await this.request("POST", `/forge/projects/${projectId}/verify`));
  }

  async outside(projectId: string): Promise<Outcome<Outside>> {
    return outcome<Outside>(await this.request("POST", `/forge/projects/${projectId}/outside`));
  }

  mirror(projectId: string, step?: (s: GatedStep) => void): Promise<Outcome<MirrorState>> {
    return this.gated<MirrorState>(`/forge/projects/${projectId}/mirror`, undefined, step);
  }

  reset(projectId: string, step?: (s: GatedStep) => void): Promise<Outcome<{ ok: true }>> {
    return this.gated<{ ok: true }>(`/forge/projects/${projectId}/reset`, undefined, step);
  }

  /** Every project on the forge, for an operator, after a step-up. */
  operatorProjects(step?: (s: GatedStep) => void): Promise<Outcome<{ projects: OperatorProject[] }>> {
    return this.gated<{ projects: OperatorProject[] }>("/forge/operator/projects", undefined, step);
  }

  /** Delete any project, as an operator. */
  operatorReset(projectId: string, step?: (s: GatedStep) => void): Promise<Outcome<{ ok: true }>> {
    return this.gated<{ ok: true }>(`/forge/operator/projects/${projectId}/reset`, undefined, step);
  }
}
