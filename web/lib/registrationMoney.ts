// What one event registration's money looks like to STAFF, in plain words —
// the method, the amount (with the card fee when the club passes it on), when
// it is or was charged, and exactly what Approve / Decline will do to it.
//
// PURE — no prisma, no Stripe, no Date.now() beyond the injected `now`. The
// Attendees screen (via GET /api/events/[id]/registrations) and the Approvals
// page (via GET /api/approvals) both render from this, so the two places a
// coach can approve say the same thing about the same row.
//
// Why per registration and not per event: one approval-gated event can carry
// several payment methods at once (Finger Lakes Duals: saved card charged on
// the charge date, payment link on approval, saved card charged the moment a
// coach approves). An event-level "charges on Nov 14" line was wrong for half
// the roster, and a coach clicking Approve had no way to know it moved money.
//
// Every sentence here mirrors what lib/eventApproval.approveRegistration /
// declineRegistration actually do:
//   APPROVAL_CHARGE  approve → SCHEDULED at now → charged in the same request
//   AUTO_CARD        approve → SCHEDULED at approvedAutoCardChargeAt (the
//                    event's charge date, or now if that date has passed →
//                    charged in the same request)
//   INVOICE          approve → REGISTERED + the first payment link emailed
//   CARD             already paid at signup; decline refunds in full
//   CASH / CHECK     approve confirms the spot; money is owed at the event;
//                    decline voids the pending offline transaction
//   no method + owes approve is REFUSED (NO_PAYMENT_METHOD)
// If that file changes, change this one and scripts/registration-money-tests.ts.

import { applyProcessingFee } from "@/lib/fees";
import { approvedAutoCardChargeAt } from "@/lib/eventPayments";

/** How a registration pays, in the words the Approvals page already used. */
export const REGISTRATION_METHOD_LABEL: Record<string, string> = {
  AUTO_CARD: "saved card",
  SAVED_CARD: "saved card",
  APPROVAL_CHARGE: "saved card, charged on approval",
  INVOICE: "billed after approval",
  CARD: "paid by card up front",
  CASH: "cash at the event",
  CHECK: "check at the event",
};

const CARD_METHODS = new Set(["AUTO_CARD", "SAVED_CARD", "APPROVAL_CHARGE", "INVOICE", "CARD"]);

export type MoneyRegistration = {
  name: string;
  paymentMethod: string | null;
  status: string;
  approvalStatus?: string | null;
  amountDue: unknown;
  amountPaid: unknown;
  scheduledChargeAt?: Date | string | null;
  paidAt?: Date | string | null;
  paidVia?: string | null;
  invoicedAt?: Date | string | null;
  invoiceCount?: number | null;
  lastChargeError?: string | null;
  sessionIds?: string[] | null;
  formResponses?: Record<string, unknown> | null;
  groupValue?: string | null;
  discountLabel?: string | null;
  discountCode?: string | null;
  discountAmount?: unknown;
  /** Roster spots asked for (B16), in entry order. DROPPED entries excluded by the caller. */
  entries?: { status: string; rosterLabel?: string | null; positionLabel?: string | null }[] | null;
};

export type MoneyEvent = {
  startsAt: Date | string;
  autoChargeDate?: Date | string | null;
  sessionCount?: number | null;
  /** Form answers worth showing in "registered for" (the event's category fields). */
  summaryFields?: { id: string; label: string }[] | null;
  /** The club's word for the group value ("School", "Team"). */
  groupLabel?: string | null;
};

export type MoneyClub = { passProcessingFees: boolean; timezone?: string | null };

export type ApproveEffectKind = "CHARGE_NOW" | "SCHEDULE" | "SEND_LINK" | "NONE" | "REFUND_ON_DECLINE" | "BLOCKED";
export type DeclineEffectKind = "REFUND" | "VOID_OFFLINE" | "NONE";
export type MoneyTone = "paid" | "scheduled" | "chargeOnApprove" | "owed" | "warn" | "muted";

export type RegistrationMoney = {
  method: string | null;
  methodLabel: string;
  /** What the family pays (or paid), card fee included when the club passes it. */
  amountLabel: string;
  totalCents: number;
  baseCents: number;
  feeCents: number;
  timing: string;
  tone: MoneyTone;
  /** True when approving this row moves money today. */
  chargesOnApprove: boolean;
  decidable: boolean;
  approveEffect: { kind: ApproveEffectKind; sentence: string; chargeNowCents: number };
  declineEffect: { kind: DeclineEffectKind; sentence: string; refundCents: number };
  registeredFor: string;
  registeredForParts: string[];
};

const DEFAULT_TZ = "America/New_York";

const num = (v: unknown): number => {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const toDate = (v: Date | string | null | undefined): Date | null => (v ? (v instanceof Date ? v : new Date(v)) : null);

export const moneyText = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * "Nov 14". A value stored at exactly 00:00 UTC is a calendar DATE (the
 * event's charge date is saved from a yyyy-mm-dd input), so it is read in UTC —
 * the same rule the member register route uses for "charged on Nov 14". Any
 * other value is an instant and is read in the club's timezone.
 */
export function moneyDay(d: Date, tz: string | null | undefined): string {
  const isDateOnly = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: isDateOnly ? "UTC" : tz || DEFAULT_TZ });
}

const firstName = (name: string) => (name.trim().split(/\s+/)[0] || name).trim();
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** "Whole event · 145 · Varsity" — what this person signed up for. */
function registeredForParts(reg: MoneyRegistration, ev: MoneyEvent): string[] {
  const parts: string[] = [];
  const entries = reg.entries ?? [];
  entries.forEach((e, i) => {
    if (!e.positionLabel && !e.rosterLabel) return;
    const spot = [e.positionLabel, e.rosterLabel].filter(Boolean).join(" · ");
    const pre = entries.length > 1 ? `Entry ${i + 1}: ` : "";
    parts.push(`${pre}${spot}${e.status === "WAITLIST" ? " (waitlist)" : ""}`);
  });
  const sessions = reg.sessionIds ?? [];
  const total = num(ev.sessionCount);
  if (sessions.length > 0) parts.push(sessions.length === 1 ? "1 session" : total > 0 ? `${sessions.length} of ${total} sessions` : `${sessions.length} sessions`);
  else parts.push(total > 1 ? `Whole event · ${total} sessions` : "Whole event");
  const answers = reg.formResponses ?? {};
  for (const f of ev.summaryFields ?? []) {
    const v = answers[f.id];
    if (v === undefined || v === null || v === "" || v === false) continue;
    parts.push(v === true ? f.label : `${f.label}: ${String(v)}`);
  }
  if (reg.groupValue) parts.push(`${ev.groupLabel || "Group"}: ${reg.groupValue}`);
  const off = Math.round(num(reg.discountAmount) * 100);
  const dname = reg.discountLabel || reg.discountCode;
  if (dname && off > 0) parts.push(`${dname} −${moneyText(off)}`);
  return parts;
}

export function describeRegistrationMoney(
  reg: MoneyRegistration,
  ev: MoneyEvent,
  club: MoneyClub,
  now: Date,
): RegistrationMoney {
  const tz = club.timezone;
  const day = (d: Date) => moneyDay(d, tz);
  const method = reg.paymentMethod ?? null;
  const who = firstName(reg.name);
  const due = num(reg.amountDue);
  const paid = num(reg.amountPaid);
  const status = reg.status;
  const pending = reg.approvalStatus === "PENDING" && status !== "CANCELED";
  const isCard = !!method && CARD_METHODS.has(method);

  // What the family pays for the money still to move. The charge engine and
  // the payment link both add the processing fee to amountDue at charge time.
  const baseCents = Math.round(due * 100);
  const fee = applyProcessingFee(baseCents, isCard && method !== "CARD" && club.passProcessingFees && baseCents > 0);
  const settled = status === "PAID" || paid > 0;
  const paidCents = Math.round(paid * 100);
  const totalCents = settled && paidCents > 0 ? paidCents : fee.totalCents;
  const owedCents = Math.max(0, baseCents - paidCents);
  const totalText = moneyText(totalCents);
  const amountLabel =
    totalCents <= 0 ? "Nothing owed"
    : settled ? `${totalText} paid`
    : fee.feeCents > 0 ? `${totalText} (${moneyText(baseCents)} + ${moneyText(fee.feeCents)} card fee)`
    : totalText;
  const methodLabel = method ? cap(REGISTRATION_METHOD_LABEL[method] ?? method.toLowerCase()) : totalCents > 0 ? "No payment method" : "Free";

  const scheduledAt = toDate(reg.scheduledChargeAt);
  const paidAt = toDate(reg.paidAt);
  const invoicedAt = toDate(reg.invoicedAt);
  const autoAt = approvedAutoCardChargeAt({ autoChargeDate: toDate(ev.autoChargeDate ?? null), startsAt: toDate(ev.startsAt) as Date }, now);
  const autoDue = autoAt.getTime() <= now.getTime();
  const offline = method === "CASH" || method === "CHECK";
  const offlineWord = method === "CHECK" ? "by check" : "cash";

  // ── Timing line ─────────────────────────────────────────────────────────
  let timing: string;
  let tone: MoneyTone = "muted";
  let chargesOnApprove = false;
  if (status === "CANCELED") {
    timing = reg.approvalStatus === "DECLINED" ? (paid > 0 ? `Declined · ${moneyText(paidCents)} refunded` : "Declined") : "Canceled";
  } else if (settled && status === "PAID") {
    tone = "paid";
    const when = paidAt ? ` ${day(paidAt)}` : "";
    if (method === "CARD") timing = `Paid by card at signup · ${totalText}${pending ? " · refunded if declined" : ""}`;
    else if (method === "INVOICE") timing = `Paid by link${when} · ${totalText}`;
    else if (offline || reg.paidVia === "CASH" || reg.paidVia === "CHECK")
      timing = `Paid ${totalText} ${reg.paidVia === "CHECK" || method === "CHECK" ? "by check" : "cash"}${when}`;
    else timing = `Charged${when} · ${totalText}`;
  } else if (pending) {
    if (method === "APPROVAL_CHARGE" && baseCents > 0) {
      tone = "chargeOnApprove";
      chargesOnApprove = true;
      timing = `Charges ${totalText} the moment you approve`;
    } else if ((method === "AUTO_CARD" || method === "SAVED_CARD") && baseCents > 0) {
      if (autoDue) {
        tone = "chargeOnApprove";
        chargesOnApprove = true;
        timing = `Charges ${totalText} the moment you approve — the charge date has passed`;
      } else {
        tone = "scheduled";
        timing = `Saved card · charged ${day(autoAt)} after approval · ${totalText}`;
      }
    } else if (method === "INVOICE" && baseCents > 0) timing = `Payment link sent when you approve · ${totalText}`;
    else if (method === "CARD" && settled) {
      tone = "paid";
      timing = `Paid by card at signup · ${totalText} · refunded if declined`;
    } else if (offline && baseCents > 0) {
      tone = "owed";
      timing = `Pays ${moneyText(owedCents)} ${offlineWord} at the event`;
    } else if (baseCents > 0 && !method) {
      tone = "warn";
      timing = `Owes ${moneyText(owedCents)} · no way to pay recorded`;
    } else timing = "Nothing owed";
  } else if (status === "SCHEDULED") {
    tone = "scheduled";
    if (scheduledAt && scheduledAt.getTime() <= now.getTime()) timing = `Saved card · charging now · ${totalText}`;
    else timing = `Saved card · charged ${scheduledAt ? day(scheduledAt) : day(autoAt)} · ${totalText}`;
  } else if (status === "PAYMENT_FAILED") {
    tone = "warn";
    timing = `Card charge failed · ${totalText} still due${reg.lastChargeError ? ` — ${reg.lastChargeError}` : ""}`;
  } else if (status === "PENDING_PAYMENT") {
    tone = "warn";
    timing = "Didn't finish card checkout · nothing charged";
  } else if (status === "AWAITING_CASH" || status === "AWAITING_CHECK") {
    tone = "owed";
    timing = `Pays ${moneyText(owedCents)} ${status === "AWAITING_CHECK" ? "by check" : "cash"} at the event`;
  } else if (method === "INVOICE" && owedCents > 0) {
    tone = "owed";
    timing = invoicedAt ? `Payment link sent ${day(invoicedAt)} · unpaid` : "Payment link not sent yet · unpaid";
  } else if (owedCents > 0) {
    tone = "owed";
    timing = invoicedAt ? `Payment link sent ${day(invoicedAt)} · unpaid` : `Owes ${moneyText(owedCents)} · no payment yet`;
  } else timing = "Nothing owed";

  // ── What Approve does ───────────────────────────────────────────────────
  let approveEffect: RegistrationMoney["approveEffect"];
  if (!pending) {
    approveEffect = { kind: "NONE", sentence: `${reg.name} has already been decided.`, chargeNowCents: 0 };
  } else if (baseCents > 0 && !method && !settled) {
    approveEffect = {
      kind: "BLOCKED",
      sentence: `${reg.name} owes ${moneyText(baseCents)} but has no way to pay recorded — send a payment link or record cash/check first.`,
      chargeNowCents: 0,
    };
  } else if (chargesOnApprove) {
    approveEffect = {
      kind: "CHARGE_NOW",
      sentence:
        method === "APPROVAL_CHARGE"
          ? `Approving ${who} charges their saved card ${totalText} now.`
          : `Approving ${who} charges their saved card ${totalText} now — the event's charge date (${day(autoAt)}) has already passed.`,
      chargeNowCents: totalCents,
    };
  } else if ((method === "AUTO_CARD" || method === "SAVED_CARD") && baseCents > 0) {
    approveEffect = {
      kind: "SCHEDULE",
      sentence: `Approving ${who} schedules their saved card for ${totalText} on ${day(autoAt)}. Nothing is charged today.`,
      chargeNowCents: 0,
    };
  } else if (method === "INVOICE" && baseCents > 0) {
    approveEffect = {
      kind: "SEND_LINK",
      sentence: `Approving ${who} emails them a payment link for ${totalText}. Nothing is charged until they pay it.`,
      chargeNowCents: 0,
    };
  } else if (settled) {
    approveEffect = {
      kind: "REFUND_ON_DECLINE",
      sentence: `Approving ${who} confirms their spot. They already paid ${totalText} by card — nothing more is charged.`,
      chargeNowCents: 0,
    };
  } else if (offline && baseCents > 0) {
    approveEffect = {
      kind: "NONE",
      sentence: `Approving ${who} confirms their spot. They owe ${moneyText(owedCents)} ${offlineWord} at the event — nothing is charged.`,
      chargeNowCents: 0,
    };
  } else {
    approveEffect = { kind: "NONE", sentence: `Approving ${who} confirms their spot. Nothing is owed.`, chargeNowCents: 0 };
  }

  // ── What Decline does ───────────────────────────────────────────────────
  let declineEffect: RegistrationMoney["declineEffect"];
  if (settled) {
    declineEffect = { kind: "REFUND", sentence: `Declining refunds ${who}'s ${totalText} in full to the card they paid with.`, refundCents: totalCents };
  } else if (offline && baseCents > 0) {
    declineEffect = { kind: "VOID_OFFLINE", sentence: `Declining cancels the ${moneyText(owedCents)} they owe ${offlineWord} — nothing was collected.`, refundCents: 0 };
  } else if ((method === "APPROVAL_CHARGE" || method === "AUTO_CARD" || method === "SAVED_CARD") && baseCents > 0) {
    declineEffect = { kind: "NONE", sentence: `Declining charges nothing — ${who}'s saved card is never charged.`, refundCents: 0 };
  } else if (method === "INVOICE" && baseCents > 0) {
    declineEffect = { kind: "NONE", sentence: `Declining sends no payment link — ${who} owes nothing.`, refundCents: 0 };
  } else {
    declineEffect = { kind: "NONE", sentence: "No money moves.", refundCents: 0 };
  }

  const parts = registeredForParts(reg, ev);
  return {
    method,
    methodLabel,
    amountLabel,
    totalCents,
    baseCents,
    feeCents: settled ? 0 : fee.feeCents,
    timing,
    tone,
    chargesOnApprove,
    decidable: pending,
    approveEffect,
    declineEffect,
    registeredFor: parts.join(" · "),
    registeredForParts: parts,
  };
}

/** The bulk approve summary: "Charged now: $174.94 (2 people)" and the button. */
export function approveBatchSummary(items: { money: Pick<RegistrationMoney, "approveEffect"> }[]): {
  count: number;
  chargeNowCents: number;
  chargeNowCount: number;
  blocked: number;
  chargedLine: string;
  buttonLabel: string;
} {
  const ok = items.filter((i) => i.money.approveEffect.kind !== "BLOCKED");
  const charging = ok.filter((i) => i.money.approveEffect.chargeNowCents > 0);
  const cents = charging.reduce((s, i) => s + i.money.approveEffect.chargeNowCents, 0);
  const n = ok.length;
  return {
    count: n,
    chargeNowCents: cents,
    chargeNowCount: charging.length,
    blocked: items.length - n,
    chargedLine:
      charging.length > 0
        ? `Charged now: ${moneyText(cents)} (${charging.length} ${charging.length === 1 ? "person" : "people"})`
        : "Nothing is charged today.",
    buttonLabel: cents > 0 ? `Approve ${n} · charge ${moneyText(cents)} now` : `Approve ${n} · nothing charged today`,
  };
}
