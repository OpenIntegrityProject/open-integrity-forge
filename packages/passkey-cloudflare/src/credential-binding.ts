import type { CredentialLabels } from "./app-tier/labels.ts";
import type { CredentialIndex } from "./identity/credential-index.ts";
import type { RecordId } from "./identity/secrets.ts";
import { CeremonyRefusal } from "./refusal.ts";

// Binding a new credential to a record, for every ceremony that adds one:
// register, enrol, recover and rebind. The order is fixed: index the
// credential id, bind the label, then let the ceremony commit to its record.
// The label is bound before the record commits, so that every passkey a
// record holds is listed under the label its password manager saved it under.
// If any step is refused or throws, everything done so far is undone, and the
// ceremony is refused for that first reason.

export interface CredentialBindingStores {
  index: () => DurableObjectStub<CredentialIndex>;
  labels: (recordId: RecordId) => DurableObjectStub<CredentialLabels>;
  /** The RP ID every new credential is made for. */
  rpId: string;
}

export interface NewCredentialBinding<T> {
  recordId: RecordId;
  credentialId: string;
  label: string;
  now: number;
  /** Commit the credential to the record. Throws to refuse the ceremony. */
  commit: () => Promise<T>;
  /** What the ceremony did before binding and must undo if it is refused. */
  undo?: () => Promise<void>;
}

export function credentialBinding(stores: CredentialBindingStores) {
  /**
   * Run every undo step, even when one throws. A failed step is logged and
   * left: the ceremony is refused for its first reason all the same.
   */
  async function undoAll(steps: Array<() => Promise<void>>) {
    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        console.error("passkey ceremony undo step failed; leaving it", error);
      }
    }
  }

  /**
   * Bind the label, or answer false when it is taken or the bind failed. A
   * label bound for a ceremony the record then refuses names no passkey and is
   * never reissued.
   */
  async function bindLabel(recordId: RecordId, label: string, credentialId: string, now: number) {
    try {
      return await stores.labels(recordId).bind(label, credentialId, now);
    } catch (error) {
      console.error("passkey label bind failed; refusing the ceremony", error);
      return false;
    }
  }

  return async function bindNewCredential<T>(request: NewCredentialBinding<T>): Promise<T> {
    const undo: Array<() => Promise<void>> = request.undo ? [request.undo] : [];
    try {
      if (!(await stores.index().put(request.credentialId, request.recordId, stores.rpId))) {
        throw new CeremonyRefusal("credential-exists");
      }
      undo.unshift(() => stores.index().delete(request.credentialId));
      if (!(await bindLabel(request.recordId, request.label, request.credentialId, request.now))) {
        throw new CeremonyRefusal("label-unbound");
      }
      return await request.commit();
    } catch (error) {
      await undoAll(undo);
      throw error;
    }
  };
}
