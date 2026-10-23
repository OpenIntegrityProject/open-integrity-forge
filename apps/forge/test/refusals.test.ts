import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { must, Person, testForge, uniqueName, waitFor, createProject } from "./harness.ts";

async function project(app = testForge()) {
  const leo = new Person(app);
  await leo.register(uniqueName("Leo"));
  const state = must(await createProject(leo, "refusals"));
  return { app, leo, id: state.id, state };
}

describe("the forge refuses", () => {
  it("a request with no session, and a POST from another origin", async () => {
    const app = testForge();
    const anonymous = await app.fetch(new Request(`${app.origin}/forge/me`));
    expect(anonymous.status).toBe(401);
    const leo = new Person(app);
    await leo.register(uniqueName("Leo"));
    const foreign = await leo.browser.send(
      new Request(`${app.origin}/forge/projects/prepare`, { method: "POST", headers: { Origin: "https://evil.example" }, body: "{}" }),
    );
    expect(foreign.status).toBe(403);
  });

  it("another person's project, as if it did not exist", async () => {
    const { app, id } = await project();
    const eve = new Person(app);
    await eve.register(uniqueName("Eve"));
    expect(await eve.forge.state(id)).toMatchObject({ result: "refused", status: 404 });
    expect(await eve.forge.prepareAgents(id, ["Mallory"])).toMatchObject({ result: "refused", status: 404 });
  });

  it("agents for a project whose first policy is not yet approved, with a reason", async () => {
    const app = testForge();
    const leo = new Person(app);
    await leo.register(uniqueName("Leo"));
    const prepared = must(await leo.forge.prepareProject("half-made"));
    const signed = must(await leo.forge.approve(prepared));
    expect(signed.repoId).toBeTruthy();
    expect(signed.policy).toBeNull();
    expect(await leo.forge.prepareAgents(signed.id, ["Ada"])).toMatchObject({ result: "refused", status: 409, refusal: { error: "no-policy" } });
  });

  it("an approval used twice", async () => {
    const { leo, id } = await project();
    const request = must(await leo.forge.prepareAgents(id, ["Ada"]));
    must(await leo.forge.approve(request));
    expect(await leo.forge.approve(request)).toMatchObject({ result: "refused", status: 409, refusal: { error: "approval-expired" } });
  });

  it("an approval without user verification, or from another origin", async () => {
    const { leo, id } = await project();
    leo.tamper = { userUnverified: true };
    const unverified = await leo.forge.approve(must(await leo.forge.prepareAgents(id, ["Ada"])));
    expect(unverified).toMatchObject({ result: "refused", status: 403, refusal: { reason: expect.stringContaining("did not verify the person") } });
    leo.tamper = { origin: "https://evil.example" };
    const foreign = await leo.forge.approve(must(await leo.forge.prepareAgents(id, ["Ada"])));
    expect(foreign).toMatchObject({ result: "refused", status: 403, refusal: { reason: expect.stringContaining("evil.example") } });
    const state = must(await leo.forge.state(id));
    expect(state.policy?.authors).toEqual([]);
    expect(state.events.at(-1)?.kind).toBe("refusal");
  });

  it("an approval made before main moved", async () => {
    const { leo, id } = await project();
    must(await leo.forge.approve(must(await leo.forge.prepareAgents(id, ["Ada", "Bo"]))));
    const state = await waitFor(leo, id, (s) => s.proposals.filter((p) => p.status === "ready").length === 2, "two proposals");
    const [ada, bo] = state.proposals;
    const first = must(await leo.forge.preparePromotion(id, ada!.id));
    const second = must(await leo.forge.preparePromotion(id, bo!.id));
    must(await leo.forge.approve(first));
    expect(await leo.forge.approve(second)).toMatchObject({ result: "refused", status: 409, refusal: { error: "stale" } });
    // A new request on the new main succeeds.
    must(await leo.forge.approve(must(await leo.forge.preparePromotion(id, bo!.id))));
  });

  it("a promoter key that belongs to someone else, and a new one without a step-up", async () => {
    const app = testForge();
    const leo = new Person(app);
    const eve = new Person(app);
    await leo.register(uniqueName("Leo"));
    await eve.register(uniqueName("Eve"));
    const theirs = eve.created;
    expect(await leo.forge.setPromoterKey(theirs)).toMatchObject({ result: "refused", status: 403, refusal: { error: "not-yours" } });

    // A second passkey of Leo replaces the first passkey only after a new step-up.
    expect((await leo.demo.enrol()).result).toBe("ok");
    app.clock.offsetMs = 11 * 60_000;
    const raw = await leo.browser.post("/forge/me/promoter-key", { response: leo.created });
    expect(raw.status).toBe(403);
    expect(((await raw.json()) as { error: string }).error).toBe("step-up-required");
    // The client does a step-up when the forge asks for it, and then sends the request again.
    const key = must(await leo.forge.setPromoterKey(leo.created));
    expect(key.credentialId).toBe(leo.created!.id);
    expect((await leo.forge.me())!.promoter?.credentialId).toBe(leo.created!.id);
  });

  it("a reset without a step-up, and stepped up it deletes everything", async () => {
    const { app, leo, id, state } = await project();
    const raw = await leo.browser.post(`/forge/projects/${id}/reset`, {});
    expect(raw.status).toBe(403);
    expect(((await raw.json()) as { error: string }).error).toBe("step-up-required");
    expect((await leo.forge.state(id)).result).toBe("ok");
    must(await leo.forge.reset(id));
    expect(await leo.forge.state(id)).toMatchObject({ result: "refused", status: 404 });
    // The repository goes in the project's alarm, after the reset answers.
    await runDurableObjectAlarm(env.PROJECTS.get(env.PROJECTS.idFromName(id)));
    const repo = env.LOCAL_REPOS.get(env.LOCAL_REPOS.idFromName(state.repo.name));
    expect(await repo.exists()).toBe(false);
    void app;
  });

  it("too many approval requests in a minute", async () => {
    const { leo, id } = await project();
    let last;
    for (let i = 0; i < 30; i++) last = await leo.forge.prepareInception(id);
    expect(last).toMatchObject({ result: "refused", status: 429 });
  });
});

describe("repo tokens", () => {
  it("are scoped to one repository, to a scope, and to a time", async () => {
    const a = env.LOCAL_REPOS.get(env.LOCAL_REPOS.idFromName(`a-${crypto.randomUUID()}`));
    const b = env.LOCAL_REPOS.get(env.LOCAL_REPOS.idFromName(`b-${crypto.randomUUID()}`));
    expect(await a.create("a")).toBe(true);
    expect(await b.create("b")).toBe(true);
    expect(await a.create("a")).toBe(false);
    const read = await a.mintToken("read", 60);
    const write = await a.mintToken("write", 60);
    const update = [{ ref: "refs/heads/main", old: null, new: "0".repeat(40) }];
    expect(await a.upload(read.secret, [], update)).toMatchObject({ ok: false });
    expect(await b.upload(write.secret, [], update)).toMatchObject({ ok: false });
    expect(await b.download(read.secret)).toBeNull();
    expect(await a.upload(write.secret, [], update)).toEqual({ ok: true });
    // A push must name the value it replaces.
    expect(await a.upload(write.secret, [], update)).toMatchObject({ ok: false, error: expect.stringContaining("moved") });
    const expired = await a.mintToken("read", -1);
    expect(await a.download(expired.secret)).toBeNull();
  });

  it("let a Git client read a repository over dumb HTTP, with a read token only", async () => {
    const { app, leo, id, state } = await project();
    const outside = must(await leo.forge.outside(id));
    const url = `${app.origin}/forge/git/${state.repo.name}.git/info/refs`;
    expect((await app.fetch(new Request(url))).status).toBe(401);
    const basic = (secret: string) => ({ Authorization: `Basic ${btoa(`x:${secret.split("?")[0]}`)}` });
    const refs = await app.fetch(new Request(url, { headers: basic(outside.token) }));
    expect(refs.status).toBe(200);
    expect(await refs.text()).toBe(`${state.mainHead}\trefs/heads/main\n`);
    const object = await app.fetch(
      new Request(`${app.origin}/forge/git/${state.repo.name}.git/objects/${state.mainHead!.slice(0, 2)}/${state.mainHead!.slice(2)}`, {
        headers: basic(outside.token),
      }),
    );
    expect(object.status).toBe(200);
    expect((await object.arrayBuffer()).byteLength).toBeGreaterThan(100);
  });
});
