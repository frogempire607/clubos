// GET /api/announcements/[id]/results
//
// 3G — campaign-level results. Groups every EmailSend row that
// carries this announcementId and tallies delivery / open / click /
// bounce / fail / unsub. Never fabricates "opened" — a null openedAt
// stays "not yet" in the response, not 0.

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission, requireMessagesSubScope } from "@/lib/apiGuard";
import { tallyEmailSends, trackingCapableRatio } from "@/lib/emailResults";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "messages", "view");
  if (denied) return denied;
  const scopeDenied = requireMessagesSubScope(session, "analytics");
  if (scopeDenied) return scopeDenied;

  const announcement = await prisma.announcement.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
    select: {
      id: true, title: true, status: true, sentAt: true, scheduledFor: true,
      canceledAt: true, sendBatchId: true, householdMode: true,
      senderUserId: true, createdAt: true,
    },
  });
  if (!announcement) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // If the send hasn't happened yet there's nothing to tally.
  if (!announcement.sendBatchId) {
    return NextResponse.json({
      announcement,
      counts: null,
      rows: [],
      trackingCapableRatio: 0,
    });
  }

  const rows = await prisma.emailSend.findMany({
    where: { announcementId: announcement.id, clubId: session.user.clubId },
    orderBy: { queuedAt: "asc" },
    select: {
      id: true, status: true, skippedReason: true, error: true,
      recipientEmail: true, recipientMemberId: true,
      providerMessageId: true,
      queuedAt: true, sentAt: true, deliveredAt: true, bouncedAt: true,
      openedAt: true, openCount: true, clickedAt: true, clickCount: true,
    },
  });

  // Aggregate tally. plan §3N: "Never claim an email was opened when
  // tracking is unavailable or blocked." The counts reflect ROW STATE —
  // the UI is what disclaims the tracking gap. Shared with the batch
  // results endpoint so the two pages can't drift.
  const counts = tallyEmailSends(rows);

  return NextResponse.json({
    announcement,
    counts,
    trackingCapableRatio: trackingCapableRatio(counts),
    rows,
  });
}
