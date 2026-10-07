// Report names and labels. PURE (no prisma, no server imports) so the
// Financials page — a client component — can import it without pulling server
// code into the browser bundle. lib/financialReports re-exports these.

export const REPORT_TYPES = [
  "pnl",
  "revenue_by_category",
  "expenses_by_category",
  "donations",
  "contractors",
  "cash_vs_card",
  "stripe_fees",
  "missing_receipts",
  "uncategorized",
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const REPORT_LABELS: Record<ReportType, string> = {
  pnl: "Profit & Loss",
  revenue_by_category: "Revenue by category",
  expenses_by_category: "Expenses by category",
  donations: "Donations summary",
  contractors: "Contractor / guest coach payments",
  cash_vs_card: "Cash vs card revenue",
  stripe_fees: "Stripe fees summary",
  missing_receipts: "Receipts missing",
  uncategorized: "Uncategorized transactions",
};
