// The stage: the history band and the three regions under it (the rules in
// the repository, the agents, the proposals), and the strip that checks the
// repository outside the forge. Each render draws from one project state.

import type { AgentState, FreshVerify, Outside, ProjectState, ProposalState, PushAccess } from "./view-types.ts";
import { clock, laneClass, plural, remaining, short, shortFingerprint } from "./format.ts";
import { HistoryGraph, legend } from "./graph.ts";
import { byId, fill, h, reducedMotion } from "./h.ts";
import { seal } from "./seal.ts";
import { fileDiff, mono, ruleList } from "./sheets.ts";

export interface StageActions {
  admit(): void;
  tempt(agentId: string): void;
  revoke(agentId: string): void;
  give(agentId: string, task: string, topic?: string): void;
  admitPerson(publicKey: string): void;
  pushAccess(personId: string): void;
  redo(proposalId: string): void;
  release(name: string): void;
  promote(proposalId: string): void;
  openCommit(oid: string): void;
  verify(): void;
  commands(): void;
  mirror(): void;
}

type AgentStatus = "idle" | "working" | "proposed" | "rejected" | "promoted" | "stopped" | "revoked";

const STATUS_WORD: Record<ProposalState["status"], string> = {
  verifying: "Verifying",
  ready: "Ready to promote",
  rejected: "Rejected",
  stale: "Verifying on the new main",
  promoted: "Promoted",
};

/** A live countdown to `until`; the ticker in `tick` keeps it current. */
function countdown(until: number, expired: string) {
  return h("span", { class: "countdown", "data-until": until, "data-expired": expired }, remaining(until - Date.now()));
}

/** Update every countdown on the page, and mark what expired. */
export function tick() {
  for (const el of document.querySelectorAll<HTMLElement>("[data-until]")) {
    const left = Number(el.dataset.until) - Date.now();
    el.textContent = left > 0 ? remaining(left) : el.dataset.expired!;
    el.closest("[data-expires]")?.classList.toggle("expired", left <= 0);
  }
}

function agentStatus(agent: AgentState, state: ProjectState): AgentStatus {
  if (state.policy?.authors.find((a) => a.id === agent.id)?.revokedAt) return "revoked";
  const last = agent.tasks.at(-1);
  if (!last) return "idle";
  if (last.status === "queued" || last.status === "working") return "working";
  if (last.status === "failed") return "stopped";
  const proposal = state.proposals.find((p) => p.id === last.proposalId);
  if (proposal?.status === "rejected") return "rejected";
  if (proposal?.status === "promoted") return "promoted";
  return "proposed";
}

const AGENT_WORD: Record<AgentStatus, string> = {
  idle: "Waiting",
  working: "Working",
  proposed: "Proposed",
  rejected: "Rejected",
  promoted: "Promoted",
  stopped: "Stopped",
  revoked: "Key revoked",
};

export class Stage {
  private readonly graph: HistoryGraph;
  private readonly actions: StageActions;
  /** The status each proposal had at the last render, to animate only what changed. */
  private shown = new Map<string, ProposalState["status"]>();
  private firstRender = true;
  fresh: FreshVerify | null = null;
  outside: Outside | null = null;
  verifying = false;
  mirroring = false;
  /** Push commands a person asked for, by laptop key id. */
  access = new Map<string, PushAccess>();

  /** Whether a passkey action runs; the buttons that start one stay disabled meanwhile. */
  private readonly busy: () => boolean;

  constructor(busy: () => boolean, actions: StageActions) {
    this.busy = busy;
    this.actions = actions;
    this.graph = new HistoryGraph((oid) => actions.openCommit(oid));
  }

  reset() {
    this.shown.clear();
    this.firstRender = true;
    this.fresh = null;
    this.outside = null;
  }

  render(state: ProjectState) {
    // Keep what the person opened, and where the focus was, across the redraw.
    const open = new Set([...document.querySelectorAll<HTMLDetailsElement>("#stage details[data-key][open]")].map((d) => d.dataset.key));
    const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.key;

    this.history(state);
    this.rules(state);
    this.agents(state);
    this.proposals(state);
    this.outsideStrip(state);

    for (const d of document.querySelectorAll<HTMLDetailsElement>("#stage details[data-key]")) if (open.has(d.dataset.key)) d.open = true;
    if (focusKey) document.querySelector<HTMLElement>(`#stage [data-key="${CSS.escape(focusKey)}"]`)?.focus();
    this.firstRender = false;
    tick();
  }

  private history(state: ProjectState) {
    const report = state.history;
    fill(byId("repo-meta"), 
      h("span", null, "Repository id ", state.repoId ? mono(short(state.repoId), state.repoId) : "not yet"),
      h("span", null, state.repo.host === "artifacts" ? "Stored in Cloudflare Artifacts" : "Stored in local Durable Objects"),
      report
        ? h("span", { class: report.ok ? "verdict-ok" : "verdict-fail" }, report.ok ? `${report.commits.length} of ${report.commits.length} commits verify` : report.summary)
        : null,
    );
    const head = byId("history").querySelector(".band-head")!;
    if (!head.querySelector(".legend")) head.append(legend());
    const releaseName = `v1.${(state.history?.tags.length ?? 0)}.0`;
    const field = h("input", { id: "release-name", value: releaseName, size: 8, "aria-label": "Release name", autocomplete: "off" });
    fill(
      byId("release-form"),
      state.policy
        ? [
            h("label", { for: "release-name", class: "small" }, "Release main as"),
            field,
            h("button", { type: "button", "data-key": "release", "data-passkey": "on", disabled: this.busy(), onclick: () => this.actions.release(field.value.trim()) }, "Release with passkey"),
          ]
        : [],
    );
    fill(byId("graph"), 
      state.repoId
        ? [
            this.graph.render(state),
            ...(state.policy
              ? []
              : [h("button", { class: "primary seal-button", type: "button", "data-action": "incept", "data-key": "incept", "data-passkey": "on", disabled: this.busy() }, "Approve the first policy")]),
          ]
        : h(
            "div",
            { class: "empty" },
            h("p", null, "The first commit appears here once your passkey approves it."),
            h("button", { class: "primary seal-button", type: "button", "data-action": "incept", "data-key": "incept", "data-passkey": "on", disabled: this.busy() }, "Approve the first commit"),
          ),
    );
  }

  private rules(state: ProjectState) {
    const policy = state.policy;
    const policyCommit = [...(state.history?.commits ?? [])].reverse().find((c) => c.action === "policy" || c.action === "incept");
    fill(byId("rules-body"), 
      ...(policy
        ? [
            h(
              "p",
              { class: "muted small" },
              "From ",
              h("code", null, "policy.json"),
              " on main. ",
              policyCommit
                ? h("button", { class: "link link-hash", type: "button", "data-key": "policy-commit", onclick: () => this.actions.openCommit(policyCommit.oid) }, `Set by ${short(policyCommit.oid)}`)
                : null,
            ),
            h("h3", null, "May approve changes to main and to these rules"),
            h(
              "ul",
              { class: "keys" },
              policy.promoters.map((p) =>
                h(
                  "li",
                  { class: "key key-promoter" },
                  p.kind === "webauthn" ? seal({ size: 34, detail: "badge", label: "" }) : h("span", { class: "swatch" }),
                  h("div", null, h("strong", null, p.id), h("span", { class: "muted" }, p.kind === "webauthn" ? ` passkey ${p.label ?? ""}` : " SSH key")),
                ),
              ),
            ),
            h("h3", null, "May sign work in their own forks"),
            policy.authors.length === 0
              ? h("p", { class: "empty" }, "No author keys yet. Admitting an agent adds one, for an hour.")
              : h(
                  "ul",
                  { class: "keys" },
                  policy.authors.map((a) => {
                    const name = state.agents.find((x) => x.id === a.id)?.name ?? a.id;
                    return h(
                      "li",
                      { class: ["key", "key-author", laneClass(a.id), a.revokedAt && "revoked"], ...(a.revokedAt ? {} : { "data-expires": "" }) },
                      h("span", { class: "swatch", "aria-hidden": "true" }),
                      h(
                        "div",
                        null,
                        h("strong", null, name),
                        " ",
                        mono(shortFingerprint(a.fingerprint), a.fingerprint),
                        a.revokedAt
                          ? h("span", { class: "small block revoked-note" }, `Revoked at ${clock(Date.parse(a.revokedAt))}. Work it signed before then still counts.`)
                          : h("span", { class: "muted small block" }, `Admitted by ${a.controller}. Valid for `, countdown(Date.parse(a.validBefore), "no longer: expired")),
                      ),
                      a.revokedAt || Date.parse(a.validBefore) < Date.now()
                        ? null
                        : h(
                            "button",
                            { class: "revoke", type: "button", "data-key": `revoke-${a.id}`, "data-passkey": "on", disabled: this.busy(), "aria-label": `Revoke ${name}'s key`, onclick: () => this.actions.revoke(a.id) },
                            "Revoke",
                          ),
                    );
                  }),
                ),
          ]
        : [h("p", { class: "empty" }, "The rules appear once the first commit exists.")]),
    );
  }

  /** A person's laptop key: its fork, and the git commands that push signed work there. */
  private personCard(person: AgentState, state: ProjectState) {
    const access = this.access.get(person.id);
    const revoked = Boolean(state.policy?.authors.find((a) => a.id === person.id)?.revokedAt);
    return h(
      "article",
      { class: ["agent", "agent-person", "lane-other"], "aria-labelledby": `agent-${person.id}` },
      h("header", null, h("h3", { id: `agent-${person.id}` }, person.name), h("span", { class: ["pill", revoked ? "pill-revoked" : "pill-idle"] }, revoked ? "Key revoked" : "Works with git")),
      h(
        "p",
        { class: "agent-meta small" },
        h("span", null, "Key ", mono(shortFingerprint(person.fingerprint), person.fingerprint)),
        h("span", null, "Fork ", h("code", null, person.fork)),
        h("span", { "data-expires": "" }, "Valid for ", countdown(Date.parse(person.validBefore), "no longer")),
      ),
      h("p", { class: "small" }, "Sign each commit with this key and push a branch to the fork. The push arrives here as a proposal and is checked like an agent's."),
      revoked ? null : h("button", { type: "button", "data-key": `push-${person.id}`, "data-passkey": "on", disabled: this.busy(), onclick: () => this.actions.pushAccess(person.id) }, access ? "New push commands" : "Get push commands"),
      access
        ? h(
            "div",
            { class: "commands" },
            h(
              "p",
              { class: "muted small" },
              `The token works for an hour and only for ${access.fork}. `,
              access.pushEvents ? "The forge hears the push by itself." : "This forge does not subscribe to push events by itself: run scripts/subscribe-pushes.ts for the fork first.",
            ),
            access.commands.map((c) =>
              h("div", { class: "command" }, h("pre", { class: "code", tabindex: 0 }, c), h("button", { type: "button", class: "copy", onclick: () => void navigator.clipboard.writeText(c) }, "Copy")),
            ),
          )
        : null,
    );
  }

  /** The form that admits a person's own SSH key, shown until one is admitted. */
  private personForm(state: ProjectState) {
    if (!state.repoId || state.agents.some((a) => a.kind === "person")) return null;
    const field = h("textarea", { id: "laptop-key", rows: 2, spellcheck: "false", placeholder: "ssh-ed25519 AAAA… you@laptop" });
    return h(
      "details",
      { class: "laptop", "data-key": "laptop" },
      h("summary", null, "Work from your laptop too"),
      h("p", { class: "small" }, "People work the same way as agents: a key of their own, a fork of their own, and every commit checked. Paste the public half of an Ed25519 SSH key."),
      h("label", { for: "laptop-key", class: "small" }, "SSH public key"),
      field,
      h("button", { class: "primary seal-button", type: "button", "data-passkey": "on", disabled: this.busy(), onclick: () => this.actions.admitPerson(field.value) }, "Admit my key with passkey"),
    );
  }

  private agents(state: ProjectState) {
    const body = byId("agents-body");
    if (state.agents.length === 0) {
      fill(body, 
        h("p", { class: "empty" }, "Agents you admit work here at the same time, each in its own fork and with its own key."),
        state.repoId ? h("button", { class: "primary", type: "button", "data-key": "admit", "data-passkey": "on", disabled: this.busy(), onclick: () => this.actions.admit() }, "Admit Ada and Bo") : null,
      );
      return;
    }
    fill(
      body,
      ...state.agents.map((agent) => {
        if (agent.kind === "person") return this.personCard(agent, state);
        const status = agentStatus(agent, state);
        const rogueStarted = agent.tasks.some((t) => t.rogue);
        const canTempt = status !== "revoked" && agent.id === "bo" && !rogueStarted && agent.tasks.length > 0 && agent.tasks.every((t) => t.status === "proposed");
        const lastEvent = agent.tasks.flatMap((t) => t.events).at(-1);
        return h(
          "article",
          { class: ["agent", laneClass(agent.id), `agent-${status}`], "aria-labelledby": `agent-${agent.id}` },
          h(
            "header",
            null,
            h("h3", { id: `agent-${agent.id}` }, agent.name),
            h("span", { class: ["pill", `pill-${status}`] }, AGENT_WORD[status]),
          ),
          h(
            "p",
            { class: "agent-meta small" },
            h("span", null, "Key ", mono(shortFingerprint(agent.fingerprint), agent.fingerprint)),
            h("span", null, "Fork ", h("code", null, agent.fork)),
            agent.tokenExpiresAt ? h("span", { "data-expires": "" }, "Fork token valid for ", countdown(agent.tokenExpiresAt, "no longer")) : null,
          ),
          agent.tasks.map((task) =>
            h(
              "section",
              { class: ["task", task.rogue && "task-rogue"] },
              h("h4", null, task.title),
              h(
                "ol",
                { class: "transcript" },
                task.events.map((e) =>
                  h("li", { class: e === lastEvent && status === "working" ? "current" : null }, h("time", null, clock(e.at)), " ", e.text),
                ),
              ),
            ),
          ),
          h(
            "div",
            { class: "agent-actions" },
            status !== "revoked" && status !== "working" && agent.tasks.length > 0 && !agent.tasks.some((t) => t.id === "readme-title" && t.status !== "failed")
              ? h("button", { type: "button", "data-key": `retitle-${agent.id}`, onclick: () => this.actions.give(agent.id, "readme-title") }, `Ask ${agent.name} to retitle the README`)
              : null,
            state.llm && status !== "revoked" && status !== "working" && agent.tasks.length > 0
              ? (() => {
                  const topic = h("input", { id: `topic-${agent.id}`, placeholder: "a topic, such as key rotation", "aria-label": `Topic for ${agent.name}'s note`, autocomplete: "off" });
                  return h(
                    "div",
                    { class: "llm-task" },
                    topic,
                    h("button", { type: "button", "data-key": `llm-${agent.id}`, onclick: () => this.actions.give(agent.id, "llm-note", topic.value) }, `Ask ${agent.name} to write a note with Claude`),
                  );
                })()
              : null,
            canTempt
              ? h(
                  "button",
                  { class: "tempt", type: "button", "data-key": `tempt-${agent.id}`, onclick: () => this.actions.tempt(agent.id) },
                  `Ask ${agent.name} to make its own key a promoter`,
                )
              : null,
          ),
        );
      }),
      this.personForm(state),
    );
  }

  private proposals(state: ProjectState) {
    const body = byId("proposals-body");
    if (state.proposals.length === 0) {
      fill(body, h("p", { class: "empty" }, "Each agent's signed work arrives here, already checked against the rules in the repository."));
      return;
    }
    const animate = !this.firstRender && !reducedMotion();
    // Newest first, but the ones to act on stay at the top.
    const order = (p: ProposalState) => (p.status === "ready" || p.status === "stale" ? 0 : p.status === "rejected" ? 1 : p.status === "verifying" ? 0 : 2);
    const list = [...state.proposals].sort((a, b) => order(a) - order(b) || (order(a) === 0 ? a.createdAt - b.createdAt : b.createdAt - a.createdAt));
    fill(body, 
      ...list.map((p) => {
        const agent = state.agents.find((a) => a.id === p.agentId);
        const changed = this.shown.get(p.id) !== p.status;
        this.shown.set(p.id, p.status);
        const report = p.report;
        const failing = report?.commits.flatMap((c) => c.rules).find((r) => !r.ok) ?? (report && !report.merge.ok ? report.merge : null);
        // One chip per rule, in rule order; a rule that fails on any commit shows as failed.
        const byRule = new Map<string, { rule: string; ok: boolean; reason: string }>();
        for (const r of report ? [...report.commits.flatMap((c) => c.rules), report.merge] : []) {
          const seen = byRule.get(r.rule);
          if (!seen || (seen.ok && !r.ok)) byRule.set(r.rule, r);
        }
        const rank = (rule: string) => (rule === "M" ? "Z" : rule);
        const rules = [...byRule.values()].sort((a, b) => rank(a.rule).localeCompare(rank(b.rule)));
        const tickIn = animate && changed && (p.status === "ready" || p.status === "rejected");
        const chips = h(
          "ul",
          { class: "chips", "aria-label": "Rules" },
          rules.map((r, i) => {
            const chip = h("li", { class: [r.ok ? "chip-ok" : "chip-fail", tickIn && "tick-in"], title: r.reason }, r.ok ? "✓ " : "✗ ", r.rule);
            if (tickIn) chip.style.animationDelay = `${i * 120}ms`;
            return chip;
          }),
        );
        return h(
          "article",
          { class: ["proposal", `proposal-${p.status}`, laneClass(p.agentId)], "aria-labelledby": `proposal-${p.id}` },
          h(
            "header",
            null,
            h("h3", { id: `proposal-${p.id}` }, p.title),
            h("span", { class: ["state", `state-${p.status}`] }, STATUS_WORD[p.status]),
          ),
          h(
            "p",
            { class: "small muted" },
            `${agent?.name ?? p.agentId}, from `,
            h("code", null, p.branch),
            " at ",
            h("button", { class: "link link-hash", type: "button", "data-key": `head-${p.id}`, onclick: () => this.actions.openCommit(p.head) }, short(p.head)),
          ),
          failing && p.status === "rejected"
            ? h("p", { class: ["reason", animate && changed && "shake"] }, h("b", null, failing.rule), " ", failing.reason)
            : report && p.status !== "promoted"
              ? h("p", { class: "reason-ok small" }, report.summary)
              : null,
          report ? chips : null,
          h(
            "details",
            { class: "why", "data-key": `why-${p.id}` },
            h("summary", null, p.status === "rejected" ? "Why?" : "Rules and changes"),
            report ? report.commits.map((c) => h("div", { class: "why-commit" }, h("p", { class: "small" }, mono(short(c.oid), c.oid), " ", c.subject), ruleList(c.rules))) : null,
            report ? ruleList([report.merge]) : null,
            p.changes.length ? h("div", { class: "why-files" }, h("h4", null, plural(p.changes.length, "file"), " would change in main"), p.changes.map((f) => fileDiff(f, f.path.endsWith("policy.json")))) : null,
          ),
          p.status === "rejected" && report && !report.merge.ok && report.commits.every((c) => c.ok)
            ? p.redoneAt
              ? h("p", { class: "small muted" }, `${agent?.name ?? "The agent"} is redoing it on the new main.`)
              : h("button", { type: "button", "data-key": `redo-${p.id}`, onclick: () => this.actions.redo(p.id) }, "Redo on the new main")
            : p.status === "ready" || p.status === "stale"
            ? h("button", { class: "primary seal-button", type: "button", "data-key": `promote-${p.id}`, "data-passkey": "on", disabled: this.busy(), onclick: () => this.actions.promote(p.id) }, "Promote with passkey")
            : p.status === "promoted" && p.promotedAs
              ? h("p", { class: "small" }, "Promoted as ", h("button", { class: "link link-hash", type: "button", onclick: () => this.actions.openCommit(p.promotedAs!) }, short(p.promotedAs)), ".")
              : null,
        );
      }),
    );
  }

  private mirrorPart(state: ProjectState) {
    const m = state.mirror;
    if (!m.available) return h("p", { class: "muted small mirror" }, "A GitHub mirror is not set up on this forge. The commands below check a clone anywhere.");
    const button = h(
      "button",
      {
        type: "button",
        "data-key": "mirror",
        "data-passkey": this.mirroring || !state.repoId ? "off" : "on",
        disabled: this.busy() || this.mirroring || !state.repoId,
        onclick: () => this.actions.mirror(),
      },
      this.mirroring ? "Pushing to GitHub…" : m.last ? "Mirror to GitHub again" : "Mirror to GitHub",
    );
    return h(
      "div",
      { class: "mirror" },
      button,
      m.last
        ? h(
            "p",
            { class: "small" },
            `Main at `,
            mono(short(m.last.head), m.last.head),
            ` is on ${m.target}, mirrored at ${clock(m.last.at)}. `,
            m.checksUrl ? h("a", { href: m.checksUrl, target: "_blank", rel: "noopener" }, "See its checks") : null,
            m.last.head !== state.mainHead ? h("span", { class: "verdict-fail" }, " Main has moved since; mirror it again.") : null,
          )
        : h("p", { class: "muted small" }, `The mirror is ${m.target}. Its workflow fetches the pinned verifier and checks every commit there.`),
    );
  }

  private outsideStrip(state: ProjectState) {
    const fresh = this.fresh ?? state.freshVerify;
    const verify = h(
      "button",
      { class: "primary", type: "button", "data-key": "verify", disabled: this.verifying || !state.repoId, onclick: () => this.actions.verify() },
      this.verifying ? "Cloning and verifying…" : "Verify from a fresh clone",
    );
    const commands = h("button", { type: "button", "data-key": "commands", disabled: !state.repoId, onclick: () => this.actions.commands() }, "Show the commands");
    fill(byId("outside-body"), 
      h("div", { class: "outside-actions" }, verify, commands),
      fresh
        ? h(
            "div",
            { class: "fresh" },
            h("p", { class: fresh.report.ok ? "verdict-ok" : "verdict-fail" }, fresh.report.summary),
            h("p", { class: "muted small" }, `Cloned from nothing at ${clock(fresh.at)}, with the repository id pinned to `, mono(short(fresh.report.repoId ?? ""), fresh.report.repoId ?? ""), "."),
            h(
              "ol",
              { class: "fresh-list" },
              fresh.report.commits.map((c) =>
                h("li", { class: [c.ok ? "rule-ok" : "rule-fail", c.role === "merged" && "merged"] }, h("span", { class: "rule-mark", "aria-hidden": "true" }, c.ok ? "✓" : "✗"), mono(short(c.oid), c.oid), " ", c.subject),
              ),
            ),
          )
        : null,
      this.mirrorPart(state),
      this.outside
        ? h(
            "div",
            { class: "commands" },
            h("p", { class: "muted small" }, "The token is read only and works for an hour. The verifier is one file, checked against the digest the repository pins; it needs Node 22 or later."),
            this.outside.commands.map((c) =>
              h(
                "div",
                { class: "command" },
                h("pre", { class: "code", tabindex: 0 }, c),
                h("button", { type: "button", class: "copy", onclick: () => void navigator.clipboard.writeText(c) }, "Copy"),
              ),
            ),
          )
        : null,
    );
  }
}
