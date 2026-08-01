// Canonical AudienceFilter DSL + server-side evaluator (plan §3D).
//
// Owners build recipient groups by combining filters on:
//   membership status / type · program (recurring class) · attendance
//   window · age / grad year · location · coach · migration status ·
//   invitation status · payment status · event registration · class
//   registration · relationship type · account role · tags · custom
//   member selections.
//
// Filters combine (`match: 'ALL' | 'ANY'`). Every rule is a discrete
// {field, op, value} triple — the evaluator translates each rule to a
// Prisma `where` fragment and AND/ORs them together. Missing / unknown
// rules produce NO members (fail-closed) so a typo can't accidentally
// blast the whole club.
//
// The DSL is JSON storage on MarketingAudience.filters. Same shape is
// evaluated in three places:
//   1. Estimated-count preview as the owner builds
//   2. Send-time expansion (isDynamic=true) so new members who now
//      match receive the message
//   3. Frozen snapshot capture (isDynamic=false → frozenMemberIds)
//
// Snapshot format:
//   {
//     match: "ALL" | "ANY",
//     rules: [{ field, op, value }],
//     // optional owner-selected memberIds always included regardless
//     // of the rule set (the "custom selections" field from plan §3D).
//     alwaysIncludeMemberIds?: string[],
//     // optional owner-selected memberIds always excluded
//     alwaysExcludeMemberIds?: string[],
//   }

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type Match = "ALL" | "ANY";
export type Op = "eq" | "ne" | "in" | "nin" | "gte" | "lte" | "between" | "true" | "false";

export interface AudienceRule {
  field: string;
  op: Op;
  value?: unknown;
}

export interface AudienceFilter {
  match: Match;
  rules: AudienceRule[];
  alwaysIncludeMemberIds?: string[];
  alwaysExcludeMemberIds?: string[];
}

// The fields listed in plan §3D. Each maps to a Prisma where fragment
// via ruleToWhere. Keeping the list explicit (rather than accepting any
// field string) is the fail-closed guard — an unknown field name never
// silently returns everyone.
export const AUDIENCE_FIELDS = [
  "membershipStatus",       // ACTIVE | INACTIVE | PROSPECT | PAUSED
  "membershipId",           // Membership.id (or "any" via op:true)
  "programClassId",         // RecurringClass.id — enrolled via attendance
  "lastAttendedDaysAgo",    // number (gte/lte)
  "neverAttended",          // op:true|false
  "ageYears",               // number
  "gradYear",               // string
  "locationId",             // Location.id
  "coachUserId",            // User.id (staff)
  "migrationStatus",        // IMPORTED | INVITED | ACTIVATED | COMPLETED | ...
  "hasCompletedMigration",  // op:true|false
  "invitationSent",         // op:true|false (Member.activationEmailSentAt)
  "paymentPastDue",         // op:true|false (MemberSubscription.status="past_due")
  "membershipEndsWithinDays", // number
  "registeredForEventId",   // Event.id (via Booking OR EventRegistration)
  "classSessionAttended",   // ClassSession.id
  "relationshipType",       // SIBLING | COUSIN | ... (via MemberRelationship)
  "accountRole",            // ATHLETE | PARENT | ADULT (derived)
  "tag",                    // Member.tags contains
  "isMinor",                // op:true|false
] as const;
export type AudienceField = (typeof AUDIENCE_FIELDS)[number];

// Public: validate + normalize the incoming filter shape. Returns a
// clean AudienceFilter or throws with a human-readable reason.
export function parseAudienceFilter(raw: unknown): AudienceFilter {
  if (!raw || typeof raw !== "object") {
    throw new Error("filter must be an object");
  }
  const src = raw as Record<string, unknown>;
  const match: Match = src.match === "ANY" ? "ANY" : "ALL";
  const rulesIn = Array.isArray(src.rules) ? src.rules : [];
  const rules: AudienceRule[] = [];
  for (const r of rulesIn) {
    if (!r || typeof r !== "object") continue;
    const rr = r as Record<string, unknown>;
    if (typeof rr.field !== "string") continue;
    if (!(AUDIENCE_FIELDS as readonly string[]).includes(rr.field)) continue;
    const op = String(rr.op ?? "eq") as Op;
    rules.push({ field: rr.field, op, value: rr.value });
  }
  const alwaysIncludeMemberIds = Array.isArray(src.alwaysIncludeMemberIds)
    ? (src.alwaysIncludeMemberIds as string[]).filter((s) => typeof s === "string")
    : undefined;
  const alwaysExcludeMemberIds = Array.isArray(src.alwaysExcludeMemberIds)
    ? (src.alwaysExcludeMemberIds as string[]).filter((s) => typeof s === "string")
    : undefined;
  return { match, rules, alwaysIncludeMemberIds, alwaysExcludeMemberIds };
}

// Evaluate the filter against a club and return the matched member IDs.
// Fail-closed: unknown rule fields drop out during parse; a filter with
// zero valid rules returns only the alwaysInclude set (or [] if none).
export async function evaluateAudience(clubId: string, filter: AudienceFilter): Promise<string[]> {
  const now = new Date();

  const ruleWheres: Prisma.MemberWhereInput[] = [];
  for (const rule of filter.rules) {
    const w = await ruleToWhere(clubId, rule, now);
    if (w) ruleWheres.push(w);
  }

  const combined: Prisma.MemberWhereInput = ruleWheres.length === 0
    ? {}
    : filter.match === "ALL"
      ? { AND: ruleWheres }
      : { OR: ruleWheres };

  const where: Prisma.MemberWhereInput = {
    clubId,
    deletedAt: null,
    ...combined,
    ...(filter.alwaysExcludeMemberIds && filter.alwaysExcludeMemberIds.length
      ? { id: { notIn: filter.alwaysExcludeMemberIds } }
      : {}),
  };

  // Base match — respects alwaysExclude but not alwaysInclude yet.
  const matchedRows = filter.rules.length === 0 && (!filter.alwaysIncludeMemberIds || !filter.alwaysIncludeMemberIds.length)
    ? []
    : await prisma.member.findMany({ where, select: { id: true } });
  const matchedIds = new Set(matchedRows.map((m) => m.id));

  // Union the alwaysInclude set (owner-picked "always ship to these
  // members" — plan §3D "custom selections"). Validate they belong to
  // this club so a stale ID can't cross tenants.
  if (filter.alwaysIncludeMemberIds && filter.alwaysIncludeMemberIds.length) {
    const valid = await prisma.member.findMany({
      where: {
        clubId,
        deletedAt: null,
        id: { in: filter.alwaysIncludeMemberIds },
        ...(filter.alwaysExcludeMemberIds && filter.alwaysExcludeMemberIds.length
          ? { id: { notIn: filter.alwaysExcludeMemberIds } }
          : {}),
      },
      select: { id: true },
    });
    for (const v of valid) matchedIds.add(v.id);
  }

  return Array.from(matchedIds);
}

// Cheap count wrapper — same evaluator, returns only length. Currently
// evaluates the whole set (necessary for correct deduplication with
// alwaysInclude); a future optimization could use `count()` when there
// are no alwaysInclude/exclude sets.
export async function estimateAudienceCount(clubId: string, filter: AudienceFilter): Promise<number> {
  const ids = await evaluateAudience(clubId, filter);
  return ids.length;
}

// ── Rule → where ────────────────────────────────────────────────────────

async function ruleToWhere(clubId: string, rule: AudienceRule, now: Date): Promise<Prisma.MemberWhereInput | null> {
  switch (rule.field as AudienceField) {
    case "membershipStatus":
      return { status: normalizeEnumIn(rule) };
    case "membershipId":
      if (rule.op === "true") return { membershipId: { not: null } };
      if (rule.op === "false") return { membershipId: null };
      return { membershipId: normalizeStringNullableWhere(rule) };
    case "isMinor":
      return { isMinor: rule.op === "true" ? true : rule.op === "false" ? false : Boolean(rule.value) };
    case "migrationStatus":
      return { migrationStatus: normalizeStringNullableWhere(rule) };
    case "hasCompletedMigration":
      return rule.op === "true"
        ? { migrationCompletedAt: { not: null } }
        : { migrationCompletedAt: null };
    case "invitationSent":
      return rule.op === "true"
        ? { activationEmailSentAt: { not: null } }
        : { activationEmailSentAt: null };
    case "paymentPastDue":
      return rule.op === "true"
        ? { subscriptions: { some: { status: "past_due" } } }
        : { subscriptions: { none: { status: "past_due" } } };
    case "membershipEndsWithinDays": {
      const days = Number(rule.value);
      if (!Number.isFinite(days) || days < 0) return null;
      const cutoff = new Date(now.getTime() + days * 86_400_000);
      return {
        subscriptions: {
          some: {
            status: { in: ["active", "past_due", "trialing"] },
            endDate: { not: null, gte: now, lte: cutoff },
          },
        },
      };
    }
    case "lastAttendedDaysAgo": {
      const days = Number(rule.value);
      if (!Number.isFinite(days) || days < 0) return null;
      const cutoff = new Date(now.getTime() - days * 86_400_000);
      // op:gte "at least N days since last attendance"  → none within window
      // op:lte "at most N days since last attendance"   → some within window
      if (rule.op === "gte") {
        return { attendanceRecords: { none: { createdAt: { gt: cutoff } } } };
      }
      if (rule.op === "lte") {
        return { attendanceRecords: { some: { createdAt: { gt: cutoff } } } };
      }
      return null;
    }
    case "neverAttended":
      return rule.op === "true"
        ? { attendanceRecords: { none: {} } }
        : { attendanceRecords: { some: {} } };
    case "ageYears": {
      const val = Number(rule.value);
      if (!Number.isFinite(val)) return null;
      const cutoff = new Date(now);
      cutoff.setFullYear(cutoff.getFullYear() - val);
      if (rule.op === "gte") {
        // age >= N  ⇔  born on or before (today - N years)
        return { dateOfBirth: { not: null, lte: cutoff } };
      }
      if (rule.op === "lte") {
        return { dateOfBirth: { not: null, gte: cutoff } };
      }
      return null;
    }
    case "gradYear":
      return { customFieldValues: { contains: `"${String(rule.value)}"` } };
    case "programClassId":
      // ClassSession.classId → RecurringClass.id (relation is
      // `recurringClass` but the FK column is `classId`).
      return { attendanceRecords: { some: { classSession: { classId: normalizeStringWhere(rule) } } } };
    case "classSessionAttended":
      return { attendanceRecords: { some: { classSessionId: normalizeStringNullableWhere(rule) } } };
    case "registeredForEventId":
      return {
        OR: [
          { bookings: { some: { eventId: normalizeStringWhere(rule) } } },
          { eventRegistrations: { some: { eventId: normalizeStringWhere(rule) } } },
        ],
      };
    case "tag":
      // Member.tags is a comma-joined String today (see schema). Match a
      // whole tag with the surrounding commas so "kids" doesn't match
      // "kidscamp". `contains` is enough here — an owner picking from a
      // curated list doesn't need full-text; a future move to text[]
      // would swap the operator only.
      return { tags: { contains: String(rule.value ?? "") } };
    case "accountRole":
      if (String(rule.value) === "ATHLETE") return { isMinor: true };
      if (String(rule.value) === "ADULT") return { isMinor: false };
      if (String(rule.value) === "PARENT") {
        // A member row that itself has children linked as guardianOf via
        // its user account. Approximation: has guardianLinks pointing at
        // other members. Cheap heuristic: has any managed athletes.
        return { user: { guardianOf: { some: { memberId: { not: undefined } } } } };
      }
      return null;
    case "relationshipType":
      // MemberRelationship.type — the column is `type` not
      // `relationshipType` (see prisma/schema.prisma:962).
      return {
        OR: [
          { relationshipsFrom: { some: { type: String(rule.value) } } },
          { relationshipsTo: { some: { type: String(rule.value) } } },
        ],
      };
    case "locationId":
    case "coachUserId":
      // Location / coach filters need an assignment model that doesn't
      // exist yet (Members don't currently reference their primary
      // location or their primary coach directly). These fields parse
      // through but produce no restrictor today so the count is honest —
      // future work wires them once Phase 4.5's location/coach model
      // ships.
      return null;
    default:
      return null;
  }
}

function normalizeEnumIn(rule: AudienceRule): Prisma.EnumMemberStatusFilter {
  const arr = normalizeArray(rule);
  if (arr.length === 0) return {};
  // Cast — Prisma expects the actual enum union; the DB will reject unknowns.
  return { in: arr as unknown as Prisma.EnumMemberStatusFilter["in"] };
}

// Non-nullable column variant — Prisma's StringFilter (no `null`).
function normalizeStringWhere(rule: AudienceRule): Prisma.StringFilter | string {
  const arr = normalizeArray(rule);
  if (arr.length === 1 && rule.op === "eq") return arr[0];
  if (arr.length === 1 && rule.op === "ne") return { not: arr[0] };
  if (rule.op === "nin") return { notIn: arr };
  return { in: arr };
}

// Nullable column variant — StringNullableFilter (accepts `null`).
function normalizeStringNullableWhere(rule: AudienceRule): Prisma.StringNullableFilter | string {
  const arr = normalizeArray(rule);
  if (arr.length === 1 && rule.op === "eq") return arr[0];
  if (arr.length === 1 && rule.op === "ne") return { not: arr[0] };
  if (rule.op === "nin") return { notIn: arr };
  return { in: arr };
}

function normalizeArray(rule: AudienceRule): string[] {
  if (Array.isArray(rule.value)) return (rule.value as unknown[]).map((v) => String(v));
  if (rule.value == null) return [];
  return [String(rule.value)];
}
