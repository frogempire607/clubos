/**
 * No hook after an early return (crash audit 2026-11-18).
 *
 *   npx tsx scripts/hooks-order-guard.ts
 *
 * React needs a component to call the same hooks, in the same order, on every
 * render. A hook written BELOW `if (!data) return <Skeleton />` runs on the
 * second render and not the first, and React throws ("Rendered more hooks than
 * during the previous render") — the whole screen is replaced by the error
 * page the moment its data arrives.
 *
 * That is exactly what happened to the staff profile and "My profile":
 * `useSingleFlight()` was added under the loading returns on 2026-11-16 and
 * both screens crashed on every open. Nothing caught it — the linter that
 * knows this rule does not run in the build, and a server-rendered test only
 * ever sees the first render.
 *
 * Source guard: parses every component with the TypeScript compiler. No
 * database, no network.
 */
import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..");
type Hit = { file: string; line: number; component: string; hook: string; returnLine: number };

function isHookCall(n: ts.Node): string | null {
  if (!ts.isCallExpression(n)) return null;
  const callee = n.expression;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
  return /^use[A-Z0-9]/.test(name) ? name : null;
}

/** Hook calls made directly by this statement — not inside a nested function. */
function hooksIn(st: ts.Node): { name: string; node: ts.Node }[] {
  const out: { name: string; node: ts.Node }[] = [];
  const top = (n: ts.Node) => {
    const h = isHookCall(n);
    if (h) out.push({ name: h, node: n });
    ts.forEachChild(n, (c) => {
      if (ts.isFunctionDeclaration(c) || ts.isFunctionExpression(c) || ts.isArrowFunction(c)) return;
      top(c);
    });
  };
  top(st);
  return out;
}

function returnsEarly(st: ts.Statement): boolean {
  if (!ts.isIfStatement(st)) return false;
  const has = (s: ts.Statement): boolean => ts.isReturnStatement(s) || (ts.isBlock(s) && s.statements.some(ts.isReturnStatement));
  return has(st.thenStatement) || (!!st.elseStatement && has(st.elseStatement));
}

export function analyze(file: string, source: string): Hit[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: Hit[] = [];
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const visit = (n: ts.Node) => {
    if ((ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.body && ts.isBlock(n.body)) {
      const name = ts.isFunctionDeclaration(n) && n.name ? n.name.text
        : n.parent && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name) ? n.parent.name.text : "";
      // components and custom hooks are the functions the rule applies to
      if (/^([A-Z]|use[A-Z0-9])/.test(name)) {
        let firstReturn: ts.Statement | null = null;
        for (const st of n.body.statements) {
          if (firstReturn) {
            for (const h of hooksIn(st)) hits.push({ file, line: line(h.node), component: name, hook: h.name, returnLine: line(firstReturn) });
          } else if (returnsEarly(st)) firstReturn = st;
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(tsx|ts)$/.test(name)) out.push(p);
  }
  return out;
}

function main() {
  let failed = 0;
  const check = (label: string, ok: boolean, detail = "") => {
    if (!ok) failed++;
    console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : `  — ${detail}`}`);
  };

  console.log("\n§1 the guard recognises the mistake");
  const BAD = `
    export default function StaffProfile() {
      const [data, setData] = useState(null);
      if (!data) return <Skeleton />;
      const flight = useSingleFlight();
      return <div />;
    }`;
  check("a hook under an early return → caught", analyze("x.tsx", BAD).length === 1);
  check("the same hook above the return → clean", analyze("x.tsx", BAD.replace("if (!data) return <Skeleton />;\n      const flight = useSingleFlight();", "const flight = useSingleFlight();\n      if (!data) return <Skeleton />;")).length === 0);
  check("a hook used inside a callback after the return is not this mistake", analyze("x.tsx", `
    function A() { const [a] = useState(0); if (!a) return null; const f = () => { useThing(); }; return <b onClick={f} />; }`).length === 0);
  check("an early return inside a helper function does not count", analyze("x.tsx", `
    function A() { function pick(x) { if (!x) return 1; return 2; } const [a] = useState(pick(1)); return <b>{a}</b>; }`).length === 0);
  check("custom hooks are checked too", analyze("x.ts", `
    export function useThing(id) { if (!id) return null; const [a] = useState(0); return a; }`).length === 1);

  console.log("\n§2 no component or hook in the product does it");
  const hits = [...files(join(ROOT, "app")), ...files(join(ROOT, "components")), ...files(join(ROOT, "lib"))]
    .flatMap((f) => analyze(relative(ROOT, f), readFileSync(f, "utf8")));
  check(`${hits.length} hook call${hits.length === 1 ? "" : "s"} below an early return`, hits.length === 0);
  for (const h of hits) console.log(`      ${h.file}:${h.line}  ${h.component} calls ${h.hook}() after the return on line ${h.returnLine}`);

  console.log(failed ? `\n${failed} FAILED` : "\nall passed");
  process.exit(failed ? 1 : 0);
}
main();
