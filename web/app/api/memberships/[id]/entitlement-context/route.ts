import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermission } from "@/lib/apiGuard";
import { prisma } from "@/lib/prisma";
import { parseOptions } from "@/lib/membershipOptions";

// GET /api/memberships/[id]/entitlement-context
//
// READ-ONLY. Everything the day picker in the membership editor needs, and
// nothing else.
//
// ── Why the picker cannot just show seven days ──────────────────────────────
//
// A day entitlement is only meaningful against days the club actually runs. A
// coach picking from an abstract Sun–Sat grid has no way to know that MS/HS is
// accepted for Mon, Tue, Thu (Olympic Season and Preseason) plus Sun (Sunday
// Funday), and would have to hold the class schedule in their head to avoid
// granting a day that does not exist or missing one that does. So the picker is
// seeded from the union of `daysOfWeek` across the classes that accept THIS
// plan, and names which classes each day comes from.
//
// ── Why the member counts are here ──────────────────────────────────────────
//
// Entitlement is read live from the option, not snapshotted onto the
// subscription (decision D3 — "a snapshot means a silent second tier nobody can
// see"). The cost of that choice is that editing days changes what existing
// members are entitled to, with no per-member review. The mitigation is that
// the editor has to SAY so, with a real number, which means it needs one.
//
// Rows whose `optionId` is null cannot be attributed to an option — they are
// counted separately rather than being silently left out of a warning about who
// is affected.

export const dynamic = "force-dynamic";

type PricingOption =
  | { type: "member" | "nonmember" | "dropin"; price: number }
  | { type: "membership"; membershipId: string };

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Same key that gates the memberships editor this feeds.
  const denied = requirePermission(session, "classes", "view");
  if (denied) return denied;

  const membership = await prisma.membership.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
    select: { id: true, options: true },
  });
  if (!membership) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const classes = await prisma.recurringClass.findMany({
    where: { clubId: session.user.clubId, deletedAt: null, active: true },
    select: { id: true, name: true, daysOfWeek: true, pricingOptions: true },
    orderBy: { name: "asc" },
  });

  const accepting = classes.filter((c) => {
    const opts = (c.pricingOptions as unknown as PricingOption[] | null) || [];
    return opts.some(
      (o) => o?.type === "membership" && o.membershipId === membership.id,
    );
  });

  const dayClasses: Record<number, string[]> = {};
  for (const c of accepting) {
    const days = Array.isArray(c.daysOfWeek) ? (c.daysOfWeek as unknown[]) : [];
    for (const raw of days) {
      const d = Number(raw);
      if (!Number.isInteger(d) || d < 0 || d > 6) continue;
      dayClasses[d] = [...(dayClasses[d] ?? []), c.name];
    }
  }
  const offeredDays = Object.keys(dayClasses)
    .map(Number)
    .sort((a, b) => a - b);

  // Per-option live subscriber counts. `optionId` is the only honest key here —
  // optionLabel drifted long ago (the approve path writes the plan name).
  const live = await prisma.memberSubscription.groupBy({
    by: ["optionId"],
    where: {
      membershipId: membership.id,
      status: { in: ["active", "pending", "past_due"] },
      member: { deletedAt: null },
    },
    _count: { _all: true },
  });

  const optionCounts: Record<string, number> = {};
  let unidentifiedCount = 0;
  for (const row of live) {
    if (row.optionId) optionCounts[row.optionId] = row._count._all;
    else unidentifiedCount += row._count._all;
  }

  return NextResponse.json({
    offeredDays,
    dayClasses,
    classes: accepting.map((c) => ({ id: c.id, name: c.name, daysOfWeek: c.daysOfWeek })),
    optionCounts,
    unidentifiedCount,
    // Echoed so the client can align counts to options without re-parsing.
    optionIds: parseOptions(membership.options).map((o) => o.id),
  });
}
