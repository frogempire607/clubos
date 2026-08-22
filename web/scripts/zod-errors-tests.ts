/**
 * Tests for lib/zodErrors.ts — turning Zod's terse validator output into a
 * message a club owner can act on.
 *
 * No DB, no network. Run:  npx tsx scripts/zod-errors-tests.ts
 *
 * The bar: every message names WHICH field is wrong and reads as English.
 * "Array must contain at least 1 element(s)" told an owner nothing about
 * which of the two arrays in the bulk-send payload was empty.
 */
import { z } from "zod";
import { formatZodError, humanizeFieldPath } from "../lib/zodErrors";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`  FAIL ${name}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ""}`); }
}

/** Parse something invalid and format whatever Zod complains about. */
function msg(schema: z.ZodTypeAny, value: unknown): string {
  try { schema.parse(value); return "(no error)"; }
  catch (e) { return e instanceof z.ZodError ? formatZodError(e) : `(not a ZodError: ${e})`; }
}

console.log("\nhumanizeFieldPath:");
check("camelCase becomes words", humanizeFieldPath(["previewText"]) === "Preview text", humanizeFieldPath(["previewText"]));
check("trailing Ids reads as IDs", humanizeFieldPath(["memberIds"]) === "Member IDs", humanizeFieldPath(["memberIds"]));
check("nested paths keep their parent", humanizeFieldPath(["email", "blocks"]) === "Email blocks", humanizeFieldPath(["email", "blocks"]));
check("array indices read as items", humanizeFieldPath(["members", 3, "email"]) === "Members item 4 email", humanizeFieldPath(["members", 3, "email"]));
check("an empty path still says something", humanizeFieldPath([]).length > 0, humanizeFieldPath([]));

console.log("\nformatZodError — the message that started this:");
// The exact bulk-send shape: two arrays, either of which can be empty.
const bulk = z.object({
  memberIds: z.array(z.string().min(1)).min(1).max(5000),
  email: z.object({ subject: z.string().min(1).max(300), blocks: z.array(z.unknown()).min(1) }).optional(),
});
const emptyMembers = msg(bulk, { memberIds: [], email: { subject: "Hi", blocks: [{}] } });
check("an empty memberIds names memberIds", emptyMembers.includes("Member IDs"), emptyMembers);
check("…and does NOT read like a raw validator", !emptyMembers.includes("element(s)"), emptyMembers);
const emptyBlocks = msg(bulk, { memberIds: ["m1"], email: { subject: "Hi", blocks: [] } });
check("an empty blocks names email blocks", emptyBlocks.includes("Email blocks"), emptyBlocks);
check("the two empty-array cases are distinguishable", emptyMembers !== emptyBlocks, [emptyMembers, emptyBlocks]);

console.log("\nformatZodError — the common failure shapes:");
check("a missing required field says so",
  msg(z.object({ subject: z.string() }), {}).toLowerCase().includes("required"), msg(z.object({ subject: z.string() }), {}));
check("an empty required string is 'required', not 'at least 1 character'",
  !msg(z.object({ subject: z.string().min(1) }), { subject: "" }).includes("character"),
  msg(z.object({ subject: z.string().min(1) }), { subject: "" }));
check("a too-long string names the limit",
  msg(z.object({ subject: z.string().max(3) }), { subject: "abcd" }).includes("3"),
  msg(z.object({ subject: z.string().max(3) }), { subject: "abcd" }));
check("a bad email says so plainly",
  msg(z.object({ replyTo: z.string().email() }), { replyTo: "nope" }).toLowerCase().includes("email address"),
  msg(z.object({ replyTo: z.string().email() }), { replyTo: "nope" }));
check("a bad enum lists the allowed values",
  msg(z.object({ mode: z.enum(["HOUSEHOLD", "PER_MEMBER"]) }), { mode: "NOPE" }).includes("HOUSEHOLD"),
  msg(z.object({ mode: z.enum(["HOUSEHOLD", "PER_MEMBER"]) }), { mode: "NOPE" }));
check("a wrong type names both the field and what was expected",
  (() => { const m = msg(z.object({ count: z.number() }), { count: "12" }); return m.includes("Count") && m.toLowerCase().includes("number"); })(),
  msg(z.object({ count: z.number() }), { count: "12" }));
check("too many items names the cap",
  msg(z.object({ memberIds: z.array(z.string()).max(2) }), { memberIds: ["a", "b", "c"] }).includes("2"),
  msg(z.object({ memberIds: z.array(z.string()).max(2) }), { memberIds: ["a", "b", "c"] }));

console.log("\nformatZodError — safety:");
check("never returns an empty string", msg(z.object({ a: z.string() }), {}).trim().length > 0);
check("ends as a sentence", /[.!]$/.test(msg(z.object({ a: z.string() }), {})), msg(z.object({ a: z.string() }), {}));
check("reports the first issue when several fields are wrong",
  msg(z.object({ a: z.string(), b: z.number() }), {}).includes("A"), msg(z.object({ a: z.string(), b: z.number() }), {}));
check("a top-level type error still produces a sentence",
  msg(z.object({ a: z.string() }), "not-an-object").length > 0, msg(z.object({ a: z.string() }), "not-an-object"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
