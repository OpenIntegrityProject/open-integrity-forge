import { randomBytes } from "../encoding.ts";

/** A credential label's length in bytes. */
export const LABEL_BYTES = 3;

/**
 * Where every credential label's bytes are drawn, so a test can choose them by
 * replacing `draw` (with `vi.spyOn`, as the demo's `pinLabelDraws` does). Only
 * code can replace it: nothing here reads a var, secret or binding, so no
 * deployment's configuration can make labels predictable. It lives apart from
 * the labels object so that `passkey-cloudflare/testing` can export it to Node.
 */
export const labelDraws = {
  draw(): Uint8Array<ArrayBuffer> {
    return randomBytes(LABEL_BYTES);
  },
};
