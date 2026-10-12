import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256, toHex } from "../authority/bytes.ts";
import { must, Person, testForge, uniqueName } from "./harness.ts";

describe("the verifier file", () => {
  it("is served by the forge, and a new repository's workflow pins its digest", async () => {
    const app = testForge();
    const served = await env.ASSETS.fetch(new Request(`${app.origin}/forge-verify.mjs`));
    expect(served.status).toBe(200);
    const digest = toHex(await sha256(new Uint8Array(await served.arrayBuffer())));

    const leo = new Person(app);
    await leo.register(uniqueName("Leo"));
    const state = must(await leo.forge.approve(must(await leo.forge.prepareProject("pinned"))));
    const root = must(await leo.forge.commit(state.id, state.repoId!));
    const workflow = root.changes.find((c) => c.path === ".github/workflows/verify.yml")!;
    const text = workflow.lines!.map((l) => l.text).join("\n");
    expect(text).toContain(`VERIFIER_SHA256: ${digest}`);
    expect(text).toContain(`VERIFIER_URL: ${app.origin}/forge-verify.mjs`);
    expect(text).toContain("sha256sum --check --strict");
  });
});
