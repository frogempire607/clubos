// Build guard: a "use client" file must never reach server-only code
// (lib/email → nodemailer, node built-ins) through its imports.
//
// Why: 2026-10-08 the Netlify build failed with "Module not found: Can't
// resolve 'fs'" because the Financials page (client) imported two constants
// from lib/financialReports, which reaches lib/payroll → lib/classStaffServer →
// lib/staffAssignmentsServer → lib/email → nodemailer. `tsc` and the unit tests
// cannot see this; only webpack does. This walks the same import graph
// (type-only imports ignored) so it fails here, in seconds, instead.
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { dirname, join, normalize } from "path";

const SERVER_ONLY = new Set(["nodemailer", "fs", "net", "dns", "tls", "child_process", "@/lib/email"]);
const IMPORT = /^\s*(?:import|export)\s+(?!type\b)([^;]*?)\s+from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm;

function resolve(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith(".")) base = normalize(join(dirname(from), spec));
  else return null;
  for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) if (existsSync(base + ext)) return base + ext;
  return null;
}

const cache = new Map<string, string[]>();
export function valueImports(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(IMPORT)) {
    const clause = m[1] ?? "";
    const spec = m[2] ?? m[3];
    const braces = /\{([^}]*)\}/.exec(clause);
    const hasDefault = /^\s*\w+\s*,/.test(clause) || (!braces && clause.trim() !== "");
    if (braces && !hasDefault) {
      const names = braces[1].split(",").map((x) => x.trim()).filter(Boolean);
      if (names.length > 0 && names.every((n) => n.startsWith("type "))) continue;
    }
    out.push(spec);
  }
  return out;
}
function deps(file: string): string[] {
  let d = cache.get(file);
  if (!d) { d = valueImports(readFileSync(file, "utf8")); cache.set(file, d); }
  return d;
}
function trace(file: string, seen: Set<string>, path: string[]): string[] | null {
  for (const spec of deps(file)) {
    if (SERVER_ONLY.has(spec)) return [...path, spec];
    const r = resolve(spec, file);
    if (r && !seen.has(r)) {
      seen.add(r);
      const hit = trace(r, seen, [...path, r]);
      if (hit) return hit;
    }
  }
  return null;
}
function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
}

// Self-check: the rule must see through a value import and ignore type-only ones.
const a = valueImports(`import { X, type Y } from "@/lib/a";\nimport type { Z } from "@/lib/b";\nimport { type Q } from "@/lib/c";\nexport { K } from "@/lib/d";`);
if (a.join() !== "@/lib/a,@/lib/d") { console.error("client-bundle-guard self-check failed", a); process.exit(1); }

const files: string[] = [];
for (const d of ["app", "components"]) if (existsSync(d)) walk(d, files);
const bad: string[] = [];
let clients = 0;
for (const f of files) {
  const head = readFileSync(f, "utf8").slice(0, 400);
  if (!/["']use client["']/.test(head)) continue;
  clients++;
  const hit = trace(f, new Set([f]), [f]);
  if (hit) bad.push(hit.join(" → "));
}
if (bad.length) {
  console.error(`client-bundle-guard: ${bad.length} client file(s) reach server-only code:\n` + bad.map((b) => "  " + b).join("\n"));
  console.error("Import the constant/type from a pure file instead (see lib/financialReportTypes.ts).");
  process.exit(1);
}
console.log(`client-bundle-guard: ${clients} client files checked, none reach server-only code.`);
