// B3 slice 1 — automatic event discounts. PURE: no prisma, no IO.
//
// Two rules a coach turns on per event (Event.autoDiscounts), plus the coach's
// own discount at approval:
//
//   SIBLING — one family registering more than one athlete. The first athlete
//             pays the price; each later one gets the amount off (or a ladder:
//             2nd x, 3rd+ y). Family = the registration's contact email plus
//             the athletes a signed-in parent is a confirmed guardian of
//             (resolved server-side, lib/eventAutoDiscountServer).
//   GROUP   — athletes sharing a value the coach names ("School", "Team").
//             Once N of them are registered, every one of them gets the rate.
//             Cohort-scoped: no "first pays full" — there's no first.
//   COACH   — a one-off amount the coach sets on one registration.
//
// Rules that hold everywhere (same as lib/eventDiscounts):
//   • One discount per registration. When a typed code and a rule both apply,
//     the one that saves the family more wins (ties go to the rule).
//   • Never raised automatically: a rule only ever lowers an unpaid price.
//     Someone leaving the group doesn't take a discount away.
//   • Discount first, processing fee second, on the discounted amount.

export type AmountRule = { type: "PERCENT" | "FIXED"; value: number };

export type SiblingConfig = {
  on: boolean;
  /** EACH_ADDITIONAL: every athlete after the first gets `each`.
   *  LADDER: tiers[0] = 2nd athlete, tiers[1] = 3rd, … the last tier carries on. */
  shape: "EACH_ADDITIONAL" | "LADDER";
  each?: AmountRule;
  tiers?: AmountRule[];
};

export type GroupConfig = {
  on: boolean;
  /** The coach's word for it — "School", "Team", "Club". Shown to families. */
  label: string;
  /** How many athletes with the same value before the rate applies (≥ 2). */
  threshold: number;
  amount: AmountRule;
  /** Optional pick-list. Empty = families type it (grouped case-insensitively). */
  options: string[];
};

export type AutoDiscounts = { sibling?: SiblingConfig; group?: GroupConfig };

export type DiscountSource = "CODE" | "SIBLING" | "GROUP" | "COACH";

/** The one discount a registration carries, whatever produced it. */
export type AppliedDiscount = {
  source: DiscountSource;
  /** CODE only. */
  id: string | null;
  code: string | null;
  type: "PERCENT" | "FIXED";
  value: number;
  label: string;
};

const MAX_TIERS = 6;

// ── reading / validating the config ─────────────────────────────────────────

function readAmount(raw: unknown): AmountRule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const type = r.type === "FIXED" ? "FIXED" : r.type === "PERCENT" ? "PERCENT" : null;
  const value = Number(r.value);
  if (!type || !Number.isFinite(value) || value <= 0) return null;
  if (type === "PERCENT" && value > 100) return null;
  return { type, value: Math.round(value * 100) / 100 };
}

/** Lenient read of whatever is stored — a bad or partial blob is "off", never a throw. */
export function parseAutoDiscounts(raw: unknown): AutoDiscounts {
  const out: AutoDiscounts = {};
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  const s = r.sibling as Record<string, unknown> | undefined;
  if (s && typeof s === "object") {
    const shape = s.shape === "LADDER" ? "LADDER" : "EACH_ADDITIONAL";
    const each = readAmount(s.each);
    const tiers = Array.isArray(s.tiers) ? s.tiers.map(readAmount).filter((t): t is AmountRule => !!t) : [];
    out.sibling = { on: s.on === true, shape, ...(each ? { each } : {}), ...(tiers.length ? { tiers } : {}) };
  }
  const g = r.group as Record<string, unknown> | undefined;
  if (g && typeof g === "object") {
    const amount = readAmount(g.amount);
    const threshold = Math.max(2, Math.floor(Number(g.threshold) || 2));
    const label = typeof g.label === "string" && g.label.trim() ? g.label.trim().slice(0, 40) : "School / team";
    const options = Array.isArray(g.options)
      ? g.options.filter((o): o is string => typeof o === "string" && !!o.trim()).map((o) => o.trim())
      : [];
    if (amount) out.group = { on: g.on === true, label, threshold, amount, options };
  }
  return out;
}

export function siblingActive(cfg: AutoDiscounts): boolean {
  const s = cfg.sibling;
  if (!s?.on) return false;
  return s.shape === "LADDER" ? !!s.tiers?.length : !!s.each;
}

export function groupActive(cfg: AutoDiscounts): boolean {
  return !!cfg.group?.on && !!cfg.group.amount;
}

/** Strict check for the editor's save. Returns the normalized blob to store. */
export function validateAutoDiscounts(
  input: unknown,
): { ok: true; value: AutoDiscounts } | { ok: false; message: string } {
  if (input == null) return { ok: true, value: {} };
  if (typeof input !== "object") return { ok: false, message: "Discounts must be an object." };
  const r = input as Record<string, unknown>;
  const value: AutoDiscounts = {};

  const s = r.sibling as Record<string, unknown> | undefined;
  if (s && typeof s === "object") {
    const on = s.on === true;
    const shape = s.shape === "LADDER" ? "LADDER" : "EACH_ADDITIONAL";
    if (shape === "EACH_ADDITIONAL") {
      const each = readAmount(s.each);
      if (on && !each) return { ok: false, message: "Sibling discount: enter an amount above 0 (percent at most 100)." };
      value.sibling = { on, shape, ...(each ? { each } : {}) };
    } else {
      const rawTiers = Array.isArray(s.tiers) ? s.tiers : [];
      if (rawTiers.length > MAX_TIERS) return { ok: false, message: `Sibling discount: at most ${MAX_TIERS} steps.` };
      const tiers: AmountRule[] = [];
      for (let i = 0; i < rawTiers.length; i++) {
        const t = readAmount(rawTiers[i]);
        if (!t) return { ok: false, message: `Sibling discount: the ${ordinalWord(i + 2)} athlete needs an amount above 0.` };
        tiers.push(t);
      }
      if (on && tiers.length === 0) return { ok: false, message: "Sibling discount: add at least the 2nd athlete's amount." };
      value.sibling = { on, shape, ...(tiers.length ? { tiers } : {}) };
    }
  }

  const g = r.group as Record<string, unknown> | undefined;
  if (g && typeof g === "object") {
    const on = g.on === true;
    const amount = readAmount(g.amount);
    const threshold = Math.floor(Number(g.threshold));
    const label = typeof g.label === "string" ? g.label.trim() : "";
    if (on) {
      if (!label) return { ok: false, message: "Group rate: name the thing athletes share (e.g. School)." };
      if (label.length > 40) return { ok: false, message: "Group rate: keep the name under 40 characters." };
      if (!Number.isFinite(threshold) || threshold < 2) return { ok: false, message: "Group rate: at least 2 athletes." };
      if (!amount) return { ok: false, message: "Group rate: enter an amount above 0 (percent at most 100)." };
    }
    const options = Array.isArray(g.options)
      ? Array.from(
          new Map(
            g.options
              .filter((o): o is string => typeof o === "string" && !!o.trim())
              .map((o) => [normalizeGroupValue(o), o.trim().slice(0, 80)] as const),
          ).values(),
        )
      : [];
    if (amount || on) {
      value.group = {
        on,
        label: label || "School / team",
        threshold: Number.isFinite(threshold) && threshold >= 2 ? threshold : 2,
        amount: amount ?? { type: "PERCENT", value: 10 },
        options,
      };
    }
  }
  return { ok: true, value };
}

// ── the arithmetic ──────────────────────────────────────────────────────────

/** "Lincoln High ", "lincoln  high" and "LINCOLN HIGH" are one group. */
export function normalizeGroupValue(s: string | null | undefined): string {
  return (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function amountOff(gross: number, rule: AmountRule | null): number {
  const base = Math.max(0, Math.round(gross * 100) / 100);
  if (!rule) return 0;
  const cut = rule.type === "PERCENT" ? (base * rule.value) / 100 : rule.value;
  const net = Math.max(0, Math.round((base - cut) * 100) / 100);
  return Math.round((base - net) * 100) / 100;
}

export function describeAmount(rule: AmountRule): string {
  return rule.type === "PERCENT" ? `${trimNum(rule.value)}% off` : `$${rule.value.toFixed(2).replace(/\.00$/, "")} off`;
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

export function ordinalWord(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

/** The rule for the athlete at `position` in their family (1 = first, pays the price). */
export function siblingRuleFor(cfg: AutoDiscounts, position: number): AmountRule | null {
  if (!siblingActive(cfg) || position < 2) return null;
  const s = cfg.sibling!;
  if (s.shape === "EACH_ADDITIONAL") return s.each ?? null;
  const tiers = s.tiers ?? [];
  return tiers[Math.min(position - 2, tiers.length - 1)] ?? null;
}

export function siblingLabel(position: number): string {
  return `Sibling discount (${ordinalWord(position)} athlete)`;
}

export function groupLabel(_cfg: AutoDiscounts, displayValue: string): string {
  return `${displayValue.trim()} group rate`;
}

/** True once `count` athletes (including this one) share the value. */
export function groupReached(cfg: AutoDiscounts, count: number): boolean {
  return groupActive(cfg) && count >= cfg.group!.threshold;
}

/** The candidates the rules produce for one registration. */
export function autoCandidates(args: {
  cfg: AutoDiscounts;
  /** 1 = the family's first athlete on this event. */
  siblingPosition: number;
  groupDisplay: string | null;
  /** Athletes sharing the group value, including this one. */
  groupCount: number;
}): AppliedDiscount[] {
  const out: AppliedDiscount[] = [];
  const sib = siblingRuleFor(args.cfg, args.siblingPosition);
  if (sib) out.push({ source: "SIBLING", id: null, code: null, ...sib, label: siblingLabel(args.siblingPosition) });
  if (args.groupDisplay && normalizeGroupValue(args.groupDisplay) && groupReached(args.cfg, args.groupCount)) {
    out.push({ source: "GROUP", id: null, code: null, ...args.cfg.group!.amount, label: groupLabel(args.cfg, args.groupDisplay) });
  }
  return out;
}

/**
 * One discount per registration: whichever saves the family the most, in
 * dollars on THIS price (10% and $40 aren't comparable in the abstract). A tie
 * goes to a rule over a typed code, then to the earlier candidate — so the
 * answer never flips between two recomputes.
 */
export function bestDiscount(
  gross: number,
  candidates: (AppliedDiscount | null | undefined)[],
): { winner: AppliedDiscount | null; considered: { d: AppliedDiscount; off: number }[] } {
  const considered = candidates.filter((c): c is AppliedDiscount => !!c).map((d) => ({ d, off: amountOff(gross, d) }));
  let winner: { d: AppliedDiscount; off: number } | null = null;
  for (const c of considered) {
    if (c.off <= 0) continue;
    if (!winner || c.off > winner.off || (c.off === winner.off && winner.d.source === "CODE" && c.d.source !== "CODE")) {
      winner = c;
    }
  }
  return { winner: winner?.d ?? null, considered };
}

/** "Sibling discount (2nd athlete) applied — it saves more than code SUMMER10." */
export function whyLine(winner: AppliedDiscount | null, considered: { d: AppliedDiscount; off: number }[]): string | null {
  if (!winner) return null;
  const typed = considered.find((c) => c.d.source === "CODE");
  if (typed && winner.source !== "CODE") return `${winner.label} applied — it saves more than code ${typed.d.code}.`;
  return null;
}

/**
 * When a group reaches its number, the athletes already in it get the rate
 * too — but only rows whose price can still change (nothing paid, no charge
 * authorized) and only where the rate beats what they already have. Paid rows
 * come back in `owedBack` so the coach can decide on a refund by hand.
 */
export function groupCatchUp(args: {
  cfg: AutoDiscounts;
  rows: {
    id: string;
    name: string;
    gross: number;
    currentOff: number;
    locked: boolean;
    source: string | null;
    /** Counted toward the number, but its price is never recomputed here
     *  (e.g. a per-session purchase whose price the list price can't rebuild). */
    fixed?: boolean;
  }[];
  displayValue: string;
}): { update: { id: string; discount: AppliedDiscount; off: number }[]; owedBack: { id: string; name: string; off: number }[] } {
  const update: { id: string; discount: AppliedDiscount; off: number }[] = [];
  const owedBack: { id: string; name: string; off: number }[] = [];
  if (!groupReached(args.cfg, args.rows.length)) return { update, owedBack };
  const d: AppliedDiscount = {
    source: "GROUP",
    id: null,
    code: null,
    ...args.cfg.group!.amount,
    label: groupLabel(args.cfg, args.displayValue),
  };
  for (const r of args.rows) {
    if (r.source === "COACH" || r.fixed) continue; // the coach's own number stands
    const off = amountOff(r.gross, d);
    if (off <= r.currentOff) continue;
    if (r.locked) owedBack.push({ id: r.id, name: r.name, off: Math.round((off - r.currentOff) * 100) / 100 });
    else update.push({ id: r.id, discount: d, off });
  }
  return { update, owedBack };
}

/** The lines families read before they register. */
export function autoDiscountSummary(cfg: AutoDiscounts): string[] {
  const out: string[] = [];
  if (siblingActive(cfg)) {
    const s = cfg.sibling!;
    if (s.shape === "EACH_ADDITIONAL") out.push(`Siblings: each athlete after the first gets ${describeAmount(s.each!)}.`);
    else
      out.push(
        `Siblings: ${s.tiers!
          .map((t, i) => `${ordinalWord(i + 2)}${i === s.tiers!.length - 1 ? "+" : ""} athlete ${describeAmount(t)}`)
          .join(", ")}.`,
      );
  }
  if (groupActive(cfg)) {
    const g = cfg.group!;
    out.push(`Group rate: once ${g.threshold} athletes from the same ${g.label.toLowerCase()} register, each gets ${describeAmount(g.amount)}.`);
  }
  return out;
}

/** What a signup page needs: the lines to show, and the group question to ask. */
export type AutoDiscountView = {
  lines: string[];
  group: { label: string; options: string[] } | null;
};

export function autoDiscountView(raw: unknown): AutoDiscountView {
  const cfg = parseAutoDiscounts(raw);
  return {
    lines: autoDiscountSummary(cfg),
    group: groupActive(cfg) ? { label: cfg.group!.label, options: cfg.group!.options } : null,
  };
}
