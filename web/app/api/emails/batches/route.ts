// GET /api/emails/batches
//
// Every email send this club has made, grouped by sendBatchId — the
// missing half of 3G. Announcement sends already had a results page
// keyed on announcementId; a bulk send from the Members tab creates no
// Announcement at all, so 77 emails went out and landed nowhere a human
// could look at them. This is that page's data.
//
// Rows without a sendBatchId (one-off transactional mail — receipts,
// password resets) are deliberately excluded: they are per-member
// history, already visible on the member profile Communications tab.

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission, requireMessagesSubScope } from "@/lib/apiGuard";
import { tallyEmailSends, batchState, type TallyRow } from "@/lib/emailResults";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "messages", "view");
  if (denied) return denied;
  const scopeDenied = requireMessagesSubScope(session, "analytics");
  if (scopeDenied) return scopeDenied;

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);

  // Newest batches first. Grab the batch ids off the most recent rows
  // rather than paging every send row in the club's history.
  const recent = await prisma.emailSend.findMany({
    where: { clubId: session.user.clubId, sendBatchId: { not: null } },
    orderBy: { queuedAt: "desc" },
    distinct: ["sendBatchId"],
    take: limit,
    select: {
      sendBatchId: true,
      subject: true,
      kind: true,
      queuedAt: true,
      announcementId: true,
      campaignId: true,
      sentByUserId: true,
      fromName: true,
    },
  });

  const batchIds = recent.map((r) => r.sendBatchId!).filter(Boolean);
  if (batchIds.length === 0) return NextResponse.json({ batches: [] });

  // One pass over the member rows of those batches. Only the columns the
  // tally reads — the bodies are large and none of them are rendered here.
  const rows = await prisma.emailSend.findMany({
    where: { clubId: session.user.clubId, sendBatchId: { in: batchIds } },
    select: {
      sendBatchId: true,
      status: true,
      skippedReason: true,
      providerMessageId: true,
      sentAt: true,
      deliveredAt: true,
      bouncedAt: true,
      openedAt: true,
      clickedAt: true,
      queuedAt: true,
    },
  });

  const byBatch = new Map<string, (TallyRow & { queuedAt: Date })[]>();
  for (const r of rows) {
    const key = r.sendBatchId!;
    const list = byBatch.get(key);
    if (list) list.push(r as never);
    else byBatch.set(key, [r as never]);
  }

  // Resolve sender names in one query rather than per batch.
  const senderIds = Array.from(
    new Set(recent.map((r) => r.sentByUserId).filter((v): v is string => !!v)),
  );
  const senders = senderIds.length
    ? await prisma.user.findMany({
        where: { id: { in: senderIds }, clubId: session.user.clubId },
        select: { id: true, firstName: true, lastName: true, email: true },
      })
    : [];
  const senderName = new Map(
    senders.map((u) => [
      u.id,
      [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email,
    ]),
  );

  const batches = recent.map((head) => {
    const group = byBatch.get(head.sendBatchId!) ?? [];
    const counts = tallyEmailSends(group);
    const stamps = group.map((r) => new Date(r.queuedAt).getTime());
    return {
      sendBatchId: head.sendBatchId!,
      subject: head.subject,
      kind: head.kind,
      announcementId: head.announcementId,
      campaignId: head.campaignId,
      fromName: head.fromName,
      sentByUserId: head.sentByUserId,
      sentByName: head.sentByUserId ? senderName.get(head.sentByUserId) ?? null : null,
      startedAt: stamps.length ? new Date(Math.min(...stamps)).toISOString() : null,
      lastActivityAt: stamps.length ? new Date(Math.max(...stamps)).toISOString() : null,
      counts,
      state: batchState(counts),
    };
  });

  return NextResponse.json({ batches });
}
