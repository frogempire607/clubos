// Does this member's membership cover THIS session, on THIS day?
//
// PURE. No prisma, no Stripe, no Date.now(). Callers load the rows and pass
// them in, which is what lets every branch be constructed by hand in a test.
//
// ── What this is for ────────────────────────────────────────────────────────
//
// Nine places currently ask the same question and all ask it the same
// incomplete way: "does this member have an `active` MemberSubscription whose
// membershipId is in the class's accepted list?" No option, no day, no term.
// So a $110 "Tue/Thu" member and a $175 full member are indistinguishable, and
// the club cannot sell a two-day membership without trusting the front desk to
// remember who is on it.
//
// This resolver answers the whole question once. §8.4.
//
// ── It warns; it does not block ─────────────────────────────────────────────
//
// Staff paths surface a verdict and record attendance anyway — a coach must
// always be able to write down who was in the room, and a membership question
// is not a reason to turn a child away at the door. Member self-serve paths
// price instead: someone booking a day they did not buy is quoted the drop-in
// rather than silently given a free session. `covered` is the fact; what each
// surface does with it is the surface's business.
//
// ── Fail OPEN, deliberately and asymmetrically ──────────────────────────────
//
// Every uncertain branch returns `covered: true`. A wrong "covered" costs the
// club one drop-in fee and is visible in the money later. A wrong "not covered"
// argues with a paying family at the front desk over a row the software could
// not read. Those are not symmetric, so the resolver only reports a shortfall
// when it can name it: a known option, a known day, and a real mismatch.

import {
  entitlementCoversWeekday,
  resolveSubscriptionOption,
  describeDays,
  type MembershipOption,
} from "@/lib/membershipOptions";

export type CoverageReason =
  | "COVERED"
  | "NO_ACTIVE_MEMBERSHIP"
  | "PLAN_NOT_ACCEPTED"
  | "DAY_NOT_INCLUDED"
  | "TERM_ENDED"
  | "OPTION_UNIDENTIFIED"
  | "NO_ACCEPTED_PLANS";

/** What a surface needs to render a verdict without re-deriving anything. */
export type CoverageVerdict = {
  covered: boolean;
  reason: CoverageReason;
  /** One front-desk sentence. Never a stack of clauses. */
  message: string;
  planName: string | null;
  optionLabel: string | null;
  optionResolution: "exact" | "inferred" | "unresolved" | "none";
  entitledDays: number[] | null;
  sessionWeekday: number;
  /** From the class's own pricingOptions. Null when the class configures none. */
  dropIn: { amount: number; source: "dropin" | "nonmember" } | null;
};

export type CoverageSubscription = {
  id: string;
  membershipId: string;
  status: string;
  optionId: string | null;
  optionLabel: string | null;
  billingPeriod: string | null;
  price: unknown;
  /** When access stops. Null = open-ended. */
  endDate: Date | null;
  /** The plan this subscription is on, with its parsed options. */
  plan: { id: string; name: string; options: MembershipOption[] } | null;
};

export type CoverageInput = {
  /** Every subscription the member holds. Filtering to `active` happens here. */
  subscriptions: CoverageSubscription[];
  /** membershipIds the class/event accepts. Empty = the class accepts no plan. */
  acceptedMembershipIds: string[];
  /**
   * The session's weekday, 0=Sun.
   *
   * MUST be `ClassSession.date.getUTCDay()` with NO timezone conversion.
   * lib/classSessions.ts generates sessions by walking UTC midnights, selecting
   * on `getUTCDay()`, and stamping wall-clock times as UTC — a 19:00 class is
   * stored 19:00Z. Converting through `Club.timezone` here would INTRODUCE an
   * off-by-one day. Verified against production: MS/HS Preseason stores
   * date 2026-11-12 00:00 / startsAt 2026-11-12 19:00, both DOW 4, matching the
   * class's daysOfWeek [1,2,4].
   */
  sessionWeekday: number;
  /** For the TERM_ENDED check. Pass the session's start instant. */
  sessionAt?: Date | null;
  dropIn?: { amount: number; source: "dropin" | "nonmember" } | null;
};

const ACTIVE = "active";

/**
 * NOT `resolveCoverage` — lib/paidThrough.ts already exports a function by that
 * name meaning something entirely different (how far a payment's money reaches,
 * in periods). Two same-named functions answering different questions in one
 * codebase is a bug waiting for whoever imports the wrong one.
 */
export function resolveSessionCoverage(input: CoverageInput): CoverageVerdict {
  const { acceptedMembershipIds, sessionWeekday } = input;
  const dropIn = input.dropIn ?? null;

  const base = {
    planName: null as string | null,
    optionLabel: null as string | null,
    optionResolution: "none" as CoverageVerdict["optionResolution"],
    entitledDays: null as number[] | null,
    sessionWeekday,
    dropIn,
  };

  // A class that accepts no plan at all is a paid class for everyone. That is a
  // pricing decision, not a coverage shortfall, so there is nothing to warn
  // about — the existing member/non-member/drop-in tiers already handle it.
  if (acceptedMembershipIds.length === 0) {
    return {
      ...base,
      covered: true,
      reason: "NO_ACCEPTED_PLANS",
      message: "This class isn't included in any membership — everyone pays a class price.",
    };
  }

  const active = input.subscriptions.filter((s) => s.status === ACTIVE);
  if (active.length === 0) {
    return {
      ...base,
      covered: false,
      reason: "NO_ACTIVE_MEMBERSHIP",
      message: dropIn
        ? `No active membership — drop-in $${fmt(dropIn.amount)}.`
        : "No active membership, and this class has no drop-in price set.",
    };
  }

  const onAccepted = active.filter((s) => acceptedMembershipIds.includes(s.membershipId));
  if (onAccepted.length === 0) {
    const held = active.map((s) => s.plan?.name).filter(Boolean).join(", ");
    return {
      ...base,
      covered: false,
      reason: "PLAN_NOT_ACCEPTED",
      planName: active[0]?.plan?.name ?? null,
      message:
        (held ? `${held} isn't accepted for this class. ` : "Their membership isn't accepted for this class. ") +
        (dropIn ? `Drop-in $${fmt(dropIn.amount)}.` : "No drop-in price is set on this class."),
    };
  }

  // A member can hold several accepted plans. ANY one covering the day is
  // enough, so evaluate all of them and keep the best answer — reporting a
  // shortfall on one plan while another covers the session would be wrong.
  let best: CoverageVerdict | null = null;

  for (const sub of onAccepted) {
    const options = sub.plan?.options ?? [];
    const res = resolveSubscriptionOption(
      { optionId: sub.optionId, billingPeriod: sub.billingPeriod, price: sub.price },
      options,
    );
    const planName = sub.plan?.name ?? null;

    // Term ended. Only claimed when there is a real date in the past — an
    // absent endDate is open-ended, never "expired".
    if (input.sessionAt && sub.endDate && sub.endDate.getTime() < input.sessionAt.getTime()) {
      best = better(best, {
        ...base,
        covered: false,
        reason: "TERM_ENDED",
        planName,
        optionLabel: sub.optionLabel,
        optionResolution: res.resolution === "unresolved" ? "unresolved" : res.resolution,
        message: `${planName ?? "Their membership"} ended ${dateStr(sub.endDate)}. ` +
          (dropIn ? `Drop-in $${fmt(dropIn.amount)}.` : "No drop-in price is set on this class."),
      });
      continue;
    }

    // Cannot identify the option ⇒ cannot judge the day. Fail OPEN and say so.
    // These are exactly the rows whose billing is already unusual (a $0 comp, a
    // legacy rate, a quarterly sum on a monthly row); warning on them would
    // train staff to ignore the warning.
    if (res.resolution === "unresolved") {
      best = better(best, {
        ...base,
        covered: true,
        reason: "OPTION_UNIDENTIFIED",
        planName,
        optionLabel: sub.optionLabel,
        optionResolution: "unresolved",
        message: `Couldn't identify which ${planName ?? "membership"} option they're on — coverage not checked.`,
      });
      continue;
    }

    const option = res.option;
    if (entitlementCoversWeekday(option.entitlement, sessionWeekday)) {
      // Covered. Nothing beats this, so return immediately.
      return {
        ...base,
        covered: true,
        reason: "COVERED",
        planName,
        optionLabel: option.label,
        optionResolution: res.resolution,
        entitledDays: option.entitlement.kind === "DAYS" ? option.entitlement.days : null,
        message: `Included in ${planName ?? "their membership"}${
          res.resolution === "inferred" ? " (option matched by price)" : ""
        }.`,
      };
    }

    const days = option.entitlement.kind === "DAYS" ? option.entitlement.days : [];
    best = better(best, {
      ...base,
      covered: false,
      reason: "DAY_NOT_INCLUDED",
      planName,
      optionLabel: option.label,
      optionResolution: res.resolution,
      entitledDays: days,
      message:
        `${option.label} covers ${describeDays(days)} — ${DAY_NAMES[sessionWeekday] ?? "this day"} isn't included. ` +
        (dropIn ? `Drop-in $${fmt(dropIn.amount)}.` : "No drop-in price is set on this class."),
    });
  }

  // onAccepted was non-empty, so the loop always produced a verdict.
  return best!;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

const dateStr = (d: Date) =>
  d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * Keep the more useful of two non-covering verdicts.
 *
 * Ranked by how actionable it is at the front desk. DAY_NOT_INCLUDED names the
 * exact shortfall and an amount, so it beats TERM_ENDED, which beats
 * OPTION_UNIDENTIFIED — the last being "we don't know", which is the least
 * useful thing to show somebody. A covering verdict never reaches here; the
 * loop returns on it.
 */
const RANK: Record<CoverageReason, number> = {
  COVERED: 100,
  DAY_NOT_INCLUDED: 40,
  TERM_ENDED: 30,
  OPTION_UNIDENTIFIED: 20,
  PLAN_NOT_ACCEPTED: 10,
  NO_ACTIVE_MEMBERSHIP: 10,
  NO_ACCEPTED_PLANS: 0,
};

function better(current: CoverageVerdict | null, candidate: CoverageVerdict): CoverageVerdict {
  if (!current) return candidate;
  // A covered verdict always wins, even against a higher-ranked shortfall:
  // holding one plan that covers the day is enough.
  if (candidate.covered && !current.covered) return candidate;
  if (current.covered && !candidate.covered) return current;
  return RANK[candidate.reason] > RANK[current.reason] ? candidate : current;
}

/**
 * Should a surface show a warning for this verdict?
 *
 * Not simply `!covered`. NO_ACTIVE_MEMBERSHIP and PLAN_NOT_ACCEPTED are already
 * handled by the existing member/non-member/drop-in pricing tiers — a staff
 * member adding a non-member to a class is not doing anything that needs
 * flagging, and duplicating that as a warning is noise that teaches people to
 * dismiss warnings.
 *
 * The warning exists for the case nothing else surfaces: a member who HAS a
 * valid, accepted membership that does not reach this day.
 */
export function shouldWarn(v: CoverageVerdict): boolean {
  return v.reason === "DAY_NOT_INCLUDED" || v.reason === "TERM_ENDED";
}
