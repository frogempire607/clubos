// GET /api/members/[id]/communications
//
// 3G: member-profile Communications tab. Returns every EmailSend row
// that resolved to this member — either directly (recipientMemberId=X)
// or via the household guardian route (recipientMemberId=null but the
// selectedMember at compose time was one of the guardian's children;
// that case is a follow-up because it requires a join through the
// original sender's audience, which isn't stored per row).
//
// For now: recipientMemberId=X is authoritative. That covers PER_MEMBER,
// PER_ATHLETE_PRIMARY, and every non-HOUSEHOLD mode. HOUSEHOLD guardian
// sends WILL show under the guardian's own row when we implement the
// guardian-view of the tab in a later session.
//
// Never claim "opened" when tracking isn't available. Resend provides
// deliveredAt via webhook; openedAt / clickedAt stay null when the
// recipient's client didn't fire tracking pixels. UI reads the raw
// timestamps and renders the correct "Delivered / Opened / Clicked /
// tracking unavailable" state — see the client component.

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission, requireMessagesSubScope } from "@/lib/apiGuard";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "members", "view");
  if (denied) return denied;
  // Tighter gate: analytics scope. A coach without messages.analytics
  // shouldn't see who received what — that's PII across the club.
  const scopeDenied = requireMessagesSubScope(session, "analytics");
  if (scopeDenied) return scopeDenied;

  const member = await prisma.member.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
    select: { id: true, email: true, guardianEmail: true },
  });
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Rows keyed on this member OR the member's stored email (some old
  // transactional sends may have recipientEmail without recipientMemberId).
  const rows = await prisma.emailSend.findMany({
    where: {
      clubId: session.user.clubId,
      OR: [
        { recipientMemberId: member.id },
        ...(member.email ? [{ recipientEmail: member.email.toLowerCase() }] : []),
      ],
    },
    orderBy: { queuedAt: "desc" },
    take: 100,
    select: {
      id: true, kind: true, status: true,
      subject: true,
      recipientEmail: true, recipientMemberId: true, recipientUserId: true,
      fromName: true, fromEmail: true, replyTo: true,
      sentByUserId: true, relatedEventId: true, relatedMembershipId: true,
      announcementId: true, campaignId: true, templateId: true,
      providerMessageId: true,
      skippedReason: true, error: true,
      queuedAt: true, sentAt: true, deliveredAt: true, bouncedAt: true,
      openedAt: true, openCount: true, clickedAt: true, clickCount: true,
      // Store a small snippet for the timeline. The full HTML is on the
      // row too; the client asks for it via /body when the reader clicks
      // through — keeps the list payload small.
      bodyText: true,
    },
  });

  // Batch-resolve sender display names + related event/membership names
  // so the timeline can render "Sent by Julian" and "About Summer Camp".
  const senderIds = Array.from(new Set(rows.map((r) => r.sentByUserId).filter((v): v is string => !!v)));
  const eventIds = Array.from(new Set(rows.map((r) => r.relatedEventId).filter((v): v is string => !!v)));
  const membershipIds = Array.from(new Set(rows.map((r) => r.relatedMembershipId).filter((v): v is string => !!v)));

  const [senders, events, memberships] = await Promise.all([
    senderIds.length
      ? prisma.user.findMany({ where: { id: { in: senderIds } }, select: { id: true, firstName: true, lastName: true } })
      : Promise.resolve([]),
    eventIds.length
      ? prisma.event.findMany({ where: { id: { in: eventIds } }, select: { id: true, name: true } })
      : Promise.resolve([]),
    membershipIds.length
      ? prisma.membership.findMany({ where: { id: { in: membershipIds } }, select: { id: true, name: true } })
      : Promise.resolve([]),
  ]);
  const senderById = new Map(senders.map((u) => [u.id, `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim()]));
  const eventById = new Map(events.map((e) => [e.id, e.name]));
  const membershipById = new Map(memberships.map((m) => [m.id, m.name]));

  return NextResponse.json({
    memberId: member.id,
    sends: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      subject: r.subject,
      recipientEmail: r.recipientEmail,
      fromName: r.fromName,
      fromEmail: r.fromEmail,
      replyTo: r.replyTo,
      sentByUserId: r.sentByUserId,
      sentByName: r.sentByUserId ? senderById.get(r.sentByUserId) ?? null : null,
      relatedEventId: r.relatedEventId,
      relatedEventName: r.relatedEventId ? eventById.get(r.relatedEventId) ?? null : null,
      relatedMembershipId: r.relatedMembershipId,
      relatedMembershipName: r.relatedMembershipId ? membershipById.get(r.relatedMembershipId) ?? null : null,
      announcementId: r.announcementId,
      campaignId: r.campaignId,
      templateId: r.templateId,
      providerMessageId: r.providerMessageId,
      // Tracking flags — the UI reads these to decide what to render.
      // Never fabricate "opened" from status alone: openedAt IS the
      // truth flag, populated by Resend webhook when a tracking pixel
      // fires. SMTP-only sends and image-blocked recipients leave it
      // null forever, which the UI renders as "delivered · open tracking
      // unavailable" not "unopened".
      trackingCapable: r.providerMessageId != null, // Resend send == tracking possible
      queuedAt: r.queuedAt,
      sentAt: r.sentAt,
      deliveredAt: r.deliveredAt,
      bouncedAt: r.bouncedAt,
      openedAt: r.openedAt,
      openCount: r.openCount,
      clickedAt: r.clickedAt,
      clickCount: r.clickCount,
      skippedReason: r.skippedReason,
      error: r.error,
      // Truncated preview for the list; the reader modal fetches the
      // full body via /body when opened.
      bodyPreview: (r.bodyText ?? "").slice(0, 200),
    })),
  });
}
