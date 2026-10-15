// The forge page. It uses the demo's sign-in, codes and settings panes
// (panes.ts). Signed out, the page tells what the forge does. Signed in, it
// starts a project or shows one on the stage. The stage shows the history, the
// rules, the agents and their proposals, and the check outside the forge. Each
// approval uses the approval sheet. That sheet shows the exact change
// before the passkey signs it. esbuild bundles this file into public/app.js;
// see `build:browser` in package.json.

import { DemoClient } from "../../demo/browser/demo-client.ts";
import { status } from "../../demo/browser/dom.ts";
import { Flows } from "../../demo/browser/flows.ts";
import { showApp } from "../../demo/browser/shell.ts";
import { ForgeClient, type ForgeMe, type Outcome } from "./forge-client.ts";
import { ask } from "./ask.ts";
import { copy } from "./copy.ts";
import { byId, fill, h, reducedMotion } from "./h.ts";
import { lend } from "./lend.ts";
import { wirePanes } from "./panes.ts";
import { ForgePasskeys } from "./passkeys.ts";
import { seal } from "./seal.ts";
import { ApprovalSheet, CommitSheet } from "./sheets.ts";
import { Stage, tick } from "./stage.ts";
import { Story } from "./story.ts";
import type { ProjectState } from "./view-types.ts";

const passkeys = new ForgePasskeys(lend);
const target = { origin: location.origin, fetch: (request: Request) => fetch(request) };
const demoClient = new DemoClient(target, passkeys);
const flows = new Flows(demoClient, location.hostname, passkeys.autofillRequests);
const forge = new ForgeClient(target, demoClient, passkeys);

function guard<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  return (...args: A) =>
    void fn(...args).catch((error) => {
      console.error(error);
      say("Something went wrong. Reload the page and try again.");
    });
}

let passkeyActionRunning = false;

/**
 * Show if a passkey action runs. Each button that starts a passkey action is
 * disabled until the action ends, so the page never ignores a press without a
 * sign. This is also true for the network requests that an action can send
 * after its sheet closes.
 */
function setBusy(busy: boolean) {
  passkeyActionRunning = busy;
  document.body.toggleAttribute("data-busy", busy);
  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-passkey]")) {
    button.disabled = busy || button.dataset.passkey === "off";
  }
}

/** Run one passkey action at a time, as the demo page does. */
function passkeyAction<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  return guard(async (...args: A) => {
    if (passkeyActionRunning) return;
    setBusy(true);
    try {
      await fn(...args);
    } finally {
      setBusy(false);
    }
  });
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** Show `message` in the toast for 6 seconds. When a pane is open, `status` writes it in that pane. */
function say(message: string) {
  status(message);
  const toast = byId("status");
  toast.classList.toggle("toast-shown", message !== "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("toast-shown"), 6000);
}

const reason = <T>(o: Outcome<T>) => (o.result === "refused" ? o.refusal.reason : o.result === "cancelled" ? "Cancelled." : "");

// --- state ------------------------------------------------------------------------

let me: ForgeMe | null = null;
let current: ProjectState | null = null;
let source: EventSource | undefined;
const listeners = new Set<(s: ProjectState) => void>();

const approvals = new ApprovalSheet(forge);
const commits = new CommitSheet(forge);
const stage = new Stage(() => passkeyActionRunning, {
  admit: passkeyAction(() => admit()),
  tempt: guard((agentId: string) => tempt(agentId)),
  revoke: passkeyAction((agentId: string) => revoke(agentId)),
  give: guard(async (agentId: string, task: string, topic?: string) => {
    const id = shownId();
    if (!id) return;
    const given = await forge.give(id, agentId, task, topic);
    if (given.result !== "ok") say(reason(given));
  }),
  admitPerson: passkeyAction(async (publicKey: string) => {
    const id = shownId();
    if (!id) return;
    const state = await approvals.run(() => forge.preparePerson(id, publicKey.trim()));
    if (state) received(state);
  }),
  pushAccess: passkeyAction(async (personId: string) => {
    const id = shownId();
    if (!id) return;
    const got = await forge.pushAccess(id, personId);
    if (got.result !== "ok") return say(reason(got));
    stage.access.set(personId, got.value);
    if (current) stage.render(current);
  }),
  release: passkeyAction(async (name: string) => {
    const id = shownId();
    if (!id) return;
    const state = await approvals.run(() => forge.prepareRelease(id, name));
    if (!state) return;
    // This name is now in use, so reset the field to its default value. The next render then shows the next name.
    const field = document.getElementById("release-name");
    if (field instanceof HTMLInputElement) field.value = field.defaultValue;
    received(state);
  }),
  redo: guard(async (proposalId: string) => {
    const id = shownId();
    if (!id) return;
    const redone = await forge.redo(id, proposalId);
    say(redone.result === "ok" ? "The agent starts again from the new main." : reason(redone));
  }),
  promote: passkeyAction((proposalId: string) => promote(proposalId)),
  openCommit: guard(async (oid: string) => {
    if (current) await commits.open(current.id, oid, current.repoId, (id) => current?.agents.find((a) => a.id === id)?.name ?? null);
  }),
  verify: guard(() => verify()),
  commands: guard(() => commands()),
  mirror: passkeyAction(() => mirror()),
});

function projectIdFromHash(): string | null {
  return /^#\/p\/([0-9a-f-]{36})$/.exec(location.hash)?.[1] ?? null;
}

function received(state: ProjectState) {
  if (projectIdFromHash() !== state.id) return;
  current = state;
  byId("stage").hidden = false;
  stage.render(state);
  for (const listener of [...listeners]) listener(state);
}

async function reload() {
  const id = projectIdFromHash();
  if (!id) return;
  const got = await forge.state(id);
  if (got.result === "ok") received(got.value);
}

// --- views ------------------------------------------------------------------------

/** Show the promoter key in the account menu, and its seal on the account button. Without one, show a warning mark. */
function promoterBadge() {
  const promoter = me?.promoter;
  byId("account-button").classList.toggle("badge-missing", !promoter);
  fill(byId("promoter-badge-seal"), promoter ? seal({ size: 24, label: "" }) : h("span", { class: "badge-warn" }, "!"));
  byId("promoter-key-name").textContent = promoter ? (promoter.label ?? promoter.credentialId.slice(0, 10)) : "none yet";
  byId("promoter-badge").textContent = promoter ? "Copy its public key" : "Make a new passkey my promoter key";
}

function startView() {
  const promoter = me?.promoter;
  fill(byId("promoter-state"), 
    promoter
      ? h(
          "div",
          { class: "promoter-ready" },
          seal({ size: 64, label: "" }),
          h(
            "p",
            null,
            "Your passkey ",
            h("strong", null, promoter.label ?? promoter.credentialId.slice(0, 10)),
            " is your promoter key. New projects trust it, and nothing else, to approve changes to main.",
            " ",
            h("button", { class: "link", type: "button", onclick: passkeyAction(newPromoterKey) }, "Use a new passkey instead"),
          ),
        )
      : h(
          "div",
          { class: "notice" },
          h("p", null, "You have no promoter key on this site yet. A promoter key is a passkey that approves changes to main."),
          h("button", { class: "primary", type: "button", onclick: passkeyAction(newPromoterKey) }, "Make a new passkey my promoter key"),
        ),
  );
  byId("create-project").dataset.passkey = promoter ? "on" : "off";
  (byId("create-project") as HTMLButtonElement).disabled = !promoter || passkeyActionRunning;
  const projects = me?.projects ?? [];
  fill(byId("project-list"), 
    ...(projects.length
      ? [
          h("h2", null, "Your projects"),
          h("ul", { class: "project-list" }, projects.map((p) => h("li", null, h("a", { href: `#/p/${p.id}` }, p.name), h("span", { class: "muted small" }, ` created ${new Date(p.createdAt).toLocaleString()}`)))),
        ]
      : []),
  );
}

function projectSwitch() {
  const select = byId<HTMLSelectElement>("project-select");
  const id = projectIdFromHash();
  select.replaceChildren(
    h("option", { value: "" }, "New project…"),
    ...(me?.projects ?? []).map((p) => h("option", { value: p.id, selected: p.id === id }, p.name)),
  );
  byId("project-switch").hidden = !me || (me.projects.length === 0 && !id);
}

/**
 * Show the view that the address names: a project, or the start view. The
 * address can change after the project is already on the page. For example, a
 * new project sets the address after its approval. Thus a project that the
 * page already shows stays. The stage of another project stays hidden until
 * its state arrives, so that the page shows no button that cannot operate.
 */
function route() {
  const id = projectIdFromHash();
  source?.close();
  source = undefined;
  if (current?.id !== id) {
    current = null;
    stage.reset();
    // A story that ended, or that waits for an approval, belongs to its project. Close its ribbon here.
    if (!story.isPlaying) story.stop();
  }
  byId("start").hidden = Boolean(id);
  byId("stage").hidden = !current;
  byId("play-story").hidden = !id;
  projectSwitch();
  if (!me) return;
  if (!id) {
    startView();
    return;
  }
  void reload();
  const s = new EventSource(`/forge/projects/${id}/stream`);
  s.addEventListener("state", (event) => received(JSON.parse((event as MessageEvent<string>).data) as ProjectState));
  source = s;
}

async function refresh() {
  me = await forge.me();
  showApp(me ? { recordId: me.recordId, memberName: me.memberName, operator: false } : null);
  // Signed in, the signed-out actions are hidden and use no space in the app bar. Thus the account button stays at its right edge.
  byId("signed-out-actions").hidden = me !== null;
  byId("open-register").hidden = me !== null;
  promoterBadge();
  route();
}

// --- actions ------------------------------------------------------------------------

/** After the page makes a passkey, make it the promoter key if there is no promoter key. With `replace`, always do it. */
async function passkeyMade(replace = false) {
  const created = passkeys.takeCreated();
  if (!created || (me?.promoter && !replace)) return;
  const set = await forge.setPromoterKey(created);
  say(set.result === "ok" ? `Your passkey ${set.value.label ?? ""} is now your promoter key.` : reason(set));
}

async function newPromoterKey() {
  const added = await flows.addPasskey("client-device");
  if (added.declined) return say(added.message);
  await passkeyMade(true);
  await refresh();
}

function open(projectId: string) {
  if (projectIdFromHash() === projectId) route();
  else location.hash = `#/p/${projectId}`;
}

async function createProject(name: string): Promise<boolean> {
  let projectId: string | null = null;
  const state = await approvals.run(async () => {
    const prepared = await forge.prepareProject(name);
    if (prepared.result === "ok") projectId = prepared.value.projectId;
    return prepared;
  });
  me = await forge.me();
  if (projectId) open(projectId);
  if (state) received(state);
  // The passkey signed the inception commit. Now `incept` does the second step, which sets the first policy.
  if (state && !state.policy) return incept();
  return Boolean(state);
}

/** The project that the page shows: the one that the address names, also while its state is not here yet. */
const shownId = () => current?.id ?? projectIdFromHash();

/** Do the inception in two passkey steps. First, sign the empty inception commit. Then, approve the first policy. */
async function incept(): Promise<boolean> {
  const id = shownId();
  if (!id) return false;
  for (let step = 0; step < 2; step++) {
    const state = await approvals.run(() => forge.prepareInception(id));
    if (!state) return false;
    received(state);
    if (state.policy) return true;
  }
  return false;
}

async function admit(): Promise<boolean> {
  const id = shownId();
  if (!id) return false;
  const state = await approvals.run(() => forge.prepareAgents(id, ["Ada", "Bo"]));
  if (state) received(state);
  return Boolean(state);
}

async function tempt(agentId: string) {
  const id = shownId();
  if (!id) return;
  const tempted = await forge.tempt(id, agentId);
  if (tempted.result !== "ok") say(reason(tempted));
}

async function revoke(agentId: string): Promise<boolean> {
  const id = shownId();
  if (!id) return false;
  const state = await approvals.run(() => forge.prepareRevocation(id, agentId));
  if (state) received(state);
  return Boolean(state);
}

async function promote(proposalId: string): Promise<boolean> {
  const id = shownId();
  if (!id) return false;
  const state = await approvals.run(() => forge.preparePromotion(id, proposalId));
  if (state) received(state);
  return Boolean(state);
}

async function verify() {
  if (!current) return;
  stage.verifying = true;
  stage.render(current);
  const verified = await forge.verifyFresh(current.id);
  stage.verifying = false;
  if (verified.result === "ok") stage.fresh = verified.value;
  else say(reason(verified));
  if (current) stage.render(current);
}

async function mirror() {
  if (!current) return;
  stage.mirroring = true;
  stage.render(current);
  const mirrored = await forge.mirror(current.id);
  stage.mirroring = false;
  say(mirrored.result === "ok" ? `Mirrored main to ${mirrored.value.target}.` : reason(mirrored));
  await reload();
}

async function commands() {
  if (!current) return;
  const got = await forge.outside(current.id);
  if (got.result !== "ok") return say(reason(got));
  stage.outside = got.value;
  stage.render(current);
}

/** Wait until `ready` is true for the state of the shown project, or until `signal` aborts. */
function waitFor(ready: (s: ProjectState) => boolean, signal: AbortSignal): Promise<ProjectState> {
  if (current && ready(current)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const listener = (s: ProjectState) => {
      if (!ready(s)) return;
      listeners.delete(listener);
      signal.removeEventListener("abort", abort);
      resolve(s);
    };
    const abort = () => {
      listeners.delete(listener);
      reject(signal.reason);
    };
    if (signal.aborted) return abort();
    listeners.add(listener);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Whether the element is rendered. Safari before 17.4 has no checkVisibility, so it falls back to the element's boxes. */
function visible(element: HTMLElement): boolean {
  return typeof element.checkVisibility === "function" ? element.checkVisibility() : element.getClientRects().length > 0;
}

/**
 * Scroll to a part of the page, open it, and put an outline on it for a short
 * time. Then move the focus to its region, so that the keyboard continues from
 * there. When the person types in a field, the focus stays in that field.
 */
function spotlight(selector: string) {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element || !visible(element)) return;
  if (element instanceof HTMLDetailsElement) element.open = true;
  // The story ribbon stays at the top of the window. Add a scroll margin, so that the ribbon does not cover the part.
  const ribbon = byId("story");
  element.style.scrollMarginTop = ribbon.hidden ? "" : `${ribbon.offsetHeight + 24}px`;
  const tall = element.offsetHeight > innerHeight / 2;
  element.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: tall ? "start" : "center" });
  element.classList.add("spotlight");
  setTimeout(() => element.classList.remove("spotlight"), 2600);
  const typing = document.activeElement?.matches("input, textarea, select, [contenteditable]");
  const region = element.closest<HTMLElement>("#history, .region, #outside");
  if (region && !typing) region.focus({ preventScroll: true });
}

const story = new Story({
  state: () => current,
  shown: projectIdFromHash,
  open: (projectId) => {
    if (projectId) open(projectId);
    else location.hash = "";
  },
  away: () => document.hidden || document.querySelector("dialog[open]") !== null,
  waitFor,
  createProject: () => createProject((byId<HTMLInputElement>("project-name").value || "gordian-notes").trim()),
  admit: () => (current?.repoId ? admit() : incept()),
  tempt,
  promote,
  verify,
  commands,
  spotlight,
});

// --- events ------------------------------------------------------------------------

const panes = wirePanes({
  flows,
  passkeyAction,
  guard,
  refresh,
  passkeyMade: () => passkeyMade(),
  signedOut: async () => {
    story.stop();
    location.hash = "";
    await refresh();
  },
});

fill(byId("hero-seal"), seal({ size: 380, ring: "approved by a person ✦ checked on any clone ✦ agents may only write ✦ ", label: "" }));
byId("hero-sign-in").addEventListener("click", panes.signIn);
byId("hero-register").addEventListener("click", panes.openRegister);
// Signed in, the wordmark shows the start view without a reload. Thus a story that plays does not stop.
document.querySelector(".wordmark")!.addEventListener("click", (event) => {
  if (!me) return;
  event.preventDefault();
  location.hash = "";
});
byId("create-form").addEventListener(
  "submit",
  passkeyAction(async (event: Event) => {
    event.preventDefault();
    await createProject(String(new FormData(event.target as HTMLFormElement).get("name")).trim());
  }),
);
byId("project-select").addEventListener("change", (event) => {
  const id = (event.target as HTMLSelectElement).value;
  location.hash = id ? `#/p/${id}` : "";
});
byId("promoter-badge").addEventListener(
  "click",
  passkeyAction(async () => {
    if (!me?.promoter) {
      byId("account-menu").hidePopover();
      return newPromoterKey();
    }
    await copy(byId<HTMLButtonElement>("promoter-badge"), JSON.stringify(me.promoter.publicKey));
  }),
);
const playStory = guard(async () => {
  if (story.isPlaying) return;
  await story.play();
});
byId("play-story").addEventListener("click", playStory);
byId("start-story").addEventListener("click", playStory);
byId("reset").addEventListener(
  "click",
  passkeyAction(async () => {
    if (!current) return;
    const deleting = await ask({
      title: `Delete ${current.name}?`,
      message: "Its repositories, its forks and its agents go too. This cannot be undone.",
      confirm: "Delete the project",
      danger: true,
    });
    if (!deleting || !current) return;
    const done = await forge.reset(current.id);
    if (done.result !== "ok") return say(reason(done));
    story.stop();
    say("The project is deleted.");
    location.hash = "";
    await refresh();
  }),
);
// A project without its inception commit or its first policy shows an approval button in the history band.
byId("graph").addEventListener("click", (event) => {
  if ((event.target as HTMLElement).closest("[data-action=incept]")) passkeyAction(incept)();
});
addEventListener("hashchange", () => route());
setInterval(tick, 1000);
guard(refresh)();

