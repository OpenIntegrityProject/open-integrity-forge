import { describe, expect, it } from "vitest";
import { NoteRefused, writeNote, type NoteClient } from "./llm.ts";

/** A replacement for the Anthropic client. It records the request and gives `reply` as its answer. */
function client(reply: object) {
  const seen: unknown[] = [];
  const fake = { create: async (request: unknown) => (seen.push(request), reply) } as unknown as NoteClient;
  return { fake, seen };
}

describe("a note written with Claude", () => {
  it("asks for structured output with the server-side fallback, and cleans what comes back", async () => {
    const { fake, seen } = client({
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify({ title: "Key  rotation\nmatters", body: "Rotate keys.\n", commitMessage: "Add a note on key rotation" }) }],
    });
    const note = await writeNote(fake, { topic: "key rotation", agentName: "Ada", existing: ["independence.md"] });
    expect(note).toEqual({ title: "Key rotation matters", body: "Rotate keys.", commitMessage: "Add a note on key rotation" });
    expect(seen[0]).toMatchObject({
      model: "claude-opus-5-5",
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema" } },
    });
    const prompt = JSON.stringify(seen[0]);
    expect(prompt).toContain("key rotation");
    expect(prompt).toContain("independence.md");
    expect(prompt).not.toMatch(/art_v[0-9]+_|lrt_v[0-9]+_|PRIVATE KEY|ssh-ed25519/);
  });

  it("reports a refusal instead of reading the content", async () => {
    const { fake } = client({ stop_reason: "refusal", stop_details: { type: "refusal", category: null, explanation: "Declined." }, content: [] });
    await expect(writeNote(fake, { topic: "x y z", agentName: "Ada", existing: [] })).rejects.toThrow(NoteRefused);
  });
});
