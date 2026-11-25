// An event's refund policy — what it is, when it ends, and the words.
//
// PURE and client-safe. No prisma, no Date.now() (callers pass `now`). Every
// surface takes its sentences from here: the event editor's preview, the
// member event screen, the review step, the payment choice, /e/[slug], the
// emails, the registration page, My bookings, and the staff refund sheet.
// scripts/event-refund-policy-tests.ts exercises every branch.
//
// For FAMILIES it is a promise: it decides what canceling themselves gives
// back. For STAFF it is information, never a lock: they can refund after the
// deadline, see a warning, and it is recorded.
//
// Deadlines are the CLUB's time. "3 days before" means the same clock time
// three calendar days earlier where the club is, across a clock change too.

import { eventScheduledChargeAt } from "@/lib/eventPayments";
import { tzOffsetMs, wallClockUTCToInstant } from "@/lib/datetime";

export const REFUND_POLICIES = ["ANYTIME", "UNTIL", "UNTIL_CHARGED", "NONE"] as const;
export type RefundPolicyKind = (typeof REFUND_POLICIES)[number];

export const REFUND_POLICY_LABELS: Record<RefundPolicyKind, string> = {
  ANYTIME: "Refundable anytime",
  UNTIL: "Refundable until a date",
  UNTIL_CHARGED: "Refundable until the card is charged",
  NONE: "Non-refundable",
};

export const NON_REFUNDABLE_CHECKBOX = "I understand this is non-refundable.";
/** The server's answer when the checkbox wasn't ticked. */
export const NON_REFUNDABLE_REQUIRED = "Tick “I understand this is non-refundable.” to register.";

/** The event columns, however they arrive (Prisma row or JSON). */
export type RefundPolicyEvent = {
  startsAt: Date | string;
  autoChargeDate?: Date | string | null;
  refundPolicy?: string | null;
  refundUntilAt?: Date | string | null;
  refundUntilDays?: number | null;
  refundNote?: string | null;
};

/** For a Prisma select that only wants what this module reads. */
export const REFUND_POLICY_SELECT = {
  startsAt: true,
  autoChargeDate: true,
  refundPolicy: true,
  refundUntilAt: true,
  refundUntilDays: true,
  refundNote: true,
} as const;

export type RefundPolicy = {
  kind: RefundPolicyKind;
  /** The moment refunds stop. Null for ANYTIME and NONE. */
  deadline: Date | null;
  note: string | null;
};

const asDate = (v: Date | string | null | undefined): Date | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** `days` calendar days before `at`, at the same clock time in the club's timezone. */
export function daysBeforeInZone(at: Date, days: number, tz: string | null | undefined): Date {
  if (!tz) return new Date(at.getTime() - days * 86_400_000);
  try {
    const wall = new Date(at.getTime() + tzOffsetMs(tz, at));
    wall.setUTCDate(wall.getUTCDate() - days);
    return wallClockUTCToInstant(wall, tz);
  } catch {
    return new Date(at.getTime() - days * 86_400_000);
  }
}

/** The event's policy, or null when none is set (or it is half-filled). */
export function readRefundPolicy(e: RefundPolicyEvent, tz: string | null | undefined): RefundPolicy | null {
  const kind = (REFUND_POLICIES as readonly string[]).includes(e.refundPolicy ?? "") ? (e.refundPolicy as RefundPolicyKind) : null;
  if (!kind) return null;
  const note = e.refundNote?.trim() || null;
  const startsAt = asDate(e.startsAt);
  if (kind === "ANYTIME" || kind === "NONE") return { kind, deadline: null, note };
  let deadline: Date | null = null;
  if (kind === "UNTIL") {
    deadline = asDate(e.refundUntilAt);
    if (!deadline && startsAt && Number.isInteger(e.refundUntilDays) && (e.refundUntilDays as number) >= 0) {
      deadline = daysBeforeInZone(startsAt, e.refundUntilDays as number, tz);
    }
  } else if (startsAt) {
    deadline = eventScheduledChargeAt({ autoChargeDate: asDate(e.autoChargeDate), startsAt });
  }
  // A policy with no moment to point at would tell families nothing true.
  return deadline ? { kind, deadline, note } : null;
}

/** Can a family still get their money back right now? */
export function refundIsOpen(p: RefundPolicy, now: Date): boolean {
  if (p.kind === "ANYTIME") return true;
  if (p.kind === "NONE") return false;
  return !!p.deadline && now.getTime() < p.deadline.getTime();
}

// ── Dates ───────────────────────────────────────────────────────────────────

const clean = (s: string) => s.replace(/[  ]/g, " ");

/** "Dec 1, 5:00 PM" — the short form staff see. */
export function shortDeadline(d: Date, tz: string | null | undefined, now?: Date): string {
  return format(d, tz, { month: "short", day: "numeric" }, false, now);
}

/** "Tue, Dec 1, 5:00 PM EST" — the exact form families see. */
export function longDeadline(d: Date, tz: string | null | undefined, now?: Date): string {
  return format(d, tz, { weekday: "short", month: "short", day: "numeric" }, true, now);
}

function format(d: Date, tz: string | null | undefined, day: Intl.DateTimeFormatOptions, zone: boolean, now?: Date): string {
  const run = (timeZone?: string) => {
    const z = timeZone ? { timeZone } : {};
    const year = (x: Date) => new Intl.DateTimeFormat("en-US", { year: "numeric", ...z }).format(x);
    // The year only when it isn't this one.
    const withYear = now && year(now) !== year(d) ? { year: "numeric" as const } : {};
    const date = new Intl.DateTimeFormat("en-US", { ...day, ...withYear, ...z }).format(d);
    const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", ...(zone ? { timeZoneName: "short" as const } : {}), ...z }).format(d);
    return clean(`${date}, ${time}`);
  };
  try {
    return run(tz ?? undefined);
  } catch {
    return run();
  }
}

// ── Families ────────────────────────────────────────────────────────────────

export type RefundPolicyView = {
  kind: RefundPolicyKind;
  /** One plain sentence, then anything else worth saying. Never empty. */
  lines: string[];
  /** Refunds are over (or never were): the checkbox is required before paying. */
  mustAcknowledge: boolean;
  deadline: string | null;
};

export type RefundPolicyClub = { timezone?: string | null; passProcessingFees?: boolean | null; passPlatformFee?: boolean | null };

export function refundPolicyView(e: RefundPolicyEvent, club: RefundPolicyClub, now: Date): RefundPolicyView | null {
  const tz = club.timezone ?? null;
  const p = readRefundPolicy(e, tz);
  if (!p) return null;
  const open = refundIsOpen(p, now);
  const lines: string[] = [];
  const when = p.deadline ? longDeadline(p.deadline, tz, now) : null;
  switch (p.kind) {
    case "ANYTIME":
      lines.push("Refundable anytime before the event.");
      break;
    case "NONE":
      lines.push("Non-refundable. Once you pay, you won't get a refund.");
      break;
    case "UNTIL":
      lines.push(open ? `Refundable until ${when}. After that, no refunds.` : `The refund deadline was ${when}. No refunds now.`);
      break;
    case "UNTIL_CHARGED":
      lines.push(open ? `Refundable until cards are charged on ${when}. After that, no refunds.` : `Refunds ended when cards were charged on ${when}. No refunds now.`);
      break;
  }
  if (open && (club.passProcessingFees || club.passPlatformFee)) lines.push("A refund is for the event price. The card processing fee isn't refunded.");
  if (p.note) lines.push(p.note);
  return { kind: p.kind, lines, mustAcknowledge: !open, deadline: p.deadline ? p.deadline.toISOString() : null };
}

// ── Staff: information, not a lock ──────────────────────────────────────────

export type RefundOverride = { warning: string; audit: { policyOverride: true; policy: RefundPolicyKind; deadline: string | null }; auditNote: string };

/** Set when a staff refund goes past the policy; null when it doesn't, or none is set. */
export function refundOverride(e: RefundPolicyEvent, tz: string | null | undefined, now: Date): RefundOverride | null {
  const p = readRefundPolicy(e, tz);
  if (!p || refundIsOpen(p, now)) return null;
  const audit = { policyOverride: true as const, policy: p.kind, deadline: p.deadline ? p.deadline.toISOString() : null };
  if (!p.deadline) return { warning: "This event is non-refundable.", audit, auditNote: "Refunded although the event is non-refundable." };
  const when = shortDeadline(p.deadline, tz, now);
  return { warning: `This is past the refund deadline (${when}).`, audit, auditNote: `Refunded past the refund deadline (${when}).` };
}

// ── A family canceling themselves ───────────────────────────────────────────

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

export type SelfCancelPlan = {
  /** LEGACY = no policy set (or nothing to apply it to): the club reviews it, as before. */
  kind: "LEGACY" | "REFUND" | "NO_REFUND" | "NOT_CHARGED" | "RETURN_BY_HAND" | "BLOCKED";
  /** Shown BEFORE they confirm. */
  text: string;
  refundCents: number;
  /** What they agreed to. Sent back on confirm and compared, so a deadline
   *  that passes while the sheet is open is shown, never sprung on them. */
  token: string;
};

export function selfCancelPlan(input: {
  policy: RefundPolicy | null;
  now: Date;
  tz: string | null | undefined;
  /** The event costs money (a spot with no money record may still have been paid for). */
  priced: boolean;
  /** The athlete's live registrations on this event. */
  registrations: { status: string; paidCents: number; priceLeftCents: number; leftCents: number; feeCents: number; byCard: boolean; charging: boolean }[];
}): SelfCancelPlan {
  const plan = (kind: SelfCancelPlan["kind"], text: string, refundCents = 0): SelfCancelPlan => ({ kind, text, refundCents, token: `${kind}:${refundCents}` });
  const legacy = plan("LEGACY", "Already paid? Refunds aren't automatic. Canceling sends your club a refund request and they'll follow up.");
  if (!input.policy) return legacy;
  const closed = (p: RefundPolicy) =>
    plan("NO_REFUND", p.deadline ? `The refund deadline was ${longDeadline(p.deadline, input.tz, input.now)}. If you cancel now, you won't get a refund.` : "This event is non-refundable. If you cancel, you won't get a refund.");
  // A spot with no money record of its own: after the deadline the answer is
  // still no refund; before it, a person works out what they paid.
  if (input.registrations.length === 0) return input.priced && !refundIsOpen(input.policy, input.now) ? closed(input.policy) : legacy;
  // More than one to choose between: a person decides.
  if (input.registrations.length > 1) return legacy;
  const r = input.registrations[0];
  if (r.charging) return plan("BLOCKED", "Your card is being charged for this right now. Wait a few minutes and try again.");
  if (r.paidCents <= 0) return plan("NOT_CHARGED", "You haven't been charged for this. If you cancel, you won't be.");
  const p = input.policy;
  if (!refundIsOpen(p, input.now)) return closed(p);
  if (r.priceLeftCents <= 0) return plan("NO_REFUND", "The event price has already been refunded, so there's nothing more to send back.");
  if (!r.byCard) return plan("RETURN_BY_HAND", `You paid ${usd(r.paidCents)} in cash or by check. If you cancel, your club is told to return ${usd(r.priceLeftCents)} to you.`, r.priceLeftCents);
  return plan("REFUND", `You'll get ${usd(r.priceLeftCents)} back on the card you paid with, in 5 to 10 business days.${r.feeCents > 0 ? ` The ${usd(r.feeCents)} card processing fee isn't refunded.` : ""}`, r.priceLeftCents);
}

// ── Saving it ───────────────────────────────────────────────────────────────

export type RefundPolicyInput = { refundPolicy?: string | null; refundUntilAt?: string | null; refundUntilDays?: number | null; refundNote?: string | null };
export type RefundPolicyColumns = { refundPolicy: RefundPolicyKind | null; refundUntilAt: Date | null; refundUntilDays: number | null; refundNote: string | null };

/** One rule for create, edit and the editor's own check. Undefined policy = not sent, change nothing. */
export function normalizeRefundPolicy(i: RefundPolicyInput): { ok: true; columns: RefundPolicyColumns | null } | { ok: false; error: string } {
  if (i.refundPolicy === undefined) return { ok: true, columns: null };
  if (!i.refundPolicy) return { ok: true, columns: { refundPolicy: null, refundUntilAt: null, refundUntilDays: null, refundNote: null } };
  if (!(REFUND_POLICIES as readonly string[]).includes(i.refundPolicy)) return { ok: false, error: "Pick one of the refund choices." };
  const kind = i.refundPolicy as RefundPolicyKind;
  const note = (i.refundNote ?? "").trim().slice(0, 500) || null;
  if (kind !== "UNTIL") return { ok: true, columns: { refundPolicy: kind, refundUntilAt: null, refundUntilDays: null, refundNote: note } };
  const at = asDate(i.refundUntilAt);
  if (at) return { ok: true, columns: { refundPolicy: kind, refundUntilAt: at, refundUntilDays: null, refundNote: note } };
  const days = i.refundUntilDays;
  if (days == null || !Number.isInteger(days) || days < 0 || days > 365) return { ok: false, error: "Set when refunds stop: a date and time, or how many days before the event (0 to 365)." };
  return { ok: true, columns: { refundPolicy: kind, refundUntilAt: null, refundUntilDays: days, refundNote: note } };
}
