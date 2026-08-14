// Pure tests for lib/memberDeletion.ts.
//   npx tsx scripts/member-deletion-tests.ts

import {
  deletionBlocks, deletionWarnings, deletionPreserved,
  confirmationMatches, confirmationPhrase, type AttachedRecords,
} from "../lib/memberDeletion";

let pass = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}

const empty: AttachedRecords = {
  transactions: 0, succeededTransactions: 0, activeSubscriptions: 0,
  guardianLinks: 0, guardedByThisMember: 0, emailSends: 0,
  documentSignatures: 0, attendanceRecords: 0, pendingApprovals: 0,
  hasLogin: false, hasLiveStripeSubscription: false,
};
const rec = (o: Partial<AttachedRecords>): AttachedRecords => ({ ...empty, ...o });

// ── Blocks ────────────────────────────────────────────────────────────────
check("a clean member is not blocked", deletionBlocks(empty).length === 0);
check("a live Stripe subscription blocks", deletionBlocks(rec({ hasLiveStripeSubscription: true })).length === 1);
check(
  "…and says why, in money terms",
  /stripe kept charging/i.test(deletionBlocks(rec({ hasLiveStripeSubscription: true }))[0].message),
);
check(
  "an offline membership does NOT block — no money moves on its own",
  deletionBlocks(rec({ activeSubscriptions: 2 })).length === 0,
);
check("money already taken does not block", deletionBlocks(rec({ transactions: 40, succeededTransactions: 40 })).length === 0);

// ── Warnings ──────────────────────────────────────────────────────────────
{
  const w = deletionWarnings(rec({ activeSubscriptions: 1, pendingApprovals: 2, hasLogin: true }));
  check("an active membership is called out", w.some((x) => /active membership/i.test(x)));
  check("closed approvals are called out", w.some((x) => /2 pending approvals will be closed/i.test(x)));
  check("the login is called out", w.some((x) => /can no longer sign in/i.test(x)));
  check("nothing is warned about on a clean member", deletionWarnings(empty).length === 0);
}
{
  // Someone who is a guardian for other athletes: those kids keep their
  // guardian, and the person confirming needs to know that outright.
  const w = deletionWarnings(rec({ guardedByThisMember: 3 }));
  check("guardianship of others is surfaced", w.some((x) => /guardian for 3 other athletes/i.test(x)));
  check("…and reassures the others are unaffected", w.some((x) => /not affected/i.test(x)));
}

// ── Preserved ─────────────────────────────────────────────────────────────
{
  const p = deletionPreserved(rec({
    transactions: 12, documentSignatures: 3, emailSends: 40,
    attendanceRecords: 88, guardianLinks: 2,
  }));
  check("payments are stated as kept", p.some((x) => /12 payment records stay on/i.test(x)));
  check("revenue reporting is explicitly unchanged", p.some((x) => /reporting are unchanged/i.test(x)));
  check("signed documents are kept", p.some((x) => /3 signed documents/i.test(x)));
  check("email history is kept", p.some((x) => /40 emails stay in the send history/i.test(x)));
  check("attendance is kept", p.some((x) => /88 attendance records/i.test(x)));
  check("guardian links are kept", p.some((x) => /2 guardian links are kept/i.test(x)));
  check("nothing is claimed kept when nothing exists", deletionPreserved(empty).length === 0);
}
{
  // Singulars must read correctly — "1 payment records" is the kind of thing
  // that makes a confirmation dialog look untrustworthy.
  const p = deletionPreserved(rec({ transactions: 1, documentSignatures: 1, emailSends: 1 }));
  check("singular payment reads correctly", p.some((x) => /1 payment record stays on/i.test(x)));
  check("singular document reads correctly", p.some((x) => /1 signed document stays in/i.test(x)));
  check("singular email reads correctly", p.some((x) => /1 email stays in/i.test(x)));
  check("no plural verb leaks onto a singular", !p.some((x) => /\b1 [a-z ]+s? stay\b/i.test(x)));
}

// ── Typed confirmation ────────────────────────────────────────────────────
check("the phrase is the member's name", confirmationPhrase("Alex Butler") === "Alex Butler");
check("exact match confirms", confirmationMatches("Alex Butler", "Alex Butler"));
check("case is forgiven", confirmationMatches("alex butler", "Alex Butler"));
check("surrounding whitespace is forgiven", confirmationMatches("  Alex Butler  ", "Alex Butler"));
check("a different name does not confirm", !confirmationMatches("Alex Buter", "Alex Butler"));
check("empty does not confirm", !confirmationMatches("", "Alex Butler"));
check("a partial name does not confirm", !confirmationMatches("Alex", "Alex Butler"));

console.log(`\n${"─".repeat(58)}`);
if (failures.length) {
  console.log(`✗ ${failures.length} failed, ${pass} passed\n`);
  failures.forEach((f) => console.log(`   ${f}`));
  process.exit(1);
}
console.log(`✓ ${pass}/${pass} passed`);
