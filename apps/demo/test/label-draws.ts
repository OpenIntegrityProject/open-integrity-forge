import { labelDraws } from "passkey-cloudflare/testing";
import { vi } from "vitest";

/** The label a pinned draw gives: three zero bytes. */
export const PINNED_LABEL = "able-able-able";
/** `PINNED_LABEL` as the labels table stores it. */
export const PINNED_LABEL_BYTES = new Uint8Array(3);

/** The label in the name a passkey was saved under, as its password manager shows it. */
export function savedLabel(credential: { userName: string }): string {
  return /\(([a-z-]+)\)$/.exec(credential.userName)![1]!;
}

/**
 * Make the next `count` labels drawn, or every one, `PINNED_LABEL`, through the
 * library's label-draw seam, leaving all other randomness alone. Returns the
 * number of label draws made so far. Undo it with `vi.restoreAllMocks()`.
 */
export function pinLabelDraws(count = Infinity): () => number {
  const real = labelDraws.draw.bind(labelDraws);
  let draws = 0;
  vi.spyOn(labelDraws, "draw").mockImplementation(() => {
    const bytes = real();
    draws++;
    return draws <= count ? bytes.fill(0) : bytes;
  });
  return () => draws;
}
