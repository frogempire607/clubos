# Reports & Financial Dashboard — engineering handoff

**Repo:** `frogempire607/clubos` · **App:** `web/` (Next.js App Router, Prisma, NextAuth, Tailwind v4 tokens)
**Scope:** everything under `/dashboard/reports`. **Out of scope:** `/dashboard/financials` — do not modify it.

## Designs

| File | What it shows |
| --- | --- |
| `Reports Current (baseline).dc.html` | The Reports page as it exists today. Reference only — do not build this. |
| `Reports.dc.html` | The target Reports hub. Eight tabs. Open the Tweaks panel and set `initialTab` to jump between them. |
| `Reports Import Wizard.dc.html` | The seven-step all-time import flow. Set `initialStep` 1–7, or click the step rail. |

The designs are inline-styled HTML using the exact tokens from `web/app/globals.css`. Lift values from them directly; do not re-derive colors or spacing.

## Specs

| Spec | Covers |
| --- | --- |
| [`specs/01-data-model.md`](specs/01-data-model.md) | Prisma models and fields to add |
| [`specs/02-api-contracts.md`](specs/02-api-contracts.md) | Every route, its params and its response shape |
| [`specs/03-calculations.md`](specs/03-calculations.md) | Formulas, double-counting rules, reliability states |
| [`specs/04-imports.md`](specs/04-imports.md) | CSV import, matching, review queue, audit, rollback |
| [`specs/05-permissions-and-mobile.md`](specs/05-permissions-and-mobile.md) | Permission matrix and responsive rules |
| [`specs/06-test-plan.md`](specs/06-test-plan.md) | Test checklist mapped to the brief's Verification section |

## What exists today

- `web/app/dashboard/reports/page.tsx` — client component. Range pills, four KPI cards, a CSS bar chart, five breakdown cards, CSV export links. ~460 lines.
- `web/app/api/reports/overview/route.ts` — one endpoint returning revenue / members / subscriptions / attendance / expenses / topEvents / revenueMonthly. Gated by `getTierFeatures(...).reports` and `requirePermission(session, "reports", "view")`.
- `web/lib/financialReports.ts` — `buildReport(clubId, type, range)` for nine report types plus `reportToCsv`. Already handles Stripe fees from balance transactions, cash-vs-card channels, uncategorized transactions and missing receipts. **Reuse this; extend it rather than writing a parallel implementation.**
- `web/app/dashboard/financials/page.tsx` — already owns bank connections (Plaid), Stripe, expense entry, donations, tax summary, and a `FIXED` / `VARIABLE` classification field on expense categories. Reports consumes that classification; it does not own it.

## Build order

**Phase 1 — the shell (no new data).** Convert `/dashboard/reports` into the tabbed hub. Keep `PageHeader`. Replace the range pills with the range dropdown (adds This week, Last week, QTD, Before AthletixOS, Since joining AthletixOS, Custom). Move today's content into the Snapshot and Revenue tabs. Add the reliability strip driven by a new `GET /api/reports/reliability`. Ship this first — it is useful on its own.

**Phase 2 — P&L.** `GET /api/reports/pnl`. Monthly first (full line detail), then weekly (condensed columns + 4-week rolling average). Partial-period detection. CSV and PDF export. Row drill-through to a transaction list.

**Phase 3 — costs, membership, unit economics, cash flow.** Four endpoints, mostly aggregation over data that already exists. Churn needs the membership-event history in Phase 4's schema to be exact; until then compute from `MemberSubscription` status transitions and flag as estimated.

**Phase 4 — historical imports.** Schema first (`specs/01`), then the importer (`specs/04`), then the all-time range options light up.

**Phase 5 — forecasts and alerts.** Everything else must be correct first; forecasts built on bad totals are worse than no forecasts.

## Non-negotiables

1. **Never present a total you can't stand behind.** If bank sync is stale, categorization is incomplete, or historical data is partial, the section says so and links to the fix. Every card carries a last-updated timestamp.
2. **Never double-count.** A Stripe charge and the bank deposit of its payout are one dollar, not two. See `specs/03`.
3. **Transfers between the club's own accounts are not income or expenses.** They appear only in the cash-flow view, in their own excluded section.
4. **Never merge people on a similar name.** Hard signals only; everything else goes to the review queue.
5. **Estimates are labelled.** Runway, CAC, LTV, break-even and every forecast carry an "Estimated" badge and state the inputs used.
6. **Reuse, don't fork.** `EXCLUDE_VOID`, `resolveRevenueCategory`, `expenseCategoryLabel`, `isCashMethod`, `computePayrollTotalForRange` already exist. Use them.
