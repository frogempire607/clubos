# AthletixOS — Coordinated Product Improvement

## 0. Mission

This is **one coordinated product improvement**, not a list of unrelated feature requests.

**Outcome we are building toward:** AthletixOS should be the easiest and most complete operating system for youth sports organizations — owners manage members, finances, communication, events, and day-to-day operations from one connected platform.

Every change must move the platform toward *polished, intuitive, scalable, production-ready* while maintaining **backward compatibility with existing customer data**.

### How to think about each request
- Think beyond the individual feature — consider how it integrates with the rest of the platform.
- Prefer reusable architecture over one-off solutions.
- Prefer the simpler workflow when it accomplishes the same business goal.
- Reuse existing components and services wherever possible.
- **If you identify a significantly better implementation than what is described here, explain why before implementing it.** Do not blindly implement every request if it introduces unnecessary technical debt — explain the tradeoffs and implement the cleaner solution.

---

## 1. Design Handoffs (source of truth)

Two approved Claude Design handoff files are provided:

1. **Members handoff** — source of truth for all UI/UX for Members, Member Profiles, Relationships, Migration, and any connected flows.
2. **Reports handoff** — source of truth for the Reports page.

Follow the approved designs unless there is a technical limitation or a substantially better solution. If you deviate, say so and explain why.

---

## 2. Before Writing Any Code

Complete this discovery pass first and report findings before implementation.

**2.1 — Review the existing implementation for every affected feature.**

**2.2 — Map how the current architecture works across:**
- Database schema
- API routes
- Stripe
- Plaid
- Reports
- Communications
- Members
- Family relationships
- Permissions
- Migrations

**2.3 — Identify opportunities to simplify existing logic** instead of layering new code on old code.

**2.4 — Identify anything required:**
- Database migrations
- Backfills
- New indexes
- Permission changes
- API updates

**2.5 — Classify each issue** as UI-only vs. backend/schema change.

**2.6 — Document risky assumptions.**

**2.7 — Produce a phased implementation plan** that keeps existing production data compatible.

**Preserve existing production data unless explicitly instructed otherwise.**

---

## 3. Standards That Apply to Every Section

For each area below:
- Understand the underlying business problem first.
- Improve the entire workflow, not just the specific UI.
- Desktop, tablet, and mobile must be equally polished.
- Maintain consistency with the rest of AthletixOS.
- Avoid duplicate business logic.
- Respect all permission levels.
- Maintain full auditability for financial and member-related actions.
- Every important action needs loading, success, warning, empty, and error states.
- Maintain accessibility and keyboard navigation.
- Add regression tests for new functionality where appropriate.

---

## 4. Implementation Order

Treat each phase as a complete product area before moving to the next.

| Phase | Area | Status |
|---|---|---|
| 1 | Owner Financials | ✅ Done |
| 2 | Reports — thin fixes from this brief | ✅ Done |
| **2.5** | **Reports — full design handoff** (8-tab hub, drill-through, imports wizard, alerts, forecasts) | ⬜ Planned |
| 3 | Communications & Email | ⬜ Planned |
| 4 | Client & Family Accounts | ⬜ Planned |
| **4.5** | **Members — full design handoff** (3 tracks, list, profile, Family & access, migration redesign, mobile, imports source label) | ⬜ Planned |
| 5 | Event Registration Confirmation | ⬜ Planned |
| 6 | Safety, Data Integrity, Testing, Deployment & Final Handoff | ⬜ Planned |

**Non-negotiable:** neither Phase 2.5 nor Phase 4.5 is a "future project." They are scheduled and each has full acceptance criteria below. Partial implementations of either handoff are not acceptable.

**Reports ↔ Members integration:** Phase 2.5.5 (Reports Membership tab — churn / retention / movement) and Phase 4.5's server-derived member tracks + migration timeline share a data spine. Ordering matters — see §4a below.

### 4a. Cross-phase dependencies

| Consumer | Depends on | Reason |
|---|---|---|
| Phase 2.5.5 (Membership tab, precise churn) | Phase 4.5.1 (server-derived tracks + subscription-event history) | The design handoff's own build plan says exact churn needs the member-event history from the Members redesign. Until 4.5.1 lands, 2.5.5 must return figures with an `ESTIMATED` reliability flag, never a fabricated total. |
| Phase 2.5.9 + 2.5.10 (Historical imports schema + wizard) | Phase 4.5.10 (owner-typed `ImportBatch.sourceLabel` — no hardcoded vendor names) | Imports and the "as imported from <label>" surfaces share `ImportBatch`. They ship in the same migration to avoid double-migrating Member and Transaction. |
| Phase 4.5.3 (Member profile Family & access card) | Phase 4B (`GET /api/members/[id]` `guardianLinks` + `user.guardianOf` include) | The read gap for the "Cameron symptom." Phase 4B must land first or fold into 4.5.1. |
| Phase 4.5.7 (Migration dashboard funnel) | Phase 4.5.1 (server-derived tracks + step-of-7 resolver) | The funnel + queue segmentation read the derived tracks. |
| Phase 2.5.4 (P&L drill-through) | Phase 2.5.9 (`Transaction.sourceSystem` + `isHistorical`) | Drill lists include historical rows and label them by source. |
| Phase 2.5.7 (Cash flow) | Phase 1B (`PlaidTransaction` persistence) + new `PayoutMatch` | Cash flow reads bank ledger + excludes Stripe payouts. |
| Phase 2.5.11 (granular permissions) + Phase 3.1.1 (`messages` sub-scopes) | Independent | Same pattern (nested JSON under existing key). |
| Phase 5.2 (server-rendered event confirmation) | Phase 4.5.10 (`Import.sourceLabel`) | Registration UI never prints a vendor name the owner didn't type. |
| Reports ↔ Financials | Phase 1 | Reports **reads** Financials data; Reports must NOT modify `/dashboard/financials`. Regression test at 6.1. |

---

# PHASE 1 — Owner Financials

**Goal:** An owner can see exactly where every dollar came from and went, on any device, without mentally untangling Stripe from cash from bank activity.

## 1A. Separate Stripe and Cash/Offline Transactions

**Problem:** The Stripe section under Financials currently mixes in non-Stripe money.

**The Stripe transaction list must only show transactions that actually came through Stripe.** Do not mix in:
- Cash payments
- Checks
- Manual payments
- Bank transfers that did not use Stripe
- Other offline payment methods

**Add a separate Cash and Offline Payments page or tab**, covering:
- Cash
- Check
- Manual payment
- External card payment
- Bank transfer
- Other offline payment methods

Each transaction must clearly show:
- Date
- Client or payer
- Athlete, if different from payer
- Item purchased
- Payment method
- Amount
- Staff member who recorded it
- Notes
- Receipt status
- Refund or reversal status

**Data integrity:** historical payment records keep their original source and are never relabeled as Stripe transactions.

## 1B. Bank Transaction Date Filters

**Problem:** The Bank page appears to show only ~30 days of Plaid transactions.

**First diagnose the actual cause.** Determine whether the limit comes from:
- The user interface
- The API request
- Plaid pagination
- Plaid transaction-sync configuration
- Database storage
- A scheduled synchronization job

**Then add date-range filters:**
- 30 Days
- 60 Days
- 90 Days
- Year to Date
- All Time
- Custom Range

"All Time" means all bank transaction history AthletixOS has successfully imported and stored. If Plaid cannot retrieve the account's complete lifetime, **clearly communicate the earliest available transaction date**.

Use pagination or incremental loading so large histories stay usable.

## 1C. Money Out and Expense Matching

**Goal:** A club owner can review and categorize outgoing money in a workflow inspired by QuickBooks but simple enough for a wrestling club or gym.

Money Out should be automatically detected from debit and outgoing bank transactions.

Each outgoing bank transaction must be able to be:
- Categorized
- Marked as reviewed
- Matched to an uploaded receipt
- Matched to payroll
- Matched to a vendor
- Matched to a refund
- Matched to a Stripe fee or payout adjustment
- Split across multiple categories
- Excluded from tax reporting
- Marked as a transfer between accounts
- Marked as personal or non-business, with proper permissions and warnings

**Suggested statuses:** Needs Review · Suggested Match · Matched · Categorized · Excluded · Duplicate · Transfer

**Matching logic:** use transaction amount, date, vendor name, payroll records, receipts, and existing system records to suggest matches.

**Never auto-finalize a match** unless it is highly reliable and safe. Owners must be able to approve, reject, or change every suggestion.

## 1D. Tax Summary

**Goal:** An owner gets an accurate organizational picture of taxable profit with no double counting.

The Tax Summary should primarily use **bank transaction data**, because clubs receive and spend money outside Stripe.

**Income should consider:**
- Stripe deposits and payments
- Checks deposited into connected bank accounts
- ACH deposits
- External payment processors
- Other business income visible in bank transactions

**Expenses** come from categorized outgoing bank transactions.

Do **not** include physical cash payments in the bank-based Tax Summary unless the owner separately recorded and categorized them as cash income inside AthletixOS.

**Avoid double counting:**
- A Stripe customer payment must not count once as a Stripe transaction and again when the payout hits the bank.
- Transfers between the club's own accounts are neither income nor expense.
- Refunds reduce the correct income category.
- Stripe fees are treated separately from gross revenue.
- Loan deposits do not automatically count as income.
- Owner contributions do not automatically count as revenue.
- Owner distributions do not automatically count as business expenses.

**The Tax Summary must clearly show:**
- Gross income
- Refunds
- Processing fees
- Net income
- Categorized expenses
- Uncategorized transactions
- Transfers
- Excluded transactions
- Cash income recorded separately
- Estimated taxable profit

Include warnings that this is an organizational summary, not a substitute for professional tax advice.

## 1E. Mobile and Tablet Financials

**Goal:** The Stripe and Bank pages are fully usable on a phone.

- Tables must not be cut off.
- Horizontal scrolling must be available when a full table is necessary.
- Important information should stay visible without horizontal scrolling where possible.
- Filters must remain accessible.
- Action menus must not render off-screen.
- Sticky columns or card layouts may be used where appropriate.
- Test common phone, tablet, laptop, and desktop widths.
- Avoid duplicate mobile-only and desktop-only actions that perform the same function inconsistently.

---

# PHASE 2 — Reports

**Goal:** The Reports page gives an owner complete historical visibility, not just a recent window.

**Follow the approved Reports design handoff as the source of truth.**

Required additions:
- **All-time transactions** — full transaction history, not a limited recent range.
- **All-time members** — full member history, including historical/inactive members.

Apply the same standards as Phase 1: date-range filtering, pagination or incremental loading for large datasets, permission-aware data, mobile and tablet layouts, and loading/empty/error states.

> **Note:** this section is thinner than the others in the original brief. Before implementing, review the Reports design handoff and report back with the full list of reports, metrics, filters, and export options it specifies, plus anything you recommend adding.

**Status:** ✅ Shipped 2026-07-28 (see PROGRESS.md). Removed the hardcoded 12-month cap, added `?includeHistorical=1` for soft-deleted members + canceled/expired subscriptions, composite indexes for range queries. The full 8-tab Reports redesign from the design handoff moves to Phase 2.5.

---

# PHASE 2.5 — Reports Full Design Handoff

**Source of truth:** `docs/improvement/design_handoff_reports/` — `README.md`, `specs/00-build-plan.md` through `specs/06-test-plan.md`, and the three `.dc.html` prototypes. Every sub-phase below cites the specific specs it lands.

**Goal:** an owner with no accounting background opens Reports and understands whether the business is healthy — from an 8-tab hub (Snapshot · Revenue · Costs · P&L · Membership · Unit economics · Cash flow · History & imports), with drill-through on every figure, honest reliability signals on every card, and a 7-step all-time CSV import wizard.

**Non-negotiables from the handoff (`README.md` and `specs/00-build-plan.md` §Non-negotiables):**
1. Never present a total we can't stand behind.
2. Never double-count (Stripe charge + payout deposit = one dollar).
3. Transfers between the club's own accounts are neither income nor expense.
4. Never merge people on a similar name.
5. Estimates are labelled.
6. Reuse existing helpers (`EXCLUDE_VOID`, `resolveRevenueCategory`, `computePayrollTotalForRange`, `isCashMethod`).
7. **Out of scope: `/dashboard/financials`.** Reports reads it, must not modify it. Regression test at 6.1.

**Owner-approved adjustments (2026-07-29):**

**A. Owner-first Snapshot.** The default Snapshot answers the questions a club owner actually asks, not SaaS-vendor questions. The five primary answers:
1. **Did I make money?** — period net + comparison + one-line explanation.
2. **Who owes me money?** — outstanding invoices, unpaid registrations, past-due subscriptions, with drill-through.
3. **Which memberships are growing?** — net change per plan, side-by-side new vs canceled, top movers.
4. **Which coaches / classes are driving revenue?** — top revenue by coach + top by class/program.
5. **What requires my attention today?** — Action Items feed (see §2.5.1a).

Advanced SaaS metrics — ARR, MRR, ARPA, ARPM, CAC, LTV, LTV:CAC — still exist and remain accurate. They move to secondary positions on the Revenue tab (MRR / ARR / ARPA / ARPM) and Unit economics tab (CAC / LTV / LTV:CAC / break-even). They are not the first thing the owner sees.

**B. Mobile is a per-sub-phase acceptance criterion, not a final polish sub-phase.** Every 2.5.x below has explicit mobile acceptance criteria. Sub-phase 2.5.12 remains as the cross-cutting responsive audit + regression test, not as the first time responsive gets attention.

**C. New sub-phase 2.5.1a — Action Items.** A first-class Snapshot section (and its own endpoint) that surfaces tasks the owner should act on today: failed payments, expiring memberships, unreconciled deposits, upcoming renewals, pending offline payments, uncategorized bank rows over threshold. Every item has a permission-gated action button and drill-through. This ships in Phase 2.5.1a so the Snapshot renders it from the first commit.

## 2.5.1 — Shell, extended range, reliability strip, owner-first Snapshot tab (`specs/02` §range, §snapshot, §reliability; `specs/03` §snapshot, §runway; `README.md` Tab 1)

**Deliverable:** owner opens `/dashboard/reports`, sees the eight-tab hub, the reliability strip, and a working owner-first Snapshot tab that answers the five questions above.

**Acceptance criteria — hub + range + reliability:**
- Eight tabs render (`Snapshot · Revenue · Costs · P&L · Membership · Unit economics · Cash flow · History & imports`) with horizontal scroll at `<lg` and active-tab-scroll-into-view (`getBoundingClientRect`, 12px slack, `scroll-behavior: smooth`).
- Range dropdown supports every key: `this_week`, `last_week`, `month`, `last_month`, `qtd`, `ytd`, `year`, `all`, `before_athletix`, `since_athletix`, `custom`. Weeks are Monday–Sunday, months are calendar months in the **club's timezone** (`Club.timezone`, not server-local).
- Every API response carries `range: { key, label, start, end, isPartialPeriod, partialNote, comparison }`.
- `GET /api/reports/reliability` — cached ~60s, returns `{ sections: [{ key, label, state, detail, count, lastUpdatedAt, href }], attentionCount }`. Every `href` deep-links to the exact fix, not a section index.
- Reliability states from `specs/03`: `COMPLETE`, `MISSING_BANK_CONNECTION`, `AWAITING_CATEGORIZATION`, `HISTORICAL_DATA_INCOMPLETE`, `CASH_DATA_NOT_INCLUDED`, `ESTIMATED`, `NEEDS_REVIEW`, `STALE`.

**Acceptance criteria — owner-first Snapshot API (`GET /api/reports/snapshot`):**
- Returns the answers to the five questions plus supporting metrics. Shape:
  ```
  {
    range: {...},
    reliability: [...],   // reliability strip payload (subset relevant to Snapshot)
    didIMakeMoney: {
      netPosition, totalInflows, totalOutflows,
      comparison: { key, label, netPositionDelta, inflowsDelta, outflowsDelta } | null,
      explanation: string          // "You brought in $X, spent $Y, kept $Z."
    },
    whoOwesMe: {
      total, count,
      breakdown: [{ kind: "unpaid_invoice"|"unpaid_registration"|"past_due_sub"|"offline_pending", label, amount, count, href }]
    },
    membershipsGrowing: {
      netChange, newCount, canceledCount,
      topMovers: [{ id, name, netChange, newCount, canceledCount, direction: "growing"|"shrinking" }]
    },
    revenueDrivers: {
      byCoach: [{ id, name, amount, share, href }] | null,   // null when no coach assignment
      byClass: [{ id, name, kind: "class"|"program"|"event"|"private", amount, share, href }]
    },
    cash: {
      accounts: [{ id, label, institution, mask, balance, lastSyncedAt }],
      stripePending, totalAvailable, lastUpdatedAt
    },
    runway: { months: number | null, status: "healthy"|"tight"|"critical", basisLabel: string },
    trend: [{ month: string, inflows: number, outflows: number, isPartial: boolean }],
    burnBasis: { label, months },
    avgWeeklyBurn, avgMonthlyBurn, avgWeeklyNet, avgMonthlyNet,
    partialPeriodNote: string | null
  }
  ```
- **`runway.months` is `null` when no bank connection** — never `0`. UI reads "Connect a bank account to see runway."
- **Partial-period detection**: monthly = `today < last day of month`; weekly = fewer than 7 elapsed days. Partial columns marked in the trend chart, excluded from rolling averages, never used as a comparison base.
- SaaS metrics (MRR, ARR, ARPA, ARPM, CAC, LTV, LTV:CAC, avg lifetime value) are **not** included in this endpoint. They live in `/api/reports/revenue` (2.5.2) and `/api/reports/unit-economics` (2.5.6).

**Acceptance criteria — Snapshot tab UI (owner-first ordering, top-to-bottom):**
1. **Reliability strip** — same on every tab.
2. **Action Items** (see §2.5.1a) — actionable list, above the fold.
3. **"Did I make money?" card** — plain-English headline (`You brought in $X, spent $Y, kept $Z.`) + net delta pill (green up / red down) vs comparison period + `View P&L →`.
4. **"Who owes me money?" card** — total + count + drillable breakdown chips (Unpaid invoices, Unpaid registrations, Past due, Offline pending). Each chip → transaction list drill.
5. **"Which memberships are growing?" card** — net change + top movers (grid at desktop, list at mobile). Each mover → membership detail (Phase 4.5 profile).
6. **"Which coaches / classes are driving revenue?" card** — two mini-tables side-by-side at desktop, stacked at mobile. Each row → drill.
7. **Cash on hand card** — highlighted total row (`rgba(163,230,53,.14)`) with "Healthy" pill + 6px lime progress bar + basis note.
8. **Money-in-vs-money-out chart** — grouped bar pairs (or fewer for shorter ranges); partial month rendered at `opacity: 0.55` with asterisk + footnote.
9. **"Where these numbers come from"** — 3-column grid of six source cards. On mobile: single column.

**Acceptance criteria — mobile (specs/05 §mobile):**
- Tab bar horizontally scrolls at `<lg` with active tab scrolled into view on mount.
- Cards stack 1-column below `md`, 2-column at `md`, full ordering above at `lg`.
- The "Did I make money?" plain-English headline never truncates on 375px — wraps to two lines instead.
- "Who owes me money?" breakdown chips wrap to multiple lines below `sm`, never overflow.
- Top movers and revenue drivers render as list on mobile (not table) with amount right-aligned.
- Cash-on-hand card total row bleeds to card edge on mobile (`-mx-3` equivalent) to keep the highlighted band visible.
- Money-in-vs-money-out chart: below `sm` shows last 6 buckets with "show all" toggle.
- Every interactive target ≥ 44×44.
- Reliability strip never collapsed on any breakpoint.

**Migration required:**
- **M9**: `Club.wentLiveAt DateTime?` (nullable; if set, `before_athletix` uses it; otherwise falls back to `Club.createdAt`).

## 2.5.1a — Action Items (`specs/02` §alerts + owner-approved extension 2026-07-29)

**Deliverable:** a first-class Action Items section on the Snapshot tab that surfaces tasks the owner should act on today, not just KPIs. Every item has a permission-gated action button and a drill-through.

**Acceptance criteria — API (`GET /api/reports/action-items`):**
- Returns `{ items: ActionItem[], counts: { high: n, medium: n, low: n }, generatedAt }`.
- Each `ActionItem` shape:
  ```
  {
    id: string,
    kind: ActionKind,           // enum below
    severity: "high"|"medium"|"low",
    title: string,              // "3 payments failed this week"
    detail: string,             // plain-English evidence
    count: number | null,       // how many rows
    amount: number | null,      // aggregate dollars if relevant
    href: string,               // drill-through to the exact fix
    action: { label: string, kind: string, permission: string } | null
  }
  ```
- **`ActionKind`** — MVP set (2.5.1a):
  - `FAILED_PAYMENT` — Stripe `invoice.payment_failed` in the last 7 days, subscription still `past_due`.
  - `EXPIRING_MEMBERSHIP` — MANUAL subs with `endDate` in next 14 days, or Stripe subs with `cancel_at_period_end=true` and `currentPeriodEnd` in next 14 days.
  - `UPCOMING_RENEWAL_LARGE` — active recurring sub with `currentPeriodEnd` in next 7 days AND amount above the club's median charge (default $200; owner-configurable via `ReportAlertSetting.threshold` in 2.5.8).
  - `UNRECONCILED_DEPOSIT` — Stripe payout with no `PayoutMatch.bankTransactionId` after 10 days (also flags reliability warning, per specs/03).
  - `OFFLINE_PAYMENT_PENDING` — `Transaction.status='PENDING'` + `paymentSource IN ('CASH','CHECK')` older than 3 days.
  - `UNCATEGORIZED_LARGE_BANK` — `PlaidTransaction` with `reviewedAt IS NULL AND categorizedExpenseId IS NULL AND markedAsTransfer=false AND excludedFromTax=false AND ABS(amount) >= threshold` (default $500; owner-configurable).
  - `HISTORICAL_IMPORT_REVIEW` — `ImportBatch.reviewCount > 0` and `status='AWAITING_REVIEW'` (comes online in 2.5.10).
  - `PAYMENT_METHOD_EXPIRING` — Stripe payment method expiring in next 30 days (via existing `stripeSetupCustomerId` lookup).
- Items ordered: high severity first, then by amount desc.
- Permission-gated: each item's `action.permission` is enforced client-side (button greyed with lock icon) and server-side (drill routes 403 for insufficient permission).

**Acceptance criteria — UI (`components/reports/ActionItems.tsx`):**
- Owner-first — rendered **above** the "Did I make money?" card on the Snapshot tab.
- One card per item: severity dot (red / orange / yellow) + title + detail + count/amount + primary action button + `⋯` (dismiss / snooze).
- Empty state (well-run club, no items): a lime tile, `check-circle-2` icon, "Nothing needs your attention today." + reassurance copy.
- Loading skeleton = 3 rows of card outlines.
- Filter chips at the top: `All (n) · High (n) · Medium (n) · Low (n)`. Chips are pills, `bg-app-bg` inactive / `bg-charcoal text-white` active.
- Every card carries a `data-action-item-kind` attribute for the `/api/reports/reliability` deep-link to jump to it.
- Snooze writes to a new `ActionItemSnooze` table (see migration below). Snoozed items disappear until `snoozedUntil` passes.

**Acceptance criteria — mobile:**
- Cards render full-width on mobile with severity dot + title + detail stacked, action button below at 44px height.
- Filter chips horizontally scroll with `-webkit-overflow-scrolling: touch`.
- Snooze / dismiss `⋯` opens a bottom sheet on mobile with 44px minimum row height.
- No horizontal page scroll at 375, 414, 768 px.

**Migration required:**
- **M9a**: `ActionItemSnooze` model — `{ id, clubId, userId, kind (ActionKind enum), targetId String?, snoozedUntil DateTime, createdAt, @@index([clubId, snoozedUntil]) }`. Bundled with M9 in the same migration file (`20260730_club_wentliveat_actionitems`) since both are small and land together.

## 2.5.2 — Revenue tab (`specs/02` §revenue; `specs/03` §recurring revenue; `README.md` Tab 2)

**Owner-first framing:** top of the tab answers "where is my revenue coming from?" — mix, top items, top coaches, top classes. SaaS metrics (MRR / ARR / ARPA / ARPM) live in a **secondary "Recurring revenue metrics" section further down the tab**, not in the primary answer.

**Acceptance criteria — API:**
- `GET /api/reports/revenue` returns `{ range, total, primary: { byItem, byCoach, byLocation, bySource, mix: {recurring, variable, recurringPercent, variablePercent} }, recurring: {activeMemberships, mrr, arr, arpa, arpMembership, newMemberships, renewedMemberships, endedMemberships, upgrades, downgrades, amount, percentOfTotal}, variable: {amount, percentOfTotal, byCategory} }`.
- **MRR is forward-looking:** sum of active recurring subscriptions normalized to monthly (annual ÷ 12, quarterly ÷ 3, weekly × 52 ÷ 12, biweekly × 26 ÷ 12). Excludes `past_due` and `pending` subscriptions.
- Revenue by item, coach, location, source — all drill targets (link to `/api/reports/pnl/drill` in 2.5.4).
- Revenue by coach: returns `null` for clubs with no coach-on-membership assignment. Gated by `reports.by_coach`.
- Revenue by location: returns `null` when the club has one location.
- Source chips (999px radius, `bg-app-bg`, 1px border, 8px dot, bold amount) — sources: `ATHLETIXOS | STRIPE | PREVIOUS_SOFTWARE | CASH | MANUAL_IMPORT | BANK | OTHER`.
- A plan change is an **upgrade** if the new normalized monthly amount is higher, **downgrade** if lower. Equal amounts are neither and are excluded from both counts.

**Acceptance criteria — UI (owner-first ordering):**
1. Revenue mix bar (34px, purple recurring / lime variable, inline percentages).
2. Top revenue by item table.
3. Top revenue by coach card + Top revenue by class card, side-by-side.
4. Source chips grid.
5. **Below the fold — "Recurring revenue metrics"** collapsible section with MRR, ARR, ARPA, ARPM, new/renewed/ended/upgrades/downgrades. Section header: "For SaaS-style metrics" + info tooltip.

**Acceptance criteria — mobile:**
- Revenue mix bar: full width, stacked labels below at `<sm` if percentages would collide.
- Coach + class cards stack 1-column below `md`; horizontal scroll table with sticky first column.
- Source chips wrap to multiple lines.
- Recurring revenue metrics section: 2-up KPI grid at `<md`, 4-up at `md+`.
- Every drill-through opens a full-screen sheet on mobile (matches P&L pattern from 2.5.4).
- No horizontal page scroll at 375, 414, 768 px.

**No new migrations** — reads existing data + `Transaction.sourceSystem` (added in 2.5.9).

## 2.5.3 — Costs tab + fixed/variable override (`specs/02` §costs; `specs/03` §rounding; `README.md` Tab 3)

**Acceptance criteria — API:**
- `GET /api/reports/costs` returns `{ range, fixed: {total, monthlyAverage, percentOfRevenue, categories}, variable: {…}, topCategories: [{rank, category, label, behavior, amount, percentOfRevenue, deltaPercent}], topVendors, largestExpenses, attention }`.
- `attention` object includes: `uncategorized`, `missingReceipts`, `awaitingReview`, `unusualIncreases`, `recurringSubscriptions`, `possibleDuplicates`.
- **Unusual increase** = current period ≥ 1.5× trailing 3-period average **AND** absolute diff ≥ $250 (both conditions).
- `PATCH /api/reports/costs/classification` body `{ category, treatAs: "FIXED"|"VARIABLE" }`. Owner-only. Writes to `ExpenseClassificationOverride`.
- Fixed/variable split bar: charcoal / orange, 34px.
- Owner override survives a category rename.
- Fixed + variable = total outflows to the cent.

**Acceptance criteria — mobile:**
- Split bar full-width; category chips wrap.
- Top-categories table: horizontal scroll with sticky first column below `md`.
- Top vendors + Largest expenses cards stack 1-column below `md`.
- "Needs a look" 6-card grid: 2×3 at `sm`, 1×6 at `<sm`.
- Fixed/variable override tap target ≥44×44.

**Migration required:**
- **M10**: `ExpenseClassificationOverride` — `{ id, clubId, category, treatAs: CostBehavior, updatedById, updatedAt, @@unique([clubId, category]) }` (`specs/01`).

## 2.5.4 — Profit & Loss + drill-through + CSV/PDF export (`specs/02` §pnl, §pnl/drill; `specs/03` §profit & loss; `README.md` Tab 4)

**This is the most-requested behavior in the brief. It ships in this sub-phase, not later.**

**Acceptance criteria — API + logic:**
- `GET /api/reports/pnl?period=monthly|weekly&basis=cash|accrual&range=…&from=…&to=…&compare=previous|last_year` returns the shape in `specs/02`: `{ period, basis, columns, sections, summary[], rollingAverage, accrualCoverage, warnings }`.
- Sections: `income`, `cost_of_sales`, `operating_expenses`.
- `values[]` arrays are index-aligned with `columns[]`.
- Line ordering follows the spec exactly: Income → Direct costs → Gross profit → Operating expenses → Net profit → Profit margin. **Never re-order alphabetically.**
- Cash basis: recognise on settlement date (`txDate ?? createdAt`).
- Accrual: recognise across `membershipStartDate → membershipEndDate` (or camp/event dates). Daily proration, not monthly (a camp Jul 28 – Aug 3 splits 4/7 into July). Purchases with no span fall back to cash and increment `unsupportedPurchaseCount`.
- 4-week rolling average **excludes partial columns**.
- Weekly table's partial-week column highlighted orange.
- Monthly table columns match design: Line · Jun 2026 · May 2026 · Change · Jun 2025 · YTD 2026.
- **`GET /api/reports/pnl/drill?line=…&…`** returns `{ line: {key, label}, total, transactions: [{id, date, description, counterparty, amount, source, href}] }`. Every number in P&L, cost and revenue tables opens this. On mobile it's a full-screen sheet, not a popover.
- **`GET /api/reports/pnl/export?format=csv|pdf`** with same params. CSV reuses `reportToCsv` from `web/lib/financialReports.ts`. PDF ships in this sub-phase (not deferred).
- Rounding: compute in `Decimal`; never accumulate in JS floats. Round at the boundary, half-up, 2 dp. Percentages 1 dp. Percentage-point changes written as "pp" not "%". Negatives parenthesised (`($1,284.00)`).

**Acceptance criteria — mobile:**
- P&L table: below `sm`, stacked card layout (one card per line, label above, values as label/value pairs). Above `sm`, horizontal scroll with sticky first column.
- Segmented controls (Monthly/Weekly, Cash/Accrual) wrap under the header at `<md`; stay in a row at `md+`.
- CSV + PDF export buttons: 44×44 minimum at mobile.
- **Drill-through opens a full-screen sheet on mobile** (not popover). Sheet has a close button at 44×44, list is virtualized for perf, and CSV export of the drill list stays available.
- No horizontal page scroll at 375, 414, 768 px.

**Migration required:** none — reads existing data.

**Blocker for Phase 4.5.5 acceptance:** drill-through must be live before the Members Payments tab wires it.

## 2.5.5 — Membership tab (`specs/02` §membership; `specs/03` §churn; `README.md` Tab 5)

**Owner-first framing:** primary answer is "which memberships are growing / shrinking?" — same top-mover data the Snapshot answers, expanded with drill-through. SaaS churn/retention/LTV metrics are the secondary section.

**Acceptance criteria — API + logic:**
- `GET /api/reports/membership?range=…&groupBy=type|program|location|age|coach` returns `{ range, movement, rates, formula, trend, breakdown, notes }`.
- Movement card: starting active → new → reactivated → canceled → expired → ending active → plan changes (marked "not counted as churn").
- **Churn formula** (verbatim from `specs/03`): `membershipChurnRate = memberships lost during period ÷ active memberships at start of period`. "Lost" = canceled OR expired AND member did not start another membership within the **14-day grace window**. The window is a named constant.
- **Not churn** (all four exclusions): plan change (up/down/lateral), scheduled pause with return date, moving between memberships without an inactive gap, seasonal end when a renewal for next season already exists.
- `revenueChurnRate = MRR lost during period ÷ MRR at start of period` (not member counts).
- `retentionRate = 1 − membershipChurnRate` always.
- `formula` object is rendered verbatim in the UI. Do not hard-code the formula text in the client.
- Zero starting memberships returns `null`, not division-by-zero or `Infinity`.
- Historical members (`isHistoricalOnly=true`) count in duration + lifetime value but never in active membership counts.
- Churn trend chart with December highlighted orange (seasonal spike) and July purple (current).
- Breakdown table with four pill filters (active pill is charcoal/white).
- `groupBy=coach` returns 403 for non-owners without `reports.by_coach`, `null` for clubs with no coach assignment.
- **Precision caveat until Phase 4.5.1 lands:** if member-subscription-event history isn't yet indexed, the response includes `reliability: "ESTIMATED"` on affected fields with the note "Exact churn requires member subscription-event history." Never fabricate a number.

**Acceptance criteria — mobile:**
- Movement card: 1-column below `md`, 2-column at `md+`.
- Churn breakdown pills: horizontal scroll below `sm`.
- Churn trend chart: below `sm` shows last 6 months with "show all" toggle.
- Breakdown table: horizontal scroll with sticky first column below `md`.
- Formula card: full-width; rule-line fraction renders vertically (numerator over denominator) below `sm`.
- No horizontal page scroll at 375, 414, 768 px.

**Migration required:** none in this sub-phase; consumes Phase 4.5.1's new tracking data when available.

## 2.5.6 — Unit economics tab (`specs/02` §unit-economics; `specs/03` §unit economics; `README.md` Tab 6)

**Owner-first framing:** this is where CAC, LTV, LTV:CAC, break-even and per-athlete margins live. It's a secondary tab by design — the Snapshot and Membership tabs answer the primary questions with plain-English numbers first. Users who want the ratios come here.

**Acceptance criteria — API + logic:**
- `GET /api/reports/unit-economics` returns `{ range, athleteCount, perAthlete: {revenue, cost, grossProfit, operatingProfit, marginPercent}, margins, breakEven, acquisition }`.
- Per-athlete KPIs: revenue, cost, gross profit, operating profit, margin %.
- `contributionMarginPerAthlete = revenuePerAthlete − variableCostPerAthlete`.
- `breakEvenAthletes = ceil(monthlyFixedCosts ÷ contributionMarginPerAthlete)`.
- **If `contributionMarginPerAthlete ≤ 0`**: return `null` with message "Your variable cost per athlete is higher than your revenue per athlete — every additional athlete currently loses money." Never divide by negative.
- Zero athletes returns `null` for every per-athlete figure.
- `CAC = marketing spend in period ÷ new members acquired`. Returns `null` when no marketing spend.
- `LTV = avgMonthlyRevenuePerAthlete × avgMembershipDurationMonths × grossMarginPercent`. Returns `null` if any input `null`.
- Break-even card: 34px number, 2px charcoal marker on progress bar at break-even point, formula block showing the arithmetic.
- Margins + Acquisition card with an "Estimated" badge + caveat paragraph.
- Every estimated field carries `isEstimate: true`.

**Acceptance criteria — mobile:**
- 4 per-athlete KPI cards: 2×2 at `<md`, 4-across at `md+`. Values never truncate at 375px (wrap or drop to next type-scale step).
- Break-even card: progress bar full-width; the 34px break-even number wraps below on `<sm`.
- Formula block on `bg-app-bg` renders vertically at `<sm` (numerator over rule over denominator).
- Margins + acquisition card: single column at `<md`.
- Estimated badge visible without truncation on every card.

**Migration required:** none in this sub-phase.

## 2.5.7 — Cash flow tab + PayoutMatch (`specs/02` §cash-flow; `specs/03` §double counting, §cash flow, §forecasts; `README.md` Tab 7)

**Acceptance criteria — API + logic:**
- `GET /api/reports/cash-flow` returns `{ range, beginningCash, cashReceived, cashSpent, netMovement, endingCash, operating: {inflows, outflows}, investing[], financing[], excluded: {accountTransfers, matchedStripePayouts}, forecast }`.
- Waterfall visualization: five columns — beginning `#E9E7FB`, received lime, spent `#F3C6C6`, investing/financing `#F3C6C6`, ending charcoal with white text — heights proportional to value.
- Classification per `specs/03`:
  - **Operating** — memberships, events, camps, privates, merch, refunds, payroll, rent.
  - **Investing** — equipment/property purchases/sales above capitalization threshold (default $2,500; owner-configurable).
  - **Financing** — loan proceeds, loan payments, owner contributions, owner distributions.
  - **Excluded** — account transfers, matched Stripe payouts.
- Loan payment: split principal (financing) from interest (operating) when schedule is known; whole payment to financing and noted when not.
- **Transfer detection**: a debit and a credit of the same amount within 3 days across two connected accounts of the same club. Excluded from both P&L sides. Shown in cash flow "Excluded".
- Table grouped Operating / Investing / Financing / Excluded from P&L.
- Forecast card: `{ expectedMembershipRevenue, expectedRecurringRevenue, upcomingPayroll, upcomingRecurringExpenses, expectedStripePayouts, projectedMonthEndCash, estimatedRunwayMonths, breakEvenProgress, isEstimate: true, basis }`.
- **Forecast returns `null` when <3 complete months of history**; the UI hides the section rather than showing zeros.
- Alerts card with dot-prefixed rows.

**Migration required:**
- **M11**: `PayoutMatch` — `{ id, clubId, stripePayoutId, bankTransactionId?, amount, matchedAt?, @@unique([clubId, stripePayoutId]) }` (`specs/01`).

**Matching algorithm (`specs/03`):** same amount within ±$0.01, bank posting date within 5 days of the payout's `arrival_date`, description contains the Stripe descriptor. Unmatched payouts older than 10 days raise a reliability warning, not a silent adjustment.

**Acceptance criteria — mobile:**
- Waterfall visualization: horizontal scrolls with a legend that stays visible at the top.
- Grouped table (Operating / Investing / Financing / Excluded): horizontal scroll with sticky first column.
- Forecast card: full-width; the "Estimated" badge stays visible.
- Alerts card: full-width; dot-prefixed rows readable at 375px.
- Excluded section chips (matched-payouts, transfers) wrap.

## 2.5.8 — Alerts + settings (`specs/02` §alerts; `specs/01` §ReportAlertSetting)

**Acceptance criteria:**
- `GET /api/reports/alerts` returns `{ alerts: [{ kind, severity: "high"|"medium"|"low", state: "TRIGGERED"|"OK", title, detail, href, threshold }] }`.
- `PUT /api/reports/alerts/settings` — owner-only.
- Kinds: `RUNWAY_BELOW`, `EXPENSES_EXCEED_REVENUE`, `CHURN_SPIKE`, `UNCATEGORIZED_COUNT`, `BANK_SYNC_STALE`, `REFUND_RATE`, `RECURRING_REVENUE_DECLINE`, `PAYROLL_ABOVE_AVERAGE`.
- Reuse severity vocabulary and dot colors from `components/NotificationBell.tsx`.
- Seed defaults on club creation: runway floor 3 months, uncategorized 20, refund rate 5%, payroll 15% above trailing average.
- New default seeds for the Action Items thresholds from 2.5.1a: `UPCOMING_RENEWAL_LARGE=200`, `UNCATEGORIZED_LARGE_BANK=500`. Owner-configurable via the settings form here.

**Acceptance criteria — mobile:**
- Alerts list: 1-column at all breakpoints (severity + title + toggle row).
- Threshold settings drawer: opens as bottom sheet on mobile, 44px minimum row height.
- Toggle switch tap target ≥44×44.

**Migration required:**
- **M12**: `ReportAlertSetting` — `{ id, clubId, kind: AlertKind, threshold: Decimal?, enabled: Boolean @default(true), @@unique([clubId, kind]) }` (`specs/01`).

## 2.5.9 — Historical import schema + field additions (`specs/01`; `specs/04` §step-6 duplicate prevention)

**Acceptance criteria:**
- `ImportBatch` model as defined in `specs/01`: `{ id, clubId, kind: ImportKind (MEMBERS|TRANSACTIONS), status: ImportStatus (DRAFT|VALIDATING|AWAITING_REVIEW|COMMITTING|COMPLETED|FAILED|ROLLED_BACK), sourceSystem, sourceLabel (owner-typed — no hardcoded vendor names), fileName, fileHash, rowCount, columnMap: Json, createdCount, matchedCount, mergedCount, skippedCount, errorCount, reviewCount, startedAt, completedAt, rolledBackAt, rollbackExpiresAt (= completedAt + 30 days), createdById }`.
- `ImportRow` model: `{ id, batchId, rowNumber, rawData: Json, normalizedData: Json?, outcome: ImportOutcome (CREATED|MATCHED|MERGED|LINKED|SKIPPED|EXCLUDED|PENDING_REVIEW), reason, matchSignal: MatchSignal?, confidence: Confidence? (HIGH|MEDIUM|LOW), targetType, targetId, decidedBy, decidedAt, errors: Json? }`.
- `MemberHistoricalRecord`: `{ id, clubId, memberId, membershipTypeLabel, startDate?, endDate?, status, externalMemberId?, sourceSystem, importBatchId?, notes, dataCompleteness: Json (drives HISTORICAL_DATA_INCOMPLETE) }`.
- Field additions on `Member`:
  - `externalMemberId String?` — indexed `(clubId, externalMemberId)`, not unique.
  - `sourceSystem String?` — `"ATHLETIXOS"` for native.
  - `importBatchId String?`.
  - `isHistoricalOnly Boolean @default(false)` — never in active rosters, billing, messaging; only in all-time reporting.
  - `normalizedEmail String?` (lowercased, indexed).
  - `normalizedPhone String?` (E.164, indexed).
- Field additions on `Transaction`:
  - `externalTransactionId String?` — **unique on `(clubId, sourceSystem, externalTransactionId)`** (the whole duplicate-prevention story).
  - `externalCustomerId String?`.
  - `sourceSystem String?` — `ATHLETIXOS | PREVIOUS_SOFTWARE | MANUAL_IMPORT | STRIPE | CASH | BANK | OTHER`. Distinct from `paymentSource` (which is *how paid*, not *where recorded*).
  - `importBatchId String?`.
  - `isHistorical Boolean @default(false)`.
  - `dedupeHash String?` — for rows with no external transaction ID; `sha256(clubId + date + amount + normalizedPayerEmail + itemLabel)`, unique per club.
- RLS policies added for all three new tables (`web/rls/`).

**Migrations required:**
- **M13**: `ImportBatch` + `ImportRow` + `MemberHistoricalRecord` + enums `ImportKind`, `ImportStatus`, `ImportOutcome`, `MatchSignal`, `Confidence`.
- **M14**: `Member` field additions listed above + indexes.
- **M15**: `Transaction` field additions listed above + composite unique + `dedupeHash` unique.

**Backfills:**
- **BF-1**: `Member.sourceSystem = 'ATHLETIXOS'` for existing rows.
- **BF-2**: `Member.normalizedEmail = LOWER(TRIM(email))` where non-null; `Member.normalizedPhone = E.164(phone)` where non-null.
- **BF-3**: `Transaction.sourceSystem` derived from `paymentSource` (STRIPE→STRIPE, CASH→CASH, CHECK→BANK-like or OTHER, EXTERNAL_READER→OTHER, MANUAL_ADJUSTMENT→MANUAL_IMPORT, COMP→OTHER).
- All backfills dry-run first with per-club report; allowlist-required `--apply`.

**Acceptance criteria — mobile (schema sub-phase, minimal UI):**
- No mobile UI in this sub-phase (schema + backfill only). The `sourceLabel`-typing surface is part of the import wizard (2.5.10) which has its own mobile criteria.

## 2.5.10 — Import wizard (7 steps) (`specs/04` — entire spec)

**Acceptance criteria:**
- **Route:** `/dashboard/reports/imports/[batchId]` (or modal off the Reports hub) with step rail sidebar.
- **Step 1 — Upload**: dashed dropzone (2px `#D8D5F7`, 12px radius, `rgba(109,93,246,.03)`), source-system radio group + owner-typed source label (feeds `ImportBatch.sourceLabel`), template download per import kind. Accepts CSV up to 20 MB / 50k rows. Computes sha256; earlier batch with same hash triggers "You imported this exact file on <date>" warning (not block).
- **Step 2 — Match columns**: auto-map by normalized header against alias table (`specs/04` member + transaction field tables). Statuses per column: Auto (lime) / Check format (orange) / Unmapped (orange, row tinted `rgba(255,106,0,.04)`, cell shows select) / Ignored (grey). Date-format detector switcher inline.
- **Step 3 — Check for problems**: two buckets — Errors (row cannot import: unparseable date, no name + no email + no external ID, end < start, dup external ID within file, non-numeric money, unrecognised currency) vs Warnings (row imports flagged: missing join date, phone reformatted, unrecognised status word, net doesn't reconcile, DOB in future / >100). `errors.csv` download = original rows verbatim + appended `error` column.
- **Step 4 — Preview**: first 50 rows exactly as they will be stored, outcome badge per row, summary footer (created / matched / needs review / excluded).
- **Step 5 — Review matches**: matching signal priority (per `specs/04`):
  - `EXTERNAL_ID` (HIGH → auto-match), `MIGRATION_ID` (HIGH), `EXACT_EMAIL` (HIGH), `EXACT_PHONE` (HIGH), `NAME_DOB` (MEDIUM → review), `NAME_GUARDIAN` (MEDIUM), `EMAIL_IS_GUARDIAN` (MEDIUM), `ID_COLLISION` (MEDIUM), `PHONE_IS_STAFF` (LOW), similar-name-only (**never a match**).
  - Any signal resolving to >1 candidate downgrades to review.
  - HIGH contradicting HIGH goes to review.
  - Five outcomes: Same-person-add-history (`MATCHED`), Merge-two-records (`MERGED`), Create-as-separate (`CREATED`), Keep-both-don't-link (`SKIPPED`), Skip-this-row (`EXCLUDED`).
  - Bulk actions: "Keep all separate" and "Ignore all". **No bulk merge.**
- **Step 6 — Confirm**: async commit for >2,000 rows (202 + jobId + poll). Chunked writes of 500 in a transaction per chunk. Merge semantics: survivor = native record; keep native value when both present; fill from import when native empty; **never overwrite non-empty native field**. Every field change logged.
- **Step 7 — Done**: success card with import ID, timing, four actions, then permanent audit log with row-level filters + CSV download.
- **Rollback (`specs/04` §rollback)**: owner-only (`reports.rollback`), 30-day window from `completedAt`. `CREATED` rows: hard-delete only if no activity attached; else convert to `isHistoricalOnly`. `MATCHED`: delete attached historical record. `MERGED`: restore archived + move relations using field-change log. Shows preview of what will be removed before confirming.
- **No emails.** Imported members are not invited, not notified, not billed, not added to campaigns. Assertion test at 6.2.

**Acceptance criteria — mobile:**
- Wizard step rail: horizontal scroll below `md` with active step centered on mount; steps clickable-backwards freely.
- Step 1 dropzone: fill-width, drop target ≥44×44 tap area, `Choose file` fallback button.
- Step 2 column-mapping table: horizontal scroll with sticky first column.
- Step 3 error table: grouped rows collapse into 1 card per error kind at `<md`, expandable.
- Step 4 preview table: horizontal scroll with sticky first column.
- Step 5 review-match cards: side-by-side panels stack at `<md`; five outcome buttons render as 44px tap targets.
- Step 6 confirm dialog: full-screen at `<sm`.
- Step 7 audit log table: horizontal scroll with sticky first column.
- Footer nav (Back / Step / Next): fixed to bottom at `<md` with safe-area inset.
- No horizontal page scroll at 375, 414, 768 px.

**Routes (`specs/02` §import routes):**
```
POST   /api/reports/imports                      → { batchId, headers[], sampleRows[], suggestedMap }
PATCH  /api/reports/imports/:id/mapping          → { valid, unmappedColumns[] }
POST   /api/reports/imports/:id/validate         → { readyCount, reviewCount, errorCount, errorGroups[], warnings[] }
GET    /api/reports/imports/:id/preview?limit=50 → { rows[], summary }
GET    /api/reports/imports/:id/errors.csv       → text/csv
GET    /api/reports/imports/:id/review?cursor=   → { items[], total, reviewed }
POST   /api/reports/imports/:id/review/:rowId    → { outcome, targetId? }
POST   /api/reports/imports/:id/commit           → 202 { jobId }
GET    /api/reports/imports/:id                  → batch status + counts
GET    /api/reports/imports/:id/log?cursor=      → paginated ImportRow[]
POST   /api/reports/imports/:id/rollback         → owner-only, 30-day
GET    /api/reports/imports                      → history list
```

**No new migrations** — reuses M13-M15.

## 2.5.11 — Granular permissions (`specs/05` §permissions)

**Acceptance criteria:**
- Ten new keys nested under `reports.*` (JSON blob, no schema change): `reports.view` (exists), `reports.financials`, `reports.bank_balances`, `reports.payroll`, `reports.owner_equity`, `reports.vendors`, `reports.membership`, `reports.by_coach`, `reports.imports`, `reports.rollback`.
- Enforcement server-side per endpoint (`specs/05` §enforcement) — a hidden tab is not access control.
- **Partial responses over 403s where sensible:** staff with `reports.financials` but not `reports.payroll` gets P&L with payroll line as `null` + `restricted: ["payroll"]` array. Totals that would leak the hidden value are also `null` (don't return a value the user could subtract from).
- Client hides tabs the user can't load via `canAccessPath`.
- Coach filtered to own revenue on `groupBy=coach`.
- Existing tier gate (`getTierFeatures(tier).reports`) stays and runs first.

**No new migration** — permission JSON is a blob.

## 2.5.12 — Mobile + responsive audit + regression pass (`specs/05` §mobile)

**Scope note:** every earlier sub-phase (2.5.1 through 2.5.11) already ships mobile-responsive per its own acceptance criteria. This sub-phase is the **cross-cutting audit + polish pass**: pixel-diff every screen at 375 / 414 / 768 / 1024 / 1280 / 1440, fix any drift, and lock in the responsive behavior with tests.

**Acceptance criteria:**
- Tab bar horizontally scrollable at `<lg`, momentum scroll, active tab scrolled into view on mount. Never collapses into `<select>`.
- KPI cards: 4 across at `lg`, 2 at `sm`, 1 below.
- Two-column card pairs stack below `lg` in read order.
- Every wide table (P&L, revenue-by-item, churn breakdown, review queue, audit log) horizontal-scrolls with **first column sticky** (`position: sticky; left: 0`), `-webkit-overflow-scrolling: touch`, right-edge fade shadow.
- P&L below `sm`: stacked card layout (one card per line, values as label/value pairs).
- Drill-through on mobile: **full-screen sheet**, not popover.
- Charts: below `sm`, 12-month bar chart shows last 6 months with "show all" toggle.
- Range dropdown: bottom sheet on mobile with 44px minimum row height. Custom uses native date inputs.
- **Reliability + alert strips never collapsed on small screens**; they wrap multi-line.
- Every interactive target ≥ 44×44 on touch.
- No horizontal page scroll at 375, 414, 768 px.
- Sticky table headers do not collide with mobile topbars (56px + search row).

## 2.5.13 — Test suite (`specs/06` — entire spec)

**Acceptance criteria — every case below must fail loudly on regression:**

- **P&L calculations** (9 cases): fixture match, weekly Mon–Sun in club tz, rounding half-up, line ordering, YTD sum, prior-year null, basis switch, no-span cash fallback, camp Jul 28–Aug 3 = 4/7 in July.
- **Partial periods** (6 cases): mid-month flagged, mid-week flagged, excluded from rolling avg, never comparison base, monthly averages use complete months, last-day-23:59-club-tz not flagged.
- **Stripe fees + payouts** (7 cases): Stripe charge once, payout deposit not double-counted, payout in excluded, 10-day unmatched → reliability, fees are direct cost, missing fee data counted, cash-on-hand includes in-transit once.
- **Refunds** (4 cases): reduces revenue in settle period, own P&L line, cross-period doesn't corrupt closed, refund rate triggers alert.
- **Bank transfers + equity** (7 cases): matched pair excluded both sides, appears in cash-flow excluded, transfer to unconnected NOT a transfer, owner contributions/distributions financing, loan proceeds/payments financing, known-schedule loan splits interest, `reports.owner_equity` denial removes lines + doesn't leak via total.
- **Cash + offline** (3 cases): cash revenue in totals + cash/offline line, no cash in range → `CASH_DATA_NOT_INCLUDED`, comp records $0 doesn't distort ARPA.
- **Churn** (12 cases): the 12 rules in `specs/06` §churn.
- **Imports** (21 cases): idempotent members, idempotent transactions, dedupe by fingerprint, external ID auto-matches, similar name never, ID→2 goes to review, contradicting HIGH → review, phone-matches-staff → LOW review, five outcomes write correctly, merge never overwrites non-empty native, imports trigger no email/invite/billing/campaign, undecided rows survive commit as PENDING_REVIEW, rollback within 30 days, rollback leaves alone activity, rollback after 30 days refused, rollback refused for non-owners, audit log one row per CSV line, errors.csv contains originals + error col, 50k works, 50k+1 rejected.
- **Fixed vs variable** (5 cases).
- **Break-even + unit economics** (7 cases): fixture match, non-positive contribution null + message, gap signed correctly, zero athletes null not NaN, CAC null on no marketing, LTV:CAC null when either input null, estimated fields carry flag.
- **Permissions** (6 cases): every one of 10 keys enforced server-side, partial P&L nulls affected totals, coach sees own only, `reports.by_coach` denial → 403, tier gate returns `UPGRADE_REQUIRED`, hidden tabs unreachable by direct URL.
- **Missing / incomplete data** (7 cases): runway null on no bank, zero burn null, uncategorized → deep link works, historical incomplete names specific gap, sync >24h → STALE, <3 months → forecast null, every reliability href resolves to real route.
- **Mobile** (9 cases): tab scroll at 375px, KPI 4→2→1, sticky first column, no page horizontal scroll at 375/414/768, no number clipped without full view, ≥44×44 targets, reliability+alerts visible+legible at 375, sticky headers don't collide with topbars, tap opens drill sheet.
- **Regression guard**: `/dashboard/financials` renders unchanged; API responses byte-identical before and after (snapshot test).

**Phase 2.5 exit criteria:**
- Every acceptance criterion above ✅ green.
- `PROGRESS.md` "Phase 2.5" section closed with dated entry.
- Migrations M9–M15 applied and confirmed via `_prisma_migrations` bookkeeping.
- Regression: no route in `/dashboard/financials/*` returns a different byte payload than pre-2.5.
- Owner sign-off on: choice between Snapshot Tab 1's status treatment options; report handoff `Open decisions` section.

---

# PHASE 3 — Communications and Email

**Goal:** An owner or authorized staff member can create a professional email and send it to exactly the right group of members — without HTML knowledge, without duplicate sends, and without leaking one family's information to another.

Two entry points must be supported:
- **Targeted messages** from the Members page
- **Advanced campaigns** from the Communications page

## 3A. Email Members Directly From the Members Page

Owners and authorized staff can select members from the Members List and send a custom email.

**Selection must support:**
- One member
- Multiple members
- All members on the current page
- All members matching the current filters
- Clearing the selection
- Reviewing recipients before sending

**Filterable/emailable groups include:**
- Active members
- Inactive members
- Prospects
- Not invited
- Invited
- Migration in progress
- Completed migration
- Members with a specific membership
- Members in a specific program
- Members assigned to a specific coach
- Members within an age group
- Parents or guardians
- Athletes
- Members with unpaid balances
- Members attending a specific class or event
- Members who have not attended recently
- Members whose memberships are expiring
- Custom manually selected groups

Add a clear bulk action: **Email Selected Members**

**Before opening the composer, show:**
- Number of selected member profiles
- Number of unique email addresses
- Members without an email address
- Duplicate or shared family email addresses
- Any recipients excluded for permissions, unsubscribes, or invalid addresses

**Household logic:** one parent email may manage multiple children. Do not send duplicate copies to the same address unless the sender deliberately chooses one message per athlete.

**Sender chooses between:**
- One email per unique household email
- One email per selected member
- One email per athlete's primary contact

Clearly preview how many actual emails will be sent.

## 3B. Rich Email Composer

A simple visual editor requiring **no HTML knowledge**, on both the Communications page and Members page.

**Content blocks:**
- Subject line
- Preview text
- Headings
- Subheadings
- Paragraph text
- Bold / italic / underlined text
- Bulleted lists
- Numbered lists
- Buttons
- Clickable links
- Images
- Club logo
- Dividers
- Spacing
- Contact information
- Social media links
- Call-to-action sections

**Editor capabilities:**
- Drag-and-drop or easy image uploads
- Image resizing
- Image alignment
- Alternative text for accessibility
- Link editing
- Undo and redo
- Desktop preview
- Mobile preview
- Test email
- Save as draft
- Duplicate message
- Save as template
- Schedule for later
- Send now

**Never allow unsafe HTML, scripts, or externally injected code.**

## 3C. Email Templates

Reusable templates for common club communication:
- General Announcement
- Practice Cancellation
- Schedule Change
- Event Registration
- Camp Promotion
- Membership Expiration
- Payment Reminder
- Migration Invitation
- Welcome Email
- Free Trial Follow-Up
- Weather Closure
- Tournament Information
- Fundraising Announcement
- Custom Blank Template

**Owners can:** create, edit, duplicate, and archive templates; set a default club header and footer; auto-insert club logo and contact information.

Staff access to templates follows communication permissions.

## 3D. Dynamic Recipient Groups

The Communications page lets owners and authorized staff build recipient groups from filters:
- Membership status
- Membership type
- Program
- Attendance
- Age
- Graduation year
- Location
- Coach
- Migration status
- Invitation status
- Payment status
- Event registration
- Class registration
- Relationship type
- Account role
- Tags
- Custom selections

**Filters must combine**, e.g.:
- Active middle-school members who have not attended in 14 days
- Parents of athletes registered for a specific event
- Members whose memberships expire within 30 days
- Invited members who have not completed migration
- Athletes enrolled in a specific program at a specific location

Show the estimated recipient count as filters are added. Allow saving a filtered audience as a reusable group. **Saved dynamic groups update automatically** as members start or stop meeting the criteria.

## 3E. Family and Relationship-Aware Communication

The system must understand family relationships and account management.

**Sender chooses the target:**
- The athlete
- The primary parent or guardian
- All authorized guardians
- The payer
- The account holder
- All linked family contacts
- One email per household
- Every selected profile individually

**For minors, default to the authorized guardian** unless club settings and permissions allow direct athlete communication.

Clearly show which recipient address was selected for each member.

## 3F. Personalization

Safe personalization fields:
- Member first name
- Athlete first name
- Parent or guardian first name
- Membership name
- Membership expiration date
- Outstanding balance
- Event name
- Class name
- Coach name
- Club name
- Club contact information
- Registration link
- Payment link
- Migration link

Example: `Hi {{guardian_first_name}}, Kellen's membership expires on {{membership_end_date}}.`

- Warn when a personalization field is unavailable for some recipients.
- Allow previewing the message as a specific recipient before sending.
- **Never expose another family's information through incorrect personalization.**

## 3G. Communication History

**Each member profile shows:**
- Email subject
- Date and time sent
- Sender
- Recipient address
- Delivery status
- Open status, when available
- Link-click status, when available
- Failed or bounced status
- Unsubscribed status
- Related campaign
- Related event or membership
- Message preview

**From the member profile, authorized users can:** view the full message, resend it, send a new email, copy the message, and see why delivery failed.

**The Communications page shows campaign-level results:**
- Intended recipients
- Emails sent
- Delivered
- Opened
- Clicked
- Bounced
- Failed
- Unsubscribed
- Skipped because no email was available

**Never claim an email was opened when tracking is unavailable or blocked.**

## 3H. Drafts, Scheduling, and Approval

Communications can be: saved as drafts · scheduled for a future date and time · canceled before sending · duplicated · sent immediately · submitted for owner approval.

Consider an optional approval workflow where certain staff roles draft emails but an owner or administrator approves the final send.

Scheduled messages use the club's timezone and clearly display the scheduled time.

**Prevent duplicate sends** caused by retries, page refreshes, job restarts, or repeated clicks.

## 3I. Unsubscribes and Required Messages

Support unsubscribe preferences for promotional and general marketing messages.

**Do not allow unsubscribing from essential transactional messages** where legally and operationally appropriate:
- Payment receipts
- Password-reset emails
- Event registration confirmations
- Membership purchase confirmations
- Account-security notices

**Clearly distinguish:** marketing emails · general club announcements · program updates · transactional emails · emergency or safety notices.

Honor unsubscribe preferences and keep an audit log of preference changes.

## 3J. Attachments, Links, and Images

Supported content: JPEG · PNG · PDF · registration links · calendar links · payment links · website links · social media links.

- Apply reasonable file-size and file-type limits.
- Scan or validate uploaded files where supported.
- **Never allow executable files or unsafe attachments.**
- For large files, prefer secure hosted links over oversized attachments.

## 3K. Deliverability and Sending Safeguards

**Pre-send checks for:**
- Empty subject
- Empty message
- Invalid email addresses
- Duplicate addresses
- Recipients without email addresses
- Unsubscribed recipients
- Excessively large images
- Broken personalization fields
- Missing sender identity
- Missing club contact information

**Final review screen shows:** subject · sender · reply-to address · recipient count · excluded recipient count · message preview · scheduled time · whether tracking is enabled.

Use idempotency so the same campaign cannot accidentally send twice. Large campaigns run through a reliable background job with progress and failure reporting.

## 3L. Permissions

Add or verify permissions for:
- View communications
- Create drafts
- Send individual emails
- Send bulk emails
- Use marketing audiences
- Manage templates
- Upload images
- Schedule campaigns
- View analytics
- Approve campaigns
- Manage unsubscribe settings

Owners have full access. Staff access only what their role explicitly allows. **Example:** a coach may email athletes assigned to their program without seeing the entire club's member list or financial information.

## 3M. Mobile and Tablet

- Member selection stays usable.
- Recipient count stays visible.
- Composer toolbar does not run off-screen.
- Images are easy to upload and resize.
- Desktop and mobile previews are accessible.
- Draft and send actions stay visible.
- Tables scroll where necessary.
- Sending confirmation dialogs fit within the screen.
- **The editor must not lose content when the device rotates or the page refreshes.**

## 3N. Testing — Communications

Cover:
- Emailing one member
- Emailing multiple members
- Emailing all filtered members
- Shared guardian emails
- Multiple children under one parent
- Unique-household vs. per-athlete delivery
- Missing email addresses
- Invalid email addresses
- Unsubscribed recipients
- Dynamic groups
- Personalization fields
- Image uploads
- Links and buttons
- Draft saving
- Scheduled sending
- Approval flow
- Duplicate-send prevention
- Delivery failures
- Communication history
- Staff permissions
- Coach-restricted audiences
- Mobile and tablet layouts

**Document at the end of this phase:** email provider and sending flow · database/schema changes · background jobs added · email tracking limitations · file-upload limitations · new permissions · required environment variables · manual testing steps · deployment order · rollback plan.

---

# PHASE 4 — Client and Family Accounts

**Goal:** One parent login can cleanly manage multiple athletes — including buying a membership and assigning it to the right kid — without duplicate records or broken relationships.

## 4A. Membership Assignment Between Linked Family Members

**Problem:** A parent purchases a membership under their own profile and cannot assign it to a linked child.

**Real case:** Michael Lister created his own profile and purchased a membership under it. His son Kellen is already linked to his account. The membership cannot currently be moved or assigned to Kellen.

Both authorized staff **and** the client account holder should be able to transfer or assign an eligible unused membership to a linked family member.

**The transfer flow must:**
- Show the current membership owner
- Show eligible linked family members
- Explain whether the transfer is allowed
- Confirm the new athlete receiving the membership
- Preserve payer and payment information
- Preserve the original transaction and receipt
- Record who performed the transfer
- Record the date and reason
- Prevent accidental duplicate memberships
- Prevent transferring a membership after usage when club rules do not allow it

**Do not rewrite payment ownership.** The payer stays Michael while the membership beneficiary becomes Kellen.

**Clearly distinguish these roles:** payer · account holder · membership owner · athlete using the membership · guardian or manager.

Add confirmation messaging before and after the transfer.

## 4B. Same-Email Family Onboarding

**Problem:** Multiple family members onboarded under the same guardian email do not link correctly.

**Real case:** Michael's second son, Cameron, was onboarded using Michael's email. The account could not be linked correctly. A staff-created relationship was added, but Cameron still did not appear on Michael's profile.

**A parent or guardian must be able to manage multiple athletes under one email address. Do not treat a shared email as proof of duplicate records.**

The data model and UI must support:
- One login managing multiple athlete profiles
- Separate athlete records
- Shared guardian email
- Individual birthdays and profile information
- Separate memberships
- Separate attendance
- Separate bookings
- Separate waivers when required
- Shared or separate payment methods, based on permissions

When staff adds a relationship, the linked person must **immediately** appear in the Family and Relationships section of both profiles. Fix any stale-cache, query, authorization, or relationship-direction issues preventing this.

## 4C. Relationship Visibility and Permissions

**For every linked relationship, show:**
- Person's name
- Profile image
- Relationship type
- Who manages whom
- Who can book
- Who can pay
- Who can sign waivers
- Who receives emails
- Relationship status
- Date linked

**Relationship actions:** View Profile · Edit Relationship · Confirm Relationship · Remove Relationship · Transfer Management · Assign Membership · Book for This Athlete

**Not every staff role should automatically be able to edit family or financial relationships.** Respect staff permissions throughout.

## 4D. Testing — Family Accounts

Cover:
- Parent with one child
- Parent with multiple children
- Multiple children sharing one guardian email
- Child linked after onboarding
- Child linked before onboarding
- Membership purchased by parent and assigned to child
- Membership transferred by staff
- Membership transferred by client
- Relationship removed
- Duplicate relationship attempt
- Reciprocal profile visibility
- Guardian permissions
- Staff permissions
- Unused vs. already-used membership transfer rules

---

# PHASE 4.5 — Members Full Design Handoff

**Source of truth:** `docs/improvement/design_handoff_members_experience/` — `README.md`, `Members Experience Redesign.dc.html` (sections `1a`–`1k`), `Current Experience — Members.dc.html` (baseline). Every sub-phase below cites the section it lands.

**Goal:** the three areas of the dashboard — members list (`/dashboard/members`), member profile (`/dashboard/members/[id]`), migration (`/dashboard/members/migration`) — read a single vocabulary that never conflates status, and the next action lives next to the person, not one profile-click deep.

**Core problem being fixed (from `README.md`):** one vocabulary was doing three jobs. A paying member mid-migration read as "Prospect · Un-invited." The redesign splits status into three independent tracks that **never share vocabulary** and puts `nextAction(member)` next to every person.

**Owner-approved adjustment (2026-07-29):** every 4.5.x sub-phase below has explicit mobile acceptance criteria. Sub-phase 4.5.9 remains as the cross-cutting audit + regression pass, not as the first time responsive gets attention.

## 4.5.1 — Status model + `nextAction` resolver (`README.md` "The status model", "Migration steps"; suggested build order §1)

**This is the foundation. Everything else in Phase 4.5 depends on it.**

**Three independent tracks — no shared vocabulary:**

- **Track 1 — Role** (neutral chip, `10.5px/600` uppercase, `#F1F1F3` on `#4B5563`): values `ATHLETE`, `PARENT / GUARDIAN`, `ACCOUNT HOLDER`, `MINOR · <age>`, `STAFF`. **A person can hold several** (e.g. `ATHLETE · PARENT`). Derived from: has subscriptions/attendance → Athlete; on the other side of a PARENT/GUARDIAN relationship → Parent; owns payment method / is billed → Account holder; `isMinor` → Minor.
- **Track 2 — Membership** (the only saturated pill in a row, `11.5px/500`, radius `999px`):
  - `Active` (`#A3E635` on `#1F1F23`) — active paid subscription, or live staff trial
  - `Pending · not charged` (`#EDEBFF` on `#4F46E5`) — subscription pending or imported plan not yet confirmed
  - `Prospect` (`rgba(109,93,246,.1)` on `#5948E8`) — **never held a membership** — nothing else
  - `Paused` (`#FFF1E6` on `#B45309`) — `status = PAUSED`
  - `Inactive` (`#F1F1F3` on `#6B7280`) — had a membership, lapsed/cancelled
  - **Hard rule:** a member who came from an import is **never** Prospect. Retire the `MIGRATING` bucket from Track 2 — it moves to Track 3.
- **Track 3 — Account setup** (6px dot + label, `12.5px`, **never a pill**, optionally with 7-segment meter):
  - `Not invited` (`#9CA3AF`), `Invited · N days ago` (`#FF6A00`), `Setting up` (`#6D5DF6`), `Profile created` (`#6D5DF6`), `Complete` (check icon, `#4D7C0F`), `Blocked · <reason>` (`#DC2626`).
  - **Retire "Un-invited" for manually-added members** — they're `Profile incomplete` (existing logic).
  - **Retire "Profile completed (reviewed)"** everywhere.

**Migration meter — 7 segments, 11–12px × 3–4px, 2px gap, radius 2px:**
1. Imported · 2. Information reviewed · 3. Invitation sent · 4. Member started setup · 5. Profile completed · 6. Membership confirmed · 7. Migration complete.

Filled segments `#1F1F23`; current step `#FF6A00` (waiting on member), `#DC2626` (blocked), `#B45309` (waiting on staff); remaining `#E5E7EB`; complete rows all `#A3E635`. Always accompany with `Step N of 7` + whose turn (`waiting on member` / `waiting on you` / `Nobody`).

**Acceptance criteria:**
- `lib/memberDisplay.ts` exports `serializeMemberForList(member): { tracks: {role, membership, accountSetup}, nextAction: {label, kind, permission}, ...member }`.
- `nextAction(member)` — **one function, shared by row action + banner + mobile card**. Returns `{ label, kind, permission }`.
- Derivation server-side in `GET /api/members` and `GET /api/members/[id]` and `GET /api/members/migration`. Two staff never see different counts.
- Existing `displayStatusOf` + `onboardingStatusOf` in `app/dashboard/members/page.tsx` deleted (or wrapped as `@deprecated` for one migration).
- No hardcoded vendor names anywhere — `Import.sourceLabel` (owner-typed, from Phase 2.5.9) is the only source of a legacy-system label. When blank, copy degrades to "As imported" / "imported <date>" / "your previous system".
- **Deprecations retained in schema, removed from UI:** `migrationGroup` (letter groups A/B/C, `LEAVE_ALONE`/`FUTURE_FOLLOW_UP`/`NEEDS_PAYMENT_METHOD`), `migrationFinalAction`, `readiness`/`readinessLabel`/`readinessReasons`, `GROUP_FILTERS`, `READINESS_FILTERS`. Their information now comes from Track 3 step + whose-turn.

**Migrations required:**
- **M17**: `Member.reviewedAt DateTime?` + `Member.reviewedByUserId String?` — the migration step-2 "Information reviewed" fact. Backfill from existing `setupComplete`/`setupBy`/`setupAt`.
- **M18**: `Member.blockedReason` enum + `Member.snoozedUntil DateTime?` — drives Blocked state and "Snooze 7 days" banner.
- **M19**: `MemberInvitationDelivery` — one row per invitation send: `{ id, clubId, memberId, sentAt, deliveredAt?, openedAt?, bouncedAt?, bounceReason?, provider, providerMessageId? }`. Drives Blocked ("3 sends, never opened") and the invitation-step "delivered/opened/bounced" surface.

**Acceptance criteria — mobile:**
- 4.5.1 is a library sub-phase (server-side derivation + resolver). Mobile surfaces begin in 4.5.2. This sub-phase has no user-facing UI to render.

## 4.5.2 — Members list (`README.md` §1a Members list)

**Acceptance criteria:**
- Content padding `28px 32px 40px`; full width (no `max-w-7xl` cap — must work for a 5,000-person club); `gap 18px` column flex.
- **Header** — `PageHeader` with title "Members", description `"<total> people · <mid-migration> mid-migration · <prospects> prospects"`. Actions right (10px gap): `Export` (outline + download icon), `Import / Migrate` (outline + upload), `Add member` (`bg-brand` white, plus icon, 500). Existing "Form settings" and "Custom fields" buttons move into Settings.
- **Work-queue strip** — 4-column grid, `gap 12px`. Each card is a saved filter that **also arms the matching bulk action**. Cards:
  - `<N> never invited` (orange), `<N> blocked` (red `#DC2626`), `<N> missing contact` (`#B45309`), `<N> possible duplicates` (brand).
- **Toolbar** (inside table card, padding `12px 16px`, bottom border):
  - Segmented person-type control: `Everyone <n> · Athletes <n> · Parents <n> · Account holders <n> · Prospects <n> · Inactive <n>`. Server-computed counts.
  - 34px search field placeholder `Name, email, phone, guardian, legacy ID`, max 300px.
  - Right side: `Filters` button (count badge, brand outline when active), sort (`Last seen`), density toggle.
  - **All six existing `<select>` dropdowns collapse into the Filters panel** (tags, membership, gender, age, custom field, setup state).
- **Active-filter chip bar** — `#FCFCFD` fill, `10px 16px`: "Filtered by" + removable chips (`#F1F1F3`, radius 6px, x icon) + `Clear all` + right-aligned `Save as view` (bookmark icon). Saved views persist per user.
- **Bulk bar** (only when selection exists) — `rgba(109,93,246,.06)` fill, brand hairline: `<N> selected`, then **`Select all N matching this filter`** (underlined link — **query-scoped, not page-scoped**). Actions right: `Send invitations` (primary), `Resend`, `Assign membership`, `Message`, `Add tag`, `⋯`. Destructive actions under `⋯` only, gated by permission.
- **Table**: header row `#FAFAFB`, 11px/600 uppercase `.06em` muted. Columns: checkbox (42px) · **Person** · **Membership** (190px) · **Account setup** (210px) · **Balance** (110px, right-aligned) · **Last seen** (120px) · actions (150px). Row divider `#F1F1F3`, hover `bg-app-bg`.
  - *Person*: 34px avatar (`#E5E7EB`, 12px/500 initials, or `profileImageUrl`), name 14px/500, meta 12px muted `Role · Minor · <who manages> · imported <date>`. **Family groups collapse** — the account-holder row gets `chevron-down`; children render indented 25px with a 2px `#E5E7EB` spine and 30px avatar.
  - *Membership*: Track 2 pill + 11px muted second line (plan, price, next charge / "Never held a membership" / "Lapsed Jun 22").
  - *Account setup*: Track 3 dot + label + 7-segment meter for anyone mid-migration + `Step 3 of 7 · waiting on member`.
  - *Balance*: `—` when nothing owed; owed amounts 13px/600 `#B45309` + 11px `2 mo overdue`.
  - *Actions*: **one** recommended next action as 12px outline button (brand outline when primary: `Resend invite`, `Fix email` on charcoal, `Assign membership`, `Win back`, muted `Leave alone`) + 28px `⋯` button.
- **`⋯` menu** — 238px popover, radius 10px, padding 5px, items 13px + 14px lucide icon + 9px gap, hover `#F7F7F9`, dividers `#F1F1F3`. **Fixed order, identical everywhere**: View profile · Edit member · Resend invitation · Send password reset · Continue migration — Assign membership · Add relationship · Check in to class — Archive member. **Permission-gated items stay visible, greyed with lock icon + role badge** (never hidden).
- **Footer** — `#FAFAFB`: `Rows 1–50 of 1,284 · sorted by last seen`, Previous/Next, A–Z jump. **Server-side search/sort/pagination mandatory. Counts come from the query, not the loaded page.**

**Acceptance criteria — mobile (partial preview of §1j; full walkthrough at 4.5.9):**
- Table swaps to card list below `md` (per `README.md` §Responsive rules). One card per person, 44px avatar, name + meta stacked, Track 2 pill + Track 3 dot on second line, 44×44 `⋯` target.
- Header actions (`Export`, `Import`, `Add member`) collapse into a `⋯` overflow menu at `<sm`, keeping `Add member` (primary) as its own visible pill.
- Work-queue strip 4-column → 2×2 at `sm` → 1-column at `<sm`.
- Person-type segmented control: horizontal scroll below `sm`.
- Filters panel: full-screen sheet below `md`.
- Active-filter chip bar wraps to multiple lines; `Clear all` link stays visible.
- Bulk bar: sticks to bottom of viewport on mobile with `env(safe-area-inset-bottom)`.
- Pill FAB (`user-plus` + `Add`) 78px above bottom nav.
- Family collapse: 3-child family cards render as a single card with a "3 more in family" chip that expands inline.
- No horizontal page scroll at 375, 414, 768 px.

**Backend acceptance:**
- `GET /api/members?page&pageSize&search&filter[key]=&sort` — server-side paginated + searched + sorted. Response: `{ members[], pagination: {total, page, pageSize}, counts: {everyone, athletes, parents, accountHolders, prospects, inactive, mid_migration} }`.
- Each row carries `{ tracks, nextAction }` from 4.5.1.
- **Query-scoped selection**: bulk endpoints accept `{ mode: 'ids'|'allMatching', ids?, filter?, count? }`. Never send 500 IDs.
- Filters/sort/segment/page in the URL. `Save as view` writes to `SavedMemberView`.

**Migration required:**
- **M20**: `SavedMemberView` — `{ id, userId, clubId, name, filters: Json, sort, createdAt }`.

## 4.5.3 — Member profile (tabs variant) (`README.md` §1c Member profile — tabs)

**Chosen variant: `1c` tabs (per plan.md open-decisions default). Reserving `1d` scroll+rail as the tablet variant.**

**Acceptance criteria:**
- Content max 1192px. Order: back link → identity header → family switcher → next-action banner → tabs → 2-column body (`1.55fr / 1fr`, gap 16px).
- **Identity header**: 64px avatar; name 25px/600 `-0.02em`; Track 2 pill; role chips; Track 3 dot+label inline. Meta line 13px muted `gap 2px 18px`: plan & price · joined · **DOB with 11px lock icon** · legacy ID. Right actions: `Message`, `Password reset` (outline + 14px icon), `Edit member` (primary), `⋯`.
- **Family switcher** — **single instance** on the page. White card, padding `9px 12px`; 11.5px/600 uppercase family name; segmented control of family members with 20px avatars, current person marked `viewing`, others annotated (`parent · pays`, `athlete`); right-aligned `Manage family & access →`. **This replaces every other "managed member" selector on the page.**
- **Next-action banner**: `#FFF7ED` on `rgba(180,83,9,.22)`, radius 10px, clock icon `#B45309`. Title 13.5px/600 names blocker + whose turn. Body 12.5px muted: evidence (how many sends, which address, when) + reassurance ("keeps training, keeps billing on his existing date"). 1–3 action buttons right (`Resend invitation` on charcoal, `Try a different email`, `Snooze 7 days`). **Renders only when something is outstanding.** Derived from same `nextAction()` resolver.
- **Tabs** (13.5px, active `text-brand` + 2px brand underline): Overview · Personal info · Memberships · Family & access · Attendance · Payments · Bookings · Messages · Documents · Migration activity · Notes. Counts in 11px; 6px `#DC2626` dot advertises a problem (missing waiver).
- **Left column (Overview tab)**:
  - **Migration progress card** — 7 equal columns, 4px bars, label + date/actor under each. Footer: "Nothing has been charged in AthletixOS…" + `Full migration activity →`.
  - **Contact & identity card** — **3-icon ownership legend** (pencil = you can edit, refresh-cw = member keeps it current, lock = locked). 2-col field grid.
  - **Recent activity** list with 24px tinted icon tiles.
  - **Locked birthday row** (span 2, `#FAFAFB` on `#EFEFF2`, radius 8px): lock icon, `Birthday`, value 13px/500, `LOCKED` chip, 11.5px explanation:
    > *"Birthdays set age brackets, waivers and minor rules, so staff can't change them. <Guardian> updates it in the member portal under Profile → Personal details. Wrong date blocking a signup? Ask them to fix it there, then refresh."*
- **Right column**:
  - **Account & security** card: portal login state, who they log in as, last login, `Password — never visible to staff`, tinted block: "Send password reset link" + address + 60-minute expiry + attribution + button.
  - **Money** card.
  - **Attendance** card (3 figures).
  - **Waivers & documents** with `<N> missing` in `#B91C1C` + `Request` action.
  - **Staff notes** (staff-only, attributed).
- **Payments tab** wires the drill-through from Phase 2.5.4 (`/api/reports/pnl/drill?line=…&memberId=…`).
- Extended `GET /api/members/[id]` include: `guardianLinks: { include: user }` + `user: { include: { guardianOf: { include: { member: true } } } }` — the Cameron-symptom fix from Phase 4B (folds in if it hasn't shipped yet).

**Acceptance criteria — mobile:**
- Identity header: 56px avatar (down from 64px), name wraps to two lines rather than truncating, right actions collapse behind `⋯` at `<sm` (only `Message` visible).
- Family switcher: 3-up segmented control below `md`, single-select dropdown at `<sm`.
- Next-action banner: full-width, actions stack vertically below `<sm`, primary action at 44px height.
- Tabs: horizontally scroll below `md`, active tab centered.
- Two-column body stacks 1-column below `lg`, left column above right (Migration progress + Contact + Recent above Account & security + Money + Attendance).
- Locked birthday row: `-mx-3` bleed to card edge on mobile for visibility.
- Every action button ≥44×44.
- No horizontal page scroll at 375, 414, 768 px.

## 4.5.4 — Edit member drawer (`README.md` §1e Edit member)

**Acceptance criteria:**
- 560px drawer/modal, radius 14px.
- Header (title + subtitle) → **brand-tinted info strip**:
  > *"<Name> is **mid-migration**. Fix anything that came over wrong in the import — it saves straight away and won't restart their setup. Every change is attributed to you in migration activity."*
- Grouped fields (`Identity`, `Contact`, then locked block, then `Relationship`) → footer (`#FAFAFB`) with `Saved as <staff> · logged to migration activity`, `Cancel`, `Save changes`.
- Label 12px/500 with 5px gap; input padding `8px 12px`, radius 8px, 14px text; helper 11px muted.
- **Corrected-field affordance**: history icon + `Imported as "607329885" · corrected by Dana R. Jul 8` + a `Revert` link.
- **Locked block**: `#FAFAFB` on `#EFEFF2`, radius 10px, header lock icon + `NOT EDITABLE BY ANYONE AT THE CLUB`. Contains:
  - Birthday: dashed `#D7D7DC` field, `#F4F4F6` fill, lock icon, age on the right, portal explanation, `Ask <guardian> to fix it` and `Copy portal link`.
  - Password: dashed field of dots, "Never visible or settable by staff", `Send password reset link`.
- **Rules:**
  - Editing an email **re-points the pending invitation, never silently re-sends**.
  - Edits never reset migration progress.
  - Every write is attributed (writes to `MemberMigrationEvent`).

**Acceptance criteria — mobile:**
- Drawer opens full-screen at `<md` (not 560px overlay).
- Info strip stays visible at the top.
- Field groups stack 1-column below `md`; 44×44 tap targets on every input.
- Locked block: dashed field renders at least 48px tall so the lock icon + label + age fit.
- Footer sticky to bottom with safe-area inset; `Cancel` and `Save changes` at 44×44.
- Every corrected-field `Revert` link ≥44×44 tap target.

## 4.5.5 — Password reset (`README.md` §1f Password reset — three states)

**Copy is final; use verbatim.**

- **Confirm dialog (412px)**: 38px brand-tinted icon tile (`key-round`); title "Send password reset link?"; body *"We'll email a secure link to **<email>** — <Name>'s guardian. It works once and expires in 60 minutes."*; grey note: *"You won't see the new password, and this doesn't change <Name>'s membership, bookings or migration status. Sent as **<staff>** and recorded in their activity log."*; `Cancel` / `Send link`.
- **Success dialog**: lime-tinted check; **"Password reset email sent successfully"**; *"Sent to **<email>** at 2:14 PM. The link expires at 3:14 PM."*; note with spam advice + `send to a different email`; **`Resend in 0:58`** (disabled, live countdown) / `Done`.
- **No email dialog**: `#FEF2F2` tile with `mail-x`; **"This member does not have an email address on file"**; *"<Name> has no email, and no guardian is linked to his account — so there's nowhere to send a reset link."*; red-tinted note with bounce history; `Add an email address` (primary), `Link a guardian`, `Close`.

Reuses existing `/api/auth/reset-password` machinery — sub-phase is UI-only.

**Acceptance criteria — mobile:**
- Dialogs render as bottom sheet at `<sm` (not centered 412px modal).
- Buttons stack vertically at `<sm` with primary at 44px height.
- Live `Resend in mm:ss` countdown stays visible and legible; disabled state is clear.
- Bounce history list scrolls within the sheet.

## 4.5.6 — Family & access (`README.md` §1g Family & access)

**Acceptance criteria:**
- Header: `<family name> family`, `<N> account holder · <N> athletes · <N> pending guardian` + `Transfer account management` + `Add relationship`.
- **Account-holder card**: 46px avatar, name 15px/600, charcoal `ACCOUNT HOLDER` chip + role chip, meta line with email, phone, card on file, who they pay for; `View profile`, `Message`.
- **Permissions table**: Person · Relationship · Manages · **Book · Pay · Waivers · Messages** (centred 15px check `#4D7C0F` or em-dash `#D1D5DB`, **editable in place**) · Status (`Confirmed` lime-tint `#3F6212` / `Pending` orange-tint `#B45309` + `Invited <date>`) · actions (`Edit`/`Remove`, or `Resend`/`Cancel` while pending). Pending rows tint `#FFFBF5`.
- **Transfer account management card**: what moves, what old holder keeps, safeguards — **owner-only by default, both adults emailed, the incoming holder must add a payment method before completion, in-flight invoices stay with the old holder, permanently logged**.
- **Staff-created relationship card**: a link a coach created at the desk appears immediately as `Pending`, attributed (`Added by Coach Ben at the desk · Jul 27`), with `Confirm`. **Grants no booking/payment rights until the adult confirms.**

**Backend acceptance:**
- Extend `MemberGuardianUser` with per-permission columns (from Phase 4C): `canBook`, `canPay`, `canWaivers`, `canMessages`. Updates are inline PATCH.
- `POST /api/members/[id]/relationships` accepts owner/staff-created relationships in `Pending` state; requires confirmation from the linked user before rights activate.

**Migration required:**
- **M21**: `MemberGuardianUser` gains `canBook Boolean @default(false)`, `canPay Boolean @default(false)`, `canWaivers Boolean @default(false)`, `canMessages Boolean @default(false)`, `status String @default('CONFIRMED')` (values: `CONFIRMED | PENDING | REJECTED`), `confirmedAt DateTime?`, `createdByUserId String?`. Backfill: existing rows → `status='CONFIRMED'`, `confirmedAt = createdAt`, all four booleans `true` (they were unrestricted before).

**Acceptance criteria — mobile:**
- Header stacks: title + counts on one row, actions on the next row at `<sm`.
- Account-holder card: 44px avatar (down from 46), name + meta stacked.
- Permissions table: swaps to card list below `md` — one card per relationship with Book/Pay/Waivers/Messages as 44×44 toggle switches.
- Transfer + Add-relationship modals: bottom sheet at `<sm`.
- Pending relationship confirm/resend/cancel buttons: 44×44.

## 4.5.7 — Migration dashboard (`README.md` §1h Migration dashboard)

**Acceptance criteria:**
- Breadcrumb → title `Migration` + subtitle (`<N> imported from your previous system · <N> fully moved over · nobody is charged in AthletixOS until they activate`) → actions (`Export plan`, `Match memberships CSV`, `Import more members`) → tabs (`Overview` · `All imported <N>` · `Duplicates` **with an orange count badge, non-blocking** · `History`).
- **Funnel card** — 7 joined segments (single border, only first/last rounded; step 7 tinted lime): `1 · Imported <N>` … `7 · Complete <N>`, each with 22px/600 count and 11px sub-line flagging the drop (`36 unreviewed`, `43 never invited`, `1 needs your yes`, `safe to stop old billing`). Below: 6px stacked progress bar (complete / in setup / invited-no-response / not invited) with legend. **Every segment is a filter. This replaces the eight unrelated KPI tiles.**
- **"Needs you" cards** — same 4-up pattern as members list.
- **Queue** — segmented by whose turn: `Needs you <N> · Waiting on member <N> · In setup <N> · Done <N>`. Columns: checkbox · Person · **Step** (meter + step name + why stuck) · Imported plan (plan, price, next billing) · **Waiting on** (pill: `You` brand-tint, `Member` orange-tint, red-tint blocked, `Nobody`) · Last invite (`Jul 12 · 3×`) · one next action + `⋯`. Bulk row above: selection count, `Send invitations`, `Assign membership`, `Mark reviewed`.
- **Cut-over advisory** — shield-check, plain-language "when can I cancel my old software?" answer tied to real numbers, plus `Cut-over checklist`.

**Deprecations enforced in UI (schema columns retained):** `migrationGroup`, `migrationFinalAction`, `readiness*` chips, `GROUP_FILTERS`, `READINESS_FILTERS` rows.

**Acceptance criteria — mobile:**
- Funnel card: 7 segments render as horizontal-scroll strip at `<md`; segment counts stay legible at 375px.
- Progress bar below funnel: full-width, legend wraps.
- "Needs you" cards: 2×2 at `sm`, 1-column at `<sm`.
- Queue tabs (Needs you / Waiting on member / In setup / Done): horizontal scroll below `md`.
- Queue table swaps to card list at `<md`; each card carries name + step meter + waiting-on pill + one primary action + `⋯`.
- Bulk actions bar sticks to bottom with safe-area inset.

## 4.5.8 — Migration detail drawer (`README.md` §1i Migration detail)

**Acceptance criteria:**
- 664px drawer over queue (staff must not lose their filter).
- Header: 38px avatar, name + Track 2 pill, `Step 3 of 7 · imported <date> · legacy <id>`, `Open full profile`, close.
- **Duplicate notice** (when applicable): brand-tinted, copy icon, evidence ("same guardian email, birthday one day apart") + `Compare`. **Non-blocking.**
- **Progress timeline**: 7 vertical steps, 11px dots (done `#1F1F23`, current ringed `box-shadow 0 0 0 3px rgba(255,106,0,.18)`, future `#fff` + 2px `#E5E7EB` border), 2px connectors. Each done step carries timestamp + actor. Invitation step embeds `Resend now` / `Send to a different email` / `Copy invite link`. Future steps explain what will happen.
- **Imported data table**: 4-col grid `118px 1fr 1fr 58px` — Field · **As imported** (header text from owner's `Import.sourceLabel` — never a hardcoded vendor name) · In AthletixOS · edit. Corrected rows tint `#FFFBF5` with old value struck through and `· fixed by <staff>`. Birthday shows lock in both value and action cell. Linked guardian shows `linked <date>` chip.
- **Footer**: reassurance line + `Assign a different plan` + `Resend invitation`.

**Acceptance criteria — mobile:**
- Drawer opens full-screen at `<md`.
- Progress timeline: 7 vertical steps compress with reduced connector spacing but keep 44×44 dot tap targets for each step's contextual actions.
- Imported data 4-column grid → 2-column at `md`, 1-column stacked at `<md` (Field / As imported → In AthletixOS → edit).
- Corrected row tint + struck-through old value stays visible on mobile.
- Footer sticky to bottom with safe-area inset.

## 4.5.9 — Mobile audit + regression pass (`README.md` §1j Mobile — 390 × 844, Capacitor shells)

**Scope note:** every earlier sub-phase (4.5.1 through 4.5.8) already ships mobile-responsive per its own acceptance criteria. This sub-phase is the **cross-cutting audit + Capacitor shell regression pass** — walk every screen at 375 × 812 (iPhone SE-ish), 390 × 844 (iPhone 14), 414 × 896, 768 × 1024, 1024 × 768, 1280 × 800. Fix any drift, verify Capacitor shell interaction, lock in with tests.

**Acceptance criteria:**
- Charcoal topbar (menu, 26px logo, Georgia wordmark, bell, 28px avatar) + existing 5-slot bottom nav (`Home · Members · Classes · Money · More`, active icon `#A3E635`, 10px/500 labels, `env(safe-area-inset-bottom)`).
- **List**: search + `Filters` with badge; person-type chips (horizontal scroll); 2-card "needs you" scroller; one card per person (radius 12px, 44px avatar, name 14.5px/600, meta + Track 2 pill + Track 3 dot); 44px `⋯` target; pill FAB (`user-plus` + `Add`) 78px above nav. **Every target ≥44px.**
- **Profile**: 56px avatar header, compact next-action banner (with `Resend` / `Call <guardian>`), family switcher as 3-up segment, 2×2 fact grid (Balance / Waiver / Last seen / Migration), section list with chevrons + debt markers, sticky bottom bar leading with **`Check in`** (current class named in label), then `Message`, `⋯`.
- **Quick-action sheet**: bottom sheet, 22px top radius, 38px handle, member header, 48px rows — `Check in to <class>, <time>` first, then View profile, Resend invitation (`3 sent`), Send password reset, Call <guardian>, Edit member, Add relationship, and a locked `Archive member` with `Owner only` badge.
- **Desk walk-in flow**: type segment (Athlete / Parent / Both) → name → minor yes/no → **link a parent** (search result card, selected state brand-outlined, explanation: *"<Parent> gets asked to confirm. Until they do, <Name> can train and check in but can't be billed."*) → two toggles (`Check in to <class> now` on, `Email the portal invitation` off) → `Add & check in`. Duplicate detection runs on save and offers existing record first.

## 4.5.10 — States, source-label enforcement, Reports integration (`README.md` §1k States, §"No hard-coded vendor names")

**Acceptance criteria — states (`1k`):**
- **Empty roster**: 56px `rgba(163,230,53,.12)` circle with `#5C8C1F` icon (matches `EmptyState.tsx`), "No members yet", never-charged reassurance, `Import a roster` / `Add one member`.
- **Empty search**: names active filters, offers spelling suggestion, `Search all <N> people` / `Clear filters`.
- **Loading**: skeleton rows stream 50 at a time; toolbar and counts stay usable.
- **Success**: never a flat "Sent 24" — `21 invitations sent` + *"3 people were skipped: 2 have no email on file, 1 was invited 4 hours ago."* + `See the 3 skipped` (filters list to exactly those).
- **Warning**: non-blocking Stripe banner that says what still works and how many people it holds up.
- **Error**: `8 invitations couldn't be delivered` → those people become **Blocked** so they stop consuming sends → `Fix these 8` / `Export list`.

**Acceptance criteria — source-label enforcement (from `README.md` "No hard-coded vendor names"):**
- **Nowhere in the UI should a specific previous-software name appear as a literal.**
- The source label comes from a single owner-entered field at import — "Where are you importing from?" — stored per import batch as `ImportBatch.sourceLabel` (Phase 2.5.9's schema).
- Echoed in: the "As imported" column header, the migration subtitle, per-member meta.
- When blank, copy degrades to "As imported" / "imported <date>" / "your previous system".
- **Grep guard**: CI test greps `web/app/**/*.tsx` for common vendor literals (`WELLNESSLIVING`, `WellnessLiving`, `JACKRABBIT`, `JackRabbit`, `ICLASSPRO`, `iClassPro`, etc.); non-empty → fail.

**Acceptance criteria — Reports integration (Phase 2.5.5 precision):**
- The `MemberInvitationDelivery` model from 4.5.1 unlocks precise churn (was ESTIMATED in 2.5.5).
- `MemberSubscription` gains an event history: **M22** — new `MemberSubscriptionEvent` model `{ id, clubId, memberSubscriptionId, memberId, kind (CREATED|ACTIVATED|PAUSED|RESUMED|CANCELED|EXPIRED|PLAN_CHANGED|REACTIVATED), fromPlan, toPlan, fromAmount, toAmount, at, actorUserId, source: enum (STRIPE_WEBHOOK|OWNER_ACTION|GUARDIAN_ACTION|MEMBER_ACTION|SYSTEM) }`. Written by every mutation to `MemberSubscription`. Powers churn's 14-day grace + plan-change detection with authority.
- Backfill: for existing subs, one `CREATED` event at `createdAt` + status-inference events. Dry-run first.
- Reports Membership tab's `reliability` flips from `ESTIMATED` to `COMPLETE` once event history is populated.

**Backend acceptance:**
- Every mutation on a migrating member logged to `MemberMigrationEvent` with actor (existing).
- No email address is invited from an imported member (Phase 2.5.10 test 6.2).

## 4.5.11 — Test suite (`README.md` §Suggested build order §7, §Permissions & safeguards)

**Acceptance criteria — every case fails loudly on regression:**

- **Status tracks**: role derivation for all 5 combinations; a person can hold multiple roles; membership pill correct for each of 5 conditions; imported member never Prospect; account-setup label correct for each of 6 states; migration meter 7 segments match state.
- **`nextAction()` resolver**: same result whether called for row action, banner, or mobile card, for each of ~12 canonical member states.
- **Server-side paging + search**: 5000-member fixture returns correct page, correct total, correct filtered count, filters compose (`personType=parent + tag=X + membership=Active`).
- **Query-scoped selection**: bulk send with `mode:'allMatching'` sends to every matching row across pages, not just the current page.
- **`⋯` menu order + gating**: same order everywhere; permission-denied items greyed with lock icon (never hidden); role badge names required role.
- **Family collapse**: 3-child family collapsed = 1 row; expanded = 4 rows with 25px indent + 2px spine.
- **Locked birthday**: staff cannot PATCH `dateOfBirth` on `/api/members/[id]`; only member/guardian via portal.
- **Password reset**: three-state dialog copy verbatim; `Resend in <mm:ss>` counts down; success writes attributable audit.
- **Family & access permissions**: unconfirmed relationship grants no book/pay/waivers/messages rights; a staff-created relationship starts `PENDING`; owner confirming triggers rights activation.
- **Transfer account management**: owner-only; both adults emailed; incoming holder must add payment method before completion; in-flight invoices stay with old holder; permanently logged (`BillingAuditLog`).
- **Migration dashboard funnel**: 7 counts sum to total; each segment filters queue correctly; deprecated columns absent from UI (grep test).
- **Migration detail drawer**: preserves parent queue's filter/scroll/selection on close.
- **Import source label**: rendered "As imported from <owner label>" when label set; degrades to "your previous system" when blank; **hardcoded vendor names grep test fails on any literal**.
- **Mobile**: 44px minimum targets throughout; sticky check-in bar; bottom-sheet quick actions; walk-in flow completes without paying.
- **Reports Membership tab precision**: after 4.5.10 backfill runs, `/api/reports/membership` returns `reliability: "COMPLETE"` instead of `ESTIMATED`; churn matches hand-computed fixture including plan-change exclusion + 14-day grace.
- **Deprecations removed from UI**: grep `web/app/**/*.tsx` for `migrationGroup`, `migrationFinalAction`, `readiness`, `readinessLabel`, `readinessReasons`, `GROUP_FILTERS`, `READINESS_FILTERS` — all empty (schema columns still present).

**Phase 4.5 exit criteria:**
- Every acceptance criterion above ✅ green.
- Migrations M17–M22 applied and confirmed via `_prisma_migrations`.
- Reports Membership tab reliability flips from `ESTIMATED` to `COMPLETE`.
- No hardcoded vendor name anywhere in the UI.
- Owner sign-off on: `1c` tabs vs `1d` scroll+rail (defaulted to tabs); person-type labels; whether Prospect is renamed; default staff permissions.
- `PROGRESS.md` "Phase 4.5" section closed with dated entry.

---

# PHASE 5 — Event Registration Confirmation

**Goal:** Every registrant — member or not, paid or free — gets unambiguous proof that they are registered, on screen and by email, exactly once.

**Applies to:** existing members · non-members · logged-in users · guest registrants · paid registrations · free registrations · registrations using a discount code · registrations made by a parent for a child.

**The confirmation page must show:**
- "You're registered" success message
- Event name
- Registered athlete or attendee
- Date and time
- Location
- Amount paid
- Payment status
- Discount applied
- Registration confirmation number
- Add-to-calendar option
- View registration option
- Return to schedule or dashboard
- Contact information for questions

**Correctness rules:**
- **Never display the success page unless registration creation actually succeeded.**
- For Stripe registrations, confirm the correct payment state before showing a final paid confirmation.
- Properly handle processing, failed, canceled, free, and offline-payment states.

**Confirmation email must include:**
- Event details
- Athlete or attendee name
- Payer name, if different
- Amount paid
- Discount
- Receipt or transaction reference
- Cancellation or refund policy
- Calendar link
- Club contact information

**Prevent duplicate confirmation emails** when webhooks or retries run more than once.

---

# PHASE 6 — Safety, Data Integrity, and Verification

**Goal:** Nothing in this release corrupts financial history, loses a member record, or exposes one family to another.

## 6A. Implementation Requirements

- Use database transactions where multiple related records must change together.
- Use idempotency for imports, payment-related actions, event confirmations, and email sending.
- Add audit logs for financial categorization, membership transfers, relationship changes, imports, merges, and staff actions.
- Preserve historical transaction records.
- Do not silently delete or merge member records.
- Do not double count Stripe payments and bank deposits.
- Do not expose one family's information to another family.
- Respect owner, administrator, staff, coach, and client permissions.
- Add loading, empty, success, warning, and error states.
- Maintain accessibility and keyboard navigation.
- Verify desktop, tablet, and mobile layouts.

## 6B. Testing Requirements

- Run TypeScript checks.
- Run linting.
- Run the production build.
- Run existing automated tests.
- Add targeted tests for the new behavior.
- Test Stripe test-mode flows.
- Test Plaid sandbox or mocked transaction flows.
- Test CSV imports with duplicate and malformed records.
- Test mobile and tablet layouts.
- Test permission boundaries.

---

## 7. Final Deliverable

When the work is complete, provide:

- Summary of what changed
- Schema and migration changes
- Backfill requirements
- New environment variables, if any
- Tests added
- Tests run and results
- Known limitations
- Manual testing checklist
- Deployment order
- Rollback plan
- Commit hashes
- Any areas that still require design or product approval
