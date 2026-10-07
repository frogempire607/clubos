import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { formatZodError } from "@/lib/zodErrors";
import { requirePermissionLive } from "@/lib/apiGuard";
import { selfRule, SELF_DENY_MESSAGE } from "@/lib/staffSelf";
import { actorFrom } from "@/lib/staffActivity";
import { fmtCents, isYmd } from "@/lib/payLedger";
import { MANUAL_KINDS, addManualLine } from "@/lib/payLedgerServer";
import { payErrorResponse, recordPayChange } from "@/lib/payLedgerApi";

const schema = z.object({
  userId: z.string().min(1),
  kind: z.enum(MANUAL_KINDS),
  // dollars; an adjustment may be negative (it takes pay off)
  amount: z.number().min(-1_000_000).max(1_000_000),
  description: z.string().trim().min(1, "Say what this is for.").max(200),
  workDate: z.string().refine(isYmd, "Choose a date."),
}).strict();

// POST /api/payroll/lines — add a bonus or a manual adjustment for one staff
// member. finances:full (live); never your own pay. Dated on/after the
// ledger start date, never in the future.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err), code: "BAD_INPUT" }, { status: 400 });
    return NextResponse.json({ error: "Invalid request body", code: "BAD_INPUT" }, { status: 400 });
  }
  if (selfRule(session.user.role, session.user.id, body.userId, "edit_pay") === "deny") {
    return NextResponse.json({ error: SELF_DENY_MESSAGE.edit_pay }, { status: 403 });
  }
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  const clubId = session.user.clubId;
  const cents = Math.round(body.amount * 100);
  try {
    const made = await addManualLine({
      clubId, userId: body.userId, kind: body.kind, cents, description: body.description, workDate: body.workDate, byUserId: session.user.id ?? null,
    });
    await recordPayChange({
      clubId, staffUserId: body.userId, ...actorFrom(session), action: body.kind === "BONUS" ? "PAY_BONUS_ADDED" : "PAY_ADJUSTMENT_ADDED",
      summary: `Added a ${body.kind === "BONUS" ? "bonus" : "pay adjustment"} of ${fmtCents(cents)}: ${body.description}`,
      after: { lineId: made.id, kind: body.kind, amount: cents / 100, description: body.description, workDate: body.workDate },
    });
    return NextResponse.json({ ok: true, id: made.id }, { status: 201 });
  } catch (err) {
    const res = payErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
