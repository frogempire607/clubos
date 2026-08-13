// GET /api/emails/batches/[batchId]
//
// One send, recipient by recipient. Same tally as the announcement
// results page (shared via lib/emailResults) so the two surfaces can
// never disagree about what "delivered" means.

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission, requireMessagesSubScope } from "@/lib/apiGuard";
import { tallyEmailSends, trackingCapableRatio, batchState } from "@/lib/emailResults";

export async function GET(_req: Request, { params }: { params: { batchId: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "messages", "view");
  if (denied) return denied;
  const scopeDenied = requireMessagesSubScope(session, "analytics");
  if (scopeDenied) return scopeDenied;

  const rows = await prisma.emailSend.findMany({
    where: { sendBatchId: params.batchId, clubId: session.user.clubId },
    orderBy: { queuedAt: "asc" },
    select: {
      id: true, status: true, skippedReason: true, error: true,
      recipientEmail: true, recipientMemberId: true,
      subject: true, kind: true, fromName: true, sentByUserId: true,
      announcementId: true, campaignId: true,
      providerMessageId: true,
      queuedAt: true, sentAt: true, deliveredAt: true, bouncedAt: true,
      openedAt: true, openCount: true, clickedAt: true, clickCount: true,
    },
  });

  if (rows.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const counts = tallyEmailSends(rows);
  const head = rows[0];

  // Recipient names, so the table reads "Kellan Lister" and not just an
  // address. Members deleted since the send simply stay email-only —
  // the send row is history and must survive the member row.
  const memberIds = Array.from(
    new Set(rows.map((r) => r.recipientMemberId).filter((v): v is string => !!v)),
  );
  const members = memberIds.length
    ? await prisma.member.findMany({
        where: { id: { in: memberIds }, clubId: session.user.clubId },
        select: { id: true, firstName: true, lastName: true },
      })
    : [];
  const memberName = new Map(
    members.map((m) => [m.id, `${m.firstName} ${m.lastName}`.trim()]),
  );

  let sentByName: string | null = null;
  if (head.sentByUserId) {
    const u = await prisma.user.findFirst({
      where: { id: head.sentByUserId, clubId: session.user.clubId },
      select: { firstName: true, lastName: true, email: true },
    });
    if (u) sentByName = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email;
  }

  const stamps = rows.map((r) => r.queuedAt.getTime());

  return NextResponse.json({
    batch: {
      sendBatchId: params.batchId,
      subject: head.subject,
      kind: head.kind,
      fromName: head.fromName,
      announcementId: head.announcementId,
      campaignId: head.campaignId,
      sentByUserId: head.sentByUserId,
      sentByName,
      startedAt: new Date(Math.min(...stamps)).toISOString(),
      lastActivityAt: new Date(Math.max(...stamps)).toISOString(),
    },
    counts,
    state: batchState(counts),
    trackingCapableRatio: trackingCapableRatio(counts),
    rows: rows.map((r) => ({
      ...r,
      recipientName: r.recipientMemberId ? memberName.get(r.recipientMemberId) ?? null : null,
    })),
  });
}
