// The promoter's seal, in the shape and colours of the Open Integrity mark. It
// has an orange disc, and a white disc in it. In the white disc is the orange
// diamond of a Git repository with a branch, or a short text such as a tree
// hash. A seal with a ring has the ring text in white on the orange, between
// fine white rims, as on security print. The seal marks each passkey approval.

import { svg } from "./h.ts";

let ids = 0;

interface SealOptions {
  /** The size of the square, in pixels. */
  size: number;
  /** The text on the ring. Small seals have no ring. */
  ring?: string;
  /** Short text in the middle, such as a tree hash. Without it, the diamond is in the middle. */
  center?: string;
  label: string;
}

const C = 100;

/**
 * The diamond with its branch, at the centre. Half of its diagonal is `half`.
 * A line starts at the upper-left edge and ends at a fork. From the fork, a
 * trunk extends downward and a branch extends to the right.
 */
function diamond(half: number) {
  const k = half / 36;
  const at = (dx: number, dy: number) => `${(C + dx * k).toFixed(2)},${(C + dy * k).toFixed(2)}`;
  const side = half * Math.SQRT2;
  const node = (dx: number, dy: number) => svg("circle", { cx: C + dx * k, cy: C + dy * k, r: 5.6 * k });
  return [
    svg("rect", { x: C - side / 2, y: C - side / 2, width: side, height: side, rx: 5 * k, transform: `rotate(45 ${C} ${C})`, class: "seal-diamond" }),
    svg(
      "g",
      { class: "seal-branch", "stroke-width": 4.6 * k },
      svg("path", { d: `M${at(-13.7, -25.8)} L${at(0.4, -15)} L${at(0, 15.9)} M${at(0.4, -15)} L${at(16.1, 0.2)}` }),
      node(0.4, -15),
      node(0, 15.9),
      node(16.1, 0.2),
    ),
  ];
}

export function seal({ size, ring, center, label }: SealOptions): SVGSVGElement {
  const id = `seal-ring-${++ids}`;
  const textRadius = 75;
  // With a ring, the white disc is smaller, so the ring text has space. Without a ring, the white disc is larger.
  const inner = ring ? 53 : 66;
  // Repeat a short ring text, so that its letters keep the same space between them all around the ring.
  const ringText = ring ? ring.repeat(Math.max(1, Math.round(64 / ring.length))) : "";
  return svg(
    "svg",
    // A seal with a label is an image with that name. A seal without a label is decoration, and aria-hidden removes it from assistive technology.
    label
      ? { viewBox: "0 0 200 200", width: size, height: size, class: "seal", role: "img", "aria-label": label }
      : { viewBox: "0 0 200 200", width: size, height: size, class: "seal", "aria-hidden": "true", focusable: "false" },
    svg("circle", { cx: C, cy: C, r: 98, class: "seal-disc" }),
    ring
      ? [
          svg("circle", { cx: C, cy: C, r: 93, class: "seal-rim" }),
          svg("circle", { cx: C, cy: C, r: 58, class: "seal-rim" }),
          svg("path", { id, d: `M ${C},${C} m -${textRadius},0 a ${textRadius},${textRadius} 0 1,1 ${2 * textRadius},0 a ${textRadius},${textRadius} 0 1,1 -${2 * textRadius},0`, fill: "none" }),
          svg("text", { class: "seal-ring" }, svg("textPath", { href: `#${id}`, startOffset: "0", textLength: Math.floor(2 * Math.PI * textRadius) - 4, lengthAdjust: "spacing" }, ringText)),
        ]
      : null,
    svg("circle", { cx: C, cy: C, r: inner, class: "seal-inner" }),
    center
      ? svg("text", { x: C, y: C, "text-anchor": "middle", "dominant-baseline": "central", class: ["seal-center", ring && "seal-center-small"] }, center)
      : diamond(inner * 0.68),
  );
}
