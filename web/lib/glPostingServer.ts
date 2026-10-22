// Accounting Phase 2 — the posting service. Reads what AthletixOS already
// records, decides nothing itself, and writes only through the Phase 1 ledger.
//
// lib/glPosting.ts holds the rules (pure, tested without a database); this
// module is the I/O around them.
//
// ── WHY THIS IS A SWEEP AND NOT WEBHOOK HOOKS ──────────────────────────────
// The obvious design is to post from the ~20 places that create a Transaction
// (webhook branches, auto-charge, offline payment, at-the-door…). That was
// rejected:
//
//   · those paths are the money-critical ones. A posting bug inside the Stripe
//     webhook risks the payment record itself, and CLAUDE.md's double-charge
//     rules exist because that code is delicate;
//   · the backfill (task 5) needs to post historical rows anyway, so a sweep
//     has to exist regardless. Two posting paths would be two sets of rules;
//   · a sweep is idempotent by construction: it asks the ledger what is
//     already posted and posts the rest. A missed webhook self-heals on the
//     next run instead of leaving a permanent hole.
//
// So nothing in the payment paths changes. The sweep runs when Financials
// loads, and the backfill script runs the same function.
//
// ── POST ONCE, KEYED ON IMMUTABLE IDS ──────────────────────────────────────
// `gl_journal_entries` has a unique index on (clubId, sourceType, sourceId)
// from Phase 1. This module reads the already-posted keys for the batch in one
// query and filters, AND catches the unique violation (P2002) as "already
// posted" — belt and braces, because two concurrent sweeps are entirely
// possible when two staff open Financials at once.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { feePolicyFor } from "@/lib/fees";
import { createEntry, LedgerError, type Actor } from "@/lib/ledgerServer";
import { bankGlAccountMaps, ensureBankGlAccounts } from "@/lib/glBankAccounts";
import {
  booksGate,
  chargeSourceId,
  planBankRow,
  planCharge,
  planDeposit,
  planExpense,
  planPayout,
  planRefund,
  planBalances,
  resolveAccount,
  type AccountMap,
  type PostingOutcome,
  type PostingPlan,
  type PostingSourceType,
  type SkipReason,
} from "@/lib/glPosting";

const toDateStr = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);
const dateOnly = (s: string) => new Date(`${s}T00:00:00.000Z`);
const cents = (d: Prisma.Decimal | number | null | undefined): number =>
  d === null || d === undefined ? 0 : Math.round(Number(d) * 100);

export type PostingReport = {
  posted: number;
  skipped: Record<string, number>;
  /// A few examples per skip reason, so the UI and the backfill script can show
  /// WHICH rows were held back rather than just a count.
  examples: { sourceType: string; sourceId: string; reason: SkipReason; detail?: string }[];
  errors: { sourceType: string; sourceId: string; error: string }[];
  booksStartDate: string | null;
  /// `YYYY-MM` → how many records posted (or, on a dry run, WOULD post) with
  /// an entry date in that month. The month-close checklist needs "is anything
  /// dated in or before January still waiting?", and a bare total would let a
  /// permanently-stuck record dated in March block January's close forever.
  postedByMonth: Record<string, number>;
};

function emptyReport(booksStartDate: string | null): PostingReport {
  return { posted: 0, skipped: {}, examples: [], errors: [], booksStartDate, postedByMonth: {} };
}
function note(r: PostingReport, sourceType: string, sourceId: string, o: Extract<PostingOutcome, { posted: false }>) {
  r.skipped[o.reason] = (r.skipped[o.reason] ?? 0) + 1;
  if (r.examples.filter((e) => e.reason === o.reason).length < 5) {
    r.examples.push({ sourceType, sourceId, reason: o.reason, detail: o.detail });
  }
}

/// The club's chart, indexed both ways. System accounts are resolved by
/// `systemKey` in preference to number, because a club may renumber them.
export async function loadAccountMap(clubId: string): Promise<AccountMap> {
  const rows = await prisma.glAccount.findMany({
    where: { clubId, active: true },
    select: { id: true, number: true, systemKey: true },
  });
  const byNumber: Record<string, string> = {};
  const bySystemKey: Record<string, string> = {};
  for (const r of rows) {
    byNumber[r.number] = r.id;
    if (r.systemKey) bySystemKey[r.systemKey] = r.id;
  }
  return { byNumber, bySystemKey };
}

/// Which (sourceType, sourceId) pairs are already on the ledger. One query per
/// batch rather than one per row.
async function alreadyPosted(clubId: string, sourceType: PostingSourceType, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await prisma.glJournalEntry.findMany({
    where: { clubId, sourceType, sourceId: { in: ids } },
    select: { sourceId: true },
  });
  return new Set(rows.map((r) => r.sourceId).filter((v): v is string => !!v));
}

/// Hand one plan to the Phase 1 ledger service.
///
/// The P2002 catch is the concurrency guard: two sweeps running at once both
/// pass the `alreadyPosted` filter, and the unique index is what actually
/// decides. Losing that race is a success, not an error.
async function post(
  clubId: string,
  plan: PostingPlan,
  actor: Actor,
  report: PostingReport,
  dryRun = false,
): Promise<void> {
  if (!planBalances(plan)) {
    report.errors.push({
      sourceType: plan.sourceType,
      sourceId: plan.sourceId,
      error: "the planned entry did not balance — nothing was posted",
    });
    return;
  }
  const month = plan.entryDate.slice(0, 7);
  // A dry run still validates the plan above, so "nothing waiting to post"
  // and "something waiting that would fail" stay distinguishable.
  if (dryRun) {
    report.posted++;
    report.postedByMonth[month] = (report.postedByMonth[month] ?? 0) + 1;
    return;
  }
  try {
    await createEntry(
      clubId,
      {
        entryDate: plan.entryDate,
        memo: plan.memo,
        reference: plan.reference,
        legalEntityId: plan.legalEntityId,
        sourceType: plan.sourceType,
        sourceId: plan.sourceId,
        lines: plan.lines,
      },
      actor,
    );
    report.posted++;
    report.postedByMonth[month] = (report.postedByMonth[month] ?? 0) + 1;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      report.skipped.ALREADY_POSTED = (report.skipped.ALREADY_POSTED ?? 0) + 1;
      return;
    }
    // A lock date or a validation refusal is information, not a crash: one bad
    // row must not stop the rest of the sweep.
    report.errors.push({
      sourceType: plan.sourceType,
      sourceId: plan.sourceId,
      error: err instanceof LedgerError ? err.message : "could not post",
    });
  }
}

const TX_SELECT = {
  id: true,
  stripeChargeId: true,
  stripePaymentIntentId: true,
  stripeInvoiceId: true,
  txDate: true,
  createdAt: true,
  amount: true,
  stripeFeeAmount: true,
  netAmount: true,
  refundedAmount: true,
  category: true,
  type: true,
  legalEntityId: true,
  description: true,
  reconciliationStatus: true,
  paymentSource: true,
  paymentMethod: true,
  status: true,
  member: { select: { firstName: true, lastName: true } },
} as const;

type TxRow = Prisma.TransactionGetPayload<{ select: typeof TX_SELECT }>;

function chargeFacts(t: TxRow) {
  const date = toDateStr(t.txDate ?? t.createdAt)!;
  const name = t.member ? `${t.member.firstName} ${t.member.lastName}`.trim() : null;
  return {
    id: t.id,
    stripeChargeId: t.stripeChargeId,
    stripePaymentIntentId: t.stripePaymentIntentId,
    stripeInvoiceId: t.stripeInvoiceId,
    date,
    amountCents: cents(t.amount),
    feeCents: t.stripeFeeAmount === null ? null : cents(t.stripeFeeAmount),
    netCents: t.netAmount === null ? null : cents(t.netAmount),
    category: t.category,
    type: t.type,
    legalEntityId: t.legalEntityId,
    memberName: name,
    description: t.description,
    reconciliationStatus: t.reconciliationStatus,
    paymentSource: t.paymentSource,
    paymentMethod: t.paymentMethod,
    status: t.status as string,
  };
}

// ── The sweep ──────────────────────────────────────────────────────────────

export type SweepOptions = {
  /// Cap per source type, so a first run on a large club can't run long. The
  /// sweep is resumable by construction — the next run picks up the rest.
  limit?: number;
  /// Skip the Stripe payout sync (a network round-trip). The lazy on-load
  /// sweep passes true; the backfill script does not.
  skipPayoutSync?: boolean;
  /// Count what WOULD post and write nothing. Phase 3's month-close checklist
  /// asks "is anything still waiting to post?", and it must be able to ask
  /// without posting — a checklist that changes the books by being looked at
  /// is not a checklist.
  ///
  /// This reuses the real sweep rather than reimplementing "what posts", so
  /// the two can never disagree. It implies skipPayoutSync: syncing payouts
  /// writes PayoutMatch rows, which is not a dry run.
  dryRun?: boolean;
};

/// Post everything postable for one club. Idempotent, resumable, and a no-op
/// for a club with no books start date.
export async function postPendingForClub(clubId: string, actor: Actor, opts: SweepOptions = {}): Promise<PostingReport> {
  const limit = Math.min(Math.max(opts.limit ?? 300, 1), 2000);
  // A dry run writes nothing, so it must not sync payouts either — that
  // creates PayoutMatch rows.
  const dryRun = opts.dryRun === true;

  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: {
      booksStartDate: true,
      passProcessingFees: true,
      passPlatformFee: true,
      tier: true,
      defaultLegalEntityId: true,
      stripeAccountId: true,
    },
  });
  const booksStartDate = toDateStr(club?.booksStartDate ?? null);
  const report = emptyReport(booksStartDate);

  // NULL books start date = automatic posting is not configured. It does NOT
  // mean "post everything" — that would double-count imported history, which
  // is the whole reason this setting exists.
  if (!club || !booksStartDate) {
    report.skipped.NO_BOOKS_START_DATE = 1;
    return report;
  }

  const accounts = await loadAccountMap(clubId);
  if (Object.keys(accounts.byNumber).length === 0) {
    report.errors.push({ sourceType: "-", sourceId: "-", error: "This club has no chart of accounts yet." });
    return report;
  }

  // Make sure every bank and card has a GL account before anything that posts
  // to one runs.
  await ensureBankGlAccounts(clubId, actor);
  const banks = await bankGlAccountMaps(clubId);
  const policy = feePolicyFor({
    passProcessingFees: club.passProcessingFees,
    passPlatformFee: club.passPlatformFee,
    tier: club.tier,
  });
  const from = dateOnly(booksStartDate);

  // ── 1. Stripe charges, cash and cheques ─────────────────────────────────
  {
    const rows = await prisma.transaction.findMany({
      where: {
        clubId,
        status: { in: ["SUCCEEDED", "REFUNDED"] },
        NOT: { reconciliationStatus: "VOID" },
        OR: [{ txDate: { gte: from } }, { txDate: null, createdAt: { gte: from } }],
      },
      select: TX_SELECT,
      orderBy: { createdAt: "asc" },
      take: limit,
    });
    const facts = rows.map(chargeFacts);
    const keys = facts.map((f) => chargeSourceId(f) ?? `tx:${f.id}`);
    const done = await alreadyPosted(clubId, "STRIPE_CHARGE", keys);

    for (const f of facts) {
      const key = chargeSourceId(f) ?? `tx:${f.id}`;
      if (done.has(key)) {
        report.skipped.ALREADY_POSTED = (report.skipped.ALREADY_POSTED ?? 0) + 1;
        continue;
      }
      const gate = booksGate(f.date, booksStartDate);
      if (gate) {
        note(report, "STRIPE_CHARGE", key, { posted: false, reason: gate });
        continue;
      }
      const outcome = planCharge(f, policy, accounts);
      if (!outcome.posted) {
        note(report, "STRIPE_CHARGE", key, outcome);
        continue;
      }
      await post(clubId, outcome.plan, actor, report, dryRun);
    }
  }

  // ── 2. Refunds, posted incrementally ────────────────────────────────────
  {
    const rows = await prisma.transaction.findMany({
      where: {
        clubId,
        refundedAmount: { gt: 0 },
        NOT: { reconciliationStatus: "VOID" },
        OR: [{ txDate: { gte: from } }, { txDate: null, createdAt: { gte: from } }],
      },
      select: TX_SELECT,
      orderBy: { createdAt: "asc" },
      take: limit,
    });

    for (const t of rows) {
      const f = chargeFacts(t);
      const base = chargeSourceId(f) ?? `tx:${f.id}`;
      const refundedTotal = cents(t.refundedAmount);

      // How much of this transaction's refund is already on the ledger. The
      // key carries the cumulative total, so prior entries tell us the high
      // water mark and we post only the delta above it.
      const prior = await prisma.glJournalEntry.findMany({
        where: { clubId, sourceType: "REFUND", sourceId: { startsWith: `${base}:` }, status: "POSTED" },
        select: { sourceId: true },
      });
      const postedSoFar = prior.reduce((max, p) => {
        const n = Number((p.sourceId ?? "").slice(base.length + 1));
        return Number.isFinite(n) && n > max ? n : max;
      }, 0);

      const gate = booksGate(f.date, booksStartDate);
      if (gate) {
        note(report, "REFUND", base, { posted: false, reason: gate });
        continue;
      }
      const outcome = planRefund(f, postedSoFar, refundedTotal, accounts);
      if (!outcome.posted) {
        note(report, "REFUND", base, outcome);
        continue;
      }
      await post(clubId, outcome.plan, actor, report, dryRun);
    }
  }

  // ── 3. Stripe payouts ───────────────────────────────────────────────────
  if (!opts.skipPayoutSync && !dryRun && club.stripeAccountId) {
    await syncStripePayouts(clubId, club.stripeAccountId, booksStartDate).catch(() => {});
  }
  {
    const payouts = await prisma.payoutMatch.findMany({
      where: { clubId, arrivalDate: { gte: from } },
      select: { stripePayoutId: true, amount: true, arrivalDate: true },
      orderBy: { arrivalDate: "asc" },
      take: limit,
    });
    const done = await alreadyPosted(clubId, "PAYOUT", payouts.map((p) => p.stripePayoutId));
    for (const p of payouts) {
      if (done.has(p.stripePayoutId)) {
        report.skipped.ALREADY_POSTED = (report.skipped.ALREADY_POSTED ?? 0) + 1;
        continue;
      }
      const date = toDateStr(p.arrivalDate);
      if (!date) continue;
      const gate = booksGate(date, booksStartDate);
      if (gate) {
        note(report, "PAYOUT", p.stripePayoutId, { posted: false, reason: gate });
        continue;
      }
      const outcome = planPayout(
        { stripePayoutId: p.stripePayoutId, date, amountCents: cents(p.amount), legalEntityId: club.defaultLegalEntityId },
        banks.defaultBankAccountId,
        accounts,
      );
      if (!outcome.posted) {
        note(report, "PAYOUT", p.stripePayoutId, outcome);
        continue;
      }
      await post(clubId, outcome.plan, actor, report, dryRun);
    }
  }

  // ── 4. Categorized expenses ─────────────────────────────────────────────
  {
    const rows = await prisma.expense.findMany({
      where: { clubId, date: { gte: from } },
      select: {
        id: true,
        date: true,
        amount: true,
        category: true,
        vendor: true,
        description: true,
        program: true,
        legalEntityId: true,
        plaidConnectionId: true,
        receiptUrl: true,
      },
      orderBy: { date: "asc" },
      take: limit,
    });
    const done = await alreadyPosted(clubId, "EXPENSE", rows.map((r) => r.id));

    for (const e of rows) {
      if (done.has(e.id)) {
        report.skipped.ALREADY_POSTED = (report.skipped.ALREADY_POSTED ?? 0) + 1;
        continue;
      }
      const date = toDateStr(e.date)!;
      const gate = booksGate(date, booksStartDate);
      if (gate) {
        note(report, "EXPENSE", e.id, { posted: false, reason: gate });
        continue;
      }
      const paidFrom = e.plaidConnectionId ? banks.byConnection[e.plaidConnectionId] ?? null : null;
      const outcome = planExpense(
        {
          id: e.id,
          date,
          amountCents: cents(e.amount),
          category: e.category,
          vendor: e.vendor,
          description: e.description,
          program: e.program,
          legalEntityId: e.legalEntityId,
          paidFromAccountId: paidFrom,
        },
        accounts,
      );
      if (!outcome.posted) {
        note(report, "EXPENSE", e.id, outcome);
        continue;
      }
      await post(clubId, outcome.plan, actor, report, dryRun);
    }
  }

  // ── 5. Categorized bank rows ────────────────────────────────────────────
  {
    // The double-count guard's inputs. PayoutMatch.bankTransactionId and
    // GlDeposit.bankTransactionId both hold PLAID'S OWN
    // `plaidTransactionId` — not our row id. That is the contract
    // lib/reportsCashFlow.ts:156 already relies on; changing it would silently
    // break cash-flow reporting.
    const [matchedPayouts, matchedDeposits] = await Promise.all([
      prisma.payoutMatch.findMany({ where: { clubId, bankTransactionId: { not: null } }, select: { bankTransactionId: true } }),
      prisma.glDeposit.findMany({ where: { clubId, bankTransactionId: { not: null } }, select: { bankTransactionId: true } }),
    ]);
    const payoutIds = new Set(matchedPayouts.map((m) => m.bankTransactionId!));
    const depositIds = new Set(matchedDeposits.map((m) => m.bankTransactionId!));

    const rows = await prisma.plaidTransaction.findMany({
      where: { clubId, date: { gte: from }, pending: false },
      select: {
        plaidTransactionId: true,
        accountId: true,
        date: true,
        amount: true,
        name: true,
        categoryOverride: true,
        legalEntityId: true,
        markedAsTransfer: true,
        excludedFromTax: true,
        reviewedAt: true,
        categorizedExpenseId: true,
      },
      orderBy: { date: "asc" },
      take: limit,
    });
    const done = await alreadyPosted(clubId, "BANK_ROW", rows.map((r) => r.plaidTransactionId));

    for (const r of rows) {
      if (done.has(r.plaidTransactionId)) {
        report.skipped.ALREADY_POSTED = (report.skipped.ALREADY_POSTED ?? 0) + 1;
        continue;
      }
      const date = toDateStr(r.date)!;
      const gate = booksGate(date, booksStartDate);
      if (gate) {
        note(report, "BANK_ROW", r.plaidTransactionId, { posted: false, reason: gate });
        continue;
      }
      const outcome = planBankRow(
        {
          plaidTransactionId: r.plaidTransactionId,
          date,
          amountCents: cents(r.amount),
          name: r.name,
          categoryOverride: r.categoryOverride,
          legalEntityId: r.legalEntityId,
          markedAsTransfer: r.markedAsTransfer,
          excludedFromTax: r.excludedFromTax,
          reviewedAt: !!r.reviewedAt,
          matchedExpenseId: r.categorizedExpenseId,
          matchedPayout: payoutIds.has(r.plaidTransactionId),
          matchedDeposit: depositIds.has(r.plaidTransactionId),
          bankAccountId: banks.byPlaidAccountId[r.accountId] ?? null,
        },
        accounts,
      );
      if (!outcome.posted) {
        note(report, "BANK_ROW", r.plaidTransactionId, outcome);
        continue;
      }
      await post(clubId, outcome.plan, actor, report, dryRun);
    }
  }

  // ── 6. Receipts follow their expense onto the entry ─────────────────────
  await attachReceiptsToEntries(clubId, actor).catch(() => {});

  return report;
}

// ── Stripe payouts ─────────────────────────────────────────────────────────

/// Fill `payout_matches` from the connected account.
///
/// That table has existed since 2026-07-31 with a consumer
/// (lib/reportsCashFlow.ts) and NO producer — so the payout half of the
/// double-count guard has been inert in production. This is the producer.
///
/// Read-only against Stripe; never moves money. Upserts on
/// (clubId, stripePayoutId), so re-running is free.
export async function syncStripePayouts(
  clubId: string,
  stripeAccountId: string,
  sinceDate: string,
): Promise<{ synced: number }> {
  const since = Math.floor(new Date(`${sinceDate}T00:00:00.000Z`).getTime() / 1000);
  let synced = 0;
  let startingAfter: string | undefined;

  for (let page = 0; page < 10; page++) {
    const res = await stripe.payouts.list(
      { limit: 100, arrival_date: { gte: since }, ...(startingAfter ? { starting_after: startingAfter } : {}) },
      { stripeAccount: stripeAccountId },
    );
    for (const p of res.data) {
      // A failed or canceled payout never reached the bank, so it is not money
      // moving and must not post.
      if (p.status !== "paid" && p.status !== "in_transit") continue;
      const arrival = new Date(p.arrival_date * 1000).toISOString().slice(0, 10);
      await prisma.payoutMatch.upsert({
        where: { clubId_stripePayoutId: { clubId, stripePayoutId: p.id } },
        create: {
          clubId,
          stripePayoutId: p.id,
          amount: new Prisma.Decimal((p.amount / 100).toFixed(2)),
          arrivalDate: dateOnly(arrival),
        },
        // Amount and arrival can both change while a payout is in transit.
        // bankTransactionId is deliberately NOT touched — that match is the
        // owner's, or the matcher's, and resyncing must not discard it.
        update: { amount: new Prisma.Decimal((p.amount / 100).toFixed(2)), arrivalDate: dateOnly(arrival) },
      });
      synced++;
    }
    if (!res.has_more || res.data.length === 0) break;
    startingAfter = res.data[res.data.length - 1].id;
  }
  return { synced };
}

// ── Receipts on entries (task 6) ───────────────────────────────────────────

/// Point every matched receipt at the journal entry its expense posted to, and
/// create the matching gl_entry_attachments row so the entry shows the
/// document. The bytes never move — this is pointers only.
export async function attachReceiptsToEntries(clubId: string, actor: Actor): Promise<{ attached: number }> {
  const receipts = await prisma.receipt.findMany({
    where: { clubId, glEntryId: null, status: "MATCHED", plaidTransactionId: { not: null } },
    select: { id: true, fileId: true, fileName: true, mimeType: true, plaidTransactionId: true },
    take: 200,
  });
  if (receipts.length === 0) return { attached: 0 };

  // A receipt is matched to a BANK ROW; the entry for that row may have posted
  // either as a BANK_ROW or through its matched expense.
  const plaidIds = receipts.map((r) => r.plaidTransactionId!).filter(Boolean);
  const bankRows = await prisma.plaidTransaction.findMany({
    where: { clubId, plaidTransactionId: { in: plaidIds } },
    select: { plaidTransactionId: true, categorizedExpenseId: true },
  });
  const expenseByPlaid = new Map(bankRows.map((b) => [b.plaidTransactionId, b.categorizedExpenseId]));

  const entries = await prisma.glJournalEntry.findMany({
    where: {
      clubId,
      status: "POSTED",
      OR: [
        { sourceType: "BANK_ROW", sourceId: { in: plaidIds } },
        { sourceType: "EXPENSE", sourceId: { in: [...expenseByPlaid.values()].filter((v): v is string => !!v) } },
      ],
    },
    select: { id: true, sourceType: true, sourceId: true },
  });
  const entryByKey = new Map(entries.map((e) => [`${e.sourceType}:${e.sourceId}`, e.id]));

  let attached = 0;
  for (const r of receipts) {
    const expenseId = expenseByPlaid.get(r.plaidTransactionId!) ?? null;
    const entryId =
      entryByKey.get(`BANK_ROW:${r.plaidTransactionId}`) ?? (expenseId ? entryByKey.get(`EXPENSE:${expenseId}`) : undefined);
    if (!entryId) continue;

    await prisma.$transaction(async (tx) => {
      await tx.receipt.updateMany({ where: { id: r.id, clubId }, data: { glEntryId: entryId } });
      const exists = await tx.glEntryAttachment.findFirst({
        where: { clubId, entryId, fileId: r.fileId },
        select: { id: true },
      });
      if (!exists) {
        const file = await tx.uploadedFile.findFirst({ where: { id: r.fileId, clubId }, select: { sizeBytes: true } });
        await tx.glEntryAttachment.create({
          data: {
            clubId,
            entryId,
            fileId: r.fileId,
            fileName: r.fileName,
            mimeType: r.mimeType,
            sizeBytes: file?.sizeBytes ?? 0,
            uploadedByUserId: actor.userId,
          },
        });
      }
    });
    attached++;
  }
  return { attached };
}

// ── Record a deposit (the other half of 1020) ──────────────────────────────

/// Move a batch of cash and cheques from 1020 Undeposited Funds into a bank
/// account — what actually happens when somebody walks the drawer to the bank.
///
/// Guards:
///   · every transaction must be this club's, SUCCEEDED, cash or cheque, and
///     NOT already in a deposit (`glDepositId` is the never-twice marker);
///   · the amount is SUMMED from those rows, never taken from the client;
///   · the whole thing is one transaction, so a failure banks nothing.
export async function recordDeposit(
  clubId: string,
  input: { bankAccountGlId: string; depositDate: string; transactionIds: string[]; memo?: string | null },
  actor: Actor,
): Promise<{ depositId: string; amountCents: number; entryId: string | null }> {
  if (input.transactionIds.length === 0) {
    throw new LedgerError("Choose at least one cash or cheque payment to deposit.");
  }

  const account = await prisma.glAccount.findFirst({
    where: { id: input.bankAccountGlId, clubId, active: true },
    select: { id: true },
  });
  if (!account) throw new LedgerError("That account doesn't exist in this club.", 404);

  const rows = await prisma.transaction.findMany({
    where: {
      id: { in: input.transactionIds },
      clubId,
      status: "SUCCEEDED",
      paymentSource: { in: ["CASH", "CHECK"] },
      glDepositId: null,
      NOT: { reconciliationStatus: "VOID" },
    },
    select: { id: true, amount: true, legalEntityId: true },
  });
  if (rows.length === 0) {
    throw new LedgerError("None of those payments can be deposited — they may already be in a deposit.", 409);
  }

  const amountCents = rows.reduce((sum, r) => sum + cents(r.amount), 0);
  if (amountCents <= 0) throw new LedgerError("That deposit adds up to $0.00.");

  const accounts = await loadAccountMap(clubId);
  const legalEntityId = rows.find((r) => r.legalEntityId)?.legalEntityId ?? null;

  const depositId = await prisma.$transaction(async (tx) => {
    const deposit = await tx.glDeposit.create({
      data: {
        clubId,
        accountId: input.bankAccountGlId,
        depositDate: dateOnly(input.depositDate),
        amountCents,
        memo: input.memo?.trim() || null,
        createdByUserId: actor.userId,
      },
      select: { id: true },
    });
    // Claim the rows conditionally — a double-click at the front desk must not
    // bank the same cash twice.
    const claimed = await tx.transaction.updateMany({
      where: { id: { in: rows.map((r) => r.id) }, clubId, glDepositId: null },
      data: { glDepositId: deposit.id },
    });
    if (claimed.count !== rows.length) {
      throw new LedgerError("Some of those payments were deposited by someone else just now. Nothing was saved.", 409);
    }
    return deposit.id;
  });

  const outcome = planDeposit(depositId, input.depositDate, amountCents, input.bankAccountGlId, legalEntityId, accounts);
  if (!outcome.posted) {
    throw new LedgerError(`The deposit was recorded but could not be posted: ${outcome.reason}`, 500);
  }
  const report = emptyReport(null);
  await post(clubId, outcome.plan, actor, report);
  const entry = await prisma.glJournalEntry.findFirst({
    where: { clubId, sourceType: "CASH_DEPOSIT", sourceId: depositId },
    select: { id: true },
  });
  if (entry) {
    await prisma.glDeposit.updateMany({ where: { id: depositId, clubId }, data: { entryId: entry.id } });
  }

  return { depositId, amountCents, entryId: entry?.id ?? null };
}

/// Cash and cheques that are recorded but not yet banked — what the "Record
/// deposit" screen offers to deposit.
export async function undepositedPayments(clubId: string): Promise<
  { id: string; date: string; amountCents: number; who: string; method: string }[]
> {
  const rows = await prisma.transaction.findMany({
    where: {
      clubId,
      status: "SUCCEEDED",
      paymentSource: { in: ["CASH", "CHECK"] },
      glDepositId: null,
      NOT: { reconciliationStatus: "VOID" },
    },
    select: {
      id: true,
      txDate: true,
      createdAt: true,
      amount: true,
      paymentSource: true,
      description: true,
      member: { select: { firstName: true, lastName: true } },
    },
    orderBy: { createdAt: "asc" },
    take: 500,
  });
  return rows.map((r) => ({
    id: r.id,
    date: toDateStr(r.txDate ?? r.createdAt)!,
    amountCents: cents(r.amount),
    who: r.member ? `${r.member.firstName} ${r.member.lastName}`.trim() : r.description ?? "Payment",
    method: r.paymentSource === "CHECK" ? "Cheque" : "Cash",
  }));
}

export { resolveAccount };
