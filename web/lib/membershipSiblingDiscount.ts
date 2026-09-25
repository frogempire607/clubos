// B3 slice 2 — the sibling MEMBERSHIP discount. PURE: no prisma, no IO.
//
// One rule per club (Club.siblingDiscount). A family = one payer: the
// subscription's payer, else the member's responsible payer, else their own
// login, else their primary guardian (resolved server-side). When a payer has
// two or more athletes on paid memberships, one athlete pays full price and
// every other gets the discount — which one pays full is the club's choice
// (Frog Empire: the pricier membership pays full, the cheaper one is
// discounted).
//
// How it reaches a price (Julian, 09-25):
//   • a NEW purchase gets it automatically at checkout (nothing live changes);
//   • a membership already running is never repriced on its own — it is
//     flagged ("recommended") and the owner applies it through Change plan.
//
// The amount shapes are the event sibling rule's (lib/eventAutoDiscounts):
// one amount for every extra athlete, or a ladder (2nd, 3rd, … last step
// carries on). One discount per membership: a typed code and the sibling
// discount compete, the bigger saving wins.

import {
  parseAutoDiscounts,
  validateAutoDiscounts,
  siblingRuleFor,
  amountOff,
  describeAmount,
  ordinalWord,
  type AmountRule,
  type SiblingConfig,
} from "@/lib/eventAutoDiscounts";

export type MembershipSiblingConfig = SiblingConfig & {
  /** Which athlete gets the discount: the cheaper memberships (the priciest
   *  pays full) or the pricier ones (the cheapest pays full). */
  discountWhich: "CHEAPER" | "PRICIER";
  /** Plans the rule covers; [] = every plan. Counting and discounting both. */
  membershipIds: string[];
};

export function parseMembershipSibling(raw: unknown): MembershipSiblingConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const s = parseAutoDiscounts({ sibling: r }).sibling ?? { on: false, shape: "EACH_ADDITIONAL" as const };
  return {
    ...s,
    discountWhich: r.discountWhich === "PRICIER" ? "PRICIER" : "CHEAPER",
    membershipIds: Array.isArray(r.membershipIds) ? r.membershipIds.filter((x): x is string => typeof x === "string") : [],
  };
}

export function validateMembershipSibling(
  input: unknown,
): { ok: true; value: MembershipSiblingConfig } | { ok: false; message: string } {
  if (!input || typeof input !== "object") return { ok: false, message: "Send the sibling discount settings." };
  const r = input as Record<string, unknown>;
  const v = validateAutoDiscounts({ sibling: r });
  if (!v.ok) return v;
  const s = v.value.sibling ?? { on: false, shape: "EACH_ADDITIONAL" as const };
  const ids = Array.isArray(r.membershipIds) ? r.membershipIds.filter((x): x is string => typeof x === "string").slice(0, 100) : [];
  return {
    ok: true,
    value: { ...s, discountWhich: r.discountWhich === "PRICIER" ? "PRICIER" : "CHEAPER", membershipIds: Array.from(new Set(ids)) },
  };
}

export function siblingOn(cfg: MembershipSiblingConfig): boolean {
  return !!siblingRuleFor({ sibling: cfg }, 2);
}

export function coversPlan(cfg: MembershipSiblingConfig, membershipId: string | null | undefined): boolean {
  return cfg.membershipIds.length === 0 || (!!membershipId && cfg.membershipIds.includes(membershipId));
}

export function membershipSiblingLabel(position: number): string {
  return `Sibling membership discount (${ordinalWord(position)} athlete)`;
}

/** Months each billing period covers — to compare a monthly and a quarterly
 *  membership on one scale when deciding which athlete pays full price. */
const MONTHS: Record<string, number> = {
  WEEKLY: 12 / 52,
  BIWEEKLY: 12 / 26,
  MONTHLY: 1,
  BIMONTHLY: 2,
  QUADRIMESTRAL: 4,
  QUARTERLY: 3,
  SEMI_ANNUAL: 6,
  ANNUAL: 12,
};

export function monthlyEquivalent(price: number, billingPeriod: string | null | undefined): number {
  const m = MONTHS[String(billingPeriod ?? "")] ?? 1;
  return price / m;
}

/** One membership in a payer's family, as the rule sees it. */
export type SiblingSub = {
  id: string;
  memberId: string;
  memberName: string;
  membershipId: string | null;
  /** This membership's price BEFORE any discount — its own agreed price
   *  (price + the discount it carries), so a grandfathered rate stays the
   *  base; for a purchase, the option's price. */
  listPrice: number;
  /** What the membership is priced at today. */
  price: number;
  billingPeriod: string | null;
  status: string;
  deliberateFree?: boolean;
  discountSource?: string | null;
  startDate?: Date | string | null;
};

export type SiblingLine = {
  subId: string;
  memberId: string;
  memberName: string;
  /** 1 = pays full price; null = not counted (comp, not covered, not live, a
   *  second membership of the same athlete). */
  position: number | null;
  rule: AmountRule | null;
  label: string | null;
  listPrice: number;
  price: number;
  /** The price the rule says, or null when the rule has nothing to say. */
  expected: number | null;
  /** DOWN = should be lower (discount missing / too small);
   *  UP   = carries a sibling discount it no longer earns. */
  drift: "DOWN" | "UP" | null;
};

const LIVE = new Set(["active", "past_due", "trialing"]);
const round = (n: number) => Math.round(n * 100) / 100;

function countable(cfg: MembershipSiblingConfig, s: SiblingSub): boolean {
  return LIVE.has(s.status) && !s.deliberateFree && s.listPrice > 0 && coversPlan(cfg, s.membershipId);
}

/**
 * The whole family at once. Ordinals are deterministic: the athlete who pays
 * full price is the priciest (discountWhich CHEAPER) or the cheapest (PRICIER),
 * compared per month; ties go to whoever started first, then the id — so a
 * recompute never moves the discount between children.
 */
export function planFamily(cfg: MembershipSiblingConfig, subs: SiblingSub[]): SiblingLine[] {
  const on = siblingOn(cfg);
  // One entry per athlete: their priciest countable membership represents them.
  const reps = new Map<string, SiblingSub>();
  for (const s of subs) {
    if (!countable(cfg, s)) continue;
    const cur = reps.get(s.memberId);
    if (!cur || monthlyEquivalent(s.listPrice, s.billingPeriod) > monthlyEquivalent(cur.listPrice, cur.billingPeriod)) reps.set(s.memberId, s);
  }
  const ordered = Array.from(reps.values()).sort((a, b) => {
    const ma = monthlyEquivalent(a.listPrice, a.billingPeriod);
    const mb = monthlyEquivalent(b.listPrice, b.billingPeriod);
    if (ma !== mb) return cfg.discountWhich === "CHEAPER" ? mb - ma : ma - mb;
    const ta = a.startDate ? new Date(a.startDate).getTime() : 0;
    const tb = b.startDate ? new Date(b.startDate).getTime() : 0;
    if (ta !== tb) return ta - tb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const pos = new Map(ordered.map((s, i) => [s.id, i + 1]));

  return subs.map((s) => {
    const position = pos.get(s.id) ?? null;
    const rule = on && position != null ? siblingRuleFor({ sibling: cfg }, position) : null;
    const expected = position == null ? null : round(s.listPrice - amountOff(s.listPrice, rule));
    let drift: SiblingLine["drift"] = null;
    if (on && expected != null) {
      if (rule && s.price > expected + 0.005 && s.discountSource !== "COACH") drift = "DOWN";
      else if (s.discountSource === "SIBLING" && s.price < expected - 0.005) drift = "UP";
    } else if (s.discountSource === "SIBLING" && (position == null || !on)) {
      drift = "UP";
    }
    return {
      subId: s.id,
      memberId: s.memberId,
      memberName: s.memberName,
      position,
      rule,
      label: rule && position ? membershipSiblingLabel(position) : null,
      listPrice: s.listPrice,
      price: s.price,
      expected,
      drift,
    };
  });
}

/** A purchase being made now: the family's live memberships plus this one. */
export function siblingForPurchase(
  cfg: MembershipSiblingConfig,
  family: SiblingSub[],
  purchase: Omit<SiblingSub, "id" | "price" | "status"> & { id?: string },
): { rule: AmountRule | null; label: string | null; position: number | null; off: number } {
  const id = purchase.id ?? "__new__";
  const lines = planFamily(cfg, [
    ...family.filter((f) => f.memberId !== purchase.memberId || f.id !== id),
    { ...purchase, id, price: purchase.listPrice, status: "active" },
  ]);
  const me = lines.find((l) => l.subId === id)!;
  return { rule: me.rule, label: me.label, position: me.position, off: amountOff(purchase.listPrice, me.rule) };
}

/** The settings page's one-line summary. */
export function membershipSiblingSummary(cfg: MembershipSiblingConfig): string {
  if (!siblingOn(cfg)) return "Off";
  const amount =
    cfg.shape === "EACH_ADDITIONAL"
      ? `each athlete after the first gets ${describeAmount(cfg.each!)}`
      : cfg.tiers!.map((t, i) => `${ordinalWord(i + 2)}${i === cfg.tiers!.length - 1 ? "+" : ""} ${describeAmount(t)}`).join(", ");
  return `On — ${amount}; the ${cfg.discountWhich === "CHEAPER" ? "priciest" : "cheapest"} membership pays full price.`;
}
