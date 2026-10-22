// Accounting Phase 3 — 1099 reporting, as a PURE module.
//
// No prisma, no next, no clock. lib/form1099Server.ts reads the payments;
// everything decided here is a function of its arguments and proven by
// scripts/form1099-tests.ts.
//
// ⚠️  THIS MODULE HANDLES NO TAX IDENTIFICATION NUMBER, AND NEITHER DOES
//     ANYTHING ELSE IN THIS PHASE.
//
// The brief asked for a contractor tax ID, encrypted at rest, masked to the
// last four, owner-only, never logged — and said to STOP and propose a design
// if the repo has no field-level encryption. It has none: there is no
// createCipheriv/decipheriv anywhere, no encryption key in .env.example, and
// every `crypto` import in lib/ is hashing, HMAC or random-token generation.
// So no TIN field was added and none is stored. The proposed design is written
// up in docs/accounting/plan.md under "1099 — the TIN question".
//
// Everything a threshold report needs EXCEPT the TIN is here and works: who
// was paid, how much, which payments are reportable, and who crossed the line.
// A club can use this to see exactly which contractors need a 1099 and for how
// much; filling in the TIN happens on the form, outside AthletixOS, until the
// encryption design is approved and built.
//
// NOTHING HERE FILES ANYTHING. It is a report and a CSV.

// ── Thresholds ──────────────────────────────────────────────────────────────
//
// Verified against IRS guidance (checked 2026-10-21):
//
//   · Payments made BEFORE 2026-01-01 → $600. The long-standing figure.
//   · Payments made ON OR AFTER 2026-01-01 → $2,000. Raised by the One Big
//     Beautiful Bill Act (OBBBA), §70433, for 1099-NEC and 1099-MISC.
//   · 2027 onwards → the $2,000 is indexed for inflation. The indexed figure
//     for a future year is NOT published yet, so this module does NOT invent
//     one: it falls back to the last known statutory figure and says, in
//     `thresholdNote`, that the year's indexed amount must be confirmed and
//     set on the club. A number quietly guessed here would be a wrong 1099.
//
// 1099-K is a DIFFERENT form with a different threshold ($20,000 and 200
// transactions), filed by the payment processor, not by the club. That is why
// card and processor payments are excluded below rather than counted here.
export const STATUTORY_THRESHOLD_CENTS: { fromYear: number; cents: number }[] = [
  { fromYear: 2026, cents: 200_000 },
  { fromYear: 0, cents: 60_000 },
];

/// The last year whose threshold is actually settled in statute. Beyond this,
/// the figure is inflation-indexed and has to be confirmed.
export const LAST_SETTLED_YEAR = 2026;

export function statutoryThresholdCents(year: number): number {
  for (const row of STATUTORY_THRESHOLD_CENTS) {
    if (year >= row.fromYear) return row.cents;
  }
  return 60_000;
}

export type ThresholdOverrides = Record<string, number> | null | undefined;

/// The threshold to use for a year: the club's own figure if it set one, else
/// the statutory default.
///
/// A club override is how a club records the indexed figure for 2027 and
/// beyond, and how it records a figure this code has not caught up with. It is
/// always the club's number that wins — the alternative is a hardcoded
/// constant going stale and nobody noticing until the forms are wrong.
export function thresholdCentsFor(year: number, overrides: ThresholdOverrides): number {
  const own = overrides?.[String(year)];
  if (typeof own === "number" && Number.isInteger(own) && own >= 0) return own;
  return statutoryThresholdCents(year);
}

export function thresholdIsOverridden(year: number, overrides: ThresholdOverrides): boolean {
  const own = overrides?.[String(year)];
  return typeof own === "number" && Number.isInteger(own) && own >= 0;
}

export function thresholdNote(year: number, overrides: ThresholdOverrides): string {
  if (thresholdIsOverridden(year, overrides)) {
    return `Using the threshold set for ${year} on this club.`;
  }
  if (year > LAST_SETTLED_YEAR) {
    return `The ${year} threshold is indexed for inflation and the figure is not published in this code. Showing the ${LAST_SETTLED_YEAR} statutory amount — confirm the ${year} figure with your accountant or the IRS instructions and set it below before you rely on this.`;
  }
  if (year >= 2026) {
    return `$2,000 for ${year} — raised from $600 by the One Big Beautiful Bill Act for payments made on or after 1 January 2026.`;
  }
  return `$600 for ${year}, the statutory amount for payments made before 1 January 2026.`;
}

// ── What counts ─────────────────────────────────────────────────────────────

/// Payment methods that are NOT reportable on a 1099-NEC/MISC, because the
/// payment processor reports them on a 1099-K instead. Paying a contractor by
/// card and also putting it on their 1099 reports the same money twice.
export const EXCLUDED_METHODS = ["CARD", "STRIPE", "PROCESSOR", "CREDIT"] as const;

export type PaymentMethodish = string | null | undefined;

export function methodIsExcluded(method: PaymentMethodish): boolean {
  if (!method) return false;
  return (EXCLUDED_METHODS as readonly string[]).includes(method.toUpperCase());
}

/// A method we have no record of. Not excluded — excluding on a guess would
/// under-report, which is the direction that gets a club penalised — but
/// surfaced on the report so the gap is visible rather than assumed away.
export function methodIsUnknown(method: PaymentMethodish): boolean {
  return !method;
}

export type PaymentSource = "CONTRACTOR_PAYMENT" | "PAYOUT";

export type Form1099Payment = {
  id: string;
  source: PaymentSource;
  contractorId: string;
  contractorName: string;
  /// Date-only `YYYY-MM-DD`. A 1099 is on the CASH basis: the year the money
  /// was paid, never the year the work was done.
  date: string;
  amountCents: number;
  method: PaymentMethodish;
  description: string | null;
};

export type ExcludedPayment = Form1099Payment & { reason: string };

export type SuspectedDuplicate = {
  a: Form1099Payment;
  b: Form1099Payment;
  reason: string;
};

export type Form1099Row = {
  contractorId: string;
  contractorName: string;
  email: string | null;
  totalCents: number;
  paymentCount: number;
  /// Reportable payments with no method on record. Counted so a club can see
  /// how much of a payee's total rests on an assumption.
  unknownMethodCents: number;
  unknownMethodCount: number;
  overThreshold: boolean;
  payments: Form1099Payment[];
  /// True when the contractor has no W-9 on file. A 1099 needs the payee's TIN
  /// and address, which come off the W-9 — and AthletixOS stores neither, so
  /// the W-9 is where they have to come from.
  missingW9: boolean;
};

export type Form1099Report = {
  year: number;
  thresholdCents: number;
  thresholdNote: string;
  thresholdIsOverridden: boolean;
  rows: Form1099Row[];
  /// Payees over the threshold — the ones that need a form.
  reportableCount: number;
  reportableTotalCents: number;
  excluded: ExcludedPayment[];
  excludedTotalCents: number;
  suspectedDuplicates: SuspectedDuplicate[];
  /// Set when nothing records how a payment was made, so "exclude card
  /// payments" could not be applied to it.
  unknownMethodTotalCents: number;
};

const MATCH_DAYS = 3;

function daysBetween(a: string, b: string): number {
  const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
  return Math.round(ms / 86_400_000);
}

/// Contractor money lives in two unreconciled tables — ContractorPayment and
/// Payout — with no link between them, so the same payment can be recorded
/// twice. This finds the likely pairs: same contractor, same amount, dates
/// within three days, and from DIFFERENT tables.
///
/// They are reported, never silently merged. Merging on a guess would
/// under-report a payee who genuinely received two equal payments in the same
/// week, which happens (two weekends of refereeing at the same rate).
export function findSuspectedDuplicates(payments: Form1099Payment[]): SuspectedDuplicate[] {
  const out: SuspectedDuplicate[] = [];
  const used = new Set<string>();
  const fromPayouts = payments.filter((p) => p.source === "PAYOUT");
  const fromContractor = payments.filter((p) => p.source === "CONTRACTOR_PAYMENT");
  for (const a of fromContractor) {
    for (const b of fromPayouts) {
      if (used.has(b.id)) continue;
      if (a.contractorId !== b.contractorId) continue;
      if (a.amountCents !== b.amountCents) continue;
      if (daysBetween(a.date, b.date) > MATCH_DAYS) continue;
      used.add(b.id);
      out.push({
        a,
        b,
        reason: `Same contractor, same amount, ${daysBetween(a.date, b.date)} ${daysBetween(a.date, b.date) === 1 ? "day" : "days"} apart, recorded in two different places. If this is one payment it is being counted twice.`,
      });
      break;
    }
  }
  return out;
}

export type ContractorFacts = {
  id: string;
  name: string;
  email: string | null;
  hasW9: boolean;
};

/// Build the year's report.
///
/// `payments` must already be filtered to the calendar year — a 1099 is on the
/// cash basis, so the year is the year the money moved, and the caller owns
/// that window.
export function buildForm1099Report(
  year: number,
  payments: Form1099Payment[],
  contractors: ContractorFacts[],
  overrides: ThresholdOverrides,
): Form1099Report {
  const thresholdCents = thresholdCentsFor(year, overrides);
  const byId = new Map(contractors.map((c) => [c.id, c]));

  const excluded: ExcludedPayment[] = [];
  const reportable: Form1099Payment[] = [];
  for (const p of payments) {
    if (methodIsExcluded(p.method)) {
      excluded.push({
        ...p,
        reason: `Paid by ${p.method}. Card and payment-processor payments are reported by the processor on a 1099-K, so including them here would report the same money twice.`,
      });
      continue;
    }
    reportable.push(p);
  }

  const grouped = new Map<string, Form1099Payment[]>();
  for (const p of reportable) {
    const arr = grouped.get(p.contractorId);
    if (arr) arr.push(p);
    else grouped.set(p.contractorId, [p]);
  }

  const rows: Form1099Row[] = [];
  for (const [contractorId, ps] of grouped) {
    const c = byId.get(contractorId);
    const totalCents = ps.reduce((s, p) => s + p.amountCents, 0);
    const unknown = ps.filter((p) => methodIsUnknown(p.method));
    rows.push({
      contractorId,
      contractorName: c?.name ?? ps[0].contractorName,
      email: c?.email ?? null,
      totalCents,
      paymentCount: ps.length,
      unknownMethodCents: unknown.reduce((s, p) => s + p.amountCents, 0),
      unknownMethodCount: unknown.length,
      overThreshold: totalCents >= thresholdCents,
      payments: [...ps].sort((x, y) => (x.date === y.date ? x.id.localeCompare(y.id) : x.date < y.date ? -1 : 1)),
      missingW9: !c?.hasW9,
    });
  }

  // Over the threshold first, then by amount: the forms that have to be filed
  // are the ones the reader came for.
  rows.sort((a, b) => {
    if (a.overThreshold !== b.overThreshold) return a.overThreshold ? -1 : 1;
    if (a.totalCents !== b.totalCents) return b.totalCents - a.totalCents;
    return a.contractorName.localeCompare(b.contractorName);
  });

  const over = rows.filter((r) => r.overThreshold);
  return {
    year,
    thresholdCents,
    thresholdNote: thresholdNote(year, overrides),
    thresholdIsOverridden: thresholdIsOverridden(year, overrides),
    rows,
    reportableCount: over.length,
    reportableTotalCents: over.reduce((s, r) => s + r.totalCents, 0),
    excluded,
    excludedTotalCents: excluded.reduce((s, p) => s + p.amountCents, 0),
    suspectedDuplicates: findSuspectedDuplicates(reportable),
    unknownMethodTotalCents: rows.reduce((s, r) => s + r.unknownMethodCents, 0),
  };
}

// ── CSV ─────────────────────────────────────────────────────────────────────

/// One row per payee over the threshold.
///
/// There is no TIN column, and that is deliberate — see the module header.
/// There is no address column either: a 1099-NEC needs the payee's address and
/// AthletixOS does not store one, so it comes off the W-9 like the TIN.
///
/// The columns that ARE here are the ones only AthletixOS knows: who, how
/// much, over how many payments, and how much of that rests on a payment whose
/// method was never recorded.
export const FORM_1099_CSV_HEADERS = [
  "Payee",
  "Email",
  "Total paid",
  "Payments",
  "Payments with no method recorded",
  "Amount with no method recorded",
  "W-9 on file",
  "Over threshold",
];

export function form1099CsvRows(report: Form1099Report, opts?: { includeBelow?: boolean }): (string | number)[][] {
  const rows = opts?.includeBelow ? report.rows : report.rows.filter((r) => r.overThreshold);
  return rows.map((r) => [
    r.contractorName,
    r.email ?? "",
    r.totalCents / 100,
    r.paymentCount,
    r.unknownMethodCount,
    r.unknownMethodCents / 100,
    r.missingW9 ? "No" : "Yes",
    r.overThreshold ? "Yes" : "No",
  ]);
}
