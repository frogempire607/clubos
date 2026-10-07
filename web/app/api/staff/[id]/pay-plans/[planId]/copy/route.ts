import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { formatZodError } from "@/lib/zodErrors";
import { requirePermissionLive } from "@/lib/apiGuard";
import { selfRule, SELF_DENY_MESSAGE } from "@/lib/staffSelf";
import { actorFrom } from "@/lib/staffActivity";
import { isYmd } from "@/lib/payLedger";
import { copyPlan, getPlan, syncPayLines } from "@/lib/payLedgerServer";
import { payErrorResponse, recordPayChange } from "@/lib/payLedgerApi";

const schema = z.object({
  toUserIds: z.array(z.string().min(1)).min(1, "Choose who gets the copy.").max(50),
  name: z.string().trim().max(80).optional().nullable(),
  effectiveFrom: z.string().refine(isYmd, "Choose the date the copy starts."),
}).strict();

// POST /api/staff/[id]/pay-plans/[planId]/copy
// Copy ONE specific pay plan of staff member [id] to other staff (or to the
// same person, as a new version). Each copy is an independent plan.
// finances:full (live). Nobody can give THEMSELF a plan: a recipient who is
// the caller is refused (owners excepted).
export async function POST(req: Request, context: { params: Promise<{ id: string; planId: string }> }) {
  const { id, planId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  const clubId = session.user.clubId;

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err), code: "BAD_INPUT" }, { status: 400 });
    return NextResponse.json({ error: "Invalid request body", code: "BAD_INPUT" }, { status: 400 });
  }
  if (body.toUserIds.some((to) => selfRule(session.user.role, session.user.id, to, "edit_pay") === "deny")) {
    return NextResponse.json({ error: SELF_DENY_MESSAGE.edit_pay }, { status: 403 });
  }
  try {
    const cur = await getPlan(clubId, planId);
    if (cur.userId !== id) return NextResponse.json({ error: "Pay plan not found.", code: "NOT_FOUND" }, { status: 404 });
    const { source, copies } = await copyPlan({
      clubId, planId, toUserIds: body.toUserIds, name: body.name ?? null, effectiveFrom: body.effectiveFrom, byUserId: session.user.id ?? null,
    });
    for (const c of copies) {
      await recordPayChange({
        clubId, staffUserId: c.userId, ...actorFrom(session), action: "PAY_PLAN_COPIED",
        summary: `Added the pay plan "${c.name}" (copied from another plan)`, before: { copiedFromPlanId: source.id, fromStaffUserId: source.userId }, after: c,
      });
    }
    await syncPayLines(clubId, { userIds: copies.map((c) => c.userId) });
    return NextResponse.json({ ok: true, copies }, { status: 201 });
  } catch (err) {
    const res = payErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
