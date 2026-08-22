// Membership purchase options — the ONE model for what a plan sells.
//
// PURE. No prisma, no Stripe, no Date.now(). Every function takes what it needs
// so a fixture can construct one by hand.
//
// ── Why this file exists ────────────────────────────────────────────────────
//
// `Membership.options` is a JSON column holding `[{label, price,
// billingPeriod}]`, and every fact about a purchase beyond those three lives
// one level up on the Membership row: `contractMonths`, `autoRenewDefault`,
// `allowManualRenewal` — one value each, shared by every option. That is why
// Frog Empire runs two membership records for one class: MS/HS needs a
// no-minimum monthly option AND a 12-month commitment option, and there is one
// `contractMonths` slot between them.
//
// Phase 8 moves those facts onto the option and adds two more (a stable id, and
// which weekdays the option grants). This module owns the resulting shape.
//
// ── It REPLACES lib/bulkPriceChange.parseMembershipOptions ──────────────────
//
// That parser is re-exported from here rather than left in place. Two parsers
// for one JSON blob would drift the first time somebody adds a key to one of
// them — the same way `memberDuplicates` logic got written twice on two
// branches and had to be reconciled by hand. There is one parser.

/** Billing periods the app can actually schedule. Order is display order. */
export const BILLING_PERIODS = [
  "WEEKLY",
  "MONTHLY",
  "QUADRIMESTRAL",
  "QUARTERLY",
  "SEMI_ANNUAL",
  "ANNUAL",
  "ONE_TIME",
] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];

/**
 * Which weekdays an option grants, evaluated against a ClassSession's date.
 *
 * `ALL` is the default for a missing key, so every option that exists today
 * keeps behaving exactly as it does. It means "every day of every class this
 * plan is accepted for" and stays true when the club adds a session — which is
 * why it is a distinct kind rather than sugar for a full day list. An option
 * that enumerates today's schedule silently un-covers its members the day a
 * Wednesday class appears.
 *
 * `COUNT` ("any two sessions a week") is a real club shape but needs a per-week
 * usage ledger and an answer to "which two did they use" that attendance alone
 * cannot give. It is RESERVED in the discriminant so adding it later is a code
 * change, not a second reshape of stored data. Nothing builds it in Phase 8.
 */
export type Entitlement =
  | { kind: "ALL" }
  | { kind: "DAYS"; days: number[] }
  | { kind: "COUNT"; perWeek: number };

export const ENTITLEMENT_ALL: Entitlement = { kind: "ALL" };

/**
 * A parsed option. Every Phase 8 field is nullable and means "inherit the
 * plan" — never "false" or "zero". That distinction is what makes this shippable
 * against live data: an option with none of these keys behaves identically to
 * how it behaves today.
 */
export type MembershipOption = {
  /** Stable, opaque, minted once, never reused. Null on rows not yet migrated. */
  id: string | null;
  /** What the member sees. Free text, renameable, NOT an identity. */
  label: string;
  price: number;
  billingPeriod: BillingPeriod;
  /** Minimum commitment in months. Null = inherit `Membership.contractMonths`. */
  contractMonths: number | null;
  /** Null = inherit `Membership.autoRenewDefault`. */
  autoRenewDefault: boolean | null;
  /** Which weekdays this option buys. Absent in storage ⇒ ALL. */
  entitlement: Entitlement;
  /**
   * D7 — documents that must be signed to buy THIS option. Null = none beyond
   * whatever the club already requires club-wide at PURCHASE. Reserved: parsed
   * and preserved on write, not yet enforced at purchase (that lands with the
   * minimum-term work).
   */
  requiredDocumentIds: string[] | null;
};

/**
 * `allowManualRenewal` is deliberately ABSENT from this type (decision D5).
 *
 * The column on `Membership` stays and keeps whatever value it holds — nothing
 * is dropped or backfilled — but it is not promoted to the option and it is no
 * longer offered in the editor. It has had no reader since it shipped, and
 * carrying a dead switch onto six options multiplies it sixfold and teaches
 * owners that the settings are unreliable. The question it gestured at — what
 * happens when a term ends — is answered properly by the renewal modes
 * (plan.md §8.14.2): TERM_THEN_ENDS vs TERM_THEN_RENEWS.
 */

const isPeriod = (v: unknown): v is BillingPeriod =>
  typeof v === "string" && (BILLING_PERIODS as readonly string[]).includes(v);

/** 0 = Sunday … 6 = Saturday — the SAME convention as RecurringClass.daysOfWeek. */
const isWeekday = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 6;

/**
 * Parse an entitlement, degrading toward MORE access on anything malformed.
 *
 * Direction matters. This value gates a child's class attendance; a blob we
 * cannot read must not silently lock somebody out of sessions they paid for.
 * A wrong "covered" shows up as a missed drop-in fee; a wrong "not covered"
 * shows up as a family turned away at the door.
 */
export function parseEntitlement(raw: unknown): Entitlement {
  if (!raw || typeof raw !== "object") return ENTITLEMENT_ALL;
  const o = raw as Record<string, unknown>;
  if (o.kind === "DAYS") {
    const days = Array.isArray(o.days) ? o.days.filter(isWeekday) : [];
    // An empty or entirely invalid day list is not "grants nothing" — it is a
    // blob we failed to read. Fall back to ALL.
    if (days.length === 0) return ENTITLEMENT_ALL;
    return { kind: "DAYS", days: Array.from(new Set(days)).sort((a, b) => a - b) };
  }
  if (o.kind === "COUNT") {
    const perWeek = Number(o.perWeek);
    if (Number.isFinite(perWeek) && perWeek > 0) return { kind: "COUNT", perWeek };
    return ENTITLEMENT_ALL;
  }
  return ENTITLEMENT_ALL;
}

/**
 * `memberships.options` is stored as a JSON *string* inside a json column, so
 * this double-parses. Verified in production:
 * `jsonb_typeof(options::jsonb) = 'string'`.
 *
 * Never throws. An entry missing label / billingPeriod / a finite price is
 * SKIPPED rather than defaulted — an option we cannot read is not an option we
 * should sell.
 */
export function parseOptions(raw: unknown): MembershipOption[] {
  let value: unknown = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value || "[]");
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];

  const out: MembershipOption[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    const label = typeof o.label === "string" ? o.label : null;
    const price = Number(o.price);
    if (!label || !isPeriod(o.billingPeriod) || !Number.isFinite(price)) continue;

    const contractMonths =
      o.contractMonths == null
        ? null
        : Number.isInteger(Number(o.contractMonths)) && Number(o.contractMonths) > 0
          ? Number(o.contractMonths)
          : null;

    out.push({
      id: typeof o.id === "string" && o.id.trim() ? o.id : null,
      label,
      price,
      billingPeriod: o.billingPeriod,
      contractMonths,
      autoRenewDefault: typeof o.autoRenewDefault === "boolean" ? o.autoRenewDefault : null,
      entitlement: parseEntitlement(o.entitlement),
      requiredDocumentIds: Array.isArray(o.requiredDocumentIds)
        ? o.requiredDocumentIds.filter((d): d is string => typeof d === "string" && !!d.trim())
        : null,
    });
  }
  return out;
}

/**
 * Build a complete option from the fields a caller actually cares about.
 *
 * Used by the editor's "add another option" button, and by every fixture. It
 * exists so nobody has to remember that a well-formed option carries five
 * fields beyond the three you type — forgetting one is how an option ends up
 * with `entitlement: undefined` and a coverage check that throws.
 */
export function makeOption(
  partial: Partial<MembershipOption> & Pick<MembershipOption, "label" | "price" | "billingPeriod">,
): MembershipOption {
  return {
    id: partial.id ?? null,
    label: partial.label,
    price: partial.price,
    billingPeriod: partial.billingPeriod,
    contractMonths: partial.contractMonths ?? null,
    autoRenewDefault: partial.autoRenewDefault ?? null,
    entitlement: partial.entitlement ?? ENTITLEMENT_ALL,
    requiredDocumentIds: partial.requiredDocumentIds ?? null,
  };
}

/** Back-compat name for the parser lib/bulkPriceChange.ts and its callers use. */
export const parseMembershipOptions = parseOptions;

/**
 * Serialize back to the stored shape, omitting every key that is null so a
 * plan nobody has touched keeps exactly the JSON it has today. Round-tripping
 * an untouched plan must not rewrite its options column.
 */
export function serializeOptions(options: MembershipOption[]): string {
  return JSON.stringify(
    options.map((o) => ({
      ...(o.id ? { id: o.id } : {}),
      label: o.label,
      price: o.price,
      billingPeriod: o.billingPeriod,
      ...(o.contractMonths != null ? { contractMonths: o.contractMonths } : {}),
      ...(o.autoRenewDefault != null ? { autoRenewDefault: o.autoRenewDefault } : {}),
      ...(o.entitlement.kind !== "ALL" ? { entitlement: o.entitlement } : {}),
      ...(o.requiredDocumentIds?.length ? { requiredDocumentIds: o.requiredDocumentIds } : {}),
    })),
  );
}

// ── Option identity ─────────────────────────────────────────────────────────

/**
 * Mint a stable option id.
 *
 * Opaque on purpose: it must never be derived from the label, the price or the
 * period, because all three change and the id must not. `nextRandom` is
 * injected so the pure module stays deterministic under test.
 */
export function mintOptionId(nextRandom: () => number = Math.random): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 10; i++) s += alphabet[Math.floor(nextRandom() * alphabet.length)];
  return `opt_${s}`;
}

/** Give every option without an id a fresh one. Existing ids are never reused or changed. */
export function withMintedIds(
  options: MembershipOption[],
  nextRandom: () => number = Math.random,
): MembershipOption[] {
  const taken = new Set(options.map((o) => o.id).filter((v): v is string => !!v));
  return options.map((o) => {
    if (o.id) return o;
    let id = mintOptionId(nextRandom);
    while (taken.has(id)) id = mintOptionId(nextRandom);
    taken.add(id);
    return { ...o, id };
  });
}

/**
 * Two options on one plan sharing BOTH billing period and price.
 *
 * This is the only condition under which the `(billingPeriod, price)` inference
 * in `resolveSubscriptionOption` becomes ambiguous, so the editor refuses to
 * save it. Refusing at write time is far cheaper than resolving it forever
 * after — and it costs the owner nothing, because two options that bill the
 * same amount on the same schedule are the same option with two names.
 */
export function findDuplicateOptions(
  options: MembershipOption[],
): Array<{ billingPeriod: BillingPeriod; price: number; labels: string[] }> {
  const groups = new Map<string, MembershipOption[]>();
  for (const o of options) {
    const key = `${o.billingPeriod}:${o.price}`;
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => ({
      billingPeriod: g[0].billingPeriod,
      price: g[0].price,
      labels: g.map((o) => o.label),
    }));
}

/**
 * The one gate a save must pass. Both membership routes call this; neither
 * keeps its own copy, and the message lives next to the rule that produces it.
 *
 * Two failures, deliberately distinguished:
 *
 *   MALFORMED         — the parser could not read an entry. Reported rather
 *                       than dropped, because a silently vanished purchase
 *                       option is a plan that no longer sells what the owner
 *                       thinks it sells.
 *   DUPLICATE_OPTION  — two options share a billing period AND a price. See
 *                       findDuplicateOptions for why this is refused at write
 *                       time rather than resolved forever after.
 */
export type OptionsValidation =
  | { ok: true; options: MembershipOption[] }
  | { ok: false; code: "MALFORMED"; error: string }
  | { ok: false; code: "DUPLICATE_OPTION"; error: string };

export function validateOptionsForSave(raw: unknown[]): OptionsValidation {
  const options = parseOptions(raw);
  if (options.length !== raw.length) {
    return {
      ok: false,
      code: "MALFORMED",
      error:
        "One or more purchase options are malformed — check that each has a label, " +
        "a price, and a billing period the app can schedule.",
    };
  }

  const dupes = findDuplicateOptions(options);
  if (dupes.length > 0) {
    const d = dupes[0];
    return {
      ok: false,
      code: "DUPLICATE_OPTION",
      error:
        `"${d.labels[0]}" and "${d.labels[1]}" are both $${d.price} ${prettyPeriodPhrase(d.billingPeriod)}. ` +
        "Two options that cost the same on the same schedule can't be told apart on a " +
        "member's subscription, so give one of them a different price or billing period.",
    };
  }

  return { ok: true, options };
}

export type OptionResolution =
  | { resolution: "exact"; option: MembershipOption }
  | { resolution: "inferred"; option: MembershipOption }
  | { resolution: "unresolved"; option: null; reason: "NO_MATCH" | "AMBIGUOUS" };

/**
 * Which option is a subscription actually on?
 *
 *   1. `optionId` matches an option id            → exact
 *   2. no optionId, exactly one (period, price)   → inferred, and FLAGGED
 *   3. anything else                              → unresolved. Never guessed.
 *
 * Matching by `optionLabel` is deliberately not a step. The migration/approve
 * path writes `optionLabel: planName`, so production carries rows labelled
 * "MS/HS" and "Jr Frogs" beside rows labelled "Monthly" — on the same plan, at
 * the same price. Kellan Lister reads "Upfront" for an option now called
 * "3 months Upfront" because it was renamed after he bought. Labels are for
 * humans; they are not identity.
 *
 * The three states are distinct because screens must render them differently.
 * An inferred option is a good guess and is never presented as fact; an
 * unresolved one is excluded from bulk selection and, in the coverage resolver,
 * fails OPEN.
 */
export function resolveSubscriptionOption(
  sub: { optionId?: string | null; billingPeriod?: string | null; price?: unknown },
  options: MembershipOption[],
): OptionResolution {
  if (sub.optionId) {
    const exact = options.find((o) => o.id === sub.optionId);
    if (exact) return { resolution: "exact", option: exact };
    // An optionId that matches nothing means the option was deleted from the
    // plan. That is not an inference problem, it is a missing option.
    return { resolution: "unresolved", option: null, reason: "NO_MATCH" };
  }

  const price = Number(sub.price ?? NaN);
  if (!sub.billingPeriod || !Number.isFinite(price)) {
    return { resolution: "unresolved", option: null, reason: "NO_MATCH" };
  }
  const matches = options.filter(
    (o) => o.billingPeriod === sub.billingPeriod && o.price === price,
  );
  if (matches.length === 1) return { resolution: "inferred", option: matches[0] };
  return {
    resolution: "unresolved",
    option: null,
    reason: matches.length > 1 ? "AMBIGUOUS" : "NO_MATCH",
  };
}

// ── Terms ───────────────────────────────────────────────────────────────────

export type PlanDefaults = {
  contractMonths?: number | null;
  autoRenewDefault?: boolean | null;
};

export type ResolvedTerms = {
  contractMonths: number | null;
  autoRenewDefault: boolean;
  /** Where each value came from — surfaced in the editor so inheritance is visible. */
  source: { contractMonths: "option" | "plan" | "none"; autoRenewDefault: "option" | "plan" | "default" };
};

/** Option value → plan column → hard default. Never the other way round. */
export function resolveTerms(option: MembershipOption, plan: PlanDefaults): ResolvedTerms {
  const contractMonths =
    option.contractMonths != null
      ? { v: option.contractMonths, s: "option" as const }
      : plan.contractMonths != null
        ? { v: plan.contractMonths, s: "plan" as const }
        : { v: null, s: "none" as const };

  const autoRenew =
    option.autoRenewDefault != null
      ? { v: option.autoRenewDefault, s: "option" as const }
      : typeof plan.autoRenewDefault === "boolean"
        ? { v: plan.autoRenewDefault, s: "plan" as const }
        : { v: true, s: "default" as const };

  return {
    contractMonths: contractMonths.v,
    autoRenewDefault: autoRenew.v,
    source: { contractMonths: contractMonths.s, autoRenewDefault: autoRenew.s },
  };
}

const PERIOD_PHRASE: Record<BillingPeriod, string> = {
  WEEKLY: "per week",
  MONTHLY: "per month",
  QUADRIMESTRAL: "every 4 months",
  QUARTERLY: "every 3 months",
  SEMI_ANNUAL: "every 6 months",
  ANNUAL: "per year",
  ONE_TIME: "one-time",
};

/** "per month", "every 3 months" — the phrase used in owner-facing messages. */
export function prettyPeriodPhrase(period: BillingPeriod): string {
  return PERIOD_PHRASE[period];
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Tue & Thu", "Mon, Tue & Thu" — an Oxford-free list humans read at a glance. */
export function describeDays(days: number[]): string {
  const names = days.map((d) => DAY_NAMES[d] ?? String(d));
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
}

const money = (n: number) =>
  Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;

/**
 * The member-facing sentence, built from structured fields.
 *
 * Nothing else in the app may concatenate a price sentence. The reason is on
 * the current MS/HS card: "3 Months $160" and "12 months $150" are two labels
 * encoding a term the database does not hold — which is exactly how the second
 * plan came to carry the wrong `contractMonths`. If the sentence is derived,
 * the data has to be right for it to read right.
 */
export function describeOption(option: MembershipOption, plan: PlanDefaults = {}): string {
  const terms = resolveTerms(option, plan);
  const parts: string[] = [];

  if (option.billingPeriod === "ONE_TIME") {
    parts.push(`${money(option.price)} one-time`);
  } else {
    parts.push(`${money(option.price)} ${PERIOD_PHRASE[option.billingPeriod]}`);
  }

  if (terms.contractMonths != null) {
    // "$160 per month for 3 months" reads as a commitment; "$450 every 3 months
    // for 3 months" would read as gibberish, so a term that merely restates the
    // billing period is left off.
    const restatesPeriod =
      (option.billingPeriod === "QUARTERLY" && terms.contractMonths === 3) ||
      (option.billingPeriod === "QUADRIMESTRAL" && terms.contractMonths === 4) ||
      (option.billingPeriod === "SEMI_ANNUAL" && terms.contractMonths === 6) ||
      (option.billingPeriod === "ANNUAL" && terms.contractMonths === 12);
    if (!restatesPeriod) {
      parts.push(`for ${terms.contractMonths} month${terms.contractMonths === 1 ? "" : "s"}`);
    }
  }

  const out = [parts.join(" ")];
  if (option.entitlement.kind === "DAYS") out.push(describeDays(option.entitlement.days));
  if (terms.contractMonths == null && option.billingPeriod !== "ONE_TIME") {
    out.push("no minimum");
  }
  return out.join(" · ");
}

// ── Entitlement evaluation ──────────────────────────────────────────────────

/**
 * Turn a day-picker selection into a stored entitlement.
 *
 * The rule that matters: selecting EVERY day the club currently offers stores
 * `ALL`, not the enumerated list. An option that enumerates today's schedule
 * silently un-covers its members the day a Wednesday session is added — the
 * members did not change, the club did, and nobody would connect the two. `ALL`
 * means "everything this plan is accepted for" and stays true as the schedule
 * moves.
 *
 * `offered` is the union of `daysOfWeek` across the classes that accept this
 * plan. An empty selection is also `ALL`: "grants nothing" is not a product,
 * and a picker with nothing ticked is far more likely to be a coach who has not
 * finished than a deliberate lockout.
 */
export function entitlementFromSelection(selected: number[], offered: number[]): Entitlement {
  const picked = Array.from(new Set(selected.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)));
  if (picked.length === 0) return ENTITLEMENT_ALL;
  const offeredSet = new Set(offered);
  const coversEverythingOffered =
    offeredSet.size > 0 && [...offeredSet].every((d) => picked.includes(d));
  if (coversEverythingOffered) return ENTITLEMENT_ALL;
  return { kind: "DAYS", days: picked.sort((a, b) => a - b) };
}

/**
 * Which days a picker should show as ticked for an existing entitlement.
 * `ALL` ticks everything on offer, which is what it means.
 */
export function selectionFromEntitlement(entitlement: Entitlement, offered: number[]): number[] {
  if (entitlement.kind === "DAYS") return entitlement.days;
  return [...offered].sort((a, b) => a - b);
}

/**
 * Does this option grant the given weekday?
 *
 * `weekday` MUST come from `ClassSession.date.getUTCDay()`, with no timezone
 * conversion. lib/classSessions.ts generates sessions by walking UTC midnights
 * and selecting on `getUTCDay()`, then stamps wall-clock times as UTC — a
 * 19:00 class is stored 19:00Z. Converting through `Club.timezone` here would
 * INTRODUCE an off-by-one day, not fix one. Verified in production: MS/HS
 * Preseason stores date 2026-11-12 00:00 / startsAt 2026-11-12 19:00, both
 * DOW 4, matching the class's daysOfWeek [1,2,4].
 *
 * COUNT is not built; it returns true so a reserved shape can never silently
 * deny access.
 */
export function entitlementCoversWeekday(entitlement: Entitlement, weekday: number): boolean {
  if (entitlement.kind === "DAYS") return entitlement.days.includes(weekday);
  return true;
}
