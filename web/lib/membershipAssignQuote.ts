// Assign membership — the ONE price the Assign sheet shows and every assign
// path (saved card, cash/check, offer link) charges. PURE: no prisma, no IO.
// The database half is lib/membershipAssignQuoteServer.
//
// Julian, 09-30: "why under billing can I not add the sibling discount when I
// assign membership?" — the sheet only knew a price override. Now it carries
// the same automatic discounts every other purchase path gets (sibling, group
// rate) plus a staff discount code, under the same rule:
//
//   • one discount per membership — the bigger saving wins; a tie goes to the
//     automatic discount so a code isn't burned for nothing
//     (chooseMembershipDiscount, shared with membershipDiscountAtPurchase);
//   • staff can turn the automatic discount off for this assignment;
//   • a typed price ("Different price") wins over everything — no discount is
//     applied on top of it.
//
// The sibling math itself is NOT here — the family positions come from
// lib/membershipSiblingDiscount via membershipSiblingServer. This file only
// picks between candidates and words the result.

import type { ValidDiscount } from "@/lib/discounts";
import { describeAmount, type AmountRule } from "@/lib/eventAutoDiscounts";
import { computeProcessingFeeCents } from "@/lib/fees";
import { offerChargeLine } from "@/lib/chargeDate";

export type DiscountFields = {
  discountCode: string | null;
  discountAmount: number | null;
  discountSource: string | null;
  discountLabel: string | null;
  discountType: string | null;
  discountValue: number | null;
};

export const NO_DISCOUNT_FIELDS: DiscountFields = {
  discountCode: null, discountAmount: null, discountSource: null, discountLabel: null, discountType: null, discountValue: null,
};

export type AutoDiscount = {
  source: "SIBLING" | "GROUP";
  rule: AmountRule;
  /** Stored label — "Sibling membership discount (2nd athlete)", "Lincoln High school rate". */
  label: string;
  off: number;
  /** SIBLING: the first name of the athlete who pays full price (never this one). */
  fullPriceName?: string | null;
};

export type ChosenDiscount = {
  finalPrice: number;
  /** The typed code — only when it won (so only then is a use recorded). */
  code: ValidDiscount | null;
  fields: DiscountFields;
  /** "Sibling membership discount (2nd athlete)" or "code SUMMER10", for descriptions. */
  label: string | null;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The one discount a membership purchase gets: a typed code or the automatic
 * (sibling / group) discount, whichever saves more — a tie goes to the
 * automatic one. `codeNet` is the code's price after discount (the caller
 * computes it with lib/discounts discountedPrice).
 */
export function chooseMembershipDiscount(args: {
  list: number;
  code: ValidDiscount | null;
  codeNet: number;
  auto: { rule: AmountRule | null; label: string | null; off: number; source?: "SIBLING" | "GROUP" | null } | null;
}): ChosenDiscount {
  const list = r2(args.list);
  const codeOff = args.code ? r2(list - args.codeNet) : 0;
  const auto = args.auto;
  if (auto && auto.rule && auto.off > 0 && auto.off >= codeOff) {
    return {
      finalPrice: r2(list - auto.off),
      code: null,
      fields: {
        discountCode: null, discountAmount: auto.off, discountSource: auto.source ?? "SIBLING", discountLabel: auto.label,
        discountType: auto.rule.type, discountValue: auto.rule.value,
      },
      label: auto.label,
    };
  }
  if (args.code && codeOff > 0) {
    return {
      finalPrice: args.codeNet,
      code: args.code,
      fields: {
        discountCode: args.code.code, discountAmount: codeOff, discountSource: "CODE", discountLabel: args.code.code,
        discountType: args.code.type, discountValue: Number(args.code.value),
      },
      label: `code ${args.code.code}`,
    };
  }
  return {
    finalPrice: list,
    code: args.code, // a 0-off code still "applied" the way it always did
    fields: {
      discountCode: args.code?.code ?? null, discountAmount: null, discountSource: args.code ? "CODE" : null,
      discountLabel: args.code?.code ?? null, discountType: null, discountValue: null,
    },
    label: args.code ? `code ${args.code.code}` : null,
  };
}

/** The best automatic candidate: most dollars off; a tie goes to the sibling discount. */
export function bestAuto(autos: AutoDiscount[]): AutoDiscount | null {
  let best: AutoDiscount | null = null;
  for (const a of autos) {
    if (!(a.off > 0)) continue;
    if (!best || a.off > best.off || (a.off === best.off && a.source === "SIBLING" && best.source !== "SIBLING")) best = a;
  }
  return best;
}

export const PERIOD_SUFFIX: Record<string, string> = {
  WEEKLY: "/week", BIWEEKLY: " every 2 weeks", MONTHLY: "/month", BIMONTHLY: " every 2 months", QUARTERLY: "/quarter",
  QUADRIMESTRAL: " every 4 months", SEMI_ANNUAL: " every 6 months", ANNUAL: "/year", ONE_TIME: "",
};
export const moneyShort = (n: number) => `$${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`;

export type AssignMethod = "CARD" | "CASH" | "OFFER";

export type AssignCandidate = {
  source: "SIBLING" | "GROUP" | "CODE";
  /** "Sibling discount", "Lincoln High school rate", "Code SUMMER10". */
  title: string;
  amountLabel: string;
  off: number;
  finalPrice: number;
  fullPriceName: string | null;
  /** "Sibling discount · 25% off · $75 → $56.25/month · Jaden pays full price" */
  line: string;
  /** APPLIED = what is charged; LOST = the other discount saves more;
   *  OFF = staff turned the automatic discount off; OVERRIDDEN = a typed price wins. */
  status: "APPLIED" | "LOST" | "OFF" | "OVERRIDDEN";
  note: string | null;
};

export type AssignQuote = {
  basePrice: number;
  billingPeriod: string;
  periodSuffix: string;
  override: number | null;
  /** The per-period price after the one discount (or the typed price). */
  finalPrice: number;
  discountOff: number;
  applied: AssignCandidate | null;
  candidates: AssignCandidate[];
  /** Whether a family/group discount exists for this assignment (the "Don't apply" toggle shows). */
  autoAvailable: boolean;
  applyFamily: boolean;
  /** Processing fee on the discounted price — card only, when the club passes it. */
  fee: number;
  /** What the first charge is: card = price + fee; cash/check = price; offer = price before any card fee. */
  firstCharge: number;
  /** What a card is charged per period (price + fee when the club passes it) —
   *  the amount an offer link charges when the family pays by card. */
  cardCharge: number;
  fields: DiscountFields;
  /** Stored description label ("Sibling membership discount (2nd athlete)" / "code X"). */
  label: string | null;
  /** True only when the typed code is the discount charged (record a use). */
  codeWon: boolean;
  codeError: string | null;
  overrideNote: string | null;
  /** Something the owner should know about the family (e.g. this athlete pays full price). */
  familyNote: string | null;
  /** One plain sentence: what this athlete pays. */
  sentence: string;
};

function candidateLine(title: string, rule: AmountRule, base: number, final: number, suffix: string, fullPriceName: string | null) {
  return `${title} · ${describeAmount(rule)} · ${moneyShort(base)} → ${moneyShort(final)}${suffix}${fullPriceName ? ` · ${fullPriceName} pays full price` : ""}`;
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function composeAssignQuote(input: {
  firstName: string;
  listPrice: number;
  billingPeriod: string;
  override: number | null;
  applyFamily: boolean;
  autos: AutoDiscount[];
  code: ValidDiscount | null;
  /** The code's price after discount (lib/discounts discountedPrice); ignored without a code. */
  codeNet: number;
  codeError?: string | null;
  familyNote?: string | null;
  method: AssignMethod;
  passProcessingFees: boolean;
}): AssignQuote {
  const base = r2(input.listPrice);
  const suffix = PERIOD_SUFFIX[input.billingPeriod] ?? "";
  const override = input.override != null && Number.isFinite(input.override) ? r2(Math.max(0, input.override)) : null;
  const best = bestAuto(input.autos);

  const cands: AssignCandidate[] = [];
  for (const a of input.autos) {
    if (!(a.off > 0)) continue;
    const final = r2(base - a.off);
    const title = a.source === "SIBLING" ? "Sibling discount" : cap(a.label);
    cands.push({
      source: a.source, title, amountLabel: describeAmount(a.rule), off: a.off, finalPrice: final,
      fullPriceName: a.source === "SIBLING" ? a.fullPriceName ?? null : null,
      line: candidateLine(title, a.rule, base, final, suffix, a.source === "SIBLING" ? a.fullPriceName ?? null : null),
      status: "LOST", note: null,
    });
  }
  const codeOff = input.code ? r2(base - input.codeNet) : 0;
  if (input.code && codeOff > 0) {
    const title = `Code ${input.code.code}`;
    cands.push({
      source: "CODE", title, amountLabel: describeAmount({ type: input.code.type, value: Number(input.code.value) }), off: codeOff,
      finalPrice: r2(input.codeNet), fullPriceName: null,
      line: candidateLine(title, { type: input.code.type, value: Number(input.code.value) }, base, r2(input.codeNet), suffix, null),
      status: "LOST", note: null,
    });
  }

  let finalPrice: number;
  let fields: DiscountFields;
  let label: string | null;
  let codeWon = false;
  let applied: AssignCandidate | null = null;
  let overrideNote: string | null = null;

  if (override != null) {
    finalPrice = override;
    fields = { ...NO_DISCOUNT_FIELDS };
    label = null;
    for (const c of cands) { c.status = "OVERRIDDEN"; c.note = "Not applied — the price you typed is used as is."; }
    overrideNote = `The price you typed (${moneyShort(override)}${suffix}) is used as is — no discount is applied on top.`;
  } else {
    const chosen = chooseMembershipDiscount({
      list: base, code: input.code, codeNet: input.codeNet,
      auto: input.applyFamily && best ? { rule: best.rule, label: best.label, off: best.off, source: best.source } : null,
    });
    finalPrice = chosen.finalPrice;
    fields = chosen.fields;
    label = chosen.label;
    codeWon = !!chosen.code && chosen.fields.discountSource === "CODE" && (chosen.fields.discountAmount ?? 0) > 0;
    const winnerSource = chosen.fields.discountSource && (chosen.fields.discountAmount ?? 0) > 0 ? chosen.fields.discountSource : null;
    for (const c of cands) {
      const isBest = c.source === "CODE" || (best && c.source === best.source && c.off === best.off);
      if (winnerSource && c.source === winnerSource && isBest) { c.status = "APPLIED"; applied = c; continue; }
      if (c.source !== "CODE" && !input.applyFamily) { c.status = "OFF"; c.note = "Turned off for this assignment."; continue; }
      c.status = "LOST";
      c.note = winnerSource
        ? `Not applied — ${winnerSource === "CODE" ? "the code" : winnerSource === "SIBLING" ? "the sibling discount" : "the group rate"} saves more. One discount per membership.`
        : null;
    }
  }

  const fee = input.method === "CARD" && input.passProcessingFees && finalPrice > 0
    ? computeProcessingFeeCents(Math.round(finalPrice * 100)) / 100
    : 0;
  const firstCharge = r2(finalPrice + fee);
  const cardCharge = r2(finalPrice + (input.passProcessingFees && finalPrice > 0 ? computeProcessingFeeCents(Math.round(finalPrice * 100)) / 100 : 0));
  const first = input.firstName || "This athlete";
  let sentence: string;
  if (override != null) sentence = `${first} pays ${moneyShort(finalPrice)}${suffix} — the price you typed.`;
  else if (applied) sentence = `${first} pays ${moneyShort(finalPrice)}${suffix} instead of ${moneyShort(base)} — ${applied.source === "SIBLING" ? `sibling discount${applied.fullPriceName ? ` (${applied.fullPriceName} pays full price)` : ""}` : applied.source === "GROUP" ? applied.title.toLowerCase() : applied.title}.`;
  else sentence = `${first} pays ${moneyShort(finalPrice)}${suffix}.`;

  return {
    basePrice: base, billingPeriod: input.billingPeriod, periodSuffix: suffix, override, finalPrice,
    discountOff: r2(base - finalPrice > 0 && override == null ? base - finalPrice : 0),
    applied, candidates: cands, autoAvailable: !!best, applyFamily: input.applyFamily,
    fee, firstCharge, cardCharge, fields, label, codeWon,
    codeError: input.codeError ?? null, overrideNote, familyNote: input.familyNote ?? null, sentence,
  };
}

// ── The offer link's first charge ───────────────────────────────────────────
//
// A card-mode offer (the family adds a card on the link) cannot be created
// without an owner-approved first charge date — /reactivation refuses with
// DATE_REQUIRED. The sheet asks for it the way Card mode's "On a date" does
// (default: the start date) and says what happens. Cash/check offers carry no
// date. A date of today or earlier charges the moment they accept — the same
// test /reactivation applies (lib/billingAdmin chargeTiming).

const PERIOD_AFTER: Record<string, string> = {
  WEEKLY: "weekly", BIWEEKLY: "every 2 weeks", MONTHLY: "monthly", BIMONTHLY: "every 2 months", QUARTERLY: "every 3 months",
  QUADRIMESTRAL: "every 4 months", SEMI_ANNUAL: "every 6 months", ANNUAL: "yearly",
};

export function offerChargePlan(input: {
  /** Card-mode offer: Stripe is connected and the family pays by card on the link. */
  cardMode: boolean;
  /** YYYY-MM-DD picked in the sheet ("" = not picked). */
  date: string;
  cardCharge: number;
  billingPeriod: string;
  now?: Date;
  /**
   * The Assign sheet's "Starts" (YYYY-MM-DD). When given, the line uses the
   * same words as the card block (lib/chargeDate: "first charge $X on Oct 15,
   * 2026 · then monthly on the 15th") and a date before the start is refused.
   */
  startDate?: string;
}): { needsDate: boolean; firstChargeDate: string | null; immediate: boolean; ok: boolean; line: string } {
  if (!input.cardMode) {
    return { needsDate: false, firstChargeDate: null, immediate: false, ok: true, line: "Nothing is charged — they confirm from the link and the payment is recorded when it's received." };
  }
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(input.date) && !Number.isNaN(new Date(`${input.date}T00:00:00Z`).getTime());
  if (!valid) return { needsDate: true, firstChargeDate: null, immediate: false, ok: false, line: "Pick the first charge date — the offer can't be sent without one." };
  const d = new Date(`${input.date}T00:00:00Z`);
  const now = input.now ?? new Date();
  if (input.startDate) {
    const r = offerChargeLine({ dateISO: input.date, startISO: input.startDate, amount: input.cardCharge, period: input.billingPeriod, now });
    if (!r.ok) return { needsDate: true, firstChargeDate: null, immediate: false, ok: false, line: r.error };
    return { needsDate: true, firstChargeDate: input.date, immediate: r.immediate, ok: true, line: r.line };
  }
  const immediate = d.getTime() <= now.getTime() + 60_000;
  const after = PERIOD_AFTER[input.billingPeriod];
  const amount = `$${input.cardCharge.toFixed(2)}`;
  const when = immediate ? "as soon as they accept" : `on ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
  return {
    needsDate: true, firstChargeDate: input.date, immediate, ok: true,
    line: `Nothing is charged until they accept — then the card is charged ${amount} ${when}${after ? `, ${after} after` : ""}.`,
  };
}
