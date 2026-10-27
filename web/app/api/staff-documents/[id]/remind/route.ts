import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive } from "@/lib/apiGuard";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { baseUrlFromRequest } from "@/lib/baseUrl";
import { sendStaffDocumentReminderEmail } from "@/lib/email";
import { recordStaffActivity } from "@/lib/staffActivity";
import { StaffDocError, outstandingPeople } from "@/lib/staffDocumentsServer";

export const dynamic = "force-dynamic";
// One email per outstanding person, sent in sequence.
export const maxDuration = 60;

// POST /api/staff-documents/[id]/remind — nudge everyone who hasn't signed.
// documents:edit.
//
// In-app AND email, as asked: the in-app half is a staff-activity row on each
// person's record, which is the notification surface staff profiles already
// have, and the email is the one that reaches them when they aren't logged in.
//
// Rate-limited per document: a reminder is a nudge, and a button somebody can
// hold down becomes harassment.
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "documents", "edit");
  if (denied) return denied;

  const rl = rateLimit({ key: `staffdoc:remind:${params.id}`, limit: 3, windowMs: 60 * 60 * 1000 });
  if (!rl.allowed) {
    return rateLimitedResponse(
      rl,
      "That reminder has already gone out a few times this hour. Give people a chance to read it.",
    );
  }

  const clubId = session.user.clubId;
  try {
    const { doc, people } = await outstandingPeople(clubId, params.id);
    if (people.length === 0) {
      return NextResponse.json({ ok: true, reminded: 0, note: "Everyone has signed it already." });
    }

    const club = await prisma.club.findUnique({
      where: { id: clubId },
      select: { name: true, emailFromName: true, emailReplyTo: true },
    });
    // baseUrlFromRequest, not getAppBaseUrl: the link has to work on whatever
    // origin the owner is actually looking at, including a deploy preview.
    const signInUrl = `${baseUrlFromRequest(req)}/dashboard/my-account`;

    let reminded = 0;
    for (const p of people) {
      // The in-app half, on their own staff record. Written first, because it
      // is the half that cannot bounce.
      await recordStaffActivity({
        clubId,
        staffUserId: p.userId,
        kind: "DOCUMENTS",
        summary: `Reminder sent: "${doc.title}" is waiting for your signature.`,
        actorName: session.user.name ?? null,
        actorUserId: session.user.id ?? null,
      }).catch(() => null);

      if (!p.email) continue;
      // One failed address must not stop the rest of the list.
      await sendStaffDocumentReminderEmail({
        to: p.email,
        firstName: p.name.split(" ")[0] || p.name,
        clubName: club?.name ?? "your club",
        documents: [{ title: doc.title, dueDate: p.dueDate }],
        signInUrl,
        fromName: club?.emailFromName ?? null,
        replyTo: club?.emailReplyTo ?? null,
      }).catch(() => null);
      reminded += 1;
    }

    return NextResponse.json({ ok: true, reminded, outstanding: people.length });
  } catch (err) {
    if (err instanceof StaffDocError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
