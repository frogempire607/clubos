import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatZodError } from "@/lib/zodErrors";
import { requirePermissionLive } from "@/lib/apiGuard";
import { selfRule, SELF_DENY_MESSAGE } from "@/lib/staffSelf";
import { actorFrom } from "@/lib/staffActivity";
import { fmtCents } from "@/lib/payLedger";
import { setAssignmentOverride } from "@/lib/payLedgerServer";
import { payErrorResponse, recordPayChange } from "@/lib/payLedgerApi";

const schema = z.object({
  // dollars; null clears the override (back to the coach's own plan)
  amount: z.number().min(0).max(1_000_000).nullable(),
  reason: z.string().trim().max(500).optional().nullable(),
}).strict();

// PUT /api/classes/session-staff/[staffRowId]/pay-override
// Set what ONE coach is paid for ONE class day (e.g. a substitute paid the
// regular coach's rate), or clear it. Can be set before the class happens.
// Stored on that assignment with who/when/why; no pay plan is changed.
// finances:full (live); never your own class day. Refused once that day's
// pay line is paid or on a payout.
export async function PUT(req: Request, context: { params: Promise<{ staffRowId: string }> }) {
  const { staffRowId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  const clubId = session.user.clubId;
  const row = await prisma.classSessionStaff.findFirst({ where: { id: staffRowId, clubId }, select: { userId: true } });
  if (!row) return NextResponse.json({ error: "That class assignment was not found.", code: "NOT_FOUND" }, { status: 404 });
  if (selfRule(session.user.role, session.user.id, row.userId, "edit_pay") === "deny") {
    return NextResponse.json({ error: SELF_DENY_MESSAGE.edit_pay }, { status: 403 });
  }
  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err), code: "BAD_INPUT" }, { status: 400 });
    return NextResponse.json({ error: "Invalid request body", code: "BAD_INPUT" }, { status: 400 });
  }
  const cents = body.amount === null ? null : Math.round(body.amount * 100);
  try {
    const res = await setAssignmentOverride({ clubId, staffRowId, cents, reason: body.reason ?? null, byUserId: session.user.id ?? null });
    if (res.before !== res.after) {
      await recordPayChange({
        clubId, staffUserId: res.userId, ...actorFrom(session),
        action: cents === null ? "PAY_LINE_OVERRIDE_CLEARED" : "PAY_LINE_OVERRIDE_SET",
        summary: cents === null
          ? `Put ${res.className} on ${res.dateYmd} back to the pay plan's amount`
          : `Set the pay for ${res.className} on ${res.dateYmd} to ${fmtCents(cents)} — ${body.reason ?? ""}`,
        before: { staffRowId, overrideCents: res.before }, after: { staffRowId, overrideCents: res.after, reason: body.reason ?? null },
      });
    }
    return NextResponse.json({ ok: true, overrideCents: res.after });
  } catch (err) {
    const res = payErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
