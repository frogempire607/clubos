import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermissionLive, requirePermissionLive } from "@/lib/apiGuard";
import { selfRule } from "@/lib/staffSelf";
import { clubTodayYmd } from "@/lib/classStaff";
import { isYmd, planWarnings } from "@/lib/payLedger";
import { getLedgerStart, listPlans, loadLedger, syncPayLines } from "@/lib/payLedgerServer";

export const dynamic = "force-dynamic";

// GET /api/payroll/ledger?from=YYYY-MM-DD&to=YYYY-MM-DD[&userId=]
// The pay ledger: every pay line with a work day in the range, per staff
// member, with the rate that priced it. finances:view (live) — or, with
// userId = yourself, your own lines (read-only).
// Brings the generated lines up to date first; nothing before the club's
// ledger start date is ever returned or written.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const userId = url.searchParams.get("userId");
  const isSelf = session.user.role === "STAFF" && !!userId && selfRule(session.user.role, session.user.id, userId, "view_pay") === "allow";
  if (!isSelf) {
    const denied = await requirePermissionLive(session, "finances", "view");
    if (denied) return denied;
  }
  const clubId = session.user.clubId;
  const [ledgerStart, club] = await Promise.all([
    getLedgerStart(clubId),
    prisma.club.findUnique({ where: { id: clubId }, select: { timezone: true } }),
  ]);
  const today = clubTodayYmd(club?.timezone ?? null);
  const canPay = !isSelf && (await hasPermissionLive(session, "finances", "full"));
  const viewer = { canEdit: canPay, userId: session.user.id, isOwner: session.user.role === "OWNER" };
  if (!ledgerStart) return NextResponse.json({ ledgerStart: null, today, from: null, to: null, coaches: [], notes: [], viewer });

  const qFrom = url.searchParams.get("from");
  const qTo = url.searchParams.get("to");
  if ((qFrom && !isYmd(qFrom)) || (qTo && !isYmd(qTo))) {
    return NextResponse.json({ error: "from and to must be dates like 2026-10-13.", code: "BAD_INPUT" }, { status: 400 });
  }
  // Never before the ledger start; a salary line is dated on its payday, so
  // the default range reaches a month ahead.
  const from = qFrom && qFrom > ledgerStart ? qFrom : ledgerStart;
  const to = qTo ?? new Date(Date.parse(`${today}T00:00:00Z`) + 32 * 86_400_000).toISOString().slice(0, 10);

  await syncPayLines(clubId, userId ? { userIds: [userId] } : {});
  const coaches = await loadLedger(clubId, { fromYmd: from, toYmd: to, userId });

  // Pay-setup notes per current staff member (salary with no pay schedule, …).
  const notes: { userId: string; name: string; warnings: string[] }[] = [];
  if (!isSelf) {
    const [staff, plans, schedules] = await Promise.all([
      prisma.user.findMany({
        where: { clubId, role: { in: ["OWNER", "STAFF"] }, deletedAt: null, ...(userId ? { id: userId } : {}) },
        select: { id: true, firstName: true, lastName: true },
        orderBy: { firstName: "asc" },
      }),
      listPlans(clubId, userId ? [userId] : undefined),
      prisma.staffPaySchedule.findMany({ where: { clubId, active: true }, select: { userId: true } }),
    ]);
    const scheduled = new Set(schedules.map((s) => s.userId));
    for (const u of staff) {
      const warnings = planWarnings({ plans: plans.filter((p) => p.userId === u.id), hasSchedule: scheduled.has(u.id), todayYmd: today });
      if (warnings.length > 0) notes.push({ userId: u.id, name: `${u.firstName} ${u.lastName}`.trim(), warnings });
    }
  }
  return NextResponse.json({ ledgerStart, today, from, to, coaches, notes, viewer });
}
