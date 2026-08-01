// GET    /api/email-templates/[id]           → detail (bodyJson + bodyHtml)
// PATCH  /api/email-templates/[id]           → edit name / body / subject / preview / description
// DELETE /api/email-templates/[id]           → archive (isSystem) or hard-delete (custom)

import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission, requireMessagesSubScope } from "@/lib/apiGuard";
import { validateEmailBlocks } from "@/lib/emailBlocks";
import { renderEmail } from "@/lib/emailRender";
import { resolvePostalAddressLines } from "@/lib/emailPostalAddress";

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
  subject: z.string().max(300).optional(),
  previewText: z.string().max(200).nullable().optional(),
  blocks: z.array(z.unknown()).min(1).optional(),
  archived: z.boolean().optional(),
});

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "messages", "view");
  if (denied) return denied;

  const t = await prisma.emailTemplate.findFirst({
    where: { id: params.id, clubId: session.user.clubId },
  });
  if (!t) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(t);
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "messages", "edit");
  if (denied) return denied;
  const scopeDenied = requireMessagesSubScope(session, "templates");
  if (scopeDenied) return scopeDenied;

  let data: z.infer<typeof patchSchema>;
  try {
    data = patchSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const existing = await prisma.emailTemplate.findFirst({
    where: { id: params.id, clubId: session.user.clubId },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const updates: Record<string, unknown> = {};
  if (data.name !== undefined) updates.name = data.name;
  if (data.description !== undefined) updates.description = data.description;
  if (data.subject !== undefined) updates.subject = data.subject;
  if (data.previewText !== undefined) updates.previewText = data.previewText;
  if (data.archived !== undefined) updates.archivedAt = data.archived ? new Date() : null;

  if (data.blocks) {
    const blocksResult = validateEmailBlocks(data.blocks);
    if (!blocksResult.ok) {
      return NextResponse.json({ error: "Invalid blocks", details: blocksResult.errors }, { status: 400 });
    }
    updates.bodyJson = blocksResult.blocks as unknown as object;
    // Refresh HTML snapshot for the templates list preview.
    const club = await prisma.club.findUnique({
      where: { id: session.user.clubId },
      select: {
        name: true, primaryColor: true,
        contactEmail: true, contactPhone: true, publicEmail: true, publicPhone: true, websiteUrl: true,
        mailingAddress: true, mailingAddress2: true, mailingCity: true,
        mailingState: true, mailingZip: true, mailingCountry: true,
      },
    });
    if (club) {
      const rendered = await renderEmail(blocksResult.blocks, {
        clubName: club.name,
        clubLogoUrl: null,
        clubContact: {
          email: club.publicEmail ?? club.contactEmail,
          phone: club.publicPhone ?? club.contactPhone,
          website: club.websiteUrl,
          address: null,
        },
        club,
        postalAddress: resolvePostalAddressLines(club),
        accentColor: club.primaryColor,
      });
      updates.bodyHtml = rendered.html;
      updates.bodyText = rendered.text;
    }
  }

  updates.updatedById = session.user.id;

  const t = await prisma.emailTemplate.update({
    where: { id: existing.id },
    data: updates,
    select: { id: true, name: true, archivedAt: true },
  });

  return NextResponse.json(t);
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "messages", "edit");
  if (denied) return denied;
  const scopeDenied = requireMessagesSubScope(session, "templates");
  if (scopeDenied) return scopeDenied;

  const existing = await prisma.emailTemplate.findFirst({
    where: { id: params.id, clubId: session.user.clubId },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // System templates archive rather than hard-delete so a future reader
  // can still see what the club started from. Custom templates can be
  // hard-deleted since no send should be pointing at them (EmailSend
  // stores the immutable snapshot, not a template FK).
  if (existing.isSystem) {
    await prisma.emailTemplate.update({
      where: { id: existing.id },
      data: { archivedAt: existing.archivedAt ?? new Date(), updatedById: session.user.id },
    });
    return NextResponse.json({ ok: true, archived: true });
  }

  await prisma.emailTemplate.delete({ where: { id: existing.id } });
  return NextResponse.json({ ok: true, deleted: true });
}
