import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { formatZodError } from "@/lib/zodErrors";
import { requirePermissionLive } from "@/lib/apiGuard";
import { selfRule, SELF_DENY_MESSAGE } from "@/lib/staffSelf";
import { actorFrom } from "@/lib/staffActivity";
import { archivePlan, getPlan, syncPayLines, updatePlan } from "@/lib/payLedgerServer";
import { payErrorResponse, planInputSchema, recordPayChange, toPlanInput } from "@/lib/payLedgerApi";

// PATCH /api/staff/[id]/pay-plans/[planId] — edit a pay plan IN PLACE.
// finances:full (live); never your own pay. Unpaid pay lines the plan priced
// are re-priced; paid lines never change.
export async function PATCH(req: Request, context: { params: Promise<{ id: string; planId: string }> }) {
  const { id, planId } = await context.params;
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
    // The plan must be THIS staff member's (the self rule above was judged on `id`).
    const cur = await getPlan(clubId, planId);
    if (cur.userId !== id) return NextResponse.json({ error: "Pay plan not found.", code: "NOT_FOUND" }, { status: 404 });
    const { before, after } = await updatePlan({ clubId, planId, input: toPlanInput(body) });
    await recordPayChange({
      clubId, staffUserId: id, ...actorFrom(session), action: "PAY_PLAN_UPDATED",
      summary: `Changed the pay plan "${after.name}"`, before, after,
    });
    await syncPayLines(clubId, { userIds: [id] });
    return NextResponse.json({ ok: true, plan: after });
  } catch (err) {
    const res = payErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

// DELETE /api/staff/[id]/pay-plans/[planId] — remove a plan from use.
// It is archived, not deleted: pay lines keep the plan that priced them.
// finances:full (live); never your own pay.
export async function DELETE(_req: Request, context: { params: Promise<{ id: string; planId: string }> }) {
  const { id, planId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (selfRule(session.user.role, session.user.id, id, "edit_pay") === "deny") {
    return NextResponse.json({ error: SELF_DENY_MESSAGE.edit_pay }, { status: 403 });
  }
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  const clubId = session.user.clubId;
  try {
    const cur = await getPlan(clubId, planId);
    if (cur.userId !== id) return NextResponse.json({ error: "Pay plan not found.", code: "NOT_FOUND" }, { status: 404 });
    const after = await archivePlan({ clubId, planId });
    if (!cur.archived) {
      await recordPayChange({
        clubId, staffUserId: id, ...actorFrom(session), action: "PAY_PLAN_ARCHIVED",
        summary: `Removed the pay plan "${cur.name}"`, before: cur, after,
      });
      await syncPayLines(clubId, { userIds: [id] });
    }
    return NextResponse.json({ ok: true, plan: after });
  } catch (err) {
    const res = payErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
