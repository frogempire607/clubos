import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";

// POST /api/attendance/charge
// Record attendance + a non-Stripe payment for a (possibly non-member /
// PROSPECT) attendee: drop-in, trial, guest, non-member fee, custom charge.
// Methods handled here never require Stripe:
//   CASH    → recorded as collected (Transaction SUCCEEDED, method CASH)
//   COMP    → free / comped (Transaction SUCCEEDED, method COMP — tracked
//             separately, never counted as revenue)
//   INVOICE → unpaid invoice (Transaction PENDING, method INVOICE)
// Card payments still go through the existing Stripe charge route.
const schema = z.object({
  classSessionId: z.string().optional().nullable(),
  eventId: z.string().optional().nullable(),
  memberId: z.string().min(1),
  status: z.enum(["PRESENT", "TRIAL", "DROP_IN"]).default("DROP_IN"),
  paymentMethod: z.enum(["CASH", "COMP", "INVOICE"]),
  amount: z.number().min(0),
  category: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  legalEntityId: z.string().optional().nullable(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "attendance", "edit");
  if (denied) return denied;

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }
  if (!data.classSessionId && !data.eventId) {
    return NextResponse.json({ error: "classSessionId or eventId required" }, { status: 400 });
  }
  if (data.paymentMethod !== "COMP" && data.amount <= 0) {
    return NextResponse.json({ error: "Enter an amount, or choose Comp / Free." }, { status: 400 });
  }

  const clubId = session.user.clubId;

  const member = await prisma.member.findFirst({
    where: { id: data.memberId, clubId, deletedAt: null },
    select: { id: true, firstName: true, lastName: true },
  });
  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

  // Resolve context label + default revenue category.
  let contextName = "";
  let category = data.category || null;
  if (data.classSessionId) {
    const cs = await prisma.classSession.findFirst({
      where: { id: data.classSessionId, clubId },
      include: { recurringClass: { select: { name: true } } },
    });
    if (!cs) return NextResponse.json({ error: "Class session not found" }, { status: 404 });
    contextName = cs.recurringClass?.name ?? "Class";
    category = category || "classes";
  } else if (data.eventId) {
    const ev = await prisma.event.findFirst({
      where: { id: data.eventId, clubId, deletedAt: null },
      select: { name: true },
    });
    if (!ev) return NextResponse.json({ error: "Event not found" }, { status: 404 });
    contextName = ev.name;
    category = category || "events";
  }

  const memberName = `${member.firstName} ${member.lastName}`.trim();
  const now = new Date();

  // Upsert the attendance record (one per attendee per session/event).
  const existing = await prisma.attendanceRecord.findFirst({
    where: {
      memberId: member.id,
      ...(data.classSessionId ? { classSessionId: data.classSessionId } : {}),
      ...(data.eventId ? { eventId: data.eventId } : {}),
    },
    select: { id: true, checkedInAt: true },
  });
  const recordData = {
    status: data.status,
    notes: data.notes ?? null,
    paymentMethod: data.paymentMethod,
    amountCharged: data.amount,
    checkedInAt: existing?.checkedInAt ?? now,
    addedById: session.user.id,
  };
  const record = existing
    ? await prisma.attendanceRecord.update({ where: { id: existing.id }, data: recordData })
    : await prisma.attendanceRecord.create({
        data: {
          clubId,
          classSessionId: data.classSessionId ?? null,
          eventId: data.eventId ?? null,
          memberId: member.id,
          ...recordData,
        },
      });

  // Authoritative money record. Comp/cash settle now; invoice is outstanding.
  const txStatus = data.paymentMethod === "INVOICE" ? "PENDING" : "SUCCEEDED";
  const label =
    data.paymentMethod === "COMP" ? "Comped" : data.paymentMethod === "INVOICE" ? "Invoice" : "Cash payment";
  await prisma.transaction.create({
    data: {
      clubId,
      memberId: member.id,
      amount: data.amount,
      status: txStatus,
      type: data.classSessionId ? "CLASS" : "EVENT",
      category,
      paymentMethod: data.paymentMethod,
      legalEntityId: data.legalEntityId || null,
      source: memberName,
      description: `${label} — ${memberName}${contextName ? ` — ${contextName}` : ""}`,
      notes: data.notes || null,
      manual: true,
      txDate: now,
    },
  });

  return NextResponse.json({ ok: true, record });
}
