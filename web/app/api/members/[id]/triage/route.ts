// Phase 4.5 — the two triage writes the migration meter has always read.
//
//   PATCH /api/members/[id]/triage  { action: "snooze" | "unsnooze" | "review" | "unreview" }
//
// ── Why these two live together ──────────────────────────────────────────────
//
// `members.reviewedAt` and `members.snoozedUntil` shipped in
// 20260804000000_members_experience and were applied on 2026-08-04. Both are
// read: `migrationMeterFor()` uses reviewedAt for step 2 ("Information
// reviewed"), and `nextAction()` uses snoozedUntil to move whose-turn to
// Nobody. Neither had anything that could write them, so:
//
//   • The funnel's step 2 read "unreviewed" for the entire roster, and the
//     "Review info" button on the profile banner had nowhere to go.
//   • "Snooze 7 days" was specified in §1c, rendered, and did nothing.
//
// Both are triage — a staffer saying "I have looked at this" or "not this
// week". Neither touches money, membership, or migration progress, so both are
// members:edit rather than billing, and both are reversible.
//
// ── Attribution ──────────────────────────────────────────────────────────────
// Every write lands in MemberMigrationEvent, because the profile's Migration
// activity tab is where a second staffer finds out that the first one already
// looked. An unattributed "reviewed" tick is worse than none: it tells you the
// work is done without telling you who to ask about it.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";

const SNOOZE_DAYS = 7;

const schema = z.object({
  action: z.enum(["snooze", "unsnooze", "review", "unreview"]),
  /** Only read for `snooze`. Bounded so a client cannot park someone forever. */
  days: z.number().int().min(1).max(90).optional(),
});

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "members", "edit");
  if (denied) return denied;

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json().catch(() => ({})));
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const member = await prisma.member.findFirst({
    where: { id, clubId: session.user.clubId, deletedAt: null },
    select: { id: true, firstName: true, reviewedAt: true, snoozedUntil: true },
  });
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const actorId = session.user.id as string | undefined;
  const staffName = [session.user.name, session.user.email].find(Boolean) ?? "staff";

  let data: { reviewedAt?: Date | null; reviewedByUserId?: string | null; snoozedUntil?: Date | null };
  let message: string;

  switch (body.action) {
    case "review": {
      // Idempotent on purpose: two staff pressing "Review info" within a minute
      // of each other should not produce two different reviewers, and the first
      // one is the one who actually did the reading.
      if (member.reviewedAt) {
        return NextResponse.json({ ok: true, reviewedAt: member.reviewedAt, alreadyReviewed: true });
      }
      data = { reviewedAt: new Date(), reviewedByUserId: actorId ?? null };
      message = `Information reviewed by ${staffName}`;
      break;
    }
    case "unreview":
      // Reversible — a staffer who ticked the wrong person needs a way back,
      // and step 2 of the meter is a claim about work, not an audit fact.
      data = { reviewedAt: null, reviewedByUserId: null };
      message = `Review mark cleared by ${staffName}`;
      break;
    case "snooze": {
      const days = body.days ?? SNOOZE_DAYS;
      const until = new Date(Date.now() + days * 86_400_000);
      data = { snoozedUntil: until };
      message = `Set aside for ${days} days by ${staffName}`;
      break;
    }
    case "unsnooze":
      data = { snoozedUntil: null };
      message = `Brought back into the queue by ${staffName}`;
      break;
  }

  const [updated] = await prisma.$transaction([
    prisma.member.update({
      where: { id },
      data,
      select: { id: true, reviewedAt: true, reviewedByUserId: true, snoozedUntil: true },
    }),
    prisma.memberMigrationEvent.create({
      data: {
        clubId: session.user.clubId,
        memberId: id,
        type: "NOTE",
        message,
        actorUserId: actorId ?? null,
      },
    }),
  ]);

  return NextResponse.json({ ok: true, ...updated });
}
