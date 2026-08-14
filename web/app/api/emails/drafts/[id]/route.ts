// GET    /api/emails/drafts/[id] — load a draft back into the composer
// DELETE /api/emails/drafts/[id] — discard it (soft delete, like every
//                                  other Announcement removal)

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission, requireMessagesSubScope } from "@/lib/apiGuard";
import { readPickedAudience, draftIsEditable, notEditableReason } from "@/lib/emailDrafts";

async function guard() {
  const session = await getServerSession(authOptions);
  if (!session) return { session: null, denied: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const denied = requirePermission(session, "messages", "send");
  if (denied) return { session, denied };
  const scopeDenied = requireMessagesSubScope(session, "bulk");
  if (scopeDenied) return { session, denied: scopeDenied };
  return { session, denied: null };
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const { session, denied } = await guard();
  if (denied || !session) return denied!;

  const row = await prisma.announcement.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
    select: {
      id: true, title: true, previewText: true, bodyJson: true, body: true,
      householdMode: true, audienceFilters: true, status: true,
      fromName: true, replyTo: true, updatedAt: true,
    },
  });
  if (!row) return NextResponse.json({ error: "Draft not found." }, { status: 404 });

  const memberIds = readPickedAudience(row.audienceFilters);
  if (!memberIds) {
    // Refuse rather than hand back an empty selection that would look like
    // "0 recipients" and invite the sender to re-pick from scratch without
    // realising the original audience was rule-driven.
    return NextResponse.json(
      {
        error: "This message targets a saved audience, not a hand-picked list. Edit it under Announcements.",
        code: "NOT_A_PICKED_LIST",
      },
      { status: 409 },
    );
  }

  // Members deleted since the draft was saved must not reappear as
  // recipients. Re-resolving here means the count the composer shows is the
  // count that would actually be sent.
  const live = await prisma.member.findMany({
    where: { id: { in: memberIds }, clubId: session.user.clubId, deletedAt: null },
    select: { id: true },
  });
  const liveIds = live.map((m) => m.id);

  return NextResponse.json({
    draft: {
      id: row.id,
      subject: row.title === "Untitled draft" ? "" : row.title,
      previewText: row.previewText ?? "",
      blocks: Array.isArray(row.bodyJson) ? row.bodyJson : [],
      mode: row.householdMode,
      memberIds: liveIds,
      droppedMemberCount: memberIds.length - liveIds.length,
      fromName: row.fromName,
      replyTo: row.replyTo,
      status: row.status,
      editable: draftIsEditable(row.status),
      notEditableReason: draftIsEditable(row.status) ? null : notEditableReason(row.status),
      savedAt: row.updatedAt,
    },
  });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const { session, denied } = await guard();
  if (denied || !session) return denied!;

  const row = await prisma.announcement.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
    select: { id: true, status: true },
  });
  if (!row) return NextResponse.json({ error: "Draft not found." }, { status: 404 });
  if (!draftIsEditable(row.status)) {
    return NextResponse.json(
      { error: notEditableReason(row.status), code: "NOT_EDITABLE" },
      { status: 409 },
    );
  }

  await prisma.announcement.update({
    where: { id: row.id },
    data: { deletedAt: new Date() },
  });
  return NextResponse.json({ ok: true });
}
