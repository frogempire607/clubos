import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatZodError } from "@/lib/zodErrors";
import { requirePermissionLive } from "@/lib/apiGuard";
import { selfRule, SELF_DENY_MESSAGE } from "@/lib/staffSelf";
import { actorFrom } from "@/lib/staffActivity";
import { fmtCents, isYmd } from "@/lib/payLedger";
import { editManualLine, setLineOverride, voidManualLine } from "@/lib/payLedgerServer";
import { payErrorResponse, recordPayChange } from "@/lib/payLedgerApi";

const schema = z.discriminatedUnion("action", [
  // Pay THIS line a set amount (a class day, a salary period, a plan bonus). The plan is not changed.
  z.object({ action: z.literal("override"), amount: z.number().min(0).max(1_000_000), reason: z.string().trim().min(1, "Say why this is paid differently.").max(500) }).strict(),
  z.object({ action: z.literal("clearOverride") }).strict(),
  // A bonus / adjustment that was added by hand.
  z.object({
    action: z.literal("edit"), amount: z.number().min(-1_000_000).max(1_000_000),
    description: z.string().trim().min(1).max(200), workDate: z.string().refine(isYmd, "Choose a date."),
  }).strict(),
  z.object({ action: z.literal("void"), reason: z.string().trim().min(1, "Say why this is being removed.").max(500) }).strict(),
]);

// PATCH /api/payroll/lines/[lineId] — change ONE unpaid pay line:
//   override / clearOverride   a generated line (the override has a reason and
//                              the name of who set it; the plan amount is kept)
//   edit / void                a bonus or adjustment added by hand
// finances:full (live); never a line of your own. A paid line, or one on a
// payout, is locked (409 LOCKED).
export async function PATCH(req: Request, context: { params: Promise<{ lineId: string }> }) {
  const { lineId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  const clubId = session.user.clubId;
  const line = await prisma.payLine.findFirst({ where: { id: lineId, clubId }, select: { id: true, userId: true } });
  if (!line) return NextResponse.json({ error: "Pay line not found.", code: "NOT_FOUND" }, { status: 404 });
  if (selfRule(session.user.role, session.user.id, line.userId, "edit_pay") === "deny") {
    return NextResponse.json({ error: SELF_DENY_MESSAGE.edit_pay }, { status: 403 });
  }

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err), code: "BAD_INPUT" }, { status: 400 });
    return NextResponse.json({ error: "Invalid request body", code: "BAD_INPUT" }, { status: 400 });
  }
  const who = { clubId, staffUserId: line.userId, ...actorFrom(session) };
  const byUserId = session.user.id ?? null;
  try {
    if (body.action === "override") {
      const cents = Math.round(body.amount * 100);
      const res = await setLineOverride({ clubId, lineId, cents, reason: body.reason, byUserId });
      await recordPayChange({
        ...who, action: "PAY_LINE_OVERRIDE_SET",
        summary: `Set the pay for "${res.description}" to ${fmtCents(cents)} — ${body.reason}`,
        before: { lineId, overrideCents: res.before }, after: { lineId, staffRowId: res.staffRowId ?? null, overrideCents: cents, reason: body.reason },
      });
    } else if (body.action === "clearOverride") {
      const res = await setLineOverride({ clubId, lineId, cents: null, byUserId });
      if (res.before !== null) {
        await recordPayChange({
          ...who, action: "PAY_LINE_OVERRIDE_CLEARED", summary: `Put "${res.description}" back to the pay plan's amount`,
          before: { lineId, overrideCents: res.before }, after: { lineId, staffRowId: res.staffRowId ?? null, overrideCents: null },
        });
      }
    } else if (body.action === "edit") {
      const cents = Math.round(body.amount * 100);
      const res = await editManualLine({ clubId, lineId, cents, description: body.description, workDate: body.workDate });
      await recordPayChange({ ...who, action: "PAY_MANUAL_LINE_EDITED", summary: `Changed "${res.after.description}" to ${fmtCents(cents)}`, before: res.before, after: res.after });
    } else {
      const res = await voidManualLine({ clubId, lineId, reason: body.reason, byUserId });
      await recordPayChange({
        ...who, action: "PAY_MANUAL_LINE_VOIDED", summary: `Removed "${res.description}" (${fmtCents(res.cents)}) — ${body.reason}`,
        before: { lineId, amount: res.cents === null ? null : res.cents / 100, description: res.description }, after: { lineId, status: "VOID", reason: body.reason },
      });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const res = payErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
