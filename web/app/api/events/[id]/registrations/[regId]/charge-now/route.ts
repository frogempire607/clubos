import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive } from "@/lib/apiGuard";
import { chargeEventRegistration } from "@/lib/eventAutoCharge";

// POST /api/events/[id]/registrations/[regId]/charge-now
//
// The Attendees screen's "Charge now" (B11 slice 3). Runs the SAME event-day
// charge the lazy sweep and /api/cron/event-charges run —
// lib/eventAutoCharge.chargeEventRegistration, with its idempotency, receipt,
// audit and single VERIFIED Transaction — for one registration whose charge
// date has ARRIVED but that no sweep has reached yet (the sweep on opening a
// roster is capped at three).
//
// Never early. The family consented to a charge on the event's charge date;
// charging before it is a different agreement, so a future-dated charge is a
// refusal here, not a shortcut.
export const maxDuration = 60;

export async function POST(_req: Request, context: { params: Promise<{ id: string; regId: string }> }) {
  const { id: eventId, regId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Charges a real card — the same bar as recording money.
  const denied = await requirePermissionLive(session, "billing", "full");
  if (denied) return denied;

  const reg = await prisma.eventRegistration.findFirst({
    where: { id: regId, eventId, clubId: session.user.clubId },
    select: { id: true, status: true, scheduledChargeAt: true },
  });
  if (!reg) return NextResponse.json({ error: "Registration not found" }, { status: 404 });
  if (reg.status !== "SCHEDULED") {
    return NextResponse.json({ error: "There's no scheduled card charge on this registration." }, { status: 409 });
  }
  if (!reg.scheduledChargeAt || reg.scheduledChargeAt.getTime() > Date.now()) {
    return NextResponse.json(
      { error: "Their card is set to be charged on the event's charge date — it can't be charged before then." },
      { status: 409 },
    );
  }

  const result = await chargeEventRegistration(reg.id);
  if (result.outcome === "succeeded") return NextResponse.json({ ok: true, outcome: result.outcome });
  if (result.outcome === "processing") {
    return NextResponse.json({ ok: true, outcome: result.outcome, message: "The charge is processing — it will show as paid once the bank confirms." });
  }
  return NextResponse.json(
    { error: result.error || `The charge didn't go through (${result.outcome}).`, outcome: result.outcome },
    { status: result.outcome === "skipped" ? 409 : 402 },
  );
}
