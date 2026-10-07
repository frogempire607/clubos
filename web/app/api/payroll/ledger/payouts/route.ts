import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { formatZodError } from "@/lib/zodErrors";
import { requirePermissionLive } from "@/lib/apiGuard";
import { selfRule, SELF_DENY_MESSAGE } from "@/lib/staffSelf";
import { actorFrom } from "@/lib/staffActivity";
import { PAYOUT_METHODS } from "@/lib/payouts";
import { fmtCents } from "@/lib/payLedger";
import { createLedgerPayout } from "@/lib/payLedgerServer";
import { payErrorResponse, recordPayChange } from "@/lib/payLedgerApi";

const schema = z.object({
  userId: z.string().min(1),
  lineIds: z.array(z.string().min(1)).min(1, "Choose at least one pay line.").max(2000),
  status: z.enum(["PAID", "PENDING"]).default("PAID"),
  method: z.enum(PAYOUT_METHODS).optional().nullable(),
  paidAt: z.string().optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
}).strict();

// POST /api/payroll/ledger/payouts — pay one staff member's chosen pay lines
// with ONE payout. The amount is exactly the lines' total; the lines are
// locked to the payout (PAID → locked for good; voiding the payout releases
// them). finances:full (live); never your own pay.
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
  const paidAt = body.paidAt ? new Date(body.paidAt) : null;
  if (paidAt && Number.isNaN(paidAt.getTime())) return NextResponse.json({ error: "The paid date isn't a valid date.", code: "BAD_INPUT" }, { status: 400 });
  if (body.status === "PAID" && !body.method) return NextResponse.json({ error: "Choose how it was paid.", code: "BAD_INPUT" }, { status: 400 });
  try {
    const res = await createLedgerPayout({
      clubId, userId: body.userId, lineIds: body.lineIds, paid: body.status === "PAID", method: body.method ?? null,
      paidAt, notes: body.notes ?? null, byUserId: session.user.id ?? null,
    });
    await recordPayChange({
      clubId, staffUserId: body.userId, ...actorFrom(session), action: "PAYROLL_PAYOUT_CREATED",
      summary: `${res.paid ? "Paid" : "Queued a payout of"} ${fmtCents(res.amountCents)} for ${res.lineCount} pay line${res.lineCount === 1 ? "" : "s"}`,
      after: { payoutId: res.payoutId, amount: res.amountCents / 100, lineIds: body.lineIds, paid: res.paid },
    });
    return NextResponse.json({ ok: true, ...res }, { status: 201 });
  } catch (err) {
    const res = payErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
