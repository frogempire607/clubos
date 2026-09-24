import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission, requirePermissionLive } from "@/lib/apiGuard";
import { writeBillingAudit } from "@/lib/billingAudit";
import { MIGRATION_STATUS } from "@/lib/migration";
import { recomputeMemberStatus } from "@/lib/memberStatus";
import { turnAutopayOff, turnAutopayOn, setAutoRenew, previewAutopayChange } from "@/lib/autopay";
import {
  recordSubscriptionCreated,
  recordSubscriptionEvent,
  SUBSCRIPTION_EVENT_KIND,
  SUBSCRIPTION_EVENT_SOURCE,
} from "@/lib/subscriptionEvents";
import { stripe } from "@/lib/stripe";
import { createSavedCardSubscription } from "@/lib/cardActivation";
import { resolveDraftOptionId, addUTCMonths } from "@/lib/billingAdmin";
import { minimumTermEndForOptionId, parseOptions, resolveTerms } from "@/lib/membershipOptions";
import { resolveStaffDiscount, quotePayment } from "@/lib/staffPayments";
import { recordDiscountUse } from "@/lib/discounts";
import { sendMembershipActivatedEmail } from "@/lib/email";
import { getAppBaseUrl } from "@/lib/baseUrl";
import { syncOneSubscription } from "@/lib/stripeSync";
import { commitPlanChange } from "@/lib/stripePlanChangeServer";

// Discrete, confirmation-gated billing actions (billing:full). Each action is
// explicit, audited, and preserves history — nothing here deletes rows. The
// only actions that touch a live Stripe subscription are B12's
// change_stripe_plan (a price swap at the next invoice, never a charge) and
// sync_stripe (read-only against Stripe).

const schema = z.object({
  action: z.enum([
    "cancel_pending_activation",
    "reassign_subscription",
    "set_deliberate_free",
    "set_autopay",
    "set_auto_renew",
    "activate_card",
    "sync_stripe",
    "change_stripe_plan",
    // B13 slice 1
    "cancel_at_period_end",
    "keep_membership",
    "comp_membership",
  ]),
  confirm: z.literal(true, { errorMap: () => ({ message: "This action requires explicit confirmation." }) }),
  // reassign_subscription:
  subscriptionId: z.string().optional(),
  targetMemberId: z.string().optional(),
  // set_deliberate_free:
  deliberateFree: z.boolean().optional(),
  // set_autopay / set_auto_renew:
  autopay: z.boolean().optional(),
  autoRenew: z.boolean().optional(),
  reason: z.string().max(200).optional().nullable(),
  // activate_card: a first charge dated today/past runs NOW. Never silently —
  // the caller acknowledges it explicitly (the UI shows the amount and date).
  confirmImmediateCharge: z.boolean().optional().default(false),
  // change_stripe_plan (subscriptionId above): the option to move to, and an
  // optional auto-renew override (null = the option's own default).
  optionId: z.string().optional(),
  // cancel_at_period_end: the reason chip, optional (Reports' churn breakdown).
  cancelReason: z.string().max(60).optional().nullable(),
});

// GET ?subscriptionId=…&direction=on|off — the exact sentence the confirm
// dialog must show, computed from live values. Read-only; `billing:view`.
// A dialog that states the wrong charge is worse than one that states none, so
// this is recomputed at render time and never snapshotted.
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "billing", "view");
  if (denied) return denied;

  const url = new URL(req.url);
  const subscriptionId = url.searchParams.get("subscriptionId");
  const direction = url.searchParams.get("direction");
  if (!subscriptionId || (direction !== "on" && direction !== "off")) {
    return NextResponse.json({ error: "subscriptionId and direction are required." }, { status: 400 });
  }
  const owns = await prisma.memberSubscription.count({
    where: { id: subscriptionId, memberId: id, member: { clubId: session.user.clubId, deletedAt: null } },
  });
  if (!owns) return NextResponse.json({ error: "Subscription not found." }, { status: 404 });

  const preview = await previewAutopayChange(subscriptionId, session.user.clubId, direction);
  if (!preview) return NextResponse.json({ error: "Subscription not found." }, { status: 404 });
  return NextResponse.json(preview);
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "billing", "full");
  if (denied) return denied;

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    throw err;
  }

  const member = await prisma.member.findFirst({
    where: { id, clubId: session.user.clubId, deletedAt: null },
  });
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // activate_card — B9. Turn the saved setup into a REAL membership for a
  // member who pays by saved card: a Stripe subscription off that card,
  // first charge on the owner-approved date (or now, confirmed), ending on
  // the commitment date when the option doesn't renew. This is the
  // "authorized user explicitly activates the membership" the Edit modal has
  // promised since July; until now only migration approval could do it, and
  // only for members still mid-migration. Colton Waite was COMPLETED.
  if (data.action === "activate_card") {
    const club = await prisma.club.findUnique({
      where: { id: session.user.clubId },
      select: { id: true, name: true, stripeAccountId: true, stripeChargesEnabled: true, passProcessingFees: true },
    });
    if (!club?.stripeAccountId || !club.stripeChargesEnabled) {
      return NextResponse.json({ error: "Online payments aren't connected for this club — use “Already paid?” to bill offline." }, { status: 409 });
    }
    if (member.requestedPaymentMethod === "CASH" || member.requestedPaymentMethod === "CHECK") {
      return NextResponse.json(
        { error: "This member's payment method is cash/check. Record the payment with “Already paid?” instead — a card is never charged for an offline member.", code: "OFFLINE_INTENDED" },
        { status: 409 },
      );
    }
    if (!member.migrationMembershipId) {
      return NextResponse.json({ error: "Pick a plan and option in Edit first.", code: "PLAN_REQUIRED" }, { status: 409 });
    }
    const plan = await prisma.membership.findFirst({
      where: { id: member.migrationMembershipId, clubId: club.id, deletedAt: null },
      select: { id: true, name: true, options: true, autoRenewDefault: true, contractMonths: true },
    });
    if (!plan) return NextResponse.json({ error: "The plan on this setup no longer exists — pick another in Edit.", code: "PLAN_REQUIRED" }, { status: 409 });
    const options = parseOptions(plan.options);
    const optionId = resolveDraftOptionId(options, member.migrationSelectedOption);
    const option = optionId ? options.find((o) => o.id === optionId) ?? null : null;
    if (!option) {
      return NextResponse.json(
        { error: `The setup names an option ${plan.name} no longer sells. Re-pick the option in Edit, then activate.`, code: "OPTION_NOT_SELLABLE" },
        { status: 409 },
      );
    }
    // Price: option, then the owner's override (the reason the override exists).
    let price = option.price;
    if (member.migrationPriceOverride != null) price = Number(member.migrationPriceOverride);
    const period = option.billingPeriod;
    if (price <= 0) {
      return NextResponse.json({ error: "This setup is $0 — there is nothing to charge. Use “Already paid?” to record a free membership.", code: "FREE" }, { status: 409 });
    }
    let discount: { id: string; code: string; amountOff: number } | null = null;
    if (member.migrationDiscountCode) {
      const resolved = await resolveStaffDiscount(club.id, member.migrationDiscountCode, { type: "MEMBERSHIP", membershipId: plan.id });
      if (!resolved.ok) return NextResponse.json({ error: `The selected discount can't be applied: ${resolved.error}`, code: "DISCOUNT_INVALID" }, { status: 400 });
      if (resolved.discount) {
        const q = quotePayment({ originalPrice: price, discount: resolved.discount, method: "CASH", passProcessingFees: false });
        if (!q.ok) return NextResponse.json({ error: q.error, code: "DISCOUNT_INVALID" }, { status: 400 });
        discount = { id: resolved.discount.id, code: resolved.discount.code, amountOff: q.quote.discountAmount };
        price = q.quote.finalPrice;
      }
    }
    if (!member.stripeSetupCustomerId || !member.stripeSetupPaymentMethodId) {
      return NextResponse.json(
        { error: "No saved card on file. Use “Add method” to collect one, or switch the payment method to cash/check in Edit and record it with “Already paid?”.", code: "CARD_SETUP_INCOMPLETE" },
        { status: 409 },
      );
    }

    // Never a second live subscription. Local, then live against Stripe on
    // every customer id we know; the live check fails CLOSED.
    const localLive = await prisma.memberSubscription.findFirst({
      where: { memberId: member.id, stripeSubscriptionId: { not: null }, status: { in: ["active", "past_due"] }, canceledAt: null },
      select: { optionLabel: true },
    });
    if (localLive) {
      return NextResponse.json({ error: `A live card subscription ("${localLive.optionLabel}") already exists — activating again would bill them twice.`, code: "ALREADY_SUBSCRIBED" }, { status: 409 });
    }
    for (const custId of [member.stripeSetupCustomerId, member.stripeCustomerId]) {
      if (!custId) continue;
      try {
        const subs = await stripe.subscriptions.list({ customer: custId, status: "all", limit: 20 }, { stripeAccount: club.stripeAccountId });
        if (subs.data.some((x) => ["active", "trialing", "past_due", "unpaid"].includes(x.status))) {
          return NextResponse.json({ error: "Stripe shows a live subscription on this member already. Run a billing sync; nothing was created or charged.", code: "ALREADY_SUBSCRIBED" }, { status: 409 });
        }
      } catch (e) {
        console.error("activate_card: live-subscription preflight failed:", e);
        return NextResponse.json({ error: "Stripe couldn't be reached to verify existing billing. Nothing was charged — try again in a minute." }, { status: 502 });
      }
    }

    // First charge: the owner-approved final date, else the imported anchor;
    // today/past ⇒ charges now, and the caller must have said so.
    const anchorRaw = member.migrationFinalBillingDate ?? member.billingAnchorDate ?? null;
    const billsImmediately = !anchorRaw || anchorRaw.getTime() <= Date.now() + 60_000;
    if (billsImmediately && !data.confirmImmediateCharge) {
      return NextResponse.json(
        { error: "This would charge the saved card right now.", code: "IMMEDIATE_CHARGE_CONFIRM_REQUIRED", price },
        { status: 409 },
      );
    }
    const terms = resolveTerms(option, { contractMonths: plan.contractMonths, autoRenewDefault: plan.autoRenewDefault });
    const termEnd = minimumTermEndForOptionId(new Date(), options, option.id, { contractMonths: plan.contractMonths }, addUTCMonths);

    const activation = await createSavedCardSubscription({
      member: {
        id: member.id,
        stripeSetupCustomerId: member.stripeSetupCustomerId,
        stripeSetupPaymentMethodId: member.stripeSetupPaymentMethodId,
      },
      startDate: new Date(),
      club: { id: club.id, stripeAccountId: club.stripeAccountId, passProcessingFees: club.passProcessingFees },
      membershipId: plan.id,
      planName: plan.name,
      optionLabel: option.label,
      optionId: option.id,
      price,
      period,
      autoRenew: terms.autoRenewDefault,
      minimumTermEndsAt: termEnd,
      anchor: billsImmediately ? null : anchorRaw,
      cancelSource: member.commitmentEndDate ?? null,
      discount,
      notes: `Activated from the billing centre by staff on ${new Date().toISOString().slice(0, 10)} — saved card.`,
      metadata: { memberId: member.id, clubId: club.id, activatedBy: "billing-admin" },
      idempotencyPrefix: "aox-activate-card",
    });
    if (!activation.ok) {
      return NextResponse.json({ error: activation.error, code: activation.code }, { status: activation.code === "STRIPE_FAILED" ? 502 : 409 });
    }
    const memberSub = activation.memberSub;

    // A $0 offline placeholder (Wyatt Eastman's imported year) is superseded,
    // not stacked: the card row is the membership now. Priced offline rows are
    // left alone — money was recorded against them.
    const superseded = await prisma.memberSubscription.updateMany({
      where: { memberId: member.id, id: { not: memberSub.id }, status: "active", billingType: "MANUAL", stripeSubscriptionId: null, price: 0 },
      data: { status: "expired", expiredAt: new Date(), notes: `Superseded by card activation ${new Date().toISOString().slice(0, 10)}.` },
    });

    await recordSubscriptionCreated(memberSub, {
      clubId: club.id,
      source: SUBSCRIPTION_EVENT_SOURCE.OWNER_ACTION,
      actorUserId: session.user.id,
      detail: { route: "billing-admin/actions activate_card", billingType: "RECURRING" },
    });
    if (memberSub.status === "active") {
      await recordSubscriptionEvent({
        clubId: club.id, memberSubscriptionId: memberSub.id, memberId: member.id,
        kind: SUBSCRIPTION_EVENT_KIND.ACTIVATED, toPlan: memberSub.optionLabel, toAmount: String(memberSub.price),
        actorUserId: session.user.id, source: SUBSCRIPTION_EVENT_SOURCE.OWNER_ACTION,
        detail: { route: "billing-admin/actions activate_card" },
      });
    }
    await prisma.member.update({
      where: { id: member.id },
      data: {
        membershipId: plan.id,
        billingUpdatedAt: new Date(),
        billingUpdatedById: session.user.id,
      },
    });
    await recomputeMemberStatus(member.id, club.id);
    if (discount) await recordDiscountUse(discount.id);
    await writeBillingAudit({
      clubId: club.id, memberId: member.id, actorUserId: session.user.id,
      action: "MEMBERSHIP_ACTIVATED_CARD",
      before: { supersededOfflineRows: superseded.count },
      after: {
        subscriptionId: memberSub.id, stripeSubscriptionId: activation.stripeSubscriptionId,
        plan: plan.name, option: option.label, price, period,
        firstChargeAt: activation.firstChargeAt.toISOString(), chargedImmediately: activation.chargedImmediately,
        endsAt: activation.endsAt?.toISOString() ?? null, autoRenew: terms.autoRenewDefault,
      },
      note: activation.chargedImmediately
        ? `"${option.label}" activated on the saved card — $${price.toFixed(2)} charged now${activation.endsAt ? `, ends ${activation.endsAt.toISOString().slice(0, 10)}` : ""}.`
        : `"${option.label}" activated on the saved card — first charge $${price.toFixed(2)} on ${activation.firstChargeAt.toISOString().slice(0, 10)}${activation.endsAt ? `, ends ${activation.endsAt.toISOString().slice(0, 10)}` : ""}.`,
    });
    const toPaid = member.isMinor ? member.guardianEmail || member.email : member.email || member.guardianEmail;
    if (toPaid) {
      sendMembershipActivatedEmail({
        to: toPaid, firstName: member.firstName, clubName: club.name, membershipName: `${plan.name} — ${option.label}`,
        amountPaid: activation.chargedImmediately ? `$${price.toFixed(2)}` : undefined,
        nextBillingDate: activation.chargedImmediately ? null : activation.firstChargeAt,
        portalUrl: `${getAppBaseUrl()}/member`,
      }).catch((e) => console.error("Activation email failed:", e));
    }
    return NextResponse.json({
      ok: true,
      subscriptionId: memberSub.id,
      stripeSubscriptionId: activation.stripeSubscriptionId,
      stripeStatus: activation.stripeStatus,
      chargedImmediately: activation.chargedImmediately,
      firstChargeAt: activation.firstChargeAt,
      endsAt: activation.endsAt,
      message: activation.chargedImmediately
        ? `${member.firstName} is on "${option.label}" — $${price.toFixed(2)} charged to the saved card${activation.endsAt ? `, through ${activation.endsAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}` : ""}.`
        : `${member.firstName} is on "${option.label}" — first charge $${price.toFixed(2)} on ${activation.firstChargeAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}.`,
    });
  }

  // sync_stripe — B12. Pull ONE subscription's live facts from Stripe onto its
  // row: status, next billing date, card, and (new) price + option. Read-only
  // against Stripe. Same code path as the nightly reconcile.
  if (data.action === "sync_stripe") {
    if (!data.subscriptionId) return NextResponse.json({ error: "subscriptionId is required." }, { status: 400 });
    const row = await prisma.memberSubscription.findFirst({
      where: { id: data.subscriptionId, memberId: member.id },
      select: { id: true, stripeSubscriptionId: true, optionLabel: true, price: true },
    });
    if (!row) return NextResponse.json({ error: "Subscription not found." }, { status: 404 });
    if (!row.stripeSubscriptionId) return NextResponse.json({ error: "This membership isn't billed through Stripe — there is nothing to sync." }, { status: 409 });
    const res = await syncOneSubscription(session.user.clubId, row.stripeSubscriptionId);
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: 502 });
    const moved = res.mirror?.changed ?? [];
    return NextResponse.json({
      ok: true,
      stripeStatus: res.stripeStatus,
      currentPeriodEnd: res.currentPeriodEnd,
      changed: moved,
      mirror: res.mirror,
      message: moved.length
        ? `Synced — Stripe charges $${res.mirror!.price.toFixed(2)} ${String(res.mirror!.billingPeriod ?? "").toLowerCase()} ("${res.mirror!.optionLabel}"); the row said "${row.optionLabel}" $${Number(row.price).toFixed(2)}. Updated: ${moved.join(", ")}.${res.mirror!.resolution === "unmatched" ? " No plan option has that price, so the option is left unset." : ""}`
        : `Synced — Stripe agrees with the row (${res.stripeStatus}${res.currentPeriodEnd ? `, next billing ${res.currentPeriodEnd.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : ""}).`,
    });
  }

  // change_stripe_plan — B12. Move a live Stripe subscription to another
  // option of the same billing interval: price swap at the next invoice (no
  // proration), commitment recorded, cancel date set or cleared. The dialog
  // showed the preview from GET …/billing-admin/plan-change; this re-derives
  // everything from live values so a stale dialog can't commit stale terms.
  if (data.action === "change_stripe_plan") {
    if (!data.subscriptionId || !data.optionId) return NextResponse.json({ error: "subscriptionId and optionId are required." }, { status: 400 });
    const res = await commitPlanChange({
      clubId: session.user.clubId, memberId: member.id, subscriptionId: data.subscriptionId, optionId: data.optionId,
      autoRenew: data.autoRenew ?? null, actorUserId: session.user.id,
    });
    if (!res.ok) return NextResponse.json({ error: res.error, code: res.code }, { status: res.status });
    return NextResponse.json({ ok: true, message: res.message, preview: res.preview });
  }

  // cancel_at_period_end — B13. The cancel the panel offers by default: the
  // athlete keeps access to the end of what is paid, then nothing renews.
  // Stripe rows: cancel_at_period_end on the live subscription (the DELETE
  // route cancels immediately — that stays the "right now" path). Offline
  // rows: the end date becomes the paid-through date and the expiry sweep
  // does the rest. Recorded as CANCELED dated the effective day, so Reports
  // count the churn in the month it happens, not the month it was decided.
  if (data.action === "cancel_at_period_end" || data.action === "keep_membership") {
    if (!data.subscriptionId) return NextResponse.json({ error: "subscriptionId is required." }, { status: 400 });
    const row = await prisma.memberSubscription.findFirst({
      where: { id: data.subscriptionId, memberId: member.id, status: { in: ["active", "past_due"] } },
    });
    if (!row) return NextResponse.json({ error: "No live membership to change." }, { status: 404 });
    const club = await prisma.club.findUnique({ where: { id: session.user.clubId }, select: { stripeAccountId: true } });
    const keep = data.action === "keep_membership";

    let effective: Date | null = null;
    if (row.stripeSubscriptionId) {
      if (!club?.stripeAccountId) return NextResponse.json({ error: "Stripe isn't connected for this club." }, { status: 409 });
      try {
        const live = await stripe.subscriptions.retrieve(row.stripeSubscriptionId, {}, { stripeAccount: club.stripeAccountId });
        if (!["active", "trialing", "past_due", "unpaid"].includes(live.status)) {
          return NextResponse.json({ error: `Stripe shows this subscription as ${live.status} — nothing live to ${keep ? "keep" : "cancel"}. Run a sync.`, code: "NOT_LIVE" }, { status: 409 });
        }
        effective = new Date(((live.status === "trialing" && live.trial_end) || live.current_period_end) * 1000);
        await stripe.subscriptions.update(
          row.stripeSubscriptionId,
          keep ? { cancel_at_period_end: false, cancel_at: "" } : { cancel_at_period_end: true, metadata: { ...(live.metadata ?? {}), cancelReason: data.cancelReason ?? "" } },
          { stripeAccount: club.stripeAccountId },
        );
      } catch (e) {
        return NextResponse.json({ error: `Stripe rejected the change — nothing was saved: ${String(e)}` }, { status: 502 });
      }
    } else {
      effective = row.paidThroughDate ?? row.endDate ?? new Date();
      if (effective.getTime() < Date.now()) effective = new Date();
    }

    await prisma.memberSubscription.update({
      where: { id: row.id },
      data: keep
        ? { endDate: null, autoRenew: true, notes: `${row.notes ? row.notes + " " : ""}[Cancel undone ${new Date().toISOString().slice(0, 10)}]` }
        : { endDate: effective, autoRenew: false, notes: `${row.notes ? row.notes + " " : ""}[Cancels ${effective!.toISOString().slice(0, 10)}${data.cancelReason ? ` — ${data.cancelReason}` : ""}]` },
    });
    await recordSubscriptionEvent({
      clubId: session.user.clubId, memberSubscriptionId: row.id, memberId: member.id,
      kind: keep ? SUBSCRIPTION_EVENT_KIND.REACTIVATED : SUBSCRIPTION_EVENT_KIND.CANCELED,
      at: keep ? new Date() : effective!,
      fromPlan: row.optionLabel, fromAmount: String(row.price),
      actorUserId: session.user.id, source: SUBSCRIPTION_EVENT_SOURCE.OWNER_ACTION,
      detail: { route: `billing-admin/actions ${data.action}`, effectiveAt: effective!.toISOString(), reason: data.cancelReason ?? null, stripe: !!row.stripeSubscriptionId },
    });
    const eff = effective!.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    await writeBillingAudit({
      clubId: session.user.clubId, memberId: member.id, actorUserId: session.user.id,
      action: keep ? "MEMBERSHIP_CANCEL_UNDONE" : "MEMBERSHIP_CANCEL_SCHEDULED",
      before: { endDate: row.endDate, autoRenew: row.autoRenew },
      after: { endDate: keep ? null : effective, autoRenew: keep, reason: data.cancelReason ?? null },
      note: keep
        ? `"${row.optionLabel}" keeps renewing — the scheduled cancel was removed${row.stripeSubscriptionId ? " (Stripe cancel_at_period_end cleared)" : ""}.`
        : `"${row.optionLabel}" cancels on ${eff}${row.stripeSubscriptionId ? " — Stripe cancels at the period end, no further charges" : " — billed offline"}${data.cancelReason ? ` · ${data.cancelReason}` : ""}.`,
    });
    return NextResponse.json({
      ok: true, effectiveAt: effective,
      message: keep ? `${member.firstName}'s membership keeps renewing.` : `${member.firstName} keeps access until ${eff}; nothing renews after that.`,
    });
  }

  // comp_membership — B13. "Make it free" in one step. Offline rows: the same
  // row goes to $0, marked as a comp on purpose. Stripe rows: the card billing
  // ends at the period end (nothing refunded, nothing charged again) and a $0
  // comp row starts that day, so the athlete is never without a membership
  // and the paid period is never double-counted.
  if (data.action === "comp_membership") {
    if (!data.subscriptionId) return NextResponse.json({ error: "subscriptionId is required." }, { status: 400 });
    const row = await prisma.memberSubscription.findFirst({
      where: { id: data.subscriptionId, memberId: member.id, status: { in: ["active", "past_due"] } },
    });
    if (!row) return NextResponse.json({ error: "No live membership to comp." }, { status: 404 });
    if (Number(row.price) <= 0 && row.deliberateFree) return NextResponse.json({ ok: true, unchanged: true, message: "Already a comp." });
    const stamp = new Date().toISOString().slice(0, 10);

    if (row.stripeSubscriptionId) {
      const club = await prisma.club.findUnique({ where: { id: session.user.clubId }, select: { stripeAccountId: true } });
      if (!club?.stripeAccountId) return NextResponse.json({ error: "Stripe isn't connected for this club." }, { status: 409 });
      let periodEnd: Date;
      try {
        const live = await stripe.subscriptions.retrieve(row.stripeSubscriptionId, {}, { stripeAccount: club.stripeAccountId });
        if (!["active", "trialing", "past_due", "unpaid"].includes(live.status)) {
          return NextResponse.json({ error: `Stripe shows this subscription as ${live.status}. Run a sync, then comp the row it leaves behind.`, code: "NOT_LIVE" }, { status: 409 });
        }
        periodEnd = new Date(((live.status === "trialing" && live.trial_end) || live.current_period_end) * 1000);
        await stripe.subscriptions.update(row.stripeSubscriptionId, { cancel_at_period_end: true, metadata: { ...(live.metadata ?? {}), compedAt: stamp } }, { stripeAccount: club.stripeAccountId });
      } catch (e) {
        return NextResponse.json({ error: `Stripe rejected the change — nothing was saved: ${String(e)}` }, { status: 502 });
      }
      await prisma.memberSubscription.update({
        where: { id: row.id },
        data: { endDate: periodEnd, autoRenew: false, notes: `${row.notes ? row.notes + " " : ""}[Comped ${stamp} — card billing ends ${periodEnd.toISOString().slice(0, 10)}]` },
      });
      const compRow = await prisma.memberSubscription.create({
        data: {
          memberId: member.id, membershipId: row.membershipId, optionId: row.optionId, optionLabel: row.optionLabel,
          price: 0, billingPeriod: row.billingPeriod, billingType: "MANUAL", autoRenew: true, status: "active",
          startDate: periodEnd, deliberateFree: true,
          notes: `Comp from ${periodEnd.toISOString().slice(0, 10)} (card billing ended) — ${stamp}${data.reason ? `: ${data.reason}` : ""}.`,
        },
      });
      await recordSubscriptionCreated(compRow, { clubId: session.user.clubId, source: SUBSCRIPTION_EVENT_SOURCE.OWNER_ACTION, actorUserId: session.user.id, detail: { route: "billing-admin/actions comp_membership", replaces: row.id } });
      await recordSubscriptionEvent({
        clubId: session.user.clubId, memberSubscriptionId: row.id, memberId: member.id,
        kind: SUBSCRIPTION_EVENT_KIND.PRICE_CHANGE, fromPlan: row.optionLabel, toPlan: row.optionLabel, fromAmount: String(row.price), toAmount: "0",
        actorUserId: session.user.id, source: SUBSCRIPTION_EVENT_SOURCE.OWNER_ACTION,
        detail: { route: "billing-admin/actions comp_membership", cardBillingEndsAt: periodEnd.toISOString(), compRowId: compRow.id },
      });
      const eff = periodEnd.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
      await writeBillingAudit({
        clubId: session.user.clubId, memberId: member.id, actorUserId: session.user.id, action: "MEMBERSHIP_COMPED",
        before: { subscriptionId: row.id, price: Number(row.price) }, after: { cardBillingEndsAt: periodEnd, compRowId: compRow.id, reason: data.reason ?? null },
        note: `"${row.optionLabel}" comped — Stripe cancels at the period end (${eff}); a $0 comp membership starts that day.`,
      });
      await recomputeMemberStatus(member.id, session.user.clubId);
      return NextResponse.json({ ok: true, message: `${member.firstName}'s card billing ends ${eff}; the membership continues free from that day.` });
    }

    await prisma.memberSubscription.update({
      where: { id: row.id },
      data: { price: 0, deliberateFree: true, notes: `${row.notes ? row.notes + " " : ""}[Comped ${stamp}${data.reason ? ` — ${data.reason}` : ""}]` },
    });
    await recordSubscriptionEvent({
      clubId: session.user.clubId, memberSubscriptionId: row.id, memberId: member.id,
      kind: SUBSCRIPTION_EVENT_KIND.PRICE_CHANGE, fromPlan: row.optionLabel, toPlan: row.optionLabel, fromAmount: String(row.price), toAmount: "0",
      actorUserId: session.user.id, source: SUBSCRIPTION_EVENT_SOURCE.OWNER_ACTION, detail: { route: "billing-admin/actions comp_membership" },
    });
    await writeBillingAudit({
      clubId: session.user.clubId, memberId: member.id, actorUserId: session.user.id, action: "MEMBERSHIP_COMPED",
      before: { subscriptionId: row.id, price: Number(row.price), deliberateFree: row.deliberateFree }, after: { price: 0, deliberateFree: true, reason: data.reason ?? null },
      note: `"${row.optionLabel}" comped — $${Number(row.price).toFixed(2)} → $0, marked as a comp on purpose.`,
    });
    await recomputeMemberStatus(member.id, session.user.clubId);
    return NextResponse.json({ ok: true, message: `${member.firstName}'s membership is now free — comped on purpose.` });
  }

  if (data.action === "cancel_pending_activation") {
    // Cancel an incomplete pending activation WITHOUT deleting history: the
    // token stops working, approval state clears, and the member returns to
    // the imported pool. Events, requests, and any saved card stay intact.
    if (member.migrationStatus === MIGRATION_STATUS.COMPLETED) {
      return NextResponse.json({ error: "This migration is already complete — nothing pending to cancel." }, { status: 409 });
    }
    if (!member.activationToken && member.approvalStatus !== "PENDING_APPROVAL") {
      return NextResponse.json({ error: "No pending activation to cancel." }, { status: 409 });
    }
    const before = {
      migrationStatus: member.migrationStatus,
      approvalStatus: member.approvalStatus,
      hadActivationToken: !!member.activationToken,
    };
    await prisma.member.update({
      where: { id: member.id },
      data: {
        activationToken: null,
        activationTokenExpires: null,
        approvalStatus: null,
        migrationStatus: MIGRATION_STATUS.IMPORTED,
        billingUpdatedAt: new Date(),
        billingUpdatedById: session.user.id,
      },
    });
    // Any open reactivation offer dies with the pending activation.
    await prisma.membershipReactivation.updateMany({
      where: { memberId: member.id, clubId: member.clubId, status: { in: ["DRAFT", "SENT"] } },
      data: { status: "CANCELED" },
    });
    await writeBillingAudit({
      clubId: member.clubId,
      memberId: member.id,
      actorUserId: session.user.id,
      action: "PENDING_ACTIVATION_CANCELED",
      before,
      after: { migrationStatus: MIGRATION_STATUS.IMPORTED, approvalStatus: null, hadActivationToken: false },
      note: "Pending activation canceled — history preserved, token invalidated.",
    });
    await prisma.memberMigrationEvent.create({
      data: {
        clubId: member.clubId,
        memberId: member.id,
        type: "NOTE",
        message: "Pending activation canceled by staff — link invalidated; no billing was started.",
        actorUserId: session.user.id,
      },
    });
    return NextResponse.json({ ok: true });
  }

  // set_autopay — §8.6.3. The owner path executes immediately; the member path
  // queues (/api/member/subscriptions/[id]/autopay → the approvals queue).
  // Both land in the same two functions, so there is exactly one implementation
  // of what turning a card on or off means.
  if (data.action === "set_autopay") {
    if (!data.subscriptionId || data.autopay === undefined) {
      return NextResponse.json({ error: "subscriptionId and autopay are required." }, { status: 400 });
    }
    const owns = await prisma.memberSubscription.count({
      where: { id: data.subscriptionId, memberId: member.id },
    });
    if (!owns) return NextResponse.json({ error: "Subscription not found." }, { status: 404 });
    const actor = { userId: session.user.id, source: SUBSCRIPTION_EVENT_SOURCE.OWNER_ACTION };
    const result = data.autopay
      ? await turnAutopayOn(data.subscriptionId, session.user.clubId, actor)
      : await turnAutopayOff(data.subscriptionId, session.user.clubId, actor);
    if (!result.ok) {
      // 409 for "you cannot do that to this row", 502 for "Stripe would not".
      const status = result.code === "STRIPE_FAILED" ? 502 : 409;
      return NextResponse.json({ error: result.error, code: result.code }, { status });
    }
    await prisma.member.update({
      where: { id: member.id },
      data: { billingUpdatedAt: new Date(), billingUpdatedById: session.user.id },
    });
    return NextResponse.json({
      ok: true,
      direction: result.direction,
      effectiveAt: result.effectiveAt,
      message: result.message,
    });
  }

  // set_auto_renew — §8.6.4. Whether the membership CONTINUES, which is a
  // different question from who charges the card. Mapped to
  // cancel_at_period_end, never a recomputed absolute cancel_at.
  if (data.action === "set_auto_renew") {
    if (!data.subscriptionId || data.autoRenew === undefined) {
      return NextResponse.json({ error: "subscriptionId and autoRenew are required." }, { status: 400 });
    }
    const ownsRow = await prisma.memberSubscription.count({
      where: { id: data.subscriptionId, memberId: member.id },
    });
    if (!ownsRow) return NextResponse.json({ error: "Subscription not found." }, { status: 404 });
    const result = await setAutoRenew(data.subscriptionId, session.user.clubId, data.autoRenew, {
      userId: session.user.id,
      source: SUBSCRIPTION_EVENT_SOURCE.OWNER_ACTION,
    });
    if (!result.ok) {
      if (result.code === "UNCHANGED") return NextResponse.json({ ok: true, unchanged: true });
      const status = result.code === "STRIPE_FAILED" ? 502 : 409;
      return NextResponse.json({ error: result.error, code: result.code }, { status });
    }
    await prisma.member.update({
      where: { id: member.id },
      data: { billingUpdatedAt: new Date(), billingUpdatedById: session.user.id },
    });
    return NextResponse.json({ ok: true, effectiveAt: result.effectiveAt, message: result.message });
  }

  // set_deliberate_free — the club states that a $0 membership is a comp it
  // meant to give, not a leftover placeholder row. This is the ONLY writer of
  // MemberSubscription.deliberateFree; the flag is never inferred from the
  // price, because inferring it is precisely the bug that counted migration
  // artifacts as active members.
  if (data.action === "set_deliberate_free") {
    if (!data.subscriptionId || data.deliberateFree === undefined) {
      return NextResponse.json({ error: "subscriptionId and deliberateFree are required." }, { status: 400 });
    }
    const target = await prisma.memberSubscription.findFirst({
      where: { id: data.subscriptionId, memberId: member.id },
      include: { membership: { select: { clubId: true, name: true } } },
    });
    if (!target || target.membership.clubId !== session.user.clubId) {
      return NextResponse.json({ error: "Subscription not found." }, { status: 404 });
    }

    // On a priced row the flag changes nothing — a paid membership counts
    // when a payment lands, comp or not. Storing it there would leave staff
    // believing they had comped someone who is still expected to pay, which
    // is worse than refusing. Point at the control that actually does it.
    if (Number(target.price) > 0) {
      return NextResponse.json(
        {
          error:
            `This membership is ${Number(target.price).toFixed(2)}, not free. Marking it comped would change ` +
            `nothing — a priced membership counts once a payment is recorded. To actually give it away, set ` +
            `the price to $0 first (Edit billing → price override, or “Mark free”), then mark it deliberate.`,
          code: "NOT_A_FREE_MEMBERSHIP",
        },
        { status: 409 },
      );
    }

    if (target.deliberateFree === data.deliberateFree) {
      return NextResponse.json({ ok: true, unchanged: true });
    }

    const note = data.reason?.trim()
      ? `[${data.deliberateFree ? "Comped" : "Comp removed"} ${new Date().toISOString().slice(0, 10)}: ${data.reason.trim()}]`
      : `[${data.deliberateFree ? "Marked deliberate comp" : "Comp marker removed"} ${new Date().toISOString().slice(0, 10)}]`;

    await prisma.memberSubscription.update({
      where: { id: target.id },
      data: {
        deliberateFree: data.deliberateFree,
        notes: `${target.notes ? target.notes + " " : ""}${note}`,
      },
    });
    await prisma.member.update({
      where: { id: member.id },
      data: { billingUpdatedAt: new Date(), billingUpdatedById: session.user.id },
    });

    // The flag decides whether this row counts as a membership at all, so
    // the member's stored status must be recomputed in the same breath —
    // otherwise the roster keeps yesterday's answer until something else
    // happens to touch them.
    await recomputeMemberStatus(member.id, session.user.clubId);
    const after = await prisma.member.findUnique({
      where: { id: member.id },
      select: { status: true },
    });
    const status = after?.status ?? member.status;

    await writeBillingAudit({
      clubId: session.user.clubId,
      memberId: member.id,
      actorUserId: session.user.id,
      action: data.deliberateFree ? "MEMBERSHIP_COMPED" : "MEMBERSHIP_COMP_REMOVED",
      before: { subscriptionId: target.id, deliberateFree: target.deliberateFree },
      after: { subscriptionId: target.id, deliberateFree: data.deliberateFree, memberStatus: status },
      note: data.deliberateFree
        ? `"${target.optionLabel}" marked a deliberate $0 membership${data.reason?.trim() ? ` — ${data.reason.trim()}` : ""}.`
        : `"${target.optionLabel}" is no longer marked a deliberate $0 membership${data.reason?.trim() ? ` — ${data.reason.trim()}` : ""}.`,
    });

    return NextResponse.json({ ok: true, deliberateFree: data.deliberateFree, memberStatus: status });
  }

  // reassign_subscription — move a NON-Stripe (manual/pending) subscription to
  // the correct athlete. Live Stripe subscriptions are deliberately blocked:
  // repointing those means Stripe customer surgery and is never done silently.
  if (!data.subscriptionId || !data.targetMemberId) {
    return NextResponse.json({ error: "subscriptionId and targetMemberId are required." }, { status: 400 });
  }
  const sub = await prisma.memberSubscription.findFirst({
    where: { id: data.subscriptionId, memberId: member.id },
    include: { membership: { select: { clubId: true, name: true } } },
  });
  if (!sub || sub.membership.clubId !== session.user.clubId) {
    return NextResponse.json({ error: "Subscription not found." }, { status: 404 });
  }
  if (sub.stripeSubscriptionId) {
    // Phase 4A replaced the old blanket 409 here.
    //
    // This action still refuses live Stripe subs, but the reason changed: it is
    // no longer "you can't do this", it is "there is a purpose-built flow that
    // does it safely". This endpoint's reassign is a bare FK repoint with no
    // preview, no eligibility check, no usage snapshot, and no record of what
    // the actor understood about the money — fine for a MANUAL/pending row,
    // unacceptable for one Stripe is actively charging.
    //
    // The transfer endpoint moves the beneficiary while deliberately leaving
    // the Stripe subscription, customer and card alone, and stores the exact
    // sentence the actor confirmed. Telling staff to cancel and re-create (the
    // old advice) would have ended the billing relationship and destroyed the
    // original receipt.
    return NextResponse.json(
      {
        error:
          "This membership is live in Stripe. Use “Assign to another family member” on the " +
          "membership instead — it moves the athlete while leaving the payment, card and receipt " +
          "exactly as they are.",
        code: "USE_TRANSFER_FLOW",
        transferUrl: `/api/member-subscriptions/${sub.id}/transfer`,
      },
      { status: 409 },
    );
  }
  const target = await prisma.member.findFirst({
    where: { id: data.targetMemberId, clubId: session.user.clubId, deletedAt: null },
    select: { id: true, firstName: true, lastName: true },
  });
  if (!target) return NextResponse.json({ error: "Target athlete not found." }, { status: 404 });
  if (target.id === member.id) {
    return NextResponse.json({ error: "That subscription already belongs to this athlete." }, { status: 400 });
  }

  await prisma.memberSubscription.update({
    where: { id: sub.id },
    data: {
      memberId: target.id,
      notes: `${sub.notes ? sub.notes + " " : ""}[Reassigned from ${member.firstName} ${member.lastName} on ${new Date().toISOString().slice(0, 10)}]`,
    },
  });
  await prisma.member.update({
    where: { id: member.id },
    data: { billingUpdatedAt: new Date(), billingUpdatedById: session.user.id },
  });
  await writeBillingAudit({
    clubId: session.user.clubId,
    memberId: member.id,
    actorUserId: session.user.id,
    action: "SUBSCRIPTION_REASSIGNED",
    before: { subscriptionId: sub.id, memberId: member.id, plan: sub.membership.name },
    after: { subscriptionId: sub.id, memberId: target.id, targetName: `${target.firstName} ${target.lastName}` },
    note: `Membership "${sub.optionLabel}" reassigned to ${target.firstName} ${target.lastName}.`,
  });
  return NextResponse.json({ ok: true });
}
