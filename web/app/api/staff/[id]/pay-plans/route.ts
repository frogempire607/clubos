import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatZodError } from "@/lib/zodErrors";
import { hasPermissionLive, requirePermissionLive } from "@/lib/apiGuard";
import { selfRule, SELF_DENY_MESSAGE } from "@/lib/staffSelf";
import { actorFrom } from "@/lib/staffActivity";
import { planWarnings } from "@/lib/payLedger";
import { createPlan, getLedgerStart, listPlans, syncPayLines } from "@/lib/payLedgerServer";
import { loadPayOptions, payErrorResponse, planInputSchema, recordPayChange, toPlanInput } from "@/lib/payLedgerApi";

export const dynamic = "force-dynamic";

// GET /api/staff/[id]/pay-plans
// One staff member's pay plans. finances:view (live) — or the staff member
// themself, who may always SEE their own pay (read-only).
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const isSelf = selfRule(session.user.role, session.user.id, id, "view_pay") === "allow";
  if (!isSelf) {
    const denied = await requirePermissionLive(session, "finances", "view");
    if (denied) return denied;
  }
  const clubId = session.user.clubId;
  const user = await prisma.user.findFirst({
    where: { id, clubId, role: { in: ["OWNER", "STAFF"] }, deletedAt: null },
    select: { id: true, firstName: true, lastName: true },
  });
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const [plans, options, schedule, ledgerStart, canFull] = await Promise.all([
    listPlans(clubId, [id]),
    loadPayOptions(clubId),
    prisma.staffPaySchedule.findFirst({ where: { clubId, userId: id, active: true }, select: { id: true } }),
    getLedgerStart(clubId),
    hasPermissionLive(session, "finances", "full"),
  ]);
  return NextResponse.json({
    today: options.today,
    ledgerStart,
    options,
    staff: [{
      id: user.id, name: `${user.firstName} ${user.lastName}`.trim(), hasSchedule: !!schedule, plans,
      warnings: planWarnings({ plans, hasSchedule: !!schedule, todayYmd: options.today }),
    }],
    // Nobody edits their own pay (owners excepted — nobody is above them).
    viewer: { canEdit: canFull && !isSelf, userId: session.user.id, isOwner: session.user.role === "OWNER" },
  });
}

// POST /api/staff/[id]/pay-plans — add a named, dated pay plan.
// finances:full (live); never your own pay.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (selfRule(session.user.role, session.user.id, id, "edit_pay") === "deny") {
    return NextResponse.json({ error: SELF_DENY_MESSAGE.edit_pay }, { status: 403 });
  }
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  const clubId = session.user.clubId;

  let body: z.infer<typeof planInputSchema>;
  try {
    body = planInputSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err), code: "BAD_INPUT" }, { status: 400 });
    return NextResponse.json({ error: "Invalid request body", code: "BAD_INPUT" }, { status: 400 });
  }
  try {
    const plan = await createPlan({ clubId, userId: id, input: toPlanInput(body), byUserId: session.user.id ?? null });
    await recordPayChange({
      clubId, staffUserId: id, ...actorFrom(session), action: "PAY_PLAN_CREATED",
      summary: `Added the pay plan "${plan.name}"`, after: plan,
    });
    // Unpaid class days this plan now covers get their amount straight away.
    await syncPayLines(clubId, { userIds: [id] });
    return NextResponse.json({ ok: true, plan }, { status: 201 });
  } catch (err) {
    const res = payErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
