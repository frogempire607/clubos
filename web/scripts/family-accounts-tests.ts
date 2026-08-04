// Phase 4 pure-function tests — no DB, no Stripe.
//
//   npx tsx scripts/family-accounts-tests.ts
//
// Covers the decisions that are easy to regress silently: payer precedence
// (the thing that makes "the payer stays Michael" true), the CONFIRMED-only
// access filter, and the billing sub-scope default being OFF.

import {
  ACTIVE_GUARDIAN_LINK,
  GUARDIAN_LINK_STATUS,
  activeGuardianLinkWhere,
  billingUnchangedNote,
  resolvePayerUserId,
} from "@/lib/familyAccess";
import {
  DEFAULT_BILLING_SUBSCOPES,
  hasBillingSubScope,
  resolveBillingSubScopes,
} from "@/lib/permissions";
import { TRANSFERABLE_STATUSES } from "@/lib/membershipTransfer";

let pass = 0;
const failures: string[] = [];

function check(name: string, cond: boolean) {
  if (cond) pass++;
  else failures.push(name);
}
function eq<T>(name: string, actual: T, expected: T) {
  check(`${name} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`, actual === expected);
}

// ── Payer precedence ────────────────────────────────────────────────────────
// The whole point of MemberSubscription.payerUserId: after a transfer moves
// memberId to the child, the payer must NOT be re-derived from the child.

eq(
  "payer: explicit subscription payer wins over everything",
  resolvePayerUserId({
    subscriptionPayerUserId: "u_parent",
    memberResponsiblePayerUserId: "u_other",
    memberUserId: "u_child",
  }),
  "u_parent",
);
eq(
  "payer: falls back to the member-wide responsible payer",
  resolvePayerUserId({
    subscriptionPayerUserId: null,
    memberResponsiblePayerUserId: "u_other",
    memberUserId: "u_child",
  }),
  "u_other",
);
eq(
  "payer: finally falls back to the member's own login",
  resolvePayerUserId({
    subscriptionPayerUserId: null,
    memberResponsiblePayerUserId: null,
    memberUserId: "u_child",
  }),
  "u_child",
);
eq(
  "payer: null when nothing resolves (never throws)",
  resolvePayerUserId({}),
  null,
);
// Regression guard for the exact pre-Phase-4 behavior: a row with no
// payerUserId must resolve identically to how it did before the column existed.
eq(
  "payer: pre-Phase-4 rows are unchanged by the new column",
  resolvePayerUserId({ memberResponsiblePayerUserId: null, memberUserId: "u_self" }),
  "u_self",
);

// ── Access filter ───────────────────────────────────────────────────────────
// A PENDING or REVOKED link must never read as access.

eq("access: the filter is CONFIRMED-only", ACTIVE_GUARDIAN_LINK.status, GUARDIAN_LINK_STATUS.CONFIRMED);
check(
  "access: activeGuardianLinkWhere preserves the caller's clauses",
  (() => {
    const w = activeGuardianLinkWhere({ userId: "u1", memberId: "m1" });
    return w.userId === "u1" && w.memberId === "m1" && w.status === "CONFIRMED";
  })(),
);
check(
  "access: activeGuardianLinkWhere overrides a caller-supplied status",
  activeGuardianLinkWhere({ status: "REVOKED" } as { status: string }).status === "CONFIRMED",
);

// ── Transferable statuses ───────────────────────────────────────────────────
check("transfer: active is transferable", TRANSFERABLE_STATUSES.includes("active"));
check("transfer: past_due is transferable (still a live membership)", TRANSFERABLE_STATUSES.includes("past_due"));
check("transfer: pending is transferable (purchase in flight)", TRANSFERABLE_STATUSES.includes("pending"));
check(
  "transfer: canceled is NOT transferable",
  !(TRANSFERABLE_STATUSES as readonly string[]).includes("canceled"),
);
check(
  "transfer: expired is NOT transferable",
  !(TRANSFERABLE_STATUSES as readonly string[]).includes("expired"),
);

// ── Billing note ────────────────────────────────────────────────────────────
// This string is stored as the acknowledgement, so it must always name the
// payer and always state that Stripe is untouched when Stripe is involved.

const liveNote = billingUnchangedNote({
  payerName: "Michael Lister",
  toAthleteName: "Kellen Lister",
  isLiveStripe: true,
});
check("note: live Stripe note names the payer", liveNote.includes("Michael Lister"));
check("note: live Stripe note names the new athlete", liveNote.includes("Kellen Lister"));
check("note: live Stripe note says the card is not changed", /not changed/i.test(liveNote));
check("note: live Stripe note promises the receipt survives", /receipt/i.test(liveNote));

const offlineNote = billingUnchangedNote({
  payerName: "Michael Lister",
  toAthleteName: "Kellen Lister",
  isLiveStripe: false,
});
check("note: offline note still names the payer", offlineNote.includes("Michael Lister"));
check("note: offline note does NOT claim a Stripe subscription exists", !/Stripe/i.test(offlineNote));

check(
  "note: falls back to a readable phrase when the payer has no name",
  billingUnchangedNote({ payerName: "", toAthleteName: "Kellen", isLiveStripe: false })
    .startsWith("the current payer"),
);

// ── Billing sub-scope ───────────────────────────────────────────────────────
// Off by default is the security-relevant part — a staff member with
// billing:full must NOT inherit the ability to move memberships.

eq("subscope: transfer_subscription defaults OFF", DEFAULT_BILLING_SUBSCOPES.transfer_subscription, false);
eq("subscope: unset permissions resolve to the default", hasBillingSubScope(null, "transfer_subscription"), false);
eq("subscope: an empty blob resolves to the default", hasBillingSubScope({}, "transfer_subscription"), false);
eq(
  "subscope: billing:full alone does NOT grant transfer",
  hasBillingSubScope({ billing: "full" }, "transfer_subscription"),
  false,
);
eq(
  "subscope: explicit true grants it",
  hasBillingSubScope({ billing_subScopes: { transfer_subscription: true } }, "transfer_subscription"),
  true,
);
eq(
  "subscope: explicit false denies it",
  hasBillingSubScope({ billing_subScopes: { transfer_subscription: false } }, "transfer_subscription"),
  false,
);
eq(
  "subscope: a non-boolean value falls back to the default rather than coercing",
  hasBillingSubScope({ billing_subScopes: { transfer_subscription: "yes" } }, "transfer_subscription"),
  false,
);
check(
  "subscope: resolve returns every scope as a boolean",
  Object.values(resolveBillingSubScopes(null)).every((v) => typeof v === "boolean"),
);

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`\n${pass}/${pass + failures.length} passed`);
if (failures.length) {
  console.error("\nFAILED:");
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  process.exit(1);
}
console.log("All Phase 4 pure-function tests passed.\n");
