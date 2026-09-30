// "When is the card charged?" — one place that decides the first-charge date
// at Assign and the next-charge date after it, and says both in plain words.
//
// Julian (owner), 2026-09-30: "when i assign membership how do I change the
// date it charges the account? Make that a thing." Before this, the Assign
// sheet had an unlabeled 32px "First charge today / On a date" toggle that
// defaulted to a month from today no matter what "Starts" said, and once a
// card membership existed nothing in the panel could move its charge date.
//
// Pure: no prisma, no Stripe, no Node built-ins (the Assign sheet imports it
// in the browser). `now` is always injected. Dates are UTC calendar days at
// 00:00Z, the convention the Assign sheet and lib/membershipMoney already use.
// Tests: scripts/charge-date-tests.ts.
//
// ── What Stripe does with the date (stated, not guessed) ────────────────────
//
// Both the first charge at Assign (lib/cardActivation, `trial_end`) and a moved
// charge (lib/membershipMoneyServer.moveChargeDate, `trial_end`) make that
// moment the subscription's billing cycle anchor: when the no-charge period
// ends Stripe invoices, and every later invoice lands on the same day of the
// period. When a month has no such day (an anchor on the 29th–31st), Stripe
// bills on that month's LAST day and goes back to the anchor day the month
// after — Stripe's own example is Jan 31 → Feb 28 (29 in a leap year) → Mar 31
// → Apr 30. `periodBoundary` below reproduces exactly that: every boundary is
// computed from the anchor (never by stepping), clamped to the month's length.

export const DAY = 86_400_000;

// ── Calendar helpers (self-contained so the browser bundle stays clean) ─────

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** "2026-10-15" → Date at 00:00Z, or null when it isn't a real YYYY-MM-DD. */
export function parseDay(s: string | null | undefined): Date | null {
  if (!s || !DAY_RE.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : d;
}
/** The UTC calendar day of a moment, as YYYY-MM-DD. */
export const dayKey = (d: Date) => d.toISOString().slice(0, 10);
/** The UTC calendar day of a moment, at 00:00Z. */
export const dayOf = (d: Date) => new Date(`${dayKey(d)}T00:00:00.000Z`);
/** Whole calendar days from a to b (b later ⇒ positive). */
export const daysBetween = (a: Date, b: Date) => Math.round((dayOf(b).getTime() - dayOf(a).getTime()) / DAY);

export const fmtDate = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
export const fmtShort = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const weekday = (d: Date) => d.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
export const money2 = (n: number) => `$${n.toFixed(2)}`;

/** 1 → "1st", 22 → "22nd", 27 → "27th". */
export function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${s}`;
}

const PERIOD_MONTHS: Record<string, number> = { MONTHLY: 1, BIMONTHLY: 2, QUARTERLY: 3, QUADRIMESTRAL: 4, SEMI_ANNUAL: 6, ANNUAL: 12 };
const PERIOD_DAYS: Record<string, number> = { WEEKLY: 7, BIWEEKLY: 14 };
const PERIOD_WORD: Record<string, string> = {
  WEEKLY: "weekly", BIWEEKLY: "every 2 weeks", MONTHLY: "monthly", BIMONTHLY: "every 2 months", QUARTERLY: "every 3 months",
  QUADRIMESTRAL: "every 4 months", SEMI_ANNUAL: "every 6 months", ANNUAL: "yearly",
};

function addMonthsUTC(start: Date, n: number): Date {
  const d = new Date(start.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, dim));
  return d;
}

/** The k-th charge after `anchor`, the way Stripe schedules it (see header). */
export function periodBoundary(anchor: Date, period: string | null | undefined, k: number): Date {
  const p = period ?? "MONTHLY";
  if (PERIOD_DAYS[p]) return new Date(anchor.getTime() + PERIOD_DAYS[p] * k * DAY);
  return addMonthsUTC(anchor, (PERIOD_MONTHS[p] ?? 1) * k);
}

/**
 * The repeat rule after a first charge on `anchor`, in words:
 *   "then monthly on the 15th"
 *   "then monthly on the 31st (the last day of shorter months)"
 *   "then every Thursday" · "then every 3 months on the 15th (next Jan 15, 2027)"
 *   "then yearly on Oct 15"
 */
export function repeatRule(anchor: Date, period: string | null | undefined): string {
  const p = period ?? "MONTHLY";
  if (p === "WEEKLY") return `then every ${weekday(anchor)}`;
  if (p === "BIWEEKLY") return `then every other ${weekday(anchor)}`;
  const dom = anchor.getUTCDate();
  const short = dom >= 29 ? " (the last day of shorter months)" : "";
  if (p === "MONTHLY" || !PERIOD_MONTHS[p]) return `then monthly on the ${ordinal(dom)}${short}`;
  if (p === "ANNUAL") {
    const leap = anchor.getUTCMonth() === 1 && dom === 29 ? " (Feb 28 in other years)" : "";
    return `then yearly on ${fmtShort(anchor)}${leap}`;
  }
  return `then ${PERIOD_WORD[p]} on the ${ordinal(dom)}${short} (next ${fmtDate(periodBoundary(anchor, p, 1))})`;
}

/**
 * The uncharged stretch between two days, `to` exclusive:
 *   gap(Oct 1, Oct 15) → { days: 14, range: "Oct 1 – Oct 14" }.
 * Null when there's no gap.
 */
export function gap(from: Date, to: Date): { days: number; range: string } | null {
  const days = daysBetween(from, to);
  if (days <= 0) return null;
  const last = new Date(dayOf(to).getTime() - DAY);
  return { days, range: days === 1 ? fmtShort(from) : `${fmtShort(from)} – ${fmtShort(last)}` };
}
const dayWord = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

// ── A. At Assign ─────────────────────────────────────────────────────────────

export type AssignChargeChoice = "today" | "start" | "date";

/** Which choices the card block offers. "On the start date" only when Starts is in the future. */
export function assignChargeChoices(startISO: string, now: Date): AssignChargeChoice[] {
  const start = parseDay(startISO);
  return start && start.getTime() > dayOf(now).getTime() ? ["today", "start", "date"] : ["today", "date"];
}

/** Default: the start date when it's in the future, else today. */
export function defaultAssignChargeChoice(startISO: string, now: Date): AssignChargeChoice {
  return assignChargeChoices(startISO, now).includes("start") ? "start" : "today";
}

export type AssignChargePlan =
  | {
      ok: true;
      /** Charged the moment it's assigned (needs the "charged right now" tick). */
      immediate: boolean;
      /** The day of the first charge (today when immediate). */
      firstCharge: Date;
      /** What the Assign PATCH sends as billingAnchorDate: null = charge now. */
      anchorISO: string | null;
      /** "First charge $56.25 on Oct 15, 2026 · then monthly on the 15th". */
      line: string;
      /** "Oct 1 – Oct 14 (14 days) aren't charged — the first charge is Oct 15." */
      freeLine: string | null;
      /** For the confirm button: "$56.25 today" / "$56.25 on Oct 15". */
      short: string;
    }
  | { ok: false; error: string };

/**
 * The card's first charge at Assign. Rules:
 *   - any day from today on; never in the past
 *   - never before the membership starts — except "Today", which is an
 *     explicit charge-now the owner ticks for (a family paying up front for a
 *     membership that starts next week); the sheet says so
 *   - before the membership's own end, when it has one
 */
export function assignChargePlan(input: {
  choice: AssignChargeChoice;
  startISO: string;
  /** Only for choice "date". */
  pickedISO?: string | null;
  amount: number;
  period: string | null | undefined;
  /** When a non-renewing option stops (the Assign sheet's `end`), if it does. */
  endsAt?: Date | null;
  now: Date;
}): AssignChargePlan {
  const today = dayOf(input.now);
  const start = parseDay(input.startISO);
  if (!start) return { ok: false, error: "Pick the start date first." };
  let first: Date;
  if (input.choice === "today") first = today;
  else if (input.choice === "start") {
    if (start.getTime() <= today.getTime()) return { ok: false, error: "The start date is today or earlier — choose Today instead." };
    first = start;
  } else {
    const picked = parseDay(input.pickedISO ?? "");
    if (!picked) return { ok: false, error: "Pick the date of the first charge." };
    if (picked.getTime() < today.getTime()) return { ok: false, error: "That date is in the past. Pick today or a later date." };
    if (picked.getTime() < start.getTime()) {
      return { ok: false, error: `The first charge can't come before the membership starts (${fmtDate(start)}). Pick ${fmtShort(start)} or later.` };
    }
    first = picked;
  }
  if (input.endsAt && dayOf(input.endsAt).getTime() <= first.getTime()) {
    return { ok: false, error: `This option ends ${fmtDate(input.endsAt)} — the first charge has to come before that.` };
  }
  const immediate = first.getTime() === today.getTime();
  const amt = money2(input.amount);
  const rule = repeatRule(first, input.period);
  const g = gap(start, first);
  const freeLine = g ? `${g.range} (${dayWord(g.days)}) ${g.days === 1 ? "isn't" : "aren't"} charged — the first charge is ${fmtShort(first)}.` : null;
  const early = immediate && start.getTime() > today.getTime() ? ` — before the ${fmtShort(start)} start` : "";
  return {
    ok: true,
    immediate,
    firstCharge: first,
    anchorISO: immediate ? null : dayKey(first),
    line: immediate ? `Charged ${amt} today${early} · ${rule}` : `First charge ${amt} on ${fmtDate(first)} · ${rule}`,
    freeLine,
    short: immediate ? `${amt} today` : `${amt} on ${fmtShort(first)}`,
  };
}

/**
 * The server's check at commit (activate_card from the Assign sheet, and the
 * Assign sheet's offer). `anchor` null ⇒ "charge now", which the route gates
 * behind confirmImmediateCharge separately.
 */
export function checkAssignAnchor(input: { anchor: Date | null; start: Date | null; now: Date; allowPast?: boolean }): { ok: true } | { ok: false; error: string } {
  const a = input.anchor;
  if (!a) return { ok: true };
  if (!input.allowPast && dayOf(a).getTime() < dayOf(input.now).getTime()) {
    return { ok: false, error: `The first charge date (${fmtDate(a)}) is in the past. Pick today or a later date — nothing was charged.` };
  }
  if (input.start && dayOf(a).getTime() < dayOf(input.start).getTime()) {
    return { ok: false, error: `The first charge (${fmtDate(a)}) can't come before the membership starts (${fmtDate(input.start)}). Nothing was charged.` };
  }
  return { ok: true };
}

/** Offer mode's line, on the same rules. Past/today ⇒ charged on acceptance. */
export function offerChargeLine(input: { dateISO: string; startISO: string; amount: number; period: string | null | undefined; now: Date }): { ok: true; immediate: boolean; line: string } | { ok: false; error: string } {
  const d = parseDay(input.dateISO);
  const start = parseDay(input.startISO);
  if (!d) return { ok: false, error: "Pick the first charge date — the offer can't be sent without one." };
  if (start && d.getTime() < start.getTime() && d.getTime() > dayOf(input.now).getTime()) {
    return { ok: false, error: `The first charge can't come before the membership starts (${fmtDate(start)}). Pick ${fmtShort(start)} or later.` };
  }
  const immediate = d.getTime() <= input.now.getTime() + 60_000;
  const amt = money2(input.amount);
  if (immediate) {
    const p = input.period ?? "MONTHLY";
    const again = PERIOD_DAYS[p] ? `then ${PERIOD_WORD[p]} from that day` : `then ${PERIOD_WORD[p] ?? "monthly"} on that day of the ${PERIOD_MONTHS[p] === 12 ? "year" : "month"}`;
    return { ok: true, immediate, line: `Nothing is charged until they accept — then ${amt} as soon as they accept · ${again}.` };
  }
  const g = start ? gap(start, d) : null;
  return {
    ok: true, immediate,
    line: `Nothing is charged until they accept — then first charge ${amt} on ${fmtDate(d)} · ${repeatRule(d, input.period)}.${g ? ` ${g.range} (${dayWord(g.days)}) ${g.days === 1 ? "isn't" : "aren't"} charged.` : ""}`,
  };
}

/** Cash/check at Assign: the day the next payment is due, and what it means later. */
export function cashNextDueLine(input: { paidThrough: Date; amount: number; hasCardOnFile: boolean }): string {
  const due = fmtDate(input.paidThrough);
  return `Next payment due ${due} — you collect it.${input.hasCardOnFile ? ` If they switch to automatic payments later, ${fmtShort(input.paidThrough)} is the day the card is first charged.` : " If they switch to automatic payments later, that's the day the card is first charged."}`;
}

// ── B. After assignment: move the next charge ───────────────────────────────

export type MoveRow = {
  hasStripe: boolean;
  status: string;
  /** Live Stripe status when read, else the row's cached one. */
  stripeStatus: string | null;
  /** What the next charge is, in dollars (fee included). */
  chargeAmount: number;
  billingPeriod: string | null;
  startDate: Date | null;
  endDate: Date | null;
  autoRenew: boolean;
  /** Stripe cancel_at (live). */
  cancelAt: Date | null;
  paused: boolean;
  /** Stripe: when the next invoice is drafted (trial_end while trialing, else the period end). */
  nextChargeAt: Date | null;
  /** Row's paid-through (cash rows: the due date; Stripe rows: set by paid-another-way / waive). */
  paidThroughDate: Date | null;
  /**
   * Stripe rows: the paid-through date written into subscription metadata
   * (aoxPaidThrough) the first time a PAYING subscription's charge was moved.
   * Its presence is how everything else knows a `trialing` status is a moved
   * cycle and not a first charge still to come (see chargeDateMoved below).
   */
  movedPaidThrough: Date | null;
  /** A one-time (duration "once") discount is attached — e.g. a pending skip. */
  onceDiscountAt: Date | null;
};

export type MovePlan =
  | {
      ok: true;
      mode: "STRIPE" | "STRIPE_FIRST_CHARGE" | "OFFLINE";
      from: Date;
      to: Date;
      /** Days newly given at no charge (negative: the charge comes sooner, still within what's paid). */
      freeDays: number;
      /** Stripe: what to write as aoxPaidThrough (unchanged when already set; null for a first charge). */
      paidThroughMarker: Date | null;
      sentence: string;
      consequence: string;
    }
  | { ok: false; code: MoveRefusal; error: string };

export type MoveRefusal =
  | "FREE" | "PAUSED" | "PAST_DUE" | "SKIP_PENDING" | "NO_NEXT" | "BAD_DATE" | "PAST" | "BEFORE_START" | "PAID_THROUGH" | "SAME" | "ENDS_BEFORE";

/**
 * Move the next charge (Stripe) or the next due date (cash/check).
 *
 * Refuses — never a silent double charge, never a surprise:
 *   - past_due / unpaid: Stripe is retrying a failed charge; moving the date
 *     would not stop that retry. Fix the payment first.
 *   - paused: nothing is charged while paused; resume first.
 *   - a pending one-time discount (the B16 skip coupon): the $0 invoice Stripe
 *     issues when the no-charge period starts would use it up.
 *   - earlier than what they've paid for: "They've paid through Nov 27. Pick
 *     Nov 27 or later, or use Refund / Waive a payment." A prorated credit for
 *     moving earlier is not offered — Stripe's credit lands on the customer
 *     balance, not the card, and the family would read two charges.
 *   - on/after the membership's end (cancel_at / non-renewing end date).
 *   - before the membership starts; in the past; today (use the normal flow).
 */
export function chargeDateMovePlan(row: MoveRow, input: { newDateISO: string; pmLabel: string | null; now: Date }): MovePlan {
  const to = parseDay(input.newDateISO);
  if (!to) return { ok: false, code: "BAD_DATE", error: "Pick a date." };
  if (row.chargeAmount <= 0) return { ok: false, code: "FREE", error: "This membership is free — there is no charge date to move." };
  if (row.paused) return { ok: false, code: "PAUSED", error: "Billing is paused — nothing is charged until it resumes. Resume it first, then move the date." };
  const today = dayOf(input.now);
  if (to.getTime() <= today.getTime()) return { ok: false, code: "PAST", error: "Pick a date after today." };
  if (row.startDate && to.getTime() < dayOf(row.startDate).getTime()) {
    return { ok: false, code: "BEFORE_START", error: `The membership starts ${fmtDate(row.startDate)} — the charge can't come before that.` };
  }
  const ends = row.hasStripe ? row.cancelAt ?? (!row.autoRenew ? row.endDate : null) : row.endDate;
  if (ends && to.getTime() >= dayOf(ends).getTime()) {
    return { ok: false, code: "ENDS_BEFORE", error: `This membership ends ${fmtDate(ends)} — the charge date has to be before that. To keep them longer, change the end date first.` };
  }
  const amt = money2(row.chargeAmount);
  const rule = repeatRule(to, row.billingPeriod);

  if (row.hasStripe) {
    if (row.status === "past_due" || row.stripeStatus === "past_due" || row.stripeStatus === "unpaid") {
      return { ok: false, code: "PAST_DUE", error: "The last card payment failed and Stripe is retrying it — moving the date won't stop that. Fix the payment first (a new card, or They paid another way), then move the date." };
    }
    if (row.onceDiscountAt) {
      return { ok: false, code: "SKIP_PENDING", error: `The ${fmtShort(row.onceDiscountAt)} charge is set to be skipped. Moving the date now would use up that skip on a $0 invoice instead of a real charge. Move the date after ${fmtShort(row.onceDiscountAt)}.` };
    }
    const from = row.nextChargeAt;
    if (!from) return { ok: false, code: "NO_NEXT", error: "Stripe hasn't told us the next charge date. Sync from Stripe, then try again." };
    if (dayKey(from) === dayKey(to)) return { ok: false, code: "SAME", error: `The next charge is already on ${fmtDate(from)}.` };
    const firstCharge = row.stripeStatus === "trialing" && !row.movedPaidThrough;
    if (firstCharge) {
      // Nothing paid yet: the first charge simply moves, either way.
      const g = row.startDate ? gap(row.startDate, to) : null;
      return {
        ok: true, mode: "STRIPE_FIRST_CHARGE", from, to, freeDays: daysBetween(from, to), paidThroughMarker: null,
        sentence: `Nothing has been charged yet. The first charge moves from ${fmtShort(from)} to ${fmtDate(to)}: ${amt} on ${input.pmLabel ?? "the saved payment method"} · ${rule}.${g ? ` ${g.range} (${dayWord(g.days)}) ${g.days === 1 ? "isn't" : "aren't"} charged.` : ""}`,
        consequence: `the first-charge date on the subscription moves to ${fmtShort(to)}. Nothing is charged today.`,
      };
    }
    // Paid through: the later of what Stripe has billed to and anything recorded by hand.
    const cands = [row.stripeStatus === "trialing" ? row.movedPaidThrough : from, row.paidThroughDate, row.movedPaidThrough].filter((x): x is Date => !!x);
    const paidThrough = new Date(Math.max(...cands.map((x) => dayOf(x).getTime())));
    if (to.getTime() < paidThrough.getTime()) {
      return { ok: false, code: "PAID_THROUGH", error: `They've paid through ${fmtDate(paidThrough)}. Pick ${fmtShort(paidThrough)} or later, or use Refund or Waive a payment.` };
    }
    const moreFree = daysBetween(from, to);
    const g = gap(dayOf(from), to);
    const words = moreFree > 0
      ? `${fmtShort(from)} → ${fmtShort(to)}: ${dayWord(g!.days)} at no charge.`
      : `${dayWord(-moreFree)} fewer at no charge — still not before the ${fmtShort(paidThrough)} they've paid through.`;
    return {
      ok: true, mode: "STRIPE", from, to, freeDays: moreFree,
      // Already in a moved no-charge stretch: keep the first recorded paid-through.
      // Billing normally (active): what they've paid through right now.
      paidThroughMarker: row.stripeStatus === "trialing" ? row.movedPaidThrough ?? paidThrough : paidThrough,
      sentence: `The next charge moves from ${fmtShort(from)} to ${fmtDate(to)}. ${words} Then ${amt} on ${fmtShort(to)} on ${input.pmLabel ?? "the saved payment method"} · ${rule}.`,
      consequence: `nothing is charged or refunded today. The subscription gets a no-charge stretch until ${fmtShort(to)} (trial_end, no proration), then renews on the new day. Stripe's dashboard shows it as "trialing" until then; here they stay an active, paying member. Plan, price, commitment and end date don't change.`,
    };
  }

  // Cash / check: the next due date is the paid-through date.
  const from = row.paidThroughDate;
  if (from && dayKey(from) === dayKey(to)) return { ok: false, code: "SAME", error: `The next payment is already due ${fmtDate(from)}.` };
  if (from && to.getTime() < dayOf(from).getTime()) {
    return { ok: false, code: "PAID_THROUGH", error: `They've paid through ${fmtDate(from)}. Pick ${fmtShort(from)} or later. To fix a paid-through date that was typed wrong, use Change dates.` };
  }
  const g = from ? gap(dayOf(from), to) : null;
  return {
    ok: true, mode: "OFFLINE", from: from ?? to, to, freeDays: g?.days ?? 0, paidThroughMarker: null,
    sentence: from
      ? `The next payment is due ${fmtDate(to)} instead of ${fmtShort(from)} — you collect it. ${fmtShort(from)} → ${fmtShort(to)}: ${dayWord(g!.days)} at no charge.`
      : `The next payment is due ${fmtDate(to)} — you collect it.`,
    consequence: `nothing — billed offline. Paid through becomes ${fmtDate(to)}. If they switch to automatic payments later, that's the day the card is first charged.`,
  };
}

/**
 * Is this Stripe `trialing` status a MOVED charge date on a paying member,
 * rather than a first charge still to come? Reads the synced snapshot
 * (lib/stripeSync.buildSnapshot copies metadata.aoxPaidThrough into it).
 */
export function chargeDateMoved(snapshot: unknown): boolean {
  const s = snapshot as { chargeDateMovedFrom?: unknown } | null | undefined;
  return !!s && typeof s.chargeDateMovedFrom === "string" && s.chargeDateMovedFrom.length > 0;
}

/** The Stripe status to SHOW: a moved charge date reads as "active", not "trialing". */
export function displayStripeStatus(stripeStatus: string | null | undefined, snapshot: unknown): string | null {
  if (!stripeStatus) return null;
  return stripeStatus === "trialing" && chargeDateMoved(snapshot) ? "active" : stripeStatus;
}

/** History: "Charge date moved Nov 27 → Dec 5 — by Julian Ramirez". */
export function moveEventSentence(detail: Record<string, unknown>, actorName: string | null): string {
  const f = typeof detail.from === "string" ? new Date(detail.from) : null;
  const t = typeof detail.to === "string" ? new Date(detail.to) : null;
  const what = detail.mode === "OFFLINE" ? "Payment due date moved" : detail.mode === "STRIPE_FIRST_CHARGE" ? "First charge moved" : "Charge date moved";
  return `${what} ${f ? fmtShort(f) : "?"} → ${t ? fmtShort(t) : "?"}${actorName ? ` — by ${actorName}` : ""}`;
}
