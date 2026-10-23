import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { operatorLog } from "../../demo/src/operator-log.ts";
import { createProject, must, Person, testForge, uniqueName } from "./harness.ts";

/** Delete a repository behind the forge's back, as a cleanup of the host does. */
async function removeRepo(name: string) {
  await env.LOCAL_REPOS.get(env.LOCAL_REPOS.idFromName(name)).destroy();
}

describe("a project whose repository is gone", () => {
  it("still has a state, which says so, and its owner can delete it", async () => {
    const app = testForge();
    const leo = new Person(app);
    await leo.register(uniqueName("Leo"));
    const state = must(await createProject(leo, "orphan"));
    expect(state.repo.missing).toBe(false);
    await removeRepo(state.repo.name);

    const after = must(await leo.forge.state(state.id));
    expect(after.repo).toMatchObject({ missing: true, remote: null });

    must(await leo.forge.reset(state.id));
    expect(await leo.forge.state(state.id)).toMatchObject({ result: "refused", status: 404 });
    expect((await leo.forge.me())!.projects).toEqual([]);
  });
});

describe("an operator", () => {
  async function forgeWithOperator() {
    const ops = { recordId: "" };
    const app = testForge({
      get OPERATOR_RECORD_IDS() {
        return ops.recordId;
      },
    } as Partial<Env>);
    const operator = new Person(app);
    await operator.register(uniqueName("Op"));
    ops.recordId = (await operator.forge.me())!.recordId;
    return { app, operator };
  }

  it("lists every project with its owner, and whether its repository is gone", async () => {
    const { app, operator } = await forgeWithOperator();
    const leo = new Person(app);
    const leoName = uniqueName("Leo");
    await leo.register(leoName);
    const kept = must(await createProject(leo, "kept"));
    const gone = must(await createProject(leo, "gone"));
    await removeRepo(gone.repo.name);

    const listed = must(await operator.forge.operatorProjects()).projects;
    expect(listed.find((p) => p.id === kept.id)).toMatchObject({ name: "kept", ownerName: leoName, missing: false });
    expect(listed.find((p) => p.id === gone.id)).toMatchObject({ name: "gone", ownerName: leoName, missing: true });

    expect(await leo.forge.operatorProjects()).toMatchObject({ result: "refused", status: 403 });
  });

  it("deletes another person's project after a step-up, and logs it first", async () => {
    const { app, operator } = await forgeWithOperator();
    const leo = new Person(app);
    await leo.register(uniqueName("Leo"));
    const gone = must(await createProject(leo, "gone"));
    await removeRepo(gone.repo.name);
    const leoId = (await leo.forge.me())!.recordId;

    const raw = await operator.browser.post(`/forge/operator/projects/${gone.id}/reset`, {});
    expect(raw.status).toBe(403);
    expect(((await raw.json()) as { error: string }).error).toBe("step-up-required");
    expect(await leo.forge.operatorReset(gone.id)).toMatchObject({ result: "refused", status: 403 });

    must(await operator.forge.operatorReset(gone.id));
    expect((await leo.forge.me())!.projects).toEqual([]);
    expect(await leo.forge.state(gone.id)).toMatchObject({ result: "refused", status: 404 });
    expect(must(await operator.forge.operatorProjects()).projects.some((p) => p.id === gone.id)).toBe(false);
    const entries = await operatorLog(env.OPERATOR_LOG, app.storagePrefix)().listFor(leoId as never);
    expect(entries.map((e) => e.action)).toContain("delete-project");
  });
});
