import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermissionLive, requirePermissionLive } from "@/lib/apiGuard";
import { planWarnings } from "@/lib/payLedger";
import { getLedgerStart, listPlans } from "@/lib/payLedgerServer";
import { loadPayOptions } from "@/lib/payLedgerApi";

export const dynamic = "force-dynamic";

// GET /api/payroll/plans  (finances:view, live)
// Every current staff member with their pay plans (any state), what a plan
// editor can pick from, and what the caller may do. Payroll → Pay plans.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "view");
  if (denied) return denied;
  const clubId = session.user.clubId;
  const [staff, plans, options, schedules, ledgerStart, canEdit] = await Promise.all([
    prisma.user.findMany({
      where: { clubId, role: { in: ["OWNER", "STAFF"] }, deletedAt: null },
      select: { id: true, firstName: true, lastName: true, role: true, staffProfile: { select: { title: true } } },
      orderBy: { firstName: "asc" },
    }),
    listPlans(clubId),
    loadPayOptions(clubId),
    prisma.staffPaySchedule.findMany({ where: { clubId, active: true }, select: { userId: true } }),
    getLedgerStart(clubId),
    hasPermissionLive(session, "finances", "full"),
  ]);
  const scheduled = new Set(schedules.map((s) => s.userId));
  return NextResponse.json({
    today: options.today,
    ledgerStart,
    options,
    staff: staff.map((u) => {
      const mine = plans.filter((p) => p.userId === u.id);
      return {
        id: u.id,
        name: `${u.firstName} ${u.lastName}`.trim(),
        role: u.role,
        title: u.staffProfile?.title ?? null,
        hasSchedule: scheduled.has(u.id),
        plans: mine,
        warnings: planWarnings({ plans: mine, hasSchedule: scheduled.has(u.id), todayYmd: options.today }),
      };
    }),
    viewer: { canEdit, userId: session.user.id, isOwner: session.user.role === "OWNER" },
  });
}
