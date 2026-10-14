// What the agents do. Most tasks are fixed scripts, so the demo runs the same
// way each time. The `llm-note` task asks Claude for its text. Two honest
// tasks change different files, so both can merge. The rogue task tries to
// make its own key a promoter.

import { parsePolicy, POLICY_PATH, renderPolicy } from "../authority/policy.ts";
import { policyFiles } from "./template.ts";
import { NOTE_MODEL, type Note } from "./llm.ts";

interface TaskContext {
  agentId: string;
  agentName: string;
  /** The `ssh-ed25519 AAAA...` text of the agent's own key. */
  publicKey: string;
  /** Read a file from the head of the fork. */
  read(path: string): Promise<string | null>;
  /** The names of the files in a directory of the fork. */
  list(dir: string): Promise<string[]>;
  /** What the person who gave the task asked for, such as a topic. */
  args: { topic?: string };
  /** Event text for the transcript. */
  say(text: string): void;
  /** Ask Claude for a note, where the deployment has an API key. */
  writeNote?: (input: { topic: string; agentName: string; existing: string[] }) => Promise<Note>;
}

interface Task {
  id: string;
  title: string;
  branch: string;
  rogue: boolean;
  /** The commit message. For the `llm-note` task, `AgentRun` uses `noteMessage` instead. */
  message: string;
  /** The files to write, or to remove where the value is null. */
  edit(ctx: TaskContext): Promise<Record<string, string | null>>;
}

const changelogEntry: Task = {
  id: "changelog",
  title: "Add a changelog entry",
  branch: "changelog",
  rogue: false,
  message: "Add a changelog entry for offline verification\n",
  async edit({ read }) {
    const text = (await read("CHANGELOG.md")) ?? "# Changelog\n";
    return { "CHANGELOG.md": `${text.trimEnd()}\n- Documented how to verify the repository offline.\n` };
  },
};

const spanishReadme: Task = {
  id: "readme-es",
  title: "Translate the README into Spanish",
  branch: "readme-es",
  rogue: false,
  message: "Translate the README into Spanish\n",
  async edit() {
    return {
      "README.es.md":
        "# Notas Gordian\n\nNotas breves sobre ideas Gordian, escritas por personas y sus agentes.\n\nVea [.repo/README.md](.repo/README.md) para saber quién puede cambiar qué.\n",
    };
  },
};

function noteTask(agentId: string): Task {
  return {
    id: "note",
    title: `Add notes/${agentId}.md`,
    branch: "note",
    rogue: false,
    message: `Add notes/${agentId}.md\n`,
    async edit({ agentName }) {
      return { [`notes/${agentId}.md`]: `# Notes from ${agentName}\n\nA short note.\n` };
    },
  };
}

/** The note from the model in the last `llm-note` task of each agent. `noteMessage` uses it for the commit message. */
const lastNote = new Map<string, Note>();

/** A note that Claude writes on a topic that a person gives. */
const LLM_NOTE: Task = {
  id: "llm-note",
  title: "Write a note with Claude",
  branch: "llm-note",
  rogue: false,
  message: "Add a note written with Claude\n",
  async edit({ args, agentId, agentName, list, say, writeNote }) {
    if (!writeNote) throw new Error("this forge has no Anthropic API key");
    const topic = args.topic ?? "the Gordian principles";
    say(`Asked Claude (${NOTE_MODEL}) for a note on "${topic}". It sees the topic and the note names, never a key or a token.`);
    const note = await writeNote({ topic, agentName, existing: await list("notes") });
    lastNote.set(agentId, note);
    say(`Claude wrote "${note.title}".`);
    const slug = note.title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "note";
    return { [`notes/${slug}.md`]: `# ${note.title}\n\n${note.body}\n` };
  },
};

/** The commit message for the last `llm-note` task of an agent: the line from the model, and the name of the model. */
export function noteMessage(agentId: string): string {
  const note = lastNote.get(agentId);
  return note ? `${note.commitMessage}\n\nWritten by ${NOTE_MODEL} on a topic a person gave.\n` : LLM_NOTE.message;
}

/** A task that two agents can both do, so that their proposals conflict after a promoter promotes one of them. */
const RETITLE: Task = {
  id: "readme-title",
  title: "Retitle the README",
  branch: "readme-title",
  rogue: false,
  message: "Retitle the README\n",
  async edit({ read, agentName }) {
    const lines = ((await read("README.md")) ?? "# Notes\n").split("\n");
    lines[0] = `# Gordian notes, as ${agentName} sees them`;
    return { "README.md": lines.join("\n") };
  },
};

/** The tasks a person can give an agent from the page, beyond its first one. */
export const GIVEN_TASKS = ["readme-title", "permanent-key", "llm-note"] as const;

/** The rogue task: the agent lists its own key as a promoter and makes its window permanent. */
export const PERMANENT_KEY: Task = {
  id: "permanent-key",
  title: "Make my key permanent",
  branch: "permanent-key",
  rogue: true,
  message: "Make my key a promoter so I can merge my own work\n",
  async edit({ read, agentId, publicKey }) {
    const policy = parsePolicy((await read(POLICY_PATH)) ?? "");
    policy.promoters.push({ id: `${agentId}-promoter`, kind: "ssh-ed25519", publicKey });
    policy.authors = policy.authors.map((a) => (a.id === agentId ? { ...a, validBefore: "2099-12-31T23:59:59.000Z" } : a));
    return { ...policyFiles(policy), [POLICY_PATH]: renderPolicy(policy) };
  },
};

/** The first task of an agent: the demo's two agents have fixed ones, any other adds a note. */
export function firstTask(agentId: string): Task {
  if (agentId === "ada") return changelogEntry;
  if (agentId === "bo") return spanishReadme;
  return noteTask(agentId);
}

export function taskById(agentId: string, taskId: string): Task {
  for (const task of [changelogEntry, spanishReadme, RETITLE, PERMANENT_KEY, LLM_NOTE, noteTask(agentId)]) if (task.id === taskId) return task;
  throw new Error(`no task ${taskId}`);
}
