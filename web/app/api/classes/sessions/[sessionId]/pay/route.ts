import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { hasPermissionLive, isOwnerLive, requirePermissionLive } from "@/lib/apiGuard";
import { loadDayPay } from "@/lib/payLedgerServer";

export const dynamic = "force-dynamic";

// GET /api/classes/sessions/[sessionId]/pay  (finances:view, live)
// "Pay for this day" on the class-day sheet: what each coach's own plan pays
// for this class day, any one-day override (amount, reason, who, when) and
// its history. Writing is PUT /api/classes/session-staff/[id]/pay-override
// (finances:full, never your own class day) — `canEdit` on each row says
// whether the caller may.
export async function GET(_req: Request, context: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "view");
  if (denied) return denied;
  const data = await loadDayPay(session.user.clubId, sessionId);
  if (!data) return NextResponse.json({ error: "Class day not found", code: "NOT_FOUND" }, { status: 404 });
  const [full, owner] = await Promise.all([hasPermissionLive(session, "finances", "full"), isOwnerLive(session)]);
  return NextResponse.json({
    ...data,
    rows: data.rows.map((r) => ({
      ...r,
      // Nobody sets their own pay (owners excepted); a paid line is locked; only ledger days can be set.
      canEdit: full && data.onLedger && !r.locked && r.payable && (owner || r.userId !== session.user.id),
    })),
  });
}
