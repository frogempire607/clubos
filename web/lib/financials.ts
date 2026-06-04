// Single source of truth for the lightweight Financial OS. Pure module (no
// prisma/next imports) so it's safe in client and server alike. Owner-facing
// language is intentionally plain — "Money In / Money Out", not GL/journal.

export const REVENUE_CATEGORIES = [
  { key: "memberships", label: "Memberships" },
  { key: "classes", label: "Classes" },
  { key: "events", label: "Events" },
  { key: "camps_clinics", label: "Camps / Clinics" },
  { key: "private_lessons", label: "Private lessons" },
  { key: "products", label: "Products / Merch" },
  { key: "donations", label: "Donations" },
  { key: "sponsorships", label: "Sponsorships" },
  { key: "manual_invoice", label: "Manual invoices" },
  { key: "cash_payment", label: "Cash payments" },
  { key: "other_income", label: "Other income" },
] as const;

export const EXPENSE_CATEGORIES = [
  { key: "RENT", label: "Rent" },
  { key: "PAYROLL", label: "Payroll / Coaches" },
  { key: "CONTRACTOR", label: "Contractor / Guest coach" },
  { key: "EQUIPMENT", label: "Gear / Equipment" },
  { key: "SOFTWARE", label: "Software" },
  { key: "MARKETING", label: "Marketing" },
  { key: "TRAVEL", label: "Travel" },
  { key: "MEALS", label: "Meals" },
  { key: "INSURANCE", label: "Insurance" },
  { key: "MAINTENANCE", label: "Repairs / Maintenance" },
  { key: "UTILITIES", label: "Utilities" },
  { key: "PROFESSIONAL", label: "Professional services" },
  { key: "FEES", label: "Bank / Processing fees" },
  { key: "EVENTS", label: "Event costs" },
  { key: "OTHER", label: "Other expense" },
] as const;

export const PAYMENT_METHODS = [
  { key: "CASH", label: "Cash" },
  { key: "CARD", label: "Card" },
  { key: "STRIPE", label: "Stripe / Online" },
  { key: "BANK", label: "Bank transfer" },
  { key: "CHECK", label: "Check" },
  { key: "INVOICE", label: "Invoice (unpaid)" },
  { key: "COMP", label: "Comp / Free" },
  { key: "OTHER", label: "Other" },
] as const;

export type RevenueCategoryKey = (typeof REVENUE_CATEGORIES)[number]["key"];

const REVENUE_LABELS: Record<string, string> = Object.fromEntries(
  REVENUE_CATEGORIES.map((c) => [c.key, c.label]),
);
const EXPENSE_LABELS: Record<string, string> = Object.fromEntries(
  EXPENSE_CATEGORIES.map((c) => [c.key, c.label]),
);
const METHOD_LABELS: Record<string, string> = Object.fromEntries(
  PAYMENT_METHODS.map((m) => [m.key, m.label]),
);

// Stripe transaction `type` → revenue category. Used only as a fallback when
// the owner hasn't explicitly set a category — we never overwrite their pick.
const TYPE_TO_CATEGORY: Record<string, RevenueCategoryKey> = {
  MEMBERSHIP: "memberships",
  CLASS: "classes",
  EVENT: "events",
  PRODUCT: "products",
  DONATION: "donations",
  PRIVATE: "private_lessons",
};

// Resolve a transaction's effective revenue category. Returns null when it
// genuinely can't be inferred so the UI can surface it under "Uncategorized".
export function resolveRevenueCategory(tx: {
  category?: string | null;
  type?: string | null;
}): string | null {
  if (tx.category) return tx.category;
  if (tx.type && TYPE_TO_CATEGORY[tx.type]) return TYPE_TO_CATEGORY[tx.type];
  return null;
}

export function revenueCategoryLabel(key: string | null | undefined): string {
  if (!key) return "Uncategorized";
  return REVENUE_LABELS[key] ?? key;
}

export function expenseCategoryLabel(key: string | null | undefined): string {
  if (!key) return "Uncategorized";
  return EXPENSE_LABELS[key] ?? key;
}

export function paymentMethodLabel(key: string | null | undefined): string {
  if (!key) return "—";
  return METHOD_LABELS[key] ?? key;
}

// CASH is everything that isn't card/online/bank rails (and isn't comped).
export function isCashMethod(method: string | null | undefined): boolean {
  return method === "CASH" || method === "CHECK";
}

// Comped / free attendance — tracked separately, never counted as revenue.
export function isCompMethod(method: string | null | undefined): boolean {
  return method === "COMP";
}

export const FINANCIAL_DISCLAIMER =
  "AthletixOS helps organize financial records but does not replace professional tax or accounting advice.";

export const TAX_SUMMARY_NOTE =
  "Tax-ready summaries to share with your accountant or use while filing.";
