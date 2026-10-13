// The promoter's seal: a guilloche rosette, as security print uses to make
// a document hard to forge, with the passkey label on its ring. It marks a
// passkey approval wherever one appears.

import { svg } from "./h.ts";

let ids = 0;

export interface SealOptions {
  /** Pixel size of the square. */
  size: number;
  /** The text on the ring. Absent for small badges. */
  ring?: string;
  /** Short text in the middle, such as a tree hash. */
  center?: string;
  /** Fewer lines for small sizes. */
  detail?: "full" | "badge";
  label: string;
}

/** One closed rosette curve: a circle whose radius waves `lobes` times. */
function rosette(cx: number, r: number, depth: number, lobes: number, phase: number, steps = 360): string {
  let d = "";
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const rr = r + depth * Math.sin(lobes * t + phase);
    const x = cx + rr * Math.cos(t);
    const y = cx + rr * Math.sin(t);
    d += `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
  }
  return d + "Z";
}

export function seal({ size, ring, center, detail = "full", label }: SealOptions): SVGSVGElement {
  const id = `seal-ring-${++ids}`;
  const c = 100;
  const lines = detail === "full" ? 14 : 6;
  const curves = [];
  for (let i = 0; i < lines; i++) {
    const phase = (i / lines) * Math.PI * 2;
    curves.push(svg("path", { d: rosette(c, 52, 9, 12, phase), class: "seal-line" }));
    if (detail === "full") curves.push(svg("path", { d: rosette(c, 30, 6, 8, -phase, 240), class: "seal-line seal-inner" }));
  }
  return svg(
    "svg",
    // A seal with a label is an image with that name; one without is decoration, hidden from assistive technology.
    label
      ? { viewBox: "0 0 200 200", width: size, height: size, class: "seal", role: "img", "aria-label": label }
      : { viewBox: "0 0 200 200", width: size, height: size, class: "seal", "aria-hidden": "true", focusable: "false" },
    svg("circle", { cx: c, cy: c, r: 96, class: "seal-rim" }),
    svg("circle", { cx: c, cy: c, r: 70, class: "seal-rim seal-rim-inner" }),
    ring
      ? [
          svg("path", { id, d: `M ${c},${c} m -82,0 a 82,82 0 1,1 164,0 a 82,82 0 1,1 -164,0`, fill: "none" }),
          svg("text", { class: "seal-ring" }, svg("textPath", { href: `#${id}`, startOffset: "0", textLength: 508, lengthAdjust: "spacing" }, ring)),
        ]
      : null,
    svg("g", { class: "seal-rosette" }, curves),
    center ? svg("text", { x: c, y: c + 6, "text-anchor": "middle", class: "seal-center" }, center) : null,
  );
}
