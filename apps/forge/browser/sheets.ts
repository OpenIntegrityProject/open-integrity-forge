// The approval sheet and the commit sheet. The approval sheet shows exactly
// what the passkey will sign. It requests the passkey only after the person
// presses Approve. Then it shows the approval as the repository keeps it. The
// commit sheet shows one commit: its message, its signature or approval, its
// files and the result of the verifier.

import type { ApprovalRequest, CommitDetail, FileDiff, ProjectState, RuleResultView } from "./view-types.ts";
import type { ForgeClient, Outcome } from "./forge-client.ts";
import { copyButton } from "./copy.ts";
import { clock, didRepo, laneClass, plural, short, shortFingerprint } from "./format.ts";
import { byId, h, reducedMotion } from "./h.ts";
import { seal } from "./seal.ts";

const ACTION_TITLE = {
  incept: "Approve the first commit",
  policy: "Approve the new rules",
  promote: "Approve this promotion",
  release: "Approve this release",
} as const;

function refusalText<T>(outcome: Outcome<T>): string {
  return outcome.result === "refused" ? outcome.refusal.reason : outcome.result === "cancelled" ? "Not approved. Nothing changed." : "";
}

function fact(term: string, ...value: (Node | string)[]) {
  return [h("dt", null, term), h("dd", null, ...value)];
}

export const mono = (text: string, title?: string) => h("code", { class: "hash", title: title ?? text }, text);

/** The diff of one file, as added and removed lines. With a `key`, the stage keeps it open when it draws again. */
export function fileDiff(file: FileDiff, open = false, key?: string) {
  return h(
    "details",
    { class: ["file-diff", `file-${file.change}`], open, "data-key": key },
    h("summary", null, h("span", { class: "file-change" }, file.change), " ", h("code", null, file.path)),
    file.lines
      ? h(
          "pre",
          // It can get the focus, so that the keyboard can scroll a long line.
          { class: "diff", tabindex: 0, "aria-label": `Changes to ${file.path}` },
          file.lines.map((l) => h("span", { class: l.kind === "+" ? "add" : l.kind === "-" ? "del" : "ctx" }, `${l.kind} ${l.text}\n`)),
        )
      : h("p", { class: "muted" }, "Too large or not text to show here."),
  );
}

/** The approval as a Gordian Envelope: its digest, the full UR, and the elided UR to share. */
function envelopeView(envelope: { full: { ur: string; digest: string }; elided: { ur: string; digest: string } }) {
  const copyable = (label: string, text: string) =>
    h("div", { class: "command" }, h("pre", { class: "code", tabindex: 0, "aria-label": label }, text), copyButton(text, "Copy", { "aria-label": `Copy ${label.toLowerCase()}` }));
  return h(
    "details",
    { class: "raw envelope" },
    h("summary", null, "As a Gordian Envelope"),
    h("p", { class: "small" }, "The same approval as a Gordian Envelope, with root digest ", mono(envelope.full.digest.slice(0, 16) + "…", envelope.full.digest), "."),
    copyable("The full Envelope", envelope.full.ur),
    h("p", { class: "small" }, "Elided for sharing: the authenticator data, client data and signature become digests. The root digest is the same, so it still names exactly this approval."),
    copyable("The elided Envelope", envelope.elided.ur),
  );
}

export function ruleList(rules: RuleResultView[]) {
  return h(
    "ul",
    { class: "rules" },
    rules.map((r) => h("li", { class: r.ok ? "rule-ok" : "rule-fail" }, h("span", { class: "rule-mark", "aria-hidden": "true" }, r.ok ? "✓" : "✗"), h("b", null, r.rule), " ", r.reason)),
  );
}

export class ApprovalSheet {
  private readonly dialog = byId<HTMLDialogElement>("approval");
  private readonly body = byId("approval-body");
  private readonly forge: ForgeClient;

  constructor(forge: ForgeClient) {
    this.forge = forge;
    this.dialog.addEventListener("cancel", (event) => {
      // Escape closes the sheet only while no passkey request runs.
      if (this.dialog.dataset.state === "waiting") event.preventDefault();
    });
  }

  private show(state: string, ...children: Node[]) {
    this.dialog.dataset.state = state;
    this.body.replaceChildren(...children);
    // The sheet's accessible name is its heading, for each step it shows.
    this.body.querySelector("h2")?.setAttribute("id", "approval-title");
    if (!this.dialog.open) this.dialog.showModal();
    const first = this.body.querySelector<HTMLElement>("[data-autofocus]");
    first?.focus();
  }

  /** Wait for a press on one of `buttons`, and return its value. When the sheet closes, return "close". */
  private choose(buttons: HTMLButtonElement[]): Promise<string> {
    return new Promise((done) => {
      const finish = (value: string) => {
        this.dialog.removeEventListener("close", onClose);
        done(value);
      };
      // `lend` closes the sheet and opens it again around a passkey request. That close event arrives late, so ignore it while the sheet is open.
      const onClose = () => {
        if (!this.dialog.open) finish("close");
      };
      this.dialog.addEventListener("close", onClose);
      for (const b of buttons) b.addEventListener("click", () => finish(b.value), { once: true });
    });
  }

  private close() {
    if (this.dialog.open) this.dialog.close();
  }

  /** Prepare one change and show it. If the person approves it, sign it. Return the project state after it, or null. */
  async run(prepare: () => Promise<Outcome<ApprovalRequest>>): Promise<ProjectState | null> {
    this.show("preparing", h("h2", null, "Preparing the change"), h("p", { class: "muted" }, "The forge builds the exact change, so you can see what you approve."));
    const prepared = await prepare();
    if (prepared.result !== "ok") return this.refused(refusalText(prepared));
    const request = prepared.value;

    for (;;) {
      const approve = h("button", { class: "primary seal-button", type: "button", value: "approve", "data-autofocus": true }, "Approve with passkey");
      const cancel = h("button", { type: "button", value: "close" }, "Cancel");
      this.show("review", ...this.review(request), h("div", { class: "sheet-actions" }, cancel, approve));
      if ((await this.choose([approve, cancel])) !== "approve") {
        this.close();
        return null;
      }
      approve.disabled = true;
      cancel.disabled = true;
      approve.textContent = "Waiting for your passkey…";
      this.dialog.dataset.state = "waiting";
      const approved = await this.forge.approve(request);
      if (approved.result === "ok") return this.signed(request, approved.value);
      if (approved.result === "refused") return this.refused(approved.refusal.reason);
      // The passkey declined. Tell the person, and let them try again.
      const again = h("button", { class: "primary", type: "button", value: "again", "data-autofocus": true }, "Try again");
      const close = h("button", { type: "button", value: "close" }, "Close");
      this.show("declined", h("h2", null, "Not approved"), h("p", null, "Your passkey did not approve it, so nothing changed."), h("div", { class: "sheet-actions" }, close, again));
      if ((await this.choose([again, close])) !== "again") {
        this.close();
        return null;
      }
    }
  }

  private review(request: ApprovalRequest): Node[] {
    const p = request.payload;
    // The first step of an inception: the passkey signs an empty commit itself, as an SSH signature.
    const root = p.action === "incept" && p.parents.length === 0;
    const title = root ? "Sign the inception commit" : p.action === "incept" ? "Approve the first policy" : ACTION_TITLE[p.action];
    const parents =
      p.parents.length === 0
        ? [h("span", null, "None: this is the root of trust")]
        : p.parents.map((oid, i) =>
            h("span", { class: "parent" }, mono(short(oid), oid), " ", h("span", { class: "muted" }, p.action === "promote" ? (i === 0 ? "main now" : "the proposal") : p.action === "release" ? "the commit to release" : "main now")),
          );
    return [
      h("div", { class: "sheet-head" }, seal({ size: 52, label: "" }), h("h2", null, title)),
      h("p", { class: "sheet-lead" }, request.summary),
      h(
        "dl",
        { class: "facts" },
        fact("Repository", p.repo ? mono(didRepo(p.repo)) : "The id of this commit becomes the did:repo address of the repository"),
        p.action === "release" ? fact("Tag", p.ref.replace("refs/tags/", "")) : fact("Branch", "main"),
        fact(p.parents.length === 1 ? "Parent" : "Parents", ...parents),
        fact("Resulting tree", root ? "Empty" : mono(short(p.tree), p.tree)),
      ),
      root
        ? h("p", null, "An empty commit: no files. Its committer is your passkey's SSH key fingerprint, and the next step sets the rules.")
        : p.action === "release"
          ? h("p", null, "A release changes no file: it names this commit of main, and your approval goes into the tag.")
          : h("h3", null, plural(request.changes.length, "file"), " change"),
      h(
        "ul",
        { class: "file-list" },
        request.changes.map((c) => h("li", { class: `file-${c.change}` }, h("span", { class: "file-change" }, c.change), " ", h("code", null, c.path))),
      ),
      ...(request.message !== undefined
        ? [h("h3", null, "Commit message"), h("pre", { class: "code", tabindex: 0, "aria-label": "The commit message" }, request.message.trimEnd())]
        : []),
      h(
        "p",
        { class: "muted small" },
        root
          ? "Your passkey signs this exact commit as an SSH signature, so git verify-commit checks it on any clone, with no forge."
          : request.message !== undefined
            ? "Your passkey signs this exact commit, its message included, as an SSH signature, so git verify-commit checks it on any clone, with no forge."
            : "Your passkey signs a digest of exactly these facts. The signature goes into the commit, so anyone with a clone can check it without this site.",
      ),
    ];
  }

  private async signed(request: ApprovalRequest, state: ProjectState): Promise<ProjectState> {
    const head = state.mainHead!;
    const stamp = seal({ size: 168, ring: `${state.promoter.label ?? "promoter key"} ✦ approved ✦ `, center: short(request.payload.tree), label: `Approved by ${state.promoter.label ?? "your passkey"}` });
    stamp.classList.add("stamp");
    if (!reducedMotion()) stamp.classList.add("stamp-press");
    const root = request.payload.action === "incept" && request.payload.parents.length === 0;
    // The passkey signed the commit itself: the inception commit, and each change of main.
    const signedCommit = root || request.message !== undefined;
    const raw = h("details", { class: "raw" }, h("summary", null, signedCommit ? "Show the signature as the commit stores it" : "Show the approval as the commit stores it"), h("p", { class: "muted" }, "Loading…"));
    const done = h("button", { class: "primary", type: "button", value: "done", "data-autofocus": true }, "Done");
    this.show(
      "signed",
      h(
        "div",
        { class: "signed" },
        stamp,
        h("div", null, h("h2", null, root ? "Signed" : "Approved"), h("p", null, "Main is now at ", mono(short(head), head), "."), h("p", { class: "muted" }, request.summary)),
      ),
      // The inception commit gives the repository its identifier, the same on every host and in every clone.
      ...(root
        ? [
            h(
              "div",
              { class: "did-born" },
              h("p", { class: "small" }, "The repository now has its decentralized identifier. It is the same on every host and in every clone."),
              h("div", { class: "command" }, h("pre", { class: "code", tabindex: 0, "aria-label": "The did:repo address of the repository" }, didRepo(state.repoId ?? head)), copyButton(didRepo(state.repoId ?? head))),
            ),
          ]
        : []),
      raw,
      h("div", { class: "sheet-actions" }, done),
    );
    void this.forge.commit(state.id, head).then((detail) => {
      if (detail.result === "ok" && signedCommit && detail.value.signature) {
        raw.replaceChildren(raw.firstChild!, h("pre", { class: "code", tabindex: 0 }, detail.value.signature));
        return;
      }
      if (detail.result !== "ok" || !detail.value.approval) return;
      const { clientData, ...trailer } = detail.value.approval;
      raw.replaceChildren(raw.firstChild!, h("pre", { class: "code", tabindex: 0 }, JSON.stringify({ ...trailer, clientData }, null, 2)));
    });
    await this.choose([done]);
    this.close();
    return state;
  }

  private async refused(reason: string): Promise<null> {
    const close = h("button", { class: "primary", type: "button", value: "close", "data-autofocus": true }, "Close");
    this.show("refused", h("h2", null, "Not done"), h("p", null, reason), h("div", { class: "sheet-actions" }, close));
    await this.choose([close]);
    this.close();
    return null;
  }
}

export class CommitSheet {
  private readonly dialog = byId<HTMLDialogElement>("commit");
  private readonly body = byId("commit-body");
  private readonly forge: ForgeClient;

  constructor(forge: ForgeClient) {
    this.forge = forge;
    byId("commit-close").addEventListener("click", () => this.dialog.close());
  }

  async open(projectId: string, oid: string, agentName: (id: string | null | undefined) => string | null) {
    this.body.replaceChildren(h("h2", { id: "commit-title" }, "Commit ", mono(short(oid), oid)), h("p", { class: "muted" }, "Reading it from the repository…"));
    if (!this.dialog.open) this.dialog.showModal();
    const got = await this.forge.commit(projectId, oid);
    if (got.result !== "ok") {
      this.body.replaceChildren(h("h2", { id: "commit-title" }, "Commit ", mono(short(oid), oid)), h("p", null, refusalText(got)));
      return;
    }
    this.body.replaceChildren(...this.detail(got.value, agentName));
  }

  private detail(c: CommitDetail, agentName: (id: string | null | undefined) => string | null): Node[] {
    const [subject, ...rest] = c.message.trimEnd().split("\n");
    const report = c.report;
    const signer = report?.signer;
    const verdict = report ? (report.ok ? "Verifies" : "Rejected") : "Not verified yet";
    const by = c.approval
      ? h(
          "section",
          { class: "proof" },
          h("h3", null, "Approved by a passkey"),
          h(
            "div",
            { class: "proof-row" },
            seal({ size: 92, center: short(c.approval.payload.tree), label: "Passkey approval" }),
            h(
              "dl",
              { class: "facts" },
              fact("Action", c.approval.payload.action),
              fact("Summary", c.approval.payload.summary),
              fact("Credential", mono(`${c.approval.credentialId.slice(0, 16)}…`, c.approval.credentialId)),
              fact("Signed at", new Date(c.approval.payload.at).toLocaleString()),
            ),
          ),
          h("details", { class: "raw" }, h("summary", null, "Show the approval"), h("pre", { class: "code", tabindex: 0 }, JSON.stringify({ payload: c.approval.payload, clientData: c.approval.clientData, authenticatorData: c.approval.authenticatorData, signature: c.approval.signature }, null, 2))),
          envelopeView(c.approval.envelope),
        )
      : c.signature
        ? h(
            "section",
            { class: ["proof", laneClass(signer?.kind === "author" ? signer.id : "x")] },
            h(
              "h3",
              null,
              signer?.kind === "promoter" && !signer.id ? "Signed by a passkey, as an SSH signature" : signer?.id ? `Signed by ${agentName(signer.id) ?? signer.id}'s key` : "Signed with an SSH key",
            ),
            signer?.fingerprint ? h("p", null, mono(shortFingerprint(signer.fingerprint), signer.fingerprint)) : null,
            h("details", { class: "raw" }, h("summary", null, "Show the signature"), h("pre", { class: "code", tabindex: 0 }, c.signature)),
          )
        : h("section", { class: "proof proof-none" }, h("h3", null, "No signature and no approval"));
    return [
      h("p", { class: ["verdict", report ? (report.ok ? "verdict-ok" : "verdict-fail") : "verdict-none"] }, verdict),
      h("h2", { id: "commit-title" }, subject ?? ""),
      rest.join("\n").trim() ? h("p", { class: "message" }, rest.join("\n").trim()) : null,
      h(
        "dl",
        { class: "facts" },
        fact("Commit", mono(short(c.oid), c.oid)),
        // A commit with no parents is the inception commit. Its id is the identifier of the repository.
        ...(c.parents.length === 0 ? fact("Identifier", mono(didRepo(c.oid))) : []),
        fact(c.parents.length === 1 ? "Parent" : "Parents", ...(c.parents.length ? c.parents.map((p) => mono(short(p), p)) : ["None: the root"])),
        fact("Tree", mono(short(c.tree), c.tree)),
        fact("Author", `${c.author.name}, ${clock(c.author.timestamp * 1000)}`),
      ),
      by,
      report ? h("section", null, h("h3", null, "What the verifier says"), ruleList(report.rules)) : null,
      h("section", null, h("h3", null, plural(c.changes.length, "file"), " changed"), c.changes.map((f) => fileDiff(f, c.changes.length <= 2))),
    ].filter((n): n is HTMLElement => n !== null);
  }
}
