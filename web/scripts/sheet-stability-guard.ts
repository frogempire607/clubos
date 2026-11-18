/**
 * Sheets and pop-ups stay open until the person closes them (2026-11-18).
 *
 *   npx tsx scripts/sheet-stability-guard.ts
 *
 * A source guard, run on every build. It reads every screen and component and
 * fails on the four shapes that made sheets close by themselves or lose what
 * was typed in them (docs/CRASH-AUDIT-2026-11-18.md):
 *
 *   A. CLOSE-ON-REFRESH. A component that draws a sheet, blanks itself while a
 *      `loading` flag is up, and raises that flag again on every reload. The
 *      reload after a save (or any background refresh) then unmounts the sheet
 *      mid-edit. Use `useFirstLoad()` (lib/firstLoad.ts): the flag can blank
 *      the screen once, and later reloads swap the data underneath.
 *
 *   B. BACKDROP ON THE CONTAINER. `onClick={onClose}` on the full-screen
 *      element that also CONTAINS the panel. A text selection dragged out past
 *      the panel edge ends as a click on that container and closes the sheet.
 *      Use `{...backdropDismiss(onClose)}` (lib/overlay.ts), which only closes
 *      when the press both started and ended on the backdrop itself.
 *
 *   D. A PRIVATE SCROLL LOCK (`document.body.style.overflow = …`). Two of them
 *      closing out of order left the page unable to scroll until a reload.
 *      Use `useScrollLock()` / `useOverlayLayer()` (lib/overlay.ts).
 *
 *   C. A PRIVATE ESCAPE LISTENER in a sheet. With a confirm dialog open on top,
 *      one Escape press answered the dialog AND closed the sheet under it. Use
 *      `useEscapeToClose()` (lib/overlay.ts): only the top layer hears Escape.
 *
 * No database, no network: it parses source with the TypeScript compiler.
 */
import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export type Violation = { rule: "A" | "B" | "C" | "D"; file: string; line: number; component: string; detail: string };

const OVERLAY_TAG = /(Modal|Drawer|Dialog|Sheet|Popover|Composer)$/;
const FULLSCREEN = /\bfixed\b[^"'`]*\binset-0\b/;

/** Components known (from a first pass over the repo) to draw a sheet somewhere inside them. */
let HOSTS: Set<string> = new Set();

function isOverlayElement(node: ts.Node): boolean {
  if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return false;
  const tag = node.tagName.getText();
  if (/^[A-Z]/.test(tag) && (OVERLAY_TAG.test(tag) || HOSTS.has(tag))) return true;
  return node.attributes.properties.some(
    (p) => ts.isJsxAttribute(p) && p.name.getText() === "className" && !!p.initializer && FULLSCREEN.test(p.initializer.getText()),
  );
}

function contains(node: ts.Node, pred: (n: ts.Node) => boolean): boolean {
  let hit = false;
  const walk = (n: ts.Node) => { if (hit) return; if (pred(n)) { hit = true; return; } ts.forEachChild(n, walk); };
  walk(node);
  return hit;
}

function containsJsx(node: ts.Node): boolean {
  return contains(node, (n) => ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n));
}

type Fn = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;
function fnName(fn: Fn): string {
  if (ts.isFunctionDeclaration(fn) && fn.name) return fn.name.text;
  const p = fn.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  return "(anonymous)";
}

/** Walk a component's own body without descending into nested components. */
function walkOwn(body: ts.Node, visit: (n: ts.Node) => void) {
  const walk = (n: ts.Node) => {
    visit(n);
    ts.forEachChild(n, (c) => {
      // A nested function that itself returns JSX and is named like a component is its own unit.
      if ((ts.isFunctionDeclaration(c) || ts.isArrowFunction(c) || ts.isFunctionExpression(c)) && /^[A-Z]/.test(fnName(c as Fn)) && containsJsx(c)) return;
      walk(c);
    });
  };
  walk(body);
}

export function analyze(file: string, source: string): Violation[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Violation[] = [];
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;

  const components: Fn[] = [];
  const collect = (n: ts.Node) => {
    if ((ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.body && /^[A-Z]/.test(fnName(n)) && containsJsx(n)) components.push(n);
    ts.forEachChild(n, collect);
  };
  collect(sf);

  // ── D: a private scroll lock ──
  const lockRe = /document\.body\.style\.overflow\s*=/g;
  for (let m = lockRe.exec(source); m; m = lockRe.exec(source)) {
    out.push({
      rule: "D", file, line: sf.getLineAndCharacterOfPosition(m.index).line + 1, component: "-",
      detail: "sets body.style.overflow by hand: two of these closing out of order leave the page unable to scroll. Use useScrollLock() / useOverlayLayer() from lib/overlay.ts.",
    });
  }

  for (const comp of components) {
    const name = fnName(comp);
    const body = comp.body!;

    // ── state flags: const [flag, setFlag] = useState(...) / useFirstLoad() ──
    const setterOf = new Map<string, string>(); // flag -> setter
    const latched = new Set<string>(); // flags that came from useFirstLoad
    walkOwn(body, (n) => {
      if (!ts.isVariableDeclaration(n) || !ts.isArrayBindingPattern(n.name) || !n.initializer || !ts.isCallExpression(n.initializer)) return;
      const callee = n.initializer.expression.getText();
      const [a, b] = n.name.elements;
      if (!a || !b || !ts.isBindingElement(a) || !ts.isBindingElement(b)) return;
      if (/^(React\.)?useState$/.test(callee)) setterOf.set(a.name.getText(), b.name.getText());
      if (callee === "useFirstLoad") latched.add(a.name.getText());
    });

    // ── does this component draw a sheet at all? ──
    let drawsOverlay = false;
    walkOwn(body, (n) => { if (isOverlayElement(n)) drawsOverlay = true; });

    // ── A: which flags blank the part of the screen a sheet lives in? ──
    const blanking = new Map<string, ts.Node>(); // flag -> where it blanks
    const emptied = new Map<string, ts.Node>(); // data state whose absence blanks the component
    const flagIn = (expr: ts.Expression): string | null => {
      const t = expr.getText().replace(/^!+/, "").replace(/[()]/g, "").trim();
      return setterOf.has(t) ? t : null;
    };
    if (drawsOverlay && ts.isBlock(body)) {
      // (1) `if (loading) return …` / `if (loading || !data) return …` at the top
      //     of the component: everything after it goes, sheets included.
      for (const st of body.statements) {
        if (!ts.isIfStatement(st)) continue;
        const returns = ts.isReturnStatement(st.thenStatement) || (ts.isBlock(st.thenStatement) && st.thenStatement.statements.some(ts.isReturnStatement));
        if (!returns) continue;
        for (const part of st.expression.getText().split("||").map((x) => x.trim().replace(/^\(|\)$/g, ""))) {
          const negated = part.startsWith("!");
          const id = part.replace(/^!+/, "").trim();
          if (!setterOf.has(id)) continue;
          if (negated) emptied.set(id, st);
          else blanking.set(id, st);
        }
      }
    }
    // (2) `{loading ? <Skeleton/> : <…a sheet…/>}` or `{!loading && <…a sheet…/>}`
    walkOwn(body, (n) => {
      if (ts.isConditionalExpression(n)) {
        const flag = flagIn(n.condition);
        if (!flag) return;
        const negated = n.condition.getText().trim().startsWith("!");
        const shown = negated ? n.whenTrue : n.whenFalse;
        if (contains(shown, isOverlayElement)) blanking.set(flag, n);
      } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        const left = n.left.getText().trim();
        if (!left.startsWith("!")) return;
        const flag = flagIn(n.left);
        if (flag && contains(n.right, isOverlayElement)) blanking.set(flag, n);
      }
    });
    for (const [flag, where] of blanking) {
      if (latched.has(flag)) continue;
      const setter = setterOf.get(flag)!;
      // A loading flag goes up AND comes down. One that only ever goes up
      // ("done", "forbidden") is a final screen, not a reload.
      let rearm: ts.Node | null = null;
      let lowered = false;
      walkOwn(body, (n) => {
        if (!ts.isCallExpression(n) || n.expression.getText() !== setter) return;
        const arg = n.arguments[0];
        if (arg && arg.kind === ts.SyntaxKind.TrueKeyword) rearm = rearm ?? n;
        if (arg && arg.kind === ts.SyntaxKind.FalseKeyword) lowered = true;
      });
      if (rearm && lowered) {
        out.push({
          rule: "A", file, line: lineOf(rearm), component: name,
          detail: `\`${setter}(true)\` re-raises the flag that blanks this component (line ${lineOf(where)}), unmounting any open sheet. Use useFirstLoad() from lib/firstLoad.ts.`,
        });
      }
    }

    // …and the same thing spelled `setData(null)` before a refetch.
    for (const [flag, where] of emptied) {
      const setter = setterOf.get(flag)!;
      walkOwn(body, (n) => {
        if (!ts.isCallExpression(n) || n.expression.getText() !== setter) return;
        const arg = n.arguments[0];
        if (!arg || (arg.kind !== ts.SyntaxKind.NullKeyword && arg.getText() !== "undefined")) return;
        out.push({
          rule: "A", file, line: lineOf(n), component: name,
          detail: `\`${setter}(null)\` empties the data this component needs to draw (line ${lineOf(where)}), unmounting any open sheet. Keep the old data until the new data arrives.`,
        });
      });
    }

    // ── B: onClick on the full-screen container itself ──
    walkOwn(body, (n) => {
      if (!ts.isJsxOpeningElement(n)) return; // self-closing = a separate backdrop element, which is safe
      let full = false, click: ts.JsxAttribute | null = null;
      for (const p of n.attributes.properties) {
        if (!ts.isJsxAttribute(p)) continue;
        const k = p.name.getText();
        if (k === "className" && p.initializer && FULLSCREEN.test(p.initializer.getText())) full = true;
        if (k === "onClick") click = p;
      }
      if (!full || !click) return;
      const parent = n.parent;
      const hasChildElements = ts.isJsxElement(parent) && parent.children.some((c) => ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c) || ts.isJsxExpression(c));
      if (!hasChildElements) return;
      out.push({
        rule: "B", file, line: lineOf(click), component: name,
        detail: "onClick on the full-screen element that contains the panel: a drag released outside the panel closes it. Use {...backdropDismiss(onClose)} from lib/overlay.ts.",
      });
    });

    // ── C: a private Escape listener in a component that draws a sheet ──
    if (drawsOverlay) {
      walkOwn(body, (n) => {
        if (!ts.isCallExpression(n) || !/\.addEventListener$/.test(n.expression.getText())) return;
        if (n.arguments[0]?.getText().replace(/['"`]/g, "") !== "keydown") return;
        // resolve an inline handler, or look for "Escape" anywhere in the component as a fallback
        if (!contains(body, (m) => ts.isStringLiteral(m) && m.text === "Escape")) return;
        out.push({
          rule: "C", file, line: lineOf(n), component: name,
          detail: "a private keydown/Escape listener: with a confirm dialog on top, one Escape closes both. Use useEscapeToClose() from lib/overlay.ts.",
        });
      });
    }
  }
  return out;
}

/** Component name → the component tags it renders, and whether it draws a sheet itself. */
export function hostsOf(sources: { file: string; source: string }[]): Set<string> {
  const renders = new Map<string, Set<string>>();
  const direct = new Set<string>();
  HOSTS = new Set();
  for (const { file, source } of sources) {
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const defaultName = /export default function (\w+)/.exec(source)?.[1];
    const visit = (n: ts.Node) => {
      if ((ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.body && /^[A-Z]/.test(fnName(n)) && containsJsx(n)) {
        const name = fnName(n);
        const tags = renders.get(name) ?? new Set<string>();
        walkOwn(n.body, (m) => {
          if (ts.isJsxOpeningElement(m) || ts.isJsxSelfClosingElement(m)) {
            const t = m.tagName.getText();
            if (/^[A-Z]/.test(t)) tags.add(t);
            if (isOverlayElement(m)) direct.add(name);
          }
        });
        renders.set(name, tags);
        void defaultName;
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  const hosts = new Set(direct);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, tags] of renders) {
      if (hosts.has(name)) continue;
      if ([...tags].some((t) => hosts.has(t))) { hosts.add(name); changed = true; }
    }
  }
  return hosts;
}

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p));
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

// The two files that implement the rules are the only places allowed to do the raw thing.
const EXEMPT = new Set(["lib/overlay.ts", "lib/firstLoad.ts"]);

export function scanRepo(): Violation[] {
  const files = [...tsxFiles(join(ROOT, "app")), ...tsxFiles(join(ROOT, "components"))]
    .map((f) => ({ file: relative(ROOT, f), source: readFileSync(f, "utf8") }))
    .filter((f) => !EXEMPT.has(f.file));
  HOSTS = hostsOf(files);
  try {
    return files.flatMap((f) => analyze(f.file, f.source));
  } finally {
    HOSTS = new Set();
  }
}

function main() {
  let failed = 0;
  const check = (label: string, ok: boolean, detail = "") => {
    if (!ok) failed++;
    console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : `  — ${detail}`}`);
  };

  // ── §1 the analyzer catches each shape (so a green run below means something) ──
  console.log("\n§1 the guard recognises each broken shape");
  const bad = (src: string) => analyze("fixture.tsx", src);
  const A_BAD = `
    function Page() {
      const [loading, setLoading] = useState(true);
      const [open, setOpen] = useState(false);
      const load = () => { setLoading(true); fetch("/x").then(() => setLoading(false)); };
      if (loading) return <p>Loading</p>;
      return <div>{open && <EditModal onSaved={load} />}</div>;
    }`;
  check("A: blank-on-loading + re-raised flag + a sheet → caught", bad(A_BAD).some((v) => v.rule === "A"));
  check("A: the same page on useFirstLoad() → clean", bad(A_BAD.replace("useState(true)", "useFirstLoad()")).filter((v) => v.rule === "A").length === 0);
  check("A: a ternary that hides the sheet while loading → caught", bad(`
    function List() {
      const [busy, setBusy] = useState(false);
      const reload = () => { setBusy(true); fetch("/x").then(() => setBusy(false)); };
      return <div>{busy ? <Spinner /> : <RowDrawer onDone={reload} />}</div>;
    }`).some((v) => v.rule === "A"));
  check("A: a page with no sheet may blank as often as it likes", bad(`
    function Report() {
      const [loading, setLoading] = useState(true);
      const load = () => { setLoading(true); };
      if (loading) return <p>Loading</p>;
      return <table />;
    }`).length === 0);
  check("A: a skeleton beside (not around) the sheet is fine", bad(`
    function Page() {
      const [loading, setLoading] = useState(true);
      const load = () => { setLoading(true); };
      return <div>{loading ? <Skeleton /> : <ul />}<EditModal onSaved={load} /></div>;
    }`).length === 0);
  const B_BAD = `function M({ onClose }) { return <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose}><div onClick={(e) => e.stopPropagation()}><input /></div></div>; }`;
  check("B: onClick on the container around the panel → caught", bad(B_BAD).some((v) => v.rule === "B"));
  check("B: backdropDismiss() → clean", bad(B_BAD.replace("onClick={onClose}", "{...backdropDismiss(onClose)}")).filter((v) => v.rule === "B").length === 0);
  check("B: a separate, empty backdrop element is fine", bad(`function M({ onClose }) { return <div><div className="fixed inset-0" onClick={onClose} /><div><input /></div></div>; }`).length === 0);
  check("C: a private Escape listener in a sheet → caught", bad(`
    function Drawer({ onClose }) {
      useEffect(() => { const k = (e) => { if (e.key === "Escape") onClose(); }; document.addEventListener("keydown", k); return () => document.removeEventListener("keydown", k); }, [onClose]);
      return <div className="fixed inset-0"><input /></div>;
    }`).some((v) => v.rule === "C"));

  // ── §2 the product ──
  check("D: a private scroll lock → caught", bad(`function M() { useEffect(() => { document.body.style.overflow = "hidden"; }, []); return <div />; }`).some((v) => v.rule === "D"));

  console.log("\n§2 no screen or component has any of the four shapes");
  const found = scanRepo();
  for (const rule of ["A", "B", "C", "D"] as const) {
    const v = found.filter((x) => x.rule === rule);
    check(`rule ${rule}: ${v.length} violation${v.length === 1 ? "" : "s"}`, v.length === 0);
    for (const x of v) console.log(`      ${x.file}:${x.line}  ${x.component} — ${x.detail}`);
  }

  console.log(failed ? `\n${failed} FAILED` : "\nall passed");
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
