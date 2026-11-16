/**
 * The dialog host in a (simulated) browser: what is on screen, and that the
 * buttons answer the promise.
 *
 *   npx tsx --tsconfig scripts/tsconfig.render.json scripts/dialog-host-tests.ts
 *
 * 78 confirm / alert / prompt call sites — including "charge this card now" —
 * depend on this one component, so it is tested as rendered, not just as a
 * queue. Uses jsdom; no network, no database.
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://athletix-os.com/", pretendToBeVisual: true });
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
g.HTMLElement = dom.window.HTMLElement;
g.KeyboardEvent = dom.window.KeyboardEvent;
g.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0);
g.cancelAnimationFrame = (id: number) => clearTimeout(id);
g.IS_REACT_ACT_ENVIRONMENT = true;

let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : `  — ${detail}`}`);
}

async function main() {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const { default: DialogHost } = await import("../components/DialogHost");
  const { confirmDialog, alertDialog, promptDialog } = await import("../lib/dialogs");

  const root = createRoot(document.getElementById("root")!);
  await act(async () => { root.render(React.createElement(DialogHost)); });
  const body = () => document.body.textContent ?? "";
  const buttons = () => Array.from(document.querySelectorAll("button")) as HTMLButtonElement[];
  const click = async (label: string) => {
    const b = buttons().find((x) => (x.textContent ?? "").trim() === label);
    if (!b) throw new Error(`no "${label}" button; have: ${buttons().map((x) => x.textContent).join(" | ")}`);
    await act(async () => { b.click(); });
  };

  console.log("\n§1 nothing is drawn until something asks");
  check("no dialog on screen", document.querySelector('[role="dialog"]') === null);

  console.log("\n§2 confirm");
  let answer: boolean | null = null;
  await act(async () => { void confirmDialog("Charge the saved card immediately?\n\n$120.00 will be charged today.", { confirmLabel: "Charge $120.00" }).then((v) => { answer = v; }); });
  check("the question is on screen, in a modal dialog", /Charge the saved card immediately\?/.test(body()) && document.querySelector('[role="dialog"][aria-modal="true"]') !== null);
  check("the web address is nowhere in it", !/athletix-os\.com|says/.test(body()));
  check("the confirm button carries the caller's label", buttons().some((b) => b.textContent === "Charge $120.00"));
  check("a money action gets the red button", /bg-red-600/.test(buttons().find((b) => b.textContent === "Charge $120.00")!.className));
  await click("Cancel");
  check("Cancel answers false and closes", answer === false && document.querySelector('[role="dialog"]') === null);

  answer = null;
  await act(async () => { void confirmDialog("Approve this profile?").then((v) => { answer = v; }); });
  check("an ordinary confirm is not red", !/bg-red-600/.test(buttons().find((b) => b.textContent === "Confirm")!.className));
  await click("Confirm");
  check("Confirm answers true and closes", answer === true && document.querySelector('[role="dialog"]') === null);

  console.log("\n§3 Escape is a cancel");
  answer = null;
  await act(async () => { void confirmDialog("Delete this draft?").then((v) => { answer = v; }); });
  await act(async () => { document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  check("Escape answers false (also what the Android back button sends)", answer === false && document.querySelector('[role="dialog"]') === null);

  console.log("\n§4 alert");
  let dismissed = false;
  await act(async () => { void alertDialog("Could not delete").then(() => { dismissed = true; }); });
  check("the message is on screen with a single OK", /Could not delete/.test(body()) && buttons().filter((b) => b.textContent === "OK").length === 1 && !buttons().some((b) => b.textContent === "Cancel"));
  await click("OK");
  check("OK dismisses it", dismissed && document.querySelector('[role="dialog"]') === null);

  console.log("\n§5 prompt");
  let typed: string | null | undefined;
  await act(async () => { void promptDialog("Rename this bank account", "Checking").then((v) => { typed = v; }); });
  const input = document.querySelector("input") as HTMLInputElement | null;
  check("the field starts with the default", input?.value === "Checking");
  await click("OK");
  check("OK answers with the text", typed === "Checking");
  typed = undefined;
  await act(async () => { void promptDialog("Rename this bank account", "Checking").then((v) => { typed = v; }); });
  await click("Cancel");
  check("Cancel answers null (the caller's `if (v === null) return` still works)", typed === null);

  console.log("\n§6 two at once");
  const got: string[] = [];
  await act(async () => {
    void confirmDialog("First question?").then((v) => got.push(`first:${v}`));
    void confirmDialog("Second question?").then((v) => got.push(`second:${v}`));
  });
  check("only the first is shown", /First question\?/.test(body()) && !/Second question\?/.test(body()));
  await click("Confirm");
  check("then the second", /Second question\?/.test(body()));
  await click("Cancel");
  check("each got its own answer", got.join(",") === "first:true,second:false");

  await act(async () => { root.unmount(); });
  console.log(`\n${"─".repeat(70)}`);
  if (failed) {
    console.log(`✗ ${failed} dialog host check(s) failed\n`);
    process.exit(1);
  }
  console.log("✓ dialog host tests passed\n");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
