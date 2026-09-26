/**
 * B6 — Members list: pure tests for the new query-filter builders (tag, gender,
 * age, custom field, letter), the bulk add-tag merge, family grouping and the
 * work-queue → bulk-action map.
 *
 *   npm run test:members-list-b6
 */
import {
  AGE_BRACKETS,
  ageDobBounds,
  ageLabel,
  ageOn,
  ageWhere,
  armedBulkAction,
  customFieldMatches,
  customFieldNeedle,
  customFieldWhere,
  distinctTags,
  familyKeyFor,
  familyKeysFor,
  groupFamilies,
  letterWhere,
  mergeTag,
  normalizeLetter,
  parseAge,
  parseTags,
  type FamilyKeyInput,
} from "../lib/membersListB6";
import { MEMBER_FILTER_PARAM_KEYS, memberWhere, parseMemberFilters } from "../lib/membersQuery";

let pass = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
    return;
  }
  failures.push(detail ? `${label} — ${detail}` : label);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}
const j = (v: unknown) => JSON.stringify(v);
const parse = (qs: string) => parseMemberFilters(new URL(`http://x/dashboard/members${qs}`));

// ── Letter ──────────────────────────────────────────────────────────────────
console.log("\nA–Z letter:");
check("lowercase normalises to uppercase", normalizeLetter("m") === "M");
check("keeps only the first character", normalizeLetter("Mc") === "M");
check("empty → null", normalizeLetter("") === null && normalizeLetter(null) === null);
check("punctuation → null", normalizeLetter("-") === null);
check(
  "letterWhere is a case-insensitive lastName prefix",
  j(letterWhere("r")) === j({ lastName: { startsWith: "R", mode: "insensitive" } }),
);
check("letterWhere(null) adds nothing", letterWhere(null) === null);
check("?letter=k parses to K", parse("?letter=k").letter === "K");

// ── Age ─────────────────────────────────────────────────────────────────────
console.log("\nAge:");
const NOW = new Date(2026, 8, 25); // 2026-09-25 local
check("parseAge accepts integers", parseAge("12") === 12);
check("parseAge floors decimals", parseAge("12.7") === 12);
check("parseAge rejects junk / negatives / blanks", parseAge("x") === null && parseAge("-1") === null && parseAge("") === null);
{
  const b = ageDobBounds(8, 10, NOW)!;
  const inRange = (dob: Date) => (!b.lte || dob <= b.lte) && (!b.gt || dob > b.gt);
  check("8th birthday today is in 8–10", inRange(new Date(2018, 8, 25)));
  check("day before 8th birthday is out", !inRange(new Date(2018, 8, 26)));
  check("day before 11th birthday is in (max inclusive)", inRange(new Date(2015, 8, 26)));
  check("11th birthday today is out", !inRange(new Date(2015, 8, 25)));
  check("ageOn agrees at the upper boundary", ageOn(new Date(2015, 8, 26), NOW) === 10);
  // Every whole age 0..30 against every bracket: bound test ⇔ ageOn test.
  let agree = true;
  for (const br of AGE_BRACKETS) {
    const bb = ageDobBounds(br.min, br.max, NOW)!;
    for (let y = 0; y <= 30; y++) {
      for (const dd of [-1, 0, 1]) {
        const dob = new Date(NOW.getFullYear() - y, NOW.getMonth(), NOW.getDate() + dd);
        const a = ageOn(dob, NOW);
        const byAge = (br.min == null || a >= br.min) && (br.max == null || a <= br.max);
        const byBound = (!bb.lte || dob <= bb.lte) && (!bb.gt || dob > bb.gt);
        if (byAge !== byBound) agree = false;
      }
    }
  }
  check("bounds agree with whole-year age for every bracket (0–30y, ±1 day)", agree);
}
check("open-ended min only", j(Object.keys(ageDobBounds(18, null, NOW)!)) === j(["lte"]));
check("open-ended max only", j(Object.keys(ageDobBounds(null, 7, NOW)!)) === j(["gt"]));
check("no bounds → null", ageDobBounds(null, null, NOW) === null && ageWhere(null, null, NOW) === null);
check(
  "ageWhere excludes unknown DOB",
  (ageWhere(8, 10, NOW) as { dateOfBirth: { not: null } }).dateOfBirth.not === null,
);
check("ageLabel names a bracket", ageLabel(8, 10) === "Age 8–10" && ageLabel(18, null) === "Age 18+");
check("ageLabel for a custom range", ageLabel(5, 9) === "Age 5–9" && ageLabel(null, 4) === "Age ≤ 4");
check("?ageMin=8&ageMax=10 parses", (() => { const f = parse("?ageMin=8&ageMax=10"); return f.ageMin === 8 && f.ageMax === 10; })());

// ── Custom field ────────────────────────────────────────────────────────────
console.log("\nCustom field:");
const blob = JSON.stringify({ cf1: "Varsity", cf2: "", cf3: 'He said "hi"' });
check("needle with value", customFieldNeedle("cf1", "Var") === '"cf1":"Var');
check("needle escapes quotes", customFieldNeedle("cf3", 'He said "') === '"cf3":"He said \\"');
check("value needle is a substring of the stored blob", blob.includes(customFieldNeedle("cf1", "Varsity")));
check("escaped needle is a substring of the stored blob", blob.includes(customFieldNeedle("cf3", 'He said "hi')));
check("customFieldMatches prefix, case-insensitive", customFieldMatches(blob, "cf1", "var"));
check("customFieldMatches rejects other value", !customFieldMatches(blob, "cf1", "JV"));
check("no value = any non-empty answer", customFieldMatches(blob, "cf1", null) && !customFieldMatches(blob, "cf2", null));
check("missing field never matches", !customFieldMatches(blob, "cf9", null));
check("bad JSON never matches", !customFieldMatches("{oops", "cf1", null));
check(
  "customFieldWhere with value is one insensitive contains",
  j(customFieldWhere("cf1", "Var")) === j({ customFieldValues: { contains: '"cf1":"Var', mode: "insensitive" } }),
);
{
  const w = customFieldWhere("cf2", null) as { AND: unknown[] };
  check("customFieldWhere without value: present AND not empty", Array.isArray(w.AND) && w.AND.length === 2);
  // Simulate the SQL against the blob
  const present = blob.includes(customFieldNeedle("cf2", null));
  const empty = blob.includes(`${customFieldNeedle("cf2", null)}"`);
  check("…and that pair excludes an empty answer", present && empty);
}
check("no field id → null", customFieldWhere(null, "x") === null);
check("?cf=abc&cfv=Yes parses", (() => { const f = parse("?cf=abc&cfv=Yes"); return f.customFieldId === "abc" && f.customFieldValue === "Yes"; })());

// ── memberWhere integration (tag / gender / age / cf / letter) ──────────────
console.log("\nmemberWhere:");
{
  const f = parse("?tag=Travel&gender=female&ageMin=8&ageMax=10&cf=cf1&cfv=Var&letter=r");
  const w = memberWhere("club1", f) as { clubId: string; AND: Record<string, unknown>[] };
  const keys = w.AND.map((c) => Object.keys(c)[0]);
  check("club + soft-delete scope kept", w.clubId === "club1");
  check("tag clause present", keys.includes("tags"));
  check("gender clause is case-insensitive", j(w.AND.find((c) => "gender" in c)) === j({ gender: { equals: "female", mode: "insensitive" } }));
  check("age clause present", keys.includes("dateOfBirth"));
  check("custom field clause present", keys.includes("customFieldValues"));
  check("letter clause present", keys.includes("lastName"));
  check("five clauses, nothing extra", w.AND.length === 5, j(keys));
  const bare = memberWhere("club1", parse("")) as { AND?: unknown[] };
  check("no params → no AND", !bare.AND);
}
check(
  "new keys are declared in MEMBER_FILTER_PARAM_KEYS",
  ["ageMin", "ageMax", "cf", "cfv", "letter"].every((k) => (MEMBER_FILTER_PARAM_KEYS as readonly string[]).includes(k)),
);

// ── Tags / bulk add-tag merge ──────────────────────────────────────────────
console.log("\nTags + bulk add-tag merge:");
check("parseTags splits and trims", j(parseTags(" Beginner, 14U ,, Travel team ")) === j(["Beginner", "14U", "Travel team"]));
check("parseTags of empty", j(parseTags("")) === j([]) && j(parseTags(null)) === j([]));
check("append to empty", j(mergeTag("", "Travel")) === j({ tags: "Travel", changed: true }));
check("append keeps order and spelling", mergeTag("Beginner, 14U", "Travel").tags === "Beginner, 14U, Travel");
check("duplicate (case-insensitive) is not changed", j(mergeTag("Beginner, travel", "Travel")) === j({ tags: "Beginner, travel", changed: false }));
check("duplicate leaves odd spacing untouched", mergeTag("A,B", "b").tags === "A,B");
check("blank tag is a no-op", mergeTag("A", "   ").changed === false);
check("commas in a new tag cannot split it", mergeTag("A", "x,y").tags === "A, x y");
check("idempotent: merging twice changes once", (() => {
  const a = mergeTag("A", "B");
  const b = mergeTag(a.tags, "B");
  return a.changed && !b.changed && b.tags === "A, B";
})());
check("distinctTags de-dupes case-insensitively and sorts", j(distinctTags([{ tags: "b, A" }, { tags: "a, C" }, { tags: "" }])) === j(["A", "b", "C"]));

// ── Family grouping ────────────────────────────────────────────────────────
console.log("\nFamily grouping:");
const blank: FamilyKeyInput = { email: null, guardianEmail: null, userId: null, guardianLinks: [], user: null, subscriptions: [] };
check("stands alone → null", familyKeyFor(blank) === null);
check("guardian login wins", familyKeyFor({ ...blank, user: { id: "U1", guardianOf: [{ memberId: "k" }] } }) === "u:U1");
check("confirmed guardian link", familyKeyFor({ ...blank, guardianLinks: [{ userId: "U2" }, { userId: "U1" }] }) === "u:U1");
check("deleted guardian user ignored", familyKeyFor({ ...blank, guardianLinks: [{ userId: "U1", user: { deletedAt: new Date() } }] }) === null);
check("payer of a live subscription", familyKeyFor({ ...blank, subscriptions: [{ payerUserId: "P", status: "active" }] }) === "u:P");
check("self-payer is not a family", familyKeyFor({ ...blank, userId: "P", subscriptions: [{ payerUserId: "P", status: "active" }] }) === null);
check("canceled payer ignored", familyKeyFor({ ...blank, subscriptions: [{ payerUserId: "P", status: "canceled" }] }) === null);
check("legacy guardianEmail, lowercased", familyKeyFor({ ...blank, guardianEmail: " Mom@X.com " }) === "e:mom@x.com");
{
  const keys = familyKeysFor([
    { ...blank, id: "mom", email: "mom@x.com" },
    { ...blank, id: "kid", guardianEmail: "MOM@x.com" },
    { ...blank, id: "solo", email: "solo@x.com" },
  ]);
  check("parent row joins the household that names her email", keys.get("mom") === "e:mom@x.com" && keys.get("kid") === "e:mom@x.com");
  check("unrelated row stays alone", keys.get("solo") === null);
}
{
  const r = (id: string, familyKey: string | null, roles: string[] = ["ATHLETE"]) => ({
    id,
    familyKey,
    tracks: { role: roles.map((role) => ({ role })) },
  });
  const rows = [r("k1", "u:A"), r("x", null), r("mom", "u:A", ["ACCOUNT_HOLDER"]), r("k2", "u:A"), r("lone", "u:B")];
  const g = groupFamilies(rows);
  check("3-person family collapses to one group", g.length === 3, j(g.map((x) => x.head.id)));
  check("group sits where its first member was", g[0].key === "u:A" && g[1].head.id === "x");
  check("account holder is the head", g[0].head.id === "mom");
  check("others keep page order", j(g[0].others.map((o) => o.id)) === j(["k1", "k2"]));
  check("a family of one on this page is not a group", g[2].key === null && g[2].others.length === 0);
  check("every row appears exactly once", g.reduce((n, x) => n + 1 + x.others.length, 0) === rows.length);
}

// ── Work-queue → bulk action ───────────────────────────────────────────────
console.log("\nWork-queue arms bulk action:");
check("Never invited → Send invitations", armedBulkAction("neverInvited") === "invite");
check("Invited (setup filter) → Resend", armedBulkAction(null, "INVITED") === "resend");
check("Not invited (setup filter) → Send invitations", armedBulkAction(null, "NOT_INVITED") === "invite");
check("Renewing this week → Email", armedBulkAction("renewingSoon") === "email");
check("Paused → Message", armedBulkAction("paused") === "message");
check("Blocked only filters", armedBulkAction("blocked") === null);
check("Missing contact only filters", armedBulkAction("missingContact") === null);
check("queue wins over setup state", armedBulkAction("neverInvited", "INVITED") === "invite");
check("nothing active → nothing armed", armedBulkAction(null, null) === null);

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
