// POST /api/announcements/[id]/cancel
//
// Cancels a DRAFT or SCHEDULED announcement so the cron sweep won't
// pick it up. Refuses SENDING (in-flight) and SENT (already delivered)
// — nothing to cancel there. Records the actor + timestamp for the
// audit trail.

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission, requireMessagesSubScope } from "@/lib/apiGuard";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "messages", "full");
  if (denied) return denied;
  const scopeDenied = requireMessagesSubScope(session, "bulk");
  if (scopeDenied) return scopeDenied;

  const existing = await prisma.announcement.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
    select: { id: true, status: true, sendBatchId: true },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (existing.sendBatchId || existing.status === "SENT") {
    return NextResponse.json({ error: "Already sent — cannot cancel." }, { status: 409 });
  }
  if (existing.status === "SENDING") {
    return NextResponse.json(
      { error: "Send is in progress — wait for it to finish, then delete or archive if needed." },
      { status: 409 },
    );
  }
  if (existing.status === "CANCELED") {
    return NextResponse.json({ ok: true, status: "CANCELED" });
  }

  const updated = await prisma.announcement.update({
    where: { id: existing.id },
    data: {
      status: "CANCELED",
      canceledAt: new Date(),
      canceledById: session.user.id,
      // Clear the schedule so a future edit doesn't accidentally re-arm
      // the cron sweep. Owner has to explicitly re-schedule.
      scheduledFor: null,
    },
    select: { id: true, status: true, canceledAt: true },
  });

  return NextResponse.json(updated);
}
