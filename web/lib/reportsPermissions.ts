// Reports Phase 2.5.11 — granular sub-scoped permissions.
//
// Sub-scopes live nested under the existing `reports` key so legacy
// `reports: "view"` (a plain enum) keeps working. When `reports` is an
// OBJECT (`{ view: true, financials: false, … }`), sub-scopes are honored.
// When it's a scalar, the coarse level ("view") maps to a sensible default
// scope set for backward compatibility.
//
// This never changes existing `hasPermission(perms, "reports", "view")`
// checks — those keep working via legacy fallback in resolveReportsScopes.

import { resolvePermissions, type PermissionKey } from "@/lib/permissions";

export const REPORT_SCOPES = [
  "view",           // exists today: gates the entire Reports section
  "financials",     // Snapshot, P&L, Costs, Cash flow, Unit economics
  "bank_balances",  // Cash on hand, runway, cash-flow balances
  "payroll",        // Payroll lines in P&L and Costs
  "owner_equity",   // Owner contributions and distributions, loan lines
  "vendors",        // Vendor names and vendor detail
  "membership",     // Membership and churn metrics
  "by_coach",       // Per-coach revenue and churn
  "imports",        // Run and review imports
  "rollback",       // Roll an import back
] as const;
export type ReportScope = (typeof REPORT_SCOPES)[number];

// Sensible defaults when a staff member has `reports: "view"` set as the
// legacy scalar. They see the Snapshot/Revenue/Costs/P&L/Membership tabs
// but nothing that leaks bank balances, payroll or owner equity.
const LEGACY_VIEW_DEFAULTS: Record<ReportScope, boolean> = {
  view: true,
  financials: true,      // P&L + Costs — the numbers most staff need
  bank_balances: false,  // Bank balances stay owner-financial permission
  payroll: false,
  owner_equity: false,
  vendors: true,
  membership: true,
  by_coach: false,       // Requires reports.by_coach explicitly
  imports: false,
  rollback: false,
};

const ALL_ON: Record<ReportScope, boolean> = REPORT_SCOPES.reduce(
  (acc, k) => ({ ...acc, [k]: true }),
  {} as Record<ReportScope, boolean>,
);
const ALL_OFF: Record<ReportScope, boolean> = REPORT_SCOPES.reduce(
  (acc, k) => ({ ...acc, [k]: false }),
  {} as Record<ReportScope, boolean>,
);

// Resolve the effective boolean per scope for a session's permissions.
// OWNER always gets ALL_ON (checked at the callsite; this helper doesn't
// know the role).
export function resolveReportsScopes(
  perms: Record<string, unknown> | null | undefined,
): Record<ReportScope, boolean> {
  const raw = (perms && typeof perms === "object" ? perms : {}) as Record<string, unknown>;
  const rawReports = raw.reports;
  if (rawReports == null || rawReports === "none") return { ...ALL_OFF };
  if (typeof rawReports === "string") {
    if (rawReports === "view" || rawReports === "edit" || rawReports === "send" || rawReports === "full") {
      // Legacy scalar. Any positive level yields the defaults.
      return { ...LEGACY_VIEW_DEFAULTS };
    }
    return { ...ALL_OFF };
  }
  if (typeof rawReports === "object") {
    const obj = rawReports as Record<string, unknown>;
    const out: Record<ReportScope, boolean> = { ...ALL_OFF };
    for (const scope of REPORT_SCOPES) {
      const v = obj[scope];
      out[scope] = v === true || v === "true" || v === 1;
    }
    // If they got at least one scope, they implicitly have `view`.
    if (Object.values(out).some((v) => v)) out.view = true;
    return out;
  }
  return { ...ALL_OFF };
}

// Owner-aware check. Owners bypass entirely.
// Accepts either a next-auth session (loosely typed like apiGuard) or a
// (role, perms) pair — matches how session.user is accessed throughout
// the codebase via `as any` casts.
export function hasReportScope(
  roleOrSession: string | undefined | { user?: { role?: string; permissions?: unknown } } | null,
  permsOrScope: Record<string, unknown> | null | undefined | ReportScope,
  maybeScope?: ReportScope,
): boolean {
  let role: string | undefined;
  let perms: Record<string, unknown> | null | undefined;
  let scope: ReportScope;
  if (typeof roleOrSession === "string" || roleOrSession == null) {
    role = roleOrSession ?? undefined;
    perms = permsOrScope as Record<string, unknown> | null | undefined;
    scope = maybeScope as ReportScope;
  } else {
    // Session-form
    const sess = roleOrSession as { user?: { role?: string; permissions?: unknown } };
    role = sess.user?.role;
    perms = (sess.user?.permissions ?? null) as Record<string, unknown> | null;
    scope = permsOrScope as ReportScope;
  }
  if (role === "OWNER") return true;
  const scopes = resolveReportsScopes(perms);
  return scopes[scope];
}

// Suggested display of the resolved scope object for the staff editor UI.
export function reportsScopeLabels(): Record<ReportScope, { label: string; help: string }> {
  return {
    view: { label: "Reports (base)", help: "Access the Reports section at all." },
    financials: { label: "Financials", help: "Snapshot, P&L, Costs, Cash flow, Unit economics." },
    bank_balances: { label: "Bank balances", help: "Cash on hand + runway + cash-flow balances." },
    payroll: { label: "Payroll", help: "Payroll lines in P&L and Costs." },
    owner_equity: { label: "Owner equity", help: "Owner contributions + distributions + loan lines." },
    vendors: { label: "Vendor names", help: "Show vendor names + vendor detail." },
    membership: { label: "Membership", help: "Membership + churn metrics." },
    by_coach: { label: "Per-coach revenue", help: "Per-coach revenue + churn breakdown." },
    imports: { label: "Run imports", help: "Run and review historical imports." },
    rollback: { label: "Roll back imports", help: "Roll an import back within 30 days." },
  };
}

// Convenience: does the caller have permission for `key`? A one-liner that
// wraps the parent `permissions.ts hasPermission` for callers that don't
// need scope nesting.
export function hasReportsAny(
  role: string | undefined,
  perms: Record<string, unknown> | null | undefined,
): boolean {
  return hasReportScope(role, perms, "view");
}

// The parent permission catalog uses `PermissionKey = "reports"` — this
// helper picks up sub-scopes without shadowing that.
export const REPORTS_PERMISSION_KEY: PermissionKey = "reports";

void resolvePermissions; // Explicit import so the parent module stays in the type graph.
