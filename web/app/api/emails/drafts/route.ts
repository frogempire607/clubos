// GET  /api/emails/drafts  — list saved bulk-email drafts
// POST /api/emails/drafts  — create or update one
//
// Backed by Announcement (see lib/emailDrafts.ts for why). Until now the
// Members-tab composer only ever persisted to localStorage, so a draft was
// tied to one browser on one device and vanished if you cleared it.

import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { requirePermission, requireMessagesSubScope } from "@/lib/apiGuard";
import { validateEmailBlocks, blocksToPlainText } from "@/lib/emailBlocks";
import {
  pickedAudience,
  readPickedAudience,
  draftTitle,
  draftIsEditable,
  notEditableReason,
  DRAFT_CHANNEL,
} from "@/lib/emailDrafts";

const HOUSEHOLD_MODES = [
  "HOUSEHOLD", "PER_MEMBER", "PER_ATHLETE_PRIMARY", "ATHLETE_ONLY",
  "PRIMARY_GUARDIAN", "ALL_GUARDIANS", "PAYER", "ACCOUNT_HOLDER",
] as const;

const schema = z.object({
  id: z.string().optional(),
  subject: z.string().max(300).optional().default(""),
  previewText: z.string().max(300).optional().nullable(),
  blocks: z.array(z.unknown()).default([]),
  mode: z.enum(HOUSEHOLD_MODES).optional().default("HOUSEHOLD"),
  memberIds: z.array(z.string()).max(5000).default([]),
  fromName: z.string().max(120).optional().nullable(),
  replyTo: z.string().max(200).optional().nullable(),
});

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "messages", "send");
  if (denied) return denied;
  const scopeDenied = requireMessagesSubScope(session, "bulk");
  if (scopeDenied) return scopeDenied;

  const rows = await prisma.announcement.findMany({
    where: {
      clubId: session.user.clubId,
      deletedAt: null,
      status: "DRAFT",
      audienceFilters: { not: Prisma.DbNull },
    },
    orderBy: { updatedAt: "desc" },
    take: 100,
    select: {
      id: true, title: true, previewText: true, householdMode: true,
      audienceFilters: true, senderUserId: true,
      createdAt: true, updatedAt: true,
    },
  });

  // Only hand-picked drafts belong here. A rule-driven announcement draft is
  // a different object and is edited on the Announcements page.
  const drafts = rows
    .map((r) => {
      const memberIds = readPickedAudience(r.audienceFilters);
      if (!memberIds) return null;
      return {
        id: r.id,
        subject: r.title,
        title: draftTitle(r.title),
        previewText: r.previewText,
        mode: r.householdMode,
        recipientCount: memberIds.length,
        senderUserId: r.senderUserId,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    })
    .filter((d): d is NonNullable<typeof d> => d !== null);

  const senderIds = Array.from(new Set(drafts.map((d) => d.senderUserId).filter((v): v is string => !!v)));
  const senders = senderIds.length
    ? await prisma.user.findMany({
        where: { id: { in: senderIds }, clubId: session.user.clubId },
        select: { id: true, firstName: true, lastName: true, email: true },
      })
    : [];
  const nameOf = new Map(
    senders.map((u) => [u.id, [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email]),
  );

  return NextResponse.json({
    drafts: drafts.map((d) => ({
      ...d,
      savedByName: d.senderUserId ? nameOf.get(d.senderUserId) ?? null : null,
    })),
  });
}

export async function POST(req: Request) {
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
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    throw err;
  }

  // A draft is half-written by definition, so blocks are NOT required to be
  // valid — but if they parse we store the normalized form, and if they are
  // structurally broken we refuse rather than persist something the send path
  // would later choke on.
  const blocksResult = validateEmailBlocks(data.blocks);
  if (!blocksResult.ok && data.blocks.length > 0) {
    return NextResponse.json({ error: "Invalid message blocks.", details: blocksResult.errors }, { status: 400 });
  }
  const blocks = blocksResult.ok ? blocksResult.blocks : [];

  const common = {
    title: data.subject.trim() || "Untitled draft",
    // The legacy plain-text column stays populated so anything reading the
    // old shape (member portal announcement list, pre-3B code) still works.
    body: blocksToPlainText(blocks) || data.subject.trim() || "(empty draft)",
    bodyJson: blocks as object,
    previewText: data.previewText?.trim() || null,
    householdMode: data.mode,
    audienceFilters: pickedAudience(data.memberIds) as object,
    fromName: data.fromName?.trim() || null,
    replyTo: data.replyTo?.trim() || null,
    channels: DRAFT_CHANNEL,
    senderUserId: session.user.id,
  };

  if (data.id) {
    const existing = await prisma.announcement.findFirst({
      where: { id: data.id, clubId: session.user.clubId, deletedAt: null },
      select: { id: true, status: true },
    });
    if (!existing) return NextResponse.json({ error: "Draft not found." }, { status: 404 });
    if (!draftIsEditable(existing.status)) {
      return NextResponse.json(
        { error: notEditableReason(existing.status), code: "NOT_EDITABLE", status: existing.status },
        { status: 409 },
      );
    }
    const updated = await prisma.announcement.update({
      where: { id: existing.id },
      data: common,
      select: { id: true, updatedAt: true },
    });
    return NextResponse.json({ ok: true, id: updated.id, savedAt: updated.updatedAt });
  }

  const created = await prisma.announcement.create({
    data: { clubId: session.user.clubId, status: "DRAFT", ...common },
    select: { id: true, updatedAt: true },
  });
  return NextResponse.json({ ok: true, id: created.id, savedAt: created.updatedAt });
}
