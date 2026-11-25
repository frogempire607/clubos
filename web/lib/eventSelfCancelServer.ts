// A family canceling its own event booking: what its refund policy gives back,
// and (policy or not) stopping a card charge that hasn't run yet.
//
// lib/eventRefundPolicy.selfCancelPlan decides what they get back and says so
// before they confirm; this reads the facts and carries it out. The refund
// itself is the one engine (lib/eventRefundServer), event price only.
//
// If the refund can't be sent, NOTHING is canceled: the family keeps the spot,
// the club is told, and nobody is left removed and still charged.

import { prisma } from "@/lib/prisma";
import { writeBillingAudit } from "@/lib/billingAudit";
import { CHARGE_MARGIN_MS, REFUND_POLICY_SELECT, chargeMayBeRunning, readRefundPolicy, selfCancelPlan, type SelfCancelPlan } from "@/lib/eventRefundPolicy";
import { centsText, refundFacts, refundFee, refundLeft, refundOptions } from "@/lib/eventRefunds";
import { loadRegistrationRefunds, refundEventRegistration } from "@/lib/eventRefundServer";

export type SelfCancel = {
  bookingId: string;
  memberId: string;
  who: string;
  eventId: string;
  eventName: string;
  plan: SelfCancelPlan;
  /** A person has to decide, and a card charge is still going to run. Staff are told. */
  scheduledLeft: boolean;
  /** The one live registration the plan is about, when there is exactly one. */
  reg: { id: string; status: string; amountDue: number | null; amountPaid: number; transactionId: string | null; refundedCents: number } | null;
};

export async function loadSelfCancel(clubId: string, bookingId: string, now: Date): Promise<SelfCancel | null> {
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, event: { clubId } },
    select: {
      id: true,
      memberId: true,
      eventId: true,
      event: { select: { name: true, pricingModel: true, memberPrice: true, nonMemberPrice: true, dropInFee: true, ...REFUND_POLICY_SELECT, club: { select: { timezone: true } } } },
      member: { select: { firstName: true, lastName: true } },
    },
  });
  if (!booking) return null;
  const tz = booking.event.club.timezone;
  const policy = readRefundPolicy(booking.event, tz);
  const rows = await prisma.eventRegistration.findMany({
    where: { clubId, eventId: booking.eventId, memberId: booking.memberId, status: { not: "CANCELED" }, OR: [{ approvalStatus: null }, { approvalStatus: { not: "DECLINED" } }] },
    select: { id: true, status: true, amountDue: true, amountPaid: true, transactionId: true, stripePaymentIntentId: true, scheduledChargeAt: true, lastChargeError: true },
  });
  const refunds = await loadRegistrationRefunds(clubId, rows, { withFailed: false });
  const read = rows.map((r) => {
    const f = refundFacts({ amountPaid: r.amountPaid, amountDue: r.amountDue, refundedCents: Math.round((refunds.get(r.id)?.refunded ?? 0) * 100) });
    return { r, f };
  });
  // Paid, but the price isn't recorded: "event price only" has no number, so a person decides.
  const unpriced = read.some(({ f }) => f.paidCents > 0 && f.priceCents == null);
  const plan = selfCancelPlan({
    policy: unpriced ? null : policy,
    now,
    tz,
    priced: booking.event.pricingModel === "SPLIT" || [booking.event.memberPrice, booking.event.nonMemberPrice, booking.event.dropInFee].some((p) => Number(p ?? 0) > 0),
    registrations: read.map(({ r, f }) => ({
      status: r.status,
      paidCents: f.paidCents,
      priceLeftCents: refundOptions(f).find((o) => o.mode === "price")?.cents ?? 0,
      leftCents: refundLeft(f),
      feeCents: refundFee(f),
      byCard: !!r.stripePaymentIntentId,
      charging: chargeMayBeRunning(r, now),
    })),
  });
  const only = read.length === 1 ? read[0] : null;
  return {
    bookingId: booking.id,
    memberId: booking.memberId,
    who: `${booking.member.firstName} ${booking.member.lastName ?? ""}`.trim(),
    eventId: booking.eventId,
    eventName: booking.event.name,
    plan,
    scheduledLeft: plan.kind === "LEGACY" && read.some(({ r, f }) => r.status === "SCHEDULED" && f.paidCents <= 0),
    reg: only
      ? { id: only.r.id, status: only.r.status, amountDue: only.r.amountDue == null ? null : Number(only.r.amountDue), amountPaid: Number(only.r.amountPaid ?? 0), transactionId: only.r.transactionId, refundedCents: only.f.refundedCents }
      : null,
  };
}

export type SelfCancelDone = { ok: boolean; refunded: boolean; message: string; staffMessage: string };

const REFUND_FAILED_FAMILY = "We couldn't send your refund just now, so nothing was canceled and you still have your spot. Your club has been told and will follow up.";

export async function runSelfCancel(c: SelfCancel, ctx: { clubId: string; actorUserId: string | null; reason: string | null }): Promise<SelfCancelDone> {
  const why = ctx.reason ? ` Reason: ${ctx.reason}` : "";
  const reg = c.reg;
  if (!reg && c.plan.kind === "NO_REFUND") {
    const freed = await prisma.booking.updateMany({ where: { id: c.bookingId, status: { not: "CANCELED" } }, data: { status: "CANCELED" } });
    if (freed.count > 0) {
      return { ok: true, refunded: false, message: "Canceled. No refund applies.", staffMessage: `${c.who} canceled their registration for "${c.eventName}" after the refund deadline. Nothing was refunded.${why}` };
    }
  }
  if (!reg) return { ok: false, refunded: false, message: "This booking couldn't be canceled. Please contact your club.", staffMessage: `${c.who} tried to cancel "${c.eventName}" and couldn't. Please follow up.${why}` };

  if (c.plan.kind === "REFUND") {
    const r = await refundEventRegistration({
      clubId: ctx.clubId,
      eventId: c.eventId,
      registrationId: reg.id,
      mode: "price",
      expectedRefundedCents: reg.refundedCents,
      actorUserId: ctx.actorUserId,
      remove: true,
      keepBooking: true,
      reason: "The family canceled before the refund deadline",
    });
    if (!r.ok) {
      return {
        ok: false,
        refunded: false,
        // Why it failed is the club's business (a low balance, say), so the
        // family gets what it means for them and the club gets the reason.
        message: REFUND_FAILED_FAMILY,
        staffMessage: `${c.who} tried to cancel "${c.eventName}" and is due ${centsText(c.plan.refundCents)} back, but the refund didn't go through. ${r.error} They are still registered.${why}`,
      };
    }
    return {
      ok: true,
      refunded: true,
      message: `Canceled. ${r.message}`,
      staffMessage: `${c.who} canceled their registration for "${c.eventName}" before the refund deadline. ${centsText(r.cents)} was refunded automatically.${why}`,
    };
  }

  // No money moves from here on. Claim the registration first, so two taps (or
  // a tap and a charge that just started) can't both act on it.
  const paid = reg.amountPaid > 0;
  const claimed = await prisma.eventRegistration.updateMany({
    where: {
      id: reg.id,
      clubId: ctx.clubId,
      status: reg.status,
      ...(paid ? {} : { stripePaymentIntentId: null }),
      // Checked again at the moment of the write: a charge that became due, or
      // ended without an answer, since they read the sheet is left alone.
      ...(!paid && reg.status === "SCHEDULED"
        ? { lastChargeError: null, OR: [{ scheduledChargeAt: null }, { scheduledChargeAt: { gt: new Date(Date.now() + CHARGE_MARGIN_MS) } }] }
        : {}),
    },
    data: { status: "CANCELED", paymentUrl: null, ...(paid ? {} : { amountDue: null, scheduledChargeAt: null, nextReminderAt: null }) },
  });
  if (claimed.count === 0) {
    return {
      ok: false,
      refunded: false,
      message: "This registration just changed, so nothing was canceled. Close this and look again.",
      staffMessage: `${c.who} tried to cancel "${c.eventName}" while it was changing. Nothing was canceled.${why}`,
    };
  }
  if (!paid && reg.transactionId) {
    // Their open cash/check record is money due, not money held.
    await prisma.transaction.updateMany({
      where: { id: reg.transactionId, clubId: ctx.clubId, status: "PENDING" },
      data: { status: "FAILED", reconciliationStatus: "VOID", notes: "Superseded: the family canceled this registration." },
    });
  }
  await prisma.booking.updateMany({ where: { id: c.bookingId }, data: { status: "CANCELED" } });
  await writeBillingAudit({
    clubId: ctx.clubId,
    memberId: c.memberId,
    actorUserId: ctx.actorUserId,
    action: "EVENT_REGISTRATION_CANCELED_BY_FAMILY",
    before: { registrationId: reg.id, status: reg.status, amountDue: reg.amountDue, amountPaid: reg.amountPaid },
    after: { registrationId: reg.id, status: "CANCELED", plan: c.plan.kind, refunded: false },
    note: `${c.who} canceled ${c.eventName}. ${c.plan.kind === "NO_REFUND" ? "No refund applies." : c.plan.kind === "RETURN_BY_HAND" ? `${centsText(c.plan.refundCents)} is due back by hand.` : "They had not been charged."}`,
  });
  if (c.plan.kind === "RETURN_BY_HAND") {
    return { ok: true, refunded: false, message: `Canceled. Your club will return ${centsText(c.plan.refundCents)} to you.`, staffMessage: `${c.who} canceled their registration for "${c.eventName}" before the refund deadline. They paid in cash or by check: return ${centsText(c.plan.refundCents)} and record it from the event's Removed list.${why}` };
  }
  if (c.plan.kind === "NO_REFUND") {
    return { ok: true, refunded: false, message: "Canceled. No refund applies.", staffMessage: `${c.who} canceled their registration for "${c.eventName}" after the refund deadline. Nothing was refunded.${why}` };
  }
  return { ok: true, refunded: false, message: "Canceled. You haven't been charged.", staffMessage: `${c.who} canceled their registration for "${c.eventName}". They had not been charged.${why}` };
}
