// Write public/index.html from browser/index.html, with the page script and
// the stylesheet addressed by a digest of what was built. A deploy that
// changes either changes the page, and a browser that kept an earlier page
// or script cannot pair the new page with the old script.
//
//   node scripts/stamp-page.ts
//
// Run it from apps/forge, after the browser build. `npm run build` runs it.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

let page = readFileSync("browser/index.html", "utf8");
for (const asset of ["/app.js", "/forge.css"]) {
  const digest = createHash("sha256").update(readFileSync(`public${asset}`)).digest("hex").slice(0, 12);
  const reference = new RegExp(`"${asset.replace(".", "\\.")}"`, "g");
  const found = page.match(reference)?.length ?? 0;
  if (found !== 1) {
    console.error(`stamp-page: browser/index.html refers to ${asset} ${found} times, not once`);
    process.exit(1);
  }
  page = page.replace(reference, `"${asset}?v=${digest}"`);
}
writeFileSync("public/index.html", page);
