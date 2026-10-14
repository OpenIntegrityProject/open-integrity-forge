// The story: the steps of the demo in order, with a caption for each step. It
// does the steps itself, and stops at each approval so that the person can
// read the change and use their passkey. The story holds at its next action in
// four conditions. These are a pause, another project on the page, an open
// pane or sheet, and a hidden tab. When the hold ends, the story shows its
// place again.

import type { ProjectState } from "./view-types.ts";
import { byId, fill, h } from "./h.ts";

interface StoryActions {
  state(): ProjectState | null;
  /** The id of the project the page shows, or null on the start view. */
  shown(): string | null;
  /** Show a project, or the start view for null. */
  open(projectId: string | null): void;
  /** True while the person cannot see the story. For example, a pane or a sheet is open, or the tab is hidden. */
  away(): boolean;
  /** Wait until `ready` is true for the project state, or until `signal` aborts. */
  waitFor(ready: (s: ProjectState) => boolean, signal: AbortSignal): Promise<ProjectState>;
  createProject(): Promise<boolean>;
  admit(): Promise<boolean>;
  tempt(agentId: string): Promise<void>;
  promote(proposalId: string): Promise<boolean>;
  verify(): Promise<void>;
  commands(): Promise<void>;
  /** Scroll to a part of the page, open it, and move the focus to its region. */
  spotlight(selector: string): void;
}

/** The actions a step uses. Each one waits while the story holds. */
interface StepActions {
  state(): ProjectState | null;
  /** Wait until `ready` is true for the project state. Only the time that the story does not hold counts toward `ms`. */
  waitFor(ready: (s: ProjectState) => boolean, ms: number): Promise<ProjectState>;
  /** Wait for `ms`. Only the time that the story does not hold counts. */
  pause(ms: number): Promise<void>;
  createProject(): Promise<boolean>;
  admit(): Promise<boolean>;
  tempt(agentId: string): Promise<void>;
  promote(proposalId: string): Promise<boolean>;
  verify(): Promise<void>;
  commands(): Promise<void>;
  spotlight(selector: string): Promise<void>;
}

interface Step {
  caption: string;
  /** The part of the page that this step changes, for "Show me". */
  where?: string;
  /** True when the step is already done, so the story skips it. */
  done?(s: ProjectState | null): boolean;
  run(a: StepActions): Promise<boolean | void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The interval at which the story examines whether it holds. */
const POLL_MS = 200;

const STEPS: Step[] = [
  {
    caption: "Create the project. Your passkey approves the first commit, and that commit's hash becomes the repository's id.",
    done: (s) => Boolean(s?.repoId),
    async run(a) {
      const created = await a.createProject();
      if (created) await a.spotlight("#history");
      return created;
    },
  },
  {
    caption: "Admit two agents. Each gets an SSH key that lasts an hour and a fork of its own. The new rules need your approval too.",
    where: "#agents",
    done: (s) => Boolean(s && s.agents.length > 0),
    async run(a) {
      const admitted = await a.admit();
      if (admitted) await a.spotlight("#agents");
      return admitted;
    },
  },
  {
    caption: "Ada and Bo work at the same time, each in its own fork, and sign every commit with its own key.",
    where: "#agents",
    async run(a) {
      await a.spotlight("#agents");
      await a.waitFor((s) => s.proposals.filter((p) => p.taskId !== "permanent-key" && p.status === "ready").length >= 2, 60_000);
      await a.spotlight("#proposals");
      await a.pause(2500);
    },
  },
  {
    caption: "Bo tries something else: it edits the rules to make its own key a promoter.",
    where: "#agents",
    done: (s) => Boolean(s?.proposals.some((p) => p.taskId === "permanent-key")),
    async run(a) {
      await a.spotlight("#agents");
      await a.tempt("bo");
      await a.waitFor((s) => s.proposals.some((p) => p.taskId === "permanent-key" && p.status === "rejected"), 60_000);
    },
  },
  {
    caption: "The repository rejects it. The commit is validly signed, but a key can never authorize itself: only a promoter changes the rules.",
    where: ".proposal-rejected .why",
    async run(a) {
      await a.spotlight(".proposal-rejected .why");
      await a.pause(5000);
    },
  },
  {
    caption: "Promote Ada's change. Your passkey signs this exact merge commit: both parents, the resulting tree and the message.",
    where: "#proposals",
    done: (s) => Boolean(s?.proposals.some((p) => p.agentId === "ada" && p.status === "promoted")),
    async run(a) {
      const ada = a.state()?.proposals.find((p) => p.agentId === "ada" && p.status === "ready");
      if (!ada) return true;
      const promoted = await a.promote(ada.id);
      if (promoted) await a.spotlight("#history");
      return promoted;
    },
  },
  {
    caption: "Main moved, so Bo's honest change is checked again on the new main. It still passes.",
    where: "#proposals",
    async run(a) {
      await a.waitFor((s) => s.proposals.some((p) => p.taskId === "readme-es" && p.status === "ready"), 30_000);
      await a.spotlight("#proposals");
      await a.pause(3000);
    },
  },
  {
    caption: "Verify the whole history from a fresh clone, with the repository id pinned. No forge record is used.",
    where: "#outside",
    async run(a) {
      await a.spotlight("#outside");
      await a.verify();
      await a.pause(3000);
    },
  },
  {
    caption: "Take it anywhere. These commands clone the repository and run the same check with no forge in the loop.",
    where: "#outside .commands",
    async run(a) {
      await a.commands();
      await a.spotlight("#outside .commands");
    },
  },
];

/** Why the story holds, or null when it does not hold. */
type Hold = "paused" | "left" | "away" | null;

export class Story {
  private readonly actions: StoryActions;
  private readonly ribbon = byId("story");
  /** The controller of the play that runs. `stop` aborts it. */
  private running: AbortController | null = null;
  private paused = false;
  /** The project of the story, or null before the story makes it. */
  private project: string | null = null;
  /** True while the story makes its project, when the address changes on purpose. */
  private creating = false;
  /** True while a step action runs. The action can open its own sheet. When that sheet closes, the story does not show its place again. */
  private acting = false;
  private index = 0;
  /** The part of the page that the story last showed in this step. */
  private spot: string | null = null;
  private hold: Hold = null;
  private watch: ReturnType<typeof setInterval> | undefined;
  private note: HTMLElement | null = null;
  private pauseButton: HTMLButtonElement | null = null;
  private backButton: HTMLButtonElement | null = null;

  constructor(actions: StoryActions) {
    this.actions = actions;
  }

  get isPlaying() {
    return this.running !== null;
  }

  /** The reason that the story holds now. */
  private holdNow(): Hold {
    const a = this.actions;
    if (!this.creating) {
      if (a.shown() !== this.project) return "left";
      // The page shows the project, but its state is not here yet.
      if (this.project !== null && a.state()?.id !== this.project) return "away";
    }
    if (a.away()) return "away";
    return this.paused ? "paused" : null;
  }

  /** Examine the hold. When a hold ends, show the place of the story again. */
  private check() {
    const hold = this.holdNow();
    if (hold === this.hold) return;
    const ended = this.hold !== null && hold === null;
    this.hold = hold;
    this.update();
    if (ended && !this.acting) this.showMe();
  }

  /** Wait while the story holds. Throw when the story stops. */
  private async held(signal: AbortSignal) {
    for (;;) {
      signal.throwIfAborted();
      this.check();
      if (this.hold === null) return;
      await sleep(POLL_MS);
    }
  }

  /** Wait for `ms` of time that the story does not hold. */
  private async count(ms: number, signal: AbortSignal) {
    let left = ms;
    while (left > 0) {
      await this.held(signal);
      const step = Math.min(left, POLL_MS);
      await sleep(step);
      left -= step;
    }
    signal.throwIfAborted();
  }

  /** The actions of one play: each waits while the story holds, and stops when the play stops. */
  private stepActions(signal: AbortSignal): StepActions {
    const a = this.actions;
    const act =
      <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
      async (...args: A): Promise<R> => {
        await this.held(signal);
        this.acting = true;
        try {
          return await fn(...args);
        } finally {
          this.acting = false;
          signal.throwIfAborted();
        }
      };
    const mine = (s: ProjectState) => this.project === null || s.id === this.project;
    return {
      state: () => {
        const s = a.state();
        return s && mine(s) ? s : null;
      },
      waitFor: async (ready, ms) => {
        await this.held(signal);
        const stop = new AbortController();
        const quit = () => stop.abort(signal.reason);
        signal.addEventListener("abort", quit);
        try {
          return await Promise.race([
            a.waitFor((s) => mine(s) && ready(s), stop.signal),
            this.count(ms, stop.signal).then(() => {
              throw new Error("this step took too long");
            }),
          ]);
        } finally {
          signal.removeEventListener("abort", quit);
          stop.abort();
        }
      },
      pause: (ms) => this.count(ms, signal),
      createProject: act(async () => {
        this.creating = true;
        try {
          const created = await a.createProject();
          this.project = a.shown();
          return created;
        } finally {
          this.creating = false;
        }
      }),
      admit: act(() => a.admit()),
      tempt: act((agentId: string) => a.tempt(agentId)),
      promote: act((proposalId: string) => a.promote(proposalId)),
      verify: act(() => a.verify()),
      commands: act(() => a.commands()),
      spotlight: act(async (selector: string) => {
        this.spot = selector;
        a.spotlight(selector);
      }),
    };
  }

  /** Show the part of the page that the current step changes. */
  private showMe() {
    const target = this.spot ?? STEPS[this.index]?.where;
    if (target && this.hold === null) this.actions.spotlight(target);
  }

  /** Show the caption of step `index`, with the controls of the story. */
  private show(index: number, note = "") {
    this.index = index;
    this.spot = null;
    const step = STEPS[index]!;
    this.note = h("p", { class: "story-note" });
    this.pauseButton = h("button", { type: "button", onclick: () => this.togglePause() });
    this.backButton = h("button", { type: "button", onclick: () => this.actions.open(this.project) }, "Go back to the story");
    const stop = h("button", { type: "button", onclick: () => this.stop() }, "Stop");
    const showMe = step.where ? h("button", { type: "button", onclick: () => this.showMe() }, "Show me") : null;
    fill(
      this.ribbon,
      h("p", { class: "story-step" }, `Step ${index + 1} of ${STEPS.length}`),
      h("p", { class: "story-caption" }, step.caption),
      this.note,
      h("div", { class: "story-controls" }, this.backButton, showMe, this.pauseButton, stop),
    );
    this.update(note);
    this.ribbon.hidden = false;
  }

  /** Show the hold in the ribbon. A `note` replaces the text of the hold. */
  private update(note = "") {
    if (!this.note || !this.pauseButton || !this.backButton) return;
    const left = this.hold === "left";
    this.note.textContent =
      note ||
      (left
        ? this.project
          ? "The story waits in its project. Go back to it to continue."
          : "The story waits on the start page. Go back to it to continue."
        : this.paused
          ? "Paused. The story continues from here when you resume."
          : "");
    this.note.hidden = this.note.textContent === "";
    this.pauseButton.textContent = this.paused ? "Resume" : "Pause";
    this.backButton.hidden = !left;
  }

  private togglePause() {
    this.paused = !this.paused;
    this.check();
    this.update();
  }

  /** Show a last message, with a button that closes the ribbon. */
  private end(title: string | null, caption: string) {
    this.note = this.pauseButton = this.backButton = null;
    fill(
      this.ribbon,
      title ? h("p", { class: "story-step" }, title) : null,
      h("p", { class: "story-caption" }, caption),
      h("div", { class: "story-controls" }, h("button", { type: "button", onclick: () => this.stop() }, "Close")),
    );
    this.ribbon.hidden = false;
  }

  stop() {
    this.running?.abort(new Error("stopped"));
    this.running = null;
    clearInterval(this.watch);
    this.watch = undefined;
    this.paused = false;
    this.hold = null;
    this.ribbon.hidden = true;
  }

  async play() {
    if (this.running) return;
    const play = new AbortController();
    const signal = play.signal;
    this.running = play;
    this.paused = false;
    this.hold = null;
    this.creating = false;
    this.project = this.actions.shown();
    // The hold can also change while a step waits, so examine it at intervals.
    this.watch = setInterval(() => this.check(), POLL_MS);
    const a = this.stepActions(signal);
    try {
      for (const [index, step] of STEPS.entries()) {
        await this.held(signal);
        if (step.done?.(a.state())) continue;
        this.show(index);
        await a.pause(1800);
        const result = await step.run(a);
        if (result === false) {
          this.finish(play);
          this.show(index, "The story waits here: this step needs your approval. Play the story again to continue.");
          this.pauseButton!.hidden = true;
          return;
        }
      }
      this.finish(play);
      this.end("The end", "Agents wrote the code. A person promoted it with a passkey. The repository holds the proof, and any clone can check it.");
    } catch (error) {
      // A stopped play leaves the ribbon as stop() left it.
      if (signal.aborted) return;
      this.finish(play);
      this.end(null, `The story stopped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** End the play `play` and keep the ribbon, if no other play started after it. */
  private finish(play: AbortController) {
    if (this.running !== play) return;
    this.running = null;
    clearInterval(this.watch);
    this.watch = undefined;
    this.hold = null;
    this.acting = false;
  }
}
