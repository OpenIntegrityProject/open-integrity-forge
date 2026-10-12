// The demo's lendPage, for every pane on the forge page: while a passkey
// request runs, the open panes are not modal, so a password manager that
// draws its picker in the page can take clicks. Afterwards they are modal
// again, and the focus returns where it was.

const PANES = ["codes", "settings", "sign-in", "approval", "commit"];

const pane = (id: string) => document.getElementById(id) as HTMLDialogElement | null;

export async function lend<T>(request: () => Promise<T>): Promise<T> {
  const lent = PANES.filter((id) => pane(id)?.matches(":modal"));
  const focused = document.activeElement;
  for (const id of lent) {
    pane(id)!.close();
    pane(id)!.show();
  }
  try {
    return await request();
  } finally {
    for (const id of lent) {
      const p = pane(id)!;
      if (p.open && !p.matches(":modal")) {
        p.close();
        p.showModal();
      }
    }
    if (focused instanceof HTMLElement && lent.some((id) => pane(id)!.open && pane(id)!.contains(focused))) focused.focus();
  }
}
