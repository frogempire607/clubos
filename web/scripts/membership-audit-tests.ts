/**
 * What a plan edit records. npx tsx scripts/membership-audit-tests.ts
 *
 * The line this produces is the ONLY trace a plan edit leaves, so a wrong or
 * missing line is the same as no audit at all.
 */
import { diffMembership, describeChanges } from "../lib/membershipAudit";
import { makeOption, type Entitlement, type MembershipOption } from "../lib/membershipOptions";

let pass = 0; const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); return; }
  failures.push(detail ? `${label} — ${detail}` : label);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}
const opt = (over: Partial<MembershipOption> & { id: string; label: string; price: number }) =>
  makeOption({ billingPeriod: "MONTHLY", ...over }) as MembershipOption;

const base = {
  scalars: { name: "MS/HS", active: true, contractMonths: null, autoRenewDefault: true },
  options: [
    opt({ id: "a", label: "Monthly Full Membership", price: 175 }),
    opt({ id: "b", label: "Monthly 2 days (Tue/Thu)", price: 110 }),
  ],
};

// The change that started this: a narrowing that reaches people who have paid.
{
  const after = {
    scalars: base.scalars,
    options: [base.options[0], { ...base.options[1], entitlement: { kind: "DAYS", days: [2, 4] } as Entitlement }],
  };
  const d = diffMembership(base, after);
  check("a day restriction is recorded", d.length === 1 && d[0].field === "days included", JSON.stringify(d));
  check("it says what it went from and to",
    d[0]?.from === "all days" && d[0]?.to === "Tue & Thu", JSON.stringify(d[0]));
  check("it is FLAGGED as reaching existing members", d[0]?.affectsExistingMembers === true);
  check("the note reads like a sentence",
    /"Monthly 2 days \(Tue\/Thu\)" days included: all days → Tue & Thu {2}\[affects existing members\]/.test(describeChanges(d)),
    describeChanges(d));
}

// A rename must not read as delete-plus-add. This is what option ids are for.
{
  const after = { scalars: base.scalars, options: [base.options[0], { ...base.options[1], label: "Tue/Thu only" }] };
  const d = diffMembership(base, after);
  check("a rename is ONE line, not a removal and an addition",
    d.length === 1 && d[0].field === "label", JSON.stringify(d));
  check("a rename is not flagged as reaching members — identity is the id",
    d[0]?.affectsExistingMembers === false);
}

// Reordering is not a change.
{
  const after = { scalars: base.scalars, options: [base.options[1], base.options[0]] };
  check("reordering options records nothing", diffMembership(base, after).length === 0);
}

// A field the caller never sent must not be reported as cleared.
{
  const after = { scalars: { name: "MS/HS Renamed" }, options: base.options };
  const d = diffMembership(base, after);
  check("untouched scalars are silent, not reported as set to nothing",
    d.length === 1 && d[0].field === "name", JSON.stringify(d));
}

// Plan-level term is inherited, so it reaches members.
{
  const after = { scalars: { ...base.scalars, contractMonths: 3 }, options: base.options };
  const d = diffMembership(base, after);
  check("a plan-level minimum term is flagged as reaching members",
    d[0]?.field === "contractMonths" && d[0]?.affectsExistingMembers === true, JSON.stringify(d));
}

// Removing an option strands anyone still resolving through it.
{
  const after = { scalars: base.scalars, options: [base.options[0]] };
  const d = diffMembership(base, after);
  check("a removed option is recorded and flagged",
    d.length === 1 && d[0].to === "removed" && d[0].affectsExistingMembers === true, JSON.stringify(d));
}

// Adding one affects nobody — no one is on it yet.
{
  const after = { scalars: base.scalars, options: [...base.options, opt({ id: "c", label: "3 Months", price: 160 })] };
  const d = diffMembership(base, after);
  check("an added option is recorded but not flagged",
    d.length === 1 && d[0].affectsExistingMembers === false, JSON.stringify(d));
}

// A price change is for NEW buyers; existing rows carry their own price.
{
  const after = { scalars: base.scalars, options: [{ ...base.options[0], price: 190 }, base.options[1]] };
  const d = diffMembership(base, after);
  check("a price change is not flagged — existing subscriptions keep their own price",
    d[0]?.field === "price" && d[0]?.affectsExistingMembers === false, JSON.stringify(d));
}

// No change at all must produce no row, or the log fills with noise.
check("an identical save records nothing", diffMembership(base, base).length === 0);
check("and says so if asked", describeChanges([]) === "No effective change.");

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.error("\nFailures:"); for (const f of failures) console.error(`  - ${f}`); process.exit(1); }
