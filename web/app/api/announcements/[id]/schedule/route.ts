// POST /api/announcements/[id]/schedule
//
// Schedules an announcement to send at `scheduledFor`. Uses the club's
// timezone (Club.timezone) for owner-visible display; the stored value
// is a UTC instant, so cron ticks compare against `now` directly.
//
// State model (plan §3H): DRAFT → SCHEDULED. A SCHEDULED row is picked
// up by the cron sweep at `scheduledFor <= now` and transitioned
// through SENDING → SENT by lib/announcementDispatch.
//
// Refusing to re-schedule a SENT / CANCELED / SENDING announcement so
// an owner can't accidentally re-fire something already dispatched.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission, requireMessagesSubScope } from "@/lib/apiGuard";

const schema = z.object({
  scheduledFor: z.string().datetime(),
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "messages", "send");
  if (denied) return denied;
  const scopeDenied = requireMessagesSubScope(session, "bulk");
  if (scopeDenied) return scopeDenied;

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const scheduledFor = new Date(data.scheduledFor);
  if (Number.isNaN(scheduledFor.getTime())) {
    return NextResponse.json({ error: "Invalid scheduled time." }, { status: 400 });
  }
  if (scheduledFor.getTime() <= Date.now()) {
    return NextResponse.json({ error: "Scheduled time must be in the future — use Send now for immediate dispatch." }, { status: 400 });
  }

  const existing = await prisma.announcement.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
    select: { id: true, status: true, sendBatchId: true },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (existing.sendBatchId) {
    return NextResponse.json({ error: "This announcement has already sent — create a new one to resend." }, { status: 409 });
  }
  if (!["DRAFT", "SCHEDULED"].includes(existing.status)) {
    return NextResponse.json(
      { error: `Cannot schedule an announcement in status ${existing.status}.` },
      { status: 409 },
    );
  }

  const updated = await prisma.announcement.update({
    where: { id: existing.id },
    data: {
      status: "SCHEDULED",
      scheduledFor,
      senderUserId: session.user.id,
    },
    select: { id: true, status: true, scheduledFor: true },
  });

  return NextResponse.json(updated);
}
