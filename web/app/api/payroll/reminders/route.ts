import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermissionLive } from "@/lib/apiGuard";
import { loadClubReminders } from "@/lib/payReminders";

// GET /api/payroll/reminders  (finances:view)
// Paydays that need the owner — upcoming (≤ 2 days), due today, or overdue up
// to 30 days and not yet settled by a PAYROLL payout — with the Payroll
// page's estimate for each pay period. Also returns every schedule (for "next
// payday") and the staff who have none (for the "set a pay schedule" hint).
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "view");
  if (denied) return denied;
  const data = await loadClubReminders(session.user.clubId);
  // What the Payroll page may offer: Mark paid needs finances:full, and never
  // on your own pay unless you're the owner (mark-paid enforces both).
  const canMarkPaid = (await requirePermissionLive(session, "finances", "full")) === null;
  return NextResponse.json({
    ...data,
    viewer: { canMarkPaid, userId: session.user.id, isOwner: session.user.role === "OWNER" },
  });
}
