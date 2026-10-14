# Security

Open Integrity Forge lets a commit reach `main` only when a promoter signs it with a passkey. The security of that approval rests on three things: the passkey, the standards it uses, and what this forge asks the passkey to sign. The standards publish their own security analyses, linked below; the rest of this page covers what the forge adds and where it falls short.

## What an approval signs

A promoter approves a change of `main` by signing the commit itself. The browser makes a WebAuthn assertion whose challenge is the commit's SSHSIG signed data, and the forge stores it as the commit's SSH signature in OpenSSH's `webauthn-sk-ecdsa-sha2-nistp256@openssh.com` format. The signed data is the whole commit object: both parents, the tree, the author and the message. The commit message ends with a `Forge-Approval` trailer naming the repository, the ref, the parents and the tree, so an approval cannot be moved to another repository or ref.

A release is approved differently: its approvals sit in the tag message and cover the repository, the ref, the commit and the tree. They do not cover the rest of the tag message.

Agents never hold a promoter key. The key stays in the person's authenticator, and every approval takes a gesture there.

## The standards underneath

These documents cover the security of the building blocks, and this page does not repeat them:

- [Web Authentication Level 3, Security Considerations](https://www.w3.org/TR/webauthn-3/#sctn-security-considerations): phishing resistance, attestation, [credential loss and key mobility](https://www.w3.org/TR/webauthn-3/#sctn-credential-loss-key-mobility), [code injection](https://www.w3.org/TR/webauthn-3/#sctn-code-injection), and the [backup state of a credential](https://www.w3.org/TR/webauthn-3/#sctn-credential-backup) that marks a synced passkey.
- [OpenSSH's FIDO and WebAuthn key formats](https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.u2f): how a WebAuthn signature is carried as an SSH signature.
- [ssh-keygen, ALLOWED SIGNERS](https://man.openbsd.org/ssh-keygen#ALLOWED_SIGNERS): the file stock Git checks commit signatures against.
- [Git's hash function transition](https://git-scm.com/docs/hash-function-transition): Git's object names and its move from SHA-1 to SHA-256.

## The forge chooses what the passkey signs

This is the largest gap. An authenticator shows no content: it asks for a touch or a biometric, never for agreement to a particular commit. The page shows the approval sheet, the parents, the tree and the full message, but the challenge the passkey signs comes from the forge, and the page does not rebuild the commit from what it shows and compare. A compromised forge could therefore show one change and have the passkey sign another.

WebAuthn's code-injection section assumes the relying party itself is honest. Here the relying party is the forge, and it also serves the page, so checking the challenge in that page would not help against a forge that serves a different page. The gap closes only with a signer the forge does not control: a command-line tool or a browser extension that rebuilds the commit object from the change, computes the signed data itself, and only then asks the authenticator to sign.

Verification does not depend on the forge. Anyone can check every approval from a clone with `forge-verify` or stock Git, so a forge that tricked a promoter leaves a signed commit that shows exactly what was approved.

## Other limits

| Limit | What follows | What would close it |
| --- | --- | --- |
| Any passkey can be a promoter key, synced or device-bound. | A synced passkey is as safe as the account it syncs through. The forge records each passkey's backup state but does not act on it, and requests no attestation, so it cannot tell what made a key. | A policy that accepts only device-bound promoter keys, read from the backup state at enrolment. |
| Stock Git cannot require user verification. | `forge-verify` rejects a passkey signature without the user-verified flag. `git verify-commit` accepts one made with a touch alone, because an allowed-signers file has no option to require it. | Checking with `forge-verify`, or an OpenSSH option for allowed signers. |
| The signer writes the commit time. | Key windows and revocation are judged by that time, so a stolen promoter key can sign commits dated before its revocation. | A trusted timestamp on each approval. |
| One promoter per project. | Losing the passkey stops promotion; compromising it gives control of `main`. The policy and the verifier accept several promoters and releases that need several approvals, but the page collects one approval per change. | Collecting approvals from several promoters. |
| A passkey belongs to the forge's domain, its relying-party ID. | A forge that moves to another domain cannot use its promoters' existing passkeys. Everything they signed still verifies. | Enrolling new promoter keys by a rule change before the move. |
| Git names objects by SHA-1. | An approval names the tree and parents by SHA-1, so it is as strong as Git's collision-detecting SHA-1. The inception commit is empty for this reason. | SHA-256 repositories. |
| A release approval does not cover the tag message. | The message of a release tag can change without breaking its approvals. | Binding the tag message into the approval. |
