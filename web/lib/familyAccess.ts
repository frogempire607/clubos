// Family access — the single vocabulary for "who may act for this athlete".
//
// ── Why this file exists ─────────────────────────────────────────────────────
// Three tables carry family meaning and only ONE of them grants anything:
//
//   MemberGuardianUser  User ↔ Member.  THE AUTHORIZATION EDGE. A CONFIRMED row
//                       IS the right to book, pay, message, sign and see the
//                       athlete. Nothing else grants access.
//   MemberRelationship  Member ↔ Member, typed SIBLING/PARENT/CHILD/…
//                       A DESCRIPTIVE LABEL. Grants nothing, ever.
//   Guardian            Legacy family profile keyed on (clubId, email).
//                       Grants nothing; still written by CSV import.
//
// Conflating the first two is what broke the Lister family: staff created a
// MemberRelationship (the only linking control the dashboard exposed) and
// reasonably expected the child to appear in the parent's portal. It never
// could — the portal reads MemberGuardianUser.
//
// ── The status rule ──────────────────────────────────────────────────────────
// Before Phase 4 the mere EXISTENCE of a row was the grant. Now a row also
// carries status, and only CONFIRMED grants. Every read that decides access
// MUST filter on it — a PENDING link is a request, and a REVOKED link is a
// removal we kept for the audit trail. Use ACTIVE_GUARDIAN_LINK so no call site
// has to remember the string.

import type { Prisma } from "@prisma/client";

export const GUARDIAN_LINK_STATUS = {
  CONFIRMED: "CONFIRMED",
  PENDING: "PENDING",
  REVOKED: "REVOKED",
} as const;

export type GuardianLinkStatus = (typeof GUARDIAN_LINK_STATUS)[keyof typeof GUARDIAN_LINK_STATUS];

/** How a link came to exist. Recorded so an incident is reconstructable. */
export const GUARDIAN_LINK_SOURCE = {
  OWNER_VOUCHED: "OWNER_VOUCHED",
  STAFF_LINKED: "STAFF_LINKED",
  SIGNUP_SWEEP: "SIGNUP_SWEEP",
  MIGRATION_ACTIVATION: "MIGRATION_ACTIVATION",
  APPROVAL: "APPROVAL",
  CONSENT_TOKEN: "CONSENT_TOKEN",
  BACKFILL: "BACKFILL",
} as const;

/**
 * The ONLY filter that means "this link currently grants access".
 * Spread it into any `guardianOf` / `guardianLinks` where-clause.
 */
export const ACTIVE_GUARDIAN_LINK = { status: GUARDIAN_LINK_STATUS.CONFIRMED } as const;

/** Same rule, expressed for a top-level `memberGuardianUser.findMany` query. */
export function activeGuardianLinkWhere<T extends Prisma.MemberGuardianUserWhereInput>(
  where: T,
): T & { status: string } {
  return { ...where, status: GUARDIAN_LINK_STATUS.CONFIRMED };
}

// ── Payer resolution (Phase 4A) ──────────────────────────────────────────────
//
// A membership has a beneficiary (MemberSubscription.memberId — who uses it)
// and a payer (who the money comes from). Before Phase 4 only the beneficiary
// existed, so a parent buying for a child had no way to say so, and an
// accidental self-purchase could not be corrected without rewriting who paid.
//
// Precedence, most specific first:
//   1. MemberSubscription.payerUserId  — set explicitly, usually by a transfer
//   2. Member.responsiblePayerUserId   — member-wide payer set in billing admin
//   3. the member's own login          — they pay for themselves
//
// Steps 2 and 3 are exactly what every pre-Phase-4 row resolves to today, so
// adding the column changed nothing for existing data.

export type PayerSources = {
  subscriptionPayerUserId?: string | null;
  memberResponsiblePayerUserId?: string | null;
  memberUserId?: string | null;
};

export function resolvePayerUserId(s: PayerSources): string | null {
  return (
    s.subscriptionPayerUserId ||
    s.memberResponsiblePayerUserId ||
    s.memberUserId ||
    null
  );
}

/**
 * Human-readable explanation of a transfer's money consequences. This exact
 * string is stored on MembershipTransfer.acknowledgedBillingNote, so what the
 * actor confirmed is evidence rather than an assumption.
 */
export function billingUnchangedNote(args: {
  payerName: string;
  toAthleteName: string;
  isLiveStripe: boolean;
}): string {
  const who = args.payerName || "the current payer";
  if (args.isLiveStripe) {
    return (
      `${who} keeps paying for this membership. The Stripe subscription, customer and card are not changed — ` +
      `only the athlete using the membership becomes ${args.toAthleteName}. ` +
      `The original payment and receipt stay exactly as they are.`
    );
  }
  return (
    `${who} stays the payer. Only the athlete using this membership becomes ${args.toAthleteName}. ` +
    `The original payment and receipt stay exactly as they are.`
  );
}
