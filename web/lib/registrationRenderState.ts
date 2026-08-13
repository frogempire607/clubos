// The ONE description of what a registration looks like to the person who made
// it — plan.md §5.2.2.
//
// The confirmation page (`/e/[slug]/registered/[registrationId]`) and every
// lifecycle email (§5.2.5) render from this context and nothing else. That is
// the whole point: before this existed, each route wrote its own "You're
// registered" copy, which is how the public event page came to promise "a
// confirmation has been sent to <email>" while the route returned before
// sending anything (ARCHITECTURE-NOTES §2.1 Phase 5, bug 1). Two surfaces that
// derive their words from one resolver cannot disagree.
//
// PURE — no prisma, no Stripe, no fetch, no Date.now() beyond an injected
// `now`. Facts that need IO (the card label from Stripe, the refund figures
// from the Transaction, the membership name) are INPUTS: the caller resolves
// them and passes them in. That keeps this file testable end-to-end from
// scripts/event-confirmation-state-tests.ts with no database.
//
// Why it is not inside lib/eventPayments.ts, which §5.2.2 nominates: it must
// read `amountToCollect` from lib/eventRepricing.ts, and that module already
// imports lib/eventPayments.ts. Putting the resolver there would make the two
// modules circular. The vocabulary (statuses, policy, waitingOn) stays in
// eventPayments; the rendering sits on top of both.
//
// The money rule (§5.0 ownership table): every figure here comes from
// `amountToCollect` / the registration's own settled columns. Nothing in this
// file reads Event.memberPrice, nonMemberPrice, publicFixedPrice or any list
// price directly — a discounted registrant owes the discounted number, and the
// page, the email and the Stripe line item must all print the same one.

import {
  CHECKOUT_HOLD_MS,
  registrationWaitingOn,
  hasOpenProposal,
  WAITING_ON_LABELS,
  type RegistrationWaitingOn,
} from "@/lib/eventPayments";
import { amountToCollect, type PricingEvent, type PricingRegistration } from "@/lib/eventRepricing";

export const REGISTRATION_RENDER_KEYS = [
  "PENDING_REVIEW",
  "PROPOSED_CHANGE_PENDING",
  "SCHEDULED_APPROVAL_CHARGE",
  "SCHEDULED_EVENT_DATE",
  "PENDING_PAYMENT_INFLIGHT",
  "PENDING_PAYMENT_INFLIGHT_SLOW",
  "PENDING_PAYMENT_EXPIRED",
  "AWAITING_CASH",
  "AWAITING_CHECK",
  "PAYMENT_FAILED",
  "PAID",
  "FREE_CONFIRMED",
  "PRICE_UNRESOLVED",
  "COVERED_BY_MEMBERSHIP",
  "REGISTERED_AMOUNT_DUE",
  "CANCELED_BY_PARENT",
  "DECLINED_BY_COACH",
  "CANCELED_PROPOSAL_DECLINED",
] as const;
export type RegistrationRenderKey = (typeof REGISTRATION_RENDER_KEYS)[number];

export type RenderSeverity = "info" | "success" | "warn" | "danger";

export type ProposedChangeView = {
  original: Record<string, unknown>;
  proposed: Record<string, unknown>;
  priceDelta: number;
  proposedAt: Date;
  coachNote: string | null;
  /** The coach's own field names, as they stood when they proposed. */
  labels: Record<string, string> | null;
};

export type RegistrationRenderContext = {
  key: RegistrationRenderKey;
  headline: string;
  subheadline: string | null;
  /** Always one of: charged today · charged on approval · charged on {date} ·
   *  due in {method} · paid · nothing owed. Never a blank line. */
  chargeTiming: string;
  waitingOn: RegistrationWaitingOn;
  waitingOnLabel: string;
  severity: RenderSeverity;
  /** The one address for this registration for its whole lifetime (§5.2.3). */
  confirmationUrl: string;
  meta: {
    confirmationCode: string;
    athleteName: string;
    payerName: string | null;
    eventName: string;
    eventStartsAt: Date;
    eventEndsAt: Date;
    location: { name: string; address?: string; directionsUrl?: string } | null;
    amountPaid: number | null;
    amountDue: number | null;
    amountRefunded: number | null;
    discountLabel: string | null;
    receiptTransactionId: string | null;
    cardLabel: string | null;
    chargeDate: Date | null;
    dueDate: Date | null;
    proximityBadge: "TODAY" | "TOMORROW" | "3_DAYS" | "THIS_WEEK" | null;
    proposedChange: ProposedChangeView | null;
    declineReason: string | null;
    escalationStage: number;
    cancellationPolicyText: string | null;
    clubName: string;
    clubContact: string | null;
    refundedAt: Date | null;
  };
  actions: {
    primary: { label: string; href: string } | null;
    secondary: Array<{ label: string; href: string }>;
  };
};

export type RenderRegistration = PricingRegistration & {
  id: string;
  name: string;
  email?: string | null;
  status: string;
  paymentMethod?: string | null;
  approvalStatus?: string | null;
  declinedReason?: string | null;
  proposedChange?: unknown;
  proposedChangeRespondedAt?: Date | string | null;
  proposedChangeAccepted?: boolean | null;
  confirmationCode?: string | null;
  amountPaid?: unknown;
  discountCode?: string | null;
  discountAmount?: unknown;
  transactionId?: string | null;
  paymentUrl?: string | null;
  scheduledChargeAt?: Date | string | null;
  paidAt?: Date | string | null;
  reminderStage?: number | null;
  createdAt?: Date | string | null;
  formResponses?: unknown;
};

export type RenderEvent = PricingEvent & {
  id: string;
  name: string;
  startsAt: Date;
  endsAt: Date;
  publicSlug?: string | null;
  paymentDueBy?: Date | null;
  registrationDeadline?: Date | null;
  cancellationPolicyText?: string | null;
  variableCostMode?: string | null;
};

export type RenderInput = {
  registration: RenderRegistration;
  event: RenderEvent;
  club: { name: string; contactEmail?: string | null; contactPhone?: string | null; timezone?: string | null };
  /** Active (non-canceled) registrations — the divisor for a variable-cost split. */
  activeCount: number;
  /** baseUrlFromRequest(req) on a request path; getAppBaseUrl() in cron + email. */
  baseUrl: string;
  now?: Date;
  // ── Facts the caller resolves (this module does no IO) ──────────────────
  /** "Visa ····4242 (Shannan Hall)" — lib/memberCard.resolveCardSnapshot. */
  cardLabel?: string | null;
  amountRefunded?: number | null;
  refundedAt?: Date | null;
  /** Set only when the free path was taken because a subscription matched. */
  membershipName?: string | null;
  /** Rendered as "Paid by <payer>" only when the payer isn't the athlete's guardian. */
  payerName?: string | null;
  location?: { name: string; address?: string; directionsUrl?: string } | null;
  /** Policy-resolved cancellation copy (resolveEventPolicy handles inheritance). */
  cancellationPolicyText?: string | null;
};

const money = (n: number) => `$${n.toFixed(2)}`;

function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtDay(d: Date, timeZone?: string | null): string {
  try {
    return d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      ...(timeZone ? { timeZone } : {}),
    });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** Calendar days between two instants in the club's local calendar. */
function daysUntil(target: Date, now: Date, timeZone?: string | null): number {
  const key = (d: Date) => {
    try {
      return d.toLocaleDateString("en-CA", timeZone ? { timeZone } : undefined);
    } catch {
      return d.toISOString().slice(0, 10);
    }
  };
  const a = Date.parse(`${key(now)}T00:00:00Z`);
  const b = Date.parse(`${key(target)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

function proximity(due: Date | null, now: Date, tz?: string | null): RegistrationRenderContext["meta"]["proximityBadge"] {
  if (!due) return null;
  const d = daysUntil(due, now, tz);
  if (d < 0) return null;
  if (d === 0) return "TODAY";
  if (d === 1) return "TOMORROW";
  if (d <= 3) return "3_DAYS";
  if (d <= 7) return "THIS_WEEK";
  return null;
}

function readProposal(reg: RenderRegistration): ProposedChangeView | null {
  const raw = reg.proposedChange;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  const proposedAt = toDate(p.proposedAt as string) ?? new Date(0);
  const changes = (p.changes && typeof p.changes === "object" ? p.changes : {}) as Record<string, unknown>;
  // The "original" side is whatever the registrant answered for the same keys,
  // so the comparison table lines up row for row instead of showing the
  // proposal against a blank column.
  const responses = (reg.formResponses && typeof reg.formResponses === "object"
    ? reg.formResponses
    : {}) as Record<string, unknown>;
  const original: Record<string, unknown> = {};
  for (const k of Object.keys(changes)) original[k] = responses[k] ?? null;
  const delta = Number(p.priceDelta);
  const labels =
    p.labels && typeof p.labels === "object" && !Array.isArray(p.labels)
      ? (p.labels as Record<string, string>)
      : null;
  return {
    original,
    proposed: changes,
    priceDelta: Number.isFinite(delta) ? delta : 0,
    proposedAt,
    coachNote: typeof p.coachNote === "string" && p.coachNote.trim() ? p.coachNote.trim() : null,
    labels,
  };
}

/** The registration number people quote on the phone. */
export function displayConfirmationCode(reg: { id: string; confirmationCode?: string | null }): string {
  return reg.confirmationCode || reg.id.slice(-8).toUpperCase();
}

/**
 * Which render key a registration is in. Order is the §5.2.6 matrix's order and
 * matters: an unanswered proposal outranks the pending approval it sits on, a
 * coach decline outranks a plain cancellation, and a pending approval outranks
 * the money state — which is how a CARD registration that already paid in full
 * still reads "Registration requested" instead of "You're registered".
 */
export function registrationRenderKey(
  reg: RenderRegistration,
  event: RenderEvent,
  opts: { now?: Date; membershipName?: string | null } = {},
): RegistrationRenderKey {
  const now = opts.now ?? new Date();

  if (hasOpenProposal(reg)) return "PROPOSED_CHANGE_PENDING";
  if (reg.approvalStatus === "DECLINED") return "DECLINED_BY_COACH";
  if (reg.status === "CANCELED") {
    return reg.proposedChangeAccepted === false ? "CANCELED_PROPOSAL_DECLINED" : "CANCELED_BY_PARENT";
  }
  if (reg.approvalStatus === "PENDING" || reg.status === "PENDING_REVIEW") return "PENDING_REVIEW";

  if (reg.status === "PENDING_PAYMENT") {
    const age = now.getTime() - (toDate(reg.createdAt)?.getTime() ?? now.getTime());
    if (age > CHECKOUT_HOLD_MS) return "PENDING_PAYMENT_EXPIRED";
    return age > 30_000 ? "PENDING_PAYMENT_INFLIGHT_SLOW" : "PENDING_PAYMENT_INFLIGHT";
  }
  if (reg.status === "SCHEDULED") {
    // An approved APPROVAL_CHARGE is charged immediately, so its SCHEDULED
    // window is the few seconds between the write and the engine returning.
    return reg.paymentMethod === "APPROVAL_CHARGE" ? "SCHEDULED_APPROVAL_CHARGE" : "SCHEDULED_EVENT_DATE";
  }
  if (reg.status === "AWAITING_CASH") return "AWAITING_CASH";
  if (reg.status === "AWAITING_CHECK") return "AWAITING_CHECK";
  if (reg.status === "PAYMENT_FAILED") return "PAYMENT_FAILED";
  if (reg.status === "PAID") return "PAID";

  // REGISTERED (and anything unrecognized): money decides.
  if (Number(reg.amountDue ?? 0) > 0) return "REGISTERED_AMOUNT_DUE";
  if (opts.membershipName) return "COVERED_BY_MEMBERSHIP";

  // "Nothing resolved" and "nothing owed" are different claims, and only the
  // second one may be told to a family. An event that carries a price — or a
  // shared cost with no total set — has one, whatever the resolver managed to
  // work out, so it can never render as free. With the tier-aware resolver in
  // lib/eventRepricing this should be unreachable; it exists so the bad pair
  // cannot come back through some other gap.
  if (eventHasAPrice(event)) return "PRICE_UNRESOLVED";
  return "FREE_CONFIRMED";
}

/** The three terminal "this is not happening" keys. */
function canceledKey(key: RegistrationRenderKey): boolean {
  return (
    key === "CANCELED_BY_PARENT" ||
    key === "DECLINED_BY_COACH" ||
    key === "CANCELED_PROPOSAL_DECLINED"
  );
}

/** True when the owner has configured money on this event, however they did it. */
function eventHasAPrice(event: RenderEvent): boolean {
  if (event.variableCostEnabled) return true;
  return (
    Number(event.memberPrice ?? 0) > 0 ||
    Number(event.nonMemberPrice ?? 0) > 0 ||
    Number(event.dropInFee ?? 0) > 0
  );
}

const SEVERITY: Record<RegistrationRenderKey, RenderSeverity> = {
  PENDING_REVIEW: "info",
  PROPOSED_CHANGE_PENDING: "warn",
  SCHEDULED_APPROVAL_CHARGE: "info",
  SCHEDULED_EVENT_DATE: "success",
  PENDING_PAYMENT_INFLIGHT: "info",
  PENDING_PAYMENT_INFLIGHT_SLOW: "warn",
  PENDING_PAYMENT_EXPIRED: "danger",
  AWAITING_CASH: "success",
  AWAITING_CHECK: "success",
  PAYMENT_FAILED: "danger",
  PAID: "success",
  FREE_CONFIRMED: "success",
  PRICE_UNRESOLVED: "warn",
  COVERED_BY_MEMBERSHIP: "success",
  REGISTERED_AMOUNT_DUE: "success",
  CANCELED_BY_PARENT: "danger",
  DECLINED_BY_COACH: "danger",
  CANCELED_PROPOSAL_DECLINED: "danger",
};

/**
 * Refund copy, enumerated here rather than written per route (§5.2.9). Until
 * the Transaction.refundedAmount columns land (ARCHITECTURE-NOTES M3), callers
 * pass the VOID-heuristic figures they already compute.
 */
function refundSentence(args: {
  amountRefunded: number | null;
  refundedAt: Date | null;
  amountPaid: number | null;
  cardLabel: string | null;
  clubContact: string | null;
  timeZone?: string | null;
}): string {
  const { amountRefunded, refundedAt, amountPaid, cardLabel } = args;
  const on = refundedAt ? ` on ${fmtDay(refundedAt, args.timeZone)}` : "";
  const to = cardLabel ? ` to your ${cardLabel}` : "";
  if (amountRefunded && amountRefunded > 0) {
    if (amountPaid && amountRefunded < amountPaid) {
      return `A ${money(amountRefunded)} refund was issued${on}. You paid ${money(amountPaid - amountRefunded)}.`;
    }
    return `${money(amountRefunded)} was refunded${on}${to}.`;
  }
  if (!amountPaid || amountPaid <= 0) return "This registration wasn't charged, so there's nothing to refund.";
  const contact = args.clubContact ? ` — please contact ${args.clubContact}` : "";
  return `The club will refund you separately${contact}.`;
}

/**
 * Build the context both surfaces render from.
 *
 * Every `chargeTiming` string produced here is one of the six shapes §5.2.6
 * allows — charged today, charged when your coach approves, charged on a date,
 * due in a method, paid, or nothing owed — and the switch below is exhaustive
 * over the key union, so adding a state without writing its copy is a compile
 * error rather than a blank line in someone's confirmation email.
 */
export function renderableRegistrationState(input: RenderInput): RegistrationRenderContext {
  const { registration: reg, event, club, baseUrl } = input;
  const now = input.now ?? new Date();
  const tz = club.timezone ?? null;

  const key = registrationRenderKey(reg, event, { now, membershipName: input.membershipName });

  const confirmationCode = displayConfirmationCode(reg);
  const confirmationUrl = event.publicSlug
    ? `${baseUrl}/e/${event.publicSlug}/registered/${reg.id}`
    : `${baseUrl}/r/${reg.id}`;

  const amountPaid = reg.amountPaid == null ? null : Number(reg.amountPaid);
  // NET, through the one resolver — never a list price (§5.0 ownership table).
  const owed = amountToCollect(event, reg, input.activeCount);
  const settled = key === "PAID" || key === "SCHEDULED_APPROVAL_CHARGE" || key === "SCHEDULED_EVENT_DATE";
  const amountDue = owed > 0 && !settled ? owed : null;
  const chargeDate = toDate(reg.scheduledChargeAt);
  const dueDate = event.paymentDueBy ?? event.registrationDeadline ?? null;
  const cardLabel = input.cardLabel ?? null;
  const cardPhrase = cardLabel ? `your ${cardLabel}` : "your card on file";
  const amountRefunded = input.amountRefunded ?? null;
  const proposal = readProposal(reg);
  const clubContact = club.contactEmail || club.contactPhone || null;
  const discountLabel =
    reg.discountCode && Number(reg.discountAmount ?? 0) > 0
      ? `${reg.discountCode} — ${money(Number(reg.discountAmount))} off`
      : reg.discountCode || null;

  const refund = () =>
    refundSentence({
      amountRefunded,
      refundedAt: input.refundedAt ?? null,
      amountPaid,
      cardLabel,
      clubContact,
      timeZone: tz,
    });

  const registerAgainHref = event.publicSlug ? `${baseUrl}/e/${event.publicSlug}` : `${baseUrl}/member/events`;
  const calendar = { label: "Add to calendar", href: `${confirmationUrl}/calendar.ics` };

  let headline: string;
  let subheadline: string | null = null;
  let chargeTiming: string;
  let primary: { label: string; href: string } | null = null;
  const secondary: Array<{ label: string; href: string }> = [];

  switch (key) {
    case "PENDING_REVIEW": {
      headline = "Registration requested";
      subheadline = `Your coach is reviewing this registration for ${event.name}.`;
      const amt = money(owed);
      chargeTiming =
        reg.paymentMethod === "APPROVAL_CHARGE"
          ? `Nothing charged yet. ${cardLabel ? `Your ${cardLabel}` : "Your saved card"} will be charged ${amt} the moment your coach approves.`
          : reg.paymentMethod === "INVOICE"
            ? "Nothing charged yet — no card required. Your club will send a payment link once your coach approves."
            : reg.paymentMethod === "CASH" || reg.paymentMethod === "CHECK"
              ? `You'll bring ${amt} in ${reg.paymentMethod.toLowerCase()} if your coach approves.`
              : reg.status === "PAID" || (amountPaid ?? 0) > 0
                ? `${money(amountPaid ?? owed)} was charged today. If your coach doesn't approve, we'll refund it in full.`
                : `Nothing is owed until your coach approves.`;
      // TENTATIVE per iCal semantics — the spot isn't confirmed yet.
      primary = { label: "Add to calendar (tentative)", href: `${confirmationUrl}/calendar.ics` };
      break;
    }
    case "PROPOSED_CHANGE_PENDING": {
      headline = "Your coach proposed a change";
      subheadline = proposal?.coachNote ?? "Review what they suggested and accept or decline.";
      chargeTiming =
        proposal && proposal.priceDelta > 0
          ? `Nothing charged yet. If you accept, ${cardPhrase} will be charged an additional ${money(proposal.priceDelta)} on top of your original ${money(amountPaid ?? owed)}.`
          : "Nothing charged yet.";
      primary = { label: "Review the coach's proposed change", href: `${baseUrl}/member/bookings/${reg.id}/proposal` };
      break;
    }
    case "SCHEDULED_APPROVAL_CHARGE": {
      headline = "You're registered";
      subheadline = "Your coach approved this registration.";
      chargeTiming = `${money(owed)} is being charged to ${cardPhrase} now. We'll email your receipt the moment it clears.`;
      primary = calendar;
      break;
    }
    case "SCHEDULED_EVENT_DATE": {
      headline = "You're registered";
      chargeTiming = chargeDate
        ? `${cardLabel ? `Your ${cardLabel}` : "Your saved card"} will be charged ${money(owed)} on ${fmtDay(chargeDate, tz)} (event day).`
        : `${cardLabel ? `Your ${cardLabel}` : "Your saved card"} will be charged ${money(owed)} on the event date.`;
      primary = calendar;
      break;
    }
    case "PENDING_PAYMENT_INFLIGHT": {
      headline = "Finishing your payment…";
      chargeTiming = "We're waiting for Stripe to confirm your payment. This usually takes a few seconds.";
      break;
    }
    case "PENDING_PAYMENT_INFLIGHT_SLOW": {
      headline = "Payment still processing";
      chargeTiming = `This is taking longer than usual. You'll receive an email as soon as it lands. If nothing arrives in an hour, contact ${clubContact ?? club.name}.`;
      primary = { label: "Try again", href: registerAgainHref };
      break;
    }
    case "PENDING_PAYMENT_EXPIRED": {
      headline = "This registration expired";
      chargeTiming = "Payment wasn't completed within 30 minutes and the spot was released. You can register again to try.";
      primary = { label: "Register again", href: registerAgainHref };
      break;
    }
    case "AWAITING_CASH": {
      headline = "You're registered";
      chargeTiming = `Please bring ${money(owed)} in cash at the event.`;
      primary = calendar;
      break;
    }
    case "AWAITING_CHECK": {
      headline = "You're registered";
      chargeTiming = `Please bring a check for ${money(owed)} at the event.`;
      primary = calendar;
      break;
    }
    case "PAYMENT_FAILED": {
      headline = "Payment didn't go through";
      subheadline = "Your spot is held, but the card charge was declined.";
      chargeTiming = "Your card was declined. Pay online now to keep your spot.";
      primary = reg.paymentUrl ? { label: "Pay now", href: reg.paymentUrl } : null;
      secondary.push(calendar);
      break;
    }
    case "PAID": {
      headline = "You're registered — payment received";
      const when = toDate(reg.paidAt);
      chargeTiming = `${money(amountPaid ?? owed)} was charged ${when ? `on ${fmtDay(when, tz)}` : "today"}${cardLabel ? ` to your ${cardLabel}` : ""}.${reg.transactionId ? ` Receipt id ${reg.transactionId}.` : ""}`;
      primary = calendar;
      break;
    }
    case "FREE_CONFIRMED": {
      headline = "You're registered";
      chargeTiming = "Nothing owed — this event is free.";
      primary = calendar;
      break;
    }
    case "PRICE_UNRESOLVED": {
      headline = "You're registered — but we owe you a price";
      subheadline = `This event has a fee, and we couldn't work out what ${reg.name} owes.`;
      chargeTiming = `Nothing has been charged. ${club.name} will confirm the amount before anything is collected${clubContact ? ` — or contact ${clubContact} if you'd rather sort it now` : ""}.`;
      primary = calendar;
      break;
    }
    case "COVERED_BY_MEMBERSHIP": {
      headline = "You're registered";
      chargeTiming = `Nothing owed — this event is included in your ${input.membershipName}.`;
      primary = calendar;
      break;
    }
    case "REGISTERED_AMOUNT_DUE": {
      headline = "You're registered";
      chargeTiming = event.variableCostEnabled
        ? event.variableCostMode === "OFFICIAL"
          ? "Payment will be split after the event. Your club will email your share once the total is known."
          : `Estimated share: ${money(owed)}. Your club will email a payment link with the final amount.`
        : `Payment of ${money(owed)} is due — your club will email a payment link.`;
      primary = calendar;
      break;
    }
    case "CANCELED_BY_PARENT": {
      headline = "Registration canceled";
      chargeTiming = refund();
      primary = { label: "Register again", href: registerAgainHref };
      break;
    }
    case "DECLINED_BY_COACH": {
      headline = "Your coach couldn't approve this registration";
      subheadline = reg.declinedReason ? `Reason from your coach: ${reg.declinedReason}` : null;
      chargeTiming = refund();
      break;
    }
    case "CANCELED_PROPOSAL_DECLINED": {
      headline = "You declined the proposed change";
      chargeTiming = refund();
      primary = { label: "Register again", href: registerAgainHref };
      break;
    }
    default: {
      // Exhaustiveness: a new key with no copy is a compile error here, not a
      // blank line in a registrant's email.
      const never: never = key;
      throw new Error(`Unhandled registration render key: ${String(never)}`);
    }
  }

  const canceled = canceledKey(key) || key === "PENDING_PAYMENT_EXPIRED";
  if (!canceled && primary?.label !== calendar.label && !secondary.some((s) => s.label === calendar.label)) {
    secondary.push(calendar);
  }
  secondary.push({ label: "View this registration", href: confirmationUrl });

  // ── Card facts are state-scoped (§5.2.7) ────────────────────────────────
  // `cardLabel` is resolved by the caller before the key is known, so without
  // this it renders under ANY state — which is how a family was told "this
  // event is free" with "Card on file: Amex ····1005" in the table directly
  // beneath it (2026-08-12). A card belongs on screen only where it is part of
  // what happens next: it is about to be charged, it was charged, it failed, or
  // it is what a refund goes back to.
  const CARD_RELEVANT: RegistrationRenderKey[] = [
    "PENDING_REVIEW",
    "PROPOSED_CHANGE_PENDING",
    "SCHEDULED_APPROVAL_CHARGE",
    "SCHEDULED_EVENT_DATE",
    "PAYMENT_FAILED",
    "PAID",
    "CANCELED_BY_PARENT",
    "DECLINED_BY_COACH",
    "CANCELED_PROPOSAL_DECLINED",
  ];
  // …and even then, only when the state actually involves the card: a
  // cash-at-the-door registration awaiting a coach has one on file and it is
  // irrelevant, and a canceled registration only mentions it if money is
  // coming back.
  const cardIsPartOfTheStory =
    CARD_RELEVANT.includes(key) &&
    (key === "PAID" ||
      key === "PAYMENT_FAILED" ||
      key === "SCHEDULED_APPROVAL_CHARGE" ||
      key === "SCHEDULED_EVENT_DATE" ||
      ((key === "PENDING_REVIEW" || key === "PROPOSED_CHANGE_PENDING") &&
        (reg.paymentMethod === "APPROVAL_CHARGE" ||
          reg.paymentMethod === "AUTO_CARD" ||
          reg.paymentMethod === "CARD" ||
          reg.paymentMethod === "SAVED_CARD")) ||
      (canceledKey(key) && (amountRefunded ?? 0) > 0));
  const renderedCardLabel = cardIsPartOfTheStory ? cardLabel : null;

  const waitingOn = registrationWaitingOn(reg, { now });

  return {
    key,
    headline,
    subheadline,
    chargeTiming,
    waitingOn,
    waitingOnLabel: WAITING_ON_LABELS[waitingOn],
    severity: SEVERITY[key],
    confirmationUrl,
    meta: {
      confirmationCode,
      athleteName: reg.name,
      payerName: input.payerName ?? null,
      eventName: event.name,
      eventStartsAt: event.startsAt,
      eventEndsAt: event.endsAt,
      location: input.location ?? null,
      amountPaid: amountPaid && amountPaid > 0 ? amountPaid : null,
      amountDue,
      amountRefunded: amountRefunded && amountRefunded > 0 ? amountRefunded : null,
      discountLabel,
      receiptTransactionId: reg.transactionId ?? null,
      cardLabel: renderedCardLabel,
      chargeDate,
      dueDate: waitingOn === "PAYMENT" ? dueDate : null,
      proximityBadge: waitingOn === "PAYMENT" ? proximity(dueDate, now, tz) : null,
      proposedChange: key === "PROPOSED_CHANGE_PENDING" ? proposal : null,
      declineReason: reg.declinedReason ?? null,
      escalationStage: Math.max(0, reg.reminderStage ?? 0),
      cancellationPolicyText: canceled ? null : (input.cancellationPolicyText ?? event.cancellationPolicyText ?? null),
      clubName: club.name,
      clubContact,
      refundedAt: input.refundedAt ?? null,
    },
    actions: { primary, secondary },
  };
}
