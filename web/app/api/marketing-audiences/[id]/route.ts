// GET / PATCH / DELETE a single audience.
// PATCH re-evaluates + updates estimatedCount when filters change.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { parseAudienceFilter, evaluateAudience } from "@/lib/audienceFilters";

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
  filters: z.unknown().optional(),
  isDynamic: z.boolean().optional(),
  archived: z.boolean().optional(),
});

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "messages", "view");
  if (denied) return denied;

  const row = await prisma.marketingAudience.findFirst({
    where: { id: params.id, clubId: session.user.clubId },
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(row);
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "messages", "edit");
  if (denied) return denied;

  let data: z.infer<typeof patchSchema>;
  try {
    data = patchSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const existing = await prisma.marketingAudience.findFirst({
    where: { id: params.id, clubId: session.user.clubId },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const updates: Record<string, unknown> = { updatedById: session.user.id };
  if (data.name !== undefined) updates.name = data.name;
  if (data.description !== undefined) updates.description = data.description;
  if (data.archived !== undefined) updates.archivedAt = data.archived ? new Date() : null;

  if (data.filters !== undefined || data.isDynamic !== undefined) {
    const filter = parseAudienceFilter(data.filters ?? existing.filters);
    const matchedIds = await evaluateAudience(session.user.clubId, filter);
    const isDynamic = data.isDynamic ?? existing.isDynamic;
    updates.filters = filter as unknown as object;
    updates.isDynamic = isDynamic;
    updates.frozenMemberIds = isDynamic ? undefined : matchedIds;
    updates.estimatedCount = matchedIds.length;
    updates.estimatedAt = new Date();
  }

  const row = await prisma.marketingAudience.update({
    where: { id: existing.id },
    data: updates,
    select: { id: true, name: true, estimatedCount: true, archivedAt: true },
  });

  return NextResponse.json(row);
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "messages", "edit");
  if (denied) return denied;

  const existing = await prisma.marketingAudience.findFirst({
    where: { id: params.id, clubId: session.user.clubId },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Soft-delete only. An Announcement may still be pointing at this
  // audience via audienceId (loose reference — no FK); we want the
  // history to keep resolving the name after "delete".
  await prisma.marketingAudience.update({
    where: { id: existing.id },
    data: { archivedAt: existing.archivedAt ?? new Date(), updatedById: session.user.id },
  });

  return NextResponse.json({ ok: true });
}
