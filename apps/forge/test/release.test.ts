import { describe, expect, it } from "vitest";
import { must, Person, testForge, uniqueName } from "./harness.ts";

describe("a release", () => {
  it("is an annotated tag of main with a passkey approval, and a fresh clone verifies it", async () => {
    const app = testForge();
    const leo = new Person(app);
    await leo.register(uniqueName("Leo"));
    const created = must(await leo.forge.approve(must(await leo.forge.prepareProject("release"))));
    const id = created.id;
    expect(await leo.forge.prepareRelease(id, "../bad")).toMatchObject({ result: "refused", status: 400 });

    const request = must(await leo.forge.prepareRelease(id, "v1.0.0"));
    expect(request.payload).toMatchObject({ action: "release", ref: "refs/tags/v1.0.0", parents: [created.mainHead] });
    expect(request.changes).toEqual([]);
    const state = must(await leo.forge.approve(request));
    expect(state.history?.tags).toMatchObject([{ name: "v1.0.0", target: created.mainHead, ok: true }]);
    expect(state.history?.tags[0]?.rules[0]?.reason).toContain("Released by");
    expect(state.mainHead).toBe(created.mainHead);

    const fresh = must(await leo.forge.verifyFresh(id));
    expect(fresh.report.tags).toMatchObject([{ name: "v1.0.0", ok: true }]);
    expect(fresh.report.summary).toContain("Its release verifies too.");
    expect(await leo.forge.prepareRelease(id, "v1.0.0")).toMatchObject({ result: "refused", status: 409, refusal: { error: "exists" } });
  });
});
