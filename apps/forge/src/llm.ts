// An agent task that Claude writes: a short note on a topic that a person
// gives. The model sees the topic and the names of the notes that exist. It
// never sees a key, a token or the policy. It does not choose the path or sign
// anything. The agent writes what the model returns, signs it with its own key
// and proposes it. Thus the rules check the work of the model as they check
// all other work.

import Anthropic from "@anthropic-ai/sdk";

export const NOTE_MODEL = "claude-opus-5-5";

/** What the model returns, as the JSON schema constrains it. */
export interface Note {
  title: string;
  body: string;
  commitMessage: string;
}

const NOTE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "A short title for the note, in sentence case." },
    body: { type: "string", description: "The note in Markdown, without its title, under 180 words." },
    commitMessage: { type: "string", description: "A one-line commit message in the imperative, under 60 characters." },
  },
  required: ["title", "body", "commitMessage"],
  additionalProperties: false,
} as const;

const SYSTEM = `You write short notes for a small repository of notes on Gordian ideas: independence, privacy, resilience and openness in digital identity.
Write plainly, for a developer audience, with no marketing tone. Do not invent facts about real people or products.`;

/** The part of the Anthropic client that this module uses, so that a test can replace it. */
export type NoteClient = Pick<Anthropic["beta"]["messages"], "create">;

export class NoteRefused extends Error {}

/** Ask Claude for a note on `topic`. Throws `NoteRefused` if the model and the fallback model both refuse. */
export async function writeNote(client: NoteClient, input: { topic: string; agentName: string; existing: string[] }): Promise<Note> {
  const response = (await client.create({
    model: NOTE_MODEL,
    max_tokens: 16000,
    // Server-side fallback: if the model refuses, the request runs again on the model that Anthropic recommends for that case.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: NOTE_SCHEMA } },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `You are ${input.agentName}, an agent that contributes notes. Write one note on this topic: ${input.topic}\n\nNotes that already exist, so you do not repeat one: ${input.existing.join(", ") || "none"}.`,
      },
    ],
  })) as Anthropic.Beta.BetaMessage;
  if (response.stop_reason === "refusal") throw new NoteRefused(response.stop_details?.explanation ?? "The model declined to write this note.");
  const text = response.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")?.text;
  if (!text) throw new Error("the model returned no text");
  const note = JSON.parse(text) as Note;
  return {
    title: note.title.replace(/\s+/g, " ").trim().slice(0, 80),
    body: note.body.trim(),
    commitMessage: note.commitMessage.replace(/\s+/g, " ").trim().slice(0, 72),
  };
}

/** A client for the Worker, or null when the deployment has no ANTHROPIC_API_KEY secret. */
export function noteClient(env: Env): NoteClient | null {
  return env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }).beta.messages : null;
}
