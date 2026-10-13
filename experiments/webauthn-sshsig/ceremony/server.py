"""A real passkey ceremony signs an Open Integrity inception commit.

usage: python3 server.py <workdir> [port]

Serves index.html on http://localhost:<port> (default 8790). The page
registers a passkey, the server builds an empty inception commit whose
committer is the key's fingerprint, the page signs the commit's SSHSIG
data with the passkey, and the server stores the assertion as the
commit's `gpgsig` in OpenSSH's webauthn-sk-ecdsa format. It then runs
`ssh-keygen -Y verify` and `git verify-commit` on the result and
returns their output. Standard library only.
"""
import base64, hashlib, json, os, struct, subprocess, sys, time
from http.server import BaseHTTPRequestHandler, HTTPServer

WORK = os.path.abspath(sys.argv[1])
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8790
RP_ID = "localhost"
ORIGIN = f"http://localhost:{PORT}"
HERE = os.path.dirname(os.path.abspath(__file__))
EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
SK_TYPE = "sk-ecdsa-sha2-nistp256@openssh.com"
SIG_TYPE = "webauthn-sk-ecdsa-sha2-nistp256@openssh.com"


def s(b):
    b = b.encode() if isinstance(b, str) else b
    return struct.pack(">I", len(b)) + b


def mpint(b):
    b = b.lstrip(b"\0") or b"\0"
    return s(b"\0" + b if b[0] & 0x80 else b)


def b64u_dec(t):
    return base64.urlsafe_b64decode(t + "=" * (-len(t) % 4))


def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def der_ecdsa(der):
    """r and s from a DER ECDSA-Sig-Value."""
    assert der[0] == 0x30
    i = 2 if der[1] < 0x80 else 2 + (der[1] & 0x7F)
    out = []
    for _ in range(2):
        assert der[i] == 0x02
        n = der[i + 1]
        out.append(der[i + 2:i + 2 + n])
        i += 2 + n
    return out


def run(*cmd, stdin=None):
    p = subprocess.run(cmd, input=stdin, capture_output=True, cwd=WORK)
    return p.returncode, (p.stdout + p.stderr).decode(errors="replace")


state = {}


def register(body):
    spki = b64u_dec(body["publicKey"])
    point = spki[-65:]
    assert point[0] == 4 and body["alg"] == -7, "need an ES256 (P-256) passkey"
    pub = s(SK_TYPE) + s("nistp256") + s(point) + s(RP_ID)
    fpr = "SHA256:" + base64.b64encode(hashlib.sha256(pub).digest()).rstrip(b"=").decode()
    name = subprocess.run(["git", "config", "user.name"], capture_output=True, text=True).stdout.strip()
    email = subprocess.run(["git", "config", "user.email"], capture_output=True, text=True).stdout.strip()
    ts = f"{int(time.time())} +0000"
    msg = ("Initialize repository and establish a SHA-1 root of trust\n\n"
           "Signed with a passkey through a WebAuthn assertion.\n\n"
           f"Signed-off-by: {fpr} <{email}>\n")
    head = (f"tree {EMPTY_TREE}\n"
            f"author {name} <{email}> {ts}\n"
            f"committer {fpr} <{email}> {ts}\n")
    payload = (head + "\n" + msg).encode()
    to_sign = b"SSHSIG" + s("git") + s("") + s("sha512") + s(hashlib.sha512(payload).digest())
    os.makedirs(WORK, exist_ok=True)
    run("git", "init", "-q", "-b", "main")
    publine = f"{SK_TYPE} {base64.b64encode(pub).decode()}"
    with open(os.path.join(WORK, "allowed_signers"), "w") as f:
        f.write(f'{email} namespaces="git" {publine}\n')
    with open(os.path.join(WORK, "passkey.pub"), "w") as f:
        f.write(publine + "\n")
    state.update(pub=pub, head=head, msg=msg, payload=payload, email=email)
    return {"fingerprint": fpr, "challenge": b64u(to_sign), "credentialId": body["credentialId"]}


def sign(body):
    auth = b64u_dec(body["authenticatorData"])
    client = b64u_dec(body["clientDataJSON"])
    r, s_ = der_ecdsa(b64u_dec(body["signature"]))
    flags, counter = auth[32], auth[33:37]
    assert auth[:32] == hashlib.sha256(RP_ID.encode()).digest(), "rpIdHash mismatch"
    sig = (s(SIG_TYPE) + s(mpint(r) + mpint(s_)) + bytes([flags]) + counter
           + s(ORIGIN) + s(client) + s(b""))
    blob = (b"SSHSIG" + struct.pack(">I", 1) + s(state["pub"]) + s("git") + s("")
            + s("sha512") + s(sig))
    b = base64.b64encode(blob).decode()
    armored = ["-----BEGIN SSH SIGNATURE-----"] + [b[i:i + 70] for i in range(0, len(b), 70)] + ["-----END SSH SIGNATURE-----"]
    gpgsig = "gpgsig " + "\n ".join(armored) + "\n"
    obj = (state["head"] + gpgsig + "\n" + state["msg"]).encode()
    _, oid = run("git", "hash-object", "-t", "commit", "-w", "--stdin", stdin=obj)
    oid = oid.strip()
    run("git", "update-ref", "refs/heads/main", oid)
    with open(os.path.join(WORK, "payload"), "wb") as f:
        f.write(state["payload"])
    with open(os.path.join(WORK, "payload.sig"), "w") as f:
        f.write("\n".join(armored) + "\n")
    rc1, out1 = run("ssh-keygen", "-Y", "verify", "-f", "allowed_signers", "-I", state["email"],
                    "-n", "git", "-s", "payload.sig", stdin=state["payload"])
    rc2, out2 = run("git", "-c", "gpg.format=ssh", "-c", "gpg.ssh.allowedSignersFile=allowed_signers",
                    "verify-commit", "-v", oid)
    rc3, out3 = run("git", "-c", "gpg.ssh.allowedSignersFile=allowed_signers", "log", "-1",
                    "--format=%H %G? %GK", oid)
    result = {"commit": oid, "flags": f"0x{flags:02x}", "clientDataJSON": client.decode(),
              "sshKeygen": {"rc": rc1, "out": out1}, "verifyCommit": {"rc": rc2, "out": out2},
              "log": out3.strip()}
    print(json.dumps(result, indent=2), flush=True)
    return result


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/":
            return self.send_error(404)
        data = open(os.path.join(HERE, "index.html"), "rb").read()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        try:
            out = {"/register": register, "/sign": sign}[self.path](body)
            code = 200
        except Exception as e:  # report to the page; the terminal shows it too
            out, code = {"error": repr(e)}, 500
            print("error:", repr(e), flush=True)
        data = json.dumps(out).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(data)


print(f"ceremony at {ORIGIN}, writing to {WORK}", flush=True)
HTTPServer(("127.0.0.1", PORT), H).serve_forever()
