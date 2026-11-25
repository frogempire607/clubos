// What the member event details screen and the register review step SAY.
// PURE: no prisma, no fetch, no Date.now() (callers pass `now`).
//
// The server's review answer (POST /api/member/events/[id]/register without
// `confirmed`) and the details screen both take their payment sentences from
// here, so "how and when you pay" reads the same before and after the tap.

import type { RefundPolicyView } from "@/lib/eventRefundPolicy";

export type PaymentMethodKey =
  | "CARD"
  | "SAVED_CARD"
  | "AUTO_CARD"
  | "CASH"
  | "CHECK"
  | "APPROVAL_CHARGE"
  | "INVOICE";

const money = (n: number) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;

// ── When ───────────────────────────────────────────────────────────────────

/** Formats in the club's timezone; with none set, in the viewer's own. */
function fmt(d: Date, tz: string | null | undefined, opts: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat("en-US", { ...opts, ...(tz ? { timeZone: tz } : {}) }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-US", opts).format(d);
  }
}

function dayKey(d: Date, tz: string | null | undefined): string {
  return fmt(d, tz, { year: "numeric", month: "2-digit", day: "2-digit" });
}

export type EventWhen = { date: string; time: string; multiDay: boolean };

/**
 * "Saturday, March 7" + "9:00 AM – 3:00 PM", or for an event over several
 * days "Sat, Mar 7 – Sun, Mar 8" + "Starts 9:00 AM · ends 3:00 PM".
 */
export function eventWhen(startsAt: Date | string, endsAt: Date | string, tz?: string | null): EventWhen {
  const s = new Date(startsAt);
  const e = new Date(endsAt);
  const t = (d: Date) => fmt(d, tz, { hour: "numeric", minute: "2-digit" });
  if (dayKey(s, tz) === dayKey(e, tz)) {
    return { date: fmt(s, tz, { weekday: "long", month: "long", day: "numeric" }), time: `${t(s)} – ${t(e)}`, multiDay: false };
  }
  const short = (d: Date) => fmt(d, tz, { weekday: "short", month: "short", day: "numeric" });
  return { date: `${short(s)} – ${short(e)}`, time: `Starts ${t(s)} · ends ${t(e)}`, multiDay: true };
}

export function sessionWhen(startsAt: Date | string, endsAt: Date | string | null | undefined, tz?: string | null): string {
  const s = new Date(startsAt);
  const day = fmt(s, tz, { weekday: "short", month: "short", day: "numeric" });
  const from = fmt(s, tz, { hour: "numeric", minute: "2-digit" });
  if (!endsAt) return `${day} · ${from}`;
  return `${day} · ${from} – ${fmt(new Date(endsAt), tz, { hour: "numeric", minute: "2-digit" })}`;
}

export function longDate(d: Date | string, tz?: string | null): string {
  return fmt(new Date(d), tz, { weekday: "long", month: "long", day: "numeric" });
}

// ── Description: never cut off, links kept ─────────────────────────────────

export type TextPiece = { kind: "text"; text: string } | { kind: "link"; text: string; href: string };

const URL_RE = /\bhttps?:\/\/[^\s<>"]+/gi;

/**
 * Split text into plain runs and web links. Only http(s) addresses become
 * links; trailing punctuation stays text ("see https://x.com." keeps the dot
 * out of the link). Line breaks are kept in the text runs for pre-wrap.
 */
export function linkifyText(text: string | null | undefined): TextPiece[] {
  const src = text ?? "";
  const out: TextPiece[] = [];
  let last = 0;
  for (const m of src.matchAll(URL_RE)) {
    let url = m[0];
    const trail = url.match(/[).,;:!?'\]]+$/);
    if (trail) url = url.slice(0, -trail[0].length);
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: "text", text: src.slice(last, at) });
    out.push({ kind: "link", text: url, href: url });
    last = at + url.length;
  }
  if (last < src.length) out.push({ kind: "text", text: src.slice(last) });
  return out;
}

// ── Spots, deadline, status ────────────────────────────────────────────────

/** A number only — never who took the spots. */
export function spotsText(capacity: number | null | undefined, taken: number, waitlist = true): string | null {
  if (!capacity || capacity <= 0) return null;
  const left = Math.max(0, capacity - taken);
  if (left === 0) return waitlist ? "Full · you can join the waitlist" : "Full";
  return left === 1 ? "1 spot left" : `${left} spots left`;
}

export function deadlineText(deadline: Date | string | null | undefined, now: Date, tz?: string | null): { text: string; closed: boolean } | null {
  if (!deadline) return null;
  const d = new Date(deadline);
  if (d.getTime() <= now.getTime()) return { text: `Registration closed ${longDate(d, tz)}`, closed: true };
  return { text: `Register by ${longDate(d, tz)}`, closed: false };
}

const STATUS_WORDS: Record<string, string> = {
  CONFIRMED: "Registered",
  WAITLISTED: "On the waitlist",
  PAID: "Registered · paid",
  REGISTERED: "Registered",
  SCHEDULED: "Registered · card charge scheduled",
  AWAITING_CASH: "Registered · cash due at the event",
  AWAITING_CHECK: "Registered · check due at the event",
  PENDING_PAYMENT: "Checkout not finished",
  PAYMENT_FAILED: "Registered · payment didn't go through",
  PENDING_REVIEW: "Waiting for the coach to review",
};

/** One of the family's athletes, as the details screen shows them. Their own registration only. */
export function athleteStatusText(status: string | null | undefined): string | null {
  if (!status) return null;
  return STATUS_WORDS[status] ?? "Registered";
}

// ── How and when payment happens ───────────────────────────────────────────

export type PricingKind = "FREE" | "COVERED" | "SPLIT" | "PAID";

export type MethodFacts = {
  /** What the card would be charged (processing fee included when passed on). */
  cardTotal: number;
  /** What cash or check owes (no card fee). */
  offlineTotal: number;
  cardFee: number;
  /** The day a scheduled card charge runs. */
  chargeOn?: Date | string | null;
  savedCardLabel?: string | null;
  tz?: string | null;
};

const feeNote = (f: MethodFacts) => (f.cardFee > 0 ? ` (includes ${money(f.cardFee)} processing fee)` : "");

/** One plain sentence: when the money moves, how much, and how. */
export function methodSentence(method: PaymentMethodKey, f: MethodFacts): string {
  const day = f.chargeOn ? longDate(f.chargeOn, f.tz) : "the event date";
  const card = f.savedCardLabel ? ` (${f.savedCardLabel})` : "";
  switch (method) {
    case "CARD":
      return `Pay ${money(f.cardTotal)} now by card on a secure checkout page${feeNote(f)}.`;
    case "SAVED_CARD":
      return `Your saved card${card} is charged ${money(f.cardTotal)} now${feeNote(f)}.`;
    case "AUTO_CARD":
      return `Nothing is charged today. Your saved card${card} is charged ${money(f.cardTotal)} on ${day}${feeNote(f)}.`;
    case "CASH":
      return `Bring ${money(f.offlineTotal)} in cash to the event. The club records it when they receive it.`;
    case "CHECK":
      return `Bring a check for ${money(f.offlineTotal)} to the event. The club records it when they receive it.`;
    case "APPROVAL_CHARGE":
      return `Nothing is charged today. If the coach approves, your saved card${card} is charged ${money(f.cardTotal)} then${feeNote(f)}.`;
    case "INVOICE":
      return `Nothing is charged today. If the coach approves, the club emails you a payment link for ${money(f.offlineTotal)}.`;
  }
}

export const APPROVAL_SENTENCE = "Registration isn't confirmed until the coach reviews it. No money moves before then.";

/**
 * The payment lines for the details screen, before anyone has chosen how to
 * pay. One line per way the event accepts, then the approval note.
 */
export function paymentSummary(input: {
  pricing: PricingKind;
  methods: PaymentMethodKey[];
  facts: MethodFacts | null;
  approval: boolean;
  athleteName?: string | null;
  split?: { mode: "ESTIMATED" | "OFFICIAL" | string | null; perHead: number | null } | null;
}): string[] {
  const lines: string[] = [];
  if (input.pricing === "FREE") lines.push("Free. Nothing to pay.");
  else if (input.pricing === "COVERED") lines.push(`Included in ${input.athleteName ? `${input.athleteName}'s` : "your"} membership. Nothing to pay.`);
  else if (input.pricing === "SPLIT") lines.push(splitSentence(input.split ?? null));
  else if (input.facts) {
    if (input.methods.length > 1) lines.push("You choose how to pay when you register:");
    for (const m of input.methods) lines.push(methodSentence(m, input.facts));
  }
  if (input.approval) lines.push(APPROVAL_SENTENCE);
  return lines;
}

export function splitSentence(split: { mode: string | null; perHead: number | null } | null): string {
  if (split?.mode === "ESTIMATED" && split.perHead != null) {
    return `Nothing is charged now. The club shares the total cost between everyone going and bills each family later, about ${money(split.perHead)} each.`;
  }
  return "Nothing is charged now. The club shares the total cost between everyone going and bills each family once the final amount is known.";
}

// ── Price ──────────────────────────────────────────────────────────────────

export type PriceView = {
  /** The headline: "$45.00", "Free", "Included in your membership", "Shared cost". */
  headline: string;
  lines: string[];
};

export function priceView(input: {
  pricing: PricingKind;
  isActiveMember: boolean;
  memberPrice: number | null;
  nonMemberPrice: number | null;
  dropInFee: number | null;
  multiSession: boolean;
  cardFee?: number | null;
  passFees?: boolean;
  discountLines?: string[];
  athleteName?: string | null;
  split?: { perHead: number | null } | null;
}): PriceView {
  if (input.pricing === "FREE") return { headline: "Free", lines: [] };
  if (input.pricing === "COVERED") {
    return { headline: "Included", lines: [`Covered by ${input.athleteName ? `${input.athleteName}'s` : "your"} membership.`] };
  }
  if (input.pricing === "SPLIT") {
    return { headline: input.split?.perHead != null ? `About ${money(input.split.perHead)}` : "Shared cost", lines: ["Split between everyone going."] };
  }
  const yours = input.isActiveMember
    ? input.memberPrice ?? input.nonMemberPrice ?? input.dropInFee
    : input.nonMemberPrice ?? input.memberPrice ?? input.dropInFee;
  const lines: string[] = [];
  if (input.memberPrice != null && input.nonMemberPrice != null && input.memberPrice !== input.nonMemberPrice) {
    lines.push(`Members ${money(input.memberPrice)} · non-members ${money(input.nonMemberPrice)}`);
    lines.push(input.isActiveMember ? "You pay the member price." : "You pay the non-member price. Members pay less.");
  }
  if (input.multiSession && input.dropInFee != null) lines.push(`One session only: ${money(input.dropInFee)}`);
  for (const d of input.discountLines ?? []) lines.push(d);
  if (input.passFees && (input.cardFee ?? 0) > 0) lines.push(`Paying by card adds a ${money(input.cardFee as number)} processing fee.`);
  return { headline: yours != null ? money(yours) : "Price on request", lines };
}

// ── The review step ────────────────────────────────────────────────────────
//
// What POST /register answers when it is not yet confirmed. Shown as "Check
// and confirm"; nothing is saved or charged until the person presses the one
// button, which re-sends the same request with `confirmed: true`.

export type RegisterReview = {
  review: true;
  athlete: { memberId: string; name: string };
  event: { id: string; name: string };
  pricing: PricingKind;
  approval: boolean;
  waitlisted: boolean;
  method: PaymentMethodKey | null;
  amount: { gross: number; due: number; discountLabel: string | null; cardFee: number; cardTotal: number } | null;
  chargeOn: string | null;
  savedCardLabel: string | null;
  split: { mode: string | null; perHead: number | null } | null;
  /** Documents the person agrees to by confirming (acknowledge-only). */
  acknowledge: { id: string; title: string }[];
  /** The event's refund policy, when one is set and money is owed. */
  refundPolicy?: RefundPolicyView | null;
  /** The plain sentence on when and how the money moves. */
  timing: string;
  /** The button's words. */
  confirmLabel: string;
};

export function reviewTiming(r: Pick<RegisterReview, "pricing" | "approval" | "method" | "amount" | "chargeOn" | "savedCardLabel" | "split" | "waitlisted">, tz?: string | null): string {
  const parts: string[] = [];
  if (r.waitlisted) parts.push("The event is full, so this puts them on the waitlist.");
  if (r.approval) parts.push(APPROVAL_SENTENCE);
  if (r.pricing === "FREE") parts.push("Free. Nothing to pay.");
  else if (r.pricing === "COVERED") parts.push("Included in their membership. Nothing to pay.");
  else if (r.pricing === "SPLIT") parts.push(splitSentence(r.split));
  else if (r.method && r.amount) {
    parts.push(methodSentence(r.method, {
      cardTotal: r.amount.cardTotal,
      offlineTotal: r.amount.due,
      cardFee: r.amount.cardFee,
      chargeOn: r.chargeOn,
      savedCardLabel: r.savedCardLabel,
      tz,
    }));
  }
  return parts.join(" ");
}

export function confirmLabel(r: Pick<RegisterReview, "pricing" | "approval" | "method" | "amount" | "waitlisted">): string {
  if (r.approval) return "Send registration request";
  if (r.waitlisted) return "Join the waitlist";
  if (r.pricing !== "PAID" || !r.method || !r.amount) return "Confirm registration";
  if (r.method === "CARD") return `Continue to payment · ${money(r.amount.cardTotal)}`;
  if (r.method === "SAVED_CARD") return `Pay ${money(r.amount.cardTotal)} and register`;
  return "Confirm registration";
}
