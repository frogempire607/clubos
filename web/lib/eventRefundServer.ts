// Event refunds — the one engine (2026-11-25).
//
// Every refund of an event registration goes through refundEventRegistration:
// the Refund action, "Remove and refund", a coach's decline, a family turning
// down a proposed change. One Stripe call site, one idempotency rule, one
// place that writes what happened.
//
// ── Order ───────────────────────────────────────────────────────────────────
//   1. read the payment live from Stripe (what it says was refunded is the truth)
//   2. refuse a stale sheet, work the amount out again on these facts
//   3. ask Stripe, under a key that allows ONE refund per payment state
//   4. only after Stripe says yes: Transaction, then (if asked) take them off
//      the event, then audit, then the receipt
// A refusal writes one audit row and nothing else: the registration, the
// Transaction and the roster are exactly as they were.
//
// ── Where a refund is stored ────────────────────────────────────────────────
// On the Transaction (refundedAmount), never copied onto the registration.
// The charge.refunded webhook writes the same absolute number, so a refund is
// counted once. Financials, the event's Collected tile, the Attendees row and
// the family's registration page all read it from there
// (loadRegistrationRefunds below).

import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import type Stripe from "stripe";
import { REFUND_APPLICATION_FEE } from "@/lib/fees";
import type { Prisma } from "@prisma/client";
import { writeBillingAudit, type BillingAuditEntry } from "@/lib/billingAudit";
import { isUniqueViolation } from "@/lib/transactionOnce";
import { REFUND_POLICY_SELECT, refundOverride, type RefundPolicyEvent } from "@/lib/eventRefundPolicy";
import { sendRefundReceipt, type RefundReceipt } from "@/lib/eventRefundEmail";
import {
  REFUNDED_ACTION,
  REFUND_FAILED_ACTION,
  cardText,
  centsText,
  describeRefundError,
  refundFacts,
  refundIdempotencyKey,
  refundIsStale,
  refundLeft,
  resolveRefund,
  type RefundFacts,
  type RefundMode,
  type RefundVia,
} from "@/lib/eventRefunds";

// ── Reading ─────────────────────────────────────────────────────────────────

const TARGET_SELECT = {
  id: true,
  eventId: true,
  clubId: true,
  memberId: true,
  name: true,
  email: true,
  status: true,
  amountDue: true,
  amountPaid: true,
  paidVia: true,
  transactionId: true,
  stripePaymentIntentId: true,
  event: { select: { id: true, name: true, ...REFUND_POLICY_SELECT } },
  club: { select: { id: true, name: true, timezone: true, stripeAccountId: true, contactEmail: true, contactPhone: true } },
} as const;

const TX_SELECT = {
  id: true,
  amount: true,
  status: true,
  refundedAmount: true,
  notes: true,
  paymentMethod: true,
  paymentSource: true,
  reconciliationStatus: true,
  stripePaymentIntentId: true,
  stripeChargeId: true,
} as const;

export type RefundTarget = {
  reg: {
    id: string;
    eventId: string;
    clubId: string;
    memberId: string | null;
    name: string;
    email: string | null;
    status: string;
    amountDue: unknown;
    amountPaid: unknown;
    paidVia: string | null;
    transactionId: string | null;
    stripePaymentIntentId: string | null;
    event: { id: string; name: string } & RefundPolicyEvent;
    club: { id: string; name: string; timezone: string | null; stripeAccountId: string | null; contactEmail: string | null; contactPhone: string | null };
  };
  tx: {
    id: string;
    amount: unknown;
    status: string;
    refundedAmount: unknown;
    notes: string | null;
    paymentMethod: string | null;
    paymentSource: string | null;
    reconciliationStatus: string | null;
    stripePaymentIntentId: string | null;
    stripeChargeId: string | null;
  } | null;
};

/** The payment behind a registration: by its card payment first, then by the linked row. */
export function matchTransaction<T extends { id: string; stripePaymentIntentId: string | null }>(
  reg: { transactionId: string | null; stripePaymentIntentId: string | null },
  txs: T[],
): T | null {
  return (
    (reg.stripePaymentIntentId ? txs.find((t) => t.stripePaymentIntentId === reg.stripePaymentIntentId) : undefined) ??
    (reg.transactionId ? txs.find((t) => t.id === reg.transactionId) : undefined) ??
    null
  );
}

/** Dollars refunded on a payment row. REFUNDED always means all of it. */
export function txRefunded(tx: { amount: unknown; refundedAmount: unknown; status: string } | null | undefined): number {
  if (!tx) return 0;
  return tx.status === "REFUNDED" ? Number(tx.amount) : Number(tx.refundedAmount ?? 0);
}

function viaOf(t: RefundTarget): RefundVia {
  if (t.reg.stripePaymentIntentId) return "CARD";
  const v = (t.reg.paidVia ?? t.tx?.paymentSource ?? t.tx?.paymentMethod ?? "").toUpperCase();
  return v === "CASH" ? "CASH" : v === "CHECK" ? "CHECK" : "OTHER";
}

export type LivePayment = {
  refundedCents: number;
  card: { brand: string | null; last4: string | null } | null;
};

// ── The outside world, replaceable so the tests run the real engine ─────────

export type RefundDeps = {
  load(clubId: string, eventId: string | null, regId: string): Promise<RefundTarget | null>;
  /** The payment as Stripe has it right now. Throws when Stripe can't be read. */
  live(paymentIntentId: string, stripeAccount: string): Promise<LivePayment>;
  /** How many refunds Stripe has definitely refused on this registration. */
  refusals(clubId: string, regId: string): Promise<number>;
  createRefund(
    params: Stripe.RefundCreateParams,
    opts: { stripeAccount: string; idempotencyKey: string },
  ): Promise<{ id: string; status: string | null; amountCents: number; chargeRefundedCents: number | null }>;
  /** Write the refund on the payment, only if its refunded figure is still
   *  `fromRefunded`. False = somebody (a second tap, the webhook) got there first. */
  recordRefund(input: {
    clubId: string;
    txId: string;
    fromRefunded: unknown;
    refundedTotal: number;
    full: boolean;
    actorUserId: string | null;
    reason: string;
    note: string;
    prevNotes: string | null;
  }): Promise<boolean>;
  audit: typeof writeBillingAudit;
  /** The audit row for a refund that happened, written once per refund id.
   *  False = it's already there (a replayed tap got Stripe's original refund back). */
  auditOnce(refundId: string, entry: BillingAuditEntry): Promise<boolean>;
  /** Take them off the event: registration CANCELED, roster spot freed. Money
   *  columns untouched. `keepBooking` = a family canceled itself, so its
   *  booking stays in their history as Canceled. */
  remove(reg: RefundTarget["reg"], keepBooking: boolean): Promise<void>;
  receipt: typeof sendRefundReceipt;
  now(): Date;
};

export const liveDeps: RefundDeps = {
  async load(clubId, eventId, regId) {
    const reg = await prisma.eventRegistration.findFirst({ where: { id: regId, clubId, ...(eventId ? { eventId } : {}) }, select: TARGET_SELECT });
    if (!reg) return null;
    const or = [
      ...(reg.stripePaymentIntentId ? [{ stripePaymentIntentId: reg.stripePaymentIntentId }] : []),
      ...(reg.transactionId ? [{ id: reg.transactionId }] : []),
    ];
    const txs = or.length ? await prisma.transaction.findMany({ where: { clubId, OR: or }, select: TX_SELECT }) : [];
    return { reg, tx: matchTransaction(reg, txs) };
  },
  async live(pi, stripeAccount) {
    const intent = await stripe.paymentIntents.retrieve(pi, { expand: ["latest_charge"] }, { stripeAccount });
    const ch = intent.latest_charge && typeof intent.latest_charge === "object" ? (intent.latest_charge as Stripe.Charge) : null;
    const c = ch?.payment_method_details?.card ?? null;
    return { refundedCents: ch?.amount_refunded ?? 0, card: c ? { brand: c.brand ?? null, last4: c.last4 ?? null } : null };
  },
  async refusals(clubId, regId) {
    return prisma.billingAuditLog.count({
      where: {
        clubId,
        action: REFUND_FAILED_ACTION,
        AND: [{ after: { path: ["registrationId"], equals: regId } }, { after: { path: ["definite"], equals: true } }],
      },
    });
  },
  async createRefund(params, opts) {
    const r = await stripe.refunds.create({ ...params, expand: ["charge"] }, opts);
    const ch = r.charge && typeof r.charge === "object" ? (r.charge as Stripe.Charge) : null;
    return { id: r.id, status: r.status, amountCents: r.amount, chargeRefundedCents: typeof ch?.amount_refunded === "number" ? ch.amount_refunded : null };
  },
  async recordRefund(x) {
    const done = await prisma.transaction.updateMany({
      where: { id: x.txId, clubId: x.clubId, refundedAmount: x.fromRefunded == null ? null : Number(x.fromRefunded) },
      data: {
        refundedAmount: x.refundedTotal,
        refundedAt: new Date(),
        refundReason: x.reason,
        refundedByUserId: x.actorUserId,
        ...(x.full ? { status: "REFUNDED" as const } : {}),
        notes: `${x.prevNotes ? x.prevNotes + "\n" : ""}${x.note}`,
      },
    });
    return done.count > 0;
  },
  async auditOnce(refundId, e) {
    try {
      await prisma.billingAuditLog.create({
        data: {
          // The id IS the guard: two copies of one tap can't both insert it.
          id: `evrefund:${refundId}`,
          clubId: e.clubId,
          memberId: e.memberId ?? null,
          actorUserId: e.actorUserId ?? null,
          action: e.action,
          before: e.before as Prisma.InputJsonValue,
          after: e.after as Prisma.InputJsonValue,
          note: e.note ?? null,
        },
      });
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      // An audit hiccup must not hide a refund that happened.
      console.error("[event refund] audit write failed", refundId, err);
      return true;
    }
  },
  audit: writeBillingAudit,
  async remove(reg, keepBooking) {
    await prisma.eventRegistration.updateMany({
      where: { id: reg.id, clubId: reg.clubId, status: { not: "CANCELED" } },
      // Only status and the link. amountPaid, transactionId and the payment
      // intent stay: they are what makes the money traceable.
      data: { status: "CANCELED", paymentUrl: null },
    });
    if (reg.memberId) {
      const where = { eventId: reg.eventId, memberId: reg.memberId };
      if (keepBooking) await prisma.booking.updateMany({ where, data: { status: "CANCELED" } });
      else await prisma.booking.deleteMany({ where });
    }
  },
  receipt: sendRefundReceipt,
  now: () => new Date(),
};

// ── What the sheet shows ────────────────────────────────────────────────────

export type RefundSheetData = {
  registrationId: string;
  name: string;
  eventName: string;
  via: RefundVia;
  /** "Visa ending in 4242", or null when Stripe couldn't be read. */
  card: string | null;
  facts: RefundFacts;
  leftCents: number;
  removed: boolean;
  /** Set when nothing can be refunded, with why. */
  blocked: string | null;
  /** Past the event's refund policy. Information, not a lock. */
  policyWarning: string | null;
};

const NO_PAYMENT = "There's no payment recorded on this registration, so there's nothing to refund.";
const CANT_READ_STRIPE = "We couldn't reach Stripe to check this payment, so nothing was refunded. Try again in a minute.";

function blockedReason(t: RefundTarget, via: RefundVia): string | null {
  if (!t.tx) return "This payment isn't in Financials yet, so it can't be refunded from here.";
  if (t.tx.reconciliationStatus === "VOID") return "This payment was voided, so there's nothing to refund.";
  if (t.tx.status !== "SUCCEEDED" && t.tx.status !== "REFUNDED") return "This payment hasn't gone through, so there's nothing to refund.";
  if (via === "CARD" && !t.reg.club.stripeAccountId) return "Stripe isn't connected for this club, so a card refund can't be sent from here.";
  return null;
}

async function readFacts(t: RefundTarget, deps: RefundDeps): Promise<{ facts: RefundFacts; via: RefundVia; card: string | null }> {
  const via = viaOf(t);
  const stored = Math.round(txRefunded(t.tx) * 100);
  let live: LivePayment | null = null;
  if (via === "CARD" && t.reg.club.stripeAccountId) {
    live = await deps.live(t.reg.stripePaymentIntentId as string, t.reg.club.stripeAccountId);
  }
  return {
    via,
    card: cardText(live?.card),
    facts: refundFacts({
      amountPaid: t.reg.amountPaid,
      amountDue: t.reg.amountDue,
      txAmount: t.tx?.amount,
      // A refund made in Stripe's own dashboard, and one whose webhook hasn't
      // arrived, both count. So does a chargeback, which only we store.
      refundedCents: Math.max(stored, live?.refundedCents ?? 0),
    }),
  };
}

export async function refundSheetData(clubId: string, eventId: string, regId: string, deps: RefundDeps = liveDeps): Promise<RefundSheetData | null> {
  const t = await deps.load(clubId, eventId, regId);
  if (!t) return null;
  const base = { registrationId: t.reg.id, name: t.reg.name, eventName: t.reg.event.name, removed: t.reg.status === "CANCELED" };
  let read: { facts: RefundFacts; via: RefundVia; card: string | null };
  let unreadable: string | null = null;
  try {
    read = await readFacts(t, deps);
  } catch (e) {
    console.error("[event refund] couldn't read the payment", regId, e);
    unreadable = CANT_READ_STRIPE.replace(", so nothing was refunded", "");
    read = { via: viaOf(t), card: null, facts: refundFacts({ amountPaid: t.reg.amountPaid, amountDue: t.reg.amountDue, txAmount: t.tx?.amount, refundedCents: Math.round(txRefunded(t.tx) * 100) }) };
  }
  const left = refundLeft(read.facts);
  const blocked =
    read.facts.paidCents <= 0 ? NO_PAYMENT
    : left <= 0 ? `The whole ${centsText(read.facts.paidCents)} has already been refunded.`
    : blockedReason(t, read.via) ?? unreadable;
  const policyWarning = refundOverride(t.reg.event, t.reg.club.timezone, deps.now())?.warning ?? null;
  return { ...base, via: read.via, card: read.card, facts: read.facts, leftCents: left, blocked, policyWarning };
}

// ── Doing it ────────────────────────────────────────────────────────────────

export type RefundInput = {
  clubId: string;
  eventId: string | null;
  registrationId: string;
  mode: RefundMode;
  customCents?: number | null;
  /** What the sheet showed as already refunded. Null = a system caller that isn't looking at a sheet. */
  expectedRefundedCents: number | null;
  actorUserId: string | null;
  /** Take them off the event too, but only once the refund has gone through. */
  remove?: boolean;
  /** With `remove`: the family canceled itself, keep its booking as Canceled. */
  keepBooking?: boolean;
  /** A person chose this, so a refund past the event's policy is recorded as an override. */
  byStaff?: boolean;
  /** "Refunded from Attendees", "Coach declined"… shown on the payment. */
  reason: string;
  /** false when the caller sends its own email about this. */
  sendReceipt?: boolean;
};

export type RefundResult =
  | { ok: true; refundId: string; cents: number; refundedTotalCents: number; paidCents: number; full: boolean; removed: boolean; via: RefundVia; card: string | null; message: string }
  | { ok: false; status: number; code: string; error: string };

export async function refundEventRegistration(input: RefundInput, deps: RefundDeps = liveDeps): Promise<RefundResult> {
  const t = await deps.load(input.clubId, input.eventId, input.registrationId);
  if (!t) return { ok: false, status: 404, code: "NOT_FOUND", error: "That registration wasn't found." };
  const { reg, tx } = t;
  if (!(Number(reg.amountPaid ?? 0) > 0)) return { ok: false, status: 409, code: "NOT_PAID", error: NO_PAYMENT };
  const via = viaOf(t);
  const why = blockedReason(t, via);
  if (why || !tx) return { ok: false, status: 409, code: "NOT_REFUNDABLE", error: why ?? NO_PAYMENT };

  let read: Awaited<ReturnType<typeof readFacts>>;
  try {
    read = await readFacts(t, deps);
  } catch (e) {
    console.error("[event refund] couldn't read the payment", reg.id, e);
    return { ok: false, status: 502, code: "STRIPE_UNREADABLE", error: CANT_READ_STRIPE };
  }
  const { facts, card } = read;
  const override = input.byStaff ? refundOverride(reg.event, reg.club.timezone, deps.now()) : null;
  if (input.expectedRefundedCents != null) {
    const stale = refundIsStale(input.expectedRefundedCents, facts);
    if (stale) return { ok: false, status: 409, code: "CHANGED", error: stale };
  }
  const want = resolveRefund(input.mode, input.customCents ?? null, facts);
  if (!want.ok) return { ok: false, status: 400, code: "AMOUNT", error: want.error };

  const fail = async (f: { kind: string; text: string; definite: boolean }, raw: unknown, status: number): Promise<RefundResult> => {
    console.error("[event refund] not refunded", reg.id, f.kind, raw);
    // The attempt is recorded; nothing else is written.
    await deps.audit({
      clubId: reg.clubId,
      memberId: reg.memberId,
      actorUserId: input.actorUserId,
      action: REFUND_FAILED_ACTION,
      before: { registrationId: reg.id, status: reg.status, amountPaid: facts.paidCents / 100, refunded: facts.refundedCents / 100 },
      after: {
        registrationId: reg.id,
        status: reg.status,
        attempted: want.cents / 100,
        kind: f.kind,
        definite: f.definite,
        error: String((raw as { message?: unknown } | null)?.message ?? raw).slice(0, 300),
        ...(override?.audit ?? {}),
      },
      note: `Refund of ${centsText(want.cents)} to ${reg.name.trim()} for ${reg.event.name} did not go through. ${f.text}${input.remove ? " They are still registered." : ""}`,
    });
    return { ok: false, status, code: f.kind, error: f.text };
  };

  let refundId: string;
  let totalCents = facts.refundedCents + want.cents;
  if (via === "CARD") {
    const refusals = await deps.refusals(reg.clubId, reg.id);
    const opts = { stripeAccount: reg.club.stripeAccountId as string, idempotencyKey: refundIdempotencyKey(reg.id, facts.refundedCents, refusals) };
    try {
      const r = await deps.createRefund(
        {
          payment_intent: reg.stripePaymentIntentId as string,
          amount: want.cents,
          refund_application_fee: REFUND_APPLICATION_FEE,
          metadata: { eventRegistrationId: reg.id },
        },
        opts,
      );
      if (r.status === "failed" || r.status === "canceled") {
        return fail({ kind: "REFUSED", definite: true, text: "Stripe couldn't send this refund to the card, so nothing was refunded. Look at the payment in Stripe." }, `refund ${r.id} ${r.status}`, 502);
      }
      refundId = r.id;
      if (r.chargeRefundedCents != null) totalCents = Math.max(r.chargeRefundedCents, totalCents);
    } catch (e) {
      const f = describeRefundError(e);
      return fail(f, e, f.kind === "BUSY" ? 409 : 502);
    }
  } else {
    // No Stripe: the money is handed back by a person and this records it.
    // The conditional write below is the double-tap guard.
    refundId = `offline-${reg.id}-${facts.refundedCents}`;
  }

  const full = totalCents >= facts.paidCents;
  const howText = via === "CARD" ? `Stripe ${refundId}` : via === "CHECK" ? "by check" : via === "CASH" ? "in cash" : "by hand";
  let recorded = false;
  try {
    recorded = await deps.recordRefund({
      clubId: reg.clubId,
      txId: tx.id,
      fromRefunded: tx.refundedAmount ?? null,
      refundedTotal: totalCents / 100,
      full: totalCents >= Math.round(Number(tx.amount) * 100),
      actorUserId: input.actorUserId,
      reason: input.reason.slice(0, 120),
      note: `Refunded ${centsText(want.cents)} (${howText}). ${input.reason}.`,
      prevNotes: tx.notes,
    });
  } catch (e) {
    // The card refund has already happened. Saying "failed" here would invite
    // a second one; the charge.refunded webhook writes the same figure.
    console.error("[event refund] refunded but not recorded", reg.id, refundId, e);
  }
  if (via !== "CARD" && !recorded) {
    return { ok: false, status: 409, code: "CHANGED", error: "This refund was already recorded, or the payment just changed. Nothing more was recorded. Close this and open it again." };
  }

  let removed = reg.status === "CANCELED";
  if (input.remove && !removed) {
    try {
      await deps.remove(reg, !!input.keepBooking);
      removed = true;
    } catch (e) {
      // Refunded but still on the list. That is said, never hidden.
      console.error("[event refund] refunded but not removed", reg.id, e);
    }
  }
  const tookOff = !!input.remove && removed;

  const result: RefundResult = {
    ok: true,
    refundId,
    cents: want.cents,
    refundedTotalCents: totalCents,
    paidCents: facts.paidCents,
    full,
    removed: tookOff,
    via,
    card,
    message:
      (via === "CARD"
        ? `${centsText(want.cents)} refunded to ${card ?? "their card"}. It usually shows up in 5 to 10 business days.`
        : `${centsText(want.cents)} refund recorded. Hand it back ${via === "CHECK" ? "by check" : via === "CASH" ? "in cash" : "to them"}.`) + (input.remove && !removed ? ` ${reg.name.trim()} couldn't be taken off the event just now. Remove them again.` : ""),
  };

  const first = await deps.auditOnce(refundId, {
    clubId: reg.clubId,
    memberId: reg.memberId,
    actorUserId: input.actorUserId,
    action: REFUNDED_ACTION,
    before: { registrationId: reg.id, status: reg.status, amountPaid: facts.paidCents / 100, refunded: facts.refundedCents / 100, transactionId: tx.id },
    after: {
      registrationId: reg.id,
      status: removed ? "CANCELED" : reg.status,
      refundId,
      amount: want.cents / 100,
      refunded: totalCents / 100,
      full,
      mode: input.mode,
      via,
      ...(override?.audit ?? {}),
    },
    note: `${centsText(want.cents)} refunded to ${reg.name.trim()} for ${reg.event.name}. ${input.reason}.${tookOff ? " They were removed from the event." : ""}${override ? ` ${override.auditNote}` : ""}`,
  });
  // A replayed tap gets Stripe's original refund back; it has its audit row
  // and its receipt already.
  if (!first) return result;

  if (input.sendReceipt !== false) {
    const receipt: RefundReceipt = {
      clubName: reg.club.name,
      clubContact: reg.club.contactEmail ?? reg.club.contactPhone ?? null,
      eventName: reg.event.name,
      athleteName: reg.name.trim(),
      amount: want.cents / 100,
      paid: facts.paidCents / 100,
      refundedTotal: totalCents / 100,
      via,
      card,
      when: deps.now(),
      timeZone: reg.club.timezone,
      removed,
    };
    await deps.receipt({ clubId: reg.clubId, eventId: reg.eventId, reg: { id: reg.id, name: reg.name, email: reg.email, memberId: reg.memberId }, refundKey: refundId, actorUserId: input.actorUserId, receipt });
  }
  return result;
}

// ── Reading refunds back, for every screen that shows a registration ────────

export type RegistrationRefund = { refunded: number; refundedAt: Date | null; failed: boolean };

type RegForRefund = { id: string; amountPaid: unknown; transactionId: string | null; stripePaymentIntentId: string | null };

/** Which audit rows make a registration read "refund failed": a failure with
 *  no refund after it. Pure, newest-last or newest-first doesn't matter. */
export function failedRefundIds(rows: { action: string; after: unknown; before?: unknown; createdAt: Date }[]): Set<string> {
  const last = new Map<string, { action: string; at: number }>();
  for (const r of rows) {
    const pick = (v: unknown) => (v && typeof v === "object" && typeof (v as Record<string, unknown>).registrationId === "string" ? ((v as Record<string, unknown>).registrationId as string) : null);
    const id = pick(r.after) ?? pick(r.before);
    if (!id) continue;
    const at = r.createdAt.getTime();
    const prev = last.get(id);
    if (!prev || at >= prev.at) last.set(id, { action: r.action, at });
  }
  return new Set([...last].filter(([, v]) => v.action === REFUND_FAILED_ACTION).map(([k]) => k));
}

/**
 * Refund state for a set of registrations. One query for the payments, and
 * (unless `withFailed` is false) one for refused attempts. Never throws: a
 * screen that can't read refunds shows the payment without them.
 */
export async function loadRegistrationRefunds(clubId: string, regs: RegForRefund[], opts: { withFailed?: boolean } = {}): Promise<Map<string, RegistrationRefund>> {
  const out = new Map<string, RegistrationRefund>();
  const paid = regs.filter((r) => Number(r.amountPaid ?? 0) > 0);
  if (paid.length === 0) return out;
  const txIds = paid.map((r) => r.transactionId).filter((x): x is string => !!x);
  const pis = paid.map((r) => r.stripePaymentIntentId).filter((x): x is string => !!x);
  const [txs, audits] = await Promise.all([
    txIds.length || pis.length
      ? prisma.transaction
          .findMany({
            where: { clubId, OR: [...(txIds.length ? [{ id: { in: txIds } }] : []), ...(pis.length ? [{ stripePaymentIntentId: { in: pis } }] : [])] },
            select: { id: true, stripePaymentIntentId: true, amount: true, refundedAmount: true, refundedAt: true, status: true },
          })
          .catch(() => [])
      : [],
    opts.withFailed === false
      ? []
      : prisma.billingAuditLog
          .findMany({
            // Refund rows are few, so the club's own are read and matched in
            // memory rather than with one JSON condition per registration.
            where: { clubId, action: { in: [REFUNDED_ACTION, REFUND_FAILED_ACTION] } },
            orderBy: { createdAt: "desc" },
            take: 2000,
            select: { action: true, before: true, after: true, createdAt: true },
          })
          .catch(() => []),
  ]);
  const failed = failedRefundIds(audits);
  for (const r of paid) {
    const tx = matchTransaction(r, txs);
    out.set(r.id, { refunded: txRefunded(tx), refundedAt: tx?.refundedAt ?? null, failed: failed.has(r.id) });
  }
  return out;
}
