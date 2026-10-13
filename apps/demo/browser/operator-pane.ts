// The operator section of the settings pane: a member looked up by name, what
// was done to them, and the actions an operator can take. No requests.

import type { MemberSummary } from "../src/responses.ts";
import { $, row, when } from "./dom.ts";
import type { FoundMember, OperatorOutcome, Told } from "./flows.ts";

function memberStatus(summary: MemberSummary): string {
  if (summary.removedAt !== null) return `Removed since ${when(summary.removedAt)}`;
  if (summary.suspendedAt !== null) return `Suspended since ${when(summary.suspendedAt)}`;
  return "Active";
}

export class OperatorPane {
  /** The member the last lookup found, which the actions act on. */
  private found: { memberName: string; recordId: string } | null = null;

  get member() {
    return this.found;
  }

  actions() {
    return document.querySelectorAll<HTMLButtonElement>("#operator-actions button");
  }

  /** Show what a lookup found; its member becomes the one the actions act on. */
  lookedUp(outcome: Exclude<OperatorOutcome, Told>) {
    if (outcome.result === "member") {
      const { memberName, recordId } = outcome.member;
      this.found = { memberName, recordId };
    }
    this.acted(outcome);
  }

  /** Show what an action did: the member as it now is, and a note. */
  acted(outcome: Exclude<OperatorOutcome, Told>) {
    if (outcome.result === "member") this.showMember(outcome.member);
    $("operator-result").textContent = outcome.note;
  }

  clear() {
    this.found = null;
    $("operator-member").hidden = true;
    $("operator-result").textContent = "";
    for (const action of this.actions()) action.disabled = true;
  }

  /**
   * Show a member, with the actions enabled unless the member was removed, which
   * is final. Allowing the name again is enabled only for a retired name.
   */
  private showMember(member: FoundMember) {
    const { summary } = member;
    $("operator-summary").replaceChildren(
      row(["Record id", member.recordId]),
      row(["Status", memberStatus(summary)]),
      row(["Created", when(summary.createdAt)]),
      row(["Passkeys", String(summary.passkeys)]),
      row(["Sessions", String(summary.sessions)]),
      row(["Recovery codes left", String(summary.recoveryCodesLeft)]),
      row(["Rebind link", summary.rebindLinkOutstanding ? "Outstanding" : "None"]),
    );
    $("operator-entries").replaceChildren(...member.entries.map((e) => row([when(e.at), e.action, e.operatorId])));
    $("operator-member").hidden = false;
    for (const action of this.actions()) {
      action.disabled = action.value === "allow-name" ? !member.retired : summary.removedAt !== null;
    }
  }
}
