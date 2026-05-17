// Shared helpers for the Member Migration / Software-Switch wizard.
// Pure functions only (no next/prisma imports) so they're safe anywhere.

import crypto from "crypto";

export const MIGRATION_STATUS = {
  IMPORTED: "IMPORTED",
  INVITED: "INVITED",
  ACTIVATED: "ACTIVATED",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  NEEDS_REVIEW: "NEEDS_REVIEW",
} as const;
export type MigrationStatus = (typeof MIGRATION_STATUS)[keyof typeof MIGRATION_STATUS];

export const PAYMENT_SETUP = {
  REQUIRED: "REQUIRED",
  COMPLETE: "COMPLETE",
} as const;

// Buckets used by the dashboard filter chips.
export const MIGRATION_FILTERS = [
  "all",
  "imported",
  "invited",
  "activated",
  "payment_required",
  "completed",
  "needs_review",
] as const;
export type MigrationFilter = (typeof MIGRATION_FILTERS)[number];

// Split a single "Athlete Name" into first/last ONLY when it's safe to do so.
// One token → first name only (lastName stays ""). Two tokens → first/last.
// 3+ tokens → first = first token, last = the rest (keeps suffixes together).
// We never block import over this — a one-name club is fully supported.
export function splitName(raw: string): { firstName: string; lastName: string } {
  const name = (raw || "").trim().replace(/\s+/g, " ");
  if (!name) return { firstName: "", lastName: "" };
  // "Last, First" form from many legacy exports.
  if (name.includes(",")) {
    const [last, first] = name.split(",").map((s) => s.trim());
    if (first) return { firstName: first, lastName: last };
  }
  const parts = name.split(" ");
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

// Resolve a usable display name from any of the supported name columns.
export function resolveName(input: {
  athleteName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}): { firstName: string; lastName: string; display: string } {
  const fn = (input.firstName || "").trim();
  const ln = (input.lastName || "").trim();
  if (fn || ln) {
    return { firstName: fn || ln, lastName: fn ? ln : "", display: `${fn} ${ln}`.trim() };
  }
  const split = splitName(input.athleteName || "");
  return {
    firstName: split.firstName || (input.athleteName || "").trim() || "Member",
    lastName: split.lastName,
    display: (input.athleteName || `${split.firstName} ${split.lastName}`).trim(),
  };
}

// Parse a wide range of legacy date strings. Returns null on anything unparseable
// rather than throwing — callers surface it as a warning.
export function parseFlexibleDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // ISO / RFC first.
  const direct = new Date(s);
  if (!isNaN(direct.getTime()) && /\d{4}/.test(s)) return direct;
  // MM/DD/YYYY or M-D-YY etc.
  const m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (m) {
    let [, mm, dd, yy] = m;
    let year = parseInt(yy, 10);
    if (year < 100) year += year < 50 ? 2000 : 1900;
    const d = new Date(year, parseInt(mm, 10) - 1, parseInt(dd, 10));
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

// Normalize a legacy billing frequency string to our billingPeriod vocabulary.
export function normalizeFrequency(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).toLowerCase().replace(/[^a-z]/g, "");
  if (!s) return null;
  if (s.includes("week")) return "WEEKLY";
  if (s.includes("biweek") || s.includes("fortnight")) return "BIWEEKLY";
  if (s.includes("month")) return "MONTHLY";
  if (s.includes("quarter")) return "QUARTERLY";
  if (s.includes("semi") || s.includes("halfyear") || s.includes("biannual")) return "SEMI_ANNUAL";
  if (s.includes("year") || s.includes("annual")) return "ANNUAL";
  if (s.includes("once") || s.includes("onetime") || s.includes("lifetime")) return "ONE_TIME";
  return null;
}

// Parse a money-ish string ("$45.00", "45", "45 USD") to a number or null.
export function parseMoney(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const cleaned = String(raw).replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isValidEmail(raw: string | null | undefined): boolean {
  return !!raw && EMAIL_RE.test(String(raw).trim());
}

// Secure URL-safe activation token.
export function newActivationToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

// Resolve the next billing / anchor date. If the legacy system billed on day X,
// Stripe should take the FIRST charge on the next future occurrence of that
// cycle — never on import day. Falls back to a sensible future date.
export function resolveBillingAnchor(args: {
  nextBillingDate: Date | null;
  membershipStartDate: Date | null;
  frequency: string | null;
  now?: Date;
}): Date | null {
  const now = args.now ?? new Date();
  // Explicit next-bill date from the old system always wins (roll forward if
  // it's already in the past so we never bill retroactively).
  let anchor = args.nextBillingDate ?? null;
  if (anchor && anchor > now) return anchor;

  const base = anchor ?? args.membershipStartDate;
  if (!base) return null;

  const step = (d: Date) => {
    const x = new Date(d);
    switch (args.frequency) {
      case "WEEKLY": x.setDate(x.getDate() + 7); break;
      case "BIWEEKLY": x.setDate(x.getDate() + 14); break;
      case "QUARTERLY": x.setMonth(x.getMonth() + 3); break;
      case "SEMI_ANNUAL": x.setMonth(x.getMonth() + 6); break;
      case "ANNUAL": x.setFullYear(x.getFullYear() + 1); break;
      default: x.setMonth(x.getMonth() + 1); break; // MONTHLY default
    }
    return x;
  };

  anchor = new Date(base);
  let guard = 0;
  while (anchor <= now && guard < 520) {
    anchor = step(anchor);
    guard++;
  }
  return anchor;
}
