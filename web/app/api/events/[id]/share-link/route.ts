import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive } from "@/lib/apiGuard";
import { sharePath } from "@/lib/eventShareLink";
import { generateShareToken } from "@/lib/eventShareLinkServer";

// /api/events/[id]/share-link — the event's PRIVATE share link (/e/s-<token>).
//
//   GET     the current link, or { link: null }
//   POST    create it; with { rotate: true } replace the token, so the old
//           link stops working at once
//   DELETE  turn it off
//
// All three need events:edit, checked live: the token is what lets a stranger
// see and register for an event that isn't public, so reading it is as
// sensitive as changing it. The token is never returned by any other route.

async function gate(id: string) {
  const session = await getServerSession(authOptions);
  const denied = await requirePermissionLive(session, "events", "edit");
  if (denied || !session) return { denied: denied ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  const event = await prisma.event.findFirst({
    where: { id, clubId: session.user.clubId, deletedAt: null },
    select: { id: true, clubId: true },
  });
  if (!event) return { denied: NextResponse.json({ error: "Not found" }, { status: 404 }) } as const;
  return { denied: null, session, event } as const;
}

const view = (token: string | null) => ({ link: token ? { token, path: sharePath(token) } : null });

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const g = await gate(id);
  if (g.denied) return g.denied;
  const link = await prisma.eventShareLink.findUnique({ where: { eventId: g.event.id }, select: { token: true } });
  return NextResponse.json(view(link?.token ?? null));
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const g = await gate(id);
  if (g.denied) return g.denied;
  const body = (await req.json().catch(() => ({}))) as { rotate?: unknown };
  const rotate = body?.rotate === true;

  const existing = await prisma.eventShareLink.findUnique({ where: { eventId: g.event.id }, select: { token: true } });
  // Pressing "Create" twice (or in two tabs) must not quietly kill the link
  // the coach already sent: only an explicit rotate replaces it.
  if (existing && !rotate) return NextResponse.json(view(existing.token));

  const token = generateShareToken();
  const saved = await prisma.eventShareLink.upsert({
    where: { eventId: g.event.id },
    create: { eventId: g.event.id, clubId: g.event.clubId, token, createdByUserId: g.session.user.id },
    update: rotate ? { token, createdByUserId: g.session.user.id } : {},
    select: { token: true },
  });
  return NextResponse.json(view(saved.token));
}

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const g = await gate(id);
  if (g.denied) return g.denied;
  await prisma.eventShareLink.deleteMany({ where: { eventId: g.event.id } });
  return NextResponse.json(view(null));
}
