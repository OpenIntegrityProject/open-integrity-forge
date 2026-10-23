# Notes for Cloudflare

What building Open Integrity Forge on Workers, Durable Objects, Queues and Artifacts taught, for the teams that make them. Each note says what the forge does about it. The README's [How it uses Cloudflare](../README.md#how-it-uses-cloudflare) says what each product does in the forge.

## Push events need a subscription for each repository

Artifacts sends `pushed` events only to a subscription for one repository, and a subscription is made through the Cloudflare API, not the `ARTIFACTS` binding. The forge makes a repository for each project and a fork for each agent, so it has to make a subscription for each of them as it goes, and remove each when it deletes the repository (`apps/forge/src/subscriptions.ts`). That needs a Cloudflare API token for the account in the Worker's secrets, `CF_API_TOKEN`.

A subscription for a whole namespace, or one the binding can make for a repository it created, would let a Worker hear every push with no API token.

## Why the live demo does not check laptop pushes

The live demo does not set `CF_API_TOKEN`. The forge then makes no push subscriptions, so it hears no push it did not make itself. Pushes by the forge and its agents are checked as they happen, because the agents propose to the forge directly. A push from a laptop is not checked until a subscription exists, and the page says so.

The token stays off because the live demo is a public site running unattended in maintenance mode. A Cloudflare API token in its secrets would reach the account's queues and subscriptions, not just this forge's, and every visitor's project would add subscriptions for the forge to clean up. A deployment that wants laptop pushes sets the token, or runs `apps/forge/scripts/subscribe-pushes.ts` for a project after its agents are admitted. `apps/forge/scripts/laptop-check.ts` tests the whole path: on 2026-10-16, with a subscription made by hand, a signed laptop push was verified in 5 seconds and promoted.

## Cold first requests can take tens of seconds

After a quiet period, the first request to a Durable Object or to Artifacts can wait a long time while using almost no CPU. Workers Observability for the live demo, over the week to 2026-10-23, recorded:

| Call | Wall time | CPU time |
| --- | --- | --- |
| A passkey challenge from the passkey library's `ChallengeStore` Durable Object | 26.3 s | 0 ms |
| `POST /auth/step-up/options`, which issues such a challenge | 13.2 s | 1 ms |
| Deleting a project, in the `Project` Durable Object, which removes its agents and its repositories in Artifacts | 22.2 s | 3 ms |

A person waiting that long with no sign of progress thinks the page has stopped. The forge now shows a working bar and a status line while a request is slow, steps up before an action that needs it rather than after a refusal, and deletes repositories from a Durable Object alarm after the project is gone, retrying any that fail (`Project.alarm` in `apps/forge/src/project.ts`).

## Smaller notes

- **Artifacts pushes are fast-forward only.** The forge writes `main` by pushing a merge commit that a promoter signed, so this fits.
- **A repository token lasts 60 seconds at least.** The forge asks for two minutes when it reads or writes the project repository itself, and never for less than 60 seconds.
- **Deleting a repository that is not there returns false.** It does not throw, so a retried delete passes over a repository that is already gone.
- **Artifacts refuses a Workers Free account.** The passkey library also needs the CPU time of Workers Paid.
- **Renaming a Worker can drop the custom domain's DNS record.** Deleting a Worker that once held the domain removed its DNS record while the dashboard still showed the domain attached. The fix was to attach the domain again. A local resolver can cache the failure, so check the host over DNS-over-HTTPS.
- **Artifacts bills operations and storage from October 2026.** `apps/forge/scripts/cleanup-artifacts.ts --dry-run` lists what a deployment would remove when a demo ends.
