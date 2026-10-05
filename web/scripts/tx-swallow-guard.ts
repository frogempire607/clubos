/**
 * The standing guard against swallowing a database error INSIDE an
 * interactive transaction.
 *
 *   npx tsx scripts/tx-swallow-guard.ts
 *
 * No database, no network — this reads the source tree.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * Finger Lakes Duals, 2026-10. approveRegistration ran, inside
 * `prisma.$transaction(async (db) => …)`:
 *
 *     try { await db.booking.create({ … }) } catch { // unique — fine }
 *
 * In Postgres a failed statement ABORTS the transaction. Catching the JS error
 * lets the callback return normally, Prisma sends COMMIT, and Postgres answers
 * a COMMIT on an aborted transaction by rolling back — without an error. The
 * registration update made earlier in the same transaction was lost while the
 * function returned ok:true, wrote an audit row and told the coach "approved".
 * An owner approved the same athlete ten times.
 *
 * Inside a transaction there is no such thing as an error you can ignore. Read
 * first (findUnique → create/update), or use upsert / createMany
 * skipDuplicates / deleteMany / updateMany, or do the tolerant write after the
 * transaction.
 *
 * ── What it flags (heuristic, on purpose) ───────────────────────────────────
 * Inside every `$transaction(async (<client>) => { … })` callback in lib/,
 * app/api/ and scripts/:
 *   A. `try { … } catch` whose try block writes through the transaction client
 *      (`db.x.create|update|upsert|delete…`, `$executeRaw`, `$queryRaw`) or
 *      hands the client to a helper (`helper(db, …)`).
 *   B. `db.x.create|update|upsert|delete…( … ).catch(` — the same thing, shorter.
 * And in any file that takes a `Prisma.TransactionClient` (a helper called
 * from inside someone else's transaction):
 *   C. A or B anywhere in the file, on a client named db / tx / trx.
 *
 * A `try` AROUND the whole `$transaction(...)` call is fine and not flagged:
 * the error left the callback, so the transaction rolled back honestly.
 *
 * ── Exceptions ──────────────────────────────────────────────────────────────
 * ALLOW below, each with the reason it is safe. Empty on the day it was
 * written — keep it that way unless the catch re-throws unconditionally.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..");
const SCAN_DIRS = ["lib", "app/api", "scripts"];
const SELF = "scripts/tx-swallow-guard.ts";

/** file (repo-relative) + a string the flagged snippet contains + why it is safe. */
const ALLOW: { file: string; contains: string; reason: string }[] = [];

export type Finding = { line: number; rule: "A" | "B" | "C"; snippet: string };

const WRITE_METHODS = "(?:create|update|upsert|delete)\\w*";

/** Index of the bracket closing the one at `open` (same kind), or -1. Skips strings and comments. */
function matchClose(src: string, open: number): number {
  const o = src[open];
  const c = o === "{" ? "}" : o === "(" ? ")" : "]";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") { const n = src.indexOf("\n", i); i = n < 0 ? src.length : n; continue; }
    if (ch === "/" && src[i + 1] === "*") { const n = src.indexOf("*/", i + 2); i = n < 0 ? src.length : n + 1; continue; }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== ch && src[j] !== "\n") { if (src[j] === "\\") j++; j++; }
      i = j; continue;
    }
    if (ch === "`") {
      // Template literal: skip text, but walk ${ … } so its braces stay balanced.
      let j = i + 1;
      while (j < src.length && src[j] !== "`") {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "$" && src[j + 1] === "{") { const e = matchClose(src, j + 1); if (e < 0) return -1; j = e + 1; continue; }
        j++;
      }
      i = j; continue;
    }
    if (ch === o) depth++;
    else if (ch === c) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

const lineOf = (src: string, idx: number) => src.slice(0, idx).split("\n").length;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 140);

/** Rules A and B over one region of source, for the given client names. */
function scanRegion(src: string, start: number, end: number, clients: string[], rule: "A" | "B" | "C"): Finding[] {
  const out: Finding[] = [];
  const names = clients.map((n) => n.replace(/[$]/g, "\\$")).join("|");
  const region = src.slice(start, end);
  const writeRe = new RegExp(`\\b(?:${names})\\s*\\.\\s*(?:\\$executeRaw|\\$queryRaw|\\w+\\s*\\.\\s*${WRITE_METHODS}\\s*\\()`);
  const helperRe = new RegExp(`(?<![.\\w])[A-Za-z_]\\w*\\(\\s*(?:${names})\\s*[,)]`);

  // A — try { …write… } catch
  const tryRe = /\btry\s*\{/g;
  for (let m = tryRe.exec(region); m; m = tryRe.exec(region)) {
    const open = start + m.index + m[0].length - 1;
    const close = matchClose(src, open);
    if (close < 0 || close > end) continue;
    if (!/^\s*catch\b/.test(src.slice(close + 1, close + 40))) continue; // try/finally re-throws
    const block = src.slice(open, close + 1);
    const hit = writeRe.exec(block) ?? helperRe.exec(block);
    if (hit) out.push({ line: lineOf(src, open + hit.index), rule: rule === "C" ? "C" : "A", snippet: oneLine(block.slice(hit.index)) });
  }

  // B — client.model.write( … ).catch(
  const callRe = new RegExp(`\\b(?:${names})\\s*\\.\\s*\\w+\\s*\\.\\s*${WRITE_METHODS}\\s*\\(`, "g");
  for (let m = callRe.exec(region); m; m = callRe.exec(region)) {
    const open = start + m.index + m[0].length - 1;
    const close = matchClose(src, open);
    if (close < 0) continue;
    if (/^\s*\.catch\s*\(/.test(src.slice(close + 1, close + 40))) {
      out.push({ line: lineOf(src, start + m.index), rule: rule === "C" ? "C" : "B", snippet: oneLine(src.slice(start + m.index, close + 12)) });
    }
  }
  return out;
}

export function scanSource(src: string): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  const add = (fs: Finding[]) => {
    for (const f of fs) {
      const k = `${f.line}:${f.snippet}`;
      if (!seen.has(k)) { seen.add(k); out.push(f); }
    }
  };

  // Interactive transaction callbacks.
  const txRe = /\$transaction\(\s*async\s*(?:\(\s*([A-Za-z_$][\w$]*)[^)]*\)|([A-Za-z_$][\w$]*))\s*=>\s*\{/g;
  for (let m = txRe.exec(src); m; m = txRe.exec(src)) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(src, open);
    if (close < 0) continue;
    const param = m[1] ?? m[2];
    add(scanRegion(src, open, close + 1, Array.from(new Set(["db", "tx", "trx", param])), "A"));
  }

  // Helpers that are handed a transaction client.
  if (/\bTransactionClient\b|\bTenantTx\b/.test(src)) add(scanRegion(src, 0, src.length, ["db", "tx", "trx"], "C"));
  return out.sort((a, b) => a.line - b.line);
}

// ── Fixtures: the guard must catch the bug it was written for ───────────────
let failed = false;
let pass = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { failed = true; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

// lib/eventApproval.ts approveRegistration, verbatim, before the 2026-10 fix.
const ORIGINAL_BUG = [
  "const decided = await prisma.$transaction(async (db) => {",
  "  const updated = await db.eventRegistration.update({ where: { id: reg.id }, data: { approvalStatus: \"APPROVED\" } });",
  "  if (reg.memberId) {",
  "    try {",
  "      await db.booking.create({",
  "        data: {",
  "          eventId: reg.eventId,",
  "          memberId: reg.memberId,",
  "          status: \"CONFIRMED\",",
  "          bookedByUserId: args.bookedByUserId ?? args.actorUserId,",
  "        },",
  "      });",
  "    } catch {",
  "      // Unique (eventId, memberId): a concurrent path already booked them.",
  "      // That is the outcome we wanted, so it is not an error for the coach.",
  "    }",
  "  }",
  "  return { reg, updated };",
  "});",
].join("\n");

const DOT_CATCH = [
  "await prisma.$transaction(async (db) => {",
  "  await db.booking",
  "    .delete({ where: { eventId_memberId: { eventId: reg.eventId, memberId: reg.memberId } } })",
  "    .catch(() => undefined);",
  "});",
].join("\n");

const FIXED = [
  "await prisma.$transaction(async (db) => {",
  "  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`evbooking:${reg.eventId}`}, 0))`;",
  "  const existing = await db.booking.findUnique({ where: { id } });",
  "  if (!existing) await db.booking.create({ data: { eventId, memberId } });",
  "  await db.booking.deleteMany({ where: { eventId } });",
  "});",
  "try { await sendEmail(); } catch (e) { console.error(e); }",
].join("\n");

const TRY_AROUND = [
  "try {",
  "  await prisma.$transaction(async (tx) => {",
  "    await tx.staffProfile.create({ data: { userId } });",
  "    await tx.user.update({ where: { id }, data });",
  "  });",
  "} catch {",
  "  return NextResponse.json({ error: \"in use\" }, { status: 409 });",
  "}",
].join("\n");

const HELPER_IN_TRY = [
  "await prisma.$transaction(async (tx) => {",
  "  try { await recordThing(tx, input); } catch (e) { console.error(e); }",
  "});",
].join("\n");

const OTHER_PARAM = [
  "await prisma.$transaction(async (client) => {",
  "  try { await client.booking.upsert({ where, create, update }); } catch {}",
  "});",
].join("\n");

const RAW_IN_TRY = [
  "await prisma.$transaction(async (db) => {",
  "  try { await db.$executeRaw`UPDATE x SET y = 1`; } catch {}",
  "});",
].join("\n");

const HELPER_FILE = [
  "export async function claim(db: Prisma.TransactionClient, id: string) {",
  "  await db.entry.update({ where: { id }, data: { status: \"ACTIVE\" } }).catch(() => null);",
  "}",
].join("\n");

const READ_IN_TRY = [
  "await prisma.$transaction(async (db) => {",
  "  try { JSON.parse(raw); } catch { raw = \"{}\"; }",
  "  await db.booking.create({ data });",
  "});",
].join("\n");

console.log("Fixtures:");
check("the original approve bug is flagged (rule A)", scanSource(ORIGINAL_BUG).some((f) => f.rule === "A" && f.snippet.includes("db.booking.create")), JSON.stringify(scanSource(ORIGINAL_BUG)));
check("…on the line of the swallowed write", scanSource(ORIGINAL_BUG)[0]?.line === 5, String(scanSource(ORIGINAL_BUG)[0]?.line));
check("delete().catch() in a transaction is flagged (rule B)", scanSource(DOT_CATCH).some((f) => f.rule === "B"), JSON.stringify(scanSource(DOT_CATCH)));
check("read-then-write + deleteMany is clean", scanSource(FIXED).length === 0, JSON.stringify(scanSource(FIXED)));
check("try AROUND the whole transaction is clean", scanSource(TRY_AROUND).length === 0, JSON.stringify(scanSource(TRY_AROUND)));
check("a helper handed the client inside try/catch is flagged", scanSource(HELPER_IN_TRY).length === 1);
check("a differently-named client is still caught", scanSource(OTHER_PARAM).length === 1);
check("raw SQL in try/catch is flagged", scanSource(RAW_IN_TRY).length === 1);
check("a TransactionClient helper's .catch is flagged (rule C)", scanSource(HELPER_FILE).some((f) => f.rule === "C"));
check("a try/catch with no db write inside a transaction is clean", scanSource(READ_IN_TRY).length === 0, JSON.stringify(scanSource(READ_IN_TRY)));

// ── The tree ────────────────────────────────────────────────────────────────
function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

console.log("\nSource tree:");
let files = 0;
let callbacks = 0;
let violations = 0;
const usedAllow = new Set<number>();
for (const dir of SCAN_DIRS) {
  for (const p of walk(join(ROOT, dir))) {
    const rel = relative(ROOT, p).split("\\").join("/");
    if (rel === SELF) continue;
    const src = readFileSync(p, "utf8");
    if (!src.includes("$transaction") && !src.includes("TransactionClient") && !src.includes("TenantTx")) continue;
    files++;
    callbacks += (src.match(/\$transaction\(\s*async/g) ?? []).length;
    for (const f of scanSource(src)) {
      const ai = ALLOW.findIndex((a) => a.file === rel && f.snippet.includes(a.contains));
      if (ai >= 0) { usedAllow.add(ai); console.log(`  allowed ${rel}:${f.line} — ${ALLOW[ai].reason}`); continue; }
      violations++;
      console.log(`  FAIL ${rel}:${f.line} [rule ${f.rule}] ${f.snippet}`);
    }
  }
}
ALLOW.forEach((a, i) => {
  if (!usedAllow.has(i)) { failed = true; console.log(`  FAIL stale allowlist entry: ${a.file} "${a.contains}" no longer matches anything — remove it`); }
});
if (violations > 0) {
  failed = true;
  console.log(
    `\n${violations} swallowed write(s) inside a transaction. A failed statement aborts the Postgres transaction; catching it makes COMMIT a silent rollback.\n` +
      "Read first (findUnique → create/update), use upsert / createMany skipDuplicates / deleteMany, or move the tolerant write after the transaction.",
  );
} else {
  console.log(`  ok  ${callbacks} interactive transaction(s) across ${files} file(s): no swallowed writes`);
}

console.log(`\n${pass} fixture checks passed${failed ? " — GUARD FAILED" : ""}`);
if (failed) process.exit(1);
