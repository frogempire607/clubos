// Phase 4.5.2 — server-side listing for the members roster.
//
// ── Why this is server-side ──────────────────────────────────────────────────
// The old page fetched every member and filtered in the browser. On a
// 5,000-person club that is a multi-megabyte payload before the first row
// paints, and — worse — the segment counts on the toolbar were counts of what
// happened to be loaded. The handoff is explicit: "Server-side search/sort/
// pagination is mandatory; counts come from the query, not the loaded page."
//
// ── The count cap ────────────────────────────────────────────────────────────
// Segment counts are DERIVED (a person is an Athlete because they have
// attendance or a subscription, not because a column says so), so they cannot
// be a SQL `count(*)`. We fetch a lean projection of every matching row and
// derive in memory. That is one query over ~15 small columns and is fine into
// the tens of thousands — but it is not unbounded, so past COUNT_CAP we return
// `counts: null` with `countsCapped: true` rather than a number that is quietly
// wrong. A missing count is honest; a wrong one is not.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ACTIVE_GUARDIAN_LINK } from "@/lib/familyAccess";
import {
  MEMBER_TRACK_SELECT,
  countsFrom,
  serializeMemberForList,
  type MemberTrackContext,
  type PersonTypeCounts,
  type SerializedMember,
} from "@/lib/memberDisplay";
import { membershipTrackFor, nextAction, rolesFor, type MemberTrackInput } from "@/lib/memberTracks";
import { toTrackInput } from "@/lib/memberDisplay";

/**
 * Resolve the owner-typed source labels for a page of members in one query.
 *
 * Lives here rather than in memberDisplay.ts so it can use the real Prisma
 * client type. members."importBatchId" has no FK (deliberate — see the note on
 * MEMBER_TRACK_SELECT), so this is a lookup, not a join.
 *
 * Safe against the pre-4.5 world: import_batches."sourceLabel" shipped with
 * 2.5.9 and has been in production since 2026-07-29.
 */
export async function loadSourceLabels(
  batchIds: (string | null | undefined)[],
): Promise<Map<string, string | null>> {
  const ids = Array.from(new Set(batchIds.filter((b): b is string => Boolean(b))));
  if (ids.length === 0) return new Map();
  const rows = await prisma.importBatch.findMany({
    where: { id: { in: ids } },
    select: { id: true, sourceLabel: true },
  });
  return new Map(rows.map((r) => [r.id, r.sourceLabel]));
}

export const COUNT_CAP = 20_000;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export type PersonType =
  | "everyone"
  | "athletes"
  | "parents"
  | "accountHolders"
  | "prospects"
  | "inactive"
  | "midMigration";

export type MemberListFilters = {
  search: string;
  personType: PersonType;
  /** Track 3 state, e.g. NOT_INVITED | BLOCKED | COMPLETE. */
  setupState: string | null;
  /** Track 2 state, e.g. ACTIVE | PENDING | PROSPECT | LEAD | INACTIVE. */
  membership: string | null;
  tag: string | null;
  gender: string | null;
  /** Work-queue shortcuts from the 4-card strip. */
  queue: "neverInvited" | "blocked" | "missingContact" | null;
  sort: "lastSeen" | "name" | "joined" | "balance";
  page: number;
  pageSize: number;
};

export function parseMemberFilters(url: URL): MemberListFilters {
  const num = (k: string, d: number) => {
    const v = Number(url.searchParams.get(k));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : d;
  };
  const str = (k: string) => {
    const v = url.searchParams.get(k)?.trim();
    return v ? v : null;
  };
  return {
    search: str("search") ?? "",
    personType: (str("personType") as PersonType) ?? "everyone",
    setupState: str("setupState"),
    membership: str("membership"),
    tag: str("tag"),
    gender: str("gender"),
    queue: (str("queue") as MemberListFilters["queue"]) ?? null,
    sort: (str("sort") as MemberListFilters["sort"]) ?? "lastSeen",
    page: num("page", 1),
    pageSize: Math.min(num("pageSize", DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE),
  };
}

/**
 * The SQL-expressible half of the filter. Everything derived (person type,
 * track states) is applied after serialization, because those are functions of
 * several tables at once and cannot be a WHERE clause without duplicating the
 * rules that lib/memberTracks.ts already owns — and a duplicated rule is a rule
 * that will drift.
 */
export function memberWhere(clubId: string, f: MemberListFilters): Prisma.MemberWhereInput {
  const where: Prisma.MemberWhereInput = { clubId, deletedAt: null };
  const and: Prisma.MemberWhereInput[] = [];

  if (f.search) {
    const q = f.search;
    and.push({
      OR: [
        { firstName: { contains: q, mode: "insensitive" } },
        { lastName: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        { phone: { contains: q } },
        { guardianName: { contains: q, mode: "insensitive" } },
        { guardianEmail: { contains: q, mode: "insensitive" } },
        // "legacy ID" in the search placeholder — the id from the old system,
        // which is often the only thing a parent can quote on the phone.
        { legacyMemberId: { contains: q, mode: "insensitive" } },
        { externalMemberId: { contains: q, mode: "insensitive" } },
      ],
    });
  }

  if (f.tag) and.push({ tags: { contains: f.tag, mode: "insensitive" } });
  if (f.gender) and.push({ gender: f.gender });

  // Work-queue cards. Each is a saved filter that also arms a bulk action, so
  // the set it selects has to be exactly the set the action will operate on.
  if (f.queue === "neverInvited") {
    and.push({ migrationStatus: { not: null }, activationEmailSentAt: null });
  } else if (f.queue === "blocked") {
    and.push({ blockedReason: { not: null } });
  } else if (f.queue === "missingContact") {
    and.push({ email: null, guardianEmail: null, phone: null, guardianPhone: null });
  }

  if (and.length) where.AND = and;
  return where;
}

const ORDER_BY: Record<MemberListFilters["sort"], Prisma.MemberOrderByWithRelationInput[]> = {
  // "Last seen" has no single column — the closest true fact is the linked
  // user's last login, and members with no login sort last rather than first.
  lastSeen: [{ user: { lastLoginAt: { sort: "desc", nulls: "last" } } }, { createdAt: "desc" }],
  name: [{ lastName: "asc" }, { firstName: "asc" }],
  joined: [{ joinedAt: "desc" }],
  balance: [{ createdAt: "desc" }],
};

/** Does a serialized row survive the derived half of the filter? */
export function matchesDerived(m: SerializedMember, f: MemberListFilters): boolean {
  if (f.membership && m.tracks.membership.track !== f.membership) return false;
  if (f.setupState && m.tracks.accountSetup.track !== f.setupState) return false;

  if (f.personType && f.personType !== "everyone") {
    const roles = new Set(m.tracks.role.map((r) => r.role));
    const meter = m.tracks.accountSetup.meter;
    switch (f.personType) {
      case "athletes":
        if (!roles.has("ATHLETE")) return false;
        break;
      case "parents":
        if (!roles.has("PARENT")) return false;
        break;
      case "accountHolders":
        if (!roles.has("ACCOUNT_HOLDER")) return false;
        break;
      case "prospects":
        if (m.tracks.membership.track !== "PROSPECT") return false;
        break;
      case "inactive":
        if (m.tracks.membership.track !== "INACTIVE") return false;
        break;
      case "midMigration":
        if (!meter.applicable || meter.step >= meter.total) return false;
        break;
    }
  }
  return true;
}

export type MemberListResult = {
  members: SerializedMember[];
  pagination: { total: number; page: number; pageSize: number; pages: number };
  counts: PersonTypeCounts | null;
  countsCapped: boolean;
};

/**
 * Gather the per-member signals the pure rules need but the base select cannot
 * cheaply carry: attendance existence, and the invitation-delivery rollup.
 *
 * Both are grouped aggregates over the page's member ids, not per-row queries —
 * a per-row query here would be 50 round trips per page load.
 */
export async function buildTrackContext(memberIds: string[], now?: Date): Promise<MemberTrackContext> {
  if (memberIds.length === 0) return { now };

  const [attendance, deliveries] = await Promise.all([
    prisma.attendanceRecord.groupBy({
      by: ["memberId"],
      where: { memberId: { in: memberIds } },
      _count: { _all: true },
    }),
    // Phase 4.5.1's per-send log. Before any invitation has been recorded
    // through it this simply returns nothing and the rules fall back to
    // Member.activationEmailSendCount, which is what they did before.
    prisma.memberInvitationDelivery.findMany({
      where: { memberId: { in: memberIds } },
      select: {
        memberId: true,
        sentAt: true,
        openedAt: true,
        bouncedAt: true,
        sentToEmail: true,
      },
      orderBy: { sentAt: "desc" },
    }),
  ]);

  const attendanceByMember = new Map<string, number>();
  for (const a of attendance) {
    if (a.memberId) attendanceByMember.set(a.memberId, a._count._all);
  }

  const invitationsByMember = new Map<
    string,
    { sends: number; opened: number; bounced: number; lastSentAt: Date | null; lastEmail: string | null }
  >();
  for (const d of deliveries) {
    const cur = invitationsByMember.get(d.memberId) ?? {
      sends: 0,
      opened: 0,
      bounced: 0,
      lastSentAt: null as Date | null,
      lastEmail: null as string | null,
    };
    cur.sends++;
    if (d.openedAt) cur.opened++;
    if (d.bouncedAt) cur.bounced++;
    // Rows arrive newest-first, so the first one seen per member is the latest.
    if (!cur.lastSentAt) {
      cur.lastSentAt = d.sentAt;
      cur.lastEmail = d.sentToEmail;
    }
    invitationsByMember.set(d.memberId, cur);
  }

  return { attendanceByMember, invitationsByMember, now };
}

export async function listMembers(clubId: string, f: MemberListFilters): Promise<MemberListResult> {
  const where = memberWhere(clubId, f);
  const now = new Date();

  const hasDerivedFilter = Boolean(
    f.membership || f.setupState || (f.personType && f.personType !== "everyone"),
  );

  const total = await prisma.member.count({ where });

  // ── Counts, and the derived-filter path ─────────────────────────────────
  // When a derived filter is active we cannot let the database paginate: the
  // rows it would skip might be exactly the ones that survive the filter. So we
  // serialize the whole matching set, filter, then slice. The cap is what keeps
  // that honest at scale.
  const capped = total > COUNT_CAP;

  if (!capped) {
    const all = await prisma.member.findMany({
      where,
      orderBy: ORDER_BY[f.sort],
      select: MEMBER_TRACK_SELECT,
    });
    const ctx = await buildTrackContext(
      all.map((m) => m.id),
      now,
    );
    ctx.sourceLabelByBatch = await loadSourceLabels(all.map((m) => m.importBatchId));

    const serialized = all.map((m) => serializeMemberForList(m, ctx));
    const counts = countsFrom(serialized);
    const filtered = hasDerivedFilter ? serialized.filter((m) => matchesDerived(m, f)) : serialized;

    const start = (f.page - 1) * f.pageSize;
    return {
      members: filtered.slice(start, start + f.pageSize),
      pagination: {
        total: filtered.length,
        page: f.page,
        pageSize: f.pageSize,
        pages: Math.max(1, Math.ceil(filtered.length / f.pageSize)),
      },
      counts,
      countsCapped: false,
    };
  }

  // ── Capped path: database pagination, no derived filters, no counts ──────
  const rows = await prisma.member.findMany({
    where,
    orderBy: ORDER_BY[f.sort],
    select: MEMBER_TRACK_SELECT,
    skip: (f.page - 1) * f.pageSize,
    take: f.pageSize,
  });
  const ctx = await buildTrackContext(
    rows.map((m) => m.id),
    now,
  );
  ctx.sourceLabelByBatch = await loadSourceLabels(rows.map((m) => m.importBatchId));

  return {
    members: rows.map((m) => serializeMemberForList(m, ctx)),
    pagination: {
      total,
      page: f.page,
      pageSize: f.pageSize,
      pages: Math.max(1, Math.ceil(total / f.pageSize)),
    },
    counts: null,
    countsCapped: true,
  };
}

/**
 * Resolve a query-scoped bulk selection into concrete member ids.
 *
 * The handoff is emphatic that "Select all N matching this filter" must send an
 * INTENT, not 500 ids — otherwise the client is bounded by what it has loaded,
 * which is exactly the bug that made bulk actions silently apply to page one.
 */
export async function resolveSelection(
  clubId: string,
  selection: { mode: "ids" | "allMatching"; ids?: string[]; filter?: Partial<MemberListFilters> },
): Promise<string[]> {
  if (selection.mode === "ids") {
    if (!selection.ids?.length) return [];
    // Re-scope to the club: an id list arrives from the client and must never
    // be trusted to be in-tenant.
    const rows = await prisma.member.findMany({
      where: { clubId, deletedAt: null, id: { in: selection.ids } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  const f: MemberListFilters = {
    search: "",
    personType: "everyone",
    setupState: null,
    membership: null,
    tag: null,
    gender: null,
    queue: null,
    sort: "lastSeen",
    page: 1,
    pageSize: MAX_PAGE_SIZE,
    ...selection.filter,
  };

  const rows = await prisma.member.findMany({
    where: memberWhere(clubId, f),
    select: MEMBER_TRACK_SELECT,
  });
  const needsDerived = Boolean(f.membership || f.setupState || (f.personType && f.personType !== "everyone"));
  if (!needsDerived) return rows.map((r) => r.id);

  const ctx = await buildTrackContext(rows.map((m) => m.id));
  return rows
    .map((m) => serializeMemberForList(m, ctx))
    .filter((m) => matchesDerived(m, f))
    .map((m) => m.id);
}

/** Re-exported so route handlers do not need two imports. */
export { MEMBER_TRACK_SELECT, ACTIVE_GUARDIAN_LINK, membershipTrackFor, nextAction, rolesFor, toTrackInput };
export type { MemberTrackInput, SerializedMember, PersonTypeCounts };
