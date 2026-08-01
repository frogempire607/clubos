// POST /api/email-templates/[id]/duplicate  → clone (system → CUSTOM, custom → CUSTOM copy)

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission, requireMessagesSubScope } from "@/lib/apiGuard";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "messages", "edit");
  if (denied) return denied;
  const scopeDenied = requireMessagesSubScope(session, "templates");
  if (scopeDenied) return scopeDenied;

  const src = await prisma.emailTemplate.findFirst({
    where: { id: params.id, clubId: session.user.clubId },
  });
  if (!src) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const copy = await prisma.emailTemplate.create({
    data: {
      clubId: src.clubId,
      // Duplicates land as CUSTOM so an owner's edits don't drift from
      // the reference stock template. isSystem=false — no protection.
      kind: "CUSTOM",
      name: `${src.name} (copy)`,
      description: src.description,
      subject: src.subject,
      previewText: src.previewText,
      bodyJson: src.bodyJson as unknown as object,
      bodyHtml: src.bodyHtml,
      bodyText: src.bodyText,
      defaultFromName: src.defaultFromName,
      defaultReplyTo: src.defaultReplyTo,
      defaultPersonalization: (src.defaultPersonalization ?? undefined) as unknown as object | undefined,
      isSystem: false,
      createdById: session.user.id,
      updatedById: session.user.id,
    },
    select: { id: true, name: true, kind: true },
  });

  return NextResponse.json(copy, { status: 201 });
}
