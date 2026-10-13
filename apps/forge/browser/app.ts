// The forge page. The demo's panes handle sign-in and settings (panes.ts).
// Signed out, the page explains the forge. Signed in, it starts a project or
// shows one on the stage: its history, its rules, its agents and their
// proposals, and the check outside the forge. Approvals go through the
// approval sheet, which shows the exact change before the passkey signs it.
// Bundled into public/app.js by esbuild; see build.command in wrangler.jsonc.

import { DemoClient } from "../../demo/browser/demo-client.ts";
import { status } from "../../demo/browser/dom.ts";
import { Flows } from "../../demo/browser/flows.ts";
import { showApp } from "../../demo/browser/shell.ts";
import { ForgeClient, type ForgeMe, type Outcome } from "./forge-client.ts";
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
 * Show whether a passkey action runs: each button that starts one is
 * disabled until it ends. A press is then never dropped without a sign, and
 * an action that ends with network requests after its sheet closes does not
 * swallow the next press.
 */
function setBusy(busy: boolean) {
  passkeyActionRunning = busy;
  document.body.toggleAttribute("data-busy", busy);
  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-passkey]")) {
    button.disabled = busy || button.dataset.passkey === "off";
  }
}

/** One passkey action at a time, as on the demo page. */
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

/** A short message at the foot of the page, which goes after a while. */
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
    if (state) received(state);
  }),
  redo: guard(async (proposalId: string) => {
    const id = shownId();
    if (!id) return;
    const redone = await forge.redo(id, proposalId);
    say(redone.result === "ok" ? "The agent starts again from the new main." : reason(redone));
  }),
  promote: passkeyAction((proposalId: string) => promote(proposalId)),
  openCommit: guard(async (oid: string) => {
    if (current) await commits.open(current.id, oid, (id) => current?.agents.find((a) => a.id === id)?.name ?? null);
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

function promoterBadge() {
  const badge = byId("promoter-badge");
  const text = byId("promoter-badge-text");
  badge.classList.toggle("badge-missing", !me?.promoter);
  fill(byId("promoter-badge-seal"), me?.promoter ? seal({ size: 26, detail: "badge", label: "" }) : h("span", { class: "badge-warn" }, "!"));
  text.textContent = me?.promoter ? `Promoter key ${me.promoter.label ?? ""}` : "No promoter key";
  badge.title = me?.promoter ? "Copy the public key of your promoter passkey" : "Make a new passkey your promoter key";
}

function startView() {
  const promoter = me?.promoter;
  fill(byId("promoter-state"), 
    promoter
      ? h(
          "div",
          { class: "promoter-ready" },
          seal({ size: 64, detail: "badge", label: "" }),
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
 * Show the view the address names: a project, or the start. The address can
 * change after the project is already here (a new project sets it once its
 * approval is done), so a project already shown stays. Another project's
 * stage stays hidden until its state arrives, so no button shows that cannot act.
 */
function route() {
  const id = projectIdFromHash();
  source?.close();
  source = undefined;
  if (current?.id !== id) {
    current = null;
    stage.reset();
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
  promoterBadge();
  route();
}

// --- actions ------------------------------------------------------------------------

/** After a passkey is made here, make it the promoter key if there is none yet. */
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
  // The inception commit is signed; the second step sets the first policy.
  if (state && !state.policy) return incept();
  return Boolean(state);
}

/** The project the page shows: the one the address names, even while its state is on its way. */
const shownId = () => current?.id ?? projectIdFromHash();

/** The inception, in two passkey steps: sign the empty inception commit, then approve the first policy. */
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

function waitFor(ready: (s: ProjectState) => boolean, ms = 60_000): Promise<ProjectState> {
  if (current && ready(current)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      listeners.delete(listener);
      reject(new Error("this step took too long"));
    }, ms);
    const listener = (s: ProjectState) => {
      if (!ready(s)) return;
      clearTimeout(timer);
      listeners.delete(listener);
      resolve(s);
    };
    listeners.add(listener);
  });
}

function spotlight(selector: string) {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) return;
  if (element instanceof HTMLDetailsElement) element.open = true;
  element.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });
  element.classList.add("spotlight");
  setTimeout(() => element.classList.remove("spotlight"), 2600);
}

const story = new Story({
  state: () => current,
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
  isPasskeyActionRunning: () => passkeyActionRunning,
  refresh,
  passkeyMade: () => passkeyMade(),
  signedOut: async () => {
    story.stop();
    location.hash = "";
    await refresh();
  },
});

fill(byId("hero-seal"), 
  seal({ size: 380, ring: "approved by a person ✦ checked on any clone ✦ agents may only write ✦ ", center: "main", label: "" }),
);
byId("hero-sign-in").addEventListener("click", () => panes.openSignIn());
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
    if (!me?.promoter) return newPromoterKey();
    await navigator.clipboard.writeText(JSON.stringify(me.promoter.publicKey));
    say("Copied the public key of your promoter passkey.");
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
    if (!current || !confirm(`Delete ${current.name}, its repositories, its forks and its agents? This cannot be undone.`)) return;
    const done = await forge.reset(current.id);
    if (done.result !== "ok") return say(reason(done));
    story.stop();
    say("The project is deleted.");
    location.hash = "";
    await refresh();
  }),
);
// A project with no inception commit yet offers to approve it from the history band.
byId("graph").addEventListener("click", (event) => {
  if ((event.target as HTMLElement).closest("[data-action=incept]")) passkeyAction(incept)();
});
addEventListener("hashchange", () => route());
setInterval(tick, 1000);
guard(refresh)();

