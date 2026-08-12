/**
 * Phase 4.5.10 — the subscription history Reports needs.
 *
 * ── Why an append-only log ──────────────────────────────────────────────────
 *
 * `MemberSubscription` holds CURRENT state. Churn is a question about
 * TRANSITIONS: how many memberships ended in March, how many of those were
 * plan changes rather than losses, and which cancellations came back inside the
 * 14-day grace. None of that is answerable from current state, which is why
 * `/api/reports/membership` has been returning `reliability: "ESTIMATED"`.
 *
 * `member_subscription_events` is that log. It is APPEND-ONLY: nothing here
 * updates or deletes a row, because the whole value is that history cannot be
 * retroactively rewritten. `memberId` is denormalized for the same reason — a
 * Phase 4A transfer moves a subscription to a different athlete, and the
 * history must keep naming the athlete it actually applied to at the time.
 *
 * ── `at` is not `createdAt` ─────────────────────────────────────────────────
 *
 * `at` is when the transition HAPPENED; `createdAt` is when we found out. A
 * Stripe webhook can arrive late and the backfill synthesizes history from
 * timestamps that are months old. Every churn window reads `at`.
 *
 * ── Never throws ────────────────────────────────────────────────────────────
 *
 * Every writer here swallows its errors. This log is analytics; a failure to
 * record that a membership was created must never be the reason a membership
 * fails to be created. The cost of a missing row is a slightly wrong report;
 * the cost of a thrown error here is a customer who paid and got nothing.
 */

import { prisma } from "@/lib/prisma";

export const SUBSCRIPTION_EVENT_KIND = {
  CREATED: "CREATED",
  ACTIVATED: "ACTIVATED",
  PAUSED: "PAUSED",
  RESUMED: "RESUMED",
  CANCELED: "CANCELED",
  EXPIRED: "EXPIRED",
  PLAN_CHANGED: "PLAN_CHANGED",
  REACTIVATED: "REACTIVATED",
  /**
   * The billed amount on an EXISTING subscription moved. NOT a lifecycle
   * transition: the membership did not start, stop, pause, or change plan —
   * only its price did. See LIFECYCLE_EVENT_KINDS below for why that
   * distinction is load-bearing rather than cosmetic.
   */
  PRICE_CHANGE: "PRICE_CHANGE",
} as const;

export type SubscriptionEventKind =
  (typeof SUBSCRIPTION_EVENT_KIND)[keyof typeof SUBSCRIPTION_EVENT_KIND];

/**
 * The kinds that describe a membership STARTING, STOPPING, or MOVING — the
 * only ones that answer "does this subscription have history".
 *
 * PRICE_CHANGE is deliberately excluded. A bulk repricing writes one row per
 * touched subscription, and if those rows counted toward coverage then
 * repricing a club's book of business would flip the Reports Membership tab
 * from ESTIMATED to COMPLETE without a single lifecycle fact being recorded —
 * turning an honest caveat into a confident wrong answer. That is the exact
 * failure mode the reliability gate exists to prevent, so the gate counts
 * lifecycle kinds only.
 *
 * Any future non-lifecycle kind (a note, a payment-method swap, a discount
 * edit) belongs outside this list too.
 */
export const LIFECYCLE_EVENT_KINDS: SubscriptionEventKind[] = [
  SUBSCRIPTION_EVENT_KIND.CREATED,
  SUBSCRIPTION_EVENT_KIND.ACTIVATED,
  SUBSCRIPTION_EVENT_KIND.PAUSED,
  SUBSCRIPTION_EVENT_KIND.RESUMED,
  SUBSCRIPTION_EVENT_KIND.CANCELED,
  SUBSCRIPTION_EVENT_KIND.EXPIRED,
  SUBSCRIPTION_EVENT_KIND.PLAN_CHANGED,
  SUBSCRIPTION_EVENT_KIND.REACTIVATED,
];

export const SUBSCRIPTION_EVENT_SOURCE = {
  STRIPE_WEBHOOK: "STRIPE_WEBHOOK",
  OWNER_ACTION: "OWNER_ACTION",
  GUARDIAN_ACTION: "GUARDIAN_ACTION",
  MEMBER_ACTION: "MEMBER_ACTION",
  SYSTEM: "SYSTEM",
} as const;

export type SubscriptionEventSource =
  (typeof SUBSCRIPTION_EVENT_SOURCE)[keyof typeof SUBSCRIPTION_EVENT_SOURCE];

export type SubscriptionEventInput = {
  clubId: string;
  memberSubscriptionId: string;
  memberId: string;
  kind: SubscriptionEventKind;
  /** Defaults to now. Pass the real transition time when it is known. */
  at?: Date;
  fromPlan?: string | null;
  toPlan?: string | null;
  fromAmount?: number | string | null;
  toAmount?: number | string | null;
  actorUserId?: string | null;
  source: SubscriptionEventSource;
  /** Stripe event id, route name, script run — whatever reconstructs an incident. */
  detail?: Record<string, unknown> | null;
};

/** Record one transition. Never throws — see the module note. */
export async function recordSubscriptionEvent(input: SubscriptionEventInput): Promise<void> {
  try {
    await prisma.memberSubscriptionEvent.create({
      data: {
        clubId: input.clubId,
        memberSubscriptionId: input.memberSubscriptionId,
        memberId: input.memberId,
        kind: input.kind,
        at: input.at ?? new Date(),
        fromPlan: input.fromPlan ?? null,
        toPlan: input.toPlan ?? null,
        fromAmount: input.fromAmount == null ? null : String(input.fromAmount),
        toAmount: input.toAmount == null ? null : String(input.toAmount),
        actorUserId: input.actorUserId ?? null,
        source: input.source,
        detail: (input.detail ?? undefined) as never,
      },
    });
  } catch (e) {
    console.error("[subscriptionEvents] failed to record", input.kind, e);
  }
}

/**
 * Convenience for the common case: a subscription row was just created.
 *
 * Takes the row rather than loose fields so a caller cannot record a CREATED
 * event against the wrong plan — the two arguments that most often drift.
 */
export async function recordSubscriptionCreated(
  sub: {
    id: string;
    memberId: string;
    price: unknown;
    optionLabel?: string | null;
    membership?: { name: string } | null;
  },
  ctx: {
    clubId: string;
    source: SubscriptionEventSource;
    actorUserId?: string | null;
    detail?: Record<string, unknown> | null;
    at?: Date;
  },
): Promise<void> {
  await recordSubscriptionEvent({
    clubId: ctx.clubId,
    memberSubscriptionId: sub.id,
    memberId: sub.memberId,
    kind: SUBSCRIPTION_EVENT_KIND.CREATED,
    at: ctx.at,
    toPlan: sub.membership?.name ?? sub.optionLabel ?? null,
    toAmount: sub.price == null ? null : String(sub.price),
    actorUserId: ctx.actorUserId ?? null,
    source: ctx.source,
    detail: ctx.detail ?? null,
  });
}

/**
 * Whether a club's event log can be trusted as COMPLETE.
 *
 * Reports must NOT flip to COMPLETE merely because the table exists — an empty
 * log reads as "nothing ever happened", which is a confident wrong answer
 * rather than an honest caveat. The test is: does every subscription this club
 * has, have at least one LIFECYCLE event? That is exactly what BF-B
 * guarantees, and it stays true afterwards because every creation path
 * records CREATED.
 *
 * The kind filter is not decoration. Without it, a bulk price change writing
 * one PRICE_CHANGE row per subscription would satisfy this test on its own,
 * and Reports would start claiming COMPLETE churn history for a club whose
 * lifecycle log had never been backfilled. See LIFECYCLE_EVENT_KINDS.
 */
export async function subscriptionHistoryIsComplete(clubId: string): Promise<boolean> {
  const [subs, covered] = await Promise.all([
    prisma.memberSubscription.count({ where: { member: { clubId } } }),
    prisma.memberSubscriptionEvent
      .groupBy({
        by: ["memberSubscriptionId"],
        where: { clubId, kind: { in: LIFECYCLE_EVENT_KINDS } },
      })
      .then((rows) => rows.length),
  ]);
  // A club with no subscriptions at all has nothing to be wrong about.
  if (subs === 0) return true;
  return covered >= subs;
}
