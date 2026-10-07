import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatZodError } from "@/lib/zodErrors";
import { requireOwnerLive } from "@/lib/apiGuard";
import { writeBillingAudit } from "@/lib/billingAudit";
import { clubTodayYmd, ymdToDate } from "@/lib/classStaff";
import { isYmd } from "@/lib/payLedger";
import { getLedgerStart } from "@/lib/payLedgerServer";

const schema = z.object({ date: z.string().refine(isYmd, "Choose a date.") }).strict();

// POST /api/settings/schedule/pay-ledger — OWNER only (verified live).
// Start the pay ledger for this club on a date. Set ONCE: the date decides
// which work gets saved pay lines and is never moved afterwards (moving it
// would create or orphan lines). It can't be in the past — nothing that has
// already happened is ever turned into pay lines — and the club must already
// be on the new coach assignments, on or before that date.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requireOwnerLive(session);
  if (denied) return denied;
  const clubId = session.user.clubId;
  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err), code: "BAD_INPUT" }, { status: 400 });
    return NextResponse.json({ error: "Invalid request body", code: "BAD_INPUT" }, { status: 400 });
  }
  const existing = await getLedgerStart(clubId);
  if (existing) return NextResponse.json({ error: `The pay ledger already starts on ${existing}. That date can't be changed.`, code: "ALREADY_SET" }, { status: 409 });
  const [settings, club] = await Promise.all([
    prisma.clubScheduleSettings.findUnique({ where: { clubId }, select: { assignmentsStartOn: true } }),
    prisma.club.findUnique({ where: { id: clubId }, select: { timezone: true } }),
  ]);
  const today = clubTodayYmd(club?.timezone ?? null);
  const assignments = settings?.assignmentsStartOn ? settings.assignmentsStartOn.toISOString().slice(0, 10) : null;
  if (!assignments) return NextResponse.json({ error: "Turn on the new coach assignments first — pay lines are built from them.", code: "NOT_SWITCHED_ON" }, { status: 409 });
  if (body.date < today) return NextResponse.json({ error: "The pay ledger can't start in the past.", code: "BAD_INPUT" }, { status: 400 });
  if (body.date < assignments) return NextResponse.json({ error: `The pay ledger can't start before coach assignments did (${assignments}).`, code: "BAD_INPUT" }, { status: 400 });
  await prisma.clubScheduleSettings.update({ where: { clubId }, data: { payLedgerStartsOn: ymdToDate(body.date), updatedByUserId: session.user.id } });
  await writeBillingAudit({ clubId, actorUserId: session.user.id ?? null, action: "PAY_LEDGER_STARTED", after: { payLedgerStartsOn: body.date }, note: `The pay ledger starts on ${body.date}.` });
  return NextResponse.json({ ok: true, payLedgerStartsOn: body.date });
}
