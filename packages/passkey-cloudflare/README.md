# passkey-cloudflare

Blockchain Commons' passkey-only identity library for collaborative web apps on Cloudflare Workers and Durable Objects. The forge signs people in and collects every approval with it.

The library answers one question, which principal is presenting, and leaves what that principal may do to the application; in the forge, the repository's own rules decide. It deploys inside each application's own Worker and keeps identity in Durable Objects, so no identity provider, password or email address stands between a person and their account. Every person can hold several passkeys from their first registration, recovery never falls back to passwords or email, and every failed ceremony gets the same response. It offers ES256 before EdDSA, because only a P-256 passkey can make the SSH signature that Git checks.

This folder carries the library's code as of upstream commit 1cf0f2a. Its history, documentation and architectural decisions are in [BlockchainCommons/passkey-cloudflare](https://github.com/BlockchainCommons/passkey-cloudflare); changes go there.
