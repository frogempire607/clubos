// B13 slice 2 — pause, resume, and the lapsed-pause sweep.
//
// A pause is a fact on the row (pausedAt / pausedUntil). Stripe rows mirror
// it as pause_collection (behavior "void": invoices during the pause are
// voided, the cycle runs on, resumes_at brings billing back by itself).
// Offline rows get the paused days handed back to paidThroughDate/endDate on
// resume (lib/membershipPanel.resumeShift). Member.status = PAUSED stays the
// roster label the B14 queue reads; this module keeps it in step.

import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { resumeShift } from "@/lib/membershipPanel";
import { recomputeMemberStatus } from "@/lib/memberStatus";
import { recordSubscriptionEvent, SUBSCRIPTION_EVENT_KIND, SUBSCRIPTION_EVENT_SOURCE } from "@/lib/subscriptionEvents";
import { writeBillingAudit } from "@/lib/billingAudit";

const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

type Result = { ok: true; message: string } | { ok: false; error: string; code?: string; status: number };

export async function pauseMembership(input: { clubId: string; memberId: string; subscriptionId: string; until: Date | null; actorUserId: string | null }): Promise<Result> {
  const row = await prisma.memberSubscription.findFirst({
    where: { id: input.subscriptionId, memberId: input.memberId, member: { clubId: input.clubId }, status: { in: ["active", "past_due"] } },
    include: { member: { select: { firstName: true } } },
  });
  if (!row) return { ok: false, error: "No live membership to pause.", status: 404 };
  if (row.pausedAt) return { ok: false, error: "Already paused.", code: "ALREADY_PAUSED", status: 409 };
  if (input.until && input.until.getTime() <= Date.now()) return { ok: false, error: "The resume date must be in the future.", status: 400 };

  if (row.stripeSubscriptionId) {
    const club = await prisma.club.findUnique({ where: { id: input.clubId }, select: { stripeAccountId: true } });
    if (!club?.stripeAccountId) return { ok: false, error: "Stripe isn't connected for this club.", status: 409 };
    try {
      await stripe.subscriptions.update(
        row.stripeSubscriptionId,
        { pause_collection: { behavior: "void", ...(input.until ? { resumes_at: Math.floor(input.until.getTime() / 1000) } : {}) } },
        { stripeAccount: club.stripeAccountId },
      );
    } catch (e) {
      return { ok: false, error: `Stripe rejected the pause — nothing was saved: ${String(e)}`, status: 502 };
    }
  }
  const now = new Date();
  await prisma.memberSubscription.update({ where: { id: row.id }, data: { pausedAt: now, pausedUntil: input.until } });
  await prisma.member.updateMany({ where: { id: input.memberId, clubId: input.clubId }, data: { status: "PAUSED" } });
  await recordSubscriptionEvent({
    clubId: input.clubId, memberSubscriptionId: row.id, memberId: input.memberId, kind: SUBSCRIPTION_EVENT_KIND.PAUSED,
    fromPlan: row.optionLabel, fromAmount: String(row.price), actorUserId: input.actorUserId ?? undefined, source: SUBSCRIPTION_EVENT_SOURCE.OWNER_ACTION,
    detail: { route: "pauseMembership", until: input.until?.toISOString() ?? null, stripe: !!row.stripeSubscriptionId },
  });
  await writeBillingAudit({
    clubId: input.clubId, memberId: input.memberId, actorUserId: input.actorUserId, action: "MEMBERSHIP_PAUSED",
    before: { pausedAt: null }, after: { pausedAt: now, pausedUntil: input.until },
    note: `"${row.optionLabel}" paused${input.until ? ` until ${fmt(input.until)}` : " until resumed"}${row.stripeSubscriptionId ? " — Stripe collection paused (invoices voided)" : " — billed offline; paused days are returned on resume"}.`,
  });
  return { ok: true, message: `${row.member.firstName} is paused${input.until ? ` until ${fmt(input.until)}` : ""}.` };
}

export async function resumeMembership(input: { clubId: string; memberId: string; subscriptionId: string; actorUserId: string | null; via?: string }): Promise<Result> {
  const row = await prisma.memberSubscription.findFirst({
    where: { id: input.subscriptionId, memberId: input.memberId, member: { clubId: input.clubId } },
    include: { member: { select: { firstName: true, status: true } } },
  });
  if (!row) return { ok: false, error: "Membership not found.", status: 404 };
  const now = new Date();
  if (row.stripeSubscriptionId && row.pausedAt) {
    const club = await prisma.club.findUnique({ where: { id: input.clubId }, select: { stripeAccountId: true } });
    if (club?.stripeAccountId) {
      try {
        await stripe.subscriptions.update(row.stripeSubscriptionId, { pause_collection: "" }, { stripeAccount: club.stripeAccountId });
      } catch (e) {
        return { ok: false, error: `Stripe rejected the resume — nothing was saved: ${String(e)}`, status: 502 };
      }
    }
  }
  const shift = resumeShift({ pausedAt: row.pausedAt, paidThroughDate: row.paidThroughDate, endDate: row.endDate, hasStripe: !!row.stripeSubscriptionId }, now);
  await prisma.memberSubscription.update({
    where: { id: row.id },
    data: { pausedAt: null, pausedUntil: null, paidThroughDate: shift.paidThroughDate, endDate: shift.endDate },
  });
  // Off the sticky label, then let the recompute say what the rows say.
  await prisma.member.updateMany({ where: { id: input.memberId, clubId: input.clubId, status: "PAUSED" }, data: { status: "ACTIVE" } });
  await recomputeMemberStatus(input.memberId, input.clubId);
  await recordSubscriptionEvent({
    clubId: input.clubId, memberSubscriptionId: row.id, memberId: input.memberId, kind: SUBSCRIPTION_EVENT_KIND.RESUMED,
    toPlan: row.optionLabel, toAmount: String(row.price), actorUserId: input.actorUserId ?? undefined,
    source: input.actorUserId ? SUBSCRIPTION_EVENT_SOURCE.OWNER_ACTION : SUBSCRIPTION_EVENT_SOURCE.SYSTEM,
    detail: { route: input.via ?? "resumeMembership", pausedDays: shift.pausedDays },
  });
  await writeBillingAudit({
    clubId: input.clubId, memberId: input.memberId, actorUserId: input.actorUserId, action: "MEMBERSHIP_RESUMED",
    before: { pausedAt: row.pausedAt, pausedUntil: row.pausedUntil, paidThroughDate: row.paidThroughDate, endDate: row.endDate },
    after: { pausedDays: shift.pausedDays, paidThroughDate: shift.paidThroughDate, endDate: shift.endDate },
    note: `"${row.optionLabel}" resumed${shift.pausedDays ? ` after ${shift.pausedDays} days` : ""}${row.stripeSubscriptionId ? " — Stripe collection resumed" : shift.pausedDays && shift.paidThroughDate ? ` — paid through moves to ${fmt(shift.paidThroughDate)}` : ""}.`,
  });
  return { ok: true, message: `${row.member.firstName} is active again${!row.stripeSubscriptionId && shift.paidThroughDate && shift.pausedDays ? ` — paid through ${fmt(shift.paidThroughDate)}` : ""}.` };
}

/**
 * Pauses whose date has passed. Stripe already resumed billing by itself
 * (resumes_at); this brings the row and the roster label along. Called from
 * the same places as expireEndedManualSubscriptions.
 */
export async function resumeLapsedPauses(clubId: string, memberIds?: string[]): Promise<number> {
  if (memberIds && memberIds.length === 0) return 0;
  const lapsed = await prisma.memberSubscription.findMany({
    where: { ...(memberIds ? { memberId: { in: memberIds } } : {}), member: { clubId, deletedAt: null }, pausedAt: { not: null }, pausedUntil: { lte: new Date() } },
    select: { id: true, memberId: true },
  });
  for (const r of lapsed) await resumeMembership({ clubId, memberId: r.memberId, subscriptionId: r.id, actorUserId: null, via: "resumeLapsedPauses" });
  return lapsed.length;
}
