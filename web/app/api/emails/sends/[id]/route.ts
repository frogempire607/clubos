// GET /api/emails/sends/[id]
// Returns the full HTML body of an EmailSend so the reader modal in
// the profile Communications tab (3G) can render "what the recipient
// actually got". Gated on messages:view + messages.analytics — reading
// the body is more sensitive than the header.

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission, requireMessagesSubScope } from "@/lib/apiGuard";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "messages", "view");
  if (denied) return denied;
  const scopeDenied = requireMessagesSubScope(session, "analytics");
  if (scopeDenied) return scopeDenied;

  const row = await prisma.emailSend.findFirst({
    where: { id: params.id, clubId: session.user.clubId },
    select: {
      id: true, subject: true, recipientEmail: true,
      fromName: true, fromEmail: true, replyTo: true,
      bodyHtml: true, bodyText: true,
      sentAt: true, deliveredAt: true, openedAt: true, clickedAt: true,
      providerMessageId: true, status: true,
    },
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(row);
}
