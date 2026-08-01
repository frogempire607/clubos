// POST /api/marketing-audiences/preview
// Evaluate an ad-hoc filter and return count + first-N member preview.
// Powers the "recipient count updates as filters change" behavior from
// plan §3D without persisting anything.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission, requireMessagesSubScope } from "@/lib/apiGuard";
import { parseAudienceFilter, evaluateAudience } from "@/lib/audienceFilters";

const schema = z.object({
  filters: z.unknown(),
  sampleLimit: z.number().int().min(0).max(50).default(10),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "messages", "view");
  if (denied) return denied;
  const scopeDenied = requireMessagesSubScope(session, "marketing");
  if (scopeDenied) return scopeDenied;

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const filter = parseAudienceFilter(data.filters);
  const ids = await evaluateAudience(session.user.clubId, filter);
  const sampleIds = ids.slice(0, data.sampleLimit);
  const sample = sampleIds.length
    ? await prisma.member.findMany({
        where: { id: { in: sampleIds } },
        select: { id: true, firstName: true, lastName: true, email: true, isMinor: true },
        orderBy: { firstName: "asc" },
      })
    : [];

  return NextResponse.json({
    count: ids.length,
    sample,
  });
}
