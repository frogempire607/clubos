# 02 — API contracts

All routes live under `web/app/api/reports/`. All follow the existing guard pattern from `web/app/api/reports/overview/route.ts`:

```ts
const session = await getServerSession(authOptions);
if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF"))
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
const denied = requirePermission(session, "reports", "view");
if (denied) return denied;
// then the tier gate — getTierFeatures(club.tier).reports
```

Financial routes add a second permission check (`specs/05`). Money-bearing routes are `OWNER`-only unless the staff member has the matching financial permission.

## Shared: range resolution

Extend the `Range` union in `overview/route.ts`:

```ts
type Range =
  | "this_week" | "last_week" | "month" | "last_month"
  | "qtd" | "ytd" | "year" | "all"
  | "before_athletix" | "since_athletix" | "custom";
```

- `before_athletix` — start `null`, end = `Club.createdAt` (or an explicit `Club.wentLiveAt` if one exists; add it if not).
- `since_athletix` — start = that same boundary, end = now.
- `custom` — requires `from` and `to` ISO dates; 400 without them.

Every response carries:

```ts
range: {
  key, label,
  start: string | null,
  end: string,
  isPartialPeriod: boolean,
  partialNote: string | null,   // "28 of 31 days"
  comparison: { key, label, start, end } | null
}
```

Weeks run **Monday to Sunday**. Months are calendar months in the club's timezone, not UTC — get the timezone from `Club`; if there isn't one, add it. Every existing date bucket in `overview/route.ts` uses server-local `new Date(...)`, which will drift for clubs outside the server's zone. Fix this as part of Phase 1.

---

## `GET /api/reports/snapshot`

Params: `range`, `from`, `to`.

```ts
{
  range: Range,
  snapshot: {
    netPosition, totalInflows, totalOutflows,
    avgWeeklyBurn, avgMonthlyBurn, avgWeeklyNet, avgMonthlyNet,
    burnBasis: { label: string, months: number }   // "Apr–Jun 2026", 3
  },
  cash: {
    accounts: [{ id, label, institution, mask, balance, lastSyncedAt }],
    stripePending: number,
    totalAvailable: number,
    lastUpdatedAt: string,
    creditExcluded: true
  },
  runway: { months: number | null, status: "healthy"|"tight"|"critical", basisLabel: string },
  comparison: { netPositionDelta, inflowsDelta, outflowsDelta } | null,
  trend: [{ month: string, inflows: number, outflows: number, isPartial: boolean }],
  reliability: ReliabilitySection[]
}
```

`runway.months` is `null` — not `0` — when there is no bank connection. The UI shows "Connect a bank account to see runway", never "0 months".

## `GET /api/reports/reliability`

Cheap, cached ~60s, called by the strip on every tab.

```ts
{
  sections: [{
    key: "bank" | "stripe" | "cash" | "categorization" | "historical" | "payroll",
    label: string,
    state: "COMPLETE" | "MISSING_BANK_CONNECTION" | "AWAITING_CATEGORIZATION"
         | "HISTORICAL_DATA_INCOMPLETE" | "CASH_DATA_NOT_INCLUDED" | "ESTIMATED" | "NEEDS_REVIEW",
    detail: string,          // "23 transactions awaiting a category"
    count: number | null,
    lastUpdatedAt: string | null,
    href: string             // deep link to the exact fix
  }],
  attentionCount: number
}
```

`href` must land on the specific screen — `/dashboard/financials?tab=out&filter=uncategorized`, not `/dashboard/financials`.

## `GET /api/reports/revenue`

```ts
{
  range, total,
  recurring: {
    activeMemberships, mrr, arr, arpa, arpMembership,
    newMemberships, renewedMemberships, endedMemberships, upgrades, downgrades,
    amount, percentOfTotal
  },
  variable: { amount, percentOfTotal, byCategory: [{ key, label, amount }] },
  byItem: [{ id, label, category, units, amount, percentOfTotal }],
  byCoach: [{ id, name, amount }] | null,      // null when the club tracks no coach assignment
  byLocation: [{ id, name, amount }] | null,
  bySource: [{ source, amount }]               // ATHLETIXOS | STRIPE | PREVIOUS_SOFTWARE | CASH | MANUAL_IMPORT | BANK | OTHER
}
```

MRR is forward-looking: sum of active recurring subscription amounts normalized to monthly (annual ÷ 12, weekly × 52/12). It is **not** the period's recurring revenue — the design shows both and they differ.

## `GET /api/reports/costs`

```ts
{
  range,
  fixed:    { total, monthlyAverage, percentOfRevenue, categories: string[] },
  variable: { total, monthlyAverage, percentOfRevenue, categories: string[] },
  topCategories: [{ rank, category, label, behavior: "FIXED"|"VARIABLE", amount, percentOfRevenue, deltaPercent }],
  topVendors:    [{ vendor, amount, transactionCount }],
  largestExpenses: [{ id, date, description, vendor, amount }],
  attention: {
    uncategorized:  { count, amount, href },
    missingReceipts:{ count, amount, href },
    awaitingReview: { count, href },
    unusualIncreases:[{ category, currentAmount, averageAmount, percentAbove }],
    recurringSubscriptions: { count, monthlyAmount, href },
    possibleDuplicates: [{ ids: string[], vendor, amount, date }]
  }
}
```

`PATCH /api/reports/costs/classification` — body `{ category, treatAs: "FIXED"|"VARIABLE" }`. Owner-only. Writes `ExpenseClassificationOverride`. Returns the recomputed fixed/variable split so the UI updates without a refetch.

Unusual increase = current period ≥ 1.5× the trailing 3-period average **and** the absolute difference ≥ $250. Both conditions, so a $12 → $30 software charge doesn't fire an alert.

## `GET /api/reports/pnl`

Params: `period=monthly|weekly`, `basis=cash|accrual`, `range`, `from`, `to`, `compare=previous|last_year`.

```ts
{
  period, basis, columns: [{ key, label, start, end, isPartial: boolean }],
  sections: [{
    key: "income" | "cost_of_sales" | "operating_expenses",
    label: string,
    lines: [{ key, label, values: number[], drillHref: string }],
    total: { label, values: number[] }
  }],
  summary: {
    grossIncome, netOperatingIncome, grossProfit, grossMarginPercent,
    totalOperatingExpenses, operatingProfit, netProfit, profitMarginPercent
  }[],                                   // one entry per column
  rollingAverage: { label: "4-week rolling average", values: number[] } | null,
  accrualCoverage: { supported: boolean, unsupportedPurchaseCount: number } | null,
  warnings: [{ kind: "PARTIAL_PERIOD" | "ACCRUAL_INCOMPLETE" | "UNCATEGORIZED", message, href }]
}
```

`values` arrays are index-aligned with `columns`. The 4-week rolling average **excludes** any partial column.

Accrual: revenue is recognised across `membershipStartDate → membershipEndDate` (or camp/event dates). A purchase with no span falls back to cash and increments `unsupportedPurchaseCount`. Never silently mix — the UI states how many.

`GET /api/reports/pnl/export?format=csv|pdf` with the same params. Reuse `reportToCsv` from `web/lib/financialReports.ts`.

## `GET /api/reports/pnl/drill`

Params: `line` (the line key), plus the same period params.

```ts
{ line: { key, label }, total: number, transactions: [{ id, date, description, counterparty, amount, source, href }] }
```

Every number in the P&L, cost and revenue tables links here. This is the single most-requested behavior in the brief — build it in Phase 2, not later.

## `GET /api/reports/membership`

Params: `range`, `groupBy=type|program|location|age|coach`.

```ts
{
  range,
  movement: { startingActive, new: n, reactivated, canceled, expired, endingActive, planChanges },
  rates: {
    churnRate, revenueChurnRate, retentionRate, trialToPaidRate,
    avgMembershipDurationMonths, avgLifetimeValue,
    avgMonthlyRevenuePerAthlete, avgMonthlyRevenuePerFamily
  },
  formula: { label: string, numerator: number, denominator: number, result: number },
  trend: [{ period: string, churnRate: number }],
  breakdown: [{ key, name, active, lost, churnRate, revenue }],
  notes: string[]
}
```

`formula` is rendered verbatim in the UI. Do not hard-code the formula text in the client.

`groupBy=coach` returns 403 for non-owners and `null` for clubs with no coach assignment on memberships.

## `GET /api/reports/unit-economics`

```ts
{
  range, athleteCount,
  perAthlete: { revenue, cost, grossProfit, operatingProfit, marginPercent },
  margins: { grossMarginPercent, operatingMarginPercent },
  breakEven: {
    athletes, currentAthletes, gap,
    formula: { label, monthlyFixedCosts, contributionMarginPerAthlete },
    isEstimate: true
  },
  acquisition: {
    cac: number | null, ltv: number | null, ltvToCacRatio: number | null,
    isEstimate: true,
    caveats: string[]     // "6 of 14 new members have no recorded acquisition source"
  }
}
```

Any field whose confidence is low returns `null` plus a caveat string. Never return a fabricated number.

## `GET /api/reports/cash-flow`

```ts
{
  range,
  beginningCash, cashReceived, cashSpent, netMovement, endingCash,
  operating: { inflows, outflows },
  investing: [{ label, amount }],
  financing: [{ label, amount, kind: "LOAN_PROCEEDS"|"LOAN_PAYMENT"|"OWNER_CONTRIBUTION"|"OWNER_DISTRIBUTION" }],
  excluded: { accountTransfers: { count, amount }, matchedStripePayouts: { count, amount } },
  forecast: {
    expectedMembershipRevenue, expectedRecurringRevenue,
    upcomingPayroll, upcomingRecurringExpenses, expectedStripePayouts,
    projectedMonthEndCash, estimatedRunwayMonths, breakEvenProgress,
    isEstimate: true, basis: string
  } | null
}
```

`forecast` is `null` when there are fewer than 3 complete months of data. The UI hides the section rather than showing zeros.

## `GET /api/reports/alerts` · `PUT /api/reports/alerts/settings`

```ts
{ alerts: [{ kind, severity: "high"|"medium"|"low", state: "TRIGGERED"|"OK", title, detail, href, threshold }] }
```

Owner-only. Reuse the severity vocabulary and dot colors from `web/components/NotificationBell.tsx` so alerts look native.

## Import routes

See `specs/04` for behavior. Contracts:

```
POST   /api/reports/imports                      → { batchId, headers[], sampleRows[], suggestedMap }
PATCH  /api/reports/imports/:id/mapping          → { valid, unmappedColumns[] }
POST   /api/reports/imports/:id/validate         → { readyCount, reviewCount, errorCount, errorGroups[], warnings[] }
GET    /api/reports/imports/:id/preview?limit=50 → { rows[], summary }
GET    /api/reports/imports/:id/errors.csv       → text/csv, original rows + an `error` column
GET    /api/reports/imports/:id/review?cursor=   → { items[], total, reviewed }
POST   /api/reports/imports/:id/review/:rowId    → { outcome: ImportOutcome, targetId? }
POST   /api/reports/imports/:id/commit           → 202 { jobId }
GET    /api/reports/imports/:id                  → batch status + counts (poll during commit)
GET    /api/reports/imports/:id/log?cursor=      → paginated ImportRow[]
POST   /api/reports/imports/:id/rollback         → owner-only, 30-day window
GET    /api/reports/imports                      → import history list
```

Commit is asynchronous for files over ~2,000 rows. Return 202 and poll; the UI shows a progress state on step 6.
