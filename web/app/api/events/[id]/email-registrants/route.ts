import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { loadEventAttendees } from "@/lib/eventAttendeesServer";
import { messageToBlocks, registrantRecipients } from "@/lib/eventFormAnswers";
import { renderEmail } from "@/lib/emailRender";
import { blocksToPlainText, type EmailBlock } from "@/lib/emailBlocks";
import { sendClubEmail } from "@/lib/sendClubEmail";
import { enqueueEmailSendRows, INLINE_DISPATCH_MAX, type EnqueueRow } from "@/lib/enqueueEmailSend";
import { buildUnsubscribeUrl } from "@/lib/unsubscribe";
import { publicClubLogoUrl } from "@/lib/clubLogo";
import { resolvePostalAddressLines } from "@/lib/emailPostalAddress";

// POST /api/events/[id]/email-registrants
//
// One email to everyone registered for an event, from the Attendees screen.
//   { audience: "paid" | "all", preview: true }                    → who it would reach
//   { audience, subject, message, clientKey }                      → send
//
// WHO: the Attendees ledger (loadEventAttendees), so this agrees with the list
// on screen. Removed rows (cancelled / declined registrations, cancelled
// bookings) are never included. A guest with no member profile is reached at
// the registration's own address. Each address gets ONE email however many
// athletes share it.
//
// HOW: lib/sendClubEmail, the same path as every other club email. kind BULK
// means the club's unsubscribe list is honoured and the message carries the
// one-click unsubscribe link. Every send writes an EmailSend row first
// (QUEUED), so a cut-off request is finished by /api/cron/email-queue, and
// (sendBatchId, dedupeKey) makes a double tap or a retry send nothing twice.
// Above INLINE_DISPATCH_MAX addresses the rows are only queued.
//
// Needs events:view (to see the list) and messages:send (to email families).
export const maxDuration = 60;

const schema = z.object({
  audience: z.enum(["paid", "all"]),
  preview: z.boolean().optional(),
  subject: z.string().trim().min(1).max(200).optional(),
  message: z.string().trim().min(1).max(10_000).optional(),
  clientKey: z.string().min(8).max(100).optional(),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const deniedView = requirePermission(session, "events", "view");
  if (deniedView) return deniedView;
  const deniedSend = requirePermission(session, "messages", "send");
  if (deniedSend) return deniedSend;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Check the subject and message and try again." }, { status: 400 });
  const body = parsed.data;

  const clubId = session.user.clubId;
  const payload = await loadEventAttendees(clubId, id);
  if (!payload) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const recipients = registrantRecipients(payload.ledger.rows, body.audience);
  const counts = {
    people: recipients.people,
    addresses: recipients.send.length,
    noEmail: recipients.noEmail.length,
  };
  if (body.preview) {
    return NextResponse.json({ ok: true, counts, noEmail: recipients.noEmail.slice(0, 50) });
  }

  if (!body.subject || !body.message) {
    return NextResponse.json({ error: "Write a subject and a message first." }, { status: 400 });
  }
  if (recipients.send.length === 0) {
    return NextResponse.json({ error: "Nobody in that group has an email address on file." }, { status: 400 });
  }

  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: {
      id: true, name: true, primaryColor: true, logoUrl: true,
      contactEmail: true, contactPhone: true, websiteUrl: true, hoursOfOperation: true,
      publicEmail: true, publicPhone: true,
      mailingAddress: true, mailingAddress2: true, mailingCity: true,
      mailingState: true, mailingZip: true, mailingCountry: true,
      emailFromName: true, emailReplyTo: true,
    },
  });
  if (!club) return NextResponse.json({ error: "Club not found." }, { status: 404 });

  const blocks = messageToBlocks(body.message) as EmailBlock[];
  if (blocks.length === 0) return NextResponse.json({ error: "Write a message first." }, { status: 400 });
  const bodyText = blocksToPlainText(blocks);
  const fromName = club.emailFromName ?? club.name;
  const replyTo = club.emailReplyTo ?? club.contactEmail ?? undefined;
  // Deterministic when the screen sends its key, so a retry of the same tap
  // lands on the same batch and the unique index refuses the second copy.
  const sendBatchId = `eventmail-${payload.event.id}-${body.clientKey ?? crypto.randomUUID()}`;

  const render = (unsubscribeUrl: string) =>
    renderEmail(blocks, {
      clubName: club.name,
      clubLogoUrl: publicClubLogoUrl(club.id, club.logoUrl),
      clubContact: {
        email: club.publicEmail ?? club.contactEmail,
        phone: club.publicPhone ?? club.contactPhone,
        website: club.websiteUrl,
        address: null,
      },
      club,
      unsubscribeUrl,
      postalAddress: resolvePostalAddressLines(club),
      accentColor: club.primaryColor,
    });

  const results = { sent: 0, queued: 0, skipped: 0, duplicate: 0, failed: 0 };
  const failures: { email: string; error: string }[] = [];

  if (recipients.send.length > INLINE_DISPATCH_MAX) {
    const rows: EnqueueRow[] = [];
    for (const r of recipients.send) {
      const unsubscribeUrl = buildUnsubscribeUrl(club.id, r.email);
      const rendered = await render(unsubscribeUrl);
      rows.push({
        kind: "BULK",
        recipientEmail: r.email,
        recipientMemberId: r.memberId,
        subject: body.subject,
        bodyHtml: rendered.html,
        bodyText: rendered.text || bodyText,
        bodyJson: blocks,
        fromName,
        replyTo,
        sendBatchId,
        dedupeKey: `eventmail:${r.email}`,
        idempotencyKey: body.clientKey ?? null,
        sentByUserId: session.user.id,
        relatedEventId: payload.event.id,
        listUnsubscribeUrl: unsubscribeUrl,
      });
    }
    const enq = await enqueueEmailSendRows(club.id, rows);
    results.queued = enq.enqueued;
    results.duplicate = enq.duplicate;
    results.failed = enq.failed;
    failures.push(...enq.failures);
  } else {
    for (const r of recipients.send) {
      const unsubscribeUrl = buildUnsubscribeUrl(club.id, r.email);
      const rendered = await render(unsubscribeUrl);
      const res = await sendClubEmail({
        clubId: club.id,
        kind: "BULK",
        recipientEmail: r.email,
        recipientMemberId: r.memberId,
        subject: body.subject,
        bodyHtml: rendered.html,
        bodyText: rendered.text || bodyText,
        bodyJson: blocks,
        fromName,
        replyTo,
        sendBatchId,
        dedupeKey: `eventmail:${r.email}`,
        idempotencyKey: body.clientKey ?? null,
        sentByUserId: session.user.id,
        relatedEventId: payload.event.id,
        listUnsubscribeUrl: unsubscribeUrl,
      });
      if (res.status === "SENT") results.sent++;
      else if (res.status === "SKIPPED") results.skipped++;
      else if (res.status === "DUPLICATE") results.duplicate++;
      else {
        results.failed++;
        failures.push({ email: r.email, error: res.error ?? "unknown" });
      }
    }
  }

  return NextResponse.json({ ok: true, sendBatchId, counts, results, noEmail: recipients.noEmail.slice(0, 50), failures: failures.slice(0, 50) });
}
