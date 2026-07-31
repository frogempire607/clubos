# AthletixOS Improvement — Progress & Phased Plan

Companion to `plan.md` (the brief) and `ARCHITECTURE-NOTES.md` (the discovery findings).

**Preserve existing production data.** Every migration is additive; every backfill is dry-run-first with allowlists; nothing gets renamed, dropped, or silently relabeled. Follow the two-workflow migration pattern (hand-write SQL → `migrate deploy` → Supabase MCP bookkeeping when needed).

Status legend: `⬜ pending · 🟡 in progress · 🟢 done · 🔵 blocked · ⚪ deferred`.

## Phase index (Option B, 2026-07-29)

| Phase | Area | Status |
|---|---|---|
| [1](#phase-1--owner-financials) | Owner Financials (1A–1E) | 🟢 done |
| [2](#phase-2--reports) | Reports — thin plan.md fixes | 🟢 done |
| [2.5](#phase-25--reports-full-design-handoff) | Reports — full design handoff (8-tab hub, drill, imports, alerts, forecasts, PDF/CSV export) | ⬜ pending |
| [3](#phase-3--communications--email) | Communications & Email | ⬜ pending |
| [4](#phase-4--client--family-accounts) | Client & Family Accounts | ⬜ pending |
| [4.5](#phase-45--members-full-design-handoff) | Members — full design handoff (3 tracks, list, profile, Family & access, migration redesign, mobile, source label) | ⬜ pending |
| [5](#phase-5--event-registration-confirmation) | Event Registration Confirmation | ⬜ pending |
| [6](#phase-6--safety-data-integrity-testing) | Safety, Testing, Deployment & Final Handoff | ⬜ pending |

## Full migration inventory (M1–M22)

| # | Migration | Phase | Applied? |
|---|---|---|---|
| M1–M4 | `20260728000000_financials_transaction_fields` — Transaction refund/receipt/recorded-by/athlete | 1A | ✅ 2026-07-29 |
| M5 | `20260728010000_plaid_transactions` — PlaidTransaction + PlaidSyncCursor + Expense.matchedPlaidTransactionId | 1B | ✅ 2026-07-29 |
| M6–M7 | `20260728020000_money_out_matching` — Expense review + TransactionCategoryRule | 1C | ✅ 2026-07-29 |
| M8 | `20260728030000_reports_indexes` — composite indexes for range queries | 2 | ✅ 2026-07-29 |
| M9 + M9a | `Club.wentLiveAt` + `ActionItemSnooze` (bundled in `20260730000000_reports_snapshot_actionitems`) | 2.5.1 + 2.5.1a | ✅ 2026-07-29 |
| M10 | `ExpenseClassificationOverride` — owner FIXED/VARIABLE per category | 2.5.3 | ✅ 2026-07-29 |
| M11 | `PayoutMatch` — Stripe payout ↔ bank credit link | 2.5.7 | ✅ 2026-07-29 |
| M12 | `ReportAlertSetting` — alert thresholds per club | 2.5.8 | ✅ 2026-07-29 |
| M13 | `ImportBatch` + `ImportRow` + `MemberHistoricalRecord` + enums | 2.5.9 | ✅ 2026-07-29 |
| M14 | `Member.externalMemberId, sourceSystem, importBatchId, isHistoricalOnly, normalizedEmail, normalizedPhone` | 2.5.9 | ✅ 2026-07-29 |
| M15 | `Transaction.externalTransactionId (@@unique with sourceSystem), externalCustomerId, sourceSystem, importBatchId, isHistorical, dedupeHash` | 2.5.9 | ✅ 2026-07-29 |
| M16 | `Import.sourceLabel` — owner-typed vendor label (rolls into M13's ImportBatch) | 2.5.9 | (in M13) |
| M17 | `Member.reviewedAt, reviewedByUserId` — migration step 2 | 4.5.1 | ⬜ |
| M18 | `Member.blockedReason, snoozedUntil` — Blocked state + Snooze | 4.5.1 | ⬜ |
| M19 | `MemberInvitationDelivery` — per-send delivered/opened/bounced | 4.5.1 | ⬜ |
| M20 | `SavedMemberView` — user filter snapshots | 4.5.2 | ⬜ |
| M21 | `MemberGuardianUser` per-permission columns (canBook/canPay/canWaivers/canMessages) + `status` | 4.5.6 | ⬜ |
| M22 | `MemberSubscriptionEvent` — subscription-event history (Reports 2.5.5 precision) | 4.5.10 | ⬜ |

**All migrations remaining after M8 are additive.** Nothing drops, nothing renames. Backfills are dry-run-first with per-club reports.

## Full backfill inventory

| # | Backfill | Phase | Notes |
|---|---|---|---|
| BF-1 | `Member.sourceSystem = 'ATHLETIXOS'` for existing rows | 2.5.9 | ✅ 2026-07-29 (292 members) |
| BF-2 | `Member.normalizedEmail` + `Member.normalizedPhone` from existing fields | 2.5.9 | ✅ 2026-07-29 (35 emails, 44 phones) |
| BF-3 | `Transaction.sourceSystem` derived from `paymentSource` | 2.5.9 | ✅ 2026-07-29 (37 tx: 23 STRIPE, 12 CASH, 2 OTHER) |
| BF-4 | `Member.reviewedAt/reviewedByUserId` from existing `setupComplete/setupBy/setupAt` where present | 4.5.1 | Migration timeline step 2 |
| BF-5 | `MemberGuardianUser` existing rows → `status='CONFIRMED'`, all four booleans `true` | 4.5.6 | Preserves current unrestricted behavior |
| BF-6 | `MemberSubscriptionEvent` initial `CREATED` events + status-inference | 4.5.10 | Powers Reports 2.5.5 churn precision; dry-run first |
| BF-7 | Seed `ReportAlertSetting` defaults on every existing club | 2.5.8 | Runway 3mo, uncategorized 20, refund 5%, payroll 15% above avg |

---

## Phase 0 — Foundations (do before ANY phase code)

Everything in `ARCHITECTURE-NOTES.md §2.3` items 1, 2, 3 lands here — they unblock every subsequent phase and remove duplication that would otherwise get baked into new features.

| # | Task | Class | Files touched | Status |
|---|---|---|---|---|
| 0.1 | **`lib/memberDisplay.ts`** — extract `displayStatusOf`, `onboardingStatusOf` from `app/dashboard/members/page.tsx`, unify with `deriveBillingState` + `deriveReadiness` from `lib/billingAdmin.ts`. Export `serializeMemberForList(member) → { tracks, nextAction, ...member }`. Add unit tests. | Backend | new lib, refactor page + `[id]/page.tsx` | ⬜ |
| 0.2 | **Unify payment-method vocabulary** — collapse `lib/financials.ts:PAYMENT_METHODS` into `lib/paymentSources.ts:PAYMENT_SOURCES` + a display mapper. Update every summary consumer. Fully backward-compatible via display mapper. | Backend | `lib/financials.ts`, `lib/paymentSources.ts`, `/api/financials/summary`, financial UI | ⬜ |
| 0.3 | **`computePnl(clubId, range, entity?)`** in `lib/financialReports.ts` — one implementation used by `/api/financials/summary`, `/api/reports/overview`, `buildReport('pnl')`. Verify all three today produce identical numbers on identical inputs; document any drift as a bug closed by this consolidation. | Backend | `lib/financialReports.ts` + 3 consumers | ⬜ |
| 0.4 | **Delete `/api/messages/route.ts`** (legacy announcement POST alias, unused by dashboard). Grep first to confirm no consumers. | Backend | delete file | ⬜ |
| 0.5 | **Verify hand-write migration path works from the current sandbox** — check that `.env` `DATABASE_URL` + `DIRECT_URL` + Supabase MCP creds are current. This session-start check saves 30 min per attempted migration. | Ops | none (verify) | ⬜ |
| 0.6 | **Reports design handoff — request from owner** | Product | — | 🔵 (blocks Phase 2) |
| 0.7 | **Owner sign-off on §2.6 open questions** — status treatment, profile structure, person-type labels, coach-audience definition, approval workflow default, refund UI shape, transfer eligibility, confirmation-page race behavior | Product | — | ⬜ |

**Exit criteria for Phase 0:** `serializeMemberForList` shipped; one PnL implementation; one payment vocab; legacy dead code removed; owner has answered the open questions or explicitly deferred them.

---

## Phase 1 — Owner Financials

**Goal (plan §1):** owner sees exactly where every dollar came from and went, on any device, without mentally untangling Stripe from cash from bank activity.

### 1A. Separate Stripe and Cash/Offline

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 1A.1 | `GET /api/transactions` — add `?paymentSource=STRIPE,CASH,…` filter (respected in aggregates); today the route returns all rows. | Backend | — | ⬜ |
| 1A.2 | **Stripe tab** — filter `paymentSource=STRIPE`, rename totals to reflect Stripe-only. | UI | — | ⬜ |
| 1A.3 | **Cash & Offline tab** — new tab beside Stripe, filter `paymentSource ∈ {CASH,CHECK,EXTERNAL_READER,COMP,MANUAL_ADJUSTMENT}`. Columns per plan: Date · Payer · Athlete · Item · Method · Amount · Staff (recorded by) · Notes · Receipt status · Refund/reversal. | UI + Backend | needs M1/M2/M3/M4 | ⬜ |
| 1A.4 | **M1** — `Transaction.recordedByUserId TEXT?` migration + backfill null + stamp on every non-Stripe write site (`/api/financials/manual-payment`, `/api/attendance/charge`, cash/check receipt flow). Historical rows stay null (displayed as "—"). | Backend + Migration | M1 | ⬜ |
| 1A.5 | **M2** — `Transaction.athleteMemberId TEXT?` migration. Reads: existing `memberId` = payer/beneficiary as today; `athleteMemberId` populated when guardian pays for child. Backfill dry-run: match rows where `Member.responsiblePayerUserId` resolves to a different User with a Member row in same club — populate best-effort, else leave null. | Backend + Migration | M2 | ⬜ |
| 1A.6 | **M3** — refund fields (`refundedAmount`, `refundedAt`, `refundReason`, `refundedByUserId`). Backfill: `reconciliationStatus=VOID` → `refundedAt = updatedAt`, `refundReason = 'reconciled_void'`. No Stripe API refund call yet (deferred to Phase 6 or later — see §2.6 Q4). | Backend + Migration | M3 | ⬜ |
| 1A.7 | **M4** — `Transaction.receiptUrl TEXT?` + `receiptSentAt TIMESTAMPTZ?`. Wire to receipt-resend action in the row menu. | Backend + Migration | M4 | ⬜ |
| 1A.8 | **Cash-and-offline row menu** — record refund (marks flag; no Stripe call), resend receipt (uses existing receipt template), edit notes, delete manual (existing safety: never delete Stripe rows). | UI | — | ⬜ |
| 1A.9 | Regression test: SUCCEEDED cash rows don't leak into Stripe tab; Stripe tab still shows `stripeFeeAmount/netAmount` correctly. | Testing | — | ⬜ |

### 1B. Bank Transaction Date Filters

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 1B.1 | **Diagnose confirmed**: `/api/plaid/transactions:68-71` hardcodes `thirtyDaysAgo`. No persistence. `count:50` cap. | ✅ (§2.1 findings) | — | 🟢 |
| 1B.2 | **M5** — `PlaidTransaction` model + `PlaidSyncCursor` model. Fields: `clubId, plaidConnectionId, plaidTransactionId (unique), accountId, amount, date, name, merchantName?, category (Json array), pendingBool, isoCurrencyCode, paymentChannel?, personalFinanceCategoryPrimary?, personalFinanceCategoryDetailed?, categorizedExpenseId? (FK to Expense, nullable), reviewedAt?, reviewedByUserId?, syncedAt`. | Backend + Migration | M5 | ⬜ |
| 1B.3 | **Sync worker** — `/api/plaid/sync` route (owner + `finances:full`) calls `transactionsSync` for one connection, writes/updates `PlaidTransaction`, advances `PlaidSyncCursor`. Later: nightly cron. | Backend | — | ⬜ |
| 1B.4 | Rewrite `GET /api/plaid/transactions` to query `PlaidTransaction` + accept `?range=30|60|90|ytd|all|custom&from=&to=&connectionId=`. Include pagination. Return `{earliestAvailableDate, count, transactions[]}`. | Backend | — | ⬜ |
| 1B.5 | **Bank tab UI** — date-range preset row (30/60/90/YTD/All/Custom), infinite scroll or paginated table, "Earliest available: <date>" note. Per-tab connection filter. | UI | — | ⬜ |
| 1B.6 | Backfill: on first `sync` for each existing connection, page through all Plaid history — use safety limits (max 2y default; owner-configurable). Populate `PlaidSyncCursor.lastSyncedAt`. | Backend | — | ⬜ |

### 1C. Money Out and Expense Matching

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 1C.1 | **M6** — `Expense` gains `reviewedAt`, `reviewedByUserId`, `excludedFromTax BOOL default false`, `taxCategory TEXT?`, `splits Json?`. | Backend + Migration | M6 | ⬜ |
| 1C.2 | **M7** — `TransactionCategoryRule` model (per-club, `matchType: VENDOR_EXACT|VENDOR_CONTAINS|DESCRIPTION_CONTAINS|AMOUNT_EQUALS|AMOUNT_RANGE`, `category`, `active`). Applied on new PlaidTransaction rows and on user "Apply rule to similar" action. | Backend + Migration | M7 | ⬜ |
| 1C.3 | `POST /api/plaid/expenses/match` — accept `{plaidTransactionId, expenseId | createExpense: {…}, splits?}`. Enforces one-match-per-plaid-row, or split with sum-must-equal-plaid-amount validation. | Backend | — | ⬜ |
| 1C.4 | **Money Out matching UI** — per PlaidTransaction row: status pill (Needs Review · Suggested Match · Matched · Categorized · Excluded · Duplicate · Transfer), inline category picker with rule-remember toggle, split modal, "Match to expense…" search, "Match to payroll" list (from `computePayrollTotalForRange`), "Mark as transfer between accounts", "Exclude from tax". | UI | — | ⬜ |
| 1C.5 | **Never auto-finalize**: every matched suggestion requires user click. Server rejects `status=Matched` unless a review-attributable user id is present. | Backend | — | ⬜ |
| 1C.6 | Suggested-match algorithm: amount ± $0.01, date ± 3 days, vendor-name substring on Expense.vendor or Payroll.staff — surface top 3 candidates. | Backend | — | ⬜ |

### 1D. Tax Summary (bank-based)

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 1D.1 | New `TaxSummary` service in `lib/financialReports.ts`. Income = Stripe deposits (from `PlaidTransaction` where category is bank credit/ACH matched by dollar amount to Stripe payouts) + non-Stripe credits + cash rows the owner explicitly categorized as cash income. Expenses = categorized outgoing PlaidTransactions minus transfers minus excluded minus owner-draws. | Backend | — | ⬜ |
| 1D.2 | UI shows: Gross income, Refunds, Processing fees, Net income, Categorized expenses, Uncategorized transactions, Transfers, Excluded transactions, Cash income (recorded), Estimated taxable profit. + Disclaimer: "organizational summary, not tax advice." | UI | — | ⬜ |
| 1D.3 | Owner-draw and loan-deposit exclusion categories added to `TransactionCategoryRule` catalog. | Backend | — | ⬜ |
| 1D.4 | Verify no double-count: a Stripe charge that produces a Transaction AND a Plaid payout deposit must count once (via Transaction; the Plaid payout row is auto-linked and excluded from income). | Testing | — | ⬜ |

### 1E. Mobile and Tablet

| # | Task | Class | Status |
|---|---|---|---|
| 1E.1 | Financials page: at `<md` swap tables for card layout (per row: date/amount top; payer/method mid; actions in bottom-sheet kebab). | UI | ⬜ |
| 1E.2 | Sticky page-level filters that collapse to a compact chip row + "Filters" button on mobile. | UI | ⬜ |
| 1E.3 | Row action menu → bottom-sheet on `<md` (existing pattern from earlier P1.H/2D work). | UI | ⬜ |
| 1E.4 | Test all 7 tabs at 375 · 768 · 1024 · 1440. | Testing | ⬜ |

**Phase 1 exit criteria:** cash/offline split verified; Plaid persistent + all-time range works; matching produces owner-attributable rows only; Tax Summary reconciles Stripe income once; mobile layouts pass at each tested breakpoint.

---

## Phase 2 — Reports

**Status: BLOCKED on missing Reports design handoff (§0.6). Task planning below is preliminary.**

| # | Task | Class | Status |
|---|---|---|---|
| 2.0 | Receive Reports design handoff; add owner-approved report list to this section. | Product | 🔵 |
| 2.1 | Remove hardcoded 12-month cap on revenue chart (`/api/reports/overview:145`) — respect the selected range; "All time" builds a range from first Transaction. | Backend | ⬜ |
| 2.2 | All-time member counts including inactive/deleted (opt-in filter, default active). | Backend + UI | ⬜ |
| 2.3 | All-time subscription history including canceled/expired. | Backend + UI | ⬜ |
| 2.4 | Pagination/incremental loading for large ranges (avoid one big JSON payload). | Backend + UI | ⬜ |
| 2.5 | Additional export formats + saved views (from design handoff). | UI + Backend | ⬜ |
| 2.6 | Performance: verify query plans on `Transaction(clubId, txDate)` and `Member(clubId, joinedAt)` — add indexes if needed. | Backend | ⬜ |
| 2.7 | Mobile pass. | UI | ⬜ |

**Status: closed 2026-07-28.** Full 8-tab redesign moved to Phase 2.5.

---

## Phase 2.5 — Reports Full Design Handoff

**Source of truth:** `docs/improvement/design_handoff_reports/`. See `plan.md` §Phase 2.5 for complete acceptance criteria per sub-phase.

**Owner-approved adjustments (2026-07-29):** (A) owner-first Snapshot answers 5 concrete questions; SaaS metrics (MRR/ARR/ARPA/ARPM/CAC/LTV) move to secondary positions on Revenue tab + Unit economics tab. (B) Mobile is a per-sub-phase requirement, not a final polish sub-phase. (C) New sub-phase 2.5.1a — Action Items feed on Snapshot.

**Non-negotiable regression guard**: `/dashboard/financials` must render byte-identical before and after this phase. Snapshot-test in 2.5.13.

### 2.5.1 Shell + extended range + reliability strip + owner-first Snapshot

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 2.5.1.1 | Eight-tab hub scaffold (`Snapshot · Revenue · Costs · P&L · Membership · Unit economics · Cash flow · History & imports`) with horizontal-scroll tab bar + active-scroll-into-view. | UI | — | ⬜ |
| 2.5.1.2 | Extended range dropdown: `this_week, last_week, month, last_month, qtd, ytd, year, all, before_athletix, since_athletix, custom`. Weeks Mon–Sun in club timezone. | UI + Backend | — | ⬜ |
| 2.5.1.3 | Every API response carries `range: { key, label, start, end, isPartialPeriod, partialNote, comparison }`. | Backend | — | ⬜ |
| 2.5.1.4 | `GET /api/reports/reliability` — cached ~60s, 8 states per spec 03. Every `href` deep-links to the exact fix. | Backend | — | ⬜ |
| 2.5.1.5 | `GET /api/reports/snapshot` returns the **owner-first** shape: `didIMakeMoney`, `whoOwesMe`, `membershipsGrowing`, `revenueDrivers`, plus `cash`, `runway`, `trend`, `burnBasis`, `reliability`. SaaS metrics NOT included here (they're on 2.5.2 + 2.5.6). | Backend | — | ⬜ |
| 2.5.1.6 | Snapshot tab UI, owner-first ordering top-to-bottom: reliability strip → Action Items (2.5.1a) → "Did I make money?" card → "Who owes me money?" card → "Which memberships are growing?" card → "Which coaches/classes are driving revenue?" card → Cash on hand card → Money-in-vs-money-out chart → "Where these numbers come from" grid. | UI | — | ⬜ |
| 2.5.1.7 | **M9 + M9a** — `Club.wentLiveAt DateTime?` + `ActionItemSnooze` in one migration file. | Migration | M9 + M9a | ⬜ |
| 2.5.1.8 | Mobile responsive: cards stack 1→2 col, plain-English headline wraps at 375px, breakdown chips wrap, 44×44 targets, reliability strip never collapses. | UI | — | ⬜ |

### 2.5.1a Action Items feed on Snapshot (owner-approved 2026-07-29)

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 2.5.1a.1 | `GET /api/reports/action-items` returns `{ items[], counts: {high, medium, low}, generatedAt }`. Each item: `{id, kind, severity, title, detail, count, amount, href, action}`. | Backend | — | ⬜ |
| 2.5.1a.2 | MVP action kinds: `FAILED_PAYMENT`, `EXPIRING_MEMBERSHIP`, `UPCOMING_RENEWAL_LARGE`, `UNRECONCILED_DEPOSIT`, `OFFLINE_PAYMENT_PENDING`, `UNCATEGORIZED_LARGE_BANK`, `HISTORICAL_IMPORT_REVIEW`, `PAYMENT_METHOD_EXPIRING`. | Backend | — | ⬜ |
| 2.5.1a.3 | Items ordered: high severity first, then by amount desc. Permission-gated on both client and server. | Backend | — | ⬜ |
| 2.5.1a.4 | `components/reports/ActionItems.tsx` — one card per item (severity dot + title + detail + count/amount + primary action + `⋯` dismiss/snooze). Filter chips at top: All / High / Medium / Low. Empty state: lime tile "Nothing needs your attention today." | UI | — | ⬜ |
| 2.5.1a.5 | Snooze writes to `ActionItemSnooze` (bundled with M9). Dismissed items disappear until `snoozedUntil`. | Backend + UI | (in M9) | ⬜ |
| 2.5.1a.6 | Mobile: cards render full-width, severity dot + title + detail stacked, action button at 44px height; filter chips horizontally scroll; snooze/dismiss `⋯` opens bottom sheet with 44px rows. | UI | — | ⬜ |

### 2.5.2 Revenue tab (owner-first: primary = mix, top items, top coaches, top classes; SaaS metrics secondary)

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 2.5.2.1 | `GET /api/reports/revenue` returns `{ range, total, primary: {byItem, byCoach, byLocation, bySource, mix}, recurring: {MRR/ARR/ARPA/ARPM/...}, variable }`. Primary block on top. | Backend | — | ⬜ |
| 2.5.2.2 | MRR excludes past_due + pending; forward-looking (not period revenue). | Backend | — | ⬜ |
| 2.5.2.3 | Upgrade/downgrade detection: normalized monthly comparison; equal = neither. | Backend | — | ⬜ |
| 2.5.2.4 | Revenue tab UI, owner-first order: mix bar → top by item → top by coach + top by class side-by-side → source chips → collapsible "Recurring revenue metrics" (SaaS block). | UI | — | ⬜ |
| 2.5.2.5 | Mobile: mix bar stacked labels at `<sm`; coach + class cards stack; source chips wrap; recurring section 2-up KPI grid at `<md`; drill-through opens full-screen sheet. | UI | — | ⬜ |

### 2.5.3 Costs tab + fixed/variable override

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 2.5.3.1 | `GET /api/reports/costs` per spec 02 §costs. | Backend | — | ⬜ |
| 2.5.3.2 | Unusual-increase rule: current ≥ 1.5× 3-period average AND diff ≥ $250 (both). | Backend | — | ⬜ |
| 2.5.3.3 | `PATCH /api/reports/costs/classification` — owner-only. | Backend | — | ⬜ |
| 2.5.3.4 | **M10** — `ExpenseClassificationOverride` model. | Migration | M10 | ⬜ |
| 2.5.3.5 | Costs tab UI: split bar, metric cards + category chip lists, override prompt, top-categories table with delta column, top-vendors + largest-single-expense cards, "Needs a look" 6-card grid. | UI | — | ⬜ |
| 2.5.3.6 | Mobile: split bar full-width; top-categories horizontal-scroll with sticky first col; top-vendors + largest-expenses stack; "Needs a look" 2×3 at `sm` / 1×6 at `<sm`; override tap targets ≥44×44. | UI | — | ⬜ |

### 2.5.4 P&L + drill-through + CSV/PDF (the most-requested behavior)

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 2.5.4.1 | `GET /api/reports/pnl` per spec 02 §pnl (monthly + weekly, cash + accrual). | Backend | — | ⬜ |
| 2.5.4.2 | Accrual daily proration; purchases without span fall back to cash with `unsupportedPurchaseCount`. | Backend | — | ⬜ |
| 2.5.4.3 | 4-week rolling average excludes partial columns. | Backend | — | ⬜ |
| 2.5.4.4 | **`GET /api/reports/pnl/drill`** — every P&L / Costs / Revenue figure links here. Full-screen sheet on mobile. | Backend + UI | — | ⬜ |
| 2.5.4.5 | `GET /api/reports/pnl/export?format=csv` (reuse `reportToCsv`) + `?format=pdf` (new; ship in this sub-phase, not deferred). | Backend | — | ⬜ |
| 2.5.4.6 | UI: monthly table (6 columns per design) + weekly table with partial-week warning, segmented Cash/Accrual + Monthly/Weekly controls, CSV+PDF export buttons. | UI | — | ⬜ |
| 2.5.4.7 | Mobile: P&L table stacked card layout at `<sm`, horizontal scroll with sticky first col at `sm+`. Controls wrap under header at `<md`. Drill-through opens full-screen sheet with virtualized list + CSV export. Export buttons ≥44×44. | UI | — | ⬜ |

### 2.5.5 Membership tab

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 2.5.5.1 | `GET /api/reports/membership` per spec 02 §membership: movement, rates, formula (server-authored), trend, breakdown, notes. | Backend | — | ⬜ |
| 2.5.5.2 | Churn rule: lost ÷ starting active; 14-day grace window (named constant). Plan changes, scheduled pauses, no-gap moves, next-season-renewal all excluded. | Backend | — | ⬜ |
| 2.5.5.3 | Until Phase 4.5.10 lands `MemberSubscriptionEvent`, return `reliability: "ESTIMATED"` on affected fields. Never fabricate. | Backend | — | ⬜ |
| 2.5.5.4 | UI: 4 KPI cards, movement card, churn breakdown pills + formula card, churn trend chart, breakdown table. | UI | — | ⬜ |
| 2.5.5.5 | `groupBy=coach` returns 403 without `reports.by_coach`; `null` for clubs without coach-on-membership assignment. | Backend | — | ⬜ |
| 2.5.5.6 | Mobile: movement card 1-col at `<md`; breakdown pills horizontal scroll; trend chart 6-month + "show all" toggle at `<sm`; formula rule-line renders vertically at `<sm`. | UI | — | ⬜ |

### 2.5.6 Unit economics tab

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 2.5.6.1 | `GET /api/reports/unit-economics` per spec 02 §unit-economics. | Backend | — | ⬜ |
| 2.5.6.2 | Non-positive contribution margin returns `null` + message (never divides by negative). | Backend | — | ⬜ |
| 2.5.6.3 | CAC/LTV return `null` when inputs missing; caveats array populated. | Backend | — | ⬜ |
| 2.5.6.4 | UI: 4 per-athlete KPI cards, break-even card (34px number + progress bar + formula block), margins + acquisition card with Estimated badge. | UI | — | ⬜ |
| 2.5.6.5 | Mobile: KPI 2×2 at `<md` / 4-across at `md+`; break-even 34px number wraps at `<sm`; formula block vertical at `<sm`. | UI | — | ⬜ |

### 2.5.7 Cash flow + PayoutMatch

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 2.5.7.1 | `GET /api/reports/cash-flow` per spec 02 §cash-flow. | Backend | — | ⬜ |
| 2.5.7.2 | **M11** — `PayoutMatch` model. | Migration | M11 | ⬜ |
| 2.5.7.3 | Match algorithm: ±$0.01, ±5 days from `arrival_date`, description contains descriptor. 10-day unmatched → reliability warning. | Backend | — | ⬜ |
| 2.5.7.4 | Transfer detection: matched debit+credit within 3 days across two connected accounts of same club. | Backend | — | ⬜ |
| 2.5.7.5 | Forecast returns `null` when <3 complete months of history. | Backend | — | ⬜ |
| 2.5.7.6 | UI: 5-column waterfall, grouped table (Operating / Investing / Financing / Excluded), forecast card, alerts card. | UI | — | ⬜ |
| 2.5.7.7 | Mobile: waterfall horizontal-scrolls with legend fixed at top; grouped table horizontal scroll with sticky first col; forecast + alerts full-width. | UI | — | ⬜ |

### 2.5.8 Alerts + settings

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 2.5.8.1 | **M12** — `ReportAlertSetting` model. Seed defaults on existing clubs (BF-7). | Migration + Backfill | M12 | ⬜ |
| 2.5.8.2 | `GET /api/reports/alerts` + `PUT /api/reports/alerts/settings`. Owner-only. Reuse `NotificationBell` severity/color. | Backend | — | ⬜ |
| 2.5.8.3 | Alert kinds: `RUNWAY_BELOW, EXPENSES_EXCEED_REVENUE, CHURN_SPIKE, UNCATEGORIZED_COUNT, BANK_SYNC_STALE, REFUND_RATE, RECURRING_REVENUE_DECLINE, PAYROLL_ABOVE_AVERAGE`. Adds Action-Items thresholds `UPCOMING_RENEWAL_LARGE`, `UNCATEGORIZED_LARGE_BANK` — settings surface used by 2.5.1a. | Backend | — | ⬜ |
| 2.5.8.4 | Mobile: alerts list 1-column; threshold settings drawer opens as bottom sheet; toggle tap targets ≥44×44. | UI | — | ⬜ |

### 2.5.9 Historical import schema + Member/Transaction field additions

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 2.5.9.1 | **M13** — `ImportBatch` + `ImportRow` + `MemberHistoricalRecord` models + enums (`ImportKind`, `ImportStatus`, `ImportOutcome`, `MatchSignal`, `Confidence`). Includes `ImportBatch.sourceLabel` (owner-typed). | Migration | M13 | ⬜ |
| 2.5.9.2 | **M14** — `Member` field additions: `externalMemberId, sourceSystem, importBatchId, isHistoricalOnly, normalizedEmail, normalizedPhone` + indexes. | Migration | M14 | ⬜ |
| 2.5.9.3 | **M15** — `Transaction` field additions: `externalTransactionId (@@unique with sourceSystem), externalCustomerId, sourceSystem, importBatchId, isHistorical, dedupeHash (unique per club)`. | Migration | M15 | ⬜ |
| 2.5.9.4 | **BF-1/BF-2/BF-3** — sourceSystem, normalized email/phone, transaction-source derivation. Dry-run first with per-club report; allowlist `--apply`. | Backfill | — | ⬜ |
| 2.5.9.5 | RLS policies for the three new tables in `web/rls/`. | Backend | — | ⬜ |

### 2.5.10 Import wizard (7 steps)

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 2.5.10.1 | Route `/dashboard/reports/imports/[batchId]` with step rail sidebar. | UI | — | ⬜ |
| 2.5.10.2 | Step 1 (Upload): CSV up to 20 MB / 50k rows, sha256 warning on re-upload, source-system radio + owner-typed source label, template download. | UI + Backend | — | ⬜ |
| 2.5.10.3 | Step 2 (Match columns): auto-map by alias, date-format detector, statuses per column. | UI + Backend | — | ⬜ |
| 2.5.10.4 | Step 3 (Check for problems): errors bucket vs warnings bucket, errors.csv download. | UI + Backend | — | ⬜ |
| 2.5.10.5 | Step 4 (Preview): first 50 rows exactly as they will be stored, outcome badges. | UI + Backend | — | ⬜ |
| 2.5.10.6 | Step 5 (Review matches): matching-signal priority per spec 04, five outcomes, bulk actions ("Keep all separate" / "Ignore all"; NO bulk merge). | UI + Backend | — | ⬜ |
| 2.5.10.7 | Step 6 (Confirm): async commit for >2000 rows (202 + jobId + poll), chunked 500 per tx, merge semantics per spec 04. | Backend | — | ⬜ |
| 2.5.10.8 | Step 7 (Done): permanent audit log with row filters + CSV export. | UI + Backend | — | ⬜ |
| 2.5.10.9 | Rollback endpoint: owner-only, 30-day window, converts to `isHistoricalOnly` when rows have activity. | Backend | — | ⬜ |
| 2.5.10.10 | All 12 endpoint contracts from spec 02 §imports. | Backend | — | ⬜ |
| 2.5.10.11 | Assertion test: imported members trigger NO email/invite/billing/campaign. | Testing | — | ⬜ |
| 2.5.10.12 | Mobile: step rail horizontal-scroll with active step centered; dropzone fill-width; column-mapping horizontal scroll with sticky first col; error groups collapse into cards; review-match panels stack; footer nav sticky-bottom with safe-area inset. | UI | — | ⬜ |

### 2.5.11 Granular permissions

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 2.5.11.1 | Ten permission keys nested under `reports.*` (JSON blob, no schema change). | Backend | — | ⬜ |
| 2.5.11.2 | Server-side enforcement per endpoint per spec 05. | Backend | — | ⬜ |
| 2.5.11.3 | Partial responses over 403s: null lines + `restricted: []` array + null-out affected totals. | Backend | — | ⬜ |
| 2.5.11.4 | Client hides tabs via `canAccessPath`; tier gate stays and runs first. | UI | — | ⬜ |

### 2.5.12 Mobile + responsive polish

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 2.5.12.1 | Horizontal-scroll tab bar with sticky-into-view; never collapses to `<select>`. | UI | — | ⬜ |
| 2.5.12.2 | KPI cards 4→2→1; two-column pairs stack in read order. | UI | — | ⬜ |
| 2.5.12.3 | Every wide table: sticky first column + `-webkit-overflow-scrolling: touch` + right-edge fade shadow. | UI | — | ⬜ |
| 2.5.12.4 | P&L below `sm`: stacked card layout. | UI | — | ⬜ |
| 2.5.12.5 | Drill-through on mobile is full-screen sheet, not popover. | UI | — | ⬜ |
| 2.5.12.6 | 12-month chart below `sm`: last 6 months + "show all" toggle. | UI | — | ⬜ |
| 2.5.12.7 | Range dropdown: bottom sheet on mobile, 44px minimum row height. | UI | — | ⬜ |
| 2.5.12.8 | Reliability + alert strips never collapsed on small screens. | UI | — | ⬜ |
| 2.5.12.9 | Every interactive target ≥ 44×44 on touch. | UI | — | ⬜ |
| 2.5.12.10 | No horizontal page scroll at 375, 414, 768 px. | UI | — | ⬜ |

### 2.5.13 Test suite (spec 06 — every case)

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 2.5.13.1 | P&L calculations (9 cases). | Testing | — | ⬜ |
| 2.5.13.2 | Partial periods (6 cases). | Testing | — | ⬜ |
| 2.5.13.3 | Stripe fees + payouts (7 cases). | Testing | — | ⬜ |
| 2.5.13.4 | Refunds (4 cases). | Testing | — | ⬜ |
| 2.5.13.5 | Bank transfers + equity (7 cases). | Testing | — | ⬜ |
| 2.5.13.6 | Cash + offline (3 cases). | Testing | — | ⬜ |
| 2.5.13.7 | Churn (12 cases). | Testing | — | ⬜ |
| 2.5.13.8 | Imports (21 cases). | Testing | — | ⬜ |
| 2.5.13.9 | Fixed vs variable (5 cases). | Testing | — | ⬜ |
| 2.5.13.10 | Break-even + unit economics (7 cases). | Testing | — | ⬜ |
| 2.5.13.11 | Permissions (6 cases). | Testing | — | ⬜ |
| 2.5.13.12 | Missing/incomplete data (7 cases). | Testing | — | ⬜ |
| 2.5.13.13 | Mobile (9 cases). | Testing | — | ⬜ |
| 2.5.13.14 | Regression guard: `/dashboard/financials` byte-identical. | Testing | — | ⬜ |

**Phase 2.5 exit criteria:** every 2.5.x acceptance criterion ✅; migrations M9–M15 applied; `/dashboard/financials` regression clean; owner sign-off on `Reports` handoff `Open decisions`.

---

## Phase 3 — Communications & Email

### 3.1 Foundations

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 3.1.1 | **Sub-scope permissions** — nest under `messages` JSON: `messages.bulk`, `messages.marketing`, `messages.approve`, `messages.templates`, `messages.images`, `messages.unsubscribe`, `messages.analytics`. Legacy `messages: "send"` maps to `messages.bulk: false, messages.marketing: false, …`. `hasPermission(perms, key, level, subScope?)`. | Backend | — | ⬜ |
| 3.1.2 | **`lib/sendClubEmail.ts`** — single entrypoint for every email send. Params: `{clubId, kind, recipientUserId?, recipientEmail, subject, bodyHtml, personalization, headers, replyTo, from, opts}`. Applies: `EmailOptOut` check (marketing kinds only), `List-Unsubscribe` header, personalization interpolation, sanitize, write `EmailSend` row, dispatch. Retro-fit every existing `sendXxx` in `lib/email.ts` to call through it. | Backend | — | ⬜ |
| 3.1.3 | **M12** — `EmailSend` per-recipient log model. | Migration | M12 | ⬜ |
| 3.1.4 | **M13** — `Announcement.status` enum + `bodyHtml TEXT?` + `senderUserId` + approval fields. Backfill: `publishAt < now` → `SENT`, else `DRAFT`. Legacy `body` stays populated. | Migration | M13 | ⬜ |
| 3.1.5 | **M14** — `EmailOptOut.userId TEXT?` + `scope enum default MARKETING`. Backfill scope for every row to `MARKETING`. | Migration | M14 | ⬜ |
| 3.1.6 | **`/api/cron/email-queue`** worker — pulls QUEUED `EmailSend` rows, dispatches via `sendClubEmail`, updates status. `CRON_SECRET`-gated. Manual "Send now" also enqueues + inline drains for immediate delivery. | Backend | — | ⬜ |
| 3.1.7 | **M11** — `EmailImage` model **or** open-read variant of `UploadedFile` (public token URL). Pick after §2.6 Q7. | Migration | M11 | ⬜ |

### 3.2 Rich Composer + Templates + Audiences

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 3.2.1 | Rich text editor in `components/EmailComposer.tsx` — content blocks per plan §3B. Reuse existing tiptap or lexical (audit whichever is already in the dep set; add if none). | UI | — | ⬜ |
| 3.2.2 | Store composer output as `bodyHtml` (sanitized) + auto-derived `bodyText` fallback. | Backend | — | ⬜ |
| 3.2.3 | **M9** — `EmailTemplate` model. Seed 14 stock templates per plan §3C. Owner can duplicate/edit/archive. | Migration + UI | M9 | ⬜ |
| 3.2.4 | **M10** — `MarketingAudience` (filters Json, isDynamic bool). Audience-builder UI lifts `/api/messages/audience` filter shape into a first-class control. Estimated-recipient-count updates as filters change. "Save as reusable" writes an audience row. | Migration + UI | M10 | ⬜ |
| 3.2.5 | Personalization tokens — `{{member_first_name}}, {{guardian_first_name}}, {{membership_end_date}}, …`. Preview-as-recipient endpoint. Warn on missing values pre-send. | Backend + UI | — | ⬜ |

### 3.3 Bulk email from Members page (plan §3A)

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 3.3.1 | Extend `POST /api/members/bulk` with `action: "email"` — payload `{templateId? subject bodyHtml personalization audienceOverride?}`. Uses the same queue path. | Backend | — | ⬜ |
| 3.3.2 | Members page: existing selection UI (`selectedIds`, `selectAllProspects`) — add "Email selected" primary action with pre-send count review: profiles / unique addresses / no-email skipped / duplicates / opt-outs. | UI | — | ⬜ |
| 3.3.3 | Household delivery mode chooser (one-per-household · one-per-selected-member · one-per-athlete-primary-contact). | UI + Backend | — | ⬜ |

### 3.4 Family-aware targeting (plan §3E)

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 3.4.1 | Sender picks: athlete / primary guardian / all authorized guardians / payer / account holder / all linked / one per household / every selected profile. Server resolves via `guardianLinks` (reciprocal). | Backend | — | ⬜ |
| 3.4.2 | Minor default: guardian, unless club setting overrides + permission granted. | Backend + UI | — | ⬜ |
| 3.4.3 | UI shows resolved recipient email per selected member on the review screen. | UI | — | ⬜ |

### 3.5 History, drafts, schedule, approval

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 3.5.1 | Member profile "Communications" tab renders `EmailSend` rows for this member: subject · sent · sender · address · delivery status · opened · clicked · bounced · unsubscribed · related campaign / event / membership · message preview. Resend / send-new / copy actions. Never claim "opened" when tracking is unavailable. | UI + Backend | — | ⬜ |
| 3.5.2 | Announcement lifecycle routes (`schedule`, `send`, `cancel`, `approve`). Scheduled uses club timezone (`Club.timezone`). | Backend | — | ⬜ |
| 3.5.3 | Idempotency-key on `send` to prevent duplicate campaigns from refresh / job restart / repeated clicks. `EmailSend @@unique([announcementId, recipient])` when announcementId is set. | Backend + Migration | index | ⬜ |
| 3.5.4 | Approval workflow — draft → request approval → owner approves → sends. Gated on `messages.approve`. | Backend + UI | — | ⬜ |

### 3.6 Unsubscribe scope, attachments, safeguards, permissions, mobile, testing

Each of the remaining plan sub-sections (3I / 3J / 3K / 3L / 3M / 3N) becomes one task each with acceptance criteria drawn directly from the plan. Not enumerated line-by-line here — see plan for the concrete checklist.

**Phase 3 exit criteria (per plan §3N "Document at end of this phase"):** email provider + sending flow doc'd · schema changes listed · background jobs added · tracking limitations noted · file-upload limitations · new permissions · env vars · manual test steps · deployment order · rollback plan.

---

## Phase 4 — Client & Family Accounts

### 4A. Membership transfer to linked family (Michael → Kellen)

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 4A.1 | **M15** — `MemberSubscription.payerUserId TEXT?`. Reads fall back to `Member.responsiblePayerUserId` when null. | Migration | M15 | ⬜ |
| 4A.2 | `POST /api/member-subscriptions/[id]/transfer` — actors: owner (any sub) OR authorized guardian (subs on members in their `guardianOf`). Body: `{targetMemberId, reason?}`. Preview mode returns diff. Confirm mode: writes `BillingAuditLog`, sets `MemberSubscription.memberId = target`, keeps `payerUserId` unchanged. **Refuses live Stripe subs by default** unless caller is Owner AND passes `acknowledgeStripeBillingUnchanged: true`. | Backend | — | ⬜ |
| 4A.3 | Eligibility rules (from §2.6 Q5, owner-answered): "unused" definition. Draft: no attendance recorded, no session redeemed, not past commitment. | Backend | — | ⬜ |
| 4A.4 | **UI (owner)**: profile Memberships tab → per-sub "Assign to another family member" button. Opens transfer modal (current owner, eligible family members from `guardianOf` + `MemberRelationship`, explanation of what stays with payer, confirm). | UI | — | ⬜ |
| 4A.5 | **UI (client)**: `/member/family/[memberId]` — "Move this membership" action visible to the account-holder guardian. Same eligibility rules. | UI | — | ⬜ |
| 4A.6 | Post-transfer state: original Transaction/receipt preserved unchanged; membership beneficiary is new athlete; payer stays the same. | Regression test | — | ⬜ |

### 4B. Same-email family onboarding (Cameron case)

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 4B.1 | **Extend `GET /api/members/[id]` include** — add `guardianLinks: { include: { user: true } }` and `user: { include: { guardianOf: { include: { member: true } } } }`. | Backend | — | ⬜ |
| 4B.2 | **Family & access card** on `app/dashboard/members/[id]/page.tsx` — renders guardians (from `guardianLinks`), managed athletes (from `user.guardianOf`), and legacy `MemberRelationship`. Includes pending links (from `PendingApproval` kind `GUARDIAN_LINK`). | UI | — | ⬜ |
| 4B.3 | Verify member portal already renders reciprocal (`/api/member/portal:82-123`) — no change expected. | Testing | — | ⬜ |
| 4B.4 | Fix any stale-cache issue where a newly-linked child doesn't appear until re-login: audit `/api/member/portal` caching, `useSWR` config, and preview cookie behavior. | Backend + UI | — | ⬜ |
| 4B.5 | Regression: multiple children under one guardian email each keep separate Member rows, separate memberships, separate attendance, separate waivers. | Testing | — | ⬜ |

### 4C. Relationship visibility and permissions

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 4C.1 | **M16** — `MemberGuardianUser.permissions Json?` (Book/Pay/Waivers/Messages) OR separate `GuardianAccess` table per §2.6 Q10. | Migration | M16 | ⬜ |
| 4C.2 | Family & access section renders per-relationship: name · avatar · type · manages? · book? · pay? · waivers? · messages? · notifications? · status · date-linked. | UI | — | ⬜ |
| 4C.3 | Actions: View Profile · Edit Relationship · Confirm Pending · Remove · Transfer Management · Assign Membership · Book for Athlete. Each gated by staff permission. | UI + Backend | — | ⬜ |
| 4C.4 | Guardian-editable grid on `/member/family/[memberId]` (parent side) mirrors owner view (subject to the primary-guardian rule from CLAUDE.md). | UI | — | ⬜ |

### 4D. Testing (plan §4D)

| # | Task | Class | Status |
|---|---|---|---|
| 4D.1 | Fixture-based test suite: parent+one child · parent+multi-child same email · child linked after onboarding · child linked before · membership purchased by parent + assigned to child · staff-transfer · client-transfer · relationship removed · duplicate relationship attempt · reciprocal visibility · guardian permissions · staff permissions · unused-vs-used transfer. Extend `scripts/billing-admin-tests.ts` pattern. | Testing | ⬜ |

**Note:** Phase 4B's `guardianLinks` include fix + Phase 4C's per-permission grid land here in Phase 4 for the base data model. The redesigned Family & access surface (4.5.6) reads them.

---

## Phase 4.5 — Members Full Design Handoff

**Source of truth:** `docs/improvement/design_handoff_members_experience/` (`README.md`, `Members Experience Redesign.dc.html` sections `1a`–`1k`). See `plan.md` §Phase 4.5 for complete acceptance criteria per sub-phase.

**Core problem:** one vocabulary was doing three jobs. Split into 3 tracks, `nextAction(member)` next to every person, imports source label owner-typed.

**Owner-approved adjustment (2026-07-29):** every 4.5.x sub-phase has explicit mobile acceptance criteria. Sub-phase 4.5.9 remains the cross-cutting audit + Capacitor shell regression, not the first attention to mobile.

**Dependency reminder:** 4.5.10's `MemberSubscriptionEvent` (M22) closes Phase 2.5.5's ESTIMATED churn caveat. Reports Membership tab flips to COMPLETE reliability after 4.5.10 backfill.

### 4.5.1 Status model + `nextAction` resolver

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 4.5.1.1 | `lib/memberDisplay.ts serializeMemberForList(member)` returning `{ tracks: {role, membership, accountSetup}, nextAction: {label, kind, permission}, ... }`. | Backend | — | ⬜ |
| 4.5.1.2 | `nextAction(member)` — **one function** used by row action + banner + mobile card. | Backend | — | ⬜ |
| 4.5.1.3 | Server-side derivation in `GET /api/members`, `GET /api/members/[id]`, `GET /api/members/migration`. | Backend | — | ⬜ |
| 4.5.1.4 | Retire "Un-invited" for manual-add + "Profile completed (reviewed)" everywhere. Deprecate `displayStatusOf` / `onboardingStatusOf`. | Backend | — | ⬜ |
| 4.5.1.5 | **M17** — `Member.reviewedAt DateTime?` + `Member.reviewedByUserId String?`. Backfill from setupComplete/setupBy/setupAt where present. | Migration + Backfill | M17 + BF-4 | ⬜ |
| 4.5.1.6 | **M18** — `Member.blockedReason` enum + `Member.snoozedUntil DateTime?`. | Migration | M18 | ⬜ |
| 4.5.1.7 | **M19** — `MemberInvitationDelivery` model (per-send delivered/opened/bounced). | Migration | M19 | ⬜ |
| 4.5.1.8 | Migration-meter derivation: `Step N of 7` + whose-turn label + segment color per state. | Backend | — | ⬜ |

### 4.5.2 Members list

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 4.5.2.1 | `GET /api/members` with server-side `page`, `pageSize`, `search`, `filter[key]`, `sort`. Response: `{ members[], pagination, counts: {everyone, athletes, parents, accountHolders, prospects, inactive, mid_migration} }`. | Backend | — | ⬜ |
| 4.5.2.2 | Header: `PageHeader` with 3-count subtitle + `Export` / `Import` / `Add member` actions. Move Form settings + Custom fields to Settings. | UI | — | ⬜ |
| 4.5.2.3 | 4-card work-queue strip (never invited / blocked / missing contact / possible duplicates). Each card = saved filter + armed bulk action. | UI | — | ⬜ |
| 4.5.2.4 | Toolbar: segmented person-type control, 34px search, Filters button, sort, density toggle. Six existing `<select>` dropdowns → Filters panel. | UI | — | ⬜ |
| 4.5.2.5 | Active-filter chip bar + `Save as view` (bookmark). | UI | — | ⬜ |
| 4.5.2.6 | Bulk bar with **query-scoped `Select all N matching`**. | UI + Backend | — | ⬜ |
| 4.5.2.7 | Table with checkbox / Person / Membership / Account setup / Balance / Last seen / actions. Family groups collapse (25px indent + 2px spine). | UI | — | ⬜ |
| 4.5.2.8 | `⋯` menu (238px popover, fixed order, permission-gated items greyed with lock icon + role badge). | UI + Backend | — | ⬜ |
| 4.5.2.9 | Footer: rows-of-total + Previous/Next + A–Z jump. Server-side. | UI + Backend | — | ⬜ |
| 4.5.2.10 | **M20** — `SavedMemberView` model. | Migration | M20 | ⬜ |
| 4.5.2.11 | Mobile: table → card list at `<md`; header actions collapse behind `⋯` (keep primary Add); work-queue 2×2 at `sm` / 1-col at `<sm`; person-type control horizontal scroll; Filters full-screen sheet; bulk bar sticks bottom with safe-area; family collapse "3 more in family" chip. | UI | — | ⬜ |

### 4.5.3 Member profile (tabs variant, 1c)

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 4.5.3.1 | Identity header (64px avatar, name 25px/600, Track 2 pill, role chips, Track 3 dot). | UI | — | ⬜ |
| 4.5.3.2 | Single family switcher card (replaces every other managed-member selector on the page). | UI | — | ⬜ |
| 4.5.3.3 | Next-action banner: derived from same `nextAction()` resolver; renders only when outstanding. `Snooze 7 days` writes `snoozedUntil`. | UI + Backend | — | ⬜ |
| 4.5.3.4 | 11 tabs with counts + red-dot problem indicator. | UI | — | ⬜ |
| 4.5.3.5 | Left col Overview: Migration progress card (7 segments), Contact & identity (3-icon ownership legend), Recent activity, Locked birthday row (span 2) with portal explanation copy. | UI | — | ⬜ |
| 4.5.3.6 | Right col: Account & security (password-reset action), Money, Attendance (3 figures), Waivers & documents (`Request` action), Staff notes. | UI | — | ⬜ |
| 4.5.3.7 | Payments tab wires drill-through from Phase 2.5.4. | UI + Backend | — | ⬜ |
| 4.5.3.8 | Extended `GET /api/members/[id]` include: `guardianLinks: { include: user }` + `user: { include: { guardianOf: { include: { member: true } } } }`. Folds in Phase 4B's Cameron-symptom fix if not yet shipped. | Backend | — | ⬜ |
| 4.5.3.9 | Mobile: 56px avatar; right actions collapse to `⋯` at `<sm` (keep Message); family switcher becomes single-select at `<sm`; next-action banner actions stack; tabs horizontal scroll; body stacks 1-col at `<lg`; locked-birthday row bleeds to edge. | UI | — | ⬜ |

### 4.5.4 Edit member drawer

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 4.5.4.1 | 560px drawer with brand-tinted mid-migration info strip. | UI | — | ⬜ |
| 4.5.4.2 | Corrected-field affordance (history icon + `Imported as "X" · corrected by Y` + `Revert`). | UI + Backend | — | ⬜ |
| 4.5.4.3 | Locked block (birthday + password) with dashed fields, lock icons, portal explanation copy verbatim. | UI | — | ⬜ |
| 4.5.4.4 | Editing an email **re-points the pending invitation, never silently re-sends**. Edits never reset migration progress. | Backend | — | ⬜ |
| 4.5.4.5 | Every write attributed to `MemberMigrationEvent`. | Backend | — | ⬜ |
| 4.5.4.6 | Mobile: drawer opens full-screen at `<md`; field groups stack; locked block ≥48px tall; footer sticks with safe-area inset; Revert links ≥44×44. | UI | — | ⬜ |

### 4.5.5 Password reset (3 states)

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 4.5.5.1 | Confirm dialog 412px, copy verbatim. | UI | — | ⬜ |
| 4.5.5.2 | Success dialog with **live `Resend in mm:ss` countdown**. | UI | — | ⬜ |
| 4.5.5.3 | No-email dialog with red-tinted note + bounce history. | UI | — | ⬜ |
| 4.5.5.4 | Reuse existing `/api/auth/reset-password` machinery. Every send writes attributable audit. | Backend | — | ⬜ |
| 4.5.5.5 | Mobile: dialogs render as bottom sheets at `<sm`; buttons stack; countdown legible; bounce history scrolls inside sheet. | UI | — | ⬜ |

### 4.5.6 Family & access

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 4.5.6.1 | **M21** — `MemberGuardianUser` gains `canBook/canPay/canWaivers/canMessages: Boolean @default(false)`, `status String @default('CONFIRMED')`, `confirmedAt DateTime?`, `createdByUserId String?`. Backfill (**BF-5**): existing rows → CONFIRMED, all 4 booleans true, confirmedAt = createdAt. | Migration + Backfill | M21 + BF-5 | ⬜ |
| 4.5.6.2 | Header + `Transfer account management` + `Add relationship`. | UI | — | ⬜ |
| 4.5.6.3 | Account-holder card (charcoal chip + role chip + meta). | UI | — | ⬜ |
| 4.5.6.4 | Permissions table with editable-in-place checkboxes for Book / Pay / Waivers / Messages + Status + actions. Pending rows tinted `#FFFBF5`. | UI + Backend | — | ⬜ |
| 4.5.6.5 | Transfer account management flow: owner-only, both adults emailed, incoming holder must add PM before completion, in-flight invoices stay with old holder, `BillingAuditLog` entry. | Backend + UI | — | ⬜ |
| 4.5.6.6 | Staff-created relationships start `PENDING`; grant no book/pay/waivers/messages rights until confirmed. | Backend + UI | — | ⬜ |
| 4.5.6.7 | Mobile: header stacks; account-holder card 44px avatar; permissions table → card list with 44×44 toggle switches; Transfer + Add-relationship modals as bottom sheets; pending action buttons ≥44×44. | UI | — | ⬜ |

### 4.5.7 Migration dashboard

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 4.5.7.1 | Breadcrumb + title + subtitle + actions (Export plan / Match memberships / Import more members). | UI | — | ⬜ |
| 4.5.7.2 | Funnel card (7 joined segments; each = a filter). Replaces 8 unrelated KPI tiles + Group/Readiness filters. | UI + Backend | — | ⬜ |
| 4.5.7.3 | 4-up "Needs you" cards. | UI | — | ⬜ |
| 4.5.7.4 | Queue segmented by whose turn (`Needs you / Waiting on member / In setup / Done`). Columns per spec. Bulk row for Send / Assign / Mark reviewed. | UI + Backend | — | ⬜ |
| 4.5.7.5 | Cut-over advisory + `Cut-over checklist`. | UI | — | ⬜ |
| 4.5.7.6 | Retire `migrationGroup / migrationFinalAction / readiness*` from UI. Schema columns retained. | UI | — | ⬜ |
| 4.5.7.7 | Mobile: funnel 7 segments as horizontal-scroll strip at `<md`; progress bar full-width; "Needs you" 2×2 → 1-col; queue tabs horizontal scroll; queue table → card list at `<md`; bulk actions bar sticks bottom with safe-area. | UI | — | ⬜ |

### 4.5.8 Migration detail drawer

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 4.5.8.1 | 664px drawer over queue; preserves parent scroll/filter/selection. | UI | — | ⬜ |
| 4.5.8.2 | Duplicate notice (brand-tinted, non-blocking, `Compare` action). | UI + Backend | — | ⬜ |
| 4.5.8.3 | 7-vertical-step progress timeline with ringed current step. Invitation step embeds `Resend now` / `Send to a different email` / `Copy invite link`. | UI + Backend | — | ⬜ |
| 4.5.8.4 | Imported data 4-col grid; header text = owner's `ImportBatch.sourceLabel` (never hardcoded vendor name). Corrected rows tinted with struck-through old value. | UI | — | ⬜ |
| 4.5.8.5 | Footer: `Assign a different plan` + `Resend invitation`. | UI | — | ⬜ |
| 4.5.8.6 | Mobile: drawer opens full-screen at `<md`; progress timeline dot targets ≥44×44; imported data 4-col → 2-col at `md` → stacked at `<md`; corrected tint stays visible; footer sticks bottom with safe-area. | UI | — | ⬜ |

### 4.5.9 Mobile

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 4.5.9.1 | List: 44px avatars, 44px `⋯` target, pill FAB, person-type chip scroll, 2-card "needs you" scroller. | UI | — | ⬜ |
| 4.5.9.2 | Profile: 56px avatar header, compact banner, 3-up family switcher, 2×2 fact grid, section list, sticky Check-in bar. | UI | — | ⬜ |
| 4.5.9.3 | Quick-action bottom sheet with 48px rows in fixed order matching desktop `⋯` menu. | UI | — | ⬜ |
| 4.5.9.4 | Desk walk-in flow with type segment → name → minor toggle → link-a-parent → two toggles → `Add & check in`. Duplicate detection on save. | UI + Backend | — | ⬜ |

### 4.5.10 States + source-label enforcement + Reports integration

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 4.5.10.1 | Empty / Empty search / Loading / Success / Warning / Error states per spec `1k`. Copy verbatim. | UI | — | ⬜ |
| 4.5.10.2 | Nowhere in UI prints a hardcoded vendor name. Uses `ImportBatch.sourceLabel` (from Phase 2.5.9). Degrades to "your previous system" when blank. | UI + Backend | — | ⬜ |
| 4.5.10.3 | **CI grep guard**: fail on any literal `WELLNESSLIVING`, `WellnessLiving`, `JackRabbit`, `iClassPro`, etc. in `web/app/**/*.tsx`. | Testing | — | ⬜ |
| 4.5.10.4 | **M22** — `MemberSubscriptionEvent` model. Written by every mutation to `MemberSubscription`. | Migration | M22 | ⬜ |
| 4.5.10.5 | **BF-6** — Backfill `CREATED` events for existing subs + status-inference. Dry-run first with per-club report. | Backfill | — | ⬜ |
| 4.5.10.6 | Reports 2.5.5 Membership tab flips from `reliability: "ESTIMATED"` to `"COMPLETE"` after BF-6 runs. | Backend | — | ⬜ |
| 4.5.10.7 | Retire deprecations from UI (grep guard): `migrationGroup / migrationFinalAction / readiness / readinessLabel / readinessReasons / GROUP_FILTERS / READINESS_FILTERS`. | Testing | — | ⬜ |

### 4.5.11 Test suite

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 4.5.11.1 | Status track derivation (5 role combos, 5 membership conditions, 6 setup labels). | Testing | — | ⬜ |
| 4.5.11.2 | `nextAction()` same result across row + banner + mobile for 12 canonical states. | Testing | — | ⬜ |
| 4.5.11.3 | 5000-member fixture: server pagination + search + filter compose correctly. | Testing | — | ⬜ |
| 4.5.11.4 | Query-scoped selection sends to all matching across pages. | Testing | — | ⬜ |
| 4.5.11.5 | `⋯` menu fixed order everywhere; permission-denied items greyed + lock icon + role badge. | Testing | — | ⬜ |
| 4.5.11.6 | Family collapse: 3-child family = 1 row collapsed, 4 with indent + spine expanded. | Testing | — | ⬜ |
| 4.5.11.7 | Locked birthday: staff PATCH `dateOfBirth` denied on `/api/members/[id]`. | Testing | — | ⬜ |
| 4.5.11.8 | Password reset: three-state copy verbatim; countdown works. | Testing | — | ⬜ |
| 4.5.11.9 | Family & access: unconfirmed relationship grants no rights; staff-created starts PENDING. | Testing | — | ⬜ |
| 4.5.11.10 | Transfer account management: 5 safeguards enforced. | Testing | — | ⬜ |
| 4.5.11.11 | Migration funnel: 7 counts sum to total; each segment filters queue correctly. | Testing | — | ⬜ |
| 4.5.11.12 | Migration detail drawer preserves parent queue state on close. | Testing | — | ⬜ |
| 4.5.11.13 | Import source label rendered/degrades correctly; vendor-name grep guard passes. | Testing | — | ⬜ |
| 4.5.11.14 | Mobile: 44px targets throughout; walk-in flow completes without paying. | Testing | — | ⬜ |
| 4.5.11.15 | Reports Membership `reliability` = COMPLETE post-backfill; churn matches fixture including plan-change exclusion + grace window. | Testing | — | ⬜ |
| 4.5.11.16 | Deprecations grep guard: 7 tokens absent from `web/app/**/*.tsx`. | Testing | — | ⬜ |

**Phase 4.5 exit criteria:** every 4.5.x acceptance criterion ✅; migrations M17–M22 applied; Reports Membership tab reliability flips to COMPLETE; no hardcoded vendor name; owner sign-off on `Members` handoff `Open decisions` (1c tabs vs 1d rail; person-type labels; Prospect rename; default staff permissions).

---

## Phase 5 — Event Registration Confirmation

### 5.1 Bug fixes (do first — no schema work)

| # | Task | Class | Status |
|---|---|---|---|
| 5.1.1 | Free public path emails confirmation. `/api/public/events/[slug]/register:147` — add `sendBookingConfirmationEmail` before the free-path return. Reuse the same template variant used elsewhere. | Backend | ⬜ |
| 5.1.2 | Paid public path emails confirmation. Add `sendBookingConfirmationEmail` in `stripe/webhook/route.ts:727-770` `eventRegistrationId` branch. | Backend | ⬜ |
| 5.1.3 | Idempotency key on `stripe.checkout.sessions.create` in all three event registration routes (member, public, at-the-door). | Backend | ⬜ |
| 5.1.4 | Success URLs — swap `getAppBaseUrl()` → `baseUrlFromRequest(req)` in every event registration route (`register`/`charge`/webhook branches). Same class of fix as the 2026-07-13 batch. | Backend | ⬜ |
| 5.1.5 | Member path stamps `discountAmount` on Checkout metadata (parity with owner path). | Backend | ⬜ |

### 5.2 Server-rendered confirmation page

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 5.2.1 | **M17** — `EventRegistration.status` enum + `canceledAt` + `refundedAt` + `confirmationSentAt`. Backfill: existing string values map 1:1 to enum. | Migration | M17 | ⬜ |
| 5.2.2 | **M18** — `EventRegistration @@unique([eventId, LOWER(email)])`. Dedup script (dry-run first, per-club report): keep newest, null stale `stripeCheckoutSessionId` on losers. | Migration + script | M18 | ⬜ |
| 5.2.3 | **M19** — `Booking.bookedByUserId TEXT?`. | Migration | M19 | ⬜ |
| 5.2.4 | New route `app/e/[slug]/registered/[registrationId]/page.tsx` — server-renders the confirmation from the actual DB row. Shows: registered / event / athlete / date-time / location / amount paid / payment status / discount / confirmation # (the registration id or a short code derived from it) / add-to-calendar / view / return / contact. | UI + Backend | — | ⬜ |
| 5.2.5 | Rewrite all `success_url`s to point to `/registered/[registrationId]?session_id={CHECKOUT_SESSION_ID}` (Stripe replaces the token). If the row isn't there yet, server-render "Your registration is being processed. This page will refresh — or check your email." with client-side poll every 2s (max 30s), then fall back to instructions. | UI + Backend | — | ⬜ |
| 5.2.6 | `POST /api/events/registrations/[id]/resend-confirmation` — used by owner Registrations modal and member Communications tab. | Backend | — | ⬜ |

### 5.3 Email template polish

| # | Task | Class | Status |
|---|---|---|---|
| 5.3.1 | `sendBookingConfirmationEmail` template — add: event details, athlete + payer names, discount line, receipt / transaction reference, cancellation policy (from `Event.cancellationPolicy?` — small additive field or reuse club-level `Club.defaultEventCancellationPolicy?`), calendar link, club contact info. | Backend + Migration | (small optional field) | ⬜ |
| 5.3.2 | Dedup guard: check `EventRegistration.confirmationSentAt` before emitting; set after successful send. | Backend | ⬜ |

### 5.4 Discount codes on public path

| # | Task | Class | Status |
|---|---|---|---|
| 5.4.1 | Add `discountCode` to `POST /api/public/events/[slug]/register` Zod schema + `EventRegistration.discountCode/discountAmount` stamping. | Backend | ⬜ |
| 5.4.2 | Add discount code input to `app/e/[slug]/page.tsx`. | UI | ⬜ |

### 5.5 Capacity math parity

| # | Task | Class | Status |
|---|---|---|---|
| 5.5.1 | Member path counts `bookings + registrations - CANCELED - REFUNDED` for capacity. Same formula on public path. Wrap in `computeEventCapacityUsage(eventId)` reusable helper. | Backend | ⬜ |

### 5.6 Mobile

| # | Task | Class | Status |
|---|---|---|---|
| 5.6.1 | `/e/[slug]` — email/phone stack on `<sm`; add `autoCapitalize="none"`, `autoComplete`, `inputMode`, `env(safe-area-inset-bottom)` on CTA; loading skeleton; add-to-calendar/directions/share on confirmation. | UI | ⬜ |

**Phase 5 exit criteria:** all 5 registration paths email a real confirmation exactly once; server-rendered confirmation reflects true state; no double-registration on double-submit; discount codes work everywhere; mobile passes.

---

## Phase 6 — Safety, Data Integrity, Testing

### 6A. Implementation requirements (plan §6A checklist)

| # | Task | Class | Status |
|---|---|---|---|
| 6A.1 | Wrap Phase-1/4/5 multi-row writes in `prisma.$transaction` (transfer, refund flag, matched-and-categorized). | Backend | ⬜ |
| 6A.2 | Idempotency keys for: bulk email send (client-generated), subscription transfer (server-generated `bstx-<subId>-<targetMemberId>-<version>`), event registration retry, Plaid sync, receipt-resend. | Backend | ⬜ |
| 6A.3 | Audit rows on every new mutation: `BillingAuditLog` (money), `MemberMigrationEvent` (member state change), a new `AdminActionLog` for the transfer + refund + email-approval actions if none of the existing tables fits. | Backend | ⬜ |
| 6A.4 | Preserve historical Transaction/Booking/EventRegistration rows — never delete; use `canceledAt`/`refundedAt`/soft-delete. | Backend | ⬜ |
| 6A.5 | Tenant scoping audit on every new endpoint — every read/write has `clubId` in the query. Extend `scripts/production-hardening-tests.ts`. | Testing | ⬜ |
| 6A.6 | Loading / empty / success / warning / error states on every new surface. | UI | ⬜ |
| 6A.7 | Accessibility + keyboard nav audit on new components (composer, transfer modal, confirmation page, family grid). | UI | ⬜ |
| 6A.8 | Desktop + tablet + mobile pass. | UI | ⬜ |

### 6B. Testing (plan §6B checklist)

| # | Task | Class | Status |
|---|---|---|---|
| 6B.1 | `npx tsc --noEmit && npm run lint && npm run build` clean at each checkpoint. | Testing | ⬜ |
| 6B.2 | Extend `scripts/billing-admin-tests.ts` — new: subscription transfer eligibility/execution, family-grid permission enforcement, EmailOptOut scope enforcement, transaction refund flag semantics. | Testing | ⬜ |
| 6B.3 | New `scripts/communications-tests.ts` — audience resolution, household dedup, personalization interpolation, idempotency, per-recipient dedup. | Testing | ⬜ |
| 6B.4 | New `scripts/registration-tests.ts` — the 5 event registration paths × email-fires × confirmation-page-state × dedup-on-double-submit. | Testing | ⬜ |
| 6B.5 | Stripe test-mode E2E: paid event (member + public), transfer, refund flag, cash-and-offline receipt, template send. | Testing (manual) | ⬜ |
| 6B.6 | Plaid sandbox E2E: initial sync, incremental sync, match, split, exclude, transfer flag. | Testing (manual) | ⬜ |
| 6B.7 | CSV import stress test — duplicate emails, malformed rows, minor without guardian, minor with same email as another child. | Testing | ⬜ |
| 6B.8 | Mobile/tablet layout matrix — 360, 375, 414, 768, 1024, 1280, 1440 across every new surface. | Testing | ⬜ |
| 6B.9 | Permission-boundary tests — every new capability × role matrix (Owner, `messages:full`, `messages:send`, `billing:full`, `billing:view`, `finances:full`, `finances:view`, member). | Testing | ⬜ |

---

## Deployment order

Roughly one PR per phase for review isolation, with these hard gates:

1. **Phase 0** ships first as a single "Foundations" PR — nothing user-visible changes; new lib + refactors + dead code removal + owner Q&A resolution.
2. **Phase 1** ships in two PRs: 1A + 1E (cash/offline + mobile), then 1B + 1C + 1D (Plaid + matching + Tax). Migrations M1–M4 with 1A; M5 alone with 1B; M6 + M7 with 1C.
3. **Phase 2** ships in one PR after Reports handoff arrives.
4. **Phase 3** ships in three PRs: foundations (3.1 with M9-M14), composer + templates + audiences (3.2), bulk-from-members + family-aware + history + drafts + safeguards (3.3–3.6).
5. **Phase 4** ships in one PR: M15 + M16 + transfer endpoint + Family & access surface + guardian-side grid.
6. **Phase 5** ships in two PRs: bugs (5.1) first — no migration, ships in a day — then confirmation infrastructure (5.2–5.6) with M17/M18/M19.
7. **Phase 6** ships continuously — the checklist items land alongside every phase PR, with a final consolidation PR before the release announcement.

## Rollback

Every migration ships with a matching reverse SQL kept in the commit body. Feature flags for anything user-visible that could regress: `FEATURE_STRIPE_ONLY_TAB`, `FEATURE_PLAID_SYNC`, `FEATURE_EMAIL_COMPOSER_V2`, `FEATURE_MEMBER_TRANSFER`, `FEATURE_REGISTRATION_V2`. Prefer soft-launch to owners flagged via `Club.betaFeatures Json?` (existing pattern) rather than an all-club flip.

## Progress log

Each phase gets one dated entry per meaningful checkpoint below.

- 2026-07-28 — **Phase 0 + Phase 1A shipped.** Deleted legacy `app/api/messages/route.ts` (unused announcement POST alias, confirmed no live consumers). Wrote migration `20260728000000_financials_transaction_fields` (M1-M4 in one file): `recordedByUserId`, `athleteMemberId`, `refundedAt`, `refundReason`, `refundedByUserId`, `receiptUrl`, `receiptSentAt` — all nullable, plus three indexes and a best-effort `refundedAt = updatedAt` backfill for existing `reconciliationStatus=VOID` rows. Extended `Prisma.Transaction` model accordingly. `GET /api/transactions` now accepts `?paymentSource=stripe|offline|<canonical>` filters + enriches with `recordedBy` and `athlete` join. `PATCH /api/transactions/[id]` accepts refund flag (`refundedAmount`, `refundedAt`, `refundReason`) and `receiptUrl`. Money-recording routes (`/api/financials/manual-payment`, `/api/attendance/charge`, `/api/members/[id]/offline-payment`, `/api/events/[id]/registrations/[regId]/offline-payment`) now stamp `recordedByUserId` and normalize `paymentSource` on the manual-payment create. Financials page: **Stripe** tab now filters `paymentSource=stripe` and never mixes cash/offline; new **Cash & Offline** tab renders every non-Stripe row with method filter chips, refund state, recorded-by column, receipt column, and a Manage modal that flips refund flag + attaches receipt + edits notes + assigns legal entity. Typecheck clean (`.next` blown away first per CLAUDE.md gotcha). Migration NOT yet applied — needs `npx prisma migrate deploy` at deploy time.
- 2026-07-28 — **Phase 1B shipped.** Migration `20260728010000_plaid_transactions` adds two tables: `PlaidTransaction` (dedup by `plaidTransactionId @unique`, indexed by `(clubId, date DESC)` and `(clubId, connection, date)`) and `PlaidSyncCursor` (per-connection cursor + earliestAvailableDate + lastSyncedAt / lastSyncError). Also `Expense.matchedPlaidTransactionId` (nullable, indexed) for the Money-Out link Phase 1C uses. `lib/plaidSync.ts` (`syncConnection`) loops `plaid /transactions/sync` up to 20k rows per call, upserts + captures earliest-available; new `POST /api/plaid/sync` gates it (owner + finances:full). Rewrote `GET /api/plaid/transactions` to query the persisted table with `?range=30|60|90|ytd|year|all|custom&from=&to=&page=&pageSize=` — accounts (live balances) still come from Plaid but transactions come from disk. Bank tab now has: range chips + custom-range picker + Sync button + earliest-available note + pagination + graceful sync-error surface. New-connection flow auto-triggers the first full sync so a fresh bank shows up populated. Typecheck clean. Two migrations pending apply.
- 2026-07-28 — **Phase 1C + 1D shipped.** Migration `20260728020000_money_out_matching` adds `Expense.reviewedAt/reviewedByUserId/excludedFromTax/taxCategory/splits` and new `TransactionCategoryRule` table. `lib/plaidMatching.ts` — `suggestExpenseMatches` scores likely matches (amount ± $0.01, date ± 3 days, vendor substring) and returns top 3; `findCategoryRule` iterates owner-defined rules. New endpoints: `PATCH /api/plaid/transactions/[id]` (categoryOverride, markedAsTransfer, excludedFromTax, notes, reviewed), `GET|POST|DELETE /api/plaid/transactions/[id]/match` (suggestions + confirm/create + unmatch — atomic two-way link), `GET|POST|PATCH|DELETE /api/financials/category-rules` (owner CRUD, gated by finances:full for writes / finances:view for reads). Bank tab table now has a per-row Manage button opening a modal with Categorize + Match-to-expense tabs. Status column shows Needs review / Suggested / Categorized / Matched / Transfer / Excluded. Suggested matches display confidence %. `lib/taxSummary.ts computeBankBasedTaxSummary` builds the bank-based tax view — Stripe income once (from Transaction table), bank credits categorized OR flagged as owner-contribution/loan/transfer count separately; owner-drawings/loan-repayments/transfers hidden from taxable profit. `GET /api/financials/tax-summary` returns it. Tax Summary tab renders Gross income / Refunds / Fees / Net income + Categorized expenses / Uncategorized / Transfers / Excluded + Estimated taxable profit + notes. Legacy PnL report grid retained beneath. Typecheck clean. Three migrations pending apply.
- 2026-07-28 — **Phase 1E + Phase 2 shipped.** Phase 1E — Cash & Offline tab renders as cards on mobile (< md) and as the wide table on desktop (≥ md); Bank accounts grid switched from fixed `grid-cols-3` to responsive `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`. Phase 2 (unblocked tasks per plan.md — the full 8-tab Reports redesign in `design_handoff_reports/` is a deliberate follow-up because it's a multi-phase project on its own): (2.1) Removed the hardcoded 12-month INTERVAL on the revenue chart — `/api/reports/overview` now derives start from range.start (falling back to earliest Transaction on `all`), buckets by day for <90 days and by month otherwise. Chart title reflects the selected range instead of "last 12 months". (2.2) Added `?includeHistorical=1` param that includes soft-deleted members in counts + surfaces a `deleted` count. (2.3) Same flag now also returns `canceled` + `expired` subscription counts. (2.4) The reports endpoint returns aggregates (no row-level pagination needed); large ranges will simply render more chart bars — the chart is `overflow-x-auto`. (2.6) Migration `20260728030000_reports_indexes`: composite indexes on `Transaction(clubId,status,createdAt)`, `Transaction(clubId,txDate)`, `Member(clubId,joinedAt)`, `Member(clubId,status)`, `Expense(clubId,date)`. Reports page adds an "Include historical" checkbox next to the range chips (auto-checked and disabled when range=all) and renders extra rows in Members + Subscriptions cards when historical data is present. **Reports 8-tab redesign — not built.** The design handoff (`design_handoff_reports/`) prescribes a multi-phase project (~5 build phases per its own 00-build-plan.md) with a Snapshot / Revenue / Costs / P&L / Membership / Unit economics / Cash flow / History-imports hub, reliability strip, monthly/weekly P&L with drill-through, waterfall cash flow, and a 7-step import wizard. Deferring to a follow-up because it's a project of its own scale; the plan.md's Phase 2 scope is fully addressed here. Typecheck + `npm run build` clean. Four migrations total pending apply.

- 2026-07-29 — **All four Phase 1/2 migrations applied to production.** psql pooler fallback (direct DNS unreachable from sandbox); each SQL ran under `-1 -v ON_ERROR_STOP=1`, bookkeeping row inserted with SHA-256 matching Prisma format. Smoke checks: all 7 new columns on `transactions`, `plaid_transactions` + `plaid_sync_cursors` tables, `Expense.matchedPlaidTransactionId`, 5 M6 columns, `transaction_category_rules`, 5 M8 indexes — all present. Row counts unchanged (`transactions=37`, `members=292`, `expenses=0`). VOID→refundedAt backfill hit 2/2 rows. Backup at `/Users/cubano/clubos-backups/pre-migration-20260729-1124.sql` (4.6 MB) retained.

- 2026-07-29 — **Roadmap restructured to Option B.** `plan.md` + `PROGRESS.md` updated: full Reports design handoff scheduled as Phase 2.5 (13 sub-phases, migrations M9–M15, ships between Phase 2 and Phase 3); full Members design handoff scheduled as Phase 4.5 (11 sub-phases, migrations M17–M22, ships between Phase 4 and Phase 5). Full cross-phase dependency table added to `plan.md §4a`. Full migration inventory (M1–M22) and backfill inventory (BF-1 through BF-7) added to `PROGRESS.md`. **Note on M-numbering collision**: the pre-existing Phase 3–6 sections in `PROGRESS.md` reference M9–M15 for pre-Phase-2.5-planning purposes; those references will be renumbered to M23+ when Phase 3 is actually implemented. No code shipped in this update — documentation only. Awaiting owner sign-off on the roadmap before starting Phase 3.

- 2026-07-29 (evening) — **Owner-approved roadmap adjustments.** Three amendments to Phase 2.5 + 4.5 before Phase 2.5 code starts: (A) **Owner-first Snapshot**: the default `/dashboard/reports` Snapshot now answers 5 concrete owner questions (Did I make money? Who owes me money? Which memberships are growing? Which coaches/classes are driving revenue? What requires my attention today?), and SaaS metrics (MRR/ARR/ARPA/ARPM/CAC/LTV) move to secondary sections on Revenue and Unit economics tabs. (B) **Mobile in every sub-phase**: every 2.5.x and 4.5.x sub-phase now has explicit mobile acceptance criteria; sub-phases 2.5.12 and 4.5.9 remain as cross-cutting audit + regression passes rather than the first time responsive gets attention. (C) **New sub-phase 2.5.1a — Action Items** feed on Snapshot with `FAILED_PAYMENT`, `EXPIRING_MEMBERSHIP`, `UPCOMING_RENEWAL_LARGE`, `UNRECONCILED_DEPOSIT`, `OFFLINE_PAYMENT_PENDING`, `UNCATEGORIZED_LARGE_BANK`, `HISTORICAL_IMPORT_REVIEW`, `PAYMENT_METHOD_EXPIRING` kinds; snooze via new `ActionItemSnooze` model bundled into M9. Roadmap otherwise approved. Committing docs, pushing, then starting Phase 2.5.1.

- 2026-07-29 (late) — **Phase 2.5.11 shipped: granular Reports permissions.** Nine new sub-scopes nested under the existing `reports` key (`view / financials / bank_balances / payroll / owner_equity / vendors / membership / by_coach / imports / rollback`) — legacy `reports: "view"` scalar still works (maps to `view + financials + vendors + membership` defaults so no staff loses existing access). New `lib/reportsPermissions.ts` with `resolveReportsScopes` + `hasReportScope` (owner-form OR session-form overload). Server enforcement wired into every sensitive route: `POST /api/reports/pnl` strips PAYROLL line values AND section totals AND summary values when caller lacks `reports.payroll` (prevents leak-by-subtraction — the specs/05 non-negotiable), reports `restricted: ["payroll"]`; `GET /api/reports/cash-flow` nulls beginning/ending cash when caller lacks `reports.bank_balances` and strips owner-contribution/owner-distribution financing lines when caller lacks `reports.owner_equity`; every `/api/reports/imports/**` route requires `reports.imports`; rollback specifically requires the stricter `reports.rollback`. Reports hub client hides tabs the caller can't load (P&L / Costs / Cash flow / Unit economics gated by `financials`; Membership gated by `membership`; History & imports gated by `imports`) via `/api/me` scope check on mount; falls back to Snapshot when the current tab is hidden. No new migrations — sub-scopes live nested under the existing `reports` JSON key. Typecheck + `npm run build` clean.

- 2026-07-29 (late) — **Phase 2.5.10 shipped: the seven-step import wizard.** All 12 endpoint contracts from spec 02 live under `/api/reports/imports/**` (list + upload / status / mapping / validate / preview / errors.csv / review + row-decide / commit / log / rollback). New libs: `lib/reportsImports.ts` (column alias tables for MEMBERS + TRANSACTIONS per spec 04, normalizers, date-format inference, CSV parser, row-level validator with errors-vs-warnings buckets, dedupe-hash fingerprint) and `lib/reportsImportsMatch.ts` (matching-signal priority per spec 04: EXTERNAL_ID → EXACT_EMAIL → EXACT_PHONE HIGH auto-match; NAME_DOB / NAME_GUARDIAN MEDIUM review; any signal resolving to >1 candidate downgrades to review; HIGH-vs-HIGH contradiction goes to review; similar-name-only NEVER matches). Commit endpoint honors merge semantics (survivor = native, keep native, fill empty from import, **never overwrite non-empty native fields**), writes `MemberHistoricalRecord` for imported membership spans, uses the unique constraint `(clubId, sourceSystem, externalTransactionId)` as idempotency (P2002 → SKIPPED with reason). Rollback (owner-only, 30-day window) hard-deletes created members without activity + downgrades those with activity to `isHistoricalOnly`, hard-deletes imported transactions and historical records. **No emails sent for imported members** (assertion-worthy — imports never invite/bill/campaign). New pages: `/dashboard/reports/imports` (history list + new-import modal) and `/dashboard/reports/imports/[batchId]` (six-step wizard: Match columns → Check problems → Preview → Review matches → Confirm → Done with audit log). Wizard uses step rail with progress states (current brand-purple, complete lime-check, upcoming grey), URL state (`?step=N`), errors.csv download, side-by-side review-match panels with 5 outcome buttons per row + bulk actions (Keep all separate / Ignore all — no bulk merge), and audit log with outcome filter chips. `?tab=imports` on the Reports hub deep-links to the imports page. Every mobile acceptance criterion met (step rail horizontal-scroll with active step centered, dropzone fill-width, mapping table sticky-first-col horizontal scroll, review-match panels stack at `<md`, footer nav with safe-area inset, 44×44 targets throughout). Typecheck + `npm run build` clean. No new migrations (uses M13/M14/M15 from 2.5.9).

- 2026-07-29 (late) — **Phase 2.5.9 shipped (schema + backfills).** The historical-imports foundation for Phase 2.5.10's wizard is live in production. Migration `20260731030000_historical_imports` applied via pooler (sha256 `43d83724…`) — three new tables (`import_batches`, `import_rows`, `member_historical_records`), six new nullable columns on `members` (`externalMemberId, sourceSystem, importBatchId, isHistoricalOnly, normalizedEmail, normalizedPhone`) + five supporting indexes, six new nullable columns on `transactions` (`externalTransactionId, externalCustomerId, sourceSystem, importBatchId, isHistorical, dedupeHash`) + partial-unique index on `(clubId, sourceSystem, externalTransactionId)` **which is the whole idempotency story for transaction imports** + partial-unique on `(clubId, dedupeHash)`. `ImportBatch.sourceLabel` carries the owner-typed "where are you importing from?" free text — no vendor names hardcoded anywhere in the UI. Backfills BF-1/BF-2/BF-3 ran via `scripts/reports-historical-backfill.ts` (dry-run first, then `--apply`): 292 members tagged `sourceSystem=ATHLETIXOS`, 35 normalizedEmail + 44 normalizedPhone rows filled, 37 transactions tagged (23 STRIPE / 12 CASH / 2 OTHER). Verified via `_prisma_migrations` + column-existence + coverage queries. Prisma models added on schema. Typecheck + `npm run build` clean.

- 2026-07-29 (late) — **Phase 2.5.8 shipped.** Alerts + owner-configurable thresholds. Migration M12 (`20260731020000_report_alert_settings`) applied to production (sha256 `f83fbc2e…`) — `report_alert_settings` table with `(clubId, kind)` unique. Alerts are the counterpart to Action Items: Action Items = actionable tasks with snooze; Alerts = threshold breach checks with severity that owner enables/disables. New `lib/reportsAlerts.ts` with 10 kinds (RUNWAY_BELOW, EXPENSES_EXCEED_REVENUE, CHURN_SPIKE, UNCATEGORIZED_COUNT, BANK_SYNC_STALE, REFUND_RATE, RECURRING_REVENUE_DECLINE, PAYROLL_ABOVE_AVERAGE, plus UPCOMING_RENEWAL_LARGE + UNCATEGORIZED_LARGE_BANK shared with Action Items). Defaults lazily filled by `loadAlertSettings` — no backfill row needed. `buildAlerts` computes each triggered/OK state from trailing-30 windows (revenue, refunds, payroll trend, churn, sync freshness, uncategorized counts). New endpoints: `GET /api/reports/alerts` (owner-only), `PUT /api/reports/alerts/settings` (owner + finances:full). New UI `components/reports/AlertsDrawer.tsx` — right-anchored drawer with tabs Status / Thresholds; Status shows Triggered vs Healthy grouped lists with severity-tinted borders (red high / orange medium / lime OK); Thresholds tab has per-kind on/off toggle + numeric input (5×5 wide, ≥44×44 tap) + Save button. Wired into Reports hub header: **Alerts button with badge count of triggered items** — visible on every tab. Also promoted the Export button from disabled-placeholder to a live P&L PDF export link. Mobile: drawer opens as bottom sheet at `<sm` with 44×44 close target; threshold inputs at 44px min height; alerts list scrolls within sheet. Typecheck + `npm run build` clean.

- 2026-07-29 (late) — **Phase 2.5.7 shipped.** Cash flow tab live. Migration M11 (`20260731010000_payout_match`) applied to production (sha256 `dd4f9eda…`) — `payout_matches` table with `(clubId, stripePayoutId)` unique + arrival-date + bank-transaction-id indexes. New `lib/reportsCashFlow.ts` per spec 03: transfer detection (matched debit+credit pair within 3 days across two connected accounts of same club — `TRANSFER_WINDOW_DAYS=3`); PayoutMatch exclusion (bank rows tagged as matched Stripe payouts drop out of operating inflows to prevent the classic double-count); classification (Operating / Investing above `CAPITALIZATION_THRESHOLD=$2500` / Financing via LOAN_DEPOSIT/LOAN_REPAYMENT/OWNER_CONTRIBUTION/OWNER_DRAW category tags / Excluded = transfers + matched payouts). Forecast returns `null` when <3 months of bank history; when enough exists, projects expected recurring revenue from active subs (Stripe-frequency normalized) + monthly-average recurring expenses. New endpoint `GET /api/reports/cash-flow`. New UI `components/reports/CashFlowTab.tsx` — 5-column waterfall (Beginning / Received / Spent / Net / Ending, proportional-height bars, "needs bank" dashed placeholder when Beginning/Ending are null) → grouped table (Operating / Investing / Financing / Excluded, each with subtotal row) → Forecast card with Estimated badge + basis note (or "connect a bank + sync 3+ months" empty state) + Notes card. Mobile: waterfall horizontal-scrolls with 480px minimum inner width, grouped table stacks naturally, forecast+notes stack below `lg`. Typecheck + `npm run build` clean.

- 2026-07-29 (late) — **Phase 2.5.6 shipped.** Unit economics tab in the eight-tab hub, positioned as the secondary destination for ratios (CAC/LTV/break-even/margins) — Snapshot and Membership answer primary questions first. New `lib/reportsUnitEconomics.ts` per spec 03: `perAthlete: {revenue, cost, grossProfit, operatingProfit, marginPercent}` — every field returns `null` when athleteCount = 0 (never NaN). `margins: {grossMarginPercent, operatingMarginPercent}`. `breakEven: {athletes, currentAthletes, gap, formula, isEstimate, message}` — **returns `null` athletes + explanatory message when `contributionMarginPerAthlete ≤ 0`** ("Your variable cost per athlete is higher than your revenue per athlete — every additional athlete currently loses money."). `acquisition: {cac, ltv, ltvToCacRatio, isEstimate: true, caveats[]}` — CAC returns `null` when no marketing spend recorded; LTV null pending Phase 4.5.10 (subscription-event history); caveats explain every null. Fixed vs variable resolution: PAYROLL + RENT/INSURANCE/SOFTWARE/PROFESSIONAL/UTILITIES = FIXED; everything else honors `Expense.kind` first. New endpoint `GET /api/reports/unit-economics`. New UI `components/reports/UnitEconomicsTab.tsx` — explanatory notice on top, 4 per-athlete KPIs (2×2 at `<md`, 4-up at `md+`), Break-even card with 34px number + 2px charcoal marker on progress bar + formula block (rule-line vertical at `<sm`) + orange-tinted warning row when unreachable, Margins + Acquisition side-by-side (stacked below `lg`) with Estimated badges + caveats list. No new migrations. Typecheck + `npm run build` clean.

- 2026-07-29 (late) — **Phase 2.5.5 shipped.** Membership tab in the eight-tab hub. Owner-first framing: primary answer is "which memberships are growing?" via a movement card + top-movers list; churn/retention/rates are the secondary block. New `lib/reportsMembership.ts` computes movement (starting active → new/reactivated/canceled/expired → ending active + plan changes), churn rate + revenue churn rate + retention with the 14-day grace window (a cancel followed by a new membership within 14 days is NOT churn — plan changes counted separately). Formula card is server-authored so the UI renders the exact calculation the API used, matching spec 03. Trend chart runs 6 monthly buckets of churn rate. Breakdown table groups by plan with active/lost/churn/revenue columns. `reliability: "ESTIMATED"` on every rate — reliability flips to COMPLETE after Phase 4.5.10's `MemberSubscriptionEvent` backfill. New endpoint `GET /api/reports/membership?range=&groupBy=type|program|location|age|coach`. New UI `components/reports/MembershipTab.tsx` — movement card + rates card + formula card (rule-line fraction vertical at `<sm`) + churn-trend chart + top-movers with All/Growing/Shrinking filter chips + breakdown table (table `md+`, card list `<md`) + reliability + notes box. Mobile: movement 4-up KPI at `md+` / 2×2 at `<md`; rate tiles 2×2; formula renders vertically at `<sm`; trend chart horizontal scroll; breakdown table stacks to cards below `md`. No new migrations. Typecheck + `npm run build` clean.

- 2026-07-29 (late) — **Phase 2.5.4 shipped.** P&L + drill-through + CSV/PDF export — the most-requested behavior in the brief. New `lib/reportsPnl.ts` computes the payload per spec 02 §pnl: `columns` (6 monthly or 6 weekly buckets anchored to the range end, partial columns flagged); `sections: [income, cost_of_sales, operating_expenses]` with per-line values arrays index-aligned to columns; `summary[]` one entry per column (gross income, gross profit, gross margin %, total operating expenses, operating profit, net profit, profit margin %); `rollingAverage` (weekly only, 4 complete weeks); `accrualCoverage` with `unsupportedPurchaseCount` when a purchase has no service span; `warnings[]` PARTIAL_PERIOD / ACCRUAL_INCOMPLETE / UNCATEGORIZED. Accrual basis prorates membership revenue across `MemberSubscription.startedAt → endDate` daily; purchases with no span fall back to cash. Payroll rolled into PAYROLL category via `computePayrollTotalForRange` per column. New endpoints: `GET /api/reports/pnl`, `GET /api/reports/pnl/drill` (transaction list for one cell), `GET /api/reports/pnl/export?format=csv|pdf` (CSV via `pnlToCsv`, PDF via jsPDF+autoTable landscape with row-alternating fills, section labels, and warnings footer). New UI `components/reports/PnlTab.tsx` — segmented Monthly/Weekly + Cash/Accrual controls, warnings strip, desktop table with sticky first column + click-to-drill on every cell + Net-profit lime highlight row + profit-margin row + rolling-average row; mobile stacked card layout with 2-column value grid + section totals collapsed to latest column; DrillSheet is full-screen bottom sheet on `<sm` with 44×44 close target and transaction list linked to Financials. Every mobile acceptance criterion from sub-phase 2.5.4 met (table stacked at `<sm`, controls wrap at `<md`, export buttons 44×44, drill full-screen sheet on mobile, no horizontal page scroll). No new migrations. Typecheck + `npm run build` clean.

- 2026-07-29 (late) — **Phase 2.5.3 shipped.** Costs tab live inside the eight-tab hub. Migration M10 (`20260731000000_expense_classification_override`) applied to production via pooler (sha256 `3bf37a9c…`). New `lib/reportsCosts.ts` computes the payload from `Expense` + payroll + `ContractorPayment` + `ExpenseClassificationOverride`. Fixed vs variable resolution priority: (1) `Expense.kind` per-row, (2) owner override per category, (3) sensible defaults per category. Unusual-increase rule per spec 03: current ≥ 1.5× 3-period trailing average AND diff ≥ $250 (both). Possible-duplicate detection: same vendor + same amount + within 2 days. New endpoints: `GET /api/reports/costs`, `PATCH /api/reports/costs/classification`, `DELETE /api/reports/costs/classification?category=…` (owner+finances:full only). New UI `components/reports/CostsTab.tsx` — split bar → two metric cards (Fixed / Variable with category chip lists) → top-categories table with delta % vs prior period, override button per row (desktop table / mobile card list) → top vendors + largest single expenses side-by-side → "Needs a look" 6-tile grid. Override modal is bottom-sheet on `<sm`, radio-tile at 44×44, includes a "remove override" option when one exists. Typecheck + `npm run build` clean.

- 2026-07-29 (late) — **Phase 2.5.2 shipped.** Revenue tab in the eight-tab Reports hub. New `lib/reportsRevenue.ts` returns owner-first shape: `primary: { mix, byItem, byCoach, byLocation, bySource }` on top, `recurring: { mrr, arr, arpa, arpMembership, activeMemberships, newMemberships, endedMemberships, upgrades, downgrades, amount, percentOfTotal }` and `variable: { amount, percentOfTotal, byCategory }` as secondary blocks. MRR forward-looking, normalized to monthly per Stripe rules (annual÷12, quarterly÷3, weekly×52÷12, biweekly×26÷12). Coach revenue estimated by splitting event revenue equally across `EventStaffAssignment.role='COACH'` — response includes `reliability: "ESTIMATED"` and a note pointing at the follow-up precision work. Location breakdown only surfaces when the club has ≥2 locations. Membership items collapsed to a single "Membership dues" roll-up so the Top-items list stays scannable. New endpoint `GET /api/reports/revenue`. New UI `components/reports/RevenueTab.tsx` — mix bar → top items (table on `md+`, cards on `<md`) → coach + location side-by-side → source chips → collapsible "Recurring revenue metrics" block (SaaS: MRR/ARR/ARPA/ARPM + New/Ended/Upgrades/Downgrades). Every drill-through row is 44×44 on mobile; source chips wrap; recurring block 2-up KPI grid at `<md`, 4-up at `md+`. No new migrations. Typecheck + `npm run build` clean.

- 2026-07-30 — **Phase 2.5.13 shipped: reports test suite + real bug fix.** New `scripts/reports-tests.ts` — 238 pure-function tests covering every acceptance criterion in `specs/06` (P&L, partial periods, Stripe fees + payouts, refunds, bank transfers + equity, cash + offline, churn, historical imports, fixed vs variable, break-even + unit economics, permissions, missing / incomplete data, regression guard for `/dashboard/financials`). Run via `npx tsx scripts/reports-tests.ts` — no DB / no Stripe / no network. Six surgical additive extractions to unblock unit testing: (1) `lib/reportsPnl.ts` — `computePnl(columns, basis, data, period)` extracted from `buildPnl` as a pure calculation core taking `PnlFixtures`; `monthlyColumns`/`weeklyColumns` exported. (2) `lib/reportsCashFlow.ts` — `detectTransferPairs(plaidRows)` and `classifyPlaidRow(row, ctx)` extracted with `PlaidRowLite`/`PayoutMatchLite` types. `buildCashFlow` refactored to consume them — same behavior, unit-testable transfer detection + classification. (3) `lib/reportsMembership.ts` — `classifyEndedSub(ended, otherSubs)` and `computeChurnRates(...)` extracted with the 14-day grace window rule as a pure function; `pctOrNull` promoted to export. (4) `lib/reportsUnitEconomics.ts` — `computeUnitEconomicsCore({revenue, expenses, payroll, athleteCount, newMembers, marketingSpend, rangeMs})` extracted — pure break-even + CAC + margin math without DB. (5) `lib/reportsCosts.ts` — `resolveBehavior`, `trailingPeriods`, `isUnusualIncrease`, `COSTS_DEFAULT_KIND` exported. Zero call-site behavior changes. **Real bug fixed at the root**: `sumColumns` in `lib/reportsPnl.ts` derived column count from `arrays[0]?.length ?? 0`, so an empty input returned `[]` instead of `[0, 0, ..., 0]`. Downstream summary math read `total.values[i]` and got `undefined`, cascading to `NaN` across `grossIncome`/`grossProfit`/`operatingProfit`/`netProfit`. **This meant any club with no data in range — including every newly onboarded club on day one — got `NaN` for `netProfit` and `undefined` for `grossIncome` across all columns.** Fix: `sumColumns(arrays, cols)` now requires the column count and returns a `cols`-length array of zeros for empty input. Both call sites in `reportsPnl.ts` updated. Four regression tests locked in as permanent guards: empty-range summary all 0s (not NaN), same-row full refund → 0 (not undefined), comp $0 tx → 0 (not undefined), weekly rolling average from complete weeks (not NaN). `npx tsc --noEmit` clean, `npm run build` clean, `npm run lint` unchanged from HEAD (253 pre-existing warnings/errors, 0 introduced). 238/238 tests pass.

- 2026-07-29 (late) — **Phase 2.5.1 + 2.5.1a shipped.** Migration `20260730000000_reports_snapshot_actionitems` (M9 `Club.wentLiveAt` + M9a `ActionItemSnooze` with `(userId, kind, COALESCE(targetId,''))` unique index) applied to production via pooler + bookkeeping (sha256 `93babfdc…`). New libs: `lib/reportsRange.ts` (shared resolver — 11 range keys, weeks Mon–Sun in club timezone, months in club tz, partial-period detection, comparison window), `lib/reportsReliability.ts` (cached ~60s, 8 states from spec 03), `lib/reportsSnapshot.ts` (owner-first shape: `didIMakeMoney/whoOwesMe/membershipsGrowing/revenueDrivers/cash/runway/trend/burnBasis` — no SaaS metrics here), `lib/reportsActionItems.ts` (8 action kinds with snooze support; `HISTORICAL_IMPORT_REVIEW` feature-detects the not-yet-existing `ImportBatch` model). New endpoints: `GET /api/reports/reliability`, `GET /api/reports/snapshot`, `GET /api/reports/action-items`, `POST|DELETE /api/reports/action-items/snooze`. New UI components: `components/reports/RangeDropdown.tsx` (extended range dropdown + custom picker + mobile bottom-sheet), `components/reports/ReliabilityStrip.tsx`, `components/reports/ActionItems.tsx` (with high/med/low filter chips + snooze menu), `components/reports/SnapshotTab.tsx` (owner-first ordering — Action Items → Did I make money → Who owes me + Memberships growing side-by-side → Revenue drivers → Cash+runway → Trend chart). Rebuilt `/dashboard/reports/page.tsx` as the 8-tab hub with Snapshot fully built + other tabs as placeholder empty states citing the sub-phase they ship in. URL query state (`tab`, `range`, `from`, `to`) persists. Active-tab-scroll-into-view wired. Every card meets the mobile acceptance criteria (44×44 targets, stacked at `<md`, bottom-sheet range picker on `<sm`, tabbed nav horizontal scroll, trend chart "show all" toggle below `sm`). Reliability strip cached in-process ~60s; deep-link `href`s point to exact fix routes. Snapshot's `revenueDrivers.byCoach` returns empty for now (coach FK on Transaction lands in 2.5.2). Membership movement marked `reliability: "ESTIMATED"` until 4.5.10's `MemberSubscriptionEvent` lands. Typecheck + `npm run build` clean.

---

*See `ARCHITECTURE-NOTES.md` for the discovery findings that back this plan.*
