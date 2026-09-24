// B13 — the Membership panel's one derivation.
//
// Every sentence on the panel (docs/improvement/design_handoff_membership_panel)
// comes from here: which row is "current", what state that puts the athlete
// in, the headline, the money line, the facts, and which actions are offered.
// Pure — the route gathers, this decides, the component renders. Tests in
// scripts/membership-panel-tests.ts.
//
// The pill and the sentences read the active MemberSubscription row, never
// Member.status (B1: status is a label). PAUSED is the one exception — it is
// the owner-set sticky label, and the row carries no pause date until the
// slice-2 migration, so the label is what we have.

import { feeBreakdown } from "@/lib/fees";
import { prettyPeriod } from "@/lib/billingAdmin";

export type PanelSub = {
  id: string;
  planName: string | null;
  optionLabel: string;
  price: number;
  billingPeriod: string | null;
  billingType: string;
  status: string;
  stripeStatus: string | null;
  hasStripe: boolean;
  startDate: Date | null;
  endDate: Date | null;
  currentPeriodEnd: Date | null;
  paidThroughDate: Date | null;
  autoRenew: boolean;
  minimumTermEndsAt: Date | null;
  deliberateFree: boolean;
  /** Stripe cancel_at from the snapshot, when known. */
  cancelAt: Date | null;
  card: { brand: string | null; last4: string | null } | null;
  createdAt: Date;
  /** B13 slice 2 — set while paused; `pausedUntil` null = open-ended. */
  pausedAt: Date | null;
  pausedUntil: Date | null;
};

export type PanelInput = {
  firstName: string;
  memberStatus: string;
  subs: PanelSub[];
  /** The saved setup (migration draft), when a plan is chosen and no row exists. */
  draft: { planName: string; optionLabel: string | null; price: number | null; period: string | null; offerSentAt: Date | null } | null;
  hasCard: boolean;
  cardLabel: string | null;
  requestedPaymentMethod: string | null;
  payerName: string | null;
  passProcessingFees: boolean;
  now: Date;
};

export type PanelState = "ACTIVE_STRIPE" | "ACTIVE_OFFLINE" | "PAST_DUE" | "PAUSED" | "PENDING" | "NONE";

export type PanelAction =
  | "change_plan" | "change_dates" | "pause" | "resume" | "cancel" | "keep" | "record_payment"
  | "activate" | "send_offer" | "edit_setup" | "cancel_setup" | "assign"
  | "sync_stripe" | "transfer" | "comp" | "retry_payment";

export type PanelView = {
  state: PanelState;
  pill: { tone: "ok" | "warn" | "pend" | "bad" | "none"; label: string };
  headline: string;
  moneyLine: string;
  committedThrough: Date | null;
  /** True when the current row has an end date and won't renew (a scheduled cancel or a fixed term). */
  ending: Date | null;
  facts: { paysWith: string; started: Date | null; renews: string; payer: string | null } | null;
  actions: { primary: PanelAction; others: PanelAction[]; more: PanelAction[] };
  currentSubId: string | null;
  /** An active row that starts in the future (e.g. the comp row after a Stripe cancel). */
  upcoming: { label: string; from: Date } | null;
  lastMembership: { label: string; endedAt: Date | null } | null;
};

export const ACTION_LABELS: Record<PanelAction, string> = {
  change_plan: "Change plan", change_dates: "Change dates", pause: "Pause", resume: "Resume", cancel: "Cancel", keep: "Keep membership",
  record_payment: "Record payment", activate: "Activate now", send_offer: "Send offer", edit_setup: "Edit setup", cancel_setup: "Cancel setup",
  assign: "Assign membership", sync_stripe: "Sync from Stripe", transfer: "Transfer to another athlete", comp: "Make it free", retry_payment: "Retry payment",
};

const LIVE_STRIPE = new Set(["active", "trialing", "past_due", "unpaid"]);
const money = (n: number) => `$${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`;
const money2 = (n: number) => `$${n.toFixed(2)}`;
const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function subLabel(s: PanelSub): string {
  return s.planName && s.planName !== s.optionLabel ? `${s.planName} · ${s.optionLabel}` : s.optionLabel;
}

/** The row the panel is about: the active row that has started, latest start first. */
export function pickCurrent(subs: PanelSub[], now: Date): { current: PanelSub | null; upcoming: PanelSub | null; pending: PanelSub | null } {
  const active = subs.filter((s) => s.status === "active" || s.status === "past_due");
  const started = active.filter((s) => !s.startDate || s.startDate.getTime() <= now.getTime());
  const future = active.filter((s) => s.startDate && s.startDate.getTime() > now.getTime());
  const byStart = (a: PanelSub, b: PanelSub) => (b.startDate?.getTime() ?? 0) - (a.startDate?.getTime() ?? 0) || b.createdAt.getTime() - a.createdAt.getTime();
  started.sort(byStart);
  future.sort((a, b) => (a.startDate!.getTime() - b.startDate!.getTime()));
  const pending = subs.filter((s) => s.status === "pending").sort(byStart)[0] ?? null;
  return { current: started[0] ?? null, upcoming: future[0] ?? null, pending };
}

export function derivePanel(input: PanelInput): PanelView {
  const { now } = input;
  const { current, upcoming, pending } = pickCurrent(input.subs, now);
  const payer = input.payerName;
  const paysWithFor = (s: PanelSub) =>
    s.hasStripe
      ? s.card?.last4 ? `${cap(s.card.brand ?? "Card")} ····${s.card.last4}` : input.cardLabel ?? "Card on file"
      : s.price <= 0 ? "Free" : "Cash / check";

  // A past membership, for the empty state's "Last:" line and Assign's default.
  const past = input.subs
    .filter((s) => s.status !== "active" && s.status !== "pending" && s.status !== "past_due")
    .sort((a, b) => (b.endDate?.getTime() ?? b.createdAt.getTime()) - (a.endDate?.getTime() ?? a.createdAt.getTime()));
  const lastMembership = past[0]
    ? { label: `${subLabel(past[0])} · ${past[0].price <= 0 ? "Free" : `${money(past[0].price)} ${prettyPeriod(past[0].billingPeriod)}`}`, endedAt: past[0].endDate }
    : null;

  const upcomingView = upcoming ? { label: upcoming.price <= 0 ? "Free" : `${subLabel(upcoming)} · ${money(upcoming.price)} ${prettyPeriod(upcoming.billingPeriod)}`, from: upcoming.startDate! } : null;

  // ── PAUSED — the row's pause (slice 2), or the owner label from before it ──
  if (current && (current.pausedAt || input.memberStatus === "PAUSED")) {
    const since = current.pausedAt;
    const until = current.pausedUntil;
    const moneyLine = since
      ? `Paused since ${fmt(since)} · ${until ? `resumes ${fmt(until)}` : "until you resume it"}${current.hasStripe ? " · card billing paused" : current.paidThroughDate ? ` · paid-through moves out by the paused days` : ""}`
      : current.hasStripe
        ? "Paused (roster label) · card billing continues — use Resume, then Pause again to pause billing too"
        : "Paused (roster label) · until you resume it";
    return {
      state: "PAUSED",
      pill: { tone: "warn", label: until ? `Paused · until ${fmt(until)}` : "Paused" },
      headline: subLabel(current),
      moneyLine,
      committedThrough: futureOrNull(current.minimumTermEndsAt, now),
      ending: current.endDate,
      facts: { paysWith: paysWithFor(current), started: current.startDate, renews: until ? `Resumes ${fmt(until)}` : "Paused", payer },
      actions: { primary: "resume", others: ["change_dates", "cancel"], more: ["transfer"] },
      currentSubId: current.id,
      upcoming: upcomingView,
      lastMembership,
    };
  }

  // ── Active on Stripe ──
  if (current && current.hasStripe) {
    const pastDue = current.status === "past_due" || current.stripeStatus === "past_due" || current.stripeStatus === "unpaid";
    const stripeLive = !current.stripeStatus || LIVE_STRIPE.has(current.stripeStatus);
    const charged = input.passProcessingFees ? feeBreakdown(current.price, true).total : current.price;
    const ending = current.cancelAt ?? (current.autoRenew ? null : current.endDate);
    const next = current.currentPeriodEnd;
    let moneyLine: string;
    if (current.price <= 0) moneyLine = current.deliberateFree ? "Free — comped on purpose" : "$0 — not marked as a comp";
    else if (pastDue) moneyLine = `${money2(charged)} ${prettyPeriod(current.billingPeriod)} · last payment failed — Stripe is retrying`;
    else if (ending && next && ending.getTime() <= next.getTime() + 86400000) moneyLine = `${money2(charged)} ${prettyPeriod(current.billingPeriod)} on the saved card · ends ${fmt(ending)} — no renewal`;
    else if (ending) moneyLine = `${money2(charged)} ${prettyPeriod(current.billingPeriod)} on the saved card${next ? ` · next charge ${fmt(next)}` : ""} · ends ${fmt(ending)}`;
    else moneyLine = `${money2(charged)} ${prettyPeriod(current.billingPeriod)} on the saved card${next ? ` · next charge ${fmt(next)}` : !stripeLive ? ` · Stripe: ${current.stripeStatus}` : ""}`;
    const others: PanelAction[] = pastDue ? ["change_plan", "cancel"] : ending ? ["keep", "change_dates", "pause"] : ["change_dates", "pause", "cancel"];
    return {
      state: pastDue ? "PAST_DUE" : "ACTIVE_STRIPE",
      pill: pastDue ? { tone: "bad", label: "Past due" } : ending ? { tone: "warn", label: `Ends ${fmt(ending)}` } : { tone: "ok", label: "Active" },
      headline: subLabel(current),
      moneyLine,
      committedThrough: futureOrNull(current.minimumTermEndsAt, now),
      ending,
      facts: { paysWith: paysWithFor(current), started: current.startDate, renews: ending ? `No — ends ${fmt(ending)}` : "Yes · auto", payer },
      actions: { primary: pastDue ? "retry_payment" : "change_plan", others, more: ["sync_stripe", "transfer", "comp"] },
      currentSubId: current.id,
      upcoming: upcomingView,
      lastMembership,
    };
  }

  // ── Active offline (cash / check / free) ──
  if (current) {
    const paidTo = current.paidThroughDate ?? current.endDate;
    const overdue = paidTo ? paidTo.getTime() < now.getTime() : false;
    const ending = current.autoRenew ? null : current.endDate;
    const free = current.price <= 0;
    const method = input.requestedPaymentMethod === "CHECK" ? "check" : "cash";
    const moneyLine = free
      ? current.deliberateFree ? "Free — comped on purpose" : "$0 — not marked as a comp (a leftover placeholder or a real comp?)"
      : `${money(current.price)} ${prettyPeriod(current.billingPeriod)}, paid by ${method}${paidTo ? ` · ${overdue ? "was paid through" : "paid through"} ${fmt(paidTo)}` : ""}${ending && ending !== paidTo ? ` · ends ${fmt(ending)}` : ""}`;
    return {
      state: "ACTIVE_OFFLINE",
      pill: overdue && !free ? { tone: "warn", label: "Payment due" } : { tone: "ok", label: "Active" },
      headline: subLabel(current),
      moneyLine,
      committedThrough: futureOrNull(current.minimumTermEndsAt, now),
      ending,
      facts: { paysWith: paysWithFor(current), started: current.startDate, renews: free ? "—" : ending ? `No — ends ${fmt(ending)}` : "When paid", payer },
      actions: {
        primary: free ? "change_plan" : "record_payment",
        others: free ? ["change_dates", "cancel"] : ["change_plan", "change_dates", "pause", "cancel"],
        more: free ? ["transfer"] : ["transfer", "comp"],
      },
      currentSubId: current.id,
      upcoming: upcomingView,
      lastMembership,
    };
  }

  // ── Pending: a row waiting on payment/approval, or a saved setup ──
  if (pending || input.draft) {
    const label = pending ? subLabel(pending) : `${input.draft!.planName}${input.draft!.optionLabel ? ` · ${input.draft!.optionLabel}` : ""}`;
    const price = pending ? pending.price : input.draft!.price;
    const period = pending ? pending.billingPeriod : input.draft!.period;
    const moneyLine = pending
      ? `Purchase in progress — ${price != null && price > 0 ? `${money(price)} ${prettyPeriod(period)} · ` : ""}not charged yet · activates when payment completes or staff approves`
      : `Setup saved — ${price != null ? `${money(price)} ${prettyPeriod(period)} · ` : ""}not active yet${input.hasCard ? " · card on file" : input.requestedPaymentMethod === "CASH" || input.requestedPaymentMethod === "CHECK" ? " · pays by cash/check" : " · no card yet"}${input.draft!.offerSentAt ? ` · offer sent ${fmt(input.draft!.offerSentAt)}` : ""}`;
    return {
      state: "PENDING",
      pill: { tone: "pend", label: "Pending" },
      headline: label,
      moneyLine,
      committedThrough: null,
      ending: null,
      facts: { paysWith: input.hasCard ? input.cardLabel ?? "Card on file" : input.requestedPaymentMethod === "CASH" || input.requestedPaymentMethod === "CHECK" ? "Cash / check" : "No card on file", started: null, renews: "—", payer },
      actions: { primary: "activate", others: ["send_offer", "edit_setup", "cancel_setup"], more: [] },
      currentSubId: pending?.id ?? null,
      upcoming: upcomingView,
      lastMembership,
    };
  }

  // ── None ──
  return {
    state: "NONE",
    pill: { tone: "none", label: "No membership" },
    headline: "No membership",
    moneyLine: lastMembership ? `Last: ${lastMembership.label}${lastMembership.endedAt ? ` · ended ${fmt(lastMembership.endedAt)}` : ""}` : `${input.firstName} has never had a membership here.`,
    committedThrough: null,
    ending: null,
    facts: null,
    actions: { primary: "assign", others: [], more: [] },
    currentSubId: null,
    upcoming: upcomingView,
    lastMembership,
  };
}

function futureOrNull(d: Date | null, now: Date): Date | null {
  return d && d.getTime() > now.getTime() ? d : null;
}
function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// ── Cancel: the sentence + the effective date, from the row ──────────────────

export type CancelPreview = {
  periodEnd: Date | null;
  /** "At the end of the paid period" is offered only when there is one in the future. */
  atPeriodEndAvailable: boolean;
  keepsAccessUntil: (when: "period_end" | "now") => Date;
  consequence: (when: "period_end" | "now") => { text: string; tone: "info" | "danger" };
};

export function cancelPreview(sub: PanelSub, now: Date): CancelPreview {
  const periodEnd = sub.hasStripe ? sub.currentPeriodEnd : sub.paidThroughDate ?? sub.endDate;
  const future = !!periodEnd && periodEnd.getTime() > now.getTime();
  return {
    periodEnd,
    atPeriodEndAvailable: future,
    keepsAccessUntil: (when) => (when === "period_end" && future ? periodEnd! : now),
    consequence: (when) => {
      if (!sub.hasStripe) return { text: when === "now" || !future ? "nothing — billed offline. The record is cancelled today." : `nothing — billed offline. The record ends on ${fmt(periodEnd!)}.`, tone: "info" };
      if (when === "now" || !future) return { text: `cancelled immediately.${future ? ` The current period (paid to ${fmt(periodEnd!)}) is not refunded from here.` : ""}`, tone: "danger" };
      return { text: `cancels at the period end, ${fmt(periodEnd!)} — no further charges.`, tone: "info" };
    },
  };
}

// ── Pause / Resume maths ─────────────────────────────────────────────────────

const DAY = 86400000;

/**
 * What resuming does to an OFFLINE row's dates: the days it sat paused are
 * given back. A family who paid for a month gets a month. Stripe rows get
 * nothing here — Stripe voided the invoices while paused and the cycle runs on.
 */
export function resumeShift(
  row: { pausedAt: Date | null; paidThroughDate: Date | null; endDate: Date | null; hasStripe: boolean },
  resumeAt: Date,
): { pausedDays: number; paidThroughDate: Date | null; endDate: Date | null } {
  if (!row.pausedAt) return { pausedDays: 0, paidThroughDate: row.paidThroughDate, endDate: row.endDate };
  const pausedDays = Math.max(0, Math.round((resumeAt.getTime() - row.pausedAt.getTime()) / DAY));
  if (row.hasStripe || pausedDays === 0) return { pausedDays, paidThroughDate: row.paidThroughDate, endDate: row.endDate };
  const shift = (d: Date | null) => (d ? new Date(d.getTime() + pausedDays * DAY) : null);
  return { pausedDays, paidThroughDate: shift(row.paidThroughDate), endDate: shift(row.endDate) };
}

/** The Pause dialog's sentences. */
export function pausePreview(row: { hasStripe: boolean; paidThroughDate: Date | null; currentPeriodEnd: Date | null }, until: Date | null, now: Date): { sentence: string; consequence: string; days: number | null } {
  const days = until ? Math.max(0, Math.round((until.getTime() - now.getTime()) / DAY)) : null;
  const span = until ? `from ${fmt(now)} to ${fmt(until)}${days ? ` (${days} days)` : ""}` : `from ${fmt(now)} until you resume it`;
  const sentence = `No charges and no class access ${span}. Attendance is still recorded if they show up. You can resume any time.`;
  const consequence = row.hasStripe
    ? until
      ? `collection paused — invoices are voided until ${fmt(until)}, then billing resumes automatically.`
      : "collection paused — invoices are voided until you resume. No charges while paused."
    : `nothing. When you resume, paid-through moves out by the paused days${days ? ` (${days})` : ""}.`;
  return { sentence, consequence, days };
}

// ── Change dates: which fields, and what Stripe hears ────────────────────────

export type DatesInput = { startDate: Date | null; paidThroughDate: Date | null; endDate: Date | null; minimumTermEndsAt: Date | null };

export function datesEditable(hasStripe: boolean): Record<keyof DatesInput, boolean> {
  return hasStripe
    ? { startDate: false, paidThroughDate: false, endDate: true, minimumTermEndsAt: true }
    : { startDate: true, paidThroughDate: true, endDate: true, minimumTermEndsAt: true };
}

/**
 * Validate + normalise a dates edit. A commitment never outlives the end
 * (§8.8.1); start never after end; Stripe rows only move the end date.
 */
export function resolveDatesEdit(
  row: DatesInput & { hasStripe: boolean },
  edit: Partial<DatesInput>,
): { ok: true; next: DatesInput; changed: (keyof DatesInput)[]; consequence: string } | { ok: false; error: string } {
  const can = datesEditable(row.hasStripe);
  const next: DatesInput = { ...row };
  const changed: (keyof DatesInput)[] = [];
  for (const k of Object.keys(edit) as (keyof DatesInput)[]) {
    if (edit[k] === undefined) continue;
    if (!can[k]) return { ok: false, error: `${LABEL[k]} is set by Stripe on this membership and can't be edited here.` };
    const v = edit[k] ?? null;
    if ((v?.getTime() ?? null) !== (row[k]?.getTime() ?? null)) { next[k] = v; changed.push(k); }
  }
  if (next.startDate && next.endDate && next.startDate.getTime() > next.endDate.getTime()) return { ok: false, error: "Start must be before the end date." };
  if (next.minimumTermEndsAt && next.endDate && next.minimumTermEndsAt.getTime() > next.endDate.getTime()) {
    next.minimumTermEndsAt = next.endDate;
    if (!changed.includes("minimumTermEndsAt")) changed.push("minimumTermEndsAt");
  }
  let consequence: string;
  if (!row.hasStripe) consequence = "nothing — billed offline. Dates change on the record only.";
  else if (!changed.includes("endDate")) consequence = "nothing — the cancel date is unchanged.";
  else if (!next.endDate) consequence = "cancel date removed — renews until cancelled.";
  else consequence = `cancel date moves to ${fmt(next.endDate)}; charges continue until then.`;
  return { ok: true, next, changed, consequence };
}

const LABEL: Record<keyof DatesInput, string> = { startDate: "Start", paidThroughDate: "Paid through", endDate: "End date", minimumTermEndsAt: "Commitment" };
