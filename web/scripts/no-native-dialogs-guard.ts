/**
 * No browser alert() / confirm() / prompt() anywhere in the product, and the
 * in-app replacements behave.
 *
 *   npx tsx scripts/no-native-dialogs-guard.ts
 *
 * Why it is a build failure and not a style note: a browser dialog is titled
 * with the web address, freezes the screen, and is the clearest sign to an
 * app reviewer that an app is a website in a box (Apple guideline 4.2). 78 of
 * them were replaced on 2026-11-15 with lib/dialogs.ts; this keeps the count
 * at zero. No database, no network, no browser.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { alertDialog, confirmDialog, promptDialog, looksDangerous, pendingDialogs, subscribeDialogs, type DialogRequest } from "../lib/dialogs";

const ROOT = join(__dirname, "..");
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : `\n      ${detail}`}`);
}

const walk = (dir: string): string[] =>
  readdirSync(join(ROOT, dir)).flatMap((e) => {
    const rel = `${dir}/${e}`;
    if (e === "node_modules") return [];
    return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(rel) ? [rel] : [];
  });
const code = (rel: string) =>
  readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, (_m, p1) => p1);

/** A call to the browser function — not a property, not a local declaration. */
const CALL = /(?<![A-Za-z0-9_.$])(?:window\.)?(alert|confirm|prompt)\s*\(/g;
const DECLARED = (src: string, name: string) => new RegExp(`\\b(?:async\\s+)?function\\s+${name}\\s*\\(|\\b(?:const|let)\\s+${name}\\s*=`).test(src);

async function main() {
  console.log("\n§1 no browser dialogs in the product");
  const hits: string[] = [];
  for (const f of [...walk("app"), ...walk("components")]) {
    const src = code(f);
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      for (const m of Array.from(line.matchAll(CALL))) {
        // A component may have its own function called `confirm`; that is not
        // the browser's. It has to be declared in the same file.
        if (DECLARED(src, m[1])) continue;
        hits.push(`${f}:${i + 1}  ${m[1]}()`);
      }
    });
  }
  check("alert / confirm / prompt calls in app/ and components/: 0", hits.length === 0, hits.slice(0, 12).join("\n      "));
  check("the dialog host is mounted at the root, above the page", /<DialogHost \/>/.test(code("app/layout.tsx")) && code("app/layout.tsx").indexOf("<DialogHost />") > code("app/layout.tsx").indexOf("<Providers>"));

  console.log("\n§2 the replacements keep the browser versions' meaning");
  let seen: readonly DialogRequest[] = [];
  const stop = subscribeDialogs((q) => { seen = q; });
  {
    const p = confirmDialog("Delete this event? Bookings will be canceled.");
    check("a confirm waits for an answer", seen.length === 1 && seen[0].kind === "confirm" && pendingDialogs() === 1);
    (seen[0] as Extract<DialogRequest, { kind: "confirm" }>).resolve(true);
    check("confirming resolves true and clears the queue", (await p) === true && pendingDialogs() === 0);
  }
  {
    const p = confirmDialog("Send it?");
    (seen[0] as Extract<DialogRequest, { kind: "confirm" }>).resolve(false);
    check("cancelling resolves false (the action must not run)", (await p) === false);
  }
  {
    const p = promptDialog("New name", "Front desk");
    const req = seen[0] as Extract<DialogRequest, { kind: "prompt" }>;
    check("a prompt carries its default", req.kind === "prompt" && req.defaultValue === "Front desk");
    req.resolve(null);
    check("cancelling a prompt resolves null, exactly like prompt()", (await p) === null);
    const p2 = promptDialog("New name");
    (seen[0] as Extract<DialogRequest, { kind: "prompt" }>).resolve("");
    check("an empty answer is an empty string, not a cancel", (await p2) === "");
  }
  {
    const a = confirmDialog("First?");
    const b = confirmDialog("Second?");
    check("two dialogs queue; one is shown at a time, in order", seen.length === 2 && seen[0].message === "First?" && seen[1].message === "Second?");
    (seen[0] as Extract<DialogRequest, { kind: "confirm" }>).resolve(true);
    check("answering the first reveals the second", seen.length === 1 && seen[0].message === "Second?");
    (seen[0] as Extract<DialogRequest, { kind: "confirm" }>).resolve(false);
    check("each resolves with its own answer", (await a) === true && (await b) === false);
  }
  {
    const p = alertDialog("Could not delete");
    (seen[0] as Extract<DialogRequest, { kind: "alert" }>).resolve();
    await p;
    check("an alert resolves when dismissed", pendingDialogs() === 0);
  }
  stop();

  console.log("\n§3 actions that cannot be taken back, or that move money, get the red button");
  for (const m of [
    "Delete this event? Bookings will be canceled.",
    "Charge the saved card immediately?",
    "Void this $120.00 payout to Sam Reed?",
    "Roll back this import?",
    "Refund the card payment too?",
    "Archive this announcement?",
    "Discard your unsaved changes to this member?",
    "This cannot be undone once dispatched.",
  ]) check(`danger: "${m}"`, looksDangerous(m));
  for (const m of ["Send this offer email now?", "Approve this profile?", "Resubscribe this address?"]) check(`not danger: "${m}"`, !looksDangerous(m));
  {
    let q: readonly DialogRequest[] = [];
    const s = subscribeDialogs((x) => { q = x; });
    void confirmDialog("Approve this profile?", { danger: true, confirmLabel: "Approve" });
    const r = q[0] as Extract<DialogRequest, { kind: "confirm" }>;
    check("a caller can set the label and force the danger style", r.confirmLabel === "Approve" && r.danger === true);
    r.resolve(false);
    s();
  }

  console.log(`\n${"─".repeat(70)}`);
  if (failed) {
    console.log(`✗ ${failed} dialog check(s) failed\n`);
    process.exit(1);
  }
  console.log("✓ no native dialogs; in-app dialogs behave\n");
}
main();
