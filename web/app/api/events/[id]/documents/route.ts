import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { documentsForEvent } from "@/lib/eventDocuments";

// Attach existing club documents to an event. All-Events docs are managed on
// the document itself (/dashboard/documents) and only DISPLAY here.

const putSchema = z.object({
  documentIds: z.array(z.string()).max(50),
});

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "events", "view");
  if (denied) return denied;
  const clubId = session.user.clubId;

  const event = await prisma.event.findFirst({
    where: { id, clubId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [attached, available, links] = await Promise.all([
    documentsForEvent(clubId, event.id),
    prisma.document.findMany({
      where: { clubId, deletedAt: null },
      select: { id: true, title: true, type: true, eventRequirement: true, appliesToAllEvents: true },
      orderBy: { title: "asc" },
    }),
    prisma.eventDocumentLink.findMany({
      where: { eventId: event.id, clubId },
      select: { documentId: true },
    }),
  ]);
  const linkedIds = new Set(links.map((l) => l.documentId));

  return NextResponse.json({
    event: { id: event.id, name: event.name },
    attached: attached.map((d) => ({ ...d, body: undefined, linkedDirectly: linkedIds.has(d.id) })),
    available,
  });
}

export async function PUT(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "events", "edit");
  if (denied) return denied;
  const clubId = session.user.clubId;

  const event = await prisma.event.findFirst({
    where: { id, clubId, deletedAt: null },
    select: { id: true },
  });
  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  // Only this club's live documents can be linked.
  const docs = await prisma.document.findMany({
    where: { id: { in: parsed.data.documentIds }, clubId, deletedAt: null },
    select: { id: true },
  });
  const validIds = docs.map((d) => d.id);

  await prisma.$transaction([
    prisma.eventDocumentLink.deleteMany({
      where: { eventId: event.id, clubId, documentId: { notIn: validIds } },
    }),
    ...validIds.map((documentId) =>
      prisma.eventDocumentLink.upsert({
        where: { documentId_eventId: { documentId, eventId: event.id } },
        create: { clubId, documentId, eventId: event.id },
        update: {},
      }),
    ),
  ]);

  return NextResponse.json({ ok: true, linked: validIds.length });
}
