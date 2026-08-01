// GET  /api/emails/opt-outs        — list opt-outs for this club
// POST /api/emails/opt-outs        — add / change scope (admin action)
// DELETE /api/emails/opt-outs?email — resubscribe (admin action)
//
// Every mutation writes an EmailOptOutAudit row with actorRole="OWNER"
// or "STAFF" and source="ADMIN". Read gate: messages:view +
// messages.unsubscribe sub-scope. Write gate: messages:edit +
// messages.unsubscribe.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission, requireMessagesSubScope } from "@/lib/apiGuard";
import { writeOptOutAudit } from "@/lib/optOutAudit";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "messages", "view");
  if (denied) return denied;
  const scopeDenied = requireMessagesSubScope(session, "unsubscribe");
  if (scopeDenied) return scopeDenied;

  const url = new URL(req.url);
  const search = (url.searchParams.get("search") || "").trim().toLowerCase();

  const rows = await prisma.emailOptOut.findMany({
    where: {
      clubId: session.user.clubId,
      ...(search ? { email: { contains: search, mode: "insensitive" as const } } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: 500,
    select: {
      id: true, email: true, userId: true, scope: true, source: true,
      createdAt: true, updatedAt: true,
    },
  });

  // Batch-load audit counts + last-action per address for the list.
  const emails = rows.map((r) => r.email);
  const audits = emails.length
    ? await prisma.emailOptOutAudit.groupBy({
        by: ["email", "action"],
        where: { clubId: session.user.clubId, email: { in: emails } },
        _count: true,
      })
    : [];
  const actionCountByEmail = new Map<string, { subscribes: number; unsubscribes: number }>();
  for (const a of audits) {
    const cur = actionCountByEmail.get(a.email) ?? { subscribes: 0, unsubscribes: 0 };
    if (a.action === "SUBSCRIBE") cur.subscribes += a._count;
    else cur.unsubscribes += a._count;
    actionCountByEmail.set(a.email, cur);
  }

  return NextResponse.json({
    optOuts: rows.map((r) => ({
      ...r,
      auditCounts: actionCountByEmail.get(r.email) ?? { subscribes: 0, unsubscribes: 0 },
    })),
  });
}

const upsertSchema = z.object({
  email: z.string().email(),
  scope: z.enum(["MARKETING", "TRANSACTIONAL", "ALL"]),
  note: z.string().max(500).optional(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "messages", "edit");
  if (denied) return denied;
  const scopeDenied = requireMessagesSubScope(session, "unsubscribe");
  if (scopeDenied) return scopeDenied;

  let data: z.infer<typeof upsertSchema>;
  try {
    data = upsertSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const email = data.email.trim().toLowerCase();

  const user = await prisma.user.findFirst({
    where: { clubId: session.user.clubId, email, deletedAt: null },
    select: { id: true },
  });

  const existing = await prisma.emailOptOut.findUnique({
    where: { clubId_email: { clubId: session.user.clubId, email } },
    select: { scope: true, userId: true },
  });

  const row = await prisma.emailOptOut.upsert({
    where: { clubId_email: { clubId: session.user.clubId, email } },
    create: {
      clubId: session.user.clubId, email,
      userId: user?.id ?? null,
      scope: data.scope,
      source: "ADMIN",
    },
    update: {
      scope: data.scope,
      source: "ADMIN",
      updatedAt: new Date(),
    },
    select: { id: true, email: true, scope: true, updatedAt: true },
  });

  if (!existing || existing.scope !== data.scope) {
    await writeOptOutAudit({
      clubId: session.user.clubId,
      email,
      userId: user?.id ?? existing?.userId ?? null,
      scope: data.scope,
      action: "UNSUBSCRIBE",
      source: "ADMIN",
      actorUserId: session.user.id,
      actorRole: (session.user.role === "OWNER" ? "OWNER" : "STAFF"),
      context: data.note ? { note: data.note } : null,
    });
  }
  return NextResponse.json(row);
}

const deleteSchema = z.object({ email: z.string().email(), note: z.string().max(500).optional() });

export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "messages", "edit");
  if (denied) return denied;
  const scopeDenied = requireMessagesSubScope(session, "unsubscribe");
  if (scopeDenied) return scopeDenied;

  let payload: z.infer<typeof deleteSchema>;
  try {
    payload = deleteSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const email = payload.email.trim().toLowerCase();

  const existing = await prisma.emailOptOut.findUnique({
    where: { clubId_email: { clubId: session.user.clubId, email } },
    select: { userId: true, scope: true },
  });
  if (!existing) return NextResponse.json({ ok: true, alreadySubscribed: true });

  await prisma.emailOptOut.delete({
    where: { clubId_email: { clubId: session.user.clubId, email } },
  });
  await writeOptOutAudit({
    clubId: session.user.clubId,
    email,
    userId: existing.userId,
    scope: "MARKETING",
    action: "SUBSCRIBE",
    source: "ADMIN",
    actorUserId: session.user.id,
    actorRole: (session.user.role === "OWNER" ? "OWNER" : "STAFF"),
    context: payload.note ? { note: payload.note } : null,
  });
  return NextResponse.json({ ok: true });
}
