// The app shell: a placeholder where an app built on the library would go,
// drawn for whoever is signed in. No requests.

import type { Me } from "../src/responses.ts";
import { $ } from "./dom.ts";

/** Draw the app for `me`, or for nobody. */
export function showApp(me: Me | null) {
  $("app-signed-out").hidden = me !== null;
  $("open-sign-in").hidden = me !== null;
  $("app-signed-in").hidden = me === null;
  $("signed-in").hidden = me === null;
  if (me) $("member-name").textContent = me.memberName ?? "";
}
