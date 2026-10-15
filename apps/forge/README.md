# Open Integrity Forge Demo

A demo Git forge on Cloudflare Workers and [Artifacts](https://developers.cloudflare.com/artifacts/), built on [Open Integrity](https://github.com/OpenIntegrityProject): validity lives in Git, not in the platform. Agents work at the same time, each in its own fork and with its own short-lived signing key. Only a person's passkey can promote a change to `main`, and it does so by signing the commit itself. Each repository starts with an Open Integrity inception commit and carries its own signer policy, so any clone can check every commit with no server, on any host, and stock `git verify-commit` checks every commit of `main`.

**Live demo:** https://forgedemo.gordianstack.com (sign in with a passkey, then "Play the story")

**Video:** https://www.youtube.com/watch?v=_KdOGtynXig (a seven-minute walkthrough of the demo)

The forge determines whether an authorized person intended each specific change. It does so not through a record on the platform, but with a signed object in Git, checked against the signer policy committed in the repository and rooted in its inception commit.

The forge is built on this repository's passkey library and reuses the demo's sign-in as is. The library offers ES256 before EdDSA, because only a P-256 passkey can make the SSH signature that Git checks.

## What it shows

1. **Your passkey signs the first commit.** It is an empty Open Integrity inception commit whose committer is your passkey's SSH key fingerprint, signed as an SSH signature that `git verify-commit` checks. Its hash becomes the repository's id and its decentralized identifier, `did:repo:<hash>`, which the History band shows with a copy button. The next commit, which your passkey also approves, sets the policy and names your passkey as the only promoter.
2. **You admit two agents, Ada and Bo.** Each gets an Ed25519 SSH key that lasts an hour and a fork of its own, with a write token for that fork only. The new rules need your approval too.
3. **The agents work at the same time.** Each signs its commits with its own key and proposes them. Every proposal is checked against the rules in the repository.
4. **Bo tries to make its own key a promoter.** The commit is validly signed, and the repository still rejects it: a key can never authorize itself.
5. **You promote Ada's change.** Your passkey signs the exact merge commit, both parents, the resulting tree, and the message, as an SSH signature that `git verify-commit` checks.
6. **Anyone checks it anywhere.** A fresh clone on a laptop, or a mirror on any Git host, gives the same answer, with no forge in the loop.

"Play the story" on the page walks through these steps, and stops where your passkey is needed. If you open a commit, go to another project or switch tabs, the story waits, and shows its place again when you come back.

Beyond the story, the page also lets you:

- **Revoke a key** (Rules): a policy change under your approval; the agent stops and its fork token stops working.
- **Release main** as an annotated tag that carries your approval.
- **Make two agents conflict** ("retitle the README"), see the second rejected at M, and "Redo on the new main".
- **Work from your laptop**: admit your own SSH key, get push commands, and push signed work that the forge verifies like an agent's.
- **Ask an agent to write a note with Claude**, when the deployment has an `ANTHROPIC_API_KEY` secret. The model sees the topic and the note names, never a key or a token, and its work is checked like any other.

## The rules

The policy is `.repo/config/verification/policy.json`. A commit is checked against the policy of its first parent, so it cannot change the rules it obeys.

| Rule | Statement |
| --- | --- |
| R0 | The first commit of main is the root of trust, and its hash is the repository id. It is an Open Integrity inception commit: empty, with the fingerprint of the passkey that signed it as its committer, and signed by that passkey as an SSH signature. |
| R1 | Each later commit of main carries an approval from a promoter in the policy of its first parent: the promoter's passkey signs the whole commit. The commit after the root sets the first policy, and the passkey that signed the root approves it. |
| R2 | Only a commit of main with such an approval changes `.repo/`. A key that a commit adds has no say over that commit. |
| R3 | Each other commit that main reaches carries a valid SSH signature from a key in the policy in force when it came in. |
| R4 | An approval names this repository, the ref, the parents and the tree of its own commit. |
| R5 | An author key signs only inside its validity window. |
| R6 | A key a promoter revoked signs nothing after its revocation; its earlier work still verifies. |
| R7 | Where the policy says `mergesOnly` (new projects do), a commit of main with one parent changes only `.repo/`, so no squash drops the authors' signatures. |
| R8 | A release tag of a main commit carries approvals of that tag from as many distinct promoters as `releaseApprovals` asks (one when absent). |
| M | A proposal merges into main with no conflicts (proposals only). |

### policy.json and Open Integrity's signer files

An Open Integrity repository such as [oi-demo](https://github.com/OpenIntegrityProject/oi-demo) keeps its signer policy as three OpenSSH allowed signers files in `.repo/config/verification/`: `allowed_commit_signers` for any commit, `allowed_main_signers` for `main`'s first-parent chain and for changes to those files, and `allowed_tag_signers` for release tags. Its verifier checks each commit against them with `ssh-keygen`, and this repository verifies itself the same way.

The forge keeps its rules in one file, `policy.json`, because it needs facts that an allowed-signers line cannot hold: a passkey promoter as a WebAuthn credential, the promoter that admitted each agent key, when a key was revoked, `mergesOnly`, and how many approvals a release takes. From that, the forge generates `allowed_commit_signers`, so stock Git checks every signature, but it writes no `allowed_main_signers` or `allowed_tag_signers`, and Open Integrity's verifier does not yet pass a forge repository. Writing those two files from the policy, so that one repository passes both verifiers, is the next step.

Each approval can also be read as a Gordian Envelope (the commit sheet shows its `ur:envelope`, and an elided form with the same digest that leaves out the authenticator data and signature); the encoder matches the reference `bc-envelope-cli` byte for byte. For a commit of `main` the assertion's challenge is the commit itself, so its Envelope is read together with that commit.

A promoter approves a change of `main` by signing the commit itself: a WebAuthn assertion whose challenge is the commit's SSHSIG data, stored as the commit's SSH signature in OpenSSH's `webauthn-sk-ecdsa-sha2-nistp256@openssh.com` format. The commit message ends with a `Forge-Approval` trailer holding a payload that names the repository, the ref, the parents and the tree, which the signature covers. A release tag carries approvals in its message instead: WebAuthn assertions whose challenge is the SHA-256 digest of such a payload. Agent commits carry ordinary SSH signatures, so `git verify-commit` checks every commit of main and every agent commit with the generated `.repo/config/verification/allowed_commit_signers`, which lists a P-256 passkey as the OpenSSH security key (`sk-ecdsa-sha2-nistp256@openssh.com`) it signs with.

## Layout

| Path | What |
| --- | --- |
| `authority/` | The verifier and what it needs: policy, approvals, SSH signatures, Git helpers. It needs no server and runs in Workers, Node and Bun. |
| `src/` | The Worker: routes (`forge.ts`), the `Project`, `AgentRun`, `Person`, `RepoIndex` and `LocalRepo` Durable Objects, the repo hosts, the push event consumer, the template and the agents' tasks. |
| `browser/` | The page: stage, history graph, approval and commit sheets, the story, the seal, and the stylesheet. |
| `scripts/` | `forge-verify.ts`, `smoke.ts`, `subscribe-pushes.ts`, `cleanup-artifacts.ts`, `check-production-bundle.ts`. |
| `wrangler.jsonc`, `wrangler.local.jsonc` | The deployed configuration, with Artifacts, and the local one, without. `scripts/config.test.ts` keeps them in step. |

## Run it locally

You need Node 23.6 or later and Git. No Cloudflare account is needed: locally, repositories live in Durable Objects that keep the Artifacts contract (repo-scoped tokens with a scope and an expiry, forks, pushes that must name the ref they replace).

```sh
npm install
npm run dev -w forge          # http://localhost:8787, with apps/forge/wrangler.local.jsonc
```

Open http://localhost:8787, register with a passkey, and create a project. Browsers allow passkeys on `localhost`.

Tests:

```sh
npm test -w forge                       # Node tests of the verifier, Worker tests, and the production bundle check
npm run typecheck -w forge
npx playwright install chromium         # once
npm run test:e2e -w forge               # the journey, the story and the GitHub mirror in Chromium
npm run smoke -w forge -- http://localhost:8787 --runs 2   # the whole story over HTTP, timed
```

| Suite | What it covers | Where it runs |
| --- | --- | --- |
| `authority/test/`, `scripts/*.test.ts` | Every rule, SSH signatures against `ssh-keygen` and `git verify-commit`, approvals, Git over HTTP against `git http-backend`, the config check, the cleanup script | Node |
| `test/` | Routes, guards, promoter-key capture, approvals, agents, proposals, push events, the event stream, the verifier pin | The Workers runtime, with the local repo host |
| `e2e/` | The page with a virtual authenticator; a real `git clone`, `forge-verify` and `git log --show-signature` on it; the mirror and its workflow steps | Chromium against `wrangler dev` |
| `e2e/a11y.spec.ts` | An axe audit (WCAG 2.1 AA) of every view, with the browser set to light and to dark | Chromium against `wrangler dev` |
| `scripts/smoke.ts` | The whole story over HTTP, with a release and a revocation | Any running forge, local or deployed |
| `scripts/push-check.ts`, `scripts/laptop-check.ts` | A push from outside the forge, and a person's signed push from a laptop, through Artifacts push events | The deployed forge, with wrangler logged in |

## Verify a repository with no forge

The verifier is one file, `forge-verify.mjs`, which the forge serves and each new repository pins by its SHA-256 digest in `.github/workflows/verify.yml`. On the page, "Show the commands" gives the exact commands with a read token. They look like this:

```sh
git clone https://<account>.artifacts.cloudflare.net/git/forge-demo/<repo>.git notes   # Artifacts asks for the token
curl -fsSLO https://<forge>/forge-verify.mjs
grep VERIFIER_SHA256 notes/.github/workflows/verify.yml       # the digest the repository pins
shasum -a 256 forge-verify.mjs                                # must match
node forge-verify.mjs notes --repo <the id of the first commit>
```

It prints each commit with its rules, and exits `0` when all of them pass, `1` when one fails. `--json` prints the full report. To use the source instead of the file, run `node apps/forge/scripts/forge-verify.ts` from this repository. Git alone checks the inception commit and the agents' signatures (in UTC, since under daylight saving time git on macOS checks a key's window an hour late):

```sh
TZ=UTC git -C notes -c gpg.ssh.allowedSignersFile=.repo/config/verification/allowed_commit_signers log --show-signature
```

## Mirrors

The verifier reads only the repository, so a mirror on any Git host gives the same answer as the forge. The forge can push one to GitHub itself, and this deployment leaves that off. When a deployment sets `MIRROR_OWNER` and the `GITHUB_TOKEN` secret, the page offers "Mirror to GitHub". It creates the private repository `<owner>/<repo>` if it is not there, sets its `FORGE_REPO_ID` variable, and force-pushes main as the forge holds it. The repository's workflow then fetches the pinned verifier and checks every commit on GitHub's runners. A commit pushed to the mirror by hand fails that check, and mirroring again puts main back. The token needs repository administration (to create the repository and its variable) and contents write access for that owner.

## Deploy

1. `npx wrangler login`.
2. The deployment is the Cloudflare account that holds gordianstack.com (`account_id` in `apps/forge/wrangler.jsonc`) at `forgedemo.gordianstack.com` (`routes`, `RP_ID`, `ORIGIN`). The account must be on Workers Paid: Artifacts refuses a Free account, and the passkey library needs Paid's CPU time too.
3. Create the queue for Artifacts push events, once: `npx wrangler queues create forge-artifacts-events`.
4. Optional secrets: `OPERATOR_RECORD_IDS`; `GITHUB_TOKEN` and a `MIRROR_OWNER` value for the mirror; `CF_API_TOKEN` (Queues edit) so the forge subscribes each new repository to push events itself; `ANTHROPIC_API_KEY` so agents can write notes with Claude. Set each with `npx wrangler secret put <NAME>`.
5. `npx wrangler deploy` from `apps/forge`. The first project creates the `forge-demo` Artifacts namespace.
6. Without `CF_API_TOKEN`, subscribe the queue to a project's repositories after it has its agents: `node scripts/subscribe-pushes.ts` (Artifacts sends push events per repository). Check them with `node scripts/push-check.ts https://<host>` and `node scripts/laptop-check.ts https://<host>`.
7. To deploy on promotion: in the dashboard, connect a project's repository to Workers Builds (Settings > Builds > Connect). New projects carry a `wrangler.jsonc` that serves their notes.
8. Smoke it: `node scripts/smoke.ts https://<host> --runs 2 --edge`.
9. When the demo is over: `node scripts/cleanup-artifacts.ts --dry-run`, then without `--dry-run`. Artifacts bills operations and storage from October 2026.

## Demo simplifications

- **The agents are scripted.** Their tasks are fixed so the demo runs the same way each time. They are forge objects, not library principals: the library's agent records and grants are future work.
- **One promoter per project**, the creator's passkey. The policy format and the verifier take more (R8 checks releases that need several), as well as SSH promoter keys; the page collects one approval per change.
- **Agents are forge objects**, not passkey-library principals: grants in the library are future work, and device-limited identities need hardware attestation the library does not ask for.
- **The page trusts the forge for the challenge.** The sheet shows the change and its message, but the passkey signs the challenge the forge sends; the page does not yet rebuild the commit and check it. A forge that showed one change and sent another would get a valid signature on the other, and no verifier could tell afterwards. Rebuilding the commit in the page closes this.
- **A release approval binds the repository, ref, commit and tree, not the tag message.** The platform could reword a release tag's message without breaking its approvals. A commit of main is signed as a whole, message and author included.
- **R5 and R6 trust the committer time**, which the signer writes. Short key windows and revocation limit this.
- **R0 trusts the first commit's own policy.** Pin the repository id (`--repo`) to know you have the right repository.
- **Merge commits only.** A squash would drop the agents' signatures.
- **The platform writes main.** It holds the only write token for the project repository and writes only with a verified approval. That is an operational choice: validity comes from the repository, and the verifier flags any commit the rules do not allow, whoever pushed it.
- **The verifier the workflow runs is served by the forge**, pinned by digest in the first commit. Rebuild it from source (`npm run build:verifier -w forge`) to compare the digest; the build is reproducible with the same dependency versions.

## License

BSD-2-Clause-Patent, as the rest of this repository. The bundled fonts (Bodoni Moda, Public Sans, IBM Plex Mono) are under the SIL Open Font License.
