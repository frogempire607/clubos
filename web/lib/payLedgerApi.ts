// Pay plans + pay ledger — what the API ROUTES share. No permission checks
// here: every handler calls its own live guard and the "never your own pay"
// rule (scripts/permission-boundary-guard.ts judges each handler by itself).
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { writeBillingAudit } from "@/lib/billingAudit";
import { recordStaffActivity } from "@/lib/staffActivity";
import { CLASS_STAFF_ROLES, clubTodayYmd } from "@/lib/classStaff";
import { ALL_SCOPE_TYPES, BONUS_TYPES, COUNT_PER, EVENT_TYPES, EVENT_TYPE_LABELS, PLAN_BASE_TYPES, isYmd, type PlanInput } from "@/lib/payLedger";
import { PayLedgerError } from "@/lib/payLedgerServer";

/** A PayLedgerError → `{ error, code }` with its status. Anything else → null (re-throw it). */
export function payErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof PayLedgerError || (err && typeof err === "object" && (err as { name?: string }).name === "PayLedgerError")) {
    const e = err as PayLedgerError;
    return NextResponse.json({ error: e.message, code: e.code }, { status: e.status ?? 400 });
  }
  return null;
}

const ymd = z.string().refine(isYmd, "Use a date like 2026-10-13.");
const scope = z.object({ scopeType: z.enum(ALL_SCOPE_TYPES), scopeId: z.string().trim().min(1).max(120) });

export const planInputSchema = z.object({
  name: z.string().trim().min(1, "Give the pay plan a name.").max(80),
  baseType: z.enum(PLAN_BASE_TYPES),
  baseAmount: z.number().min(0).max(1_000_000),
  effectiveFrom: ymd,
  effectiveTo: ymd.nullable().optional(),
  baseScopes: z.array(scope).max(200).default([]),
  bonuses: z.array(z.object({
    id: z.string().min(1).nullable().optional(),
    bonusType: z.enum(BONUS_TYPES),
    amount: z.number().min(0).max(1_000_000),
    minThreshold: z.number().int().min(0).nullable().optional(),
    maxThreshold: z.number().int().min(0).nullable().optional(),
    countPer: z.enum(COUNT_PER).default("PERIOD"),
    scopes: z.array(scope).max(200).default([]),
  })).max(20).default([]),
}).strict();

export function toPlanInput(d: z.infer<typeof planInputSchema>): PlanInput {
  return {
    name: d.name, baseType: d.baseType, baseAmount: d.baseAmount, effectiveFrom: d.effectiveFrom,
    effectiveTo: d.effectiveTo ?? null, baseScopes: d.baseScopes,
    bonuses: d.bonuses.map((b) => ({
      id: b.id ?? null, bonusType: b.bonusType, amount: b.amount, minThreshold: b.minThreshold ?? null,
      maxThreshold: b.maxThreshold ?? null, countPer: b.countPer, scopes: b.scopes,
    })),
  };
}

export type PayOptions = Awaited<ReturnType<typeof loadPayOptions>>;

/** Everything a plan editor can pick from. */
export async function loadPayOptions(clubId: string) {
  const [classes, events, memberships, lessonTypes, usedRoles, club] = await Promise.all([
    prisma.recurringClass.findMany({ where: { clubId, deletedAt: null }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.event.findMany({ where: { clubId, deletedAt: null }, select: { id: true, name: true }, orderBy: { startsAt: "desc" }, take: 100 }),
    prisma.membership.findMany({ where: { clubId, deletedAt: null }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.privateLessonType.findMany({ where: { clubId, deletedAt: null }, select: { id: true, title: true }, orderBy: { title: "asc" } }),
    prisma.classStaffRule.findMany({ where: { clubId, roleName: { not: null } }, select: { roleName: true } }),
    prisma.club.findUnique({ where: { id: clubId }, select: { timezone: true } }),
  ]);
  const roles: string[] = CLASS_STAFF_ROLES.map((r) => r.label);
  for (const r of usedRoles) {
    const name = (r.roleName ?? "").trim();
    if (name && !roles.some((x) => x.toLowerCase() === name.toLowerCase())) roles.push(name);
  }
  return {
    classes,
    events,
    memberships,
    lessonTypes: lessonTypes.map((l) => ({ id: l.id, name: l.title })),
    roles,
    eventTypes: EVENT_TYPES.map((t) => ({ id: t, name: EVENT_TYPE_LABELS[t] })),
    today: clubTodayYmd(club?.timezone ?? null),
  };
}

/** One audit-log row + one "Recent activity" line for a pay change. Never throws. */
export async function recordPayChange(args: {
  clubId: string; staffUserId: string; actorUserId: string | null; actorName: string | null;
  action: string; summary: string; before?: unknown; after?: unknown;
}): Promise<void> {
  await writeBillingAudit({
    clubId: args.clubId, actorUserId: args.actorUserId, action: args.action,
    before: args.before, after: args.after, note: `${args.summary} (staff ${args.staffUserId})`,
  });
  await recordStaffActivity({
    clubId: args.clubId, staffUserId: args.staffUserId, actorUserId: args.actorUserId, actorName: args.actorName,
    kind: "PAY", summary: args.summary,
  });
}
