// The browser's passkeys for the forge page. They work as the passkeys of the
// demo page do. Only one WebAuthn request runs at a time, and `run` (the
// forge's `lend`) runs each request except autofill. They also keep the registration response
// of each passkey that they make. The forge reads the promoter key from that
// response, because only a registration contains the public key.

import {
  autofillPasskey,
  createPasskey,
  findPasskey,
  usePasskey,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "passkey-cloudflare/browser";
import type { Authenticator, GetMode } from "../../demo/browser/demo-client.ts";
import { AutofillRequests, type RunPasskeyRequest } from "../../demo/browser/flows.ts";

export class ForgePasskeys implements Authenticator {
  readonly autofillRequests = new AutofillRequests();
  /** The registration response of the last passkey made on this page, until `takeCreated` reads it. */
  private created: RegistrationResponseJSON | null = null;
  private readonly run: RunPasskeyRequest;

  constructor(run: RunPasskeyRequest) {
    this.run = run;
  }

  async create(options: PublicKeyCredentialCreationOptionsJSON) {
    this.autofillRequests.stop();
    const result = await this.run(() => createPasskey(options));
    if (result.result === "created") this.created = result.response;
    return result;
  }

  get(options: PublicKeyCredentialRequestOptionsJSON, mode: GetMode) {
    if (typeof mode === "object") {
      const found = autofillPasskey(options, mode.autofill);
      this.autofillRequests.waiting();
      return found;
    }
    this.autofillRequests.stop();
    return this.run(() => (mode === "find" ? findPasskey(options) : usePasskey(options)));
  }

  /** Request an approval: an ordinary passkey request, with options that the forge made for one change. */
  approve(options: PublicKeyCredentialRequestOptionsJSON) {
    this.autofillRequests.stop();
    return this.run(() => usePasskey(options));
  }

  /** Return the registration response of the last passkey made here. A second call returns null. */
  takeCreated(): RegistrationResponseJSON | null {
    const created = this.created;
    this.created = null;
    return created;
  }
}
