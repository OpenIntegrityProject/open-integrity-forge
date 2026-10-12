// The dumb HTTP protocol of Git, read only, for repositories in LocalRepo
// objects. With it, a plain `git clone` works against `wrangler dev`, so the
// verifier can check a clone on disk that no forge code wrote. The password
// of HTTP Basic auth is a read token of the repository.

const PATH = /^\/forge\/git\/([A-Za-z0-9][A-Za-z0-9._-]*)\.git\/(info\/refs|HEAD|objects\/info\/packs|objects\/([0-9a-f]{2})\/([0-9a-f]{38}))$/;

function unauthorized(): Response {
  return new Response("A read token is required.\n", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="forge"' } });
}

export async function localGitHttp(request: Request, env: Env): Promise<Response | null> {
  const match = PATH.exec(new URL(request.url).pathname);
  if (!match) return null;
  if (env.REPO_HOST !== "local") return new Response("Not found.\n", { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed.\n", { status: 405 });
  const [, name, file, dir, rest] = match;
  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Basic ")) return unauthorized();
  const secret = decodeURIComponent(atob(auth.slice(6)).split(":").slice(1).join(":"));
  const repo = env.LOCAL_REPOS.get(env.LOCAL_REPOS.idFromName(name!));
  const text = (body: string) => new Response(body, { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });

  if (file === "info/refs") {
    const refs = await repo.listRefs(secret);
    if (!refs) return unauthorized();
    return text(Object.entries(refs).sort(([a], [b]) => a.localeCompare(b)).map(([ref, oid]) => `${oid}\t${ref}\n`).join(""));
  }
  if (file === "HEAD") {
    if (!(await repo.listRefs(secret))) return unauthorized();
    return text("ref: refs/heads/main\n");
  }
  if (file === "objects/info/packs") {
    if (!(await repo.listRefs(secret))) return unauthorized();
    return text("");
  }
  const data = await repo.object(secret, `${dir}${rest}`);
  if (data === null) return (await repo.listRefs(secret)) ? new Response("Not found.\n", { status: 404 }) : unauthorized();
  return new Response(data, { headers: { "Content-Type": "application/x-git-loose-object", "Cache-Control": "no-store" } });
}
