# WebAuthn assertions as Git signatures

Can a passkey sign a Git commit that stock tools verify? OpenSSH defines a signature type, `webauthn-sk-ecdsa-sha2-nistp256@openssh.com`, for exactly the bytes a browser's WebAuthn assertion produces: authenticator data, `clientDataJSON`, and an ECDSA P-256 signature over both. If the assertion's challenge is the SSHSIG "data to be signed", `ssh-keygen -Y verify` checks it like any other SSH signature, and so does Git.

`webauthn_sshsig.py` builds such a signature with a software P-256 key, laid out exactly as a browser assertion would be, so the verifier side can be tested without a real authenticator:

```sh
uv run --no-project --with cryptography python webauthn_sshsig.py <keydir> <message> <flags-hex> [rp-id] > sig
ssh-keygen -Y verify -f allowed_signers -I <principal> -n git -s sig < message
```

The public key is an `sk-ecdsa-sha2-nistp256@openssh.com` key whose application string is the relying party ID, since OpenSSH compares the SHA-256 of the application with the authenticator data's `rpIdHash`.

## Findings

| Test | Result |
|---|---|
| SSHSIG over a file, flags `05` (user present and verified) | `Good "git" signature ... ECDSA-SK key` |
| Same signature, message altered | rejected |
| A commit object carrying the signature as `gpgsig`, listed in `allowed_commit_signers` and `allowed_main_signers` | the Open Integrity verifier reports it OK as a main signer |
| Same, flags `01` (user present, not verified) | also OK: nothing checks user verification |

So a passkey can sign merges to main today, with no change to Git or OpenSSH. Two gaps remain before a passkey signature can stand for "a person verified themselves":

- `allowed_signers` accepts only `cert-authority`, `namespaces`, `valid-after` and `valid-before`; OpenSSH's `verify-required` is an `authorized_keys` option. Requiring user verification has to be done by the repository's own verifier.
- The Open Integrity verifier reads authenticator flags only from signature types that begin with `sk-`, so it reports none for `webauthn-sk-` signatures.

## A real passkey ceremony

`ceremony/` runs the same test with a real passkey in a browser. `server.py` (standard library only) serves `index.html` on `http://localhost:8790`. The page creates a P-256 passkey, the server builds an empty inception commit whose committer is the key's fingerprint, the page signs that commit's SSHSIG data as the WebAuthn challenge, and the server stores the assertion as the commit's `gpgsig`:

```sh
python3 ceremony/server.py <workdir>          # then open http://localhost:8790
git -C <workdir> -c gpg.ssh.allowedSignersFile=allowed_signers verify-commit main
```

| Test | Result |
|---|---|
| Inception commit signed by a passkey in Chrome on macOS with Touch ID, flags `1d` (present, verified, backup eligible, backed up) | `git verify-commit`: `Good "git" signature ... ECDSA-SK key`; `%G?` is `G` |
| Same signature, one word of the message changed | rejected by `ssh-keygen -Y verify` |
| A software key standing in for the browser, through the same server | accepted; with `clientDataJSON` altered after signing, rejected |

Chrome added a field, `other_keys_can_be_added_here`, to `clientDataJSON`, as it does at random to discourage parsing it against a template. OpenSSH still accepted the signature, so an extra trailing field does not matter to it, while the signature covers every byte of the JSON. A signer must store `clientDataJSON` exactly as the browser returned it.

`ceremony/result/` holds that run: the commit as a bundle and as text, the public key, the signed payload and its signature, and the `allowed_signers` line that verifies them.
