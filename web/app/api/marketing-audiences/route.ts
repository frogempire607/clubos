// GET  /api/marketing-audiences         → list (with archived toggle)
// POST /api/marketing-audiences         → create (evaluates filter, stashes count)

import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission, requireMessagesSubScope } from "@/lib/apiGuard";
import { parseAudienceFilter, evaluateAudience } from "@/lib/audienceFilters";

const createSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional().nullable(),
  filters: z.unknown(),
  // isDynamic=true → filter re-evaluates at send time (default).
  // isDynamic=false → frozenMemberIds captured now, sends only to those.
  isDynamic: z.boolean().default(true),
});

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "messages", "view");
  if (denied) return denied;
  const scopeDenied = requireMessagesSubScope(session, "marketing");
  if (scopeDenied) return scopeDenied;

  const includeArchived = new URL(req.url).searchParams.get("archived") === "1";

  const rows = await prisma.marketingAudience.findMany({
    where: {
      clubId: session.user.clubId,
      ...(includeArchived ? {} : { archivedAt: null }),
    },
    orderBy: [{ archivedAt: "asc" }, { name: "asc" }],
    select: {
      id: true, name: true, description: true, filters: true,
      isDynamic: true, frozenMemberIds: true,
      estimatedCount: true, estimatedAt: true,
      archivedAt: true, createdAt: true, updatedAt: true,
    },
  });

  return NextResponse.json({ audiences: rows });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "messages", "edit");
  if (denied) return denied;
  const scopeDenied = requireMessagesSubScope(session, "marketing");
  if (scopeDenied) return scopeDenied;

  let data: z.infer<typeof createSchema>;
  try {
    data = createSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const filter = parseAudienceFilter(data.filters);
  const matchedIds = await evaluateAudience(session.user.clubId, filter);

  const row = await prisma.marketingAudience.create({
    data: {
      clubId: session.user.clubId,
      name: data.name,
      description: data.description ?? null,
      filters: filter as unknown as object,
      isDynamic: data.isDynamic,
      // For a static audience we freeze the current match set at save
      // time. Dynamic audiences leave this null and re-evaluate on send.
      frozenMemberIds: data.isDynamic ? undefined : matchedIds,
      estimatedCount: matchedIds.length,
      estimatedAt: new Date(),
      createdById: session.user.id,
    },
    select: { id: true, name: true, estimatedCount: true },
  });

  return NextResponse.json(row, { status: 201 });
}
