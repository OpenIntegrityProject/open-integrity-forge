# Notes for Cloudflare

Two findings from building Open Integrity Forge on Cloudflare matter most to the teams that make these products. Artifacts push events need a subscription for each repository, made with an account API token. Some Durable Object and Artifacts calls waited 13 to 26 seconds while using almost no CPU. Each note says what the forge does about it, and the first says what would help. The README's [How it uses Cloudflare](../README.md#how-it-uses-cloudflare) says what each product does in the forge.

## Push events need a subscription for each repository

Artifacts sends `pushed` events only to a subscription for one repository, and a subscription is made through the Cloudflare API, not the `ARTIFACTS` binding. The forge makes a repository for each project and a fork for each agent, so it has to make a subscription for each of them as it goes, and remove each when it deletes the repository (`apps/forge/src/subscriptions.ts`). That needs a Cloudflare API token for the account in the Worker's secrets, `CF_API_TOKEN`.

**What would help:** a subscription for a whole namespace, or a way for the `ARTIFACTS` binding to subscribe to a repository it created. Either would let a Worker hear every push with no account API token in its secrets.

## Why the live demo does not check laptop pushes

The live demo does not set `CF_API_TOKEN`. The forge then makes no push subscriptions, so it hears no push it did not make itself. Pushes by the forge and its agents are checked as they happen, because the agents propose to the forge directly. A push from a laptop is not checked until a subscription exists, and the page says so.

The token stays off because the live demo is a public site running unattended in maintenance mode. The forge would then hold an account API token, a credential that reaches beyond its own repositories, and every visitor's project would add subscriptions for the forge to clean up. A deployment that wants laptop pushes sets the token, or runs `apps/forge/scripts/subscribe-pushes.ts` for a project after its agents are admitted. `apps/forge/scripts/laptop-check.ts` tests the whole path: on 2026-10-16, with a subscription made by hand, a signed laptop push was verified within 5 seconds of the push and then promoted.

## Some calls waited tens of seconds with almost no CPU

Workers Observability for the live demo, over the week to 2026-10-23, recorded these slowest calls. From the forge's side there is no telling whether the time went to starting the object, to its subrequests or to storage.

| Call | When (UTC) | Wall time | CPU time |
| --- | --- | --- | --- |
| A passkey challenge from the passkey library's `ChallengeStore` Durable Object | 2026-10-23 04:37 | 26.3 s | 0 ms |
| `POST /auth/step-up/options`, which issues such a challenge | 2026-10-23 15:32 | 13.2 s | 1 ms |
| Deleting a project, in the `Project` Durable Object, which removes its agents and its repositories in Artifacts | 2026-10-23 15:32 | 22.2 s | 3 ms |

A person waiting that long with no sign of progress thinks the page has stopped. The forge now shows a working bar and a status line while a request is slow, asks for the passkey again (a step-up) before an action that needs a fresh one, rather than after the server refuses, and deletes repositories from a Durable Object alarm after the project is gone, retrying any that fail (`Project.alarm` in `apps/forge/src/project.ts`).

## Smaller notes

- **`createToken` takes a lifetime of 60 seconds or more.** The forge raises anything shorter to 60 seconds, and asks for two minutes when it reads or writes a repository itself.
- **`delete` returns false for a repository that does not exist.** It does not throw, so a retried delete passes over a repository that is already gone.
- **Artifacts needs Workers Paid.** The passkey library needs Paid too, for CPU time.
- **Deleting a Worker that once held a custom domain can remove the domain's DNS record**, while the dashboard still shows the domain attached. Attaching the domain again fixed it. A local resolver can cache the failure, so check the host over DNS-over-HTTPS.
- **Artifacts bills operations and storage from October 2026.** `apps/forge/scripts/cleanup-artifacts.ts --dry-run` lists what a deployment would remove when a demo ends.
