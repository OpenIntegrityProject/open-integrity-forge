# Forge: agents write, a person promotes

A demo Git forge on Cloudflare Workers and [Artifacts](https://developers.cloudflare.com/artifacts/). Agents work at the same time, each in its own fork and with its own short-lived key. Only a person's passkey can promote a change to `main`. The proof of that approval lives in the repository, not on the platform, so any clone can check it with no server, on any host.

It asks the question from Tempo's [Human authorization in agentic workflows](https://tempo.xyz/developers/blog/human-authorization-in-agentic-workflows): did an authorized human intend this specific action? Tempo keeps the answer on its server. Here the answer is a signed object in Git, checked against a signer policy committed in the repository and rooted in its first commit.

The forge is built on this repository's passkey library and reuses the demo's sign-in as is. It changes neither.

## What it shows

1. **Your passkey approves the first commit.** Its hash becomes the repository's id. Its policy names your passkey as the only promoter.
2. **You admit two agents, Ada and Bo.** Each gets an Ed25519 SSH key that lasts an hour and a fork of its own, with a write token for that fork only. The new rules need your approval too.
3. **The agents work at the same time.** Each signs its commits with its own key and proposes them. The forge checks every proposal against the rules in the repository.
4. **Bo tries to make its own key a promoter.** The commit is validly signed, and the repository still rejects it: a key can never authorize itself.
5. **You promote Ada's change.** Your passkey approves the exact merge: both parents and the resulting tree.
6. **Anyone checks it anywhere.** A fresh clone, a laptop or a GitHub mirror gives the same answer, with no forge in the loop.

"Play the story" on the page walks through these steps, and stops where your passkey is needed.

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
| R0 | The first commit of main is the root of trust. Its approval verifies against the promoter key in its own policy. Its hash is the repository id. |
| R1 | Each later commit of main carries an approval from a promoter in the policy of its first parent. |
| R2 | Only a commit of main with such an approval changes `.repo/`. A key that a commit adds has no say over that commit. |
| R3 | Each other commit that main reaches carries a valid SSH signature from a key in the policy in force when it came in. |
| R4 | An approval names this repository, the ref, the parents and the tree of its own commit. |
| R5 | An author key signs only inside its validity window. |
| R6 | A key a promoter revoked signs nothing after its revocation; its earlier work still verifies. |
| R7 | Where the policy says `mergesOnly` (new projects do), a commit of main with one parent changes only `.repo/`, so no squash drops the authors' signatures. |
| R8 | A release tag of a main commit carries approvals of that tag from as many distinct promoters as `releaseApprovals` asks (one when absent). |
| M | A proposal merges into main with no conflicts (proposals only). |

Each approval can also be read as a Gordian Envelope (the commit sheet shows its `ur:envelope`, and an elided form with the same digest that leaves out the authenticator data and signature); the encoder matches the reference `bc-envelope-cli` byte for byte.

An approval is a WebAuthn assertion. Its challenge is the SHA-256 digest of a payload that names the repository, the ref, the parents and the tree. It is stored in the commit message as a `Forge-Approval` trailer. Agent commits carry ordinary SSH signatures, so `git verify-commit` also checks them with the generated `.repo/config/verification/allowed_commit_signers`.

## Run it locally

You need Node 23.6 or later, and Git. No Cloudflare account is needed: locally, repositories live in Durable Objects that keep the Artifacts contract (repo-scoped tokens with a scope and an expiry, forks, pushes that must name the ref they replace).

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
| `e2e/a11y.spec.ts` | An axe audit (WCAG 2.1 AA) of every view in light and dark mode | Chromium against `wrangler dev` |
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

It prints each commit with its rules, and exits 0 when all of them pass, 1 when one fails. `--json` prints the full report. To use the source instead of the file, run `node apps/forge/scripts/forge-verify.ts` from this repository. Git alone checks the agents' signatures:

```sh
git -C notes -c gpg.ssh.allowedSignersFile=.repo/config/verification/allowed_commit_signers log --show-signature
```

## The GitHub mirror

When the deployment sets `MIRROR_OWNER` and the `GITHUB_TOKEN` secret, the page offers "Mirror to GitHub". It creates the private repository `<owner>/<repo>` if it is not there, sets its `FORGE_REPO_ID` variable, and force-pushes main as the forge holds it. The repository's workflow then fetches the pinned verifier and checks every commit on GitHub's runners. A commit pushed to the mirror by hand fails that check, and mirroring again puts main back. The token needs repository administration (to create the repository and its variable) and contents write access for that owner.

## Deploy

1. `npx wrangler login`.
2. The deployment is the BCTS Cloudflare account (`account_id` in `apps/forge/wrangler.jsonc`) at `forge.bcts.dev` (`routes`, `RP_ID`, `ORIGIN`). The account must be on Workers Paid: Artifacts refuses a Free account, and the passkey library needs Paid's CPU time too.
3. Create the queue for Artifacts push events, once: `npx wrangler queues create forge-artifacts-events`.
4. Optional secrets: `OPERATOR_RECORD_IDS`; `GITHUB_TOKEN` and a `MIRROR_OWNER` value for the mirror; `CF_API_TOKEN` (Queues edit) so the forge subscribes each new repository to push events itself; `ANTHROPIC_API_KEY` so agents can write notes with Claude. Set each with `npx wrangler secret put <NAME>`.
5. `npx wrangler deploy` from `apps/forge`. The first project creates the `forge-demo` Artifacts namespace.
6. Without `CF_API_TOKEN`, subscribe the queue to a project's repositories after it has its agents: `node scripts/subscribe-pushes.ts` (Artifacts sends push events per repository). Check them with `node scripts/push-check.ts https://<host>` and `node scripts/laptop-check.ts https://<host>`.
7. To deploy on promotion: in the dashboard, connect a project's repository to Workers Builds (Settings > Builds > Connect). New projects carry a `wrangler.jsonc` that serves their notes.
8. Smoke it: `node scripts/smoke.ts https://<host> --runs 2 --edge`.
9. When the demo is over: `node scripts/cleanup-artifacts.ts --dry-run`, then without `--dry-run`. Artifacts bills operations and storage from October 2026.

## Demo simplifications

- **The agents are scripted.** Their tasks are fixed so the demo runs the same way each time. They are forge objects, not library principals: the library's agent records and grants are future work.
- **One promoter per project**, the creator's passkey. The policy format and the verifier take more (R8 checks releases that need several), and SSH promoter keys too; the page collects one approval per change.
- **Agents are forge objects**, not passkey-library principals: grants in the library are future work, and device-limited identities need hardware attestation the library does not ask for.
- **An approval binds the repository, ref, parents and tree, not the commit message or author fields.** The platform could reword a promotion's message without breaking its approval.
- **R5 and R6 trust the committer time**, which the signer writes. Short key windows and revocation limit this.
- **R0 trusts the first commit's own policy.** Pin the repository id (`--repo`) to know you have the right repository.
- **Merge commits only.** A squash would drop the agents' signatures.
- **The platform writes main.** It holds the only write token for the project repository and writes only with a verified approval. That is an operational choice: validity comes from the repository, and the verifier flags any commit the rules do not allow, whoever pushed it.
- **The verifier the workflow runs is served by the forge**, pinned by digest in the first commit. Rebuild it from source (`npm run build:verifier -w forge`) to compare the digest; the build is reproducible with the same dependency versions.

## Layout

| Path | What |
| --- | --- |
| `authority/` | The verifier and what it needs: policy, approvals, SSH signatures, Git helpers. It needs no server and runs in Workers, Node and Bun. |
| `src/` | The Worker: routes (`forge.ts`), the `Project`, `AgentRun`, `Person`, `RepoIndex` and `LocalRepo` Durable Objects, the repo hosts, the push event consumer, the template and the agents' tasks. |
| `browser/` | The page: stage, history graph, approval and commit sheets, the story, the seal, and the stylesheet. |
| `scripts/` | `forge-verify.ts`, `smoke.ts`, `subscribe-pushes.ts`, `cleanup-artifacts.ts`, `check-production-bundle.ts`. |
| `wrangler.jsonc`, `wrangler.local.jsonc` | The deployed configuration, with Artifacts, and the local one, without. `scripts/config.test.ts` keeps them in step. |

The plan, decisions and progress are in [`docs/forge-demo-plan.md`](../../docs/forge-demo-plan.md).

## License

BSD-2-Clause-Patent, as the rest of this repository. The bundled fonts (Bodoni Moda, Public Sans, IBM Plex Mono) are under the SIL Open Font License.
