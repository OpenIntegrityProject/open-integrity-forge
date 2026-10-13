// The history band: main and one lane per agent, oldest on the left. A
// commit on main with a passkey approval is a filled seal mark, an agent's
// signed commit is a ring in the agent's colour, and a commit the verifier
// rejects is a red cross. Each mark opens the commit sheet.

import type { ProjectState } from "../src/state.ts";
import { laneClass, short } from "./format.ts";
import { h, reducedMotion, svg } from "./h.ts";
import { seal } from "./seal.ts";

type Kind = "inception" | "approved" | "author" | "rejected";

interface Mark {
  oid: string;
  lane: string;
  kind: Kind;
  subject: string;
  parents: string[];
  at: number;
  seq: number;
}

const COL = 84;
const ROW = 58;
const LEFT = 108;
const TOP = 40;

const KIND_WORD: Record<Kind, string> = {
  inception: "Inception commit, signed by passkey",
  approved: "Commit on main, approved by passkey",
  author: "Signed commit",
  rejected: "Rejected commit",
};

/** The commits to draw: main and what it merged, then every proposed commit not yet on main. */
function marks(state: ProjectState): Mark[] {
  const out = new Map<string, Mark>();
  let seq = 0;
  const agentOf = (id: string | null | undefined) => (id && state.agents.some((a) => a.id === id) ? id : "other");
  for (const c of state.history?.commits ?? []) {
    const onMain = c.role === "inception" || c.role === "main";
    const kind: Kind = !c.ok ? "rejected" : c.role === "inception" ? "inception" : onMain ? "approved" : "author";
    out.set(c.oid, { oid: c.oid, lane: onMain ? "main" : agentOf(c.signer?.id), kind, subject: c.subject, parents: c.parents, at: c.at, seq: seq++ });
  }
  for (const p of state.proposals) {
    if (p.status === "promoted") continue;
    for (const c of p.report?.commits ?? []) {
      if (out.has(c.oid)) continue;
      out.set(c.oid, { oid: c.oid, lane: p.agentId, kind: c.ok ? "author" : "rejected", subject: c.subject, parents: c.parents, at: c.at, seq: seq++ });
    }
  }
  return [...out.values()];
}

/** Order the marks so each comes after its parents, and otherwise by time. */
function columns(list: Mark[]): Map<string, number> {
  const known = new Set(list.map((m) => m.oid));
  const waiting = new Map(list.map((m) => [m.oid, m.parents.filter((p) => known.has(p)).length]));
  const children = new Map<string, string[]>();
  for (const m of list) for (const p of m.parents) if (known.has(p)) children.set(p, [...(children.get(p) ?? []), m.oid]);
  const byOid = new Map(list.map((m) => [m.oid, m]));
  const ready = list.filter((m) => waiting.get(m.oid) === 0);
  const order = new Map<string, number>();
  while (ready.length > 0) {
    ready.sort((a, b) => a.at - b.at || a.seq - b.seq);
    const next = ready.shift()!;
    order.set(next.oid, order.size);
    for (const child of children.get(next.oid) ?? []) {
      const left = waiting.get(child)! - 1;
      waiting.set(child, left);
      if (left === 0) ready.push(byOid.get(child)!);
    }
  }
  return order;
}

/** The key to the marks, drawn with the same shapes. */
export function legend(): HTMLElement {
  const mark = (...children: SVGElement[]) => svg("svg", { width: 22, height: 22, viewBox: "-11 -11 22 22", "aria-hidden": "true" }, ...children);
  const item = (icon: SVGElement, text: string) => h("li", null, icon, text);
  return h(
    "ul",
    { class: "legend", "aria-label": "Key to the history" },
    item(mark(svg("circle", { r: 9, class: "mark-approved" }), svg("circle", { r: 4.5, class: "mark-approved-core" })), "Approved by a passkey"),
    item(mark(svg("circle", { r: 7, class: "mark-author lane-ada" })), "Signed by an agent's key"),
    item(mark(svg("circle", { r: 9, class: "mark-rejected" }), svg("path", { d: "M-4,-4L4,4M4,-4L-4,4", class: "mark-rejected-x" })), "Rejected by the rules"),
  );
}

export class HistoryGraph {
  private seen = new Set<string>();
  private first = true;
  private readonly open: (oid: string) => void;

  constructor(open: (oid: string) => void) {
    this.open = open;
  }

  render(state: ProjectState): SVGSVGElement {
    const list = marks(state);
    const col = columns(list);
    const lanes = ["main", ...state.agents.map((a) => a.id)];
    if (list.some((m) => m.lane === "other")) lanes.push("other");
    const row = (lane: string) => Math.max(0, lanes.indexOf(lane));
    const x = (oid: string) => LEFT + (col.get(oid) ?? 0) * COL;
    const y = (lane: string) => TOP + row(lane) * ROW;
    const width = LEFT + Math.max(1, col.size) * COL + 40;
    const height = TOP + lanes.length * ROW;
    const byOid = new Map(list.map((m) => [m.oid, m]));
    const animate = !this.first && !reducedMotion();

    const laneNames = lanes.map((lane) => {
      const name = lane === "main" ? "main" : lane === "other" ? "other" : (state.agents.find((a) => a.id === lane)?.name ?? lane);
      return svg(
        "g",
        { class: ["lane", laneClass(lane === "other" ? "x" : lane === "main" ? null : lane)] },
        svg("line", { x1: LEFT - 20, x2: width - 10, y1: y(lane), y2: y(lane), class: "lane-rule" }),
        svg("text", { x: 12, y: y(lane) + 4, class: "lane-name" }, name),
      );
    });

    const edges = [];
    for (const m of list) {
      for (const p of m.parents) {
        const parent = byOid.get(p);
        if (!parent) continue;
        const side = m.lane !== "main" ? m.lane : parent.lane;
        const [x1, y1, x2, y2] = [x(p), y(parent.lane), x(m.oid), y(m.lane)];
        const d = y1 === y2 ? `M${x1},${y1}L${x2},${y2}` : `M${x1},${y1}C${x1 + COL * 0.6},${y1} ${x2 - COL * 0.6},${y2} ${x2},${y2}`;
        edges.push(svg("path", { d, class: ["edge", laneClass(side === "main" ? null : side === "other" ? "x" : side)] }));
      }
    }

    const nodes = list.map((m) => {
      const cx = x(m.oid);
      const cy = y(m.lane);
      const fresh = animate && !this.seen.has(m.oid);
      const label = `${KIND_WORD[m.kind]} ${short(m.oid)}: ${m.subject}`;
      const mark =
        m.kind === "inception"
          ? (() => {
              const s = seal({ size: 38, detail: "badge", label: "" });
              s.setAttribute("x", String(cx - 19));
              s.setAttribute("y", String(cy - 19));
              s.removeAttribute("role");
              return s;
            })()
          : m.kind === "approved"
            ? [svg("circle", { cx, cy, r: 12, class: "mark-approved" }), svg("circle", { cx, cy, r: 6.5, class: "mark-approved-core" })]
            : m.kind === "author"
              ? svg("circle", { cx, cy, r: 9.5, class: "mark-author" })
              : [
                  svg("circle", { cx, cy, r: 12, class: "mark-rejected" }),
                  svg("path", { d: `M${cx - 5},${cy - 5}L${cx + 5},${cy + 5}M${cx + 5},${cy - 5}L${cx - 5},${cy + 5}`, class: "mark-rejected-x" }),
                ];
      return svg(
        "g",
        {
          class: ["node", laneClass(m.lane === "main" ? null : m.lane === "other" ? "x" : m.lane), fresh && "node-new"],
          tabindex: 0,
          role: "button",
          "aria-label": label,
          onclick: () => this.open(m.oid),
          onkeydown: (event: KeyboardEvent) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              this.open(m.oid);
            }
          },
        },
        svg("title", null, label),
        svg("circle", { cx, cy, r: 22, class: "node-hit" }),
        mark,
        svg("text", { x: cx, y: cy + 31, "text-anchor": "middle", class: "node-sha" }, short(m.oid)),
      );
    });

    // Each release is a label above the commit it names.
    const releases = (state.history?.tags ?? [])
      .filter((t) => byOid.has(t.target))
      .map((t) =>
        svg(
          "g",
          { class: ["release", !t.ok && "release-bad"] },
          svg("title", null, `${t.name}: ${t.rules.map((r) => r.reason).join(" ")}`),
          svg("text", { x: x(t.target), y: y(byOid.get(t.target)!.lane) - 17, "text-anchor": "middle", class: "release-name" }, `${t.ok ? "" : "✗ "}${t.name}`),
        ),
      );

    this.seen = new Set(list.map((m) => m.oid));
    this.first = false;
    return svg(
      "svg",
      { width, height, viewBox: `0 0 ${width} ${height}`, class: "graph", role: "group", "aria-label": "History of main and of each fork" },
      laneNames,
      edges,
      nodes,
      releases,
    );
  }
}
