# Open Integrity Forge

**A Git platform for agents in which the platform cannot make a commit valid.**

When an agent can open a pull request, run a review and trigger a deploy, every system downstream sees a valid login. None of them can answer the question that matters: *did a person who is allowed to approve this actually intend this specific change?* If the platform answers that question, the platform holds the power, and whoever compromises the platform holds it too.

Open Integrity Forge moves that authority out of the platform and into the repository. Validity lives in Git:

- Every repository starts with a **signed first commit**, its root of trust. Its hash is the repository's id.
- The rules for who may sign what are **files committed in the repository**, and each commit is judged by the rules in force *before* it, so a key can never authorize itself.
- Agents work **at the same time, each in its own fork**, each signing with its **own key that lasts an hour**. They can write, sign and propose freely. They cannot merge.
- A change reaches `main` only when **a person approves that exact change** with a passkey: both parents and the resulting tree.
- **Anyone with a clone can check the whole history, on any host, with no forge in the loop.** Cloudflare hosts the repositories and GitHub can mirror them; neither can make a commit valid.

It runs on [Cloudflare Workers](https://developers.cloudflare.com/workers/), [Durable Objects](https://developers.cloudflare.com/durable-objects/), [Queues](https://developers.cloudflare.com/queues/) and [Artifacts](https://developers.cloudflare.com/artifacts/). It is part of the [Open Integrity Project](https://github.com/OpenIntegrityProject), a [Blockchain Commons](https://www.blockchaincommons.com) project.

**Live demo:** https://LIVE-DEMO-HOST (sign in with a passkey, then "Play the story")

## What the demo shows

1. **Your passkey approves the first commit.** Its hash becomes the repository's id, and the rules in it name your passkey as the only promoter.
2. **You admit two agents, Ada and Bo.** Each gets an Ed25519 SSH key that lasts an hour and a fork of its own, with a write token for that fork only. Changing the rules needs your approval too.
3. **The agents work at the same time.** Each signs its commits with its own key and proposes them. Artifacts push events reach a Queue, and the forge checks every proposal against the rules in the repository.
4. **Bo tries to make its own key a promoter.** The commit is validly signed, and the repository still rejects it: a key can never authorize itself.
5. **You promote Ada's change.** Your passkey approves the exact merge, and the approval is stored in the commit.
6. **Anyone checks it anywhere.** A fresh clone, a laptop or a GitHub mirror gives the same answer.

The page also lets you revoke an agent's key, release `main` as a tag that carries your approval, make two agents conflict and redo the loser on the new `main`, push signed work from your own laptop, and, where the deployment has an Anthropic API key, ask an agent to write a note with Claude. Every one of these is checked by the same rules.

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
| R7 | Where the policy says `mergesOnly`, a commit of main with one parent changes only `.repo/`, so no squash drops the authors' signatures. |
| R8 | A release tag of a main commit carries approvals of that tag from as many distinct promoters as `releaseApprovals` asks. |
| M | A proposal merges into main with no conflicts (proposals only). |

An approval is a WebAuthn assertion whose challenge is the SHA-256 digest of a payload naming the repository, the ref, the parents and the tree. It is stored in the commit message as a `Forge-Approval` trailer, and can also be read as a [Gordian Envelope](https://developer.blockchaincommons.com/envelope/).

## Check a repository with no forge

The verifier is one file, `forge-verify.mjs`, which each new repository pins by its SHA-256 digest. "Show the commands" on the page gives the exact commands with a read-only token that lasts an hour:

```sh
git clone https://<account>.artifacts.cloudflare.net/git/forge-demo/<repo>.git notes
curl -fsSLO https://<forge>/forge-verify.mjs
shasum -a 256 forge-verify.mjs          # must match the digest the repository pins
node forge-verify.mjs notes --repo <the id of the first commit>
```

It needs Node 22 or later, prints each commit with its rules, and exits 0 when all pass. Git alone checks the agents' signatures:

```sh
git -C notes -c gpg.ssh.allowedSignersFile=.repo/config/verification/allowed_commit_signers log --show-signature
```

Stock Git checks the agents' commits, which carry ordinary SSH signatures. The promotions on `main` carry passkey approvals in a trailer, which only `forge-verify` reads today; see "What this does not do yet".

## Run it locally

You need Node 23.6 or later and Git. No Cloudflare account is needed: locally, repositories live in Durable Objects that keep the Artifacts contract.

```sh
npm install
npm run dev -w forge          # http://localhost:8787
```

Open http://localhost:8787, register with a passkey and create a project. Browsers allow passkeys on `localhost`. Tests, deployment and the GitHub mirror are described in [apps/forge/README.md](apps/forge/README.md).

## What this does not do yet

- **Promotions are not yet Git signatures.** A passkey can produce a WebAuthn signature that stock OpenSSH verifies as an SSH signature ([experiments/webauthn-sshsig/](experiments/webauthn-sshsig/)), so the next step is to store the approval as the merge commit's own signature, letting `git verify-commit` check every commit on `main`. A real browser ceremony in that format is still to be run.
- **User verification is not enforced for passkey signatures in Git.** OpenSSH's `allowed_signers` has no `verify-required` option, so a passkey signature without user verification would be accepted like one with it.
- **An approval binds the repository, ref, parents and tree, not the commit message or author fields.** The platform could reword a promotion's message without breaking its approval.
- **Signer times can be backdated.** Key windows and revocation are judged by the committer time, which the signer writes; short windows limit this, and a trusted timestamp would close it.
- **One promoter per project.** The policy and the verifier accept several, and releases that need more than one approval; the page collects one approval per change.
- **The agents are scripted**, so the demo runs the same way each time, apart from the optional note written with Claude. A signature proves which key signed, not which model produced the change.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the trust model and where this goes next.

## Credits

- **Christopher Allen** ([@ChristopherA](https://github.com/ChristopherA)), Blockchain Commons: architect of Open Integrity and of this forge, and author of [passkey-cloudflare](https://github.com/BlockchainCommons/passkey-cloudflare), the passkey-only identity library the forge's sign-in and approvals are built on.
- **Leonardo Custodio** ([@leonardocustodio](https://github.com/leonardocustodio)): built the forge demo, its verifier, its page and its tests.

## License

Unless otherwise noted, all files are ©2026 Open Integrity Project / Blockchain Commons, LLC, and licensed under the [BSD-2-Clause Plus Patent License](https://spdx.org/licenses/BSD-2-Clause-Patent.html). See [LICENSE.md](LICENSE.md). The bundled fonts (Bodoni Moda, Public Sans, IBM Plex Mono) are under the SIL Open Font License.
