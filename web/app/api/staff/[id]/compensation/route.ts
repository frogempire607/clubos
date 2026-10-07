import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermissionLive } from "@/lib/apiGuard";
import { selfRule, SELF_DENY_MESSAGE } from "@/lib/staffSelf";
import { recordStaffActivity, actorFrom } from "@/lib/staffActivity";

import { prisma } from "@/lib/prisma";
import { writeBillingAudit } from "@/lib/billingAudit";
import { clubTodayYmd } from "@/lib/classStaff";
import { planActiveOn, type LedgerPlan, type PlanInput } from "@/lib/payLedger";
import { PayLedgerError, archivePlan, createPlan, listPlans, updatePlan } from "@/lib/payLedgerServer";

const SCOPE_TYPES = ["CLASS", "EVENT", "MEMBERSHIP", "PRIVATE_LESSON_TYPE"] as const;

const scopeSchema = z.object({
  scopeType: z.enum(SCOPE_TYPES),
  scopeId: z.string().min(1),
});

const planSchema = z.object({
  baseType: z.enum(["SALARY", "PER_CLASS", "HOURLY"]),
  baseAmount: z.number().min(0),
  baseScopes: z.array(scopeSchema).default([]), // CLASS scopes only are meaningful for base
  bonuses: z
    .array(
      z.object({
        bonusType: z.enum(["ATTENDANCE", "SIGNUP", "REVENUE_SHARE"]),
        amount: z.number().min(0),
        scopes: z.array(scopeSchema).default([]),
        minThreshold: z.number().int().min(0).nullable().optional(),
        maxThreshold: z.number().int().min(0).nullable().optional(),
      })
    )
    .default([]),
});

async function requireStaff(userId: string, clubId: string) {
  return prisma.user.findFirst({
    where: { id: userId, clubId, role: { in: ["OWNER", "STAFF"] }, deletedAt: null },
    select: { id: true },
  });
}

// The plan this older, one-plan endpoint talks about: the coach's plan in force
// today (the oldest, if several). Coaches with several plans are edited on
// Payroll → Pay plans (/api/staff/[id]/pay-plans).
function primaryPlan(plans: LedgerPlan[], today: string): LedgerPlan | null {
  return plans.find((p) => planActiveOn(p, today)) ?? plans.find((p) => !p.archived) ?? null;
}

async function todayFor(clubId: string): Promise<string> {
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { timezone: true } });
  return clubTodayYmd(club?.timezone ?? null);
}

// GET /api/staff/[id]/compensation
// Returns the staff member's compensation plan plus the assignable options
// (classes / events / memberships / private lesson types) for the builder UI.
// `plan` is the plan in force today in the original one-plan shape (kept for
// the Overview tab); `planCount` says how many plans the coach holds.
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // B21: a staff member may always SEE their own pay plan (read-only).
  if (selfRule(session.user.role, session.user.id, id, "view_pay") !== "allow") {
    const denied = await requirePermissionLive(session, "finances", "view");
    if (denied) return denied;
  }
  const staff = await requireStaff(id, session.user.clubId);
  if (!staff) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [plans, today, classes, events, memberships, lessonTypes] = await Promise.all([
    listPlans(session.user.clubId, [id]),
    todayFor(session.user.clubId),
    prisma.recurringClass.findMany({
      where: { clubId: session.user.clubId, deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.event.findMany({
      where: { clubId: session.user.clubId, deletedAt: null },
      select: { id: true, name: true, startsAt: true },
      orderBy: { startsAt: "desc" },
      take: 100,
    }),
    prisma.membership.findMany({
      where: { clubId: session.user.clubId, deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.privateLessonType.findMany({
      where: { clubId: session.user.clubId, deletedAt: null },
      select: { id: true, title: true },
      orderBy: { title: "asc" },
    }),
  ]);

  const plan = primaryPlan(plans, today);
  const shaped = plan
    ? {
        id: plan.id,
        name: plan.name,
        baseType: plan.baseType,
        baseAmount: plan.baseAmount,
        baseScopes: plan.baseScopes,
        bonuses: plan.bonuses.map((bo) => ({
          id: bo.id,
          bonusType: bo.bonusType,
          amount: bo.amount,
          minThreshold: bo.minThreshold,
          maxThreshold: bo.maxThreshold,
          scopes: bo.scopes,
        })),
      }
    : null;

  return NextResponse.json({
    plan: shaped,
    planCount: plans.filter((p) => !p.archived).length,
    options: {
      classes,
      events: events.map((e) => ({ id: e.id, name: e.name })),
      memberships,
      lessonTypes: lessonTypes.map((l) => ({ id: l.id, name: l.title })),
    },
  });
}

// PUT /api/staff/[id]/compensation — the older one-plan save.
// It no longer deletes and recreates (pay lines remember the plan that priced
// them): a coach with no plan gets one, a coach with exactly one plan has it
// edited IN PLACE, and a coach with several is sent to Payroll → Pay plans.
export async function PUT(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // B21: nobody changes their own pay, whatever permissions they hold.
  if (selfRule(session.user.role, session.user.id, id, "edit_pay") === "deny") {
    return NextResponse.json({ error: SELF_DENY_MESSAGE.edit_pay }, { status: 403 });
  }
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  const staff = await requireStaff(id, session.user.clubId);
  if (!staff) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const clubId = session.user.clubId;

  let data: z.infer<typeof planSchema>;
  try {
    data = planSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const [plans, today] = await Promise.all([listPlans(clubId, [id]), todayFor(clubId)]);
  const live = plans.filter((p) => !p.archived);
  if (live.length > 1) {
    return NextResponse.json({ error: "This staff member has more than one pay plan. Edit them on Payroll → Pay plans.", code: "MULTIPLE_PLANS" }, { status: 409 });
  }
  const cur = live[0] ?? null;
  const input: PlanInput = {
    name: cur?.name ?? "Pay plan",
    baseType: data.baseType,
    baseAmount: data.baseAmount,
    effectiveFrom: cur?.effectiveFrom ?? today,
    effectiveTo: cur?.effectiveTo ?? null,
    baseScopes: data.baseScopes,
    // The old form does not send bonus ids: line them up with the stored ones
    // in order, so an edited bonus stays the same bonus.
    bonuses: data.bonuses.map((b, i) => {
      const prev = cur?.bonuses.filter((x) => x.bonusType === b.bonusType) ?? [];
      const nth = data.bonuses.slice(0, i).filter((x) => x.bonusType === b.bonusType).length;
      return {
        id: prev[nth]?.id ?? null,
        bonusType: b.bonusType,
        amount: b.amount,
        minThreshold: b.minThreshold ?? null,
        maxThreshold: b.maxThreshold ?? null,
        countPer: (prev[nth]?.countPer === "CLASS_DAY" ? "CLASS_DAY" : "PERIOD") as "PERIOD" | "CLASS_DAY",
        scopes: b.scopes,
      };
    }),
  };

  try {
    const before = cur;
    const after = cur
      ? (await updatePlan({ clubId, planId: cur.id, input })).after
      : await createPlan({ clubId, userId: id, input, byUserId: session.user.id ?? null });
    await writeBillingAudit({
      clubId, actorUserId: session.user.id ?? null, action: before ? "PAY_PLAN_UPDATED" : "PAY_PLAN_CREATED",
      before: before ?? undefined, after, note: `Pay plan "${after.name}" for staff ${id}.`,
    });
  } catch (err) {
    if (err instanceof PayLedgerError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    throw err;
  }

  await recordStaffActivity({
    clubId: session.user.clubId,
    staffUserId: id,
    ...actorFrom(session),
    kind: "PAY",
    summary: `Updated the pay plan (${data.baseType === "SALARY" ? "salary" : data.baseType === "PER_CLASS" ? "per class" : "hourly"} base${data.bonuses.length ? `, ${data.bonuses.length} bonus${data.bonuses.length === 1 ? "" : "es"}` : ""})`,
  });

  return NextResponse.json({ ok: true });
}

// DELETE — remove the coach's pay plans from use (archived, never deleted:
// pay lines keep the name of the plan that priced them).
export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // B21: nobody changes their own pay, whatever permissions they hold.
  if (selfRule(session.user.role, session.user.id, id, "edit_pay") === "deny") {
    return NextResponse.json({ error: SELF_DENY_MESSAGE.edit_pay }, { status: 403 });
  }
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  const clubId = session.user.clubId;
  const plans = (await listPlans(clubId, [id])).filter((p) => !p.archived);
  for (const p of plans) {
    await archivePlan({ clubId, planId: p.id });
    await writeBillingAudit({ clubId, actorUserId: session.user.id ?? null, action: "PAY_PLAN_ARCHIVED", before: p, note: `Pay plan "${p.name}" for staff ${id} was removed.` });
  }
  if (plans.length > 0) {
    await recordStaffActivity({ clubId, staffUserId: id, ...actorFrom(session), kind: "PAY", summary: `Removed ${plans.length === 1 ? "the pay plan" : `${plans.length} pay plans`}` });
  }
  return NextResponse.json({ ok: true });
}
