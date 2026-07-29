import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { ACTION_ITEM_KINDS } from "@/lib/reportsActionItems";

// POST /api/reports/action-items/snooze
// Body: { kind, targetId?, days }
//
// Snoozes an Action Item for the caller. `targetId` optional — omit to snooze
// the entire kind for this user. `days` between 1 and 30.

const schema = z.object({
  kind: z.enum(ACTION_ITEM_KINDS),
  targetId: z.string().nullish(),
  days: z.number().int().min(1).max(30).default(7),
  reason: z.string().max(200).nullish(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "reports", "view");
  if (denied) return denied;

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const { kind, targetId, days, reason } = parsed.data;

  const snoozedUntil = new Date(Date.now() + days * 86400000);

  // Composite unique key via COALESCE lives in the DB but Prisma doesn't
  // model that; delete-then-insert atomically.
  await prisma.$transaction([
    prisma.actionItemSnooze.deleteMany({
      where: {
        userId: session.user.id,
        kind,
        targetId: targetId ?? null,
      },
    }),
    prisma.actionItemSnooze.create({
      data: {
        clubId: session.user.clubId,
        userId: session.user.id,
        kind,
        targetId: targetId ?? null,
        snoozedUntil,
        reason: reason ?? null,
      },
    }),
  ]);

  return NextResponse.json({ ok: true, snoozedUntil });
}

// DELETE /api/reports/action-items/snooze?kind=&targetId=
export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "reports", "view");
  if (denied) return denied;

  const url = new URL(req.url);
  const kind = url.searchParams.get("kind");
  const targetId = url.searchParams.get("targetId");
  if (!kind) return NextResponse.json({ error: "kind required" }, { status: 400 });

  await prisma.actionItemSnooze.deleteMany({
    where: {
      userId: session.user.id,
      kind,
      targetId: targetId || null,
    },
  });
  return NextResponse.json({ ok: true });
}
