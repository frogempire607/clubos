// Accounting Phase 3 — the 1099 report, read from the database.
//
// Reads only. Nothing here writes, and nothing here files anything with
// anybody. The rules are in lib/form1099.ts (pure, proven by
// scripts/form1099-tests.ts).
//
// NO TAX IDENTIFICATION NUMBER IS READ, WRITTEN OR LOGGED, because none is
// stored — see the header of lib/form1099.ts and the write-up in
// docs/accounting/plan.md.
//
// Every query is scoped by clubId.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  type ContractorFacts,
  type Form1099Payment,
  type Form1099Report,
  buildForm1099Report,
} from "@/lib/form1099";

const ymd = (d: Date): string => d.toISOString().slice(0, 10);

/// Contractor money lives in two places and this reads both:
///
///   · ContractorPayment — the per-contractor payment log (owner-only to
///     write, no GL link).
///   · Payout — the payouts page, where payeeType is CONTRACTOR or GUEST and
///     `contractorId` points at the same contractor. Only PAID payouts count:
///     a PENDING payout is money not yet handed over, and a 1099 is on the
///     cash basis.
///
/// They have no link between them, so the same payment can appear in both.
/// buildForm1099Report finds the likely pairs and REPORTS them rather than
/// merging — merging on a guess would under-report a referee who genuinely
/// worked two weekends at the same rate.
export async function loadForm1099Payments(clubId: string, year: number): Promise<{
  payments: Form1099Payment[];
  contractors: ContractorFacts[];
}> {
  const from = new Date(`${year}-01-01T00:00:00.000Z`);
  const to = new Date(`${year}-12-31T23:59:59.999Z`);

  const [contractorRows, paymentRows, payoutRows] = await Promise.all([
    prisma.contractor.findMany({
      where: { clubId, deletedAt: null },
      select: { id: true, name: true, email: true, w9Url: true },
      orderBy: { name: "asc" },
    }),
    prisma.contractorPayment.findMany({
      where: { clubId, date: { gte: from, lte: to } },
      select: {
        id: true,
        contractorId: true,
        amount: true,
        date: true,
        service: true,
        notes: true,
        paymentMethod: true,
        contractor: { select: { name: true } },
      },
      orderBy: { date: "asc" },
    }),
    prisma.payout.findMany({
      where: {
        clubId,
        status: "PAID",
        payeeType: { in: ["CONTRACTOR", "GUEST"] },
        contractorId: { not: null },
        // paidAt is when the money actually moved, which is the date a 1099
        // cares about. A payout created in December and paid in January
        // belongs to January's year.
        paidAt: { gte: from, lte: to },
      },
      select: {
        id: true,
        contractorId: true,
        payeeName: true,
        amount: true,
        paidAt: true,
        method: true,
        notes: true,
        kind: true,
      },
      orderBy: { paidAt: "asc" },
    }),
  ]);

  const nameById = new Map(contractorRows.map((c) => [c.id, c.name]));

  const payments: Form1099Payment[] = [
    ...paymentRows.map((r) => ({
      id: `cp:${r.id}`,
      source: "CONTRACTOR_PAYMENT" as const,
      contractorId: r.contractorId,
      contractorName: r.contractor?.name ?? nameById.get(r.contractorId) ?? "Unknown",
      date: ymd(r.date),
      // Decimal(10,2) → integer cents. Math.round, not truncation: a value
      // that arrives as 40.0000001 must become 4000, not 3999.
      amountCents: Math.round(Number(r.amount) * 100),
      method: r.paymentMethod,
      description: r.service ?? r.notes ?? null,
    })),
    ...payoutRows
      .filter((r): r is typeof r & { contractorId: string; paidAt: Date } => !!r.contractorId && !!r.paidAt)
      .map((r) => ({
        id: `po:${r.id}`,
        source: "PAYOUT" as const,
        contractorId: r.contractorId,
        contractorName: nameById.get(r.contractorId) ?? r.payeeName,
        date: ymd(r.paidAt),
        amountCents: Math.round(Number(r.amount) * 100),
        method: r.method,
        description: r.notes ?? r.kind ?? null,
      })),
  ];

  return {
    payments,
    contractors: contractorRows.map((c) => ({
      id: c.id,
      name: c.name,
      email: c.email,
      hasW9: !!c.w9Url,
    })),
  };
}

export async function form1099Report(clubId: string, year: number): Promise<Form1099Report> {
  const [{ payments, contractors }, club] = await Promise.all([
    loadForm1099Payments(clubId, year),
    prisma.club.findUnique({ where: { id: clubId }, select: { form1099Thresholds: true } }),
  ]);
  const overrides = normaliseThresholds(club?.form1099Thresholds);
  return buildForm1099Report(year, payments, contractors, overrides);
}

/// `Club.form1099Thresholds` is a JSON blob, so it has to be validated on the
/// way out, not trusted. A stray string or a negative number would otherwise
/// become a threshold.
export function normaliseThresholds(raw: unknown): Record<string, number> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d{4}$/.test(k)) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 100_000_000) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/// Set (or clear) one year's threshold. Merges into the existing blob so
/// setting 2027 does not wipe 2026.
export async function setThreshold(
  clubId: string,
  year: number,
  cents: number | null,
): Promise<Record<string, number> | null> {
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { form1099Thresholds: true },
  });
  const current = normaliseThresholds(club?.form1099Thresholds) ?? {};
  if (cents === null) delete current[String(year)];
  else current[String(year)] = cents;
  const next = Object.keys(current).length ? current : null;
  await prisma.club.update({
    where: { id: clubId },
    // Prisma distinguishes "JSON null" from "column NULL": clearing the last
    // override has to be Prisma.DbNull, or the column ends up holding the JSON
    // value `null` and `form1099Thresholds` stops reading as unset.
    data: { form1099Thresholds: next === null ? Prisma.DbNull : (next as Prisma.InputJsonValue) },
  });
  return next;
}

/// Which years have any contractor money at all, newest first — so the year
/// picker offers real years instead of an empty one.
export async function form1099Years(clubId: string): Promise<number[]> {
  const [payments, payouts] = await Promise.all([
    prisma.contractorPayment.findMany({
      where: { clubId },
      select: { date: true },
      orderBy: { date: "desc" },
      take: 2000,
    }),
    prisma.payout.findMany({
      where: { clubId, status: "PAID", payeeType: { in: ["CONTRACTOR", "GUEST"] }, paidAt: { not: null } },
      select: { paidAt: true },
      orderBy: { paidAt: "desc" },
      take: 2000,
    }),
  ]);
  const years = new Set<number>();
  for (const p of payments) years.add(p.date.getUTCFullYear());
  for (const p of payouts) if (p.paidAt) years.add(p.paidAt.getUTCFullYear());
  // Always offer last year, which is the one a club files for.
  years.add(new Date().getUTCFullYear() - 1);
  return [...years].sort((a, b) => b - a);
}
