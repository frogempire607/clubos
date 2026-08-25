// What changed on a membership plan, in words, for the audit log.
//
// PURE — no prisma, no session. The caller loads before/after and writes the row.
//
// ── Why this exists ─────────────────────────────────────────────────────────
//
// Every billing mutation writes a BillingAuditLog row. Editing a PLAN did not,
// and a plan edit changes what every member on it is entitled to. On 2026-08-25
// the "Monthly 2 days (Tue/Thu)" option acquired a DAYS[2,4] entitlement in
// production — which immediately stopped a paying member being covered on
// Mondays and Sundays — and the only trace anywhere was `memberships.updatedAt`
// moving. Not who, not what, not from what to what.
//
// A diff of the whole options JSON would be technically complete and useless to
// read. This produces one line per real change, in the vocabulary the owner used
// when they made it.

import {
  describeDays,
  type Entitlement,
  type MembershipOption,
} from "@/lib/membershipOptions";

export type PlanScalars = {
  name?: string | null;
  active?: boolean | null;
  contractMonths?: number | null;
  autoRenewDefault?: boolean | null;
  trialEnabled?: boolean | null;
  trialDays?: number | null;
  purchaseAccess?: string | null;
};

export type MembershipChange = {
  /** "plan" for a plan-level field, otherwise the option's label. */
  scope: string;
  field: string;
  from: string;
  to: string;
  /** True when this change alters what an EXISTING member may attend or owes. */
  affectsExistingMembers: boolean;
};

const entitlementText = (e: Entitlement): string =>
  e.kind === "ALL" ? "all days" : e.kind === "DAYS" ? describeDays(e.days) : `${e.perWeek}/week`;

const show = (v: unknown): string =>
  v === null || v === undefined ? "—" : typeof v === "boolean" ? (v ? "on" : "off") : String(v);

/**
 * Compare two versions of a plan.
 *
 * Options are matched by `id`, never by label or position: a rename is a
 * one-line change, not a delete plus an add, and reordering is not a change at
 * all. That is the whole reason option ids exist.
 */
export function diffMembership(
  before: { scalars: PlanScalars; options: MembershipOption[] },
  after: { scalars: PlanScalars; options: MembershipOption[] },
): MembershipChange[] {
  const out: MembershipChange[] = [];

  const scalarFields: (keyof PlanScalars)[] = [
    "name", "active", "contractMonths", "autoRenewDefault",
    "trialEnabled", "trialDays", "purchaseAccess",
  ];
  for (const f of scalarFields) {
    // `undefined` on the AFTER side means the caller did not touch the field —
    // Prisma ignores it, so reporting it as "set to nothing" would be a lie.
    if (after.scalars[f] === undefined) continue;
    if (before.scalars[f] === after.scalars[f]) continue;
    out.push({
      scope: "plan", field: f,
      from: show(before.scalars[f]), to: show(after.scalars[f]),
      // A plan-level term or auto-renew default is inherited by any option that
      // does not state its own, so it reaches existing members.
      affectsExistingMembers: f === "contractMonths" || f === "autoRenewDefault" || f === "active",
    });
  }

  const beforeById = new Map(before.options.filter((o) => o.id).map((o) => [o.id!, o]));
  const afterById = new Map(after.options.filter((o) => o.id).map((o) => [o.id!, o]));

  for (const [id, a] of afterById) {
    const b = beforeById.get(id);
    if (!b) {
      out.push({
        scope: a.label, field: "option", from: "—",
        to: `added ($${a.price} ${a.billingPeriod})`,
        affectsExistingMembers: false,   // nobody is on it yet
      });
      continue;
    }
    if (b.label !== a.label) {
      out.push({ scope: b.label, field: "label", from: b.label, to: a.label,
        // A rename is display only: identity is the id, and existing rows keep
        // their own optionLabel snapshot.
        affectsExistingMembers: false });
    }
    if (b.price !== a.price) {
      out.push({ scope: a.label, field: "price", from: `$${b.price}`, to: `$${a.price}`,
        // Changes the sticker for NEW purchases. Existing subscriptions carry
        // their own price and are only moved by the bulk price tool.
        affectsExistingMembers: false });
    }
    if (b.billingPeriod !== a.billingPeriod) {
      out.push({ scope: a.label, field: "billing period", from: b.billingPeriod, to: a.billingPeriod,
        affectsExistingMembers: false });
    }
    if (b.contractMonths !== a.contractMonths) {
      out.push({ scope: a.label, field: "minimum term",
        from: b.contractMonths == null ? "inherits plan" : `${b.contractMonths} months`,
        to: a.contractMonths == null ? "inherits plan" : `${a.contractMonths} months`,
        affectsExistingMembers: false });
    }
    if (b.autoRenewDefault !== a.autoRenewDefault) {
      out.push({ scope: a.label, field: "auto-renew default",
        from: show(b.autoRenewDefault), to: show(a.autoRenewDefault),
        affectsExistingMembers: false });
    }
    const eb = entitlementText(b.entitlement), ea = entitlementText(a.entitlement);
    if (eb !== ea) {
      out.push({ scope: a.label, field: "days included", from: eb, to: ea,
        // THE one that reaches people who have already paid. Enforcement is
        // live, so a narrowing takes effect the instant it is saved.
        affectsExistingMembers: true });
    }
  }

  for (const [id, b] of beforeById) {
    if (!afterById.has(id)) {
      out.push({ scope: b.label, field: "option", from: `$${b.price} ${b.billingPeriod}`, to: "removed",
        // Anyone still on it keeps their subscription, but the option can no
        // longer be resolved for coverage or repricing.
        affectsExistingMembers: true });
    }
  }

  return out;
}

/** One human line per change, for the audit note. */
export function describeChanges(changes: MembershipChange[]): string {
  if (changes.length === 0) return "No effective change.";
  return changes
    .map((c) => `${c.scope === "plan" ? "Plan" : `"${c.scope}"`} ${c.field}: ${c.from} → ${c.to}` +
      (c.affectsExistingMembers ? "  [affects existing members]" : ""))
    .join("; ");
}
