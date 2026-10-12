// A real Git server for tests: `git http-backend` behind a small Node server
// that requires a token as the Basic auth password, as Artifacts and GitHub
// do. Repositories are bare directories under `root`.

import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";

export interface GitServer {
  url: string;
  close(): Promise<void>;
}

export async function startGitServer(root: string, token: string, port = 0): Promise<GitServer> {
  const server: Server = createServer((req, res) => {
    const auth = req.headers.authorization ?? "";
    const password = auth.startsWith("Basic ") ? Buffer.from(auth.slice(6), "base64").toString().split(":").slice(1).join(":") : "";
    if (password !== token.split("?expires=")[0]) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' }).end();
      return;
    }
    const url = new URL(req.url!, "http://x");
    const cgi = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        REMOTE_USER: "x",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method!,
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
      },
    });
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0);
    let sent = false;
    cgi.stdout.on("data", (chunk: Buffer) => {
      if (sent) return void res.write(chunk);
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of head.subarray(0, end).toString().split("\r\n")) {
        const [k, ...v] = line.split(":");
        if (k!.toLowerCase() === "status") status = Number(v.join(":").trim().split(" ")[0]);
        else headers[k!] = v.join(":").trim();
      }
      res.writeHead(status, headers);
      res.write(head.subarray(end + 4));
      sent = true;
    });
    cgi.on("close", () => res.end());
  });
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise((done) => server.close(() => done())) };
}
