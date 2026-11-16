/**
 * Stored files never run as a page on our origin, and staff-only file kinds
 * never reach a member login.
 *
 *   npx tsx scripts/file-response-tests.ts
 *
 * No database, no network.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileResponseHeaders, isInlineSafe, STAFF_ONLY_FILE_KINDS } from "../lib/fileResponse";

let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : `  — ${detail}`}`);
}
const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

console.log("\n§1 what a browser may render inline");
for (const t of ["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf", "IMAGE/PNG", "image/png; charset=binary"]) {
  check(`${t} is inline-safe`, isInlineSafe(t));
}
for (const t of ["image/svg+xml", "text/html", "text/plain", "application/xhtml+xml", "application/msword", "", null, undefined]) {
  check(`${String(t) || "(empty)"} is NOT inline-safe`, !isInlineSafe(t as string));
}

console.log("\n§2 an SVG is a download in a sandbox, a photo is untouched");
const svg = fileResponseHeaders({ mimeType: "image/svg+xml", size: 10, cacheControl: "private", originalName: "logo.svg" });
check("svg: attachment", svg["Content-Disposition"].startsWith("attachment;"), svg["Content-Disposition"]);
check("svg: sandboxed, no script source", /sandbox/.test(svg["Content-Security-Policy"] ?? "") && /default-src 'none'/.test(svg["Content-Security-Policy"] ?? ""));
check("svg: nosniff", svg["X-Content-Type-Options"] === "nosniff");
const png = fileResponseHeaders({ mimeType: "image/png", size: 10, cacheControl: "private", originalName: "me.png" });
check("png: inline", png["Content-Disposition"].startsWith("inline;"));
check("png: no sandbox header", png["Content-Security-Policy"] === undefined);
check("png: nosniff", png["X-Content-Type-Options"] === "nosniff");
const pdf = fileResponseHeaders({ mimeType: "application/pdf", size: 10, cacheControl: "private", originalName: "waiver.pdf" });
check("pdf: inline and not sandboxed (viewers refuse a sandbox)", pdf["Content-Disposition"].startsWith("inline;") && pdf["Content-Security-Policy"] === undefined);
const noName = fileResponseHeaders({ mimeType: "image/svg+xml", size: 10, cacheControl: "public" });
check("svg with no filename is still an attachment", noName["Content-Disposition"] === "attachment");
const rasterNoName = fileResponseHeaders({ mimeType: "image/webp", size: 10, cacheControl: "public" });
check("raster with no filename sets no disposition", rasterNoName["Content-Disposition"] === undefined);

console.log("\n§3 a filename cannot break out of its header");
const nasty = fileResponseHeaders({ mimeType: "image/png", size: 1, cacheControl: "private", originalName: 'a"b\r\nSet-Cookie: x=1\\.png' });
check("quotes, backslashes and line breaks are removed", !/["\\\r\n]/.test(nasty["Content-Disposition"].replace(/^inline; filename="|"$/g, "")), nasty["Content-Disposition"]);
const long = fileResponseHeaders({ mimeType: "image/png", size: 1, cacheControl: "private", originalName: "x".repeat(5000) });
check("a very long name is cut", long["Content-Disposition"].length < 260);

console.log("\n§4 staff-only kinds");
for (const k of ["document", "LEDGER", "RECEIPT"]) check(`${k} is staff-only`, STAFF_ONLY_FILE_KINDS.has(k));
for (const k of ["IMAGE", "DOCUMENT", "OTHER"]) check(`${k} stays available to the club's members`, !STAFF_ONLY_FILE_KINDS.has(k));

console.log("\n§5 the routes that hand files out use the shared headers");
const files = read("app/api/files/[id]/route.ts");
check("/api/files/[id] builds headers with fileResponseHeaders", /fileResponseHeaders\(/.test(files) && !/"Content-Type": file\.mimeType/.test(files));
check("/api/files/[id] refuses staff-only kinds for a member login", /STAFF_ONLY_FILE_KINDS\.has\(file\.kind\)[\s\S]{0,120}requireStaff\(session\)/.test(files));
check("/api/files/[id] still scopes by club before anything else", files.indexOf("file.clubId !== session.user.clubId") > 0 && files.indexOf("file.clubId !== session.user.clubId") < files.indexOf("getObject(file.storageKey)"));
const logo = read("app/api/public/club-logo/[clubId]/route.ts");
check("the public club-logo route uses the shared headers", /fileResponseHeaders\(/.test(logo) && !/"Content-Type": file\.mimeType/.test(logo));

console.log("\n§6 the partner search gives out names only");
const search = read("app/api/member/privates/search-partners/route.ts");
const select = /select:\s*\{([^}]*)\}/.exec(search.slice(search.indexOf("prisma.member.findMany")))?.[1] ?? "";
check("the result select has no email", !/email/.test(select), select.trim());
check("email is not a search field", !/email:\s*\{\s*contains/.test(search));

console.log(`\n${"─".repeat(70)}`);
if (failed) {
  console.log(`✗ ${failed} file-response check(s) failed\n`);
  process.exit(1);
}
console.log("✓ file-response tests passed\n");
