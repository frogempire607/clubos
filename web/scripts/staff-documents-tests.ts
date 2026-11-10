// Phase 12.1 Part 4 — staff documents and e-signatures.
//
//   npm run test:staff-documents     (and it GATES the build)
//
// No database, no network.
//
// §6 IS THE SEPARATION GUARD. A staff handbook or a non-compete must never
// appear in a member's document list. `Document.audience` defaults to MEMBER,
// so every existing row and write is unaffected — which also means a MISSED
// filter is invisible until the day a club creates its first staff document.
// So the guard enumerates every member-facing document read and fails the
// build if one of them stops filtering.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ASSIGNMENT_SCOPES,
  assignedStaffIds,
  documentStatus,
  dueDateFor,
  isAssignmentScope,
  needsNewVersion,
  outstandingFor,
  statusFor,
  validateSignature,
  type Assignment,
  type SignatureRow,
  type StaffPerson,
} from "../lib/staffDocuments";

const ROOT = join(__dirname, "..");
let pass = 0;
const fails: string[] = [];
const ok = (cond: boolean, name: string, detail?: string) => {
  if (cond) pass++;
  else fails.push(detail ? `${name} — ${detail}` : name);
};
const eq = <T,>(actual: T, expected: T, name: string) =>
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    name,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );

const STAFF: StaffPerson[] = [
  { userId: "u_owner", name: "Avery Owner", email: "avery@example.com", title: "Owner" },
  { userId: "u_head", name: "Dana Head", email: "dana@example.com", title: "Head Coach" },
  { userId: "u_asst", name: "Sam Assistant", email: "sam@example.com", title: "Assistant Coach" },
  { userId: "u_desk", name: "Kit Desk", email: null, title: "Front Desk" },
  { userId: "u_notitle", name: "Rowan Untitled", email: "rowan@example.com", title: null },
];
const A = (over: Partial<Assignment> & { scope: Assignment["scope"] }): Assignment => ({
  id: `a_${Math.random().toString(36).slice(2, 8)}`,
  staffUserId: null,
  role: null,
  dueDate: null,
  ...over,
});
const sig = (staffUserId: string, documentVersion: number, signedAt = "2026-10-01T10:00:00.000Z"): SignatureRow => ({
  staffUserId,
  documentVersion,
  signedAt,
  signerName: "signed",
});

// ── 1. Who is assigned ──────────────────────────────────────────────────────
console.log("[1] assignment");
{
  eq([...assignedStaffIds([A({ scope: "ALL" })], STAFF)].sort(), STAFF.map((s) => s.userId).sort(), "1.1 ALL means everyone, owners included");
  eq([...assignedStaffIds([A({ scope: "STAFF", staffUserId: "u_head" })], STAFF)], ["u_head"], "1.2 STAFF means one named person");
  eq([...assignedStaffIds([A({ scope: "ROLE", role: "Head Coach" })], STAFF)], ["u_head"], "1.3 ROLE matches a title");
  eq([...assignedStaffIds([A({ scope: "ROLE", role: "head coach" })], STAFF)], ["u_head"], "1.4 case-insensitively");
  eq([...assignedStaffIds([A({ scope: "ROLE", role: "  Head Coach  " })], STAFF)], ["u_head"], "1.5 and trimmed — a stray space must not empty the list");
  eq([...assignedStaffIds([A({ scope: "ROLE", role: "Nobody" })], STAFF)], [], "1.6 a role nobody holds assigns nobody");

  // The union, with no duplicates.
  const both = assignedStaffIds(
    [A({ scope: "ROLE", role: "Head Coach" }), A({ scope: "STAFF", staffUserId: "u_head" })],
    STAFF,
  );
  eq([...both], ["u_head"], "1.7 the same person twice is still one person");
  const mixed = assignedStaffIds(
    [A({ scope: "STAFF", staffUserId: "u_desk" }), A({ scope: "ROLE", role: "Head Coach" })],
    STAFF,
  );
  eq([...mixed].sort(), ["u_desk", "u_head"], "1.8 separate assignments add up");

  // A departed colleague's leftover assignment must not resurrect them.
  eq([...assignedStaffIds([A({ scope: "STAFF", staffUserId: "u_gone" })], STAFF)], [], "1.9 an assignment to somebody who has left assigns nobody");
  eq([...assignedStaffIds([A({ scope: "STAFF", staffUserId: null })], STAFF)], [], "1.10 a STAFF assignment with no person assigns nobody");
  eq([...assignedStaffIds([A({ scope: "ROLE", role: null })], STAFF)], [], "1.11 nor a ROLE assignment with no role");
  eq([...assignedStaffIds([], STAFF)], [], "1.12 no assignments means nobody");
  eq([...assignedStaffIds([A({ scope: "ALL" })], [])], [], "1.13 and ALL with no staff is still nobody");

  eq([...ASSIGNMENT_SCOPES], ["ALL", "ROLE", "STAFF"], "1.14 three scopes");
  ok(isAssignmentScope("ROLE") && !isAssignmentScope("EVERYONE"), "1.15 and only those three are accepted");
}

// ── 2. Due dates ────────────────────────────────────────────────────────────
console.log("\n[2] due dates");
{
  const assignments = [
    A({ scope: "ALL", dueDate: "2026-12-31" }),
    A({ scope: "ROLE", role: "Head Coach", dueDate: "2026-11-15" }),
    A({ scope: "STAFF", staffUserId: "u_desk" }),
  ];
  eq(dueDateFor(assignments, STAFF, "u_head"), "2026-11-15", "2.1 the SOONEST applicable date wins");
  eq(dueDateFor(assignments, STAFF, "u_asst"), "2026-12-31", "2.2 somebody only covered by ALL gets ALL's date");
  eq(dueDateFor(assignments, STAFF, "u_desk"), "2026-12-31", "2.3 an assignment with no date doesn't erase one that has it");
  eq(dueDateFor([A({ scope: "ALL" })], STAFF, "u_head"), null, "2.4 no dates means no due date");
  eq(dueDateFor(assignments, STAFF, "u_gone"), null, "2.5 and somebody unassigned has none");
}

// ── 3. Versions: a new one is owed, the old signature is kept ───────────────
console.log("\n[3] versions");
{
  eq(statusFor([], "u_head", 1), { status: "OUTSTANDING", signedAt: null, signedVersion: null }, "3.1 never signed is OUTSTANDING");

  const v1 = statusFor([sig("u_head", 1)], "u_head", 1);
  eq(v1.status, "SIGNED", "3.2 signed at the current version is SIGNED");
  eq(v1.signedVersion, 1, "3.3 and reports which version");

  // THE REQUIREMENT: a new version requires re-signing, and the old signature
  // is kept — so the answer is "signed v1", not "unsigned".
  const superseded = statusFor([sig("u_head", 1)], "u_head", 2);
  eq(superseded.status, "SUPERSEDED", "3.4 a new version makes an old signature SUPERSEDED, not absent");
  eq(superseded.signedVersion, 1, "3.5 and the version they DID sign is still reported");
  ok(!!superseded.signedAt, "3.6 as is when they signed it");

  const resigned = statusFor([sig("u_head", 1), sig("u_head", 2)], "u_head", 2);
  eq(resigned.status, "SIGNED", "3.7 re-signing the new version clears it");
  eq(resigned.signedVersion, 2, "3.8 reporting the newest version signed");

  // Somebody else's signature is not mine.
  eq(statusFor([sig("u_asst", 2)], "u_head", 2).status, "OUTSTANDING", "3.9 a colleague's signature doesn't count as mine");
  // A signature at a version AHEAD of current (an edit was reverted) still
  // counts: they signed this text.
  eq(statusFor([sig("u_head", 3)], "u_head", 2).status, "SIGNED", "3.10 a signature at a later version still counts as signed");

  // Only title and body publish a version.
  const before = { title: "Handbook", body: "<p>Rules</p>" };
  ok(needsNewVersion(before, { title: "Staff handbook" }), "3.11 changing the title publishes a new version");
  ok(needsNewVersion(before, { body: "<p>New rules</p>" }), "3.12 so does changing the body");
  ok(!needsNewVersion(before, { title: "Handbook" }), "3.13 saving the same title does not");
  ok(!needsNewVersion(before, { title: "  Handbook  " }), "3.14 nor does whitespace around it");
  ok(!needsNewVersion(before, {}), "3.15 nor does changing nothing");
  ok(!needsNewVersion(before, { body: "<p>Rules</p>" }), "3.16 nor saving the same body");
  ok(needsNewVersion({ title: "X", body: null }, { body: "<p>new</p>" }), "3.17 adding a body to an empty one does");
  ok(!needsNewVersion({ title: "X", body: null }, { body: null }), "3.18 and null to null does not");
}

// ── 4. The owner's status view ──────────────────────────────────────────────
console.log("\n[4] who has and hasn't signed");
{
  const assignments = [A({ scope: "ALL", dueDate: "2026-12-01" })];
  const signatures = [sig("u_head", 2), sig("u_asst", 1)];
  const s = documentStatus(assignments, STAFF, signatures, 2);

  eq(s.people.length, 5, "4.1 everybody assigned appears");
  eq(s.signed, 1, "4.2 one has signed the current version");
  eq(s.outstanding, 4, "4.3 and four have not");
  // Outstanding first: that is the list an owner came for.
  eq(s.people[0].status, "OUTSTANDING", "4.4 outstanding people are listed first");
  eq(s.people[s.people.length - 1].status, "SIGNED", "4.5 and signed ones last");
  const asst = s.people.find((p) => p.userId === "u_asst")!;
  eq(asst.status, "SUPERSEDED", "4.6 somebody who signed an older version is SUPERSEDED");
  eq(asst.signedVersion, 1, "4.7 with the version they signed");
  eq(s.people.every((p) => p.dueDate === "2026-12-01"), true, "4.8 and each carries their due date");

  // Only assigned people appear — a document for one role does not list the
  // whole team as outstanding.
  const roleOnly = documentStatus([A({ scope: "ROLE", role: "Head Coach" })], STAFF, [], 1);
  eq(roleOnly.people.map((p) => p.userId), ["u_head"], "4.9 a role document lists only that role");
  eq(roleOnly.outstanding, 1, "4.10 and counts only them");

  const nobody = documentStatus([], STAFF, [], 1);
  eq(nobody.people, [], "4.11 an unassigned document lists nobody");
  eq(nobody.outstanding, 0, "4.12 and nothing is outstanding");
}

// ── 5. Signing ──────────────────────────────────────────────────────────────
console.log("\n[5] signing");
{
  eq(validateSignature({ signerName: "Dana Head" }, "Dana Head"), [], "5.1 a typed name is a valid signature");
  ok(validateSignature({ signerName: "" }, "Dana Head").length > 0, "5.2 an empty one is not");
  ok(validateSignature({ signerName: "  " }, "Dana Head").length > 0, "5.3 nor whitespace");
  ok(validateSignature({ signerName: "D" }, "Dana Head").length > 0, "5.4 nor a single initial");
  ok(validateSignature({ signerName: "x".repeat(201) }, null).length > 0, "5.5 and an absurd one is capped");

  // A nickname is NOT refused. People sign "Dan" when the record says
  // "Daniel", and blocking a genuine signature over that helps nobody.
  eq(validateSignature({ signerName: "Dan" }, "Daniel Head"), [], "5.6 a nickname is accepted — it is still their signature");

  eq(
    validateSignature({ signerName: "Dana Head", signatureDataUrl: "data:image/png;base64,iVBORw0KGgo=" }, null),
    [],
    "5.7 a drawn PNG signature is accepted",
  );
  ok(
    validateSignature({ signerName: "Dana Head", signatureDataUrl: "javascript:alert(1)" }, null).length > 0,
    "5.8 anything that isn't a PNG data URL is refused",
  );
  ok(
    validateSignature({ signerName: "Dana Head", signatureDataUrl: "data:image/svg+xml;base64,PHN2Zz4=" }, null).length > 0,
    "5.9 including an SVG, which can carry script",
  );

  // What one person owes, soonest first.
  const docs = [
    { id: "d1", title: "Handbook", version: 2, assignments: [A({ scope: "ALL", dueDate: "2026-12-01" })] },
    { id: "d2", title: "Non-compete", version: 1, assignments: [A({ scope: "ROLE", role: "Head Coach", dueDate: "2026-11-01" })] },
    { id: "d3", title: "Signed already", version: 1, assignments: [A({ scope: "ALL" })] },
    { id: "d4", title: "Not mine", version: 1, assignments: [A({ scope: "ROLE", role: "Front Desk" })] },
  ];
  const sigs = { d1: [sig("u_head", 1)], d3: [sig("u_head", 1)] };
  const mine = outstandingFor(docs, STAFF, sigs, "u_head");
  eq(mine.map((m) => m.id), ["d2", "d1"], "5.10 outstanding documents come soonest-due first");
  eq(mine.find((m) => m.id === "d1")?.status, "SUPERSEDED", "5.11 one signed at an old version is still owed");
  ok(!mine.some((m) => m.id === "d3"), "5.12 a signed one is not owed");
  ok(!mine.some((m) => m.id === "d4"), "5.13 and a document for another role is not mine at all");

  const undated = outstandingFor(
    [{ id: "x", title: "B", version: 1, assignments: [A({ scope: "ALL" })] },
     { id: "y", title: "A", version: 1, assignments: [A({ scope: "ALL" })] }],
    STAFF, {}, "u_head",
  );
  eq(undated.map((m) => m.title), ["A", "B"], "5.14 undated documents sort by title");
  const mixedDates = outstandingFor(
    [{ id: "x", title: "No date", version: 1, assignments: [A({ scope: "ALL" })] },
     { id: "y", title: "Dated", version: 1, assignments: [A({ scope: "ALL", dueDate: "2027-01-01" })] }],
    STAFF, {}, "u_head",
  );
  eq(mixedDates.map((m) => m.id), ["y", "x"], "5.15 a dated document comes before an undated one");
}

// ── 6. THE SEPARATION GUARD ─────────────────────────────────────────────────
// A staff handbook must never reach a member's document list. `audience`
// defaults to MEMBER, so a missed filter is invisible until the first staff
// document exists — which is exactly why this is enumerated.
console.log("\n[6] staff documents never reach members");
{
  const MEMBER_FACING = [
    "app/api/member/documents/route.ts",
    "app/api/member/documents/[id]/sign/route.ts",
    "app/api/member/signup/route.ts",
    "app/api/members/[id]/route.ts",
    "app/api/members/[id]/documents/route.ts",
    "app/api/members/migration/activate/[token]/route.ts",
    "app/api/events/[id]/documents/route.ts",
    "app/api/documents/route.ts",
    "app/api/documents/[id]/route.ts",
    "app/api/search/route.ts",
    "app/api/dashboard/summary/route.ts",
    "lib/eventDocuments.ts",
  ];
  const strip = (x: string) =>
    x
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/(^|[^:])\/\/.*$/gm, (_m, p1) => p1);

  for (const rel of MEMBER_FACING) {
    const src = strip(readFileSync(join(ROOT, rel), "utf8"));
    const queries = [...src.matchAll(/prisma\.document\.(findMany|findFirst|count)\(\{\s*where:\s*\{([\s\S]{0,200})/g)];
    ok(queries.length > 0, `6.1 ${rel} still queries documents`, "if this file stopped reading documents, remove it from the list");
    const unfiltered = queries.filter((q) => !/audience:\s*"MEMBER"/.test(q[2]));
    eq(
      unfiltered.length,
      0,
      `6.2 every document read in ${rel} filters audience: "MEMBER"`,
    );
  }

  // And the staff side filters the other way.
  const staffServer = strip(readFileSync(join(ROOT, "lib/staffDocumentsServer.ts"), "utf8"));
  const staffQueries = [...staffServer.matchAll(/prisma\.document\.(findMany|findFirst)\(\{\s*\n?\s*(?:\/\/[^\n]*\n\s*)*where:\s*\{([\s\S]{0,200})/g)];
  ok(staffQueries.length >= 3, "6.3 the staff server reads documents");
  eq(
    staffQueries.filter((q) => !/audience:\s*"STAFF"/.test(q[2])).length,
    0,
    '6.4 and every one of them filters audience: "STAFF"',
  );

  // Writes must set it, or a staff document would default to MEMBER and
  // appear in members' lists.
  ok(/audience: "STAFF"/.test(staffServer), "6.5 creating a staff document sets audience STAFF explicitly");

  // The staff signature table must not be confused with the member one.
  ok(
    !/prisma\.documentSignature\./.test(staffServer),
    "6.6 the staff server never writes the MEMBER signature table",
  );
  const memberSign = strip(readFileSync(join(ROOT, "app/api/member/documents/[id]/sign/route.ts"), "utf8"));
  ok(
    !/staffDocumentSignature/.test(memberSign),
    "6.7 and the member signing route never writes the STAFF one",
  );

  // Staff read their own documents through an endpoint with NO id parameter,
  // so "can't see other staff's" is structural.
  const mine = readFileSync(join(ROOT, "app/api/me/documents/route.ts"), "utf8");
  ok(/session\.user\.id/.test(mine), "6.8 the staff endpoint takes the user from the session");
  ok(!/params/.test(mine), "6.9 and has no id parameter to tamper with");
  ok(
    /where: \{ staffUserId \}/.test(readFileSync(join(ROOT, "lib/staffDocumentsServer.ts"), "utf8")),
    "6.10 and loads only that person's own signatures, rather than filtering later",
  );

  // The body is sanitised on the way IN, like member documents — it is
  // rendered with dangerouslySetInnerHTML.
  ok(/sanitizeRichHtml\(/.test(staffServer), "6.11 the body is sanitised before it is stored");
}

// ── 7. Reuse, not a parallel system ─────────────────────────────────────────
console.log("\n[7] what is reused");
{
  const schema = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");
  const server = readFileSync(join(ROOT, "lib/staffDocumentsServer.ts"), "utf8");

  // The DOCUMENT is the existing model.
  ok(/prisma\.document\.create\(/.test(server), "7.1 a staff document IS a Document row");
  ok(!/model StaffPolicyDocument|model StaffSignableDocument/.test(schema), "7.2 no parallel document model was created");

  // The reason the link table is new is written down where it will be read.
  ok(
    /memberId` is a REQUIRED foreign key|memberId` is a REQUIRED FK/.test(
      readFileSync(join(ROOT, "lib/staffDocuments.ts"), "utf8") + schema,
    ),
    "7.3 and the reason the LINK table is staff-specific is documented in the source",
  );

  // Member documents keep their own mechanism untouched.
  ok(
    /signatureValidForDays/.test(schema),
    "7.4 member documents keep signatureValidForDays, which staff versions do not replace",
  );
  ok(
    /required: false,\s*\n\s*requiredAt: \[\]/.test(server),
    "7.5 a staff document never gates a signup, a purchase or an event",
  );
}

console.log(`\n${fails.length ? "✗" : "✓"} staff-documents: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
