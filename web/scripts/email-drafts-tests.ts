// Pure tests for lib/emailDrafts.ts.
//   npx tsx scripts/email-drafts-tests.ts

import {
  pickedAudience,
  readPickedAudience,
  draftTitle,
  draftIsEditable,
  notEditableReason,
} from "../lib/emailDrafts";

let pass = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ── The stored shape ──────────────────────────────────────────────────────
{
  const a = pickedAudience(["m3", "m1", "m2"]);
  check("a picked audience carries no rules", same(a.rules, []));
  check("ids are sorted and de-duplicated", same(pickedAudience(["b", "a", "b"]).alwaysIncludeMemberIds, ["a", "b"]));
  check(
    "re-saving an unchanged selection produces an identical filter",
    JSON.stringify(pickedAudience(["m2", "m1"])) === JSON.stringify(pickedAudience(["m1", "m2"])),
  );
  check("match is ALL", a.match === "ALL");
}

// ── Reading it back ───────────────────────────────────────────────────────
{
  check("round-trips", same(readPickedAudience(pickedAudience(["x", "y"])), ["x", "y"]));
  check("null filter is not a picked list", readPickedAudience(null) === null);
  check("a string is not a picked list", readPickedAudience("nope") === null);
  check("an empty selection is not a picked list", readPickedAudience({ rules: [], alwaysIncludeMemberIds: [] }) === null);
  check("a missing id array is not a picked list", readPickedAudience({ rules: [] }) === null);

  // The important one: a RULE-driven audience must never be flattened into a
  // member list. Doing so would silently turn "everyone active" into whatever
  // the rule happened to match on the day it was read.
  check(
    "a rule-driven audience is refused, not flattened",
    readPickedAudience({
      rules: [{ field: "membershipStatus", op: "eq", value: "ACTIVE" }],
      alwaysIncludeMemberIds: ["m1"],
    }) === null,
  );
  check(
    "non-string ids are dropped",
    same(readPickedAudience({ rules: [], alwaysIncludeMemberIds: ["a", 7, null, "b"] }), ["a", "b"]),
  );
}

// ── Titles ────────────────────────────────────────────────────────────────
{
  check("a subject is the title", draftTitle("Practice canceled") === "Practice canceled");
  check("an empty subject still gets a findable name", draftTitle("") === "Untitled draft");
  check("whitespace is not a subject", draftTitle("   ") === "Untitled draft");
  check("null is handled", draftTitle(null) === "Untitled draft");
}

// ── What may be edited ────────────────────────────────────────────────────
{
  check("a DRAFT is editable", draftIsEditable("DRAFT") === true);
  for (const s of ["SCHEDULED", "QUEUED", "SENDING", "SENT", "CANCELED"]) {
    check(`${s} is not editable`, draftIsEditable(s) === false);
  }
  check("a scheduled send explains how to change it", /cancel it first/i.test(notEditableReason("SCHEDULED")));
  check("a sent one points at duplicating", /duplicate/i.test(notEditableReason("SENT")));
  check("an in-flight send says so", /right now/i.test(notEditableReason("SENDING")));
  check("an unknown status still gets a sentence", notEditableReason("WAT").length > 0);
}

console.log(`\n${"─".repeat(58)}`);
if (failures.length) {
  console.log(`✗ ${failures.length} failed, ${pass} passed\n`);
  failures.forEach((f) => console.log(`   ${f}`));
  process.exit(1);
}
console.log(`✓ ${pass}/${pass} passed`);
