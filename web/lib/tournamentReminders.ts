// The escalation sweep — plan.md §5.6.6 and §5.6.7.
//
// Two passes, one invocation, mirroring `runDueEventCharges`: due payment
// reminders, then the responsible-coach digest. Neither ever throws — one
// broken row must not abandon the queue behind it.
//
// ── Why this is a separate module from lib/eventReminders.ts ────────────────
// That file is the scheduling MATH and is strictly pure: the mutation routes
// import it inside their transactions, and the 271-assertion test suite walks
// its cadences with no database in sight. Importing prisma there would drag a
// client into all of that. So the arithmetic stays pure and the sweep — which
// needs prisma, the email ledger and the clock — lives here.
//
// ── What makes a double-fire safe ───────────────────────────────────────────
// Nothing in this file decides whether an email has already been sent. The
// (sendBatchId, dedupeKey) partial-unique index does: `event-remind:<regId>:
// <stage>` for a reminder, `coach-digest:<userId>:<day in club tz>` for a
// digest. A cron that runs twice, a Netlify retry after a timeout, and a
// lazy sweep firing at the same moment all converge on the same key, and the
// second insert resolves to SKIPPED. The advisory lock below is about not
// having two writers advance the same row's stage, not about the send.

import { prisma } from "@/lib/prisma";
import { resolveEventPolicy, registrationWaitingOn } from "@/lib/eventPayments";
import {
  computeNextReminderAt,
  resolveReminderAnchor,
  stageIndexFor,
} from "@/lib/eventReminders";
import {
  loadRegistrationRenderContext,
  sendRegistrationLifecycleEmail,
  sendCoachDigestEmail,
  type DigestRow,
} from "@/lib/eventLifecycleEmails";

export type ReminderOutcome = "sent" | "skipped" | "failed" | "not-due";
export type ReminderResult = { registrationId: string; outcome: ReminderOutcome; stage?: number; error?: string };

/** Three consecutive failures on one stage and a human needs to look. */
const FAILURE_SENTINEL = -1;
const MAX_STAGE_FAILURES = 3;
const HOUR_MS = 3_600_000;

const REG_FOR_REMINDER = {
  include: {
    event: { include: { customEventType: { select: { defaultPolicy: true } } } },
  },
} as const;

/**
 * Send one registration's next reminder, if it is genuinely due.
 *
 * The row is re-read inside the lock because the outer query is a snapshot: a
 * family can pay, a coach can decline, and a parent can cancel between the
 * sweep listing this row and this function reaching it. Re-verifying is what
 * stops a paid registration getting a stage-5 reminder.
 */
export async function sendDueReminder(
  registrationId: string,
  opts: { now?: Date } = {},
): Promise<ReminderResult> {
  const now = opts.now ?? new Date();

  const prepared = await prisma.$transaction(async (db) => {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`evreg-mut:${registrationId}`}, 0))`;

    const reg = await db.eventRegistration.findUnique({
      where: { id: registrationId },
      ...REG_FOR_REMINDER,
    });
    if (!reg) return { outcome: "not-due" as const };
    if (!reg.nextReminderAt || reg.nextReminderAt > now) return { outcome: "not-due" as const };
    if (reg.reminderStage === FAILURE_SENTINEL) return { outcome: "not-due" as const };

    const policy = resolveEventPolicy(reg.event);
    // §5.6.2 — money on the parent, escalation switched on, and an anchor to
    // count from. Anything else and the queue entry is stale; clear it rather
    // than leaving a row the sweep keeps picking up and putting down.
    // In practice never null — Event.startsAt is required, and it is the last
    // fallback — but the sweep must not assume that of a row it re-read.
    const anchor = resolveReminderAnchor(reg.event, policy);
    if (!policy.escalationEnabled || !anchor || registrationWaitingOn(reg, { now }) !== "PAYMENT") {
      await db.eventRegistration.update({
        where: { id: reg.id },
        data: { nextReminderAt: null },
      });
      return { outcome: "not-due" as const };
    }

    // Which stage this firing IS. Derived from the anchor rather than from
    // reminderStage + 1, because §5.6.4 lets stages be skipped: a family who
    // registers eight days out never gets the 14-day nudge, and the next one
    // they get is stage 2, not stage 1.
    const stage = stageIndexFor(anchor, policy, reg.nextReminderAt) || (reg.reminderStage ?? 0) + 1;
    return { outcome: "due" as const, stage, reg };
  });

  if (prepared.outcome !== "due") return { registrationId, outcome: "not-due" };
  const { stage } = prepared;

  // The send happens OUTSIDE the lock: it is a network round trip to an email
  // provider, and holding a pooled connection across it is the same mistake
  // the approve path documents. The dedupe key is what makes that safe.
  let sent = false;
  let error: string | undefined;
  try {
    const ctx = await loadRegistrationRenderContext(registrationId, { now, escalationStage: stage });
    if (!ctx) throw new Error("registration vanished between lock and send");
    const res = await sendRegistrationLifecycleEmail({
      registrationId,
      transition: "REMINDER",
      ctx,
    });
    // INSERTED or SKIPPED both count as "this stage was attempted" (§5.6.5) —
    // only a throw means the provider never got it.
    sent = res.sent + res.skipped > 0;
    if (!sent) error = "no deliverable recipient";
  } catch (e) {
    error = String(e);
  }

  const advanced = await prisma.$transaction(async (db) => {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`evreg-mut:${registrationId}`}, 0))`;
    const reg = await db.eventRegistration.findUnique({
      where: { id: registrationId },
      ...REG_FOR_REMINDER,
    });
    if (!reg) return "gone" as const;
    const policy = resolveEventPolicy(reg.event);

    if (!sent) {
      const failures = (reg.reminderSendFailures ?? 0) + 1;
      const dead = failures >= MAX_STAGE_FAILURES;
      await db.eventRegistration.update({
        where: { id: reg.id },
        data: {
          reminderSendFailures: failures,
          // Retry the SAME stage in an hour; after three tries stop and
          // surface it, because silently retrying forever is how a family
          // never hears from you and nobody finds out.
          ...(dead
            ? { reminderStage: FAILURE_SENTINEL, nextReminderAt: null }
            : { nextReminderAt: new Date(now.getTime() + HOUR_MS) }),
          lastChargeError: undefined,
        },
      });
      return dead ? ("dead" as const) : ("retry" as const);
    }

    const projected = { ...reg, reminderStage: stage, lastReminderAt: now };
    await db.eventRegistration.update({
      where: { id: reg.id },
      data: {
        reminderStage: stage,
        lastReminderAt: now,
        reminderSendFailures: 0,
        nextReminderAt: computeNextReminderAt(projected, reg.event, policy, { now }),
      },
    });
    return "advanced" as const;
  });

  if (advanced === "advanced") return { registrationId, outcome: "sent", stage };
  if (advanced === "gone") return { registrationId, outcome: "skipped" };
  return { registrationId, outcome: "failed", stage, error };
}

/**
 * Pass 1 — every reminder that is due right now.
 *
 * Sequential on purpose, exactly like the charge sweep: serverless-friendly,
 * no thundering herd at the email provider, and a limit that the next run
 * simply picks up from.
 */
export async function runDueTournamentReminders(scope?: {
  clubId?: string;
  eventId?: string;
  limit?: number;
  now?: Date;
}): Promise<{ due: number; results: ReminderResult[] }> {
  const now = scope?.now ?? new Date();
  try {
    const due = await prisma.eventRegistration.findMany({
      where: {
        nextReminderAt: { lte: now },
        status: { not: "CANCELED" },
        reminderStage: { not: FAILURE_SENTINEL },
        ...(scope?.clubId ? { clubId: scope.clubId } : {}),
        ...(scope?.eventId ? { eventId: scope.eventId } : {}),
      },
      orderBy: { nextReminderAt: "asc" },
      take: scope?.limit ?? 25,
      select: { id: true },
    });

    const results: ReminderResult[] = [];
    for (const r of due) {
      try {
        results.push(await sendDueReminder(r.id, { now }));
      } catch (e) {
        console.error("[tournamentReminders] threw for", r.id, e);
        results.push({ registrationId: r.id, outcome: "failed", error: String(e) });
      }
    }
    return { due: due.length, results };
  } catch (e) {
    console.error("[tournamentReminders] sweep failed", e);
    return { due: 0, results: [] };
  }
}

/** YYYY-MM-DD in the club's own calendar — the digest's per-day dedupe key. */
function dayKeyIn(timeZone: string | null, at: Date): string {
  try {
    return at.toLocaleDateString("en-CA", timeZone ? { timeZone } : { timeZone: "UTC" });
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** The hour of `at` in the club's calendar, for the once-a-day gate. */
function hourIn(timeZone: string | null, at: Date): number {
  try {
    return Number(
      at.toLocaleString("en-US", { hour: "2-digit", hour12: false, timeZone: timeZone ?? "UTC" }),
    );
  } catch {
    return at.getUTCHours();
  }
}

/**
 * Pass 2 — the responsible coach's daily digest of what has been sitting.
 *
 * 09:00 in the club's own timezone, falling back to 09:00 UTC when the column
 * is unset (§5.12 item 5). The hour gate is a courtesy — the real guarantee is
 * the per-day dedupe key, so a cron that fires twice inside the hour still
 * sends one email.
 */
export async function runCoachDigests(scope?: {
  clubId?: string;
  now?: Date;
  /** Skip the 09:00 gate — used by tests and by an explicit manual run. */
  force?: boolean;
}): Promise<{ coaches: number; sent: number }> {
  const now = scope?.now ?? new Date();
  let sent = 0;
  try {
    // Only rows a coach can still act on, aged past a day (§5.6.7).
    const stalled = await prisma.eventRegistration.findMany({
      where: {
        approvalStatus: "PENDING",
        status: { not: "CANCELED" },
        approvalRequestedAt: { lt: new Date(now.getTime() - 24 * HOUR_MS) },
        proposedChangeRespondedAt: null,
        event: { deletedAt: null, responsibleCoachUserId: { not: null } },
        ...(scope?.clubId ? { clubId: scope.clubId } : {}),
      },
      select: {
        id: true,
        name: true,
        clubId: true,
        approvalRequestedAt: true,
        createdAt: true,
        proposedChange: true,
        event: { select: { id: true, name: true, responsibleCoachUserId: true } },
        club: { select: { timezone: true } },
      },
    });

    // A proposal on the table is waiting on the PARENT, not the coach — same
    // precedence the roster queue and the Action Center probes apply.
    const actionable = stalled.filter((r) => !r.proposedChange);

    const byCoach = new Map<string, { clubId: string; timezone: string | null; rows: DigestRow[] }>();
    for (const r of actionable) {
      const coachId = r.event.responsibleCoachUserId;
      if (!coachId) continue;
      const key = `${r.clubId}:${coachId}`;
      const bucket = byCoach.get(key) ?? { clubId: r.clubId, timezone: r.club.timezone, rows: [] };
      bucket.rows.push({
        registrationId: r.id,
        athleteName: r.name,
        eventId: r.event.id,
        eventName: r.event.name,
        daysWaiting: Math.floor(
          (now.getTime() - (r.approvalRequestedAt ?? r.createdAt).getTime()) / 86_400_000,
        ),
      });
      byCoach.set(key, bucket);
    }

    for (const [key, bucket] of byCoach) {
      const coachUserId = key.split(":")[1];
      if (!scope?.force && hourIn(bucket.timezone, now) !== 9) continue;
      const coach = await prisma.user.findFirst({
        where: { id: coachUserId, clubId: bucket.clubId, deletedAt: null },
        select: { id: true, email: true, firstName: true },
      });
      if (!coach?.email) continue;
      const res = await sendCoachDigestEmail({
        clubId: bucket.clubId,
        coachUserId: coach.id,
        coachEmail: coach.email,
        coachFirstName: coach.firstName ?? null,
        rows: bucket.rows.sort((a, b) => b.daysWaiting - a.daysWaiting),
        dayKey: dayKeyIn(bucket.timezone, now),
      });
      if (res.sent) sent++;
    }

    return { coaches: byCoach.size, sent };
  } catch (e) {
    console.error("[tournamentReminders] digest pass failed", e);
    return { coaches: 0, sent };
  }
}
