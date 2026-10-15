// The client for the forge routes. Like the demo client, it sends the
// requests and returns outcomes. It does not touch the DOM. Tests also use it,
// with a software authenticator in place of the passkey.

import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from "passkey-cloudflare/browser";
import type { DemoClient, Target } from "../../demo/browser/demo-client.ts";
import type { ApprovalRequest, CommitDetail, FreshVerify, MirrorState, PushAccess, Outside, ProjectListing, ProjectState, PromoterKey, Refusal } from "../src/state.ts";

export interface ForgeMe {
  recordId: string;
  memberName: string | null;
  promoter: PromoterKey | null;
  projects: ProjectListing[];
  repoHost: string;
}

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

  /** Send a POST request. If the route requires a step-up, do the step-up once and send the request again. */
  private async gated<T>(path: string, body?: unknown): Promise<Outcome<T>> {
    let response = await this.request("POST", path, body);
    const refused = (await response.clone().json().catch(() => ({}))) as { error?: string };
    if (response.status === 403 && refused.error === "step-up-required") {
      const steppedUp = await this.demo.stepUp();
      if (steppedUp.result !== "ok") return { result: "cancelled" };
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
  setPromoterKey(response: unknown): Promise<Outcome<PromoterKey>> {
    return this.gated<PromoterKey>("/forge/me/promoter-key", { response });
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

  /** Ask the promoter's passkey to approve this exact change, and send the approval. */
  async approve(request: ApprovalRequest): Promise<Outcome<ProjectState>> {
    const found = await this.approver.approve(request.options as PublicKeyCredentialRequestOptionsJSON);
    if (found.result !== "found") return { result: "cancelled" };
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

  pushAccess(projectId: string, personId: string): Promise<Outcome<PushAccess>> {
    return this.gated<PushAccess>(`/forge/projects/${projectId}/people/${personId}/push-access`);
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

  mirror(projectId: string): Promise<Outcome<MirrorState>> {
    return this.gated<MirrorState>(`/forge/projects/${projectId}/mirror`);
  }

  reset(projectId: string): Promise<Outcome<{ ok: true }>> {
    return this.gated<{ ok: true }>(`/forge/projects/${projectId}/reset`);
  }
}
