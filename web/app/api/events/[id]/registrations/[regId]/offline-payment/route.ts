import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { settleEventRegistrationOffline } from "@/lib/eventOfflinePayments";

// POST /api/events/[id]/registrations/[regId]/offline-payment
// Staff records the physical cash/check an event registrant handed over — at
// check-in or before the event. This is the ONLY moment an offline event
// registration becomes revenue: the PENDING Transaction flips to SUCCEEDED,
// the registration flips to PAID, and the receipt goes out.
//
// The settlement itself lives in lib/eventOfflinePayments.settleEventRegistrationOffline
// — the single path shared with the Bookings at-the-door flow, so the same
// physical cash can only ever produce one Transaction no matter which screen
// staff used. This route is the permission gate and the request shape.

const schema = z.object({
  // Staff may correct cash↔check at receipt time (what actually arrived).
  // TERMINAL is the external card reader — recorded, never charged by us.
  method: z.enum(["CASH", "CHECK", "TERMINAL"]).optional(),
  // Check number or a short note.
  reference: z.string().max(120).optional().nullable(),
  // What was actually received; must equal the amount due.
  amountReceived: z.number().positive().optional(),
});

export async function POST(req: Request, context: { params: Promise<{ id: string; regId: string }> }) {
  const { id: eventId, regId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Money is money — same gate as recording a membership's cash/check.
  const denied = requirePermission(session, "billing", "full");
  if (denied) return denied;
  const clubId = session.user.clubId;

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const { method, reference, amountReceived } = parsed.data;

  // Default to whatever the registrant already declared, so the front desk
  // doesn't have to restate it.
  const reg = await prisma.eventRegistration.findFirst({
    where: { id: regId, eventId, clubId },
    select: { status: true, paymentMethod: true },
  });
  if (!reg) return NextResponse.json({ error: "Registration not found" }, { status: 404 });
  const finalMethod =
    method ?? (reg.paymentMethod === "CHECK" || reg.status === "AWAITING_CHECK" ? "CHECK" : "CASH");

  const result = await settleEventRegistrationOffline({
    clubId,
    registrationId: regId,
    method: finalMethod,
    reference,
    actorUserId: session.user.id ?? null,
    amountReceived: amountReceived ?? null,
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  return NextResponse.json({
    ok: true,
    registrationId: regId,
    status: "PAID",
    method: result.method,
    amountPaid: result.amount,
    transactionId: result.transactionId,
  });
}
