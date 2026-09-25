// B12 — change a LIVE Stripe membership from inside AthletixOS.
//
// Julian could not do this from Stripe: an Express connected account has no
// Customers tab, so the only route to "put Orson on 12 months at $150" was a
// hand-edit the local record never heard about. This is the in-app route:
//
//   preview  → what changes, when, and what it commits the member to
//   commit   → ONE Stripe call (subscriptions.update, no proration: the new
//              price starts on the next invoice), then the local mirror,
//              the commitment floor, an event and an audit line
//
// Rules the code enforces, not the owner's memory:
//   - same billing interval only. Monthly → quarterly needs a new
//     subscription (cancel this one at period end, activate the new setup);
//     Stripe would otherwise reset the billing cycle and prorate.
//   - never touches money already billed: proration_behavior "none".
//   - the commitment counts from the day the new price starts.

import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { billingPeriodToStripeInterval } from "@/lib/stripe";
import { ensureMembershipProduct } from "@/lib/stripeCatalog";
import { parseOptions, resolveTerms, type MembershipOption } from "@/lib/membershipOptions";
import { addUTCMonths, addBillingPeriod } from "@/lib/billingAdmin";
import {
  planChangeTerms,
  sameStripeInterval,
  unitAmountFor,
  baseFromUnitAmount,
  offlinePlanChange,
  switchLines,
} from "@/lib/stripePlanChange";
import { createSavedCardSubscription } from "@/lib/cardActivation";
import { feeBreakdown } from "@/lib/fees";
import { writeBillingAudit } from "@/lib/billingAudit";
import { recordSubscriptionEvent, SUBSCRIPTION_EVENT_KIND, SUBSCRIPTION_EVENT_SOURCE } from "@/lib/subscriptionEvents";
import { recomputeMemberStatus } from "@/lib/memberStatus";
import { siblingDiscountForPlanChange } from "@/lib/membershipSiblingServer";

const LIVE = new Set(["active", "trialing", "past_due", "unpaid"]);

export type PlanChangeError = { ok: false; code: string; error: string; status: number };

export type PlanChangePreview = {
  ok: true;
  subscription: { id: string; stripeSubscriptionId: string; stripeStatus: string };
  current: {
    planName: string | null; optionLabel: string; price: number; billingPeriod: string | null;
    /** What Stripe actually charges today (fee-inclusive), for the "before" line. */
    chargedTotal: number; feeFolded: boolean;
    cancelAt: Date | null; minimumTermEndsAt: Date | null; autoRenew: boolean;
  };
  target: {
    planId: string; planName: string; optionId: string; optionLabel: string; price: number; billingPeriod: string;
    fee: number; total: number; contractMonths: number | null;
  };
  /** The date the new price first bills — the current period end (trial end while trialing). */
  effectiveAt: Date;
  autoRenew: boolean;
  minimumTermEndsAt: Date | null;
  cancelAt: Date | null;
  /** True when the club price is unchanged and only terms move. */
  sameAmount: boolean;
  /** Plain sentences for the confirm dialog. */
  lines: string[];
};

type Ctx = {
  club: { id: string; name: string; stripeAccountId: string; stripeChargesEnabled: boolean; passProcessingFees: boolean };
  row: {
    id: string; memberId: string; membershipId: string | null; optionId: string | null; optionLabel: string;
    price: unknown; billingPeriod: string | null; autoRenew: boolean; minimumTermEndsAt: Date | null; endDate: Date | null;
    stripeSubscriptionId: string | null; status: string;
  };
  plan: { id: string; name: string; options: unknown; contractMonths: number | null; autoRenewDefault: boolean; description: string | null; clubId: string; stripeProductId: string | null; stripePriceIds: unknown };
  option: MembershipOption;
  /** The option's own price before PlanChangeInput.discount (B3 slice 2). */
  listPrice: number;
  sub: Stripe.Subscription;
};

/** B3 slice 2 — a discount carried onto the new price (the sibling
 *  membership discount, applied from its recommendation). */
export type PlanChangeDiscount = { source: "SIBLING"; type: "PERCENT" | "FIXED"; value: number; label: string };

function discountOption(option: MembershipOption, d: PlanChangeDiscount | null | undefined): MembershipOption {
  if (!d) return option;
  const cut = d.type === "PERCENT" ? (option.price * d.value) / 100 : d.value;
  return { ...option, price: Math.max(0, Math.round((option.price - cut) * 100) / 100) };
}

/** The discount columns for the row after a plan change: the discount carried
 *  in, or none — a plan change without one resets the row to the list price. */
function discountColumns(d: PlanChangeDiscount | null | undefined, listPrice: number, price: number) {
  return d
    ? { discountCode: null, discountSource: d.source, discountLabel: d.label, discountType: d.type, discountValue: d.value, discountAmount: Math.round((listPrice - price) * 100) / 100 }
    : { discountCode: null, discountSource: null, discountLabel: null, discountType: null, discountValue: null, discountAmount: null };
}

async function loadContext(input: { clubId: string; memberId: string; subscriptionId: string; optionId: string; allowIntervalChange?: boolean; discount?: PlanChangeDiscount | null }): Promise<Ctx | PlanChangeError> {
  const club = await prisma.club.findUnique({
    where: { id: input.clubId },
    select: { id: true, name: true, stripeAccountId: true, stripeChargesEnabled: true, passProcessingFees: true },
  });
  if (!club?.stripeAccountId || !club.stripeChargesEnabled) {
    return { ok: false, code: "STRIPE_NOT_CONNECTED", error: "Online payments aren't connected for this club.", status: 409 };
  }
  const stripeAccountId: string = club.stripeAccountId;
  const row = await prisma.memberSubscription.findFirst({
    where: { id: input.subscriptionId, memberId: input.memberId, member: { clubId: club.id, deletedAt: null } },
    select: {
      id: true, memberId: true, membershipId: true, optionId: true, optionLabel: true, price: true, billingPeriod: true,
      autoRenew: true, minimumTermEndsAt: true, endDate: true, stripeSubscriptionId: true, status: true,
    },
  });
  if (!row) return { ok: false, code: "NOT_FOUND", error: "Subscription not found.", status: 404 };
  if (!row.stripeSubscriptionId) {
    return { ok: false, code: "NOT_STRIPE", error: "This membership isn't billed through Stripe — change it with Edit on the profile instead.", status: 409 };
  }
  // Option ids are minted once and never reused, so the id alone says which
  // plan it belongs to — the target may be a different plan than the row's.
  const plans = await prisma.membership.findMany({
    where: { clubId: club.id, deletedAt: null },
    select: { id: true, name: true, options: true, contractMonths: true, autoRenewDefault: true, description: true, clubId: true, stripeProductId: true, stripePriceIds: true },
  });
  const plan = plans.find((p) => parseOptions(p.options).some((o) => o.id === input.optionId)) ?? null;
  if (!plan) return { ok: false, code: "OPTION_NOT_FOUND", error: "That option no longer exists on any plan.", status: 409 };
  const option = parseOptions(plan.options).find((o) => o.id === input.optionId)!;
  if (option.billingPeriod === "ONE_TIME" || option.price <= 0) {
    return { ok: false, code: "OPTION_NOT_RECURRING", error: "Only a recurring, priced option can go on a Stripe subscription.", status: 409 };
  }
  if (!input.allowIntervalChange && !sameStripeInterval(option.billingPeriod, row.billingPeriod)) {
    return {
      ok: false, code: "INTERVAL_CHANGE",
      error: `"${option.label}" bills ${option.billingPeriod.toLowerCase().replace("_", "-")} and this subscription bills ${String(row.billingPeriod ?? "").toLowerCase().replace("_", "-")}. Stripe can't switch the billing cycle in place without resetting and prorating it — turn auto-renew off so this one ends at its period end, then activate the new setup from the billing centre.`,
      status: 409,
    };
  }
  let sub: Stripe.Subscription;
  try {
    sub = await stripe.subscriptions.retrieve(
      row.stripeSubscriptionId,
      { expand: ["items.data.price", "default_payment_method"] },
      { stripeAccount: stripeAccountId },
    );
  } catch (e) {
    return { ok: false, code: "STRIPE_UNREACHABLE", error: `Stripe couldn't be read: ${String(e)}`, status: 502 };
  }
  if (!LIVE.has(sub.status)) {
    return { ok: false, code: "NOT_LIVE", error: `Stripe shows this subscription as ${sub.status} — there's nothing live to change.`, status: 409 };
  }
  if ((sub.items?.data?.length ?? 0) !== 1) {
    return { ok: false, code: "MULTI_ITEM", error: "This subscription has more than one line item in Stripe, which the in-app change doesn't handle.", status: 409 };
  }
  return { club: { ...club, stripeAccountId }, row, plan, option: discountOption(option, input.discount), listPrice: option.price, sub };
}

const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function buildPreview(ctx: Ctx, autoRenewOverride: boolean | null): PlanChangePreview {
  const { club, row, plan, option, sub } = ctx;
  const item = sub.items.data[0];
  const unit = item.price?.unit_amount ?? null;
  const inv = unit != null ? baseFromUnitAmount(unit, club.passProcessingFees) : { baseCents: Math.round(Number(row.price) * 100), feeFolded: false };
  // While trialing the first invoice is at trial end; otherwise the period end.
  const effectiveAt = new Date(((sub.status === "trialing" && sub.trial_end) || sub.current_period_end) * 1000);
  const terms = planChangeTerms({ effectiveAt, option, plan, autoRenew: autoRenewOverride, addMonths: addUTCMonths, addPeriod: addBillingPeriod });
  const fb = feeBreakdown(option.price, club.passProcessingFees);
  const sameAmount = inv.baseCents === Math.round(option.price * 100);
  const lines: string[] = [];
  lines.push(
    sameAmount
      ? `The charge stays $${fb.total.toFixed(2)}${club.passProcessingFees ? ` ($${option.price.toFixed(2)} + $${fb.fee.toFixed(2)} processing fee)` : ""}.`
      : `From ${fmt(effectiveAt)} the card is charged $${fb.total.toFixed(2)}${club.passProcessingFees ? ` ($${option.price.toFixed(2)} + $${fb.fee.toFixed(2)} processing fee)` : ""} instead of $${(unit != null ? unit / 100 : Number(row.price)).toFixed(2)}.`,
  );
  lines.push("Nothing is charged or refunded today — money already billed stays as it is.");
  if (terms.minimumTermEndsAt) lines.push(`${terms.contractMonths}-month commitment from ${fmt(effectiveAt)} to ${fmt(terms.minimumTermEndsAt)}.`);
  lines.push(terms.cancelAt ? `Billing ends automatically on ${fmt(terms.cancelAt)} — no renewal after that.` : "Keeps renewing until you cancel it.");
  return {
    ok: true,
    subscription: { id: row.id, stripeSubscriptionId: sub.id, stripeStatus: sub.status },
    current: {
      planName: null, optionLabel: row.optionLabel, price: inv.baseCents / 100, billingPeriod: row.billingPeriod,
      chargedTotal: unit != null ? unit / 100 : Number(row.price), feeFolded: inv.feeFolded,
      cancelAt: sub.cancel_at ? new Date(sub.cancel_at * 1000) : null, minimumTermEndsAt: row.minimumTermEndsAt, autoRenew: row.autoRenew,
    },
    target: {
      planId: plan.id, planName: plan.name, optionId: option.id!, optionLabel: option.label, price: option.price, billingPeriod: option.billingPeriod,
      fee: fb.fee, total: fb.total, contractMonths: resolveTerms(option, plan).contractMonths,
    },
    effectiveAt,
    autoRenew: terms.autoRenew,
    minimumTermEndsAt: terms.minimumTermEndsAt,
    cancelAt: terms.cancelAt,
    sameAmount,
    lines,
  };
}

export type PlanChangeInput = { clubId: string; memberId: string; subscriptionId: string; optionId: string; autoRenew: boolean | null; discount?: PlanChangeDiscount | null };

export async function previewPlanChange(input: PlanChangeInput): Promise<PlanChangePreview | PlanChangeError> {
  const ctx = await loadContext(input);
  if ("ok" in ctx) return ctx;
  return buildPreview(ctx, input.autoRenew);
}

export type PlanChangeResult =
  | { ok: true; preview: PlanChangePreview; message: string }
  | PlanChangeError;

export async function commitPlanChange(input: PlanChangeInput & { actorUserId: string }): Promise<PlanChangeResult> {
  const ctx = await loadContext(input);
  if ("ok" in ctx) return ctx;
  const { club, row, plan, option, sub } = ctx;
  const preview = buildPreview(ctx, input.autoRenew);
  const item = sub.items.data[0];

  // Same product as activations use, so every member on a plan shares one
  // Stripe Product; a cross-plan change moves to the new plan's product.
  let productId = await ensureMembershipProduct(
    { id: plan.id, clubId: plan.clubId, name: plan.name, description: plan.description, stripeProductId: plan.stripeProductId, stripePriceIds: plan.stripePriceIds },
    { id: club.id, stripeAccountId: club.stripeAccountId, stripeChargesEnabled: true },
  );
  if (!productId) {
    const existing = item.price?.product;
    productId = typeof existing === "string" ? existing : (existing as { id?: string } | null)?.id ?? null;
  }
  if (!productId) return { ok: false, code: "NO_PRODUCT", error: "Couldn't resolve a Stripe product for this plan.", status: 502 };

  const unitAmount = unitAmountFor(option.price, club.passProcessingFees);
  const interval = billingPeriodToStripeInterval(option.billingPeriod);
  if (!interval) return { ok: false, code: "OPTION_NOT_RECURRING", error: "That option isn't a recurring billing period.", status: 409 };
  const cancelAtUnix = preview.cancelAt ? Math.floor(preview.cancelAt.getTime() / 1000) : null;

  let updated: Stripe.Subscription;
  try {
    updated = await stripe.subscriptions.update(
      sub.id,
      {
        items: [{ id: item.id, price_data: { currency: "usd", product: productId, unit_amount: unitAmount, recurring: interval } }],
        // The new price starts on the next invoice. Nothing mid-cycle.
        proration_behavior: "none",
        // Explicit either way: a member moving OFF a fixed term must stop
        // being cut off on the old date.
        cancel_at: cancelAtUnix ?? "",
        cancel_at_period_end: false,
        metadata: { ...(sub.metadata ?? {}), memberSubscriptionId: row.id, memberId: row.memberId, optionId: option.id ?? "", planChangedAt: new Date().toISOString() },
      },
      { stripeAccount: club.stripeAccountId, idempotencyKey: `aox-plan-change-${row.id}-${option.id}-${unitAmount}-${cancelAtUnix ?? 0}-${sub.current_period_end}` },
    );
  } catch (e) {
    return { ok: false, code: "STRIPE_FAILED", error: `Stripe rejected the change — nothing was saved: ${String(e)}`, status: 502 };
  }

  const before = { optionId: row.optionId, optionLabel: row.optionLabel, price: Number(row.price), autoRenew: row.autoRenew, minimumTermEndsAt: row.minimumTermEndsAt, endDate: row.endDate, membershipId: row.membershipId };
  await prisma.memberSubscription.update({
    where: { id: row.id },
    data: {
      membershipId: plan.id,
      optionId: option.id,
      optionLabel: option.label,
      price: option.price,
      billingPeriod: option.billingPeriod,
      autoRenew: preview.autoRenew,
      minimumTermEndsAt: preview.minimumTermEndsAt,
      endDate: preview.cancelAt,
      stripeStatus: updated.status,
      stripePriceId: updated.items?.data?.[0]?.price?.id ?? null,
      stripeProductId: productId,
      currentPeriodEnd: updated.current_period_end ? new Date(updated.current_period_end * 1000) : null,
      ...discountColumns(input.discount, ctx.listPrice, option.price),
      notes: `${row.optionLabel} → ${option.label}${input.discount ? ` (${input.discount.label})` : ""} on ${new Date().toISOString().slice(0, 10)} (billing centre); new price from ${preview.effectiveAt.toISOString().slice(0, 10)}.`,
    },
  });
  if (row.membershipId !== plan.id) {
    await prisma.member.updateMany({ where: { id: row.memberId, clubId: club.id }, data: { membershipId: plan.id } });
  }
  await prisma.member.updateMany({ where: { id: row.memberId, clubId: club.id }, data: { billingUpdatedAt: new Date(), billingUpdatedById: input.actorUserId } });
  await recomputeMemberStatus(row.memberId, club.id);
  await recordSubscriptionEvent({
    clubId: club.id, memberSubscriptionId: row.id, memberId: row.memberId,
    kind: preview.sameAmount && row.optionId === option.id ? SUBSCRIPTION_EVENT_KIND.PRICE_CHANGE : SUBSCRIPTION_EVENT_KIND.PLAN_CHANGED,
    fromPlan: row.optionLabel, toPlan: option.label, fromAmount: String(before.price), toAmount: String(option.price),
    actorUserId: input.actorUserId, source: SUBSCRIPTION_EVENT_SOURCE.OWNER_ACTION,
    detail: { route: "billing-admin/actions change_stripe_plan", effectiveAt: preview.effectiveAt.toISOString(), cancelAt: preview.cancelAt?.toISOString() ?? null, unitAmount },
  });
  await writeBillingAudit({
    clubId: club.id, memberId: row.memberId, actorUserId: input.actorUserId,
    action: "STRIPE_PLAN_CHANGED",
    before,
    after: {
      optionId: option.id, optionLabel: option.label, price: option.price, unitAmount, autoRenew: preview.autoRenew,
      minimumTermEndsAt: preview.minimumTermEndsAt?.toISOString() ?? null, endDate: preview.cancelAt?.toISOString() ?? null,
      effectiveAt: preview.effectiveAt.toISOString(), stripeSubscriptionId: sub.id, membershipId: plan.id,
    },
    note: `"${row.optionLabel}" $${before.price.toFixed(2)} → "${option.label}" $${option.price.toFixed(2)} from ${fmt(preview.effectiveAt)}${preview.minimumTermEndsAt ? `, committed to ${fmt(preview.minimumTermEndsAt)}` : ""}${preview.cancelAt ? `, ends ${fmt(preview.cancelAt)}` : ", renews"}.`,
  });
  return {
    ok: true,
    preview,
    message: `Now on "${option.label}" — $${preview.target.total.toFixed(2)} from ${fmt(preview.effectiveAt)}${preview.cancelAt ? `, ends ${fmt(preview.cancelAt)}` : ""}.`,
  };
}


// ═══════════════════════════════════════════════════════════════════════════
// B13 slice 3 — Change plan for everyone
//
//   previewAnyPlanChange / commitAnyPlanChange pick the shape from the row:
//     no Stripe subscription          → OFFLINE (local, from the next payment)
//     Stripe, same billing interval   → SAME_INTERVAL (B12, unchanged)
//     Stripe, different interval      → SWITCH (end this one at period end,
//                                        start the new one that day, same card)
// ═══════════════════════════════════════════════════════════════════════════

export type PlanChangeKind = "SAME_INTERVAL" | "SWITCH" | "OFFLINE";

export type AnyPlanChangePreview = Omit<PlanChangePreview, "subscription"> & {
  kind: PlanChangeKind;
  subscription: { id: string; stripeSubscriptionId: string | null; stripeStatus: string | null };
};

type OfflineCtx = {
  club: { id: string; name: string };
  row: {
    id: string; memberId: string; membershipId: string | null; optionId: string | null; optionLabel: string; price: unknown;
    billingPeriod: string | null; autoRenew: boolean; minimumTermEndsAt: Date | null; endDate: Date | null;
    paidThroughDate: Date | null; currentPeriodEnd: Date | null; pausedAt: Date | null; status: string;
  };
  plan: { id: string; name: string; options: unknown; contractMonths: number | null; autoRenewDefault: boolean };
  option: MembershipOption;
  listPrice: number;
};

async function whichKind(input: { clubId: string; memberId: string; subscriptionId: string; optionId: string }): Promise<PlanChangeKind | PlanChangeError> {
  const row = await prisma.memberSubscription.findFirst({
    where: { id: input.subscriptionId, memberId: input.memberId, member: { clubId: input.clubId, deletedAt: null } },
    select: { stripeSubscriptionId: true, billingPeriod: true },
  });
  if (!row) return { ok: false, code: "NOT_FOUND", error: "Subscription not found.", status: 404 };
  if (!row.stripeSubscriptionId) return "OFFLINE";
  const plans = await prisma.membership.findMany({ where: { clubId: input.clubId, deletedAt: null }, select: { options: true } });
  const option = plans.flatMap((p) => parseOptions(p.options)).find((o) => o.id === input.optionId) ?? null;
  if (!option) return { ok: false, code: "OPTION_NOT_FOUND", error: "That option no longer exists on any plan.", status: 409 };
  return sameStripeInterval(option.billingPeriod, row.billingPeriod) ? "SAME_INTERVAL" : "SWITCH";
}

// ── OFFLINE ──────────────────────────────────────────────────────────────────

async function loadOffline(input: { clubId: string; memberId: string; subscriptionId: string; optionId: string; discount?: PlanChangeDiscount | null }): Promise<OfflineCtx | PlanChangeError> {
  const club = await prisma.club.findUnique({ where: { id: input.clubId }, select: { id: true, name: true } });
  if (!club) return { ok: false, code: "NOT_FOUND", error: "Club not found.", status: 404 };
  const row = await prisma.memberSubscription.findFirst({
    where: { id: input.subscriptionId, memberId: input.memberId, member: { clubId: club.id, deletedAt: null } },
    select: {
      id: true, memberId: true, membershipId: true, optionId: true, optionLabel: true, price: true, billingPeriod: true,
      autoRenew: true, minimumTermEndsAt: true, endDate: true, paidThroughDate: true, currentPeriodEnd: true,
      pausedAt: true, status: true, stripeSubscriptionId: true,
    },
  });
  if (!row) return { ok: false, code: "NOT_FOUND", error: "Subscription not found.", status: 404 };
  if (row.stripeSubscriptionId) return { ok: false, code: "IS_STRIPE", error: "This membership is billed through Stripe.", status: 409 };
  if (row.status !== "active" && row.status !== "past_due") {
    return { ok: false, code: "NOT_LIVE", error: "This membership isn't active — assign a new one instead.", status: 409 };
  }
  if (row.pausedAt) return { ok: false, code: "PAUSED", error: "This membership is paused. Resume it first, then change the plan.", status: 409 };
  const plans = await prisma.membership.findMany({
    where: { clubId: club.id, deletedAt: null },
    select: { id: true, name: true, options: true, contractMonths: true, autoRenewDefault: true },
  });
  const plan = plans.find((p) => parseOptions(p.options).some((o) => o.id === input.optionId)) ?? null;
  if (!plan) return { ok: false, code: "OPTION_NOT_FOUND", error: "That option no longer exists on any plan.", status: 409 };
  const option = parseOptions(plan.options).find((o) => o.id === input.optionId)!;
  if (option.billingPeriod === "ONE_TIME") {
    return { ok: false, code: "OPTION_NOT_RECURRING", error: "A one-time option can't replace a running membership — assign it as a new membership instead.", status: 409 };
  }
  return { club, row, plan, option: discountOption(option, input.discount), listPrice: option.price };
}

function offlinePreview(ctx: OfflineCtx, autoRenew: boolean | null, now: Date): AnyPlanChangePreview {
  const { row, plan, option } = ctx;
  const price = Number(row.price);
  const r = offlinePlanChange({
    row: { price, billingPeriod: row.billingPeriod, optionLabel: row.optionLabel, paidThroughDate: row.paidThroughDate, currentPeriodEnd: row.currentPeriodEnd },
    option, plan, autoRenew, now, addMonths: addUTCMonths, addPeriod: addBillingPeriod,
  });
  return {
    ok: true,
    kind: "OFFLINE",
    subscription: { id: row.id, stripeSubscriptionId: null, stripeStatus: null },
    current: {
      planName: null, optionLabel: row.optionLabel, price, billingPeriod: row.billingPeriod, chargedTotal: price, feeFolded: false,
      cancelAt: row.endDate, minimumTermEndsAt: row.minimumTermEndsAt, autoRenew: row.autoRenew,
    },
    target: {
      planId: plan.id, planName: plan.name, optionId: option.id!, optionLabel: option.label, price: option.price, billingPeriod: option.billingPeriod,
      fee: 0, total: option.price, contractMonths: resolveTerms(option, plan).contractMonths,
    },
    effectiveAt: r.effectiveAt,
    autoRenew: r.autoRenew,
    minimumTermEndsAt: r.minimumTermEndsAt,
    cancelAt: r.cancelAt,
    sameAmount: r.sameAmount,
    lines: r.lines,
  };
}

async function commitOffline(input: PlanChangeInput & { actorUserId: string }): Promise<AnyPlanChangeResult> {
  const ctx = await loadOffline(input);
  if ("ok" in ctx) return ctx;
  const { club, row, plan, option } = ctx;
  const preview = offlinePreview(ctx, input.autoRenew, new Date());
  const before = {
    optionId: row.optionId, optionLabel: row.optionLabel, price: Number(row.price), billingPeriod: row.billingPeriod,
    autoRenew: row.autoRenew, minimumTermEndsAt: row.minimumTermEndsAt, endDate: row.endDate, membershipId: row.membershipId,
  };
  await prisma.memberSubscription.update({
    where: { id: row.id },
    data: {
      membershipId: plan.id,
      optionId: option.id,
      optionLabel: option.label,
      price: option.price,
      billingPeriod: option.billingPeriod,
      autoRenew: preview.autoRenew,
      minimumTermEndsAt: preview.minimumTermEndsAt,
      endDate: preview.cancelAt,
      ...discountColumns(input.discount, ctx.listPrice, option.price),
      // paidThroughDate deliberately untouched: what was paid for stays paid for.
      notes: `${row.optionLabel} → ${option.label}${input.discount ? ` (${input.discount.label})` : ""} on ${new Date().toISOString().slice(0, 10)} (membership panel); new price from the next payment, ${preview.effectiveAt.toISOString().slice(0, 10)}.`,
    },
  });
  if (row.membershipId !== plan.id) {
    await prisma.member.updateMany({ where: { id: row.memberId, clubId: club.id }, data: { membershipId: plan.id } });
  }
  await prisma.member.updateMany({ where: { id: row.memberId, clubId: club.id }, data: { billingUpdatedAt: new Date(), billingUpdatedById: input.actorUserId } });
  await recomputeMemberStatus(row.memberId, club.id);
  const sameOption = row.optionId === option.id;
  await recordSubscriptionEvent({
    clubId: club.id, memberSubscriptionId: row.id, memberId: row.memberId,
    kind: sameOption ? SUBSCRIPTION_EVENT_KIND.PRICE_CHANGE : SUBSCRIPTION_EVENT_KIND.PLAN_CHANGED,
    fromPlan: row.optionLabel, toPlan: option.label, fromAmount: String(before.price), toAmount: String(option.price),
    actorUserId: input.actorUserId, source: SUBSCRIPTION_EVENT_SOURCE.OWNER_ACTION,
    detail: { route: "billing-admin/actions change_offline_plan", effectiveAt: preview.effectiveAt.toISOString(), endDate: preview.cancelAt?.toISOString() ?? null },
  });
  await writeBillingAudit({
    clubId: club.id, memberId: row.memberId, actorUserId: input.actorUserId,
    action: "OFFLINE_PLAN_CHANGED",
    before,
    after: {
      optionId: option.id, optionLabel: option.label, price: option.price, billingPeriod: option.billingPeriod, autoRenew: preview.autoRenew,
      minimumTermEndsAt: preview.minimumTermEndsAt?.toISOString() ?? null, endDate: preview.cancelAt?.toISOString() ?? null,
      effectiveAt: preview.effectiveAt.toISOString(), membershipId: plan.id,
    },
    note: preview.lines.join(" "),
  });
  return {
    ok: true,
    preview,
    message: `Now on "${option.label}" — $${option.price.toFixed(2)} from the next payment (${fmt(preview.effectiveAt)})${preview.cancelAt ? `, ends ${fmt(preview.cancelAt)}` : ""}.`,
  };
}

// ── SWITCH (Stripe, different billing cycle) ─────────────────────────────────

function cardOf(sub: Stripe.Subscription): { pmId: string | null; label: string | null } {
  const pm = sub.default_payment_method;
  if (!pm) return { pmId: null, label: null };
  if (typeof pm === "string") return { pmId: pm, label: null };
  const brand = pm.card?.brand ? pm.card.brand.charAt(0).toUpperCase() + pm.card.brand.slice(1) : null;
  return { pmId: pm.id, label: pm.card?.last4 ? `${brand ?? "Card"} ····${pm.card.last4}` : null };
}

/** Refusals specific to a switch, on top of loadContext's. */
function switchBlocked(ctx: Ctx, now: Date): PlanChangeError | null {
  const { sub } = ctx;
  const effectiveAt = new Date(((sub.status === "trialing" && sub.trial_end) || sub.current_period_end) * 1000);
  if (sub.pause_collection) {
    return { ok: false, code: "PAUSED", error: "Billing is paused on this subscription. Resume it first, then switch the plan.", status: 409 };
  }
  if (sub.status === "past_due" || sub.status === "unpaid") {
    return { ok: false, code: "PAST_DUE", error: "The last payment on this subscription failed. Settle it first — a switch would start the new plan on a card that isn't working.", status: 409 };
  }
  if (sub.cancel_at && sub.cancel_at * 1000 < effectiveAt.getTime() - 60_000) {
    return { ok: false, code: "ENDS_EARLIER", error: `This subscription already ends on ${fmt(new Date(sub.cancel_at * 1000))}, before its period end. Assign the new membership after it ends instead.`, status: 409 };
  }
  if (effectiveAt.getTime() < now.getTime() + 60 * 60_000) {
    return { ok: false, code: "TOO_SOON", error: "The current period ends within the hour. Try again after the renewal goes through.", status: 409 };
  }
  if (typeof sub.customer !== "string" && !sub.customer) {
    return { ok: false, code: "NO_CUSTOMER", error: "Stripe has no customer on this subscription.", status: 409 };
  }
  return null;
}

function switchPreview(ctx: Ctx, autoRenew: boolean | null): AnyPlanChangePreview {
  const base = buildPreview(ctx, autoRenew);
  const { club, row, option, sub } = ctx;
  const unit = sub.items.data[0]?.price?.unit_amount ?? null;
  const lines = switchLines({
    currentLabel: row.optionLabel,
    currentTotal: unit != null ? unit / 100 : Number(row.price),
    currentPeriod: row.billingPeriod,
    effectiveAt: base.effectiveAt,
    option,
    fee: base.target.fee,
    total: base.target.total,
    passProcessingFees: club.passProcessingFees,
    terms: { autoRenew: base.autoRenew, contractMonths: base.target.contractMonths, minimumTermEndsAt: base.minimumTermEndsAt, cancelAt: base.cancelAt },
    cardLabel: cardOf(sub).label,
  });
  return { ...base, kind: "SWITCH", lines, sameAmount: false };
}

async function commitSwitch(input: PlanChangeInput & { actorUserId: string }): Promise<AnyPlanChangeResult> {
  const ctx = await loadContext({ ...input, allowIntervalChange: true });
  if ("ok" in ctx) return ctx;
  const now = new Date();
  const blocked = switchBlocked(ctx, now);
  if (blocked) return blocked;
  const { club, row, plan, option, sub } = ctx;
  const preview = switchPreview(ctx, input.autoRenew);
  const effectiveAt = preview.effectiveAt;
  const effUnix = Math.floor(effectiveAt.getTime() / 1000);
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const { pmId } = cardOf(sub);
  const member = await prisma.member.findUnique({ where: { id: row.memberId }, select: { id: true, stripeSetupPaymentMethodId: true } });

  // Step 1 — the new subscription, trialing until the switch date so its first
  // charge IS the switch date. Created first: if step 2 then fails, this one
  // is canceled before it has ever charged, and the member is exactly where
  // they started. (The other order could leave them with no membership.)
  const created = await createSavedCardSubscription({
    member: { id: row.memberId, stripeSetupCustomerId: customerId, stripeSetupPaymentMethodId: pmId ?? member?.stripeSetupPaymentMethodId ?? null },
    startDate: effectiveAt,
    club: { id: club.id, stripeAccountId: club.stripeAccountId, passProcessingFees: club.passProcessingFees },
    membershipId: plan.id,
    planName: plan.name,
    optionLabel: option.label,
    optionId: option.id,
    price: option.price,
    period: option.billingPeriod,
    autoRenew: preview.autoRenew,
    minimumTermEndsAt: preview.minimumTermEndsAt,
    anchor: effectiveAt,
    cancelSource: preview.cancelAt,
    notes: `Switched from "${row.optionLabel}" (${row.billingPeriod ?? "?"}) on ${now.toISOString().slice(0, 10)}; starts ${effectiveAt.toISOString().slice(0, 10)} (membership panel).`,
    metadata: { memberId: row.memberId, clubId: club.id, membershipId: plan.id, optionId: option.id ?? "", switchedFromSubscription: sub.id },
    idempotencyPrefix: `aox-switch-${row.id}`,
  });
  if (!created.ok) {
    return { ok: false, code: created.code, error: `${created.error} The current plan was not changed.`, status: 502 };
  }

  // Step 2 — the current subscription ends on the switch date. No proration:
  // its last period is paid for and stays that way.
  try {
    await stripe.subscriptions.update(
      sub.id,
      { cancel_at: effUnix, cancel_at_period_end: false, proration_behavior: "none" },
      { stripeAccount: club.stripeAccountId, idempotencyKey: `aox-switch-end-${row.id}-${effUnix}-${created.stripeSubscriptionId}` },
    );
  } catch (e) {
    // Undo step 1. It is trialing and has charged nothing.
    let undone = true;
    try {
      await stripe.subscriptions.cancel(created.stripeSubscriptionId, {}, { stripeAccount: club.stripeAccountId });
    } catch (e2) {
      undone = false;
      console.error("[planSwitch] rollback cancel failed", created.stripeSubscriptionId, e2);
    }
    await prisma.memberSubscription.update({
      where: { id: created.memberSub.id },
      data: { status: "canceled", stripeStatus: undone ? "canceled" : created.stripeStatus, endDate: now, notes: `Rolled back — the old subscription couldn't be set to end: ${String(e)}` },
    });
    return {
      ok: false,
      code: "STRIPE_FAILED",
      error: undone
        ? `Stripe wouldn't set the current subscription to end, so the new one was canceled before it charged anything. Nothing changed. (${String(e)})`
        : `Stripe wouldn't set the current subscription to end, AND canceling the new one (${created.stripeSubscriptionId}) failed — cancel it in Stripe before ${fmt(effectiveAt)} or the card is charged twice. (${String(e)})`,
      status: 502,
    };
  }

  if (input.discount) {
    await prisma.memberSubscription.update({ where: { id: created.memberSub.id }, data: discountColumns(input.discount, ctx.listPrice, option.price) });
  }
  const before = { optionId: row.optionId, optionLabel: row.optionLabel, price: Number(row.price), billingPeriod: row.billingPeriod, autoRenew: row.autoRenew, endDate: row.endDate };
  await prisma.memberSubscription.update({
    where: { id: row.id },
    data: {
      endDate: effectiveAt,
      autoRenew: false,
      notes: `Ends ${effectiveAt.toISOString().slice(0, 10)} — switching to "${option.label}" (${created.stripeSubscriptionId}).`,
    },
  });
  await prisma.member.updateMany({ where: { id: row.memberId, clubId: club.id }, data: { billingUpdatedAt: new Date(), billingUpdatedById: input.actorUserId } });
  await recomputeMemberStatus(row.memberId, club.id);
  await recordSubscriptionEvent({
    clubId: club.id, memberSubscriptionId: row.id, memberId: row.memberId,
    kind: SUBSCRIPTION_EVENT_KIND.PLAN_CHANGED,
    fromPlan: row.optionLabel, toPlan: option.label, fromAmount: String(before.price), toAmount: String(option.price),
    actorUserId: input.actorUserId, source: SUBSCRIPTION_EVENT_SOURCE.OWNER_ACTION,
    detail: { route: "billing-admin/actions switch_stripe_plan", effectiveAt: effectiveAt.toISOString(), newMemberSubscriptionId: created.memberSub.id, newStripeSubscriptionId: created.stripeSubscriptionId },
  });
  await recordSubscriptionEvent({
    clubId: club.id, memberSubscriptionId: created.memberSub.id, memberId: row.memberId,
    kind: SUBSCRIPTION_EVENT_KIND.CREATED,
    fromPlan: row.optionLabel, toPlan: option.label, toAmount: String(option.price),
    actorUserId: input.actorUserId, source: SUBSCRIPTION_EVENT_SOURCE.OWNER_ACTION,
    detail: { route: "billing-admin/actions switch_stripe_plan", startsAt: effectiveAt.toISOString(), replacesMemberSubscriptionId: row.id },
  });
  await writeBillingAudit({
    clubId: club.id, memberId: row.memberId, actorUserId: input.actorUserId,
    action: "STRIPE_PLAN_SWITCHED",
    before: { ...before, stripeSubscriptionId: sub.id },
    after: {
      oldEndsAt: effectiveAt.toISOString(),
      newMemberSubscriptionId: created.memberSub.id,
      newStripeSubscriptionId: created.stripeSubscriptionId,
      optionId: option.id, optionLabel: option.label, price: option.price, billingPeriod: option.billingPeriod,
      autoRenew: preview.autoRenew, minimumTermEndsAt: preview.minimumTermEndsAt?.toISOString() ?? null, endDate: preview.cancelAt?.toISOString() ?? null,
    },
    note: preview.lines.join(" "),
  });
  return {
    ok: true,
    preview,
    message: `Switching on ${fmt(effectiveAt)}: "${row.optionLabel}" ends, "${option.label}" starts at $${preview.target.total.toFixed(2)} on the same card.`,
  };
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

export type AnyPlanChangeResult = { ok: true; preview: AnyPlanChangePreview; message: string } | PlanChangeError;

/** B3 slice 2 — unless the caller decided, a plan change carries the sibling
 *  membership discount the family still earns on the target option. */
async function withSibling<T extends PlanChangeInput>(input: T): Promise<T> {
  if (input.discount !== undefined) return input;
  return { ...input, discount: await siblingDiscountForPlanChange(input) };
}

export async function previewAnyPlanChange(rawInput: PlanChangeInput): Promise<AnyPlanChangePreview | PlanChangeError> {
  const input = await withSibling(rawInput);
  const p = await previewAnyPlanChangeInner(input);
  if (!p.ok || !input.discount) return p;
  return { ...p, lines: [`Includes the ${input.discount.label}: $${(p.target.price).toFixed(2)} instead of the list price.`, ...p.lines] };
}

async function previewAnyPlanChangeInner(input: PlanChangeInput): Promise<AnyPlanChangePreview | PlanChangeError> {
  const kind = await whichKind(input);
  if (typeof kind !== "string") return kind;
  if (kind === "OFFLINE") {
    const ctx = await loadOffline(input);
    if ("ok" in ctx) return ctx;
    return offlinePreview(ctx, input.autoRenew, new Date());
  }
  const ctx = await loadContext({ ...input, allowIntervalChange: kind === "SWITCH" });
  if ("ok" in ctx) return ctx;
  if (kind === "SWITCH") {
    const blocked = switchBlocked(ctx, new Date());
    if (blocked) return blocked;
    return switchPreview(ctx, input.autoRenew);
  }
  const p = buildPreview(ctx, input.autoRenew);
  return { ...p, kind: "SAME_INTERVAL" };
}

/** `expectedKind` is what the owner confirmed; a row that changed shape since the preview is refused, not reinterpreted. */
export async function commitAnyPlanChange(
  rawInput: PlanChangeInput & { actorUserId: string; expectedKind: PlanChangeKind },
): Promise<AnyPlanChangeResult> {
  const input = await withSibling(rawInput);
  const kind = await whichKind(input);
  if (typeof kind !== "string") return kind;
  if (kind !== input.expectedKind) {
    return { ok: false, code: "KIND_CHANGED", error: "This membership changed since the preview. Close the dialog and try again.", status: 409 };
  }
  if (kind === "OFFLINE") return commitOffline(input);
  if (kind === "SWITCH") return commitSwitch(input);
  const res = await commitPlanChange(input);
  if (!res.ok) return res;
  return { ok: true, message: res.message, preview: { ...res.preview, kind: "SAME_INTERVAL" } };
}
