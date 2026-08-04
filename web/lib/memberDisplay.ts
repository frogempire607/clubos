// Phase 4.5.1 — the server-side serializer that turns a Member row into the
// three tracks + the one next action.
//
// ── The split ────────────────────────────────────────────────────────────────
// lib/memberTracks.ts   PURE. The rules. No Prisma, no I/O, fully unit-tested.
// lib/memberDisplay.ts  THIS FILE. Knows the Prisma shape, gathers the signals
//                       the rules need, and calls into memberTracks.
//
// Same discipline as lib/familyRules.ts (pure) ↔ lib/familyAccess.ts (DB).
//
// ── Why derivation is server-side ────────────────────────────────────────────
// The handoff is explicit: "Keep the derivation server-side (in /api/members) so
// two staff never see different counts." Today `displayStatusOf` and
// `onboardingStatusOf` live in app/dashboard/members/page.tsx — in the browser,
// over whatever subset of members that page happened to load. The counts on the
// segmented control were therefore counts of the current page, and the mobile
// card and the row could disagree.
//
// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║ BLOCKED ON MIGRATION 20260804000000_members_experience                     ║
// ║                                                                           ║
// ║ MEMBER_TRACK_SELECT references four columns that do not exist in the      ║
// ║ database yet: reviewedAt, reviewedByUserId, blockedReason, snoozedUntil.  ║
// ║ Handing this select to Prisma before the migration is applied makes the   ║
// ║ query throw, which would take /api/members down.                          ║
// ║                                                                           ║
// ║ So this module is COMPLETE AND TYPE-CHECKED BUT NOT YET WIRED into any    ║
// ║ route. After Julian applies the migration, swap the select in             ║
// ║ /api/members and /api/members/[id] to MEMBER_TRACK_SELECT and call        ║
// ║ serializeMemberForList. See PROGRESS.md "Blocked on migration".           ║
// ║                                                                           ║
// ║ serializeMemberForList itself is safe to call today — it reads the new    ║
// ║ fields as optional and every one of them degrades honestly when absent.   ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

import { Prisma } from "@prisma/client";
import {
  membershipDetailFor,
  membershipTrackFor,
  migrationMeterFor,
  nextAction,
  resolveSourceLabel,
  rolesFor,
  setupLabelFor,
  setupTrackFor,
  type MemberTrackInput,
  type MigrationMeter,
  type NextAction,
  type RoleChip,
} from "@/lib/memberTracks";
import { GUARDIAN_LINK_STATUS } from "@/lib/familyAccess";

/**
 * Everything the tracks need, and nothing else. Kept as a Prisma.validator so a
 * schema change that removes a field fails the build here rather than at
 * runtime — the pattern CLAUDE.md prescribes after the readonly-tuple incident.
 */
export const MEMBER_TRACK_SELECT = Prisma.validator<Prisma.MemberSelect>()({
  id: true,
  clubId: true,
  firstName: true,
  lastName: true,
  status: true,
  isMinor: true,
  dateOfBirth: true,
  email: true,
  phone: true,
  guardianEmail: true,
  guardianName: true,
  userId: true,
  profileImageUrl: true,
  joinedAt: true,
  tags: true,

  trialEndsAt: true,

  // Migration / import
  migrationStatus: true,
  importedAt: true,
  importBatchId: true,
  legacySource: true,
  legacyMemberId: true,
  legacyMembershipName: true,
  legacyMembershipPrice: true,
  activationEmailSentAt: true,
  activationEmailSendCount: true,
  activatedAt: true,
  migrationCompletedAt: true,
  approvalStatus: true,
  paymentSetupStatus: true,

  // ── Phase 4.5.1 columns — REQUIRE THE MIGRATION ────────────────────────
  reviewedAt: true,
  reviewedByUserId: true,
  blockedReason: true,
  snoozedUntil: true,

  subscriptions: {
    select: {
      id: true,
      status: true,
      optionLabel: true,
      price: true,
      billingPeriod: true,
      currentPeriodEnd: true,
      canceledAt: true,
      endDate: true,
      payerUserId: true,
      membership: { select: { name: true } },
    },
  },
  // Only CONFIRMED links grant anything — a PENDING link is a request and a
  // REVOKED one is a removal kept for audit. Counting either would tell an
  // owner a child has a guardian account when they do not.
  guardianLinks: {
    where: { status: GUARDIAN_LINK_STATUS.CONFIRMED },
    select: { id: true, userId: true, user: { select: { id: true, deletedAt: true } } },
  },
  user: {
    select: {
      id: true,
      role: true,
      lastLoginAt: true,
      guardianOf: {
        where: { status: GUARDIAN_LINK_STATUS.CONFIRMED },
        select: { memberId: true },
      },
    },
  },
  // NOTE: there is deliberately no `importBatch: {...}` include here.
  // members."importBatchId" is a plain scalar with NO foreign key — that was an
  // explicit choice in 20260731030000_historical_imports, matching
  // Transaction.athleteMemberId and Member.responsiblePayerUserId, so an import
  // batch can be pruned without cascading into member rows. Prisma therefore
  // has no relation to traverse. The batch's sourceLabel is resolved through
  // MemberTrackContext.sourceLabelByBatch instead — one grouped query per page
  // rather than a join per row.
});

export type MemberTrackRow = Prisma.MemberGetPayload<{ select: typeof MEMBER_TRACK_SELECT }>;

/** Extra per-member signals the base select cannot cheaply carry. */
export type MemberTrackContext = {
  /** memberId → attendance count. Absent = treated as no attendance. */
  attendanceByMember?: Map<string, number>;
  /** memberId → outstanding balance in dollars. */
  balanceByMember?: Map<string, number>;
  /** memberId → invitation delivery rollup (blocked on migration). */
  invitationsByMember?: Map<
    string,
    { sends: number; opened: number; bounced: number; lastSentAt: Date | null; lastEmail: string | null }
  >;
  /**
   * importBatchId → ImportBatch.sourceLabel, the owner-typed "Where are you
   * importing from?". Loaded with one grouped query per page — see
   * loadSourceLabels below. Absent = the label degrades, never guesses.
   */
  sourceLabelByBatch?: Map<string, string | null>;
  now?: Date;
};

function decimalToNumber(v: Prisma.Decimal | number | null | undefined): number | null {
  if (v == null) return null;
  return typeof v === "number" ? v : Number(v);
}

/**
 * Map a Prisma row onto the pure input shape. This is the ONLY place that knows
 * both vocabularies, which is what keeps memberTracks.ts free of Prisma.
 */
export function toTrackInput(row: MemberTrackRow, ctx: MemberTrackContext = {}): MemberTrackInput {
  const inv = ctx.invitationsByMember?.get(row.id);

  // A guardian link whose user has been soft-deleted is not an account.
  const liveGuardianLinks = (row.guardianLinks ?? []).filter((l) => !l.user?.deletedAt);

  const subs = (row.subscriptions ?? []).map((s) => ({
    status: s.status,
    planName: s.membership?.name ?? null,
    optionLabel: s.optionLabel,
    price: decimalToNumber(s.price),
    billingPeriod: s.billingPeriod,
    currentPeriodEnd: s.currentPeriodEnd,
    canceledAt: s.canceledAt,
    endDate: s.endDate,
  }));

  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    status: row.status,
    isMinor: row.isMinor,
    dateOfBirth: row.dateOfBirth,
    email: row.email,
    guardianEmail: row.guardianEmail,
    guardianName: row.guardianName,
    userId: row.userId,
    hasGuardianAccount: liveGuardianLinks.length > 0,

    hasAttendance: (ctx.attendanceByMember?.get(row.id) ?? 0) > 0,
    guardianOfCount: row.user?.guardianOf?.length ?? 0,
    isStaff: row.user?.role === "OWNER" || row.user?.role === "STAFF",
    // They fund something: a subscription names them as payer, or they hold
    // their own active membership.
    isAccountHolder:
      (row.subscriptions ?? []).some((s) => s.payerUserId && s.payerUserId === row.userId) ||
      ((row.user?.guardianOf?.length ?? 0) > 0 && (row.subscriptions?.length ?? 0) > 0),

    subscriptions: subs,
    trialEndsAt: row.trialEndsAt,
    balanceOwed: ctx.balanceByMember?.get(row.id) ?? null,

    migrationStatus: row.migrationStatus,
    importedAt: row.importedAt,
    importBatchId: row.importBatchId,
    legacySource: row.legacySource,
    legacyMemberId: row.legacyMemberId,
    legacyMembershipName: row.legacyMembershipName,
    legacyMembershipPrice: decimalToNumber(row.legacyMembershipPrice),
    activationEmailSentAt: row.activationEmailSentAt,
    activationEmailSendCount: row.activationEmailSendCount,
    activatedAt: row.activatedAt,
    migrationCompletedAt: row.migrationCompletedAt,
    approvalStatus: row.approvalStatus,
    paymentSetupStatus: row.paymentSetupStatus,

    reviewedAt: row.reviewedAt,
    reviewedByUserId: row.reviewedByUserId,
    blockedReason: row.blockedReason,
    snoozedUntil: row.snoozedUntil,

    invitationSendCount: inv?.sends ?? row.activationEmailSendCount ?? null,
    invitationOpenedCount: inv?.opened ?? null,
    invitationBouncedCount: inv?.bounced ?? null,
    lastInvitationSentAt: inv?.lastSentAt ?? row.activationEmailSentAt,
    lastInvitationEmail: inv?.lastEmail ?? null,

    lastSeenAt: row.user?.lastLoginAt ?? null,
  };
}

export type SerializedMemberTracks = {
  role: RoleChip[];
  membership: { track: string; label: string; detail: string | null };
  accountSetup: { track: string; label: string; dot: string; meter: MigrationMeter };
};

export type SerializedMember = {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  initials: string;
  profileImageUrl: string | null;
  isMinor: boolean;
  email: string | null;
  guardianEmail: string | null;
  lastSeenAt: Date | null;
  balanceOwed: number | null;
  /** Owner-typed label for where this person was imported from. Never a literal. */
  sourceLabel: string | null;
  importedAt: Date | null;
  tracks: SerializedMemberTracks;
  nextAction: NextAction;
};

import { MEMBERSHIP_LABELS, SETUP_DOT, type MembershipTrack, type SetupTrack } from "@/lib/memberTracks";

/** Initials for the avatar. Falls back to one letter, never to empty. */
export function initialsOf(firstName: string, lastName: string): string {
  const a = firstName?.trim()?.[0] ?? "";
  const b = lastName?.trim()?.[0] ?? "";
  return (a + b).toUpperCase() || "?";
}

/**
 * The one serializer every members surface reads — list rows, the profile
 * header, the migration queue and the mobile card.
 */
export function serializeMemberForList(row: MemberTrackRow, ctx: MemberTrackContext = {}): SerializedMember {
  const now = ctx.now ?? new Date();
  const input = toTrackInput(row, ctx);

  const membership = membershipTrackFor(input, now) as MembershipTrack;
  const setup = setupTrackFor(input) as SetupTrack;

  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    fullName: `${row.firstName} ${row.lastName}`.trim(),
    initials: initialsOf(row.firstName, row.lastName),
    profileImageUrl: row.profileImageUrl ?? null,
    isMinor: row.isMinor,
    email: row.email ?? null,
    guardianEmail: row.guardianEmail ?? null,
    lastSeenAt: row.user?.lastLoginAt ?? null,
    balanceOwed: ctx.balanceByMember?.get(row.id) ?? null,
    sourceLabel: resolveSourceLabel({
      batchSourceLabel: row.importBatchId ? ctx.sourceLabelByBatch?.get(row.importBatchId) ?? null : null,
      legacySource: row.legacySource,
    }),
    importedAt: row.importedAt ?? null,
    tracks: {
      role: rolesFor(input, now),
      membership: {
        track: membership,
        label: MEMBERSHIP_LABELS[membership],
        detail: membershipDetailFor(input, now),
      },
      accountSetup: {
        track: setup,
        label: setupLabelFor(input, now),
        dot: SETUP_DOT[setup],
        meter: migrationMeterFor(input, now),
      },
    },
    nextAction: nextAction(input, now),
  };
}

/**
 * Person-type segment counts for the toolbar. Computed from the QUERY, never
 * from the loaded page — a count that changes when you paginate is worse than
 * no count at all.
 */
export type PersonTypeCounts = {
  everyone: number;
  athletes: number;
  parents: number;
  accountHolders: number;
  prospects: number;
  inactive: number;
  midMigration: number;
};

/**
 * Resolve the owner-typed source labels for a page of members in one query.
 *
 * Safe to call TODAY — import_batches."sourceLabel" shipped with 2.5.9 and is
 * already in production, so this is not blocked on the new migration.
 */
export async function loadSourceLabels(
  db: { importBatch: { findMany: (a: unknown) => Promise<{ id: string; sourceLabel: string | null }[]> } },
  batchIds: (string | null | undefined)[],
): Promise<Map<string, string | null>> {
  const ids = Array.from(new Set(batchIds.filter((b): b is string => Boolean(b))));
  if (ids.length === 0) return new Map();
  const rows = await db.importBatch.findMany({
    where: { id: { in: ids } },
    select: { id: true, sourceLabel: true },
  });
  return new Map(rows.map((r) => [r.id, r.sourceLabel]));
}

export function countsFrom(serialized: SerializedMember[]): PersonTypeCounts {
  const c: PersonTypeCounts = {
    everyone: serialized.length,
    athletes: 0,
    parents: 0,
    accountHolders: 0,
    prospects: 0,
    inactive: 0,
    midMigration: 0,
  };
  for (const m of serialized) {
    const roles = new Set(m.tracks.role.map((r) => r.role));
    if (roles.has("ATHLETE")) c.athletes++;
    if (roles.has("PARENT")) c.parents++;
    if (roles.has("ACCOUNT_HOLDER")) c.accountHolders++;
    if (m.tracks.membership.track === "PROSPECT") c.prospects++;
    if (m.tracks.membership.track === "INACTIVE") c.inactive++;
    const meter = m.tracks.accountSetup.meter;
    if (meter.applicable && meter.step < meter.total) c.midMigration++;
  }
  return c;
}
