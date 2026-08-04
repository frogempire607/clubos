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
import { prisma } from "@/lib/prisma";
import { GUARDIAN_LINK_KIND } from "@/lib/guardianLink";

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

// ── The family read (Phase 4B) ───────────────────────────────────────────────
//
// THE CAMERON BUG, in one sentence: `GET /api/members/[id]` returned
// MemberRelationship and the legacy Guardian's other kids, but never
// `guardianLinks` (who can act for this member) or `user.guardianOf` (who this
// member's login can act for). So the dashboard showed a staff-created
// relationship — which grants nothing — and hid the actual access edges. Staff
// could not see that Cameron WAS linked, just to a duplicate account.
//
// This loader returns all four in one shape so no surface has to remember to
// ask for the third and fourth.

export type FamilyGuardian = {
  linkId: string;
  userId: string;
  name: string;
  email: string | null;
  /** From the guardian's own member row, when they have one. */
  profileImageUrl: string | null;
  relationship: string | null;
  /** CONFIRMED grants access; PENDING is a staff proposal awaiting confirmation. */
  status: string;
  isPrimary: boolean;
  canBook: boolean;
  canPay: boolean;
  canSignWaivers: boolean;
  canReceiveEmails: boolean;
  source: string | null;
  linkedAt: Date;
  /** The athlete's own member row, if this guardian is also a member here. */
  memberId: string | null;
};

export type FamilyManagedAthlete = {
  linkId: string;
  memberId: string;
  name: string;
  profileImageUrl: string | null;
  isMinor: boolean;
  /** The athlete's member status (ACTIVE/PROSPECT/…), not the link status. */
  status: string;
  /** The link's own status — CONFIRMED or PENDING. */
  linkStatus: string;
  /** A transferable subscription on this athlete, for "Assign Membership". */
  transferableSubscriptionId: string | null;
  relationship: string | null;
  isPrimary: boolean;
  canBook: boolean;
  canPay: boolean;
  canSignWaivers: boolean;
  canReceiveEmails: boolean;
  linkedAt: Date;
};

export type FamilyPendingLink = {
  approvalId: string;
  requestingUserId: string | null;
  requestingUserEmail: string | null;
  relationship: string | null;
  requestedAt: Date;
};

export type FamilyPayload = {
  guardians: FamilyGuardian[];
  managedAthletes: FamilyManagedAthlete[];
  pendingGuardianRequests: FamilyPendingLink[];
  /** True when this member has a portal login of their own. */
  hasOwnLogin: boolean;
};

export async function loadFamilyForMember(
  memberId: string,
  clubId: string,
): Promise<FamilyPayload> {
  const member = await prisma.member.findFirst({
    where: { id: memberId, clubId, deletedAt: null },
    select: {
      userId: true,
      // Who can act FOR this member.
      // NOT filtered to CONFIRMED here: the staff card must also show PENDING
      // staff proposals so someone can confirm them. REVOKED stays hidden —
      // it is history, surfaced in the member's event log, not a live row.
      // Every CONSUMER of this payload must respect `status` (see 4C actions).
      guardianLinks: {
        where: { status: { in: [GUARDIAN_LINK_STATUS.CONFIRMED, GUARDIAN_LINK_STATUS.PENDING] } },
        orderBy: [{ status: "asc" }, { isPrimary: "desc" }, { createdAt: "asc" }],
        select: {
          id: true, userId: true, relationship: true, isPrimary: true, status: true,
          canBook: true, canPay: true, canSignWaivers: true, canReceiveEmails: true,
          source: true, createdAt: true,
          user: {
            select: {
              id: true, firstName: true, lastName: true, email: true,
              memberProfile: { select: { id: true, profileImageUrl: true } },
            },
          },
        },
      },
    },
  });
  if (!member) return { guardians: [], managedAthletes: [], pendingGuardianRequests: [], hasOwnLogin: false };

  // Who this member's own login can act for (the reciprocal direction — the
  // half the dashboard never loaded).
  const managed = member.userId
    ? await prisma.memberGuardianUser.findMany({
        where: {
          status: { in: [GUARDIAN_LINK_STATUS.CONFIRMED, GUARDIAN_LINK_STATUS.PENDING] },
          userId: member.userId,
          member: { clubId, deletedAt: null },
        },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
        select: {
          id: true, relationship: true, isPrimary: true, status: true,
          canBook: true, canPay: true, canSignWaivers: true, canReceiveEmails: true,
          createdAt: true,
          member: {
            select: {
              id: true, firstName: true, lastName: true, isMinor: true, status: true,
              profileImageUrl: true,
              subscriptions: {
                where: { status: { in: ["active", "past_due", "pending"] } },
                orderBy: { createdAt: "desc" },
                take: 1,
                select: { id: true },
              },
            },
          },
        },
      })
    : [];

  // Requests waiting on staff. Without these, a guardian who asked for access
  // is invisible on the profile and the request silently rots in the queue.
  const pending = await prisma.pendingApproval.findMany({
    where: { clubId, memberId, kind: GUARDIAN_LINK_KIND, status: "PENDING" },
    orderBy: { requestedAt: "desc" },
    select: { id: true, payload: true, requestedAt: true },
  });

  return {
    hasOwnLogin: !!member.userId,
    guardians: member.guardianLinks.map((l) => ({
      linkId: l.id,
      userId: l.userId,
      name: `${l.user.firstName ?? ""} ${l.user.lastName ?? ""}`.trim() || (l.user.email ?? "Unknown"),
      email: l.user.email,
      profileImageUrl: l.user.memberProfile?.profileImageUrl ?? null,
      relationship: l.relationship,
      status: l.status,
      isPrimary: l.isPrimary,
      canBook: l.canBook,
      canPay: l.canPay,
      canSignWaivers: l.canSignWaivers,
      canReceiveEmails: l.canReceiveEmails,
      source: l.source,
      linkedAt: l.createdAt,
      memberId: l.user.memberProfile?.id ?? null,
    })),
    managedAthletes: managed.map((l) => ({
      linkId: l.id,
      memberId: l.member.id,
      name: `${l.member.firstName} ${l.member.lastName}`.trim(),
      profileImageUrl: l.member.profileImageUrl ?? null,
      isMinor: l.member.isMinor,
      status: l.member.status,
      linkStatus: l.status,
      transferableSubscriptionId: l.member.subscriptions[0]?.id ?? null,
      relationship: l.relationship,
      isPrimary: l.isPrimary,
      canBook: l.canBook,
      canPay: l.canPay,
      canSignWaivers: l.canSignWaivers,
      canReceiveEmails: l.canReceiveEmails,
      linkedAt: l.createdAt,
    })),
    pendingGuardianRequests: pending.map((p) => {
      const payload = (p.payload ?? {}) as {
        requestingUserId?: string;
        requestingUserEmail?: string;
        relationship?: string;
      };
      return {
        approvalId: p.id,
        requestingUserId: payload.requestingUserId ?? null,
        requestingUserEmail: payload.requestingUserEmail ?? null,
        relationship: payload.relationship ?? null,
        requestedAt: p.requestedAt,
      };
    }),
  };
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
