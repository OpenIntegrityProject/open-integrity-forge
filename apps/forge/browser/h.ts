// A small element builder, so the stage code reads as the markup it makes.
// It sets text with textContent only, never innerHTML.

export type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown>;

function apply(element: Element, attrs: Attrs = {}): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === "class") {
      element.setAttribute("class", Array.isArray(value) ? value.filter(Boolean).join(" ") : String(value));
    } else {
      element.setAttribute(key, value === true ? "" : String(value));
    }
  }
}

function append(element: Element, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(element, child);
    else element.append(child instanceof Node ? child : String(child));
  }
}

/** Replace the children of `element`. Empty children are left out, as `h` does. */
export function fill(element: Element, ...children: Child[]): void {
  element.replaceChildren();
  append(element, children);
}

/** An HTML element. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  apply(element, attrs ?? {});
  append(element, children);
  return element;
}

const SVG = "http://www.w3.org/2000/svg";

/** An SVG element. */
export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG, tag);
  apply(element, attrs ?? {});
  append(element, children);
  return element;
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`no element #${id}`);
  return element as T;
}

/** Whether the person asked for less motion. */
export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
