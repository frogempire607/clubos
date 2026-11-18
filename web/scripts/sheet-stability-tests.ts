/**
 * Sheets stay open, and keep what was typed, until the person closes them
 * (crash audit 2026-11-18, docs/CRASH-AUDIT-2026-11-18.md).
 *
 *   npx tsx --tsconfig scripts/tsconfig.render.json scripts/sheet-stability-tests.ts
 *
 * Rendered in jsdom — no network, no database. One section per fix:
 *
 *   1  backdrop: a press that starts in the panel never closes the sheet
 *   2  Escape reaches only the top layer; the scroll lock is counted
 *   3  a reload after the first one never blanks the page under a sheet
 *   4  the shared Sheet keeps typed text through parent re-renders
 *   5  the member edit drawer (the reported case): drag-select, Escape
 *   6  the connection bar never rebuilds a screen with a sheet open
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://athletix-os.com/", pretendToBeVisual: true });
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
g.HTMLElement = dom.window.HTMLElement;
g.KeyboardEvent = dom.window.KeyboardEvent;
g.MouseEvent = dom.window.MouseEvent;
g.Event = dom.window.Event;
g.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0);
g.cancelAnimationFrame = (id: number) => clearTimeout(id);
g.IS_REACT_ACT_ENVIRONMENT = true;
// The connection guard wraps window.fetch; nothing here reaches a network.
// Every request fails the way a dropped connection does.
(dom.window as unknown as { fetch: unknown }).fetch = () => Promise.reject(new TypeError("Load failed"));
g.fetch = (...a: unknown[]) => (dom.window as unknown as { fetch: (...x: unknown[]) => Promise<unknown> }).fetch(...a);

let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : `  — ${detail}`}`);
}

async function main() {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { act, useState, createElement: h } = React;
  const { backdropDismiss, useEscapeToClose, hasOpenOverlay } = await import("../lib/overlay");
  const { useFirstLoad } = await import("../lib/firstLoad");
  const { default: Sheet } = await import("../components/Sheet");
  const { default: DialogHost } = await import("../components/DialogHost");
  const { confirmDialog } = await import("../lib/dialogs");

  const fire = async (el: Element, type: string) => {
    await act(async () => { el.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true })); });
  };
  /** A press on `from`, released on `to`: the click lands on their common ancestor. */
  const pressAndRelease = async (from: Element, to: Element) => {
    await fire(from, "pointerdown");
    await fire(from, "mousedown");
    await fire(to, "pointerup");
    await fire(to, "mouseup");
    let target: Element | null = from;
    while (target && !target.contains(to)) target = target.parentElement;
    await fire(target ?? to, "click");
  };
  const escape = async () => {
    await act(async () => { document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  };
  const type = async (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  const mount = async (node: React.ReactNode) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => { root.render(node); });
    return { host, root, unmount: async () => { await act(async () => { root.unmount(); }); host.remove(); } };
  };

  // ── 1 ────────────────────────────────────────────────────────────────────
  console.log("\n§1 backdrop: the press must start AND end on the backdrop");
  {
    let closed = 0;
    const m = await mount(
      h("div", { id: "bd", className: "fixed inset-0", ...backdropDismiss(() => { closed++; }) },
        h("div", { id: "panel", onClick: (e: { stopPropagation(): void }) => e.stopPropagation() }, h("input", { id: "name" }))),
    );
    const bd = document.getElementById("bd")!, name = document.getElementById("name")!;
    await pressAndRelease(name, bd);
    check("a text selection dragged out of the panel and released on the backdrop does not close", closed === 0, `closed ${closed}×`);
    await pressAndRelease(bd, name);
    check("a press on the backdrop released inside the panel does not close", closed === 0);
    await pressAndRelease(name, name);
    check("a click inside the panel does not close", closed === 0);
    await act(async () => { (bd as HTMLElement).click(); });
    check("a click with no press before it (script, stray event) does not close", closed === 0);
    await pressAndRelease(bd, bd);
    check("a real click on the backdrop closes, once", closed === 1, `closed ${closed}×`);
    await m.unmount();
  }

  // ── 2 ────────────────────────────────────────────────────────────────────
  console.log("\n§2 Escape reaches only the top layer; scroll lock is counted");
  {
    let lowerClosed = 0;
    function Lower() {
      const [open, setOpen] = useState(true);
      useEscapeToClose(() => { lowerClosed++; setOpen(false); }, open);
      return open ? h("div", { id: "lower" }, "drawer") : null;
    }
    const m = await mount(h(React.Fragment, null, h(Lower), h(DialogHost)));
    let answer: boolean | null = null;
    await act(async () => { void confirmDialog("Discard your unsaved changes?").then((v) => { answer = v; }); });
    check("a confirm dialog is open over the drawer", !!document.querySelector('[role="dialog"]') && !!document.getElementById("lower"));
    await escape();
    check("Escape answers the dialog (Cancel)…", answer === false);
    check("…and does NOT also close the drawer under it", lowerClosed === 0 && !!document.getElementById("lower"), `drawer closed ${lowerClosed}×`);
    check("no second dialog was raised by the same key press", document.querySelector('[role="dialog"]') === null);
    await escape();
    check("the next Escape closes the drawer", lowerClosed === 1 && !document.getElementById("lower"));
    check("nothing is left registered", !hasOpenOverlay());
    await m.unmount();

    // two sheets, closed lower-first: the page must scroll again afterwards
    function Two({ a, b }: { a: boolean; b: boolean }) {
      return h(React.Fragment, null,
        h(Sheet, { open: a, onClose: () => undefined, title: "A" }, "a"),
        h(Sheet, { open: b, onClose: () => undefined, title: "B" }, "b"));
    }
    document.body.style.overflow = "";
    const t = await mount(h(Two, { a: true, b: false }));
    await act(async () => { t.root.render(h(Two, { a: true, b: true })); });
    check("page scroll is locked while sheets are open", document.body.style.overflow === "hidden");
    await act(async () => { t.root.render(h(Two, { a: false, b: true })); });
    check("still locked while one sheet remains", document.body.style.overflow === "hidden");
    await act(async () => { t.root.render(h(Two, { a: false, b: false })); });
    check("closing the lower sheet first does not leave the page unable to scroll", document.body.style.overflow === "", `overflow="${document.body.style.overflow}"`);
    await t.unmount();
  }

  // ── 3 ────────────────────────────────────────────────────────────────────
  console.log("\n§3 a reload never blanks the page under an open sheet");
  {
    let finish: () => void = () => undefined;
    let reload: () => void = () => undefined;
    let sheetMounts = 0;
    function EditSheet() {
      React.useEffect(() => { sheetMounts++; }, []);
      return h("div", { role: "dialog" }, h("input", { id: "typed" }));
    }
    function Page() {
      const [loading, setLoading, refreshing] = useFirstLoad();
      const [open, setOpen] = useState(false);
      reload = () => setLoading(true);
      finish = () => setLoading(false);
      if (loading) return h("p", { id: "skeleton" }, "Loading…");
      return h("div", { id: "page", "data-refreshing": String(refreshing) },
        h("button", { id: "open", onClick: () => setOpen(true) }, "Edit"),
        open && h(EditSheet));
    }
    const m = await mount(h(Page));
    check("first load shows the skeleton", !!document.getElementById("skeleton"));
    await act(async () => { finish(); });
    await act(async () => { (document.getElementById("open") as HTMLElement).click(); });
    const input = document.getElementById("typed") as HTMLInputElement;
    await type(input, "Christina Ulr");
    await act(async () => { reload(); });
    check("a background reload does not bring the skeleton back", !document.getElementById("skeleton") && !!document.getElementById("page"));
    check("the sheet is the same sheet (not closed, not rebuilt)", sheetMounts === 1 && document.getElementById("typed") === input, `mounted ${sheetMounts}×`);
    check("the typed text is still there", (document.getElementById("typed") as HTMLInputElement | null)?.value === "Christina Ulr");
    check("the page is told it is refreshing instead", document.getElementById("page")!.getAttribute("data-refreshing") === "true");
    await act(async () => { finish(); });
    check("…and that it finished", document.getElementById("page")!.getAttribute("data-refreshing") === "false" && sheetMounts === 1);
    await m.unmount();
  }

  // ── 4 ────────────────────────────────────────────────────────────────────
  console.log("\n§4 the shared Sheet through parent re-renders");
  {
    let closed = 0;
    let rerender: () => void = () => undefined;
    function Parent() {
      const [n, setN] = useState(0);
      rerender = () => setN((x) => x + 1);
      // a NEW onClose and NEW data on every render, as real callers pass
      return h(Sheet, { open: true, onClose: () => { closed++; }, title: `Edit guardian (${n})` }, h("input", { id: "g", defaultValue: "" }), h("span", null, `rev ${n}`));
    }
    const m = await mount(h(Parent));
    const input = document.getElementById("g") as HTMLInputElement;
    await type(input, "Shannan Hal");
    for (let i = 0; i < 5; i++) await act(async () => { rerender(); });
    check("five parent re-renders: same field, same text, still open", document.getElementById("g") === input && input.value === "Shannan Hal" && closed === 0);
    const dialog = document.querySelector('[role="dialog"]')!;
    const backdrop = dialog.parentElement!.firstElementChild!;
    await pressAndRelease(input, backdrop);
    check("drag-select released on the Sheet backdrop does not close it", closed === 0, `closed ${closed}×`);
    await pressAndRelease(dialog.querySelector("h2")!, dialog.querySelector("h2")!);
    check("a tap on the Sheet's own title does not close it", closed === 0);
    await pressAndRelease(backdrop, backdrop);
    check("a real click on the backdrop closes it", closed === 1);
    await escape();
    check("Escape closes it", closed === 2);
    await m.unmount();

    let forced = 0;
    const d = await mount(h(Sheet, { open: true, onClose: () => { forced++; }, title: "Must answer", dismissable: false }, "x"));
    const bd = document.querySelector('[role="dialog"]')!.parentElement!.firstElementChild!;
    await pressAndRelease(bd, bd);
    await escape();
    check("a non-dismissable Sheet ignores the backdrop and Escape", forced === 0);
    await d.unmount();
  }

  // ── 5 ────────────────────────────────────────────────────────────────────
  console.log("\n§5 the member edit drawer — the reported case (editing a guardian's name)");
  {
    const { EditMemberDrawer } = await import("../components/members/EditMemberDrawer");
    let closed = 0;
    const member = {
      id: "m1", profileImageUrl: null, firstName: "Drayke", lastName: "Ulrich", email: null, phone: null, dateOfBirth: "2014-03-02",
      guardianName: "Christina Ulrich", guardianEmail: "christina@example.test", guardianPhone: null, isMinor: true,
      customFieldValues: "{}", midMigration: false, hasPendingInvitation: false, loginEmail: null, accountHolderName: "Christina Ulrich",
    };
    const m = await mount(h(React.Fragment, null,
      h(EditMemberDrawer, {
        member: member as never, staffName: "Dana Rivera", onClose: () => { closed++; }, onSave: () => undefined,
        onSendReset: () => undefined, onCopyPortalLink: () => undefined,
      }),
      h(DialogHost)));
    const drawer = document.querySelector('[role="dialog"]') as HTMLElement;
    const label = Array.from(drawer.querySelectorAll("label")).find((l) => /Guardian name/.test(l.textContent ?? ""))!;
    const input = label.querySelector("input") as HTMLInputElement;
    check("the guardian name field is in the drawer", !!input && input.value === "Christina Ulrich");

    await pressAndRelease(input, drawer);
    check("selecting the name and letting go outside the panel does not close the drawer", closed === 0, `closed ${closed}×`);
    check("…and does not ask to discard anything", document.querySelectorAll('[role="dialog"]').length === 1);

    await type(input, "Christina Ulrich-Hall");
    await pressAndRelease(input, drawer);
    check("same gesture with unsaved text: still open, no prompt, text intact", closed === 0 && document.querySelectorAll('[role="dialog"]').length === 1 && input.value === "Christina Ulrich-Hall");

    await pressAndRelease(drawer, drawer);
    check("a real click on the backdrop with unsaved text asks first", document.querySelectorAll('[role="dialog"]').length === 2 && closed === 0);
    await escape();
    check("Escape on that question cancels it — one prompt, not a second one", document.querySelectorAll('[role="dialog"]').length === 1 && closed === 0, `${document.querySelectorAll('[role="dialog"]').length} dialogs, closed ${closed}×`);
    check("the typed name survived all of it", input.isConnected && input.value === "Christina Ulrich-Hall");
    await m.unmount();
  }

  // ── 6 ────────────────────────────────────────────────────────────────────
  console.log("\n§6 the connection bar never rebuilds a screen that has a sheet open");
  {
    const { default: ConnectionGuard } = await import("../components/ConnectionGuard");
    let mounts = 0;
    function Screen({ withSheet }: { withSheet: boolean }) {
      React.useEffect(() => { mounts++; }, []);
      return h("main", null, "screen", h(Sheet, { open: withSheet, onClose: () => undefined, title: "Pick a plan" }, h("select", { id: "plan" }, h("option", null, "Monthly"), h("option", null, "Yearly"))));
    }
    const m = await mount(h(ConnectionGuard, null, h(Screen, { withSheet: true })));
    // a data load that fails the way a dropped connection does
    await act(async () => { await (window.fetch("https://athletix-os.com/api/members") as Promise<unknown>).catch(() => undefined); });
    check("the can't-reach-the-server bar is showing", !!document.querySelector('[role="alert"]'));
    await act(async () => { window.dispatchEvent(new dom.window.Event("online")); });
    check("back online with a sheet open: the screen is NOT rebuilt", mounts === 1, `mounted ${mounts}×`);
    await act(async () => { m.root.render(h(ConnectionGuard, null, h(Screen, { withSheet: false }))); });
    await act(async () => { window.dispatchEvent(new dom.window.Event("online")); });
    check("back online with nothing open: the screen reloads itself, as before", mounts === 2, `mounted ${mounts}×`);
    await m.unmount();
  }

  console.log(failed ? `\n${failed} FAILED` : "\nall passed");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
