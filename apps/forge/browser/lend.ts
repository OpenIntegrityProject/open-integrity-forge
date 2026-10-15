// The demo's lendPage, for the panes and for the approval and commit sheets of
// the forge page. While a passkey request runs, the open panes and sheets are
// not modal. Thus a password manager that shows its picker in the page can get
// clicks. After the request, they are modal again, and the focus returns to
// where it was.

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
