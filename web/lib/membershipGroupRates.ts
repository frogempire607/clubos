// B3 slice 3 — membership GROUP RATES. PURE: no prisma, no IO.
//
// A club defines any number of group rates, each naming what athletes share
// in the club's own words ("Team", "School", "Bus route", "Homeschool co-op")
// — nothing is assumed. A rate: once N athletes with the same answer hold a
// paid membership on a covered plan, each of them earns the amount off.
// Cohort-scoped (plan.md §9.1): no "first pays full", every athlete in the
// group gets it once N is met.
//
// The athlete's answer lives on the member (Member.groupValues, keyed by the
// rate's id), grouped on normalizeGroupValue so "Lincoln High " and "lincoln
// high" are one group. Same reach rules as the sibling discount: new purchases
// get it at checkout; running memberships are recommended, never repriced.

import { normalizeGroupValue, amountOff, describeAmount, type AmountRule } from "@/lib/eventAutoDiscounts";
import type { SiblingLine } from "@/lib/membershipSiblingDiscount";


export type GroupRate = {
  id: string;
  on: boolean;
  /** What athletes share — the question families and staff see. */
  label: string;
  threshold: number;
  amount: AmountRule;
  /** Optional pick-list; empty = typed (case/spacing ignored). */
  options: string[];
  /** Plans it counts and discounts; [] = every plan. */
  membershipIds: string[];
};

export const MAX_GROUP_RATES = 10;

function readAmount(raw: unknown): AmountRule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const type = r.type === "FIXED" ? "FIXED" : r.type === "PERCENT" ? "PERCENT" : null;
  const value = Number(r.value);
  if (!type || !Number.isFinite(value) || value <= 0 || (type === "PERCENT" && value > 100)) return null;
  return { type, value: Math.round(value * 100) / 100 };
}

const cleanOptions = (raw: unknown): string[] =>
  Array.isArray(raw)
    ? Array.from(new Map(raw.filter((o): o is string => typeof o === "string" && !!o.trim()).map((o) => [normalizeGroupValue(o), o.trim().slice(0, 80)] as const)).values()).slice(0, 200)
    : [];

/** Lenient read — junk entries are dropped, never thrown. */
export function parseGroupRates(raw: unknown): GroupRate[] {
  if (!Array.isArray(raw)) return [];
  const out: GroupRate[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const id = typeof o.id === "string" && o.id ? o.id : null;
    const label = typeof o.label === "string" ? o.label.trim().slice(0, 40) : "";
    const amount = readAmount(o.amount);
    if (!id || !label || !amount) continue;
    out.push({
      id, label, amount,
      on: o.on === true,
      threshold: Math.max(2, Math.floor(Number(o.threshold) || 2)),
      options: cleanOptions(o.options),
      membershipIds: Array.isArray(o.membershipIds) ? o.membershipIds.filter((x): x is string => typeof x === "string") : [],
    });
  }
  return out.slice(0, MAX_GROUP_RATES);
}

/** Strict check for the settings save. New rates get an id here. */
export function validateGroupRates(
  input: unknown,
  newId: () => string,
): { ok: true; value: GroupRate[] } | { ok: false; message: string } {
  if (!Array.isArray(input)) return { ok: false, message: "Send a list of group rates." };
  if (input.length > MAX_GROUP_RATES) return { ok: false, message: `At most ${MAX_GROUP_RATES} group rates.` };
  const out: GroupRate[] = [];
  const labels = new Set<string>();
  for (let i = 0; i < input.length; i++) {
    const o = (input[i] && typeof input[i] === "object" ? input[i] : {}) as Record<string, unknown>;
    const label = typeof o.label === "string" ? o.label.trim() : "";
    const n = i + 1;
    if (!label) return { ok: false, message: `Group rate ${n}: name what the athletes share (a team, a school…).` };
    if (label.length > 40) return { ok: false, message: `Group rate ${n}: keep the name under 40 characters.` };
    const key = normalizeGroupValue(label);
    if (labels.has(key)) return { ok: false, message: `Two group rates are both called "${label}". Give each its own name.` };
    labels.add(key);
    const threshold = Math.floor(Number(o.threshold));
    if (!Number.isFinite(threshold) || threshold < 2) return { ok: false, message: `${label}: at least 2 athletes.` };
    const amount = readAmount(o.amount);
    if (!amount) return { ok: false, message: `${label}: enter an amount above 0 (percent at most 100).` };
    out.push({
      id: typeof o.id === "string" && /^gr_[a-z0-9]{4,}$/.test(o.id) ? o.id : newId(),
      on: o.on === true,
      label: label.slice(0, 40),
      threshold,
      amount,
      options: cleanOptions(o.options),
      membershipIds: Array.isArray(o.membershipIds) ? Array.from(new Set(o.membershipIds.filter((x): x is string => typeof x === "string"))).slice(0, 100) : [],
    });
  }
  return { ok: true, value: out };
}

/** An athlete's answers, cleaned against the rates (unknown ids dropped; a
 *  pick-list answer must be on the list). */
export function cleanGroupValues(
  rates: GroupRate[],
  input: Record<string, unknown>,
): { ok: true; value: Record<string, string> } | { ok: false; message: string } {
  const out: Record<string, string> = {};
  for (const r of rates) {
    const raw = typeof input?.[r.id] === "string" ? (input[r.id] as string).trim().replace(/\s+/g, " ").slice(0, 80) : "";
    if (!raw) continue;
    if (r.options.length) {
      const hit = r.options.find((o) => normalizeGroupValue(o) === normalizeGroupValue(raw));
      if (!hit) return { ok: false, message: `Choose a ${r.label.toLowerCase()} from the list.` };
      out[r.id] = hit;
    } else out[r.id] = raw;
  }
  return { ok: true, value: out };
}

export function readGroupValues(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "string" && v.trim()) out[k] = v.trim();
  return out;
}

export const rateCovers = (r: GroupRate, membershipId: string | null | undefined) =>
  r.membershipIds.length === 0 || (!!membershipId && r.membershipIds.includes(membershipId));

export function groupRateLabel(r: GroupRate, value: string): string {
  return `${value} ${r.label.toLowerCase()} rate`;
}

/** One paid membership, as the group rates see it. */
export type GroupSub = {
  memberId: string;
  membershipId: string | null;
  listPrice: number;
  status: string;
  deliberateFree?: boolean;
  groupValues: Record<string, string>;
};

const LIVE = new Set(["active", "past_due", "trialing"]);

/** rate id → normalized value → the distinct athletes counting toward it. */
export function groupCounts(rates: GroupRate[], subs: GroupSub[]): Map<string, Map<string, Set<string>>> {
  const out = new Map<string, Map<string, Set<string>>>();
  for (const r of rates) {
    if (!r.on) continue;
    const m = new Map<string, Set<string>>();
    for (const s of subs) {
      if (!LIVE.has(s.status) || s.deliberateFree || !(s.listPrice > 0) || !rateCovers(r, s.membershipId)) continue;
      const v = normalizeGroupValue(s.groupValues[r.id]);
      if (!v) continue;
      if (!m.has(v)) m.set(v, new Set());
      m.get(v)!.add(s.memberId);
    }
    out.set(r.id, m);
  }
  return out;
}

export type GroupCandidate = { rateId: string; label: string; rule: AmountRule; off: number; count: number; threshold: number };

/**
 * The best group rate this athlete earns on a membership priced `listPrice` on
 * `membershipId` — the one that saves most in dollars; ties to the earlier
 * rate. `includeSelf` counts the athlete even if they aren't counted yet (a
 * purchase being made now).
 */
export function bestGroupRate(args: {
  rates: GroupRate[];
  counts: Map<string, Map<string, Set<string>>>;
  memberId: string;
  groupValues: Record<string, string>;
  membershipId: string | null;
  listPrice: number;
  includeSelf?: boolean;
}): GroupCandidate | null {
  let best: GroupCandidate | null = null;
  for (const r of args.rates) {
    if (!r.on || !rateCovers(r, args.membershipId)) continue;
    const display = args.groupValues[r.id];
    const v = normalizeGroupValue(display);
    if (!v) continue;
    const set = new Set(args.counts.get(r.id)?.get(v) ?? []);
    if (args.includeSelf) set.add(args.memberId);
    if (!set.has(args.memberId) || set.size < r.threshold) continue;
    const off = amountOff(args.listPrice, r.amount);
    if (off <= 0) continue;
    if (!best || off > best.off) best = { rateId: r.id, label: groupRateLabel(r, display!.trim()), rule: r.amount, off, count: set.size, threshold: r.threshold };
  }
  return best;
}

export function groupRateSummary(r: GroupRate): string {
  return `${r.label}: once ${r.threshold} athletes share one, each gets ${describeAmount(r.amount)}${r.on ? "" : " (off)"}.`;
}

// ── one answer per membership: sibling vs group rate ─────────────────────────


export type AutoLine = SiblingLine & {
  /** Which automatic discount the membership should carry, if any. */
  source: "SIBLING" | "GROUP" | null;
  rule: AmountRule | null;
};

/**
 * The sibling line (lib/membershipSiblingDiscount.planFamily) and the best
 * group rate, merged: whichever saves more on this membership's own price.
 * `expected` / `drift` / `label` are rewritten for the winner. A membership
 * carrying a hand-set (COACH) or bigger code price is never second-guessed.
 */
export function combineAuto(
  line: SiblingLine,
  sub: { price: number; discountSource?: string | null },
  group: GroupCandidate | null,
): AutoLine {
  const sibOff = line.rule ? amountOff(line.listPrice, line.rule) : 0;
  const grpOff = group?.off ?? 0;
  const useGroup = grpOff > 0 && grpOff > sibOff;
  const bestOff = useGroup ? grpOff : sibOff;
  const source: AutoLine["source"] = bestOff > 0 ? (useGroup ? "GROUP" : "SIBLING") : null;
  const expected = line.position != null || group ? Math.round((line.listPrice - bestOff) * 100) / 100 : line.expected;
  const auto = sub.discountSource === "SIBLING" || sub.discountSource === "GROUP";
  let drift: AutoLine["drift"] = null;
  if (expected != null) {
    if (source && sub.price > expected + 0.005 && sub.discountSource !== "COACH") drift = "DOWN";
    else if (auto && sub.price < expected - 0.005) drift = "UP";
  } else if (auto) drift = "UP";
  return {
    ...line,
    expected,
    drift,
    source,
    rule: useGroup ? group!.rule : line.rule,
    label: useGroup ? group!.label : source ? line.label : null,
  };
}
