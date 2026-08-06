// Phase 4.5.7 — the migration funnel.
//
// ── Why this replaces the eight KPI tiles ────────────────────────────────────
// The migration page showed eight unrelated numbers (imported, invited,
// activated, approved, …) that didn't add up to anything. An owner could read
// all eight and still not answer the only question they actually have: "how far
// through this am I, and what's stuck?"
//
// The funnel answers it, because the seven segments are ONE sequence — the same
// seven steps lib/memberTracks.ts already resolves per member. A person is
// counted at the furthest step they have completed, so the segments descend and
// the drop between any two is a real, clickable population.
//
// ── Derived, not stored ──────────────────────────────────────────────────────
// There is no funnel column and there must not be one. Every number here comes
// from `migrationMeterFor` over the same rows the queue lists, so a segment
// count and the list you get by clicking it are the same query. That is the
// whole reason 4.5.1 exists.

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { MEMBER_TRACK_SELECT, serializeMemberForList, toTrackInput } from "@/lib/memberDisplay";
import { buildTrackContext, loadSourceLabels } from "@/lib/membersQuery";
import {
  MIGRATION_STEPS,
  MIGRATION_STEP_COUNT,
  WAITING_ON,
  migrationMeterFor,
} from "@/lib/memberTracks";

/** Cap mirrors the roster's — past this we say so rather than guess. */
const FUNNEL_CAP = 20_000;

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "members", "view");
  if (denied) return denied;

  const clubId = session.user.clubId;

  // Migration members only: someone never imported has no place in a funnel
  // about moving off the previous system.
  const where = {
    clubId,
    deletedAt: null,
    isHistoricalOnly: false,
    migrationStatus: { not: null },
  } as const;

  const total = await prisma.member.count({ where });
  if (total > FUNNEL_CAP) {
    return NextResponse.json({ capped: true, total, segments: null, queue: null, advisory: null });
  }

  const rows = await prisma.member.findMany({ where, select: MEMBER_TRACK_SELECT });
  const ctx = await buildTrackContext(rows.map((r) => r.id));
  ctx.sourceLabelByBatch = await loadSourceLabels(rows.map((r) => r.importBatchId));

  // Count each person at the FURTHEST step they have completed. `step` is the
  // number of completed steps, so someone imported-and-reviewed sits at 2.
  const atStep = new Array(MIGRATION_STEP_COUNT + 1).fill(0) as number[];
  const queue = { needsYou: 0, waitingOnMember: 0, inSetup: 0, done: 0, blocked: 0 };

  // The sub-lines under each segment: the specific reason people are stuck
  // THERE, which is what makes a segment worth clicking.
  let unreviewed = 0;
  let neverInvited = 0;
  let awaitingYourYes = 0;
  let noResponse = 0;

  for (const r of rows) {
    const input = toTrackInput(r, ctx);
    const meter = migrationMeterFor(input);
    atStep[Math.min(meter.step, MIGRATION_STEP_COUNT)]++;

    if (meter.step >= MIGRATION_STEP_COUNT) queue.done++;
    else if (meter.waitingOn === WAITING_ON.BLOCKED) {
      queue.blocked++;
      queue.needsYou++;
    } else if (meter.waitingOn === WAITING_ON.STAFF) queue.needsYou++;
    else if (meter.waitingOn === WAITING_ON.MEMBER) queue.waitingOnMember++;
    else queue.inSetup++;

    if (meter.step === 1) unreviewed++;
    if (meter.step === 2) neverInvited++;
    if (meter.step === 5) awaitingYourYes++;
    if (meter.step === 3) noResponse++;
  }

  // Segment N = "reached at least step N". Descending by construction, which is
  // what makes it a funnel rather than a bar chart.
  const reachedAtLeast = (n: number) => atStep.slice(n).reduce((a, b) => a + b, 0);

  // Each subline flags the drop OUT of its own segment — the people who got
  // this far and stopped. So it always counts `meter.step === <segment>`, and
  // the number tells you what clicking that segment will show you needs doing.
  const SUBLINES: (string | null)[] = [
    unreviewed ? `${unreviewed} unreviewed` : null,
    neverInvited ? `${neverInvited} never invited` : null,
    noResponse ? `${noResponse} no response yet` : null,
    null,
    awaitingYourYes ? `${awaitingYourYes} needs your yes` : null,
    null,
    null,
  ];

  const segments = MIGRATION_STEPS.map((label, i) => ({
    step: i + 1,
    label,
    count: reachedAtLeast(i + 1),
    subline: SUBLINES[i],
  }));

  const complete = atStep[MIGRATION_STEP_COUNT];
  const notInvited = reachedAtLeast(1) - reachedAtLeast(3);
  const invitedNoResponse = reachedAtLeast(3) - reachedAtLeast(4);
  const inSetup = reachedAtLeast(4) - complete;

  // ── The cut-over advisory ───────────────────────────────────────────────
  // "When can I cancel my old software?" answered from the real numbers rather
  // than a percentage. The threshold is deliberately conservative: anyone not
  // yet at step 6 still has billing that has not been confirmed here, and
  // cancelling the old system while that is true is how a family stops being
  // charged by anyone at all.
  const notYetConfirmed = total - reachedAtLeast(6);
  const advisory = {
    total,
    complete,
    notYetConfirmed,
    safeToCancel: total > 0 && notYetConfirmed === 0,
    headline:
      total === 0
        ? "Nothing has been imported yet."
        : notYetConfirmed === 0
          ? "Everyone's membership is confirmed here. You can stop billing in your previous system."
          : `${notYetConfirmed} ${notYetConfirmed === 1 ? "person still has" : "people still have"} no confirmed membership in AthletixOS. Keep your previous system billing until that reaches zero.`,
  };

  return NextResponse.json({
    capped: false,
    total,
    segments,
    progress: { complete, inSetup, invitedNoResponse, notInvited },
    queue,
    advisory,
  });
}
