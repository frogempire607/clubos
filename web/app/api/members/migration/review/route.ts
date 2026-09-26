// B6 — bulk "Mark reviewed" for the migration queue's bulk row.
//
//   POST /api/members/migration/review  { memberIds: string[] }
//
// The same write as PATCH /api/members/[id]/triage { action: "review" }, for
// many people at once:
//   · same permission (members:edit — triage, not billing);
//   · idempotent — anyone already reviewed keeps their FIRST reviewer and gets
//     no second event (two staff ticking the same person should not produce two
//     different reviewers);
//   · attributed — one MemberMigrationEvent per person, so each profile's
//     Migration activity tab still says who looked.
//
// Club-scoped by construction: ids from another club simply don't match.

import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";

const MAX_PER_REQUEST = 500;

const schema = z.object({
  memberIds: z.array(z.string().min(1)).min(1).max(MAX_PER_REQUEST),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "members", "edit");
  if (denied) return denied;

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json().catch(() => ({})));
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    throw err;
  }

  const clubId = session.user.clubId;
  const ids = [...new Set(body.memberIds)];
  const found = await prisma.member.findMany({
    where: { id: { in: ids }, clubId, deletedAt: null },
    select: { id: true, reviewedAt: true },
  });
  const toReview = found.filter((m) => !m.reviewedAt).map((m) => m.id);
  const alreadyReviewed = found.length - toReview.length;
  const notFound = ids.length - found.length;

  if (toReview.length > 0) {
    const actorId = (session.user.id as string | undefined) ?? null;
    const staffName = [session.user.name, session.user.email].find(Boolean) ?? "staff";
    const now = new Date();
    await prisma.$transaction([
      // `reviewedAt: null` in the WHERE keeps it idempotent under a race with
      // the single-member route: whoever wrote first stays the reviewer.
      prisma.member.updateMany({
        where: { id: { in: toReview }, clubId, reviewedAt: null },
        data: { reviewedAt: now, reviewedByUserId: actorId },
      }),
      prisma.memberMigrationEvent.createMany({
        data: toReview.map((memberId) => ({
          clubId,
          memberId,
          type: "NOTE",
          message: `Information reviewed by ${staffName}`,
          actorUserId: actorId,
        })),
      }),
    ]);
  }

  return NextResponse.json({ ok: true, reviewed: toReview.length, alreadyReviewed, notFound });
}
