// The story: the demo's steps in order, with a caption for each. It acts on
// its own, and halts at each approval for the person to read the change and
// use their passkey. Pause stops it after the current step.

import type { ProjectState } from "./view-types.ts";
import { byId, fill, h } from "./h.ts";

export interface StoryActions {
  state(): ProjectState | null;
  /** Wait until the project state satisfies `ready`. */
  waitFor(ready: (s: ProjectState) => boolean, ms?: number): Promise<ProjectState>;
  createProject(): Promise<boolean>;
  admit(): Promise<boolean>;
  tempt(agentId: string): Promise<void>;
  promote(proposalId: string): Promise<boolean>;
  verify(): Promise<void>;
  commands(): Promise<void>;
  /** Scroll to and open a part of the stage. */
  spotlight(selector: string): void;
}

interface Step {
  caption: string;
  /** True when the step is already done, so the story skips it. */
  done?(s: ProjectState | null): boolean;
  run(a: StoryActions): Promise<boolean | void>;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STEPS: Step[] = [
  {
    caption: "Create the project. Your passkey approves the first commit, and that commit's hash becomes the repository's id.",
    done: (s) => Boolean(s?.repoId),
    run: (a) => a.createProject(),
  },
  {
    caption: "Admit two agents. Each gets an SSH key that lasts an hour and a fork of its own. The new rules need your approval too.",
    done: (s) => Boolean(s && s.agents.length > 0),
    run: (a) => a.admit(),
  },
  {
    caption: "Ada and Bo work at the same time, each in its own fork, and sign every commit with its own key.",
    async run(a) {
      await a.waitFor((s) => s.proposals.filter((p) => p.taskId !== "permanent-key" && p.status === "ready").length >= 2, 60_000);
      a.spotlight("#proposals");
      await pause(2500);
    },
  },
  {
    caption: "Bo tries something else: it edits the rules to make its own key a promoter.",
    done: (s) => Boolean(s?.proposals.some((p) => p.taskId === "permanent-key")),
    async run(a) {
      a.spotlight("#agents");
      await a.tempt("bo");
      await a.waitFor((s) => s.proposals.some((p) => p.taskId === "permanent-key" && p.status === "rejected"), 60_000);
    },
  },
  {
    caption: "The repository rejects it. The commit is validly signed, but a key can never authorize itself: only a promoter changes the rules.",
    async run(a) {
      a.spotlight(".proposal-rejected .why");
      await pause(5000);
    },
  },
  {
    caption: "Promote Ada's change. Your passkey signs this exact merge commit: both parents, the resulting tree and the message.",
    done: (s) => Boolean(s?.proposals.some((p) => p.agentId === "ada" && p.status === "promoted")),
    async run(a) {
      const ada = a.state()?.proposals.find((p) => p.agentId === "ada" && p.status === "ready");
      return ada ? a.promote(ada.id) : true;
    },
  },
  {
    caption: "Main moved, so Bo's honest change is checked again on the new main. It still passes.",
    async run(a) {
      await a.waitFor((s) => s.proposals.some((p) => p.taskId === "readme-es" && p.status === "ready"), 30_000);
      a.spotlight("#proposals");
      await pause(3000);
    },
  },
  {
    caption: "Verify the whole history from a fresh clone, with the repository id pinned. No forge record is used.",
    async run(a) {
      a.spotlight("#outside");
      await a.verify();
      await pause(3000);
    },
  },
  {
    caption: "Take it anywhere. These commands clone the repository and run the same check with no forge in the loop.",
    async run(a) {
      await a.commands();
      a.spotlight("#outside .commands");
    },
  },
];

export class Story {
  private readonly actions: StoryActions;
  private playing = false;
  private paused = false;
  private readonly ribbon = byId("story");

  constructor(actions: StoryActions) {
    this.actions = actions;
  }

  get isPlaying() {
    return this.playing;
  }

  private show(index: number, note = "") {
    const pauseButton = h("button", { type: "button", onclick: () => this.togglePause() }, this.paused ? "Resume" : "Pause");
    const stop = h("button", { type: "button", onclick: () => this.stop() }, "Stop");
    fill(this.ribbon, 
      h("p", { class: "story-step" }, `Step ${index + 1} of ${STEPS.length}`),
      h("p", { class: "story-caption" }, STEPS[index]!.caption),
      note ? h("p", { class: "story-note" }, note) : null,
      h("div", { class: "story-controls" }, pauseButton, stop),
    );
    this.ribbon.hidden = false;
  }

  private togglePause() {
    this.paused = !this.paused;
    const button = this.ribbon.querySelector<HTMLButtonElement>(".story-controls button");
    if (button) button.textContent = this.paused ? "Resume" : "Pause";
  }

  stop() {
    this.playing = false;
    this.paused = false;
    this.ribbon.hidden = true;
  }

  async play() {
    if (this.playing) return;
    this.playing = true;
    this.paused = false;
    try {
      for (const [index, step] of STEPS.entries()) {
        if (!this.playing) return;
        if (step.done?.(this.actions.state())) continue;
        this.show(index);
        await pause(1800);
        while (this.paused && this.playing) await pause(200);
        if (!this.playing) return;
        const result = await step.run(this.actions);
        if (result === false) {
          this.show(index, "The story waits here: this step needs your approval. Play the story again to continue.");
          this.playing = false;
          return;
        }
      }
      fill(this.ribbon, 
        h("p", { class: "story-step" }, "The end"),
        h("p", { class: "story-caption" }, "Agents wrote the code. A person promoted it with a passkey. The repository holds the proof, and any clone can check it."),
        h("div", { class: "story-controls" }, h("button", { type: "button", onclick: () => this.stop() }, "Close")),
      );
    } catch (error) {
      fill(this.ribbon, 
        h("p", { class: "story-caption" }, `The story stopped: ${error instanceof Error ? error.message : String(error)}`),
        h("div", { class: "story-controls" }, h("button", { type: "button", onclick: () => this.stop() }, "Close")),
      );
    } finally {
      this.playing = false;
    }
  }
}
