/**
 * The screens the crash audit's crawl found broken (2026-11-18,
 * docs/CRASH-AUDIT-2026-11-18.md), pinned so they stay fixed.
 *
 *   npx tsx scripts/crash-audit-tests.ts
 *
 *   1  import wizard: "a.then is not a function" on every open
 *   2  a field's `pattern` the browser cannot compile (validation silently off)
 *   3  a failed reload keeps the screen that is already drawn
 *
 * (The staff-profile crash has its own guard: scripts/hooks-order-guard.ts.)
 * No database, no network.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..");
const code = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : `  — ${detail}`}`);
}
function tsx(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsx(p));
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}
const all = [...tsx(join(ROOT, "app")), ...tsx(join(ROOT, "components"))].map((f) => ({ file: relative(ROOT, f), src: readFileSync(f, "utf8") }));

async function main() {
console.log("\n§1 a page's `params` is an object here (Next 14), a Promise on the next version");
{
  // What the wizard did, and what it does now, against both shapes.
  const read = async (params: unknown) => (await Promise.resolve(params as { batchId: string })).batchId;
  const object = { batchId: "batch_1" };
  let threw = false;
  try { (object as unknown as Promise<unknown>).then(() => undefined); } catch { threw = true; }
  check("calling .then on the object is the crash that was reported", threw);
  check("Promise.resolve(params) reads the object", (await read(object)) === "batch_1");
  check("…and reads a Promise the same way", (await read(Promise.resolve(object))) === "batch_1");
  const wizard = code("app/dashboard/reports/imports/[batchId]/page.tsx");
  check("the import wizard reads it that way", /Promise\.resolve\(params\)/.test(wizard) && !/[^.\w]params\.then\(/.test(wizard));
  const offenders = all.filter((f) => /^"use client"/m.test(f.src) && /[^.\w]params\.then\(|\buse\(params\)/.test(f.src)).map((f) => f.file);
  check("no client page calls params.then(…) or use(params)", offenders.length === 0, offenders.join(", "));
}

console.log("\n§2 every pattern=\"…\" on a field is one the browser can compile");
{
  // Browsers compile `pattern` with the `v` flag, where a bare "-" inside
  // [...] is an error. An invalid pattern is ignored: the field validates
  // nothing and the console logs an error on every submit.
  const bad: string[] = [];
  let n = 0;
  for (const f of all) {
    for (const m of f.src.matchAll(/\bpattern="([^"]+)"/g)) {
      n++;
      try { new RegExp(m[1].replace(/\\\\/g, "\\"), "v"); } catch { bad.push(`${f.file}: ${m[1]}`); }
    }
  }
  check(`${n} pattern attribute${n === 1 ? "" : "s"}, all valid`, bad.length === 0, bad.join(" · "));
  const slug = /pattern="([^"]+)"/.exec(code("app/dashboard/settings/club/page.tsx"))?.[1] ?? "";
  const re = new RegExp(`^(?:${slug})$`, "v");
  check("the club address field accepts frog-empire-2 and refuses Frog Empire", re.test("frog-empire-2") && !re.test("Frog Empire"));
}

console.log("\n§3 a reload that fails keeps the screen that is already drawn");
{
  const home = code("app/member/page.tsx");
  check("member home never empties its data on a failed reload", !/setData\(null\)/.test(home.slice(home.indexOf("function MemberHome") >= 0 ? home.indexOf("function MemberHome") : 0)) || !/\.catch\(\(\) => \{ setData\(null\)/.test(home));
  check("…it keeps what it had", /setData\(\(prev: PortalData \| null\) => d \?\? prev\)/.test(home));
  for (const f of ["components/reports/CostsTab.tsx", "components/reports/PnlTab.tsx"]) {
    check(`${f.split("/").pop()} keeps the report on screen when a refresh fails`, /setData\(\(prev\) => d \?\? prev\)/.test(code(f)));
  }
}

}

main().then(() => {
  console.log(failed ? `\n${failed} FAILED` : "\nall passed");
  process.exit(failed ? 1 : 0);
});
