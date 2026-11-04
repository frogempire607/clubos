/**
 * Guard: Next.js route files may only export route handlers and route config.
 *
 *   npx tsx scripts/route-exports-tests.ts
 *
 * 2026-11-03: a helper exported from billing-admin/actions/route.ts passed the
 * type check and the tests but failed `next build` on Netlify ("… is not a
 * valid Route export field"). Next only validates route exports during its
 * own build, so this scans every app/**\/route.ts for anything else.
 */
import * as fs from "fs";
import * as path from "path";

const ALLOWED = new Set([
  "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS",
  "dynamic", "dynamicParams", "revalidate", "fetchCache", "runtime", "preferredRegion", "maxDuration", "generateStaticParams",
]);
const root = path.join(__dirname, "..", "app");
const bad: string[] = [];
let files = 0;
function walk(dir: string) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/^route\.(ts|tsx|js)$/.test(e.name)) {
      files++;
      const src = fs.readFileSync(p, "utf8");
      const re = /^export\s+(?:async\s+)?(?:function|const|let|var|class|type|interface)\s+([A-Za-z0-9_$]+)/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const isType = /^export\s+(type|interface)\s/.test(m[0]);
        if (!isType && !ALLOWED.has(m[1])) bad.push(`${path.relative(root, p)}: export ${m[1]}`);
      }
      for (const b of Array.from(src.matchAll(/^export\s*\{([^}]*)\}/gm))) {
        for (const part of b[1].split(",").map((x) => x.trim()).filter(Boolean)) {
          const name = part.split(/\s+as\s+/).pop()!.trim();
          if (!ALLOWED.has(name)) bad.push(`${path.relative(root, p)}: export { ${part} }`);
        }
      }
    }
  }
}
walk(root);
if (bad.length) {
  console.log(`✗ route files export things Next.js rejects at build time:\n  ${bad.join("\n  ")}`);
  process.exit(1);
}
console.log(`✓ ${files} route files export only handlers / route config`);
