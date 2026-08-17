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
| **2.5** | **Reports — full design handoff** (8-tab hub, drill-through, imports wizard, alerts, forecasts) | ✅ Done (2026-07-30) — see note below |
| 3 | Communications & Email | ✅ Done (2026-08-02) |
| 4 | Client & Family Accounts | ✅ Done (2026-08-03) |
| **4.5** | **Members — full design handoff** (3 tracks, list, profile, Family & access, migration redesign, mobile, imports source label) | ⬜ Planned |
| 5 | Event Registration Confirmation | ⬜ Planned |
| 6 | Safety, Data Integrity, Testing, Deployment & Final Handoff | ⬜ Planned |
| 7 | The Family Model in the Experience | ⬜ In progress |
| **8** | **Membership Structure, Entitlements & Per-Member Pricing** (one card per class, option-level terms + day grants, attendance enforcement, membership-first price tool) | ⬜ Spec written 2026-08-16 — awaiting decisions D1–D10 |

**Remaining work: 4.5, 5, 6, 7, 8.** (There is no Phase 4.6 in this plan — 4.5 is the last decimal phase.)

**The ⬜ statuses in this table are the plan's original schedule and lag reality — 4.5 and 5 have close-out entries in `PROGRESS.md`, and 7.1 is merged. `PROGRESS.md` is the current state; this table is the ordering.**

**Phase 2.5 carve-out:** 2.5.12 (mobile + responsive audit + regression pass) was deliberately held back by the owner and is the one 2.5 sub-phase not shipped. Everything else in 2.5, including 2.5.13's 238-test suite, is live. Do not re-open the rest of 2.5 to get at 2.5.12.

**Non-negotiable:** neither Phase 2.5 nor Phase 4.5 is a "future project." They are scheduled and each has full acceptance criteria below. Partial implementations of either handoff are not acceptable.

**Reports ↔ Members integration:** Phase 2.5.5 (Reports Membership tab — churn / retention / movement) and Phase 4.5's server-derived member tracks + migration timeline share a data spine. Ordering matters — see §4a below.

### 4a. Cross-phase dependencies

| Consumer | Depends on | Reason |
|---|---|---|
| Phase 2.5.5 (Membership tab, precise churn) | Phase 4.5.1 (server-derived tracks + subscription-event history) | The design handoff's own build plan says exact churn needs the member-event history from the Members redesign. Until 4.5.1 lands, 2.5.5 must return figures with an `ESTIMATED` reliability flag, never a fabricated total. |
| ~~Phase 2.5.9 + 2.5.10 (Historical imports schema + wizard)~~ | ~~Phase 4.5.10 (owner-typed `ImportBatch.sourceLabel`)~~ | **RESOLVED — no dependency remains.** 2.5.9 shipped `ImportBatch.sourceLabel` itself on 2026-07-29. See §4a-i. |
| Phase 4.5.3 (Member profile Family & access card) | Phase 4B (`GET /api/members/[id]` `guardianLinks` + `user.guardianOf` include) | The read gap for the "Cameron symptom." Phase 4B must land first or fold into 4.5.1. |
| Phase 4.5.7 (Migration dashboard funnel) | Phase 4.5.1 (server-derived tracks + step-of-7 resolver) | The funnel + queue segmentation read the derived tracks. |
| Phase 2.5.4 (P&L drill-through) | Phase 2.5.9 (`Transaction.sourceSystem` + `isHistorical`) | Drill lists include historical rows and label them by source. |
| Phase 2.5.7 (Cash flow) | Phase 1B (`PlaidTransaction` persistence) + new `PayoutMatch` | Cash flow reads bank ledger + excludes Stripe payouts. |
| Phase 2.5.11 (granular permissions) + Phase 3.1.1 (`messages` sub-scopes) | Independent | Same pattern (nested JSON under existing key). |
| Phase 5.2 (server-rendered event confirmation) | ~~Phase 4.5.10~~ — **unblocked**, reads `ImportBatch.sourceLabel` directly (shipped in 2.5.9) | Registration UI never prints a vendor name the owner didn't type. Phase 5.2 no longer waits on 4.5.10 for this; it does still have to honor the same degrade-when-blank copy rules (§4a-i). |
| Reports ↔ Financials | Phase 1 | Reports **reads** Financials data; Reports must NOT modify `/dashboard/financials`. Regression test at 6.1. |

### 4a-i. Shared-migration plan for imports + `sourceLabel` is closed (2026-08-04)

The original §4a row said 2.5.9/2.5.10 and 4.5.10 would **ship `ImportBatch` in one migration** so `Member` and `Transaction` were only altered once. That is now moot, and it cost nothing:

**2.5.9 already shipped the whole `ImportBatch` model, `sourceLabel` included.** Migration folder `20260731030000_historical_imports` (applied to production 2026-07-29, sha256 `43d83724…`) created `import_batches` with `sourceLabel TEXT NULL` — the owner-typed "where are you importing from?" free text — plus `import_rows`, `member_historical_records`, the six `members` columns, and the six `transactions` columns with both partial-unique indexes. 2.5.10's wizard already writes `sourceLabel` at Step 1. `Member` and `Transaction` were altered exactly once, which is what the shared-migration plan was protecting.

**So 4.5.10 needs no migration for source-label enforcement.** Everything left in that half of 4.5.10 is read-side and copy-side against a column that already exists:

- render `"As imported from <ImportBatch.sourceLabel>"` in the column header, migration subtitle, and per-member meta;
- degrade to `"As imported"` / `"imported <date>"` / `"your previous system"` when the column is null (it is nullable, and pre-wizard batches will have it null);
- the CI grep guard over `web/app/**/*.tsx` for vendor literals.

No schema change. Do **not** write a migration to "add" `sourceLabel` — it is already in `schema.prisma` (`model ImportBatch`) and in production.

**4.5.10's own migration is `MemberSubscriptionEvent`, and nothing else.** It is unrelated to imports; it exists to close Phase 2.5.5's `ESTIMATED` churn caveat. It must contain exactly:

- new table `member_subscription_events` — `{ id, clubId, memberSubscriptionId, memberId, kind (CREATED|ACTIVATED|PAUSED|RESUMED|CANCELED|EXPIRED|PLAN_CHANGED|REACTIVATED), fromPlan, toPlan, fromAmount, toAmount, at, actorUserId, source (STRIPE_WEBHOOK|OWNER_ACTION|GUARDIAN_ACTION|MEMBER_ACTION|SYSTEM) }`;
- indexes on `(clubId, at)` and `(memberSubscriptionId, at)` — the churn query walks a club's events over a date range, and the per-sub timeline reads one subscription in order;
- the enums for `kind` and `source`;
- RLS policy for the new table, matching the pattern in `web/rls/` used by the tables added after the 2026-07-02 RLS migration.

Additive only. No column is added to `member_subscriptions` itself — the event log is a sidecar, so nothing about existing billing reads changes when it lands.

Two rules when it gets written:

1. **Name it by folder, not by `M<n>`.** The M-numbers in `PROGRESS.md` are a planning inventory and this one has already been renumbered (M22 → M28). The folder timestamp must sort after the latest applied folder (currently `20260803000000_family_accounts`).
2. **The backfill is separate and dry-run-first.** One `CREATED` event per existing `MemberSubscription` at its `createdAt`, plus status-inference events. Reports' Membership tab only flips `reliability` from `ESTIMATED` to `COMPLETE` after that backfill runs — not when the table is created empty.

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
- `MemberGuardianUser` per-permission columns **already shipped** with Phase 4's `20260803000000_family_accounts` (which absorbed the migration this sub-phase used to own). The live column names are **`canBook`, `canPay`, `canSignWaivers`, `canReceiveEmails`** — this document previously said `canWaivers` / `canMessages`, which do not exist. **Corrected 2026-08-04 (J-9): code wins.** Do not add a second pair. Updates are inline PATCH.
- `POST /api/members/[id]/relationships` accepts owner/staff-created relationships in `Pending` state; requires confirmation from the linked user before rights activate.

**Migration required: NONE.** The former M21 was folded into Phase 4's `20260803000000_family_accounts` and is already in production, with `status` defaulting to `CONFIRMED` and all four permission booleans defaulting to `true` so pre-Phase-4 rows keep their previously-unrestricted behavior. `isPrimary`, `source`, `createdByUserId`, `confirmedAt` and `revokedAt` shipped in the same migration.

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

**FIRST ITEM — dark mode (owner, 2026-08-04, J-8).** The dashboard runs in dark mode and Phase 4.5's semantic tint pairs (`warn-surface`, `danger-surface`, `success-surface`, `chip-surface`, `prospect-surface`, `pending-surface`, `hairline`, `table-chrome`) shipped as **fixed light-mode values**, which read wrong on a dark background. **This has now been deferred once already** — accepted in session 1 to keep the build moving, and explicitly re-raised by the owner in session 2. It is the FIRST item in this sub-phase, not the last: walk every members surface with `data-theme="dark"` before touching viewport widths. Each pair needs a dark counterpart under the existing `:root[data-theme="dark"]` override block in `app/globals.css`; the tints must stay distinguishable from each other (waiting / broken / settled) rather than collapsing into one grey.

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
- `MemberSubscription` gains an event history: **this sub-phase's one and only migration** (listed as M28 in `PROGRESS.md`'s inventory, renumbered from M22 — name it by folder when you write it, per §4a-i) — new `MemberSubscriptionEvent` model `{ id, clubId, memberSubscriptionId, memberId, kind (CREATED|ACTIVATED|PAUSED|RESUMED|CANCELED|EXPIRED|PLAN_CHANGED|REACTIVATED), fromPlan, toPlan, fromAmount, toAmount, at, actorUserId, source: enum (STRIPE_WEBHOOK|OWNER_ACTION|GUARDIAN_ACTION|MEMBER_ACTION|SYSTEM) }` + indexes on `(clubId, at)` and `(memberSubscriptionId, at)` + RLS policy. Written by every mutation to `MemberSubscription`. Powers churn's 14-day grace + plan-change detection with authority. **The source-label half of this sub-phase needs no migration — `ImportBatch.sourceLabel` shipped with 2.5.9 (§4a-i).**
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
- Every Phase 4.5 migration applied and confirmed via `_prisma_migrations` (`PROGRESS.md` inventory rows M23–M28 — renumbered from M17–M22 on 2026-08-02; identify each by folder, not by number).
- Reports Membership tab reliability flips from `ESTIMATED` to `COMPLETE`.
- No hardcoded vendor name anywhere in the UI.
- Owner sign-off on: `1c` tabs vs `1d` scroll+rail (defaulted to tabs); person-type labels; whether Prospect is renamed; default staff permissions.
- `PROGRESS.md` "Phase 4.5" section closed with dated entry.

---

# PHASE 5 — Event Registration Confirmation + Tournament Approval & Payment Workflow

**Goal (two goals in one phase, one shared surface):**

1. **Confirmation goal (all events).** Every registrant — member or not, paid or free — gets unambiguous proof that they are registered, on screen and by email, exactly once. This closes the three concrete bugs already identified in `ARCHITECTURE-NOTES.md` §2.1 Phase 5.
2. **Tournament workflow goal (opt-in).** For events the owner marks as tournament-shaped, remove as much human intervention as possible while giving the responsible coach real control over who competes. The parent registers, an authorization or a payment method is captured up front, a coach approves / declines / proposes a change from an Action Item, the parent responds if the registration is modified, the platform escalates payment reminders as the deadline approaches, and every registration exposes both its status and who it's waiting on.

**Scope constraint (non-negotiable).** Coach approval, proposed-change flow, authorization/hold logic, and escalating payment reminders are **opt-in per event and per event type**. A weekly clinic must not require coach approval to register. The full workflow lands **default OFF for every event type**; the owner turns on whichever pieces they want per event or per type.

---

## 5.0 What already exists (audit — do not rebuild)

Ordered from strongest existing coverage to weakest.

**Data model — mostly in place.** `Event` + `EventRegistration` + `Booking` already carry payment methods, decision status, scheduled charges, offline settlement, transactions, invoicing tracking, event documents, tournament + variable-cost fields, and event bundles. Every field this phase needs for status/who-it's-waiting-on/aging is already stored except: **approver identity, approval status, proposed-change payload, reminder escalation counter, and the "opt-in per event type" columns**. Additive migrations only.

**Payment infrastructure — reusable as-is:**

- **`lib/eventPayments.ts`** — `EVENT_PAYMENT_METHODS = CARD | AUTO_CARD | CASH | CHECK`, the eight-state status model (`PENDING_PAYMENT / SCHEDULED / AWAITING_CASH / AWAITING_CHECK / PAYMENT_FAILED / PAID / REGISTERED / CANCELED`), `capacityWhere()` with `CHECKOUT_HOLD_MS`, `checkinPaymentBlock()`. **Extend this file, don't build a parallel model.**
- **`lib/eventAutoCharge.ts`** — off-session PaymentIntent charge with per-registration idempotency key (`aox-eventreg-<id>-a<attempt>`), prior-PI retrieve, metadata search for orphaned PIs, fail-CLOSED on unverifiable prior attempts, one VERIFIED Transaction + receipt + audit + `EVENT_AUTO_CHARGED` on success, `PAYMENT_FAILED` + auto-generated Checkout link + email on decline, `runDueEventCharges()` sweeper. **This is the charge engine — do not fork it.**
- **`lib/memberCard.ts`** — `resolveChargeablePaymentMethodId()` verifies a stored PM is still attached to the customer (families replace cards; stored pointers go stale); `resolveCardSnapshot()` renders "Visa ····4242 (Shannan Hall)". Reused by every consented-charge surface.
- **`lib/stripeCatalog.ts`** — reusable `ensureMembershipProduct` / `ensureRecurringPrice` pattern already exists; one-time event Products are not catalogued yet (small consistency gap, not blocking).
- **`lib/bundlePurchases.ts settleBundlePurchase`** — the ONE bundle settlement path with conditional claim + Transaction dedup on PI id. Same discipline this phase must follow for tournaments.

**Cron + sweep — the pattern to reuse:**

- **`netlify/functions/event-charges-cron.mts`** (hourly, UTC, thin wrapper) → **`/api/cron/event-charges`** (constant-time bearer compare, 503 when `CRON_SECRET` unset — never open by default) → `runDueEventCharges`. Every path is idempotent (per-reg key, PI recovery, Transaction dedupe). Registration rosters ALSO lazy-sweep on open (`limit:3`) so charges still run when no scheduler is configured. **Reminder + escalation cron follows this exact shape: `netlify/functions/tournament-reminders-cron.mts` → `POST /api/cron/tournament-reminders`. No new infrastructure.**
- **`netlify/functions/email-queue-cron.mts`** → **`/api/cron/email-queue`** — the send-queue drainer, already ships. **Every reminder + status email in this phase goes through `lib/sendClubEmail.ts` so the M16 `(sendBatchId, dedupeKey)` partial-unique index enforces "no double-send".**

**Owner surface — mostly in place:**

- **`/api/events/[id]/registrations`** (already lazy-sweeps due charges, cap 3) — the roster is the natural surface for the "who's waiting on what" column and the coach-approval affordances.
- **`/api/events/[id]/bill-registrants`** — mass-invoice engine (Stripe Checkout link + email per unpaid registrant, `invoicedAt` + `invoiceCount` incremented, SCHEDULED excluded so consented charges aren't double-billed). Owner can force re-invoice. **This is the manual escalation lever; the automatic escalation cron calls the same code path per-registrant.**
- **`lib/actionCenter.ts`** — the "command center" backbone. Read-only, permission-filtered, cached per (club,user), 20s TTL, self-clearing counts (an item disappears when the underlying record clears). Already surfaces `PENDING_EVENT_PAYMENTS`, `EVENT_PAYMENT_FAILED`, `EVENT_CHARGE_OVERDUE`, `EVENT_DUPLICATE_PAYMENT`, `TOURNAMENT_INVOICE_DUE`, `TOURNAMENT_PRICE_MISSING`. **Add one more probe per new coach-workflow state — don't build a parallel feed.**
- **`lib/reportsActionItems.ts`** — Reports Snapshot Action Items (`FAILED_PAYMENT`, `EXPIRING_MEMBERSHIP`, `OFFLINE_PAYMENT_PENDING`, `UNCATEGORIZED_LARGE_BANK`, `UPCOMING_RENEWAL_LARGE`, …) with `ActionItemSnooze` per-user snoozing. **Add tournament kinds here for snoozable-by-owner escalations that don't belong in the always-on Action Center.**
- **Owner Approvals queue** (`/dashboard/members/approvals` + `lib/approvals.ts`) — currently surfaces `GUARDIAN_LINK`, `MEMBERSHIP_CANCEL`, `MEMBERSHIP_PURCHASE`, `PRIVATE_PACKAGE_PURCHASE`, `INVOICE_SPLIT`, `MIGRATION_BILLING`. **Coach approval belongs in the Action Center (live, unresolved-count feed), not here.** The Approvals queue is for owner/staff decisions with formal member impact; coach approval is per-event coach workflow and would drown the queue.

**Notification systems — three that already exist, none is right for coach approval alone:**

- **`Message`** (DM). Real per-recipient row with `readAt`. `sendMemberMessage` fans out to member's User + all guardians. Wire coach → parent proposed-change conversations here (see §5.5) — this is the two-way channel the plan needs.
- **`Announcement` + `AnnouncementEngagement`**. Broadcast, per-recipient engagement tracking. Not per-event workflow.
- **`PendingApproval`** — member-side family kinds (`CLASS_BOOK`, `EVENT_REGISTER`, `PRIVATE_REQUEST`, `PACKAGE_BUY`, `MEMBERSHIP_SUBSCRIBE`, `PRODUCT_BUY`) already exist for the parental-controls gate. **Reuse the same replay-payload pattern for the parent's "accept the coach's proposed change" flow — it's the same problem shape.**

**Client email — reminder mechanics:**

- `EventRegistration.invoicedAt` + `invoicedCount` — already tracked when `bill-registrants` runs. This is the aging spine. **The registration currently has no `lastReminderAt` / `nextReminderAt` / `reminderStage` — add three nullable columns; the escalation cron reads them.**
- `sendPaymentReceiptEmail`, `sendBookingConfirmationEmail`, `sendPaymentFailedEmail` exist. **No `sendPaymentReminderEmail` template exists** — add one.
- `EmailOptOut` — currently scoped to `MARKETING`. Payment reminders are transactional and must not be opt-out-suppressible (already the current default — no change needed).

**What is genuinely missing (all additive):**

1. Per-event / per-event-type opt-in flags for the tournament workflow (approval, holds, escalation).
2. Coach-approver identity on the event (or on the registration).
3. Registration approval columns (`approvalStatus`, `approvedByUserId`, `approvedAt`, `declinedReason`, `proposedChange`, `proposedChangeRespondedAt`).
4. Escalation-cadence columns on `EventRegistration` (`reminderStage`, `lastReminderAt`, `nextReminderAt`).
5. A dedicated Action Center probe per new state.
6. A parent-facing "accept the proposed change / decline" surface in the member portal.
7. A `POST /api/events/[id]/registrations/[regId]/approve|decline|propose-change` mutation with idempotency.
8. `POST /api/registrations/[id]/proposed-change/respond` (parent side).
9. One hourly `POST /api/cron/tournament-reminders` cron route + Netlify wrapper (mirrors `event-charges-cron.mts`).
10. New email helpers: proposed-change, coach-declined, payment reminder (stages 1/2/final), coach-approval-needed digest to the responsible coach.
11. `Booking` gets `bookedByUserId` — the pre-existing attribution gap already flagged in ARCHITECTURE-NOTES §2.4 M19.
12. Server-rendered success confirmation surface with a **real registration confirmation number** shown on screen + in the email.

**What would be redundant to build:**

- A separate Notification model / feed. Use `Message` (per-user threads), `PendingApproval` (parent-side replay), Action Center (owner live count feed), Reports Action Items (snoozable owner feed), and `EmailSend` (per-recipient email log). Every "notification" this phase produces fits one of these five.
- A new cron system. `netlify/functions/*` + `CRON_SECRET`-gated `/api/cron/*` routes are the pattern; add exactly one route and one wrapper.
- A new payment engine. `chargeEventRegistration` is the model — coach-approval "capture on approve" reuses it verbatim by setting `scheduledChargeAt = now` at approval time. This is the same trick the SAVED_CARD path already uses.
- A new coach roster. `EventStaffAssignment` + `RecurringClass.assignedStaffIds` + `CompensationAssignment` already model coach↔event. Add ONE optional `Event.responsibleCoachUserId` scalar for "who owns approving this event"; if unset, any staff with `events:edit` can approve. Do not build a separate approver table.
- A per-event "final invoice date". `Event.registrationDeadline`, `Event.autoChargeDate`, and `Event.startsAt` already give the escalation cron three natural anchors. The `EventRegistrationPolicy` block below picks which anchor each escalation uses; no new date columns needed on `Event`.

### 5.0.1 Ownership boundary — what Phase 5 does NOT own

Phase 5 shares `EventRegistration`, `bill-registrants`, the roster, and the Stripe Checkout call with other workstreams. The table below records who owns each concern **so Phase 5 does not re-spec it**. "Phase 5 obligation" is the only thing this phase must do about that row.

| Concern | Owner | Status | Phase 5 obligation |
|---|---|---|---|
| **Event discount codes** — `EventRegistration.discount{Id,Code,Type,Value,Amount}`, `Discount.eventIds`, discount-aware `lib/eventRepricing`, code entry on `/e/[slug]` + member + staff paths, survival into `bill-registrants` and the Stripe session | **Event discount codes workstream** (branch `claude/event-discount-codes-*`; migration `20260807000000_event_discount_codes`) | Migration written 2026-08-07; implementation pending | **Do not re-spec, do not add a second discount surface, do not add discount columns.** Phase 5 consumes it in exactly two places: `RegistrationRenderContext.meta.discountLabel` (§5.2.2) reads `reg.discountCode`/`reg.discountAmount`, and the coach **propose-change** price-delta (§5.4.7) is computed on the **net** amount from `amountToCollect`, never on the event's list price. |
| **What a registration owes today** — `amountToCollect` / `expectedAmount` / `planReprice` in `lib/eventRepricing.ts` | Event repricing (shipped 2026-08-03, Frog Empire fix) | Live; being extended to be discount-aware by the row above | Never read `Event.memberPrice`/`nonMemberPrice`/`publicFixedPrice` directly to decide what someone owes. Every Phase 5 surface — roster, confirmation page, reminder email, escalation cron, `APPROVAL_CHARGE` — resolves through `amountToCollect`. |
| **Processing fee** — `lib/fees.ts` | Fees module | Live | Always compute the fee on the **discounted** amount (`amountToCollect`), never on the list price. `quotePayment` already does this; new Phase 5 charge paths must too. |
| **One discount maximum** | `lib/discounts.ts` + `lib/staffPayments.resolveStaffDiscount` | Live — structural | Stacking is refused by construction (one nullable code per registration; the engine has no stacking configuration). Phase 5 must not introduce a second discount slot, a "sibling discount" field, or an additive adjustment on top of a code. A second discount **replaces** the first. |
| **Owner-facing discount setup** | The existing discount admin (`/dashboard/memberships` → discount modal, `/api/discounts`) | Live; gains an `eventIds` checklist | Phase 5 adds **no** discount management UI anywhere in the event editor. Per-event scoping is a checklist on the existing Discount row. |
| **Off-session charge engine** — `chargeEventRegistration`, per-reg idempotency key, PI recovery | `lib/eventAutoCharge.ts` | Live | §5.1's `APPROVAL_CHARGE` reuses it verbatim. It stamps discount identity onto the `Transaction` from the registration row (today it reads the `autoChargeConsent` JSON blob — the discount workstream moves that read to the real columns). |
| **Offline settlement** — cash/check/terminal → one `Transaction` | `lib/eventOfflinePayments.settleEventRegistrationOffline` | Live | The cash prompt collects `amountDue` (net). Phase 5 must not compute its own "amount to collect at the door". |

**The invariant this table exists to protect:** the roster's "owes" figure, the invoice preview, the Stripe line item, the cash/check prompt, and every Phase 5 confirmation surface and reminder email must all print the number one resolver produced. Any Phase 5 route that computes a price itself is a bug, regardless of whether a discount is involved.

---

## 5.1 The Stripe recommendation (read this before anything else)

**Do not architect this workflow around Stripe manual-capture authorization holds.**

Stripe's card authorization has a **7-day expiry** (older cards fail sooner; certain issuers as short as 24 hours). Tournament registration routinely opens **weeks or months** before the event date and often before the coach-approval window closes. A design that assumes "authorize now, capture on approval" would silently expire authorizations on the majority of tournaments this phase targets, then either (a) fail on capture with no recourse or (b) require a fresh authorization from the parent — the exact human intervention the workflow is supposed to eliminate.

Manual-capture is the right pattern for **short-window** transactions: hotel check-in holds, car-rental deposits, ride-share auths, at-the-door pre-auth for a same-day walk-in. It is the wrong pattern for tournament registration with a multi-week approval and payment cycle.

### Recommended: saved-card + off-session charge on approval

Reuse the **exact** discipline already shipping in `lib/eventAutoCharge.ts` and `lib/bundlePurchases.ts`.

- **At registration time.** The parent selects a payment intent that is one of:
  1. **Pay now by card** (existing `CARD` path) — Stripe Checkout up front; on approval nothing more happens, they've already paid; on decline the coach declines the whole registration and a full refund is issued via existing refund tooling.
  2. **Charge my saved card on approval** (new intent `APPROVAL_CHARGE`, opt-in per event) — no charge yet; a chargeable saved card must exist (`resolveChargeablePaymentMethodId`), else the parent is prompted to add one via the existing `/api/member/payment-method/setup` setup-mode Checkout with `metadata.eventRegistrationId` so the webhook can auto-associate it back to this registration; explicit consent captured (identical shape to the existing `autoChargeConsent` blob). Registration lands `PENDING_REVIEW`, `scheduledChargeAt = null`, `paymentMethod = APPROVAL_CHARGE`.
  3. **Pay cash/check at the event** (existing `CASH`/`CHECK`). Same behavior as today; no card involved. Coach approval still gates the spot.
  4. **Bill me** (new `INVOICE` — opt-in per event, defaults off) — no card required; on approval, the registration transitions to the mass-invoice pipeline (`bill-registrants` targets it) and the escalation cron takes over.

- **At coach-approve time.** The route calls `chargeEventRegistration()` with `scheduledChargeAt = now` for `APPROVAL_CHARGE`; the existing engine handles idempotency, prior-PI recovery, exact receipt, and the `PAYMENT_FAILED` fallback path (auto-generated Checkout link + email). For `INVOICE`, the route enqueues an immediate first invoice using `bill-registrants` per-target logic. For `CASH`/`CHECK`, no money moves at approve time — the existing check-in gate handles collection.

- **At coach-propose-change time.** No money moves. The parent's saved consent is snapshot into `EventRegistration.proposedChange` alongside the coach's proposed values (whichever entry categories the club configured, the session, or one more entry — see §5.4.3). The parent accepts or declines. On accept, if the proposed change alters price (rare — an extra entry typically adds a fee), a fresh consent is required from the parent for the delta before the charge fires. On decline, the registration transitions to `CANCELED`; if a hold or authorization exists it's canceled via `stripe.paymentIntents.cancel`.

- **At coach-decline time.** No charge fires. If the parent had already paid via `CARD` up front, the refund is created via existing Stripe refund tooling; a `Transaction.refundedAmount` row goes onto the roadmap (already scheduled in Architecture §2.4 M3). If the parent had chosen `APPROVAL_CHARGE`, nothing was charged — the consent snapshot is retained for audit but never fires.

**Why this beats manual-capture:**

- No 7-day expiry window to manage.
- Every existing safety property survives — per-registration idempotency key, prior-PI recovery, fail-closed on unverifiable state, `EVENT_DUPLICATE_PAYMENT` detection, receipt + audit, `PAYMENT_FAILED` auto-Checkout-link fallback.
- Zero new payment infrastructure. `chargeEventRegistration()` is already exactly this shape.
- Same-day / walk-up tournament sign-ups can still use `CARD` (immediate Stripe Checkout) — no downside.
- Works for both members (who typically have a card on file already) and non-members (public registration flow requires a card to opt into `APPROVAL_CHARGE`; else falls back to `INVOICE`/`CASH`/`CHECK`).

**Why not a Stripe Invoice up front?** Stripe Invoices don't natively pause + resume around an approval decision, and creating one at registration time commits an invoice number even when the coach declines. The current `bill-registrants` implementation uses Checkout links, not Invoices, for exactly this reason — send-when-ready, cancelable, one-off, no invoice-number waste. Continue that pattern.

**Manual-capture holds — the one place they're the right tool.** Short-window (<7 day) reservations: same-day walk-in registration where the tournament is later that day, camp reservations where approval will happen within hours. These are rare and can be handled by the existing `CARD` path (immediate capture) with no measurable downside vs a hold. If a specific customer proves they need short-window authorization semantics later, add a fifth intent — but do not architect the whole system around them.

---

## 5.2 Confirmation goal — state-aware surface + lifecycle emails (all events, always)

These land regardless of the tournament workflow toggles. The confirmation is no longer a single "You're registered" moment — it is a **state-driven surface** that the page and email both render from one shared context resolver, and a **lifecycle of transactional emails** that keep the registrant in sync as approval, payment, and coach-proposed changes progress.

**The core rule this section enforces:** the page and every email must render from the same `renderableRegistrationState(reg, event)` context, so they can't disagree. Neither the page nor an email may print "You're registered" or "Paid" unless the underlying registration state says so. The visitor-facing status ("Awaiting coach review", "Amount due $X by Friday", "Charged $X today", "Coach proposed a change — accept or decline") is derived, never hardcoded per route.

### 5.2.1 Fix the three concrete bugs from ARCHITECTURE-NOTES §2.1 Phase 5

- **Free public path silently drops the email.** `app/api/public/events/[slug]/register/route.ts:231` returns early on the free branch before any send. Fix: route through the new `sendEventConfirmationEmail` helper (see §5.2.4) after every terminal `NextResponse.json`. Idempotency: `sendClubEmail dedupeKey = "event-confirm:<registrationId>"` — a repeat POST or a webhook retry finds the same key and skips (the M16 partial-unique index enforces this).
- **Paid public path also drops the email.** Webhook `eventRegistrationId` branch at `app/api/stripe/webhook/route.ts:822-895` sends `sendPaymentReceiptEmail` but never `sendBookingConfirmationEmail`. Fix: call the confirmation helper here too, with the same `dedupeKey`. When both the registration route and the webhook attempt a send, the partial-unique index guarantees exactly one lands.
- **Success page shows "you're registered" before the webhook writes.** `app/e/[slug]/page.tsx` and `app/member/events/page.tsx` both render green success on `?paid=true`/`?registered=true` without server confirmation. Fix by shipping the server-rendered confirmation route (§5.2.3) — it never renders success without reading the actual row.

### 5.2.2 Shared render context — one function, two surfaces

New pure helper `renderableRegistrationState(reg, event, club)` in `lib/eventPayments.ts` (extend the existing pure module — no DB, no IO). Consumed by both the server-rendered confirmation route and every lifecycle email helper. Returns:

```
type RegistrationRenderContext = {
  key: RegistrationRenderKey;           // discriminant — see the state matrix below
  headline: string;                     // e.g. "Registration requested", "You're registered — payment received"
  subheadline: string | null;           // one line under the headline
  chargeTiming: string;                 // plain-English sentence — see §5.2.7 rule
  waitingOn: "COACH" | "PARENT" | "PAYMENT" | "COMPLETE" | "CANCELED";
  waitingOnLabel: string;               // "Waiting on your coach", "Waiting on your reply", "Payment due", "You're all set", "Canceled"
  severity: "info" | "success" | "warn" | "danger";  // colors the badge on both surfaces
  meta: {
    confirmationCode: string;
    athleteName: string;
    payerName: string | null;           // rendered as "Paid by <payer>" only when payer != athlete guardian
    eventName: string;
    eventStartsAt: Date;
    eventEndsAt: Date;
    location: { name: string; address?: string; directionsUrl?: string } | null;
    amountPaid: number | null;
    amountDue: number | null;
    amountRefunded: number | null;
    discountLabel: string | null;
    receiptTransactionId: string | null;
    cardLabel: string | null;           // "Visa ····4242 (Shannan Hall)" — via resolveCardSnapshot
    chargeDate: Date | null;            // when the money moves — populated for SCHEDULED_*
    dueDate: Date | null;               // when payment is due (paymentDueBy || registrationDeadline)
    proximityBadge: "TODAY" | "TOMORROW" | "3_DAYS" | "THIS_WEEK" | null;
    proposedChange: {
      original: Record<string, unknown>;
      proposed: Record<string, unknown>;
      priceDelta: number;
      proposedAt: Date;
      coachNote: string | null;
    } | null;
    declineReason: string | null;
    escalationStage: number;            // 0..6 per §5.6
    cancellationPolicyText: string | null;
  };
  actions: {
    primary: { label: string; href: string } | null;   // "Pay now" / "Review proposal" / "Add to calendar"
    secondary: Array<{ label: string; href: string }>;
  };
};
```

**Both surfaces call the exact same resolver.** The page renders JSX around this context; every email helper renders HTML+text around this context. If a state's copy changes, it changes in one place. A test suite (`scripts/event-confirmation-state-tests.ts`, similar to `scripts/event-payment-tests.ts`) walks every discriminant and asserts headline, chargeTiming, waitingOn, and actions per state — the same shape as the existing 40-case `event-payment-tests.ts`.

### 5.2.3 Server-rendered confirmation surface — one route for every path

New route: `GET /e/[slug]/registered/[registrationId]` — server component that reads the actual `EventRegistration` row, computes `renderableRegistrationState()`, and renders exactly what state it's in. **No optimistic "you're registered" text ever, no state assumed from a URL query param.**

- If the row does not exist → 404.
- Otherwise → render the state-driven card (§5.2.6) using the shared context.
- If the row is `PENDING_PAYMENT` and less than 30 seconds old → the card shows the state key `PENDING_PAYMENT_INFLIGHT` (poll banner: "Your payment is still processing — we'll email you the moment it lands"), auto-refresh every 3s for 30s, then flip to `PENDING_PAYMENT_INFLIGHT_SLOW` copy with a support link. After `CHECKOUT_HOLD_MS` (30 min) → key becomes `PENDING_PAYMENT_EXPIRED`.

**"View registration" always reads live.** The URL `${base}/e/${slug}/registered/${regId}` is the ONE address for a registration for its entire lifetime. On the return visit after a coach approves, after a parent accepts a proposal, after the escalation cron sends a reminder, or after a charge succeeds — the page reflects the current state, not the snapshot from when the visitor first landed. This is the "no frozen snapshot" requirement: the URL is a live view, not a receipt.

**Success URL wiring.** Both `stripe.checkout.sessions.create` `success_url` (public + member) become `${baseUrlFromRequest(req)}/e/${slug}/registered/${registrationId}?src=paid`. **Use `baseUrlFromRequest`**, not `getAppBaseUrl()` — the plan already flagged this rule for the migration/reactivation flow (2026-07-13 launch-blocker batch); apply the same rule here so Netlify preview deploys don't bounce to production. `getAppBaseUrl()` is still correct for webhooks and cron. Both `/api/public/events/[slug]/register` and `/api/member/events/[id]/register` return the confirmation URL in their JSON response and the client redirects to it — never render success in the caller.

**Confirmation number.** Deterministic, human-readable, unique per registration. Recommend `EventRegistration.confirmationCode` (new column, additive) computed at row-create time as a length-8 base32 of the row id, uppercased. Reuse in-email, on-screen, in the calendar file, and as the URL segment (visible portion — the row id remains the true key). Old rows: backfill on first read (compute-and-persist if `confirmationCode is null`) so the column is always populated by the time anyone reads it.

### 5.2.4 Confirmation email — every state, one helper, one dedupeKey per lifecycle event

New helper `sendEventConfirmationEmail(ctx)` in `lib/email.ts` — accepts a `RegistrationRenderContext` and renders both HTML + plain-text bodies. Emitted through `sendClubEmail` (`lib/sendClubEmail.ts`) so it hits `EmailSend` with:

- `kind = "TRANSACTIONAL"` — per Phase 3I, transactional sends are **NOT** suppressed by `EmailOptOut` (scope `MARKETING`). A registrant with a marketing opt-out still receives their registration confirmation, coach approval, decline notice, receipt, and payment reminder. No unsubscribe link — footer says "This is a transactional notification about your registration for <event>. You'll receive one for every material change."
- `relatedEventId = event.id`
- `dedupeKey = "event-confirm:<registrationId>"` — the *initial* confirmation only.
- `sendBatchId = "event-confirm"` — fixed value; the M16 partial-unique index makes "one confirmation send per registration ever" structural.

**The lifecycle sends are each their own dedupeKey** so a state transition triggers a new email even after the initial confirmation was sent. See §5.2.5.

### 5.2.5 Lifecycle emails — one row per transition, all through `sendClubEmail`

Every follow-up email routes through the same helper. Each transition is identified by a dedupeKey shape that makes retries safe. The M16 `(sendBatchId, dedupeKey)` partial-unique index is authoritative — a re-fire, webhook retry, cron re-run, or repeated user click can never double-send.

| Transition | Trigger | Recipient(s) | Helper | `sendBatchId` | `dedupeKey` | Copy summary |
|---|---|---|---|---|---|---|
| Initial confirmation | Registration created (any path) | Registrant + guardians | `sendEventConfirmationEmail` | `event-confirm` | `event-confirm:<regId>` | State-driven per §5.2.6 |
| Coach approved | `POST …/approve` transitions APPROVED | Registrant + guardians | `sendEventCoachApprovedEmail` | `event-approved` | `event-approved:<regId>` | "Your coach approved your registration for <event>." Includes the *new* state's copy (SCHEDULED_EVENT_DATE / PAID / AWAITING_CASH) so the parent knows what happens next. |
| Coach declined | `POST …/decline` | Registrant + guardians | `sendEventCoachDeclinedEmail` | `event-declined` | `event-declined:<regId>` | "Your coach couldn't approve <event>. Reason: <owner-typed>. <refund status>." |
| Coach proposed a change | `POST …/propose-change` | Registrant + guardians | `sendEventCoachProposalEmail` | `event-proposal` | `event-proposal:<regId>:<proposedAt.ISO>` | The proposedAt timestamp keys the row so a *revised* proposal after a prior one re-notifies (the index treats them as different rows). |
| Parent accepted proposal | `POST …/proposal/accept` (auto-approves) | Registrant + guardians + responsible coach (BCC-style, separate `EmailSend` per recipient) | `sendEventProposalAcceptedEmail` | `event-accepted` | `event-accepted:<regId>:<respondedAt.ISO>` | Parent copy: same as "Coach approved" for the new proposed spot. Coach copy: "The parent accepted your proposed change." |
| Parent declined proposal | `POST …/proposal/decline` | Registrant + guardians + responsible coach | `sendEventProposalDeclinedEmail` | `event-parent-declined` | `event-parent-declined:<regId>:<respondedAt.ISO>` | "You declined the coach's proposed change. Your registration has been canceled. <refund status>." |
| Charge succeeded (APPROVAL_CHARGE / AUTO_CARD sweep / SAVED_CARD immediate) | `chargeEventRegistration` recordSuccess | Registrant | Existing `sendPaymentReceiptEmail` | `event-receipt` | `event-receipt:<transactionId>` | Keyed on Transaction id — the same PaymentIntent replayed produces the same Transaction id, so a webhook retry can't re-send. |
| Charge failed | `chargeEventRegistration` recordFailure | Registrant + guardians | Existing `sendEmail` inline (extract to `sendEventChargeFailedEmail` for consistency) | `event-charge-failed` | `event-charge-failed:<regId>:<chargeAttempts>` | "Your card charge for <event> didn't go through. Pay online below." + auto-generated Checkout link. Keyed on `chargeAttempts` (which only increments on definitively dead prior PIs) so a real second decline resends but a transient retry doesn't. |
| Payment reminder stage 1–6 | Escalation cron per §5.6 | Registrant + guardians | New `sendEventPaymentReminderEmail` | `event-remind` | `event-remind:<regId>:<stage>` | State + days-to-anchor per §5.6.1. Never sent for `PAID` / `SCHEDULED` / `PENDING_PAYMENT` / `PENDING_REVIEW`. |
| Offline payment recorded | `POST /api/members/[id]/offline-payment` linking to a reg | Registrant + guardians | Existing `sendPaymentReceiptEmail` | `event-offline-receipt` | `event-offline-receipt:<transactionId>` | "We've marked your cash/check payment for <event> as received." |
| Parent canceled | `POST /api/member/bookings/[bookingId]/cancel` for an event booking | Registrant + guardians | New `sendEventCanceledByParentEmail` | `event-canceled` | `event-canceled:<regId>` | "Your registration for <event> was canceled. <refund policy>." |
| Coach message | `POST /api/events/[id]/registrations/[regId]/message` (existing `sendMemberMessage`) | Parent | Not via `sendClubEmail` — routes through the messaging path with its own in-app + email surface | — | — | See §5.5. |

**"One row per material change" rule.** Non-material state changes (`invoiceCount++`, `lastReminderAt` updated, staff renamed) do NOT trigger an email. Material changes (approval, decline, proposal, parent response, charge success, charge failure, cancellation, each reminder stage crossed) each produce exactly one email per recipient via one dedupeKey — replays are safe, and the audit trail is the `EmailSend` history for the registration (queryable by `relatedEventId + recipientMemberId`).

**Recipient resolution.** For every send, recipients = the registrant's email + every guardian on file (via `Member.guardianLinks[].user.email` + `Member.guardianEmail` fallback for guardian-only families). Each recipient is a *separate* `EmailSend` row so the (`sendBatchId`, `dedupeKey`, `recipientEmail`) tuple deduplicates per-recipient — a guardian who's also on the athlete's row (rare — `member.email == guardian.email`) doesn't get the same message twice because `recipientEmail` is normalized to lowercase before insert. The `sendBatchId` per transition + the caller resolving recipients via `resolveRegistrationRecipients(reg)` (single helper, reused by every lifecycle send) is what prevents a mismatched dedup list from re-sending on retry.

### 5.2.6 The state matrix — page + email use the same key per row

| Key | Registration state | Headline | Charge timing (verbatim template — vars in `{ }`) | Waiting on | Primary action |
|---|---|---|---|---|---|
| `PENDING_REVIEW` | `approvalStatus = PENDING` | "Registration requested" | Depends on `approvalPaymentIntent`: **APPROVAL_CHARGE**: "Nothing charged yet. Your {cardLabel} will be charged {amount} the moment your coach approves." · **INVOICE**: "Nothing charged yet — no card required. Your club will send a payment link once your coach approves." · **CARD**: "{amount} was charged today. If your coach doesn't approve, we'll refund it in full." · **CASH / CHECK**: "You'll bring {amount} in {method} if your coach approves." | COACH | "Add to calendar (tentative)" — a calendar entry marked `TENTATIVE` per iCal semantics |
| `PROPOSED_CHANGE_PENDING` | `proposedChange != null AND proposedChangeRespondedAt IS null` | "Your coach proposed a change" | "Nothing charged yet." (unless `priceDelta > 0`, then: "If you accept, {cardLabel} will be charged an additional {priceDelta} on top of your original {amountPaid_or_due}.") | PARENT | "Review the coach's proposed change" → `/member/bookings/[regId]/proposal` |
| `SCHEDULED_EVENT_DATE` | `status = SCHEDULED AND scheduledChargeAt > now` (AUTO_CARD or approved APPROVAL_CHARGE with a future charge date) | "You're registered" | "Your {cardLabel} will be charged {amount} on {chargeDate} (event day)." | PAYMENT | "Add to calendar" |
| `PENDING_PAYMENT_INFLIGHT` | `status = PENDING_PAYMENT AND createdAt > now - 30s` | "Finishing your payment…" | "We're waiting for Stripe to confirm your payment. This usually takes a few seconds." | PAYMENT | (auto-refresh; no primary action) |
| `PENDING_PAYMENT_INFLIGHT_SLOW` | `status = PENDING_PAYMENT AND 30s < age < CHECKOUT_HOLD_MS` | "Payment still processing" | "This is taking longer than usual. You'll receive an email as soon as it lands. If nothing arrives in an hour, contact {clubContact}." | PAYMENT | "Try again" → re-create Checkout via existing route |
| `PENDING_PAYMENT_EXPIRED` | `status = PENDING_PAYMENT AND age > CHECKOUT_HOLD_MS` | "This registration expired" | "Payment wasn't completed within 30 minutes and the spot was released. You can register again to try." | CANCELED | "Register again" → back to `/e/[slug]` or `/member/events` |
| `AWAITING_CASH` | `status = AWAITING_CASH` | "You're registered" | "Please bring {amount} in cash at the event." | PAYMENT | "Add to calendar" |
| `AWAITING_CHECK` | `status = AWAITING_CHECK` | "You're registered" | "Please bring a check for {amount} at the event." + `event.club` payable-to line when configured | PAYMENT | "Add to calendar" |
| `PAYMENT_FAILED` | `status = PAYMENT_FAILED` | "Payment didn't go through" | "Your card was declined. Pay online now to keep your spot." | PAYMENT | "Pay now" → the auto-generated Checkout link stored on `paymentUrl` |
| `PAID` | `status = PAID` | "You're registered — payment received" | "{amount} was charged {chargeDate_absolute_or_"today"} to your {cardLabel}. Receipt id {receiptTransactionId}." | COMPLETE | "Add to calendar" |
| `FREE_CONFIRMED` | `status = REGISTERED AND amountDue == null` for a truly free event | "You're registered" | "Nothing owed — this event is free." | COMPLETE | "Add to calendar" |
| `COVERED_BY_MEMBERSHIP` | Free path taken because an active sub matched `event.acceptedMemberships` | "You're registered" | "Nothing owed — this event is included in your {membershipName}." | COMPLETE | "Add to calendar" |
| `REGISTERED_AMOUNT_DUE` | `status = REGISTERED AND amountDue > 0 AND paymentMethod IS null` (variable-cost billed later, or fixed-price public path pending invoice) | "You're registered" | Depends on `event.variableCostMode`: **ESTIMATED**: "Estimated share: {amount}. Your club will email a payment link with the final amount." · **OFFICIAL**: "Payment will be split after the event. Your club will email your share once the total is known." · **FIXED (public)**: "Payment of {amount} is due — your club will email a payment link." | PAYMENT | "Add to calendar" |
| `CANCELED_BY_PARENT` | `status = CANCELED AND approvalStatus != DECLINED` | "Registration canceled" | Refund state per §5.2.9: "{amount} was refunded on {refundedAt}." / "This registration hadn't been charged, so nothing to refund." | CANCELED | "Register again" (link back to the event) |
| `DECLINED_BY_COACH` | `approvalStatus = DECLINED` | "Your coach couldn't approve this registration" | Refund state per §5.2.9. If `declineReason`: "Reason from your coach: {declineReason}" | CANCELED | (none — parent may re-register with a message via `/member/messages`) |
| `CANCELED_PROPOSAL_DECLINED` | `proposedChangeAccepted = false AND status = CANCELED` | "You declined the proposed change" | Refund state per §5.2.9 | CANCELED | "Register again" |

**Rule enforced by the resolver.** For every state, `chargeTiming` MUST be one of: **charged today**, **charged when your coach approves**, **charged on {chargeDate}**, **due in {method}**, **paid**, or **nothing owed**. The resolver has a type-level exhaust check — an unhandled state key is a compile error, not a silent blank line.

### 5.2.7 On-screen confirmation card fields (every state, one shared component)

The card renders from `RegistrationRenderContext` in this fixed order. Fields render only when the meta value is present, with the exceptions in the "always visible" column.

| Slot | Source | Always visible? |
|---|---|---|
| **Status badge** (colored per `severity`) | `waitingOnLabel` | ✅ |
| **Headline** | `context.headline` | ✅ |
| **Subheadline** | `context.subheadline` | when non-null |
| **Charge timing sentence** | `context.chargeTiming` | ✅ |
| **Proposed-change comparison** (two-column: Original vs Proposed, priceDelta below) | `meta.proposedChange` | key = `PROPOSED_CHANGE_PENDING` |
| **Decline reason quote** | `meta.declineReason` | key = `DECLINED_BY_COACH` |
| **Confirmation number** | `meta.confirmationCode` | ✅ |
| **Event name** | `meta.eventName` | ✅ |
| **Registered athlete/attendee** | `meta.athleteName` | ✅ |
| **Paid by** | `meta.payerName` | when payer ≠ default guardian |
| **Date & time** | `meta.eventStartsAt/endsAt` | ✅ |
| **Location + Directions** | `meta.location` | when present |
| **Amount paid** | `meta.amountPaid` | when > 0 |
| **Amount due** | `meta.amountDue` | when > 0 AND state has an amount owed |
| **Amount refunded** | `meta.amountRefunded` | when > 0 |
| **Discount applied** | `meta.discountLabel` | when present |
| **Card on file** | `meta.cardLabel` | when relevant to state |
| **Due date + proximity badge** | `meta.dueDate` + `meta.proximityBadge` | when state = PAYMENT |
| **Escalation stage indicator** | `meta.escalationStage` | when > 0 AND state = PAYMENT |
| **Cancellation policy** (collapsed by default) | `meta.cancellationPolicyText` | when non-null AND state ≠ CANCELED* |
| **Primary action button** | `actions.primary` | when present |
| **Secondary actions** | `actions.secondary` | always show "Add to calendar" for non-canceled states |
| **View registration URL** (this same page) | `context.confirmationUrl` | ✅ — printed as the shareable "return to this page" link |
| **Club contact** | `Club.contactEmail` + `Club.contactPhone` | ✅ |

The email renders the same slots in the same order with the same copy — same file exports one JSX component (for the page) and one HTML template (for the email), both consuming the same context.

### 5.2.8 Multi-athlete parents — one email per registration, deliberately

**Decision: one email per athlete per transition.** Reasoning:

- Each `EventRegistration` is a discrete transactional record with its own confirmation number, `approvalStatus`, `paymentMethod`, `amountDue`, `proposedChange`, `reminderStage`, and eventual `Transaction` ledger. Its state transitions independently — athlete A can be approved while athlete B is pending, athlete A can pay while athlete B is awaiting a proposed change.
- A single "family digest" email would either (a) print stale state for the other athletes at any given transition, (b) require rebuilding a debounced notification queue we already ruled out in §5.7, or (c) partial-update the message in place — none survive contact with the state matrix.
- The M16 dedupeKey is per-registration for exactly this reason. Bundling would break the structural idempotency guarantee.
- 3A's household deduplication solves a different problem: **marketing broadcasts** — one household receives one campaign email even if multiple members' filters match. Transactional emails are per-record events, not per-audience. The `EmailSend.kind` distinction (`MARKETING` vs `TRANSACTIONAL`) is the seam.

**Two mitigations to reduce inbox friction on the common "parent registers 3 kids in one submission" case:**

1. **Registration route bundling.** When a POST creates ≥2 registrations for the same event under the same authenticated guardian in the same request (a future explicit "register multiple athletes" endpoint) the *initial* confirmation email carries a "You registered N athletes for <event>" cover paragraph listing all of them, but is still one `EmailSend` row **per registration** — each with its own confirmation number and `event-confirm:<regId>` dedupeKey. The body is generated from a slightly different template branch (`RegistrationRenderContext.bundleContext`) that includes a "Athletes registered together:" list, but the ledger + accept/decline links + return URL are per-athlete.
2. **Send-queue coalescing (optional, later).** The queue drainer (`/api/cron/email-queue`) may collapse ≥2 `EmailSend` rows to the same `recipientEmail` inserted within a short window (say 60s) into one delivered message when the provider supports multi-part MIME batching. This is a delivery-layer optimization only — the ledger remains one row per registration per transition, so dedup and audit are unaffected. Skip in v1 unless the "3 emails in 3 seconds" complaint materializes.

**No cross-registration state mixing, ever.** An email about athlete A's approval never references athlete B's status. The parent gets a full picture on the roster (`/member/bookings`, one row per registration with a family group header) — the emails stay narrow.

### 5.2.9 Refund state copy — how the render context reads it

Refunds surface via the ARCHITECTURE-NOTES §2.4 M3 track (`Transaction.refundedAmount`, `refundedAt`). Until M3 lands, the resolver reads refund state from the `Transaction.reconciliationStatus = VOID` heuristic (already the current codebase's proxy) and prints:

- Full refund present → "{amountRefunded} was refunded on {refundedAt} to your {cardLabel}."
- Partial refund present → "A {amountRefunded} refund was issued on {refundedAt}. You paid {amountPaid_minus_refund}."
- No refund + never charged → "This registration wasn't charged, so nothing to refund."
- No refund + charged and not refunded (e.g. CASH/CHECK, PAID that decline path didn't touch) → "The club will refund you separately — please contact {clubContact}."

The copy variants are **enumerated in the resolver**, not written per-route.

### 5.2.10 Idempotency across the full lifecycle — one paragraph, restated for the audit

Every email in §5.2.5 uses `sendClubEmail` with a per-transition `(sendBatchId, dedupeKey)` pair. The M16 partial-unique index on `email_sends(sendBatchId, dedupeKey) WHERE sendBatchId IS NOT NULL AND dedupeKey IS NOT NULL` is the structural guarantee — a second insert with the same tuple violates the constraint, the send is marked `SKIPPED reason=duplicate`, and the caller returns normally.

The four re-fire vectors this protects against:

- **Webhook retries.** Stripe retries a `checkout.session.completed` after our response times out. Both the registration route and the webhook call `sendEventConfirmationEmail(reg)`; the first inserts, the second returns `SKIPPED`. Same for `charge.succeeded` and `invoice.paid`.
- **Cron job restarts.** The tournament-reminders cron re-fires after a Netlify function timeout. `event-remind:<regId>:<stage>` blocks a re-send at the same stage; only a fresh stage rotation produces a new row.
- **Repeated user clicks.** A parent double-taps "Accept proposed change". Both requests attempt `event-accepted:<regId>:<respondedAt.ISO>`; the second is a no-op because `respondedAt` is the timestamp of the *first* successful response, so both requests target the same key.
- **A state set twice.** A coach approves, then the transaction race we already handle in `chargeEventRegistration` re-runs recordSuccess. The receipt keys on `transactionId` (Stripe PI-id-derived, exactly one Transaction per PaymentIntent) — the second recordSuccess is a no-op.

Per CLAUDE.md's caveat: the SQL migration for `email_sends` is authoritative; the `@@unique` in `schema.prisma` is documentation only because Prisma cannot model partial unique indexes. Do not "reconcile" this drift.

---

## 5.3 Tournament workflow — opt-in surfaces (owner settings first)

Every workflow feature below is **default OFF**. This section defines the settings owners toggle before anything else in §5.4–§5.7 has any effect.

### 5.3.1 Per-event-type defaults (`ClubEventType`)

Extend `ClubEventType` with a new nullable JSON `defaultPolicy` blob (additive migration, no backfill needed — null = no policy):

```
ClubEventType.defaultPolicy: {
  requiresCoachApproval:       boolean,   // default false
  approvalPaymentIntent:       "CARD" | "APPROVAL_CHARGE" | "INVOICE" | "CASH_CHECK" | "PARENT_CHOOSES",
                                          // default "PARENT_CHOOSES"
  allowProposedChanges:        boolean,   // default false — needs requiresCoachApproval
  escalationEnabled:           boolean,   // default false
  escalationAnchor:            "registrationDeadline" | "eventStart" | "autoChargeDate",
                                          // default "registrationDeadline"
  escalationSchedule:          "DEFAULT_TOURNAMENT" | "GENTLE" | "AGGRESSIVE" | "CUSTOM",
                                          // default "DEFAULT_TOURNAMENT" (see §5.6)
  customEscalationDays:        number[] | null,  // when schedule=CUSTOM: days-before-anchor to send
  cancellationPolicyText:      string | null     // rendered in the confirmation email
}
```

Owner opens **Manage event types** (existing modal), toggles a per-type default. Built-in `EventType.TOURNAMENT` presets ship as opt-in defaults but do not auto-turn-on for existing rows.

### 5.3.2 Per-event overrides (`Event`)

Extend `Event` with additive columns that override the type default when non-null:

```
Event.requiresCoachApproval        boolean?  // null = inherit from type
Event.approvalPaymentIntent        string?   // null = inherit
Event.allowProposedChanges         boolean?  // null = inherit
Event.responsibleCoachUserId       string?   // FK-soft to User; null = "any staff with events:edit"
Event.escalationEnabled            boolean?  // null = inherit
Event.escalationAnchor             string?
Event.escalationSchedule           string?
Event.escalationCustomDays         Json?
Event.cancellationPolicyText       string?   // per-event override
Event.paymentDueBy                 DateTime? // hard deadline for payment; used by final-stage reminder
```

`resolveEventPolicy(event)` (new pure helper in `lib/eventPayments.ts`, no DB) walks `event → event.customEventType.defaultPolicy → hardcoded fallback`. Every downstream check calls this — no route directly reads the columns.

**UI**: the event editor grows a **"Coach approval + payment"** collapsible card, defaulting closed. Inside:

- One master toggle "This event requires coach approval before the spot is confirmed."
- When on, reveals: payment intent picker, responsible coach picker, allow-proposed-changes checkbox, cancellation-policy textarea, escalation subcard.
- **Entry categories** (separate from the approval card, because they drive the signup form whether or not approval is on): any number of owner-defined categories, each a label plus an optional value list, offered with presets (Weight Class, Division, Age Group, Position, Belt Level, Bracket) and a custom option. Defaults per event type live in `ClubEventType.defaultPolicy.categoryFields`; the event's own `registrationForm` overrides them. These are exactly the fields a coach may propose changing (§5.4.6), so nothing downstream needs its own list.
- Escalation subcard: enabled/disabled, anchor picker, schedule picker (with a "See the cadence" preview that renders exactly what will be sent on which day), payment-due-by date.
- **The card is hidden by default in the editor for non-tournament event types** — a weekly clinic owner should never see it unless they set `defaultPolicy` on that type. Discoverability is via the event-types modal.

### 5.3.3 Public event surface

If the event is opt-in and requires approval, the public registration page and the member registration form show a prominent line **before** the pay picker: *"Registration is not confirmed until the coach reviews it. You'll be notified as soon as they do — no money moves until then."*

For `APPROVAL_CHARGE`, the pay picker adds the "Charge my saved card on approval" option (member only — public path can't have a saved card). The button label reads "Register — reviewed by coach, then charged $X" (server-computed exact amount, same discipline as the existing PAYMENT_METHOD_REQUIRED response).

---

## 5.4 Registration flow — write-path mechanics

**Scope (what §5.4 owns, what it doesn't).** §5.4 covers the server-side write path — what actually happens in the database, in Stripe, in the audit log, and in the rate limiter when a parent registers, a coach approves/declines/proposes, a parent accepts/declines a proposal, or a Booking materializes. **State names, per-state copy, waitingOn labels, and the full render matrix live in §5.2.6.** **The lifecycle of transactional emails triggered by these mutations lives in §5.2.5.** This section names its state values using the §5.2.6 keys and refers to email sends by their §5.2.5 row, and does not repeat either. Schema columns are declared in §5.10; §5.4 references them by name.

### 5.4.1 The one new registration status — `PENDING_REVIEW`

Add exactly one value to the `RegistrationStatus` union in `lib/eventPayments.ts`: `PENDING_REVIEW`. It is the only new registration status this phase introduces on the row; every other §5.2.6 render key resolves off existing status + auxiliary columns (`proposedChange`, `approvalStatus`, `scheduledChargeAt`) already listed in §5.10.

Wire into the existing sets in the same module:

- `ACTIVE_REGISTRATION_STATUSES` — **excluded** by default. A `PENDING_REVIEW` row is a request, not a spot.
- `CHECKIN_BLOCKING_STATUSES` — **included**. `checkinPaymentBlock()` already fails OPEN when no registration row is present (so free / membership-covered attendees still walk in); with `PENDING_REVIEW` in the blocking set, someone the coach hasn't approved is denied at the door. Copy: "This registration is still awaiting coach approval — please see staff."
- `UNPAID_REGISTRATION_STATUSES` — **excluded**. Nothing is owed yet in `PENDING_REVIEW`; including it would surface phantom "money owed" counts in the Action Center probe `PENDING_EVENT_PAYMENTS`.

`REGISTRATION_STATUS_LABELS` gains `PENDING_REVIEW: "Awaiting coach review"` for the raw-status renderer (roster row for owners without the render context), but every user-facing surface should prefer the §5.2.6 render context because that's what carries the *charge timing* copy — the raw label alone lies to registrants under APPROVAL_CHARGE.

### 5.4.2 Capacity semantics with `PENDING_REVIEW`

The default behavior is **capacity is NOT held during review**. Rationale: an approval-gated tournament with capacity 32 that receives 60 registration requests must let request #33 enter the queue — the coach's job is to pick who competes, not to have that decision made by whoever's phone finished sending the form first. `capacityWhere()` continues to return the existing OR-clause; `PENDING_REVIEW` is not one of the ORs.

Capacity is enforced at **approve time**, inside the same advisory-lock transaction the approve route runs (§5.4.6): re-count `bookings + eventRegistrations WHERE status IN ACTIVE_REGISTRATION_STATUSES`; if `>= event.capacity`, the approve route 409s with `EVENT_FULL` and the coach picks a different registration.

**Owner opt-in override.** `Event.holdSpotDuringReview: boolean @default(false)` (schema in §5.10). When true, `capacityWhere()` extends its OR-clause with `PENDING_REVIEW`, and the approve-time re-check no longer needs to fail on capacity — the spot was reserved at registration time. Intended for owners whose approvals are quick and whose events genuinely have a first-come lane. Off by default.

The `CHECKOUT_HOLD_MS` behavior for `PENDING_PAYMENT` is unchanged; `PENDING_REVIEW` has no equivalent expiry — a review request lives until a coach decides. Stalled probes (`EVENT_APPROVAL_STALLED_*` in §5.6.5) surface age.

### 5.4.3 Schema — cross-reference to §5.10

Every column §5.4 reads or writes is enumerated in §5.10. The columns this section relies on by name: on `Event` — `requiresCoachApproval`, `approvalPaymentIntent`, `allowProposedChanges`, `responsibleCoachUserId`, `holdSpotDuringReview`; on `ClubEventType` — `defaultPolicy`; on `EventRegistration` — `approvalStatus`, `approvedByUserId`, `approvedAt`, `declinedReason`, `approvalRequestedAt`, `proposedChange`, `proposedChangeRespondedAt`, `proposedChangeAccepted`, `reminderStage`, `lastReminderAt`, `nextReminderAt`, `confirmationCode`; on `Booking` — `bookedByUserId`.

Two shape notes not covered in §5.10 (semantic, not schema):

- `EventRegistration.proposedChange` payload shape: `{ proposedByUserId, proposedAt (ISO), coachNote?, priceDelta?, changes: {...}, labels: {...} }` where `changes` is validated against a **per-event** allowlist — the event's own entry categories plus the two structural keys `session | extraEntry` — and an unknown top-level key returns 400 so the §5.2.6 `PROPOSED_CHANGE_PENDING` render context always has a shape-safe `proposed` slot. **The allowlist is not a fixed union.** It was originally specced as `weightClass | division | session | addAnotherDual | freeText`, which is one sport's vocabulary compiled into the validator; AthletixOS sells to any youth sports organisation, and a judo club proposes a belt and a weight while a soccer club proposes a position. Entry categories are configured by the owner per event (`Event.registrationForm`, marked by the reserved `participant_category` id) and defaulted per event type (`ClubEventType.defaultPolicy.categoryFields`), each carrying a label and an optional value list — a list makes the coach's control a picker, no list leaves it free text. `labels` snapshots the field names as they stood when the coach proposed, so renaming a category later cannot relabel a decision a family already answered. Resolution and validation live in `lib/eventCategories.ts`; no surface may name a sport (guarded by `npm run test:sport-terms`).
- `EventRegistration.approvalStatus` NULL vs `PENDING` distinction: **NULL** on any registration to an event where `resolveEventPolicy(event).requiresCoachApproval` was false at create time — this is how the resolver + downstream surfaces detect "coach approval was never part of this event's contract" without loading the event's current policy. Later toggling `requiresCoachApproval` on an event does NOT retroactively mark existing NULL rows PENDING; only new registrations see the new policy.

### 5.4.4 The `waitingOn` resolver — co-located with the state machine

`registrationWaitingOn(reg, event) → "COACH" | "PARENT" | "PAYMENT" | "COMPLETE" | "CANCELED"` lives in `lib/eventPayments.ts` next to the status constants. **Return values, decision rules, and per-state assignments are defined in §5.2.6** (the state matrix maps each render key to a `waitingOn`). This section only records the two constraints on the function itself:

- **Pure.** No prisma, no fetch. Callers pass the already-loaded row + event so the same value can be computed from any context (render, probe, cron, test) without a re-query.
- **Consumers.** The §5.2.2 render context, the `/api/events/[id]/registrations` roster payload, every `lib/actionCenter.ts` probe that reads registration status, and the escalation cron scheduler (§5.6) all call this — never their own hand-rolled equivalent. If a caller needs a filter (e.g. "everyone waiting on PAYMENT"), they compute it from the same resolver, not from a duplicated status set.

### 5.4.5 Create-path branching — `POST …/register` (member + public)

When `resolveEventPolicy(event).requiresCoachApproval` is true, the create routes fork BEFORE any charge or Checkout call. What each `approvalPaymentIntent` writes on row-create:

- **APPROVAL_CHARGE** — status `PENDING_REVIEW`, `approvalStatus = PENDING`, `approvalRequestedAt = now`, `paymentMethod = "APPROVAL_CHARGE"`, `scheduledChargeAt = null`, `autoChargeConsent` snapshot recorded (same shape as the existing AUTO_CARD consent — see `app/api/member/events/[id]/register/route.ts:685-696`). Precondition: `resolveChargeablePaymentMethodId(customerId, stripeAccountId, savedPmId)` returns non-null. If it returns null, the route responds `402 PAYMENT_SETUP_REQUIRED` with a URL to the existing setup-mode Checkout (`/api/member/payment-method/setup`) carrying `metadata.eventRegistrationId` so the setup webhook branch attaches the newly saved PM to the row on completion. Public path never offers APPROVAL_CHARGE — see §5.3.3.
- **INVOICE** — status `PENDING_REVIEW`, `approvalStatus = PENDING`, `paymentMethod = "INVOICE"`, no card required. On approval the `bill-registrants` per-target logic fires the first invoice (§5.4.6).
- **CARD** (pay now, up front) — the existing Stripe Checkout path runs immediately; on Checkout success the webhook writes status `PAID` per §5.2.6's `PAID` key — but `approvalStatus = PENDING` stays. This is the deliberate "already paid, still awaiting coach approval" case; the confirmation surface flips to §5.2.6's `PENDING_REVIEW` render key because the resolver reads `approvalStatus` first (even though `status = PAID`). Refund on coach-decline is unconditional (§5.4.6 decline dispatch).
- **CASH / CHECK** — status `AWAITING_CASH` / `AWAITING_CHECK` per today's behavior, `approvalStatus = PENDING`, one PENDING offline Transaction written via the existing `createEventOfflinePendingTx()` — coach approval still gates whether that money is ever collected. On decline the offline Transaction is voided via the same "superseded — the registrant changed how they're paying" path already in place at `app/api/member/events/[id]/register/route.ts:568-577`.
- **PARENT_CHOOSES** (policy default) — presents the payment picker as today; each concrete method above lands in its own branch.

**No `Booking.create` at registration time when `requiresCoachApproval`.** `Booking` is the "confirmed spot" primitive (member portal calendar, class rosters, member/bookings, `bookedByUserId` attribution); creating it before a coach approves would leak unapproved spots into member-facing surfaces. The row lives only in `EventRegistration` until §5.4.6 approve. Free/covered/no-approval paths retain today's inline `Booking.create`.

**Idempotency + concurrency at create time.** The existing per-registration advisory lock (`pg_advisory_xact_lock(hashtextextended('evreg:<eventId>:<memberId>', 0))` at `app/api/member/events/[id]/register/route.ts:545-546`) already serializes concurrent double-clicks for member registrations; the create path reuses it. Public-path double-click prevention: add `EventRegistration @@unique([eventId, email])` when `email` is non-null via a partial unique index (Prisma cannot model this — see the M18 pattern in ARCHITECTURE-NOTES §2.4; the SQL migration is authoritative, the schema `@@unique` is documentation only). Existing dupes handled by the M18 dedup script listed in ARCHITECTURE-NOTES §2.4.

**Parental-controls gate runs FIRST.** `lib/parentalControls.ts` (`applyParentalControls` with `kind = "EVENT_REGISTER"`) already fires before Stripe on the member route. It stays exactly where it is — GUARDIAN approval is a separate question from COACH approval and comes first. A minor whose guardian queues a `PENDING` approval never reaches the coach queue; only on guardian approve does the replay land the registration in `PENDING_REVIEW` for coach approval. Two-layer approval (guardian, then coach) is the correct semantic — do not collapse them.

**Post-create side effects (both routes):**
- `sendEventConfirmationEmail(ctx)` fires with the initial-confirmation dedupeKey per §5.2.5 row 1. The rendered state key per §5.2.6 depends on `paymentMethod`: `PENDING_REVIEW` for APPROVAL_CHARGE / INVOICE / CASH / CHECK, `PENDING_PAYMENT_INFLIGHT` for CARD.
- `BillingAuditLog` action `EVENT_REGISTRATION_CREATED` with `before: null, after: { registrationId, status, approvalStatus, paymentMethod }`.
- `lib/actionCenter.ts` gets a new probe `COACH_APPROVAL_REQUESTED` (declared in §5.7 as a surface, wired in §5.6.5 as a probe) that surfaces the new row within one cache TTL (20s).

### 5.4.6 Coach mutation routes — `approve`, `decline`, `propose-change`

Three new routes, all under `POST /api/events/[id]/registrations/[regId]/{approve|decline|propose-change}`.

**Common contract — every coach mutation route:**

- **Authorization.** `events:edit` OR the caller's user id matches `Event.responsibleCoachUserId`. Owners bypass as always. `requirePermission(session, "events", "edit")` handles the first half; the responsible-coach override adds a second branch. Fail path: 403 `PERMISSION_REQUIRED`.
- **Rate limit.** `rateLimit({ key: "approve:event:<userId>", limit: 60, windowMs: 60_000 })` — the existing `lib/ratelimit.ts` per-user bucket. New key namespace; existing implementation.
- **Load + serialize.** `prisma.$transaction(async db => { await db.$executeRaw`pg_advisory_xact_lock(hashtextextended('evreg-mut:' || regId, 0))`; ... })` — same lock family the create path uses, distinct namespace (`evreg-mut:`) so a create replay and an approve don't contend. Inside the lock the route reads the current row, validates the transition, writes, and dispatches side effects atomically.
- **Terminal-state guard.** On a request whose current state doesn't accept the requested transition: return 409 `INVALID_TRANSITION` with `{ currentStatus, currentApprovalStatus, waitingOn }` so the client rerenders from truth. A repeat approve on an APPROVED row is a 409 (not a 200 no-op) because the caller needs to know their view was stale; the audit log preserves the first approve, no side effect fires twice.
- **Side-effect dispatch is inside the lock.** Money-moving side effects (`chargeEventRegistration`, `stripe.refunds.create`, `createEventOfflinePendingTx` void) inherit their own idempotency guarantees (PI dedup, Stripe idempotency keys, unique `(sendBatchId, dedupeKey)` on emails per §5.2.10) — the lock only guarantees that within one AthletixOS process, two concurrent mutations don't both attempt them.
- **Audit.** Every route writes `BillingAuditLog` with `memberId, actorUserId, action, before, after, note`. Actions: `EVENT_REGISTRATION_APPROVED`, `EVENT_REGISTRATION_DECLINED`, `EVENT_REGISTRATION_PROPOSAL`. Refund side effects add `EVENT_REGISTRATION_REFUNDED`. §5.2.5 emails are queued after the audit row lands.
- **Email.** Never inline — always through `sendClubEmail`, always keyed per §5.2.5. The route calls one helper per transition and moves on.

**`approve` — body: `{}` (no parameters).** Semantic: the responsible coach accepts the registration as originally submitted.

- Capacity re-check unless `event.holdSpotDuringReview` was on (§5.4.2). On full → 409 `EVENT_FULL`.
- Write: `approvalStatus = APPROVED, approvedByUserId = actor, approvedAt = now`.
- Status transition per §5.2.6 keyed to `paymentMethod`:
  - APPROVAL_CHARGE → `status = SCHEDULED`, `scheduledChargeAt = now`, then call `chargeEventRegistration(regId)` synchronously in-request. The engine's existing discipline (per-registration idempotency key, prior-PI recovery, exactly one VERIFIED Transaction, fail-CLOSED on unverifiable state) handles the money. Success flips `status = PAID`; decline flips `PAYMENT_FAILED` and generates the fallback Checkout link + email already documented in §5.2.5 row 8. §5.2.6 render keys `SCHEDULED_APPROVAL_CHARGE` (narrow, <5s window between the write and the engine's return) and `PAID` follow.
  - INVOICE → `status = REGISTERED`, `amountDue = <resolved event price>`. Immediately generate + email the first invoice by calling the same per-target logic used by `bill-registrants` (extracted to `billOneRegistrant(reg, event, mode)` — same code, one caller becomes two). Escalation cron takes over from stage 1.
  - CARD (paid up front) → `status` was already `PAID` from webhook; no money moves. Only `approvalStatus`, `approvedByUserId`, `approvedAt` change.
  - CASH / CHECK → `status` unchanged; PENDING offline Transaction unchanged. Escalation cron takes over from stage 1 for the amount due.
- `Booking.create({ eventId, memberId, status: "CONFIRMED", bookedByUserId: <see §5.4.9> })`. Unique-violation on `(eventId, memberId)` (concurrent path already created it) is caught + treated as a successful outcome; no error to the actor.
- Emails per §5.2.5 rows 2 + (7 or 9) depending on paymentMethod — one send per material change per recipient, all dedupe-keyed.

**`decline` — body: `{ reason: string }`.** Semantic: the coach cannot accept the registration as submitted.

- `reason` is validated (1..500 chars), sanitized via `sanitizeRichHtml` before storage (the reason renders in the parent's email — same rule as `Document.body`).
- Write: `approvalStatus = DECLINED, approvedByUserId = actor, approvedAt = now, declinedReason = <sanitized>, status = CANCELED`. `approvalStatus = DECLINED` on a `status = CANCELED` row is the discriminant that §5.2.6 uses to render `DECLINED_BY_COACH` vs `CANCELED_BY_PARENT`.
- Refund dispatch keyed on `paymentMethod`:
  - CARD paid up front → `stripe.refunds.create({ payment_intent: reg.stripePaymentIntentId }, { stripeAccount, idempotencyKey: aox-eventreg-refund-<regId> })`. Refund success writes `Transaction.refundedAmount + refundedAt + refundedByUserId` via the ARCHITECTURE-NOTES §2.4 M3 columns; a Stripe error is not retried inline — the audit row records the failure and an owner-actionable `EVENT_REGISTRATION_REFUND_FAILED` Action Center probe surfaces it (severity high). Permission gate: the decline route requires `finances:full` OR the actor is an Owner. A coach without `finances:full` on a CARD-paid decline gets 403 `FINANCE_PERMISSION_REQUIRED` — they must ask an owner to decline, since a decline + no refund would strand real money. This is a deliberate friction: a partial decline (no refund) is never a correct terminal state.
  - APPROVAL_CHARGE (never charged) → no refund. `autoChargeConsent` snapshot is retained on the row for audit.
  - INVOICE (never invoiced) → no refund. `paymentUrl` if any is left untouched — the CANCELED status prevents any further stage-cron fire because §5.6.1 excludes CANCELED.
  - CASH / CHECK → the PENDING offline Transaction is voided via the same "superseded" path already at `app/api/member/events/[id]/register/route.ts:568-577` (change `paymentSource` untouched, status → FAILED, reconciliationStatus → VOID, notes appended). No money to refund because none was collected.
  - SCHEDULED (rare race — cron charged before decline landed) → same as CARD paid up front. This is why the advisory lock exists — normally the decline route reads `SCHEDULED` and either the charge cron already flipped it to PAID (refund CARD-style) or hasn't run yet (cancel the schedule before refunding via `stripe.paymentIntents.cancel` if a PI was created but not yet settled).
- Emails per §5.2.5 rows 3 + (if refund fired) 7.

**`propose-change` — body: `{ changes: {...}, message?: string, priceDelta?: number }`.** Semantic: the coach wants the parent to accept a different entry — one of the event's own categories, a different session, or one more entry — and then approve.

- `allowProposedChanges` policy must resolve true — else 403 `PROPOSALS_NOT_ALLOWED`. Owners can override per-event but not per-coach.
- `changes` validated against the per-event allowlist (see §5.4.3 shape note — the event's configured categories plus `session` / `extraEntry`, never a hard-coded sport vocabulary). `message` optional, 1..2000 chars, sanitized. `priceDelta` optional signed decimal — validated against `event.memberPrice`/`nonMemberPrice`/`dropInFee` to prevent a nonsensical priceDelta (e.g. `-$1000` on a $50 event); 400 `INVALID_PRICE_DELTA` on out-of-band values.
- Write: replaces the current `proposedChange` blob with `{ proposedByUserId: actor, proposedAt: now, coachNote: message, priceDelta, changes }`; `proposedChangeRespondedAt = null`, `proposedChangeAccepted = null`. Prior proposals are NOT preserved on the row (single-slot column) — the audit history in `BillingAuditLog` action `EVENT_REGISTRATION_PROPOSAL` with `before: <prior blob>, after: <new blob>` is the archive.
- Status unchanged. §5.2.6 render key flips to `PROPOSED_CHANGE_PENDING` because the resolver reads `proposedChange != null AND proposedChangeRespondedAt IS null` first, ahead of `PENDING_REVIEW`.
- No money moves. Ever.
- Emails per §5.2.5 row 4. Additionally, post a DM in the parent↔coach `Message` thread (§5.5) via `sendMemberMessage` with a deep link to `/member/bookings/[regId]/proposal`.

### 5.4.7 Parent-response routes — `proposal/accept`, `proposal/decline`

Two new routes under `POST /api/member/events/[id]/registrations/[regId]/proposal/{accept|decline}`.

**Common contract — every parent-response route:**

- **Authorization.** Session `User.id` is the registration's linked `Member.userId` OR one of the member's `guardianLinks[].userId`. Fail path: 403.
- **Rate limit.** `rateLimit({ key: "respond:event:<userId>", limit: 20, windowMs: 60_000 })`.
- **Lock + terminal guard.** Same advisory-lock discipline as §5.4.6 (`evreg-mut:` namespace). A double-click accept-then-accept fits the terminal-state guard: second request reads `proposedChangeRespondedAt != null` and 409s with the current state.
- **Idempotency by response timestamp.** The first successful response sets `proposedChangeRespondedAt` and `proposedChangeAccepted`; both fields are immutable thereafter. Emails per §5.2.5 rows 5 + 6 key on `respondedAt` so a hypothetical replay under the same lock produces the same email row (dedup match).
- **Audit.** `BillingAuditLog` action `EVENT_REGISTRATION_PARENT_RESPONSE`.

**`proposal/accept` — body: `{ additionalConsent?: { agreed: true, buttonLabel: string, amount: number } }`.**

- Precondition: `proposedChange != null AND proposedChangeRespondedAt IS null`. Else 409.
- If `proposedChange.priceDelta > 0` AND the registration's `paymentMethod ∈ {APPROVAL_CHARGE, CARD, SCHEDULED}`: `additionalConsent` is required and its `amount` must equal `priceDelta` (server-recomputed, not client-trusted). Missing / mismatched → 400 `CONSENT_REQUIRED` or `CONSENT_AMOUNT_MISMATCH`.
- Apply the proposed values to the registration:
  - Fields modeled on the event's `registrationForm` overlay into `formResponses` (existing JSON). Because entry categories ARE `registrationForm` entries, an accepted category change lands in the same place the registrant's original answer did.
  - Anything schema-tracked (future dedicated columns) updates directly — none today, so `formResponses` overlay covers all v1 change types.
- Write: `proposedChangeRespondedAt = now, proposedChangeAccepted = true`. Merge the priceDelta into `amountDue` for INVOICE / CASH / CHECK; update the stored `autoChargeConsent.amount` for APPROVAL_CHARGE using the fresh `additionalConsent` snapshot; for CARD (already paid up front), generate a `bill-registrants`-style payment link for the delta and stamp it on `paymentUrl` — the delta is collected separately, not via a re-charge of the original PI.
- **Re-enter the approve pipeline.** Acceptance implies approval (the coach's proposal doubled as their approval-conditional-on-parent-accepting). The route calls the same internal `approveRegistration(regId, actor = coach)` helper the coach approve route calls — the coach's userId (from `proposedChange.proposedByUserId`) is the recorded `approvedByUserId`, `approvedAt = now`. Booking creation, payment settlement dispatch, and all §5.2.5 lifecycle emails follow identically. §5.2.5 row 5 is the parent-accepted email; the coach approve email (row 2) is NOT sent again because acceptance-triggered approval uses row 5's dedupeKey (`event-accepted:<regId>:<respondedAt>`) not row 2's.

**`proposal/decline` — body: `{}` (no parameters).**

- Precondition: same as accept.
- Write: `proposedChangeRespondedAt = now, proposedChangeAccepted = false, status = CANCELED`. `approvalStatus` is left at `PENDING` (never becomes `DECLINED` — the coach didn't decline). §5.2.6 renders this as `CANCELED_PROPOSAL_DECLINED`.
- Refund dispatch: identical to §5.4.6 decline, keyed on `paymentMethod`. Rationale: the parent's proposal-decline is functionally a cancellation, and cancellation of a paid-up-front CARD registration must refund. The permission gate is different though: the actor is the parent, not staff, so `finances:full` is not checkable — instead the route calls `stripe.refunds.create` on the parent's behalf with the actor's userId recorded as the initiator, and the refund is unconditional. Owner catches an issue via `BillingAuditLog` if a refund fires unexpectedly.
- Post a DM back to the coach via `sendMemberMessage` so the coach sees the decline in-thread. Email per §5.2.5 row 6.

### 5.4.8 Booking attribution — `bookedByUserId`

`Booking.bookedByUserId String?` — the pre-existing attribution gap from ARCHITECTURE-NOTES §2.4 M19 folds in here because coach-approval creates Bookings and coach attribution matters for the daily digest, the roster, and per-athlete reporting. Nullable; legacy rows stay null; every consumer defaults to "unknown".

Set on every `Booking.create`:

- Self-book (member registers themselves) → `session.user.id`.
- Guardian booking for child → `session.user.id` (the guardian). Combined with `Booking.memberId = child` this is the parent-registered-for-athlete signal.
- Owner-add via attendance/roster → the staff user's id.
- Coach approval of a `PENDING_REVIEW` row → the approving coach's user id (from the approve route's session).
- Parent acceptance of a coach proposal that re-enters approve → the coach's user id (from `proposedChange.proposedByUserId`).

### 5.4.9 Multi-athlete write semantics

Per-registration writes, always. A parent registering N athletes for the same tournament creates N `EventRegistration` rows — each with its own `approvalStatus`, `proposedChange`, `paymentMethod`, `paymentUrl`, `reminderStage`, `nextReminderAt`, `autoChargeConsent`, and eventual `Transaction` ledger. Every mutation route in §5.4.6 and §5.4.7 targets one `regId` — never a family group. A coach can approve one athlete and decline another; each approval or decline fires its own §5.2.5 lifecycle email.

**One transaction per POST for multi-registration create.** When a future explicit "register multiple athletes" endpoint creates ≥2 rows in one submission, all N inserts run inside one `prisma.$transaction` so either all rows exist or none do; the initial confirmation email per §5.2.8 rides the bundleContext cover paragraph. Every subsequent mutation is per-registration.

**Bundle purchases stay out of scope.** `EventBundlePurchase` grants Bookings only on PAID or ON_ACCEPTANCE (existing behavior); it does not go through `approvalStatus`. §5.2.8 already flagged the "tournament-approval + bundle" combination as out-of-scope-for-v1 — do not add a bundle branch to the mutation routes in this section.

### 5.4.10 Charge / refund side-effect ownership — who owns which idempotency

The write-path mutations produce three kinds of money side effect. Each has one owner of its idempotency contract; the routes call the owner and move on.

| Side effect | Owner | Idempotency guard |
|---|---|---|
| Off-session card charge (APPROVAL_CHARGE at approve, AUTO_CARD at scheduled sweep, SAVED_CARD immediate) | `lib/eventAutoCharge.chargeEventRegistration` | Per-registration key `aox-eventreg-<regId>-a<attempt>`; prior-PI retrieve; metadata search; fail-CLOSED on unverifiable state (existing implementation, do not fork) |
| Refund on decline | `stripe.refunds.create` | Idempotency key `aox-eventreg-refund-<regId>`; a replay hits Stripe's cached response and returns the same refund id; the `Transaction.refundedAmount` update is a no-op on the second call because refundedAt is already set |
| Offline Transaction void on decline / method-switch | `prisma.transaction.updateMany({ where: { id, status: "PENDING" }, ... })` | Conditional update — the second call finds no PENDING rows, updates zero, no side effect (existing pattern at `app/api/member/events/[id]/register/route.ts:568-577`) |

Route-level idempotency is the advisory lock + terminal-state guard (§5.4.6 common contract); side-effect idempotency lives with the side-effect owner. No client-provided idempotency keys on the mutation routes themselves — the lock + guard is sufficient because a replay under the lock produces the same terminal state, and the side-effect owners each dedup independently.

### 5.4.11 What §5.4 does NOT own — one-shot cross-reference

- **State names, per-state copy, waitingOn labels, render-context slot order, confirmation-page rendering, calendar attachment, cancellation-policy display** → §5.2.2, §5.2.6, §5.2.7.
- **Which mutations trigger which emails, dedupeKey shapes, recipient resolution, marketing-vs-transactional classification, `EmailSend` ledger** → §5.2.5, §5.2.10.
- **Refund copy variants** → §5.2.9.
- **Multi-athlete email bundling decision** → §5.2.8.
- **Owner-facing surfaces (roster columns, Action Center probes, coach digest, Reports Action Items)** → §5.7.
- **Escalation cron cadence, stage schedule, stalled-approval probes** → §5.6.
- **Owner settings for opt-in (per-event-type policy, per-event override, responsible coach picker, cancellation-policy textarea)** → §5.3.
- **Schema column list** → §5.10.

If a future edit finds itself restating any of the above, stop and cross-reference back to the section listed.

---

## 5.5 Two-way parent ↔ coach communication

Reuse `Message` + `sendMemberMessage` — do not build a new inbox.

- Every `PENDING_REVIEW` registration gets a `Message` thread pre-tagged with `subjectMemberId = the registered athlete`. Coach comments (via a "Message parent" button on the roster row) land in this thread. `sendMemberMessage` already fans out to the parent's User + all guardianLinks; guardians already see child-scoped threads on `/member/messages` (2026-06-21 batch).
- Propose-change and decline both post an auto-message in the thread with the exact reason (owner-typed). The parent gets an in-app + email notification of the DM via the existing message-notification path.

---

## 5.6 Escalation — the scheduling engine

**Scope (what §5.6 owns, what it doesn't).** §5.6 is the *when* — the hourly cron that decides which registrations are due for a reminder or a stalled-approval nudge, how the anchor and cadence resolve, how `EventRegistration.nextReminderAt` is advanced after each fire, and how the same cron pass surfaces the coach-daily-digest for `PENDING_REVIEW` rows that have aged. **The email itself — subject, body, recipients, `sendBatchId`, `dedupeKey`, marketing-vs-transactional classification — is defined in §5.2.5 row 8 (payment reminder) and rows 4/9/10 (coach digest is a separate row added below).** **State names come from §5.2.6.** **Idempotency of the send is §5.2.10.** **Owner-facing surfaces (roster columns, Action Center probes, Reports Action Items) are §5.7.** §5.6 references those by name and adds only the scheduling logic.

### 5.6.1 Cron infrastructure — mirror the event-charges pattern

One new Netlify scheduled function + one new route, both mirroring the shape already shipping in `netlify/functions/event-charges-cron.mts` → `/api/cron/event-charges`. Nothing bespoke:

- **`netlify/functions/tournament-reminders-cron.mts`** — hourly (`schedule: "0 * * * *"`, UTC), thin HTTP wrapper. Reads `CRON_SECRET` + `URL` from `Netlify.env`, POSTs `${URL}/api/cron/tournament-reminders?limit=100` with `Authorization: Bearer $CRON_SECRET`, logs the response tally, returns 200 either way (the next hour retries). No business logic; identical scaffolding to the existing charge cron.
- **`POST|GET /api/cron/tournament-reminders`** — constant-time bearer compare against `CRON_SECRET`. 503 when the secret is unset (never open by default — the same "moving money is not an acceptable open default" rule the charge cron enforces). On authorized call, invokes `runDueTournamentReminders({ limit })` in a new pure-ish module `lib/eventReminders.ts` and returns `{ ok, dueReminders, dueDigests, tally, results }`.
- **`runDueTournamentReminders({ limit })`** never throws — per-registration failures are logged and counted; one broken row must not abandon the queue behind it (same shape as `runDueEventCharges` at `lib/eventAutoCharge.ts:502-511`).

**Lazy sweep parity.** The registrations roster route (`/api/events/[id]/registrations`) already lazy-sweeps due charges with `runDueEventCharges({ limit: 3 })`. Extend it with a matching `runDueTournamentReminders({ eventId, limit: 3 })` so a club that never configures `CRON_SECRET` still gets reminders sent whenever staff open the roster. Both paths are idempotent per §5.2.10 — running twice can never re-send.

**One cron, two passes.** The route runs two sequential sweeps in one invocation: (1) due payment reminders per §5.6.4, (2) due coach digests per §5.6.7 when `hour(now) BETWEEN 9 AND 10 UTC` (the digest is a once-per-UTC-day fire). Splitting into two routes would require two Netlify schedules and two secrets for no gain; one route, one wrapper, two internal passes is the same pattern the sync jobs already use.

### 5.6.2 Which registrations are eligible for a reminder

A registration is eligible when the resolver returns `waitingOn = "PAYMENT"` per §5.4.4 AND `resolveEventPolicy(event).escalationEnabled` per §5.3.2 AND `nextReminderAt <= now`. The `waitingOn = PAYMENT` check subsumes every "money is owed and it's on the parent" state — §5.2.6 keys `AWAITING_CASH`, `AWAITING_CHECK`, `PAYMENT_FAILED`, and `REGISTERED_AMOUNT_DUE` — without §5.6 having to enumerate them.

**Explicitly not eligible** (the resolver already excludes these; recorded here so an implementation session doesn't re-add them):

- `PAID`, `SCHEDULED_EVENT_DATE`, `SCHEDULED_APPROVAL_CHARGE`, `FREE_CONFIRMED`, `COVERED_BY_MEMBERSHIP` — nothing owed, or the money is already committed.
- `PENDING_PAYMENT_*` — the CHECKOUT_HOLD_MS expiry handles this state, not a reminder.
- `PENDING_REVIEW` and `PROPOSED_CHANGE_PENDING` — money is not the blocker; the coach digest (§5.6.7) handles COACH-waiting, and DMs in the parent↔coach thread handle PARENT-waiting.
- `CANCELED_*`, `DECLINED_BY_COACH` — terminal.

### 5.6.3 Anchor selection — one function, four inputs

`resolveReminderAnchor(event, registration) → Date | null` in `lib/eventReminders.ts`. Precedence, first non-null wins:

1. `event.paymentDueBy` — an owner-set hard payment deadline; overrides everything.
2. `event.escalationAnchor` per policy resolution (§5.3.2 `PARENT_CHOOSES` → falls through) — one of:
   - `"registrationDeadline"` → `event.registrationDeadline`.
   - `"eventStart"` → `event.startsAt`.
   - `"autoChargeDate"` → `event.autoChargeDate` (only meaningful when the event has an AUTO_CARD or APPROVAL_CHARGE registration path).
3. Fallback: `event.registrationDeadline ?? event.startsAt`.
4. If all four are null (rare — an owner enabled escalation on a rolling event with no dates) → returns null and the registration is skipped with a `SKIPPED reason=no-anchor` log line. The Action Center gets an `EVENT_REMINDER_NO_ANCHOR` probe surfaced by §5.7 so the owner sees the misconfiguration.

Anchor timezone: the anchor is a `Date` (UTC instant); day-offset math (§5.6.4) uses `Club.timezone` when set for the "days before" comparison so "3 days before" means "3 days before in the club's local calendar", not 72h ± DST wobble. Existing `lib/datetime.ts` helpers already do the two-pass tz math; reuse.

### 5.6.4 Named cadences — stage offsets only, no copy

**Copy for each stage lives in §5.2.5 row 8 and §5.2.6.** §5.6 names the cadence and lists day-offsets — full stop.

| Schedule | Stage day-offsets from anchor (negative = before, 0 = anchor day, positive = after) |
|---|---|
| `DEFAULT_TOURNAMENT` | −14, −7, −3, −1, 0, +2 |
| `GENTLE` | −14, −3, 0 |
| `AGGRESSIVE` | −21, −14, −7, −3, −1, 0, +2, +7 |
| `CUSTOM` | Owner-typed `escalationCustomDays: number[]` on `Event` (or the event-type default). |

Stage index is 1-based and maps to the same `reminderStage` column §5.4 declares. When the resolver computes `nextReminderAt`, it walks the schedule from the current `reminderStage` and picks the earliest offset whose absolute date is > `lastReminderAt` (or > registration `createdAt` when nothing has fired yet). A registration created after stage 3's offset has already passed skips stages 1–3 entirely and fires stage 4 next — the point is *time to the anchor*, not stage count. `reminderStage` records the last stage actually fired so §5.2.6's proximity badge and §5.7's roster aging column read a real number.

**Stage 0 handling.** No `AGGRESSIVE`-schedule stage fires *before* the registration is created; if the anchor is 30 days out and the parent registers today, stage 1 at −21 fires 9 days from now. Historical "we should have sent 3 stages before this parent registered" is never backfilled.

### 5.6.5 `nextReminderAt` — who writes it, when

The column is populated in exactly three places:

1. **On registration create.** After the row is inserted with a payment method that could ever owe money (`AWAITING_CASH`, `AWAITING_CHECK`, `REGISTERED with amountDue > 0`; `PAYMENT_FAILED` from an auto-charge decline via `lib/eventAutoCharge.ts`; not for `PAID` / `SCHEDULED` / `PENDING_PAYMENT` / `PENDING_REVIEW`), the create route calls `computeNextReminderAt(reg, event)` and stores the result. Guarded by `event.escalationEnabled` and a non-null anchor — null result is fine, the column stays null and the cron ignores this row until it becomes eligible.
2. **After each successful send in the cron.** The `runDueTournamentReminders` loop calls `sendClubEmail` per §5.2.5 (which enforces the per-stage dedup); on any non-throw return — INSERTED, `SKIPPED reason=duplicate`, or `SKIPPED reason=opted-out` (payment reminders are transactional and skip the opt-out gate; this outcome should be impossible but the loop treats it as "consider stage attempted and advance") — the loop advances `reminderStage`, sets `lastReminderAt = now`, and recomputes `nextReminderAt` from the schedule. A `FAILED` send (SMTP error) does NOT advance; `nextReminderAt` is bumped forward one hour and the next cron pass retries the same stage. On the third `FAILED` for the same stage the row is marked `reminderStage = -1` (sentinel) and surfaces to Action Center as `EVENT_REMINDER_SEND_FAILED` (severity high; §5.7 lists the probe).
3. **On state transition.** Every mutation route in §5.4.6 and §5.4.7 that changes `status` (approve, decline, propose accept/decline, offline-payment record) calls `computeNextReminderAt(reg, event)` in the same transaction. Approve of an `APPROVAL_CHARGE` that succeeds → `nextReminderAt = null` (nothing more to remind). Approve of an `INVOICE` → recomputed from stage 1. Decline / cancel → `nextReminderAt = null`. `POST /api/members/[id]/offline-payment` recording receipt → `nextReminderAt = null` on any linked registration. This is what stops a paid registration from getting a stage-5 reminder because the cron read a stale row.

The reads → decide → write cycle in the cron runs one registration at a time inside its own `prisma.$transaction` with the same `evreg-mut:<regId>` advisory lock §5.4.6 defines. Concurrent cron + mutation cannot race — the mutation wins the lock, updates `nextReminderAt`, and the cron reads the new value on its next iteration.

### 5.6.6 Cron send — routing through §5.2.5

The cron loop per eligible registration:

1. Acquire the `evreg-mut:<regId>` advisory lock inside a `prisma.$transaction`.
2. Reload the row; re-verify eligibility (§5.6.2) — the row may have been paid/canceled between the outer query and here.
3. Build a `RegistrationRenderContext` via §5.2.2's resolver with the current `reminderStage + 1` in `meta.escalationStage` so §5.2.6's copy renders the correct urgency.
4. Call `sendEventPaymentReminderEmail(ctx)` — the §5.2.5 row 8 helper. dedupeKey is `event-remind:<regId>:<stage>` per §5.2.10; the M16 partial-unique index makes a re-fire structurally a no-op.
5. On non-throw return: advance `reminderStage`, `lastReminderAt`, and `nextReminderAt` per §5.6.5.
6. On throw (SMTP, DB, provider): bump `nextReminderAt` forward one hour, increment a per-registration `reminderSendFailures` counter (add to §5.10 schema list), and — after three consecutive failures on the same stage — sentinel `reminderStage = -1` and surface via §5.7.

**Never re-render, never re-copy inside the cron.** All email copy comes from the §5.2.5 helper. The cron passes context; it does not string-format subjects or bodies.

**Rate limiting the cron itself.** No rate limit on the cron route (it's `CRON_SECRET`-gated); Stripe / SMTP throughput is limited by the sequential per-registration loop + the `limit=100` per invocation. If the queue exceeds 100 per hour the next hour catches up — same as the charge cron.

### 5.6.7 Coach digest — different data, same cron pass

The second sweep inside `/api/cron/tournament-reminders` fires once per day — the wrapper's hourly schedule plus a once-per-day gate, so no second schedule is needed. **Per the §5.12 item 5 decision (owner, 2026-08-04) the gate is 09:00 in `Club.timezone` when that column is set, and `hour(now) BETWEEN 9 AND 10 UTC` only as the fallback when it is null** (it is null for every club today). Recipient is the single responsible coach, which is what the grouping below already does. Digest logic:

- Query every user that is a `responsibleCoachUserId` on at least one Event whose registrations include a row with `approvalStatus = PENDING AND approvalRequestedAt < now - 24h`. Group by coach.
- For each coach, compose a single `EmailSend` row via `sendCoachDigestEmail(coach, groupedRegistrations)` — a new §5.2.5 row (call it row 12: coach daily digest). Content: one line per registration with athlete name, event name, days since request, deep link to the roster row. `sendBatchId = "coach-digest"`, `dedupeKey = "coach-digest:<userId>:<YYYY-MM-DD in Club.timezone>"`. The date-in-club-tz key means one digest per coach per calendar day even if the cron fires 09:00 UTC twice (once at 08:59:59, once at 09:00:00 — the M16 index catches the second).
- On coach = owner (owner is often the responsible coach for a small club), suppress duplicates by keying on the user id — an owner with two hats gets one digest.

The digest is not tied to reminder stages; it fires whenever there's stalled work, indefinitely, until the coach clears the queue. A coach with zero stalled rows receives no digest that day (empty groups skip the send).

**Owner-side stalled-approval probes** are Action Center kinds `EVENT_APPROVAL_STALLED_48H` and `EVENT_APPROVAL_STALLED_PAST_DEADLINE` — declared in §5.7. The cron does not write to them; the Action Center recomputes them live from `EventRegistration.approvalStatus + approvalRequestedAt + event.registrationDeadline` on every request (per the `lib/actionCenter.ts` self-clearing count model already in place). §5.6 fires the *coach's* digest; §5.7 surfaces the *owner's* count.

**No auto-approve, no auto-decline.** A coach who misses the window makes the call; the owner can act on the coach's behalf via the same §5.4.6 routes (they gate on `events:edit`, which owners have). Auto-decision on stalled approvals is explicitly out of scope — flagged in §5.12 as a decision the owner has already implicitly made by opting into coach approval.

### 5.6.8 Time discipline — one place each

- **UTC everywhere for storage and cron scheduling.** `nextReminderAt` is a UTC instant. Netlify cron is UTC.
- **`Club.timezone` for calendar-day math.** "3 days before" and "same day" resolve in the club's local calendar; the digest key rolls over at the club's midnight, not UTC midnight. Existing `lib/datetime.ts` helpers.
- **`baseUrlFromRequest` never appears in this section** — the cron has no incoming request; all URLs in reminder + digest emails are built with `getAppBaseUrl()`. Same rule §5.2.3 states for the confirmation route.

### 5.6.9 What §5.6 does NOT own — one-shot cross-reference

- **Reminder email subject, body, recipients, transactional classification** → §5.2.5 row 8.
- **Coach digest email subject, body, recipient resolution** → §5.2.5 (new row 12 to add when §5.2.5 is next edited).
- **Per-state copy including proximity urgency** → §5.2.6.
- **Email dedup guarantee across all lifecycle sends** → §5.2.10.
- **Roster columns, filter presets, Action Center probes, Reports Action Items snoozable kinds** → §5.7.
- **Which registration states are eligible / ineligible for reminders** → follows §5.4.4's `waitingOn` resolver; §5.6 only names PAYMENT as the trigger set.
- **Mutation routes that write `nextReminderAt` on state transition** → §5.4.6, §5.4.7 (via the shared `computeNextReminderAt` helper co-located with the scheduler).
- **Owner opt-in settings (schedule name, custom day offsets, `paymentDueBy`)** → §5.3.1, §5.3.2.
- **Schema columns (`reminderStage`, `lastReminderAt`, `nextReminderAt`, `reminderSendFailures`)** → §5.10.

If a future edit finds itself restating any of the above, stop and cross-reference back to the section listed.

---

## 5.7 Visibility surfaces — no duplicated feeds

Every "notification" this phase produces routes through exactly one owner of that information.

| Signal | Owner | Consumer surfaces |
|---|---|---|
| Coach needs to approve a registration | `EventRegistration.approvalStatus = PENDING` | Action Center probe `COACH_APPROVAL_REQUESTED` (live count, self-clearing); roster row indicator; **daily coach digest at 09:00 UTC** when count > 0 for `responsibleCoachUserId`. Never in the owner Approvals queue. |
| Parent needs to respond to a proposed change | `EventRegistration.proposedChange IS NOT NULL AND proposedChangeRespondedAt IS NULL` | Member portal `/member/bookings` pending-response pill; `PendingApproval` row (kind `EVENT_PROPOSAL_RESPONSE`) so it appears in the family approvals card the same way `CLASS_BOOK` etc. do today; single DM in the parent↔coach Message thread; single email via `sendClubEmail` dedupeKey `event-proposal:<regId>:<proposedAt>`. |
| Payment is owed | `registrationWaitingOn(reg) = PAYMENT` | Action Center probe (existing `PENDING_EVENT_PAYMENTS`); roster row; escalating reminder emails (§5.6); member portal "amount due" pill. |
| Payment failed | `status = PAYMENT_FAILED` | Existing `EVENT_PAYMENT_FAILED` probe; the auto-generated Checkout link + email already sent by `eventAutoCharge.recordFailure`. |
| Duplicate payment landed | `Transaction.reconciliationStatus = REVIEW, type = EVENT` | Existing `EVENT_DUPLICATE_PAYMENT` probe. |
| Coach hasn't responded | `PENDING_REVIEW` age | New probes `EVENT_APPROVAL_STALLED_48H` + `_PAST_DEADLINE`; coach daily digest. |
| Registration confirmed | State-driven confirmation email | `sendEventConfirmationEmail` (one dedupeKey per registration, structural once). |

**Rule.** Nothing that would create a second surface for the same underlying fact. The Action Center count IS the notification for the owner; the DM thread IS the notification for the parent; the `EmailSend` per-recipient row IS the ledger; `Booking` IS the calendar spot; `EventRegistration` IS the money+status truth. Every consumer reads from one of these — no shadow tables.

---

## 5.8 Owner-facing settings — the checklist to turn it on

Owner does exactly this to enable coach approval + escalation on a tournament type:

1. **Manage event types** → choose `TOURNAMENT` → set `defaultPolicy`:
   - Toggle "Require coach approval before confirming registrations."
   - Pick the default payment intent: parent chooses / charge saved card on approval / bill later / cash-or-check / require card up front.
   - Toggle "Allow coach to propose registration changes (any entry category, the session, or one more entry)."
   - Toggle "Send payment reminders as the deadline approaches" → pick a schedule (default `DEFAULT_TOURNAMENT`).
   - Write the cancellation policy that will appear on every confirmation email for this type.
2. **Create or edit a tournament event** → the "Coach approval + payment" card is open by default because the type opts in. Owner:
   - Picks a **responsible coach** from the club's staff list (else "any staff with events:edit can approve").
   - Confirms or overrides the type default for approval / payment / escalation.
   - Sets `paymentDueBy` (defaults to `registrationDeadline` when blank).
3. **Set `CRON_SECRET`** in the Netlify environment (already required for `event-charges-cron`; the tournament-reminders cron reuses it). The scheduled functions register themselves on the next production deploy — no other configuration.

That is the entire operator-side turn-on. Everything else — probes, digests, reminders, escalation, confirmations, approvals surface — is automatic and self-clearing.

---

## 5.9 Tournament-only vs all-event summary

**All events, always (Phase 5 core):**
- Bug fixes 5.2.1.
- Server-rendered confirmation surface 5.2.2.
- Confirmation email helper + dedupeKey structural once-only 5.2.3.
- Confirmation card fields 5.2.4.
- `EventRegistration.confirmationCode` + `Booking.bookedByUserId`.

**Tournament-only (opt-in per event type, defaults OFF):**
- `PENDING_REVIEW` state + coach approval routes 5.4.
- Proposed-change flow 5.4.5–5.4.6.
- Escalating payment reminders 5.6.
- Responsible-coach digest + stalled-approval probes 5.6.5.
- All new Action Center probes (`COACH_APPROVAL_REQUESTED`, `EVENT_APPROVAL_STALLED_*`, `EVENT_REMINDER_OVERDUE`).
- `PendingApproval` kind `EVENT_PROPOSAL_RESPONSE`.

**Applies to camps / clinics only when the owner turns it on:**
- Coach approval (yes, occasionally useful for waitlist-heavy multi-week camps).
- Escalating reminders (yes, useful for camp deposits or clinic prepayment).
- Proposed-change (rarely useful outside tournaments — leave defaulted off for these types).
- Authorization holds (no — Stripe manual-capture window is wrong; see §5.1).

---

## 5.10 Schema changes (all additive, no destructive backfills)

Every column is nullable or defaults to a safe value; every existing row keeps computing exactly as it does today until the tournament workflow is turned on for its event.

- `Event`: `requiresCoachApproval Boolean?`, `approvalPaymentIntent String?`, `allowProposedChanges Boolean?`, `responsibleCoachUserId String?`, `escalationEnabled Boolean?`, `escalationAnchor String?`, `escalationSchedule String?`, `escalationCustomDays Json?`, `cancellationPolicyText String?`, `paymentDueBy DateTime?`, `holdSpotDuringReview Boolean @default(false)`.
- `ClubEventType`: `defaultPolicy Json?`.
- `EventRegistration`: `confirmationCode String? @unique` (backfill compute-on-read then persist), `approvalStatus String?`, `approvedByUserId String?`, `approvedAt DateTime?`, `declinedReason String?`, `approvalRequestedAt DateTime?`, `proposedChange Json?`, `proposedChangeRespondedAt DateTime?`, `proposedChangeAccepted Boolean?`, `reminderStage Int @default(0)`, `lastReminderAt DateTime?`, `nextReminderAt DateTime?`.
- `Booking`: `bookedByUserId String?` (M19 in ARCHITECTURE-NOTES §2.4 — folds into Phase 5).
- Index: `EventRegistration(status, nextReminderAt)` so the cron sweep is a covered scan; `EventRegistration(clubId, approvalStatus)` for the roster; `EventRegistration(status, approvalRequestedAt)` for stalled probes.
- `PendingApproval.kind` string set gains `EVENT_PROPOSAL_RESPONSE` — no schema change (`kind` is already free-string).
- No new enums added on `MemberSubscription`, `Transaction`, or any live-money model. The existing `RegistrationStatus` string set grows by exactly one value (`PENDING_REVIEW`).

**Follow the "hand-write SQL + `migrate deploy` + Supabase MCP bookkeeping" pattern from CLAUDE.md.** One migration folder per commit; timestamp must sort after `20260801040000` (the latest applied on this repo per CLAUDE.md).

---

## 5.11 Correctness rules (all events, restated)

- **Never display the success page unless registration creation actually succeeded** — enforced by §5.2.2 (server-rendered from the actual row).
- For Stripe registrations, confirm the correct payment state before showing a final paid confirmation — enforced by reading `EventRegistration.status`.
- Properly handle processing, failed, canceled, free, and offline-payment states — enforced by state-driven copy per §5.2.2 + §5.2.3.
- Prevent duplicate confirmation emails when webhooks or retries run more than once — enforced structurally by the `(sendBatchId, dedupeKey)` partial-unique index; documented in CLAUDE.md as index authoritative-in-SQL, `@@unique` in schema is documentation only.
- Never charge on decline. Never charge on unresponded proposal. Never charge without an active consent snapshot. Enforced by only calling `chargeEventRegistration` from the approve path and the parent-accept path.
- Never auto-approve, auto-decline, auto-refund. Every terminal decision belongs to a human.
- Every mutation writes to `BillingAuditLog` — `EVENT_REGISTRATION_APPROVED`, `EVENT_REGISTRATION_DECLINED`, `EVENT_REGISTRATION_PROPOSAL`, `EVENT_REGISTRATION_PARENT_RESPONSE`, `EVENT_REGISTRATION_ESCALATED`.

---

## 5.12 Design and product decisions — ALL EIGHT DECIDED (owner, 2026-08-04)

**These are closed. Do not re-ask them.** Every item below was answered by the owner and each answer is the recommendation that preceded it, unless the "Decided" line says otherwise. An implementation session should build straight from these — there is nothing here to pause on.

1. **Cancellation policy text** — per-event-type, per-event, or per-club?
   **DECIDED: per-type with a per-event override.** `ClubEventType` carries the default text (§5.3.1); `Event` may override it (§5.3.2). No club-level field.

2. **Refund on coach-decline of a CARD-paid registration** — real refund or a "mark refunded" flag?
   **DECIDED: a real, full refund.** `stripe.refunds.create` fires on decline of a CARD-paid registration, gated on `finances:full`. No manual-in-Stripe flag path. (§5.4.6 decline dispatch owns the idempotency; §5.4.7's parent-decline path refunds unconditionally with the parent recorded as initiator, per that section's stated exception to the `finances:full` gate.)

3. **Holding a spot during review** —
   **DECIDED: default OFF, but the coach can turn it on.** Ship the default as OFF — capacity is enforced at approve time (§5.4.2, §5.4.6), not at registration. This is **not** a hardcoded constant: it is the per-event `Event.holdSpotDuringReview @default(false)` field already specified in §5.4.2 / §5.10, and it must be exposed in the event editor so a coach who wants `PENDING_REVIEW` rows to consume capacity can flip it. When ON, `PENDING_REVIEW` joins the OR-clause in `capacityWhere()`.

4. **`EVENT_PROPOSAL_RESPONSE` as a member-facing approval kind** — may we add a kind beyond the six the plan restricts to?
   **DECIDED: yes, add it.** `MEMBER_APPROVAL_KINDS` in `lib/parentalControls.ts` gains `EVENT_PROPOSAL_RESPONSE` alongside CLASS_BOOK / EVENT_REGISTER / PRIVATE_REQUEST / PACKAGE_BUY / MEMBERSHIP_SUBSCRIBE / PRODUCT_BUY. It stays on the member/family side and must not cross into the owner Approvals queue.

5. **Responsible-coach daily digest timing and recipients** —
   **DECIDED: yes to both parts of the recommendation.** The digest cron reads `Club.timezone` and sends at 09:00 club-local, falling back to 09:00 UTC when the column is null (it is null today — see root `CLAUDE.md`). Recipient is the **single responsible coach**, not the full `events:edit` staff list.

6. **Bundles vs coach approval** —
   **DECIDED: bundles bypass coach approval for v1.** A coach may still decline an individual event inside a bundle, which refunds that event's share only. The bundle purchase itself is never held for approval.

7. **Public-path `APPROVAL_CHARGE` for non-members** —
   **DECIDED: not offered publicly.** It requires a saved card, which requires an account. `/e/[slug]` never presents `APPROVAL_CHARGE` — consistent with the existing rule that the public path never offers AUTO_CARD.

8. **Reports Action Item `TOURNAMENT_PAYMENT_STALLED` threshold** —
   **DECIDED: stage 6.** Any tournament reminder cadence that reached stage 6 (§5.6.4) with payment still outstanding raises the Action Item. No separate day-count threshold.

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

# PHASE 7 — The Family Model in the Experience

**Goal:** the family model is real in the database and absent in the experience. Signup does not make it obvious you are creating a child's account, and once inside, the portal treats a family as individuals you toggle between. Both halves of this phase close that gap.

**Phase number:** this is **Phase 7**, not 4.6. §4 states "there is no Phase 4.6 — 4.5 is the last decimal phase," and that line was written deliberately to stop decimal sprawl; it is respected here. Two consequences to note when this lands:

- The trailing Final Deliverable section used to share this number. It was **renumbered to `## 8. Final Deliverable`** on approval (2026-08-15), so nothing in this file is called 7 twice.
- **Numeric order is not execution order.** Phase 6 is the final safety/verification gate and must still run last. Phase 7.1 is scheduled **first — ahead of 4.5 and 5** — because it is hitting every two-child family in the club today, not one member.

---

## 7.0 Audit — every path that creates an account or a member

Traced 2026-08-15 against `frogempire607/clubos` and read-only production. Ordered by how often they fire.

### The seven paths

| # | Path | Entry | Records created, in order | Who ends up the athlete | Who ends up the guardian |
|---|---|---|---|---|---|
| 1 | **Member portal signup — ADULT_ATHLETE** | `/member/signup` → `POST /api/member/signup` | `User` (role MEMBER) → nested `Member` (`status PROSPECT`, `isMinor false`, `email` = signup email) via `memberProfile.create`; `LegalAcceptance` ×2; optional `DocumentSignature` rows; optional `trialEndsAt` | The signer | Nobody. No guardian link. Correct for a genuine adult athlete. |
| 2 | **Member portal signup — MINOR_ATHLETE** | same | `User` **named after the child** but carrying whatever email was typed → nested `Member` (`isMinor true`, `email` = **signup email**, `guardianName`/`guardianEmail` from the form) → `GuardianConsentRequest` + consent email → (on click) `ParentalConsent` + `MemberGuardianUser` | The child | **Whoever owns the email in `guardianEmail`** — resolved by email lookup at consent time |
| 3 | **Member portal signup — PARENT** | same | `User` only. **No `Member` row** (deliberate, CLAUDE.md "Guardian-only accounts are not members"). Then the vouched sweep: every live member with `guardianEmail == signup email` is linked via `requestGuardianLink` | Nobody — no athlete is created | The signer, for each swept child |
| 4 | **Free trial** | `?trial=1` on either signup, or a club Free Trial offer | `Member.trialEndsAt` on **`user.memberProfile`** — the member this signup created | Whoever that member is | n/a |
| 5 | **Staff-created member** | `/dashboard/members` → `POST /api/members` | `Member` → if `guardianEmail` matches a live `User`, `memberGuardianUser.upsert` (route.ts:232) | The typed athlete | The matched account, owner-vouched |
| 6 | **Migration activation** | `/activate/[token]` → `POST /api/members/migration/activate/[token]` | resurrect-or-create `User` → `Member.userId` link → `memberGuardianUser.upsert` (route.ts:623) for guardian-managed minors → documents, card setup | The imported member | The activation contact when `guardianManaged` |
| 7 | **Public event registration** | `/e/[slug]` → `POST /api/public/events/[slug]/register` | `EventRegistration` (+ `Booking` if an existing member matched by email). **Creates no `User` and no `Member`** | Nobody new | Nobody |

### What the person actually sees

- **Paths 1–3** share one wizard. Step 1 is a three-way picker (Adult Athlete / Young Athlete / Parent). The copy names the roles but the form that follows is the same shape for all three, and **the email field is not labelled by role** — on MINOR_ATHLETE it reads as "your email" while the record it writes is the *child's* `Member.email`. A parent filling in a child's signup types their own email there, correctly, and it lands on the child.
- **Path 3 (PARENT) creates no athlete and offers no next step.** The wizard finishes, the parent lands in an empty portal, and nothing prompts them to onboard the child. This is the "emails me asking how to add their kid" case when they picked the right option.
- **Path 4** is silent on the PARENT path: `user.memberProfile` is null, so the trial is skipped with no message. A parent who clicked a trial link and chose "Parent" gets no trial and no explanation.

### Which paths can produce AJ Dorn's shape

**Only path 2**, and it needs one more condition: the guardian email must equal the email the account was created under. Then:

1. Dad opens `/member/signup`, picks **Young Athlete**, types `Adam (AJ) Dorn` as the name, `adamjdorn@gmail.com` (his own) as the email, and the same address as guardian email with `Adam j Dorn, Sr` as guardian name.
2. Route creates `User` `cmsno0z49…` — **email = dad's, first/last name = "Adam (AJ) Dorn"**, i.e. the dad's login is named after his son — and nests `Member` `cmsno0z4a…` with `isMinor true`, `email` = dad's address, `Member.userId` pointed at that user.
3. `isMinor` → `createGuardianConsentRequest` → consent email sent **to `adamjdorn@gmail.com`** — the same inbox that just signed up.
4. Dad clicks the consent link. `app/api/guardian-consent/[token]/route.ts:72` resolves `guardianUser` **by `request.guardianEmail`** and finds the account created in step 2. Line 101 upserts `MemberGuardianUser { userId: <AJ's own login>, memberId: <AJ> }`.
5. `trialEndsAt` 2026-08-17 written to the member (step 4 of the table — behaving as designed).

**The result is one `User` that is simultaneously the athlete, the athlete's own login, and the athlete's own guardian.** This is the exact inversion CLAUDE.md forbids ("never point a minor's `userId` at the guardian… inverts parental controls and, because `userId` is unique, makes a second child invisible"), reached without anyone pointing anything anywhere — the email lookup did it.

Two live consequences, both matching the owner's report:

- **`applyParentalControls` keys oversight on `member.userId !== bookerUserId`.** Here they are equal, so the guardian is treated as the child acting alone. Controls are inverted for this member.
- **`Member.userId` is globally unique.** A second Dorn child cannot attach to this login as `userId`, and the portal offers no path to add one from this state — so the dad's only recourse was email.

AJ is also a **duplicate**: an imported `Adam Dorn` (`cmr7b603d…`, migration `INVITED`, DOB 2011-09-15) already existed from the 2026-07-05 CSV, with `guardianName` "Adam Dorn" — the dad's name in the child's guardian field. The self-signup created a second record (DOB 2012-09-15) rather than matching it.

### How many members are in this shape today

Read-only counts, club `cmq9xyrjx…`, live members only, 2026-08-15:

| Shape | Count | Reading |
|---|---|---|
| **A. Self-guardian** — `Member.userId` == a `MemberGuardianUser.userId` on the same member | **4** | AJ Dorn's exact defect. 3 are minors created by self-signup (Dakota Mastrantonio 07-17, Paris Battaglia 07-21, Adam (AJ) Dorn 08-10); the 4th is a non-minor. |
| **B. Minors holding their own login** | **9** | The at-risk class. 4 are 07-05 CSV imports where the child's own email was supplied (Drayke Ulrich, Delos Stone, Maximus Alexander, Cael Bruce) — those are *legitimate*, guardian differs. The other 5 are self-signups from 07-17 onward. |
| **C. Minors whose `Member.email` == their `guardianEmail`** | **30** | Parent's address sitting on the child record. Not itself broken, but it is the precondition that turns path 2 into shape A. |
| **D. Minors with no CONFIRMED guardian link** | **227** of 287 | Mostly un-activated CSV imports — they have `guardianEmail` text but no account behind it. This is the backlog for "every child appears under their parent's Family & access." |
| **E. Members with a trial window set** | 15 | Trial attachment is correct in all cases inspected (always on the athlete member). |
| **F. Guardian-only users (login, no member row)** | 51 | Path 3 working as designed. |
| **G. Total live members** | 287 | |

**Rate of arrival:** shape A did not exist before 2026-07-17. Three of the four appeared in the 24 days since. Every self-signup minor where the parent uses their own address for both fields produces it.

---

## 7.1 Family-wide view — **build this first**

**Problem:** every booking surface is scoped to one athlete. `/member/schedule` fetches `?memberId=<activeId>`; `BookingsPanel` gathers records for all accessible members then filters to `activeId` (`m.id === activeId`); `/api/member/schedule` keys its booked-state lookups on `context.id`. A parent who books two children sees one child's booking at a time and concludes the second failed. This is what happened to Shannan Hall — **both** Titus's and Max's Aug 17 bookings landed, 38 seconds apart, and she reported one had not.

### Surfaces that change

| Surface | Change |
|---|---|
| `app/member/page.tsx` (Home) | "This week" block becomes family-wide: every child's next items in one chronological list, each row carrying the athlete's name + avatar. |
| `app/member/schedule/page.tsx` | Adds an **All athletes** option to the athlete selector, and makes it the **default for guardians with ≥2 children**. Booked items pin to the top as today, but across the family. |
| `components/member/BookingsPanel.tsx` | Drop the `m.id === activeId` filter when the family scope is selected. It already collects every accessible member's records — it throws them away. |
| `app/api/member/schedule/route.ts` | Accept `memberId=all` (or omit). Returns one feed with a `forMember: { id, firstName }` tag per item. Booked-state lookups move from `context.id` to `{ in: accessibleIds }`. |
| `app/api/member/portal/route.ts` | No change — it already returns per-member `summaries` + `attendanceRecords` for self + `guardianOf`. |
| `app/member/documents`, `/member/family/[id]` | Unchanged. Documents and controls are legitimately per-child. |

### What a parent sees after booking two children

This is the acceptance case. Booking Titus and Max into MS/HS Preseason on Monday must end with, on one screen and without switching profiles:

1. **Inline confirmation naming both children**, e.g. `Booked — Titus and Max, MS/HS Preseason, Mon Aug 17, 7:00 PM. Covered by their memberships.` One line per child if the outcomes differ (one covered, one paid).
2. **Both rows visible in the family feed**, each tagged with the athlete's name, without a profile switch.
3. **A per-child failure is stated per child, never as a whole-request failure** — "Titus booked. Max could not: his membership doesn't include this class." Today a mixed result is indistinguishable from a total failure.

### Does the profile switcher survive?

**Yes — it stays, with a family option added.** It is not replaced.

- It gains an **All athletes** entry that becomes the default when the guardian has ≥2 confirmed children. One child → unchanged behavior, no family option, no regression.
- Per-child scope remains for the surfaces that genuinely need it (documents, controls, billing) and for any parent who prefers it — the selection persists via the existing `lib/activeProfile.ts`.
- `components/ProfileSwitcher.tsx` and `AthleteRail` keep their current role. Do **not** remove the layout Managing bar; it is the single control (2026-07-03 decision).

### Booking two children in one action — explicitly out of scope for 7.1

7.1 makes the *result* visible. A multi-select "book both" control is a separate change to `POST /api/member/classes/book` (which takes one `memberId`) and is deferred to 7.6 so the visibility fix is not held up behind a write-path change.

### Acceptance

- Guardian with 2+ children lands on a family-scoped schedule by default and sees both children's upcoming items in one list.
- Booking child A then child B produces two visible confirmed rows without a profile switch.
- Single-child guardians and adult athletes see no change.
- Mobile 390×844: the athlete tag on each row does not push the time off-screen.
- No new N+1: the family feed is one query over `accessibleIds`, not one per child.

---

## 7.2 Signup states whose account is being created

**Code change, future members only.**

- Step 1's three-way picker stays, but each option states the outcome in the person's words: *"I'm signing my child up — I'll manage their account"* / *"I train here myself"* / *"I only manage someone else's account."*
- On the child path, **label the fields by role**: "Your child's name", "Your email (you'll manage this account)", "Your name". Today both name and email read as if they belong to one person, which is how a dad's login came to be named "Adam (AJ) Dorn".
- **Create the guardian account immediately after the child**, in the same submission — a separate `User` for the parent, guardian-linked to the child, rather than one account doing both jobs. This is the structural fix for shape A: no self-guardian link is possible when the guardian is a different row.
- **From the guardian side, prompt to onboard the child next.** Path 3 currently ends in an empty portal. It should end on "Add your athlete" with the sweep result shown ("We found 2 children already listed under your email").
- **A parent who also trains is explicitly supported** — the guardian account can gain an adult athlete profile via the existing idempotent `POST /api/member/self-profile`. Offer it as a choice, never infer it, and never block it.

## 7.3 Trial attaches to the athlete

**Code change.** The rule already holds where a member exists (`Member.trialEndsAt` on `user.memberProfile`). Two gaps:

- **PARENT signups silently grant nothing** — `user.memberProfile` is null, the block is skipped, no message. With 7.2 creating the child first, the trial attaches to the child; until then, say so rather than failing quietly.
- The trial must **never** be written to a guardian-only account. Add an explicit guard: refuse to set `trialEndsAt` on a member whose `userId` is also a guardian link on the same member (shape A), because that record's identity is ambiguous.

## 7.4 Repair the existing records — **data corrections, not code**

These are **existing-member corrections** and must follow the established pattern: a script that is **dry-run by default, requires an explicit `--apply --members <ids>` allowlist, writes audit rows, hard-deletes nothing, and is run by the owner from his own terminal** (CLAUDE.md, Supabase MCP is read-only). Model on `scripts/fix-status-truth.ts`.

| Correction | Scope | What it does |
|---|---|---|
| **SELF_GUARDIAN** | 4 members (shape A) | Split the conflated account: create/identify the parent's own `User`, move the `MemberGuardianUser` link to it, null the child's `Member.userId`, rename the parent login off the child's name. Requires a per-family decision on the parent's email — **owner-reviewed, one at a time**, not a sweep. |
| **CHILD_EMAIL** | 30 members (shape C) | Where `Member.email == guardianEmail` on a minor, move the address to `guardianEmail` only and null the child's own `email`, per the centralized contact rule. Safe to batch; still allowlisted. |
| **ORPHAN_MINORS** | up to 227 (shape D) | Where a minor's `guardianEmail` matches a live `User`, create the CONFIRMED guardian link (owner-vouched, the rule `requestGuardianLink` already enforces). Where no account exists, leave it — that is an invite, not a repair. |
| **AJ_DUPLICATE** | 1 | Adam Dorn (`cmr7b603d…`, imported) and Adam (AJ) Dorn (`cmsno0z4a…`, self-signup) are the same athlete with different DOBs. Route through the existing confirmation-gated merge on `/dashboard/members/duplicates`, which preserves history — **not** through this script. |

**Ordering:** SELF_GUARDIAN before ORPHAN_MINORS, or the sweep will re-link a conflated account to itself.

## 7.5 Tests

Extend the Phase 4D matrix rather than starting a new one. New cases: family-scoped feed returns every child's items in one query; per-child failure renders per child; single-child guardian sees no family option; a parent who is also an athlete appears in both roles; **a signup whose guardian email equals the account email produces two `User` rows and zero self-guardian links** (the AJ regression); trial never lands on a guardian-only account. Pure-function coverage in `scripts/`, integration coverage against the local throwaway Postgres as `scripts/audience-filters-tests.ts` does.

## 7.6 Deferred

Multi-select "book both children in one action" (write-path change to `POST /api/member/classes/book`). Do not fold into 7.1.

---

## Schema

**7.1, 7.3, 7.4 need no schema change.** The family view is a read-scope change over data `/api/member/portal` already returns; the trial column exists; the corrections are row edits.

**7.2 may need one additive column** — a `Member.createdVia` / `signupIntent` enum (`ADULT_SELF | CHILD_BY_GUARDIAN | STAFF | IMPORT | ACTIVATION`) so a record's origin is legible later. Today the only way to tell how a member was created is to infer it from `migrationStatus` and timestamps, which is how this audit had to be done. **Recommended but not required for 7.1** — decide before 7.2 starts.

If it is approved: additive, nullable, no backfill of existing rows beyond a deterministic inference pass, folder timestamp sorting after `20260803000000_family_accounts`, RLS policy matching `web/rls/`. **No migration is written in this spec** — per instruction.

## Code changes vs data corrections

- **Code, future members only:** 7.1 (family view), 7.2 (signup intent + guardian account creation), 7.3 (trial guards), 7.5 (tests).
- **Data corrections, existing members only:** 7.4 in full — 4 self-guardian splits, 30 child-email moves, up to 227 orphan-minor links, 1 duplicate merge. None of these are fixed by shipping code; none of the code changes repair a row already written.

---

# PHASE 8 — Membership Structure, Entitlements, and Per-Member Pricing

**Status: spec only. No implementation, no migrations written.** Audited against
production (read-only Supabase MCP) and the working tree on
`claude/membership-pricing-structure-5f7585` on 2026-08-16.

**The problem, in one sentence:** the club runs two membership records for one
class because an option can only carry a label, a price and a billing period —
every other fact about a purchase (how long you are committed, whether it
renews, which days it buys) lives one level up on the plan, where there is one
slot for all options to share.

---

## 8.0 Audit — what is already there

### 8.0.1 What exists and must not be rebuilt

The bulk price tool from the 2026-08-14 session is substantially built and
substantially right. `lib/bulkPriceChange.ts` (790 lines, pure, no Prisma) +
`/api/memberships/[id]/price-change/{preview,apply}` +
`components/BulkPriceChangeModal.tsx` already provide:

- read-only preview that provably writes nothing (owner-gated, same as apply,
  because the preview discloses every member's negotiated price);
- per-row `channel` (stripe/offline), `onListPrice`, `upfront`, `credit`
  (unused-time credit or additional-due, `UNKNOWN` rather than a fabricated
  figure when no period end is stored), `warnings`, `defaultSelected`;
- an advance-notice gate — increases refuse without a future effective date
  (`validateNotice`), and `directionForRows` computes direction from the rows
  actually being changed, not from the plan's list price;
- Stripe-first-then-verify-then-DB ordering, per-row independence, rollback of
  the Stripe item if the DB write fails, `proration_behavior: "none"`,
  `stripeUnitAmountCents` preserving the `passProcessingFees` passthrough;
- `moves` — relocating an **offline** row to a different plan/option, with
  Stripe rows refused and the reason spelled out on the row
  (`canChangeOption` / `changeBlockedReason`);
- `member_subscription_events` rows on every change, `BillingAuditLog`, a
  notification email with per-member opt-out, and `clientKey`-scoped Stripe
  idempotency.

Phase 8 **extends** this. It does not replace it. Everything above survives.

### 8.0.2 The production shape, verified

Six live plans. The two the brief names, exactly as stored:

| Plan | Options (label · price · billingPeriod) | `contractMonths` | Live subs |
|---|---|---|---|
| **MS/HS** `cmq9zoo3n…` | Monthly Full Membership · 175 · MONTHLY<br>Monthly 2 days (Tue/Thu) · 110 · MONTHLY<br>3 months Upfront · 450 · QUARTERLY<br>1 year · 1500 · ANNUAL | 1 | 11 |
| **MS/HS 3 or 12 months Commitment** `cmspjh1bq…` | 3 Months · 160 · MONTHLY<br>12 months · 150 · MONTHLY | 3 | **1** |
| **Jr Frogs** `cmq9zok7u…` | Monthly · 110 · MONTHLY<br>Upfront · 250 · QUARTERLY<br>1 Year · 900 · ANNUAL | 1 | 7 |
| **Jr Frogs Monthly Commitment** `cmsqv1ldd…` | 3 months · 90 · MONTHLY<br>12 months · 80 · MONTHLY | 3 | **0** |

Also live and **out of scope for this phase**: Girls MS/HS (still on the old
190/530/2000 list), Girls Jr Frogs (110/300/1000), Girls Only, Sunday Funday,
Tadpoles.

Two facts from that table drive most of the design:

1. **MS/HS already has two options sharing `billingPeriod: MONTHLY`.** The
   review screen's message — *"This plan has more than one option billed
   MONTHLY, so a subscription's billing period no longer says which one it is
   on"* — is `resolveOption` returning `AMBIGUOUS_PERIOD` (409). It is not a
   bug. It is the matcher correctly refusing to guess, because
   `(membershipId, billingPeriod)` stopped being an identity the day the
   Tue/Thu option was added. Collapsing the two plans puts **four** MONTHLY
   options on one card, so this gets worse before it gets better.
2. **The commitment plan is already wrong, and the brief is right about why.**
   Its two options need 3-month and 12-month terms; `contractMonths` is one
   `Int?` on the plan and holds `3`. Maximus Alexander is on "12 months" under
   a plan that says 3.

### 8.0.3 Five defects that force the two-card workaround

**D1 — Option identity is a label string, matched with `===`.** Every write
path does `options.find(o => o.label === optionLabel)`
(`/api/member/memberships/subscribe:88`). `MemberSubscription.optionLabel` is
the only stored pointer, and it is unreliable: the migration-approve path writes
`optionLabel: planName` (`migration/[id]/approve:614`), so production carries
rows labelled "MS/HS" and "Jr Frogs" beside rows labelled "Monthly" and
"1 Year", on the same plan, at the same price. Kellan Lister reads *"Stored
option label is 'Upfront', not '3 months Upfront'"* because the option was
renamed after he bought. Case drift is live too — MS/HS has both `1 year` and
`1 Year` on ANNUAL/$1500.

**D2 — Terms are plan-level.** `contractMonths`, `autoRenewDefault`,
`allowManualRenewal` are columns on `Membership`. One value each, for all
options.

**D3 — `contractMonths` is read by nothing.** Grepped: it is written by the
membership create/edit/duplicate routes, rendered on the member portal plan card
(*"3-month minimum commitment"*), and consulted by **zero** enforcement, quote,
or cancellation path. It is a label today.

**D4 — `allowManualRenewal` is read by nothing at all.** Written, editable,
duplicated, never consulted. Dead field.

**D5 — There is no writer for `MemberSubscription.autoRenew`.** It is set at
creation from `Membership.autoRenewDefault`, at cancel-approval, and at
reactivation confirm. No route toggles it afterwards. Neither a member nor a
coach can change it.

### 8.0.4 The class schedule — why day entitlements cannot be modelled as class access

Verified against `recurring_classes`:

| Class | `daysOfWeek` | Accepted plans |
|---|---|---|
| Ms/HS Olympic Season | `[1,2,4]` Mon·Tue·Thu | MS/HS, Girls MS/HS |
| MS/HS Preseason | `[1,2,4]` Mon·Tue·Thu | MS/HS, Girls MS/HS |
| Sunday Funday | `[0]` Sun | MS/HS, Girls MS/HS, Jr Frogs, Girls Jr Frogs, Sunday Funday |
| Jr Frogs | `[1,3]` Mon·Wed | Jr Frogs, Girls Jr Frogs |
| Girls Class | `[5]` Fri | Girls MS/HS, Girls Jr Frogs, Girls Only |
| Tadpoles | `[3,0]` Wed·Sun | Tadpoles |

**One `RecurringClass` spans both entitled and non-entitled days.** The $175
full member and the $110 Tue/Thu member attend *the same class* — Olympic Season
— and differ only on Monday. So the entitlement cannot be expressed as "which
classes this option grants", at any granularity. It has to be **which weekdays**,
evaluated against the individual `ClassSession`.

**And the weekday must be read as `getUTCDay()`, with no timezone conversion.**
`lib/classSessions.ts:34-49` generates sessions by walking UTC midnights,
selecting on `cur.getUTCDay()`, and stamping wall-clock times as UTC
(`startsAt.setUTCHours(sh, sm)`). Verified in production: MS/HS Preseason
sessions store `date = 2026-11-12 00:00:00`, `startsAt = 2026-11-12 19:00:00`,
and both yield DOW 4 — matching `daysOfWeek: [1,2,4]`. The class system stores
wall clock as UTC by design. Converting through `Club.timezone` here would
*introduce* the off-by-one-day bug, not fix it. `Club.timezone` is therefore
**not** a blocker for this phase.

### 8.0.5 Where coverage is decided today — nine call-sites, one rule

Every one of them asks the same question: *does this member have an `active`
`MemberSubscription` whose `membershipId` is in the class's/event's accepted
list?* No option, no day, no term.

| # | Call-site | Shape |
|---|---|---|
| 1 | `api/classes/[id]/charge:68` | staff adds to attendance / charges |
| 2 | `api/member/classes/book:121` | member self-books a class |
| 3 | `api/member/checkin/[id]:303-311` | QR / self check-in |
| 4 | `api/member/schedule:146,394` | schedule feed "Included in your membership" |
| 5 | `api/events/[id]/charge:77` | staff event charge |
| 6 | `api/member/events/[id]/register:281` | member event registration |
| 7 | `api/member/events:55` + `app/member/events/page.tsx:376` | event list pricing |
| 8 | `api/member/privates:120` | private-lesson member vs non-member rate |
| 9 | `api/attendance:95` | TRIAL guard ("already has an active membership") |

Sites 8 and 9 ask only "any active sub", not "an accepted one" — deliberately,
and unchanged by this phase.

### 8.0.6 A live bug the collapse fixes

**Neither commitment plan appears in any class's `pricingOptions`.** Maximus
Alexander, paying $150/month on "MS/HS 3 or 12 months Commitment", is not
membership-covered for Olympic Season, Preseason, or Sunday Funday. Every
coverage call-site above returns false for him; he is priced as a non-member or
drop-in. That is a direct consequence of the two-card workaround — a second plan
was created and nobody added it to six classes. Collapsing to one card fixes it
structurally.

### 8.0.7 The renewal-quote hazard is live, and this phase makes it worse before better

`resolveOfferPricing` (`lib/billingAdmin.ts:454`) builds every renewal /
reactivation quote from **member-level frozen fields** —
`migrationSelectedOption`, `migrationPriceOverride`, `legacyMembership*` — and,
when a plan is assigned with no selected option, from `options[0]`, the first
option in the array. It never reads `MemberSubscription.price`. Production
today:

| Member | Actually pays | `migrationSelectedOption` | Quote would be |
|---|---|---|---|
| Levi Schanzenbach | $175 MONTHLY | `{Monthly, 190, MONTHLY}` | **$190** |
| Max Hall | $175 MONTHLY | `{Monthly, 190, MONTHLY}` | **$190** |
| Orson Chorba | $175 MONTHLY | `{Monthly, 190, MONTHLY}` | **$190** |
| Kellan Lister | $450 QUARTERLY | `{Upfront, 530, QUARTERLY}` | **$530**, under a label MS/HS no longer has |
| Oren Oren | $175 MONTHLY | `null`, and `Member.membershipId` is null | **not configured / $0** |

The brief's constraint — *"a member can look right and still renew wrong"* — is
not hypothetical; it is five of eleven MS/HS members. Phase 8 does not fix
`resolveOfferPricing` (that is its own decision, §8.12-D9), but **§8.1's
`optionId` is the prerequisite**: once a subscription names its option, a quote
can be built from `(optionId, subscription.price)` instead of a frozen JSON blob
written at import time.

### 8.0.8 Eleven Stripe subscriptions carry a local `endDate` and `autoRenew: true`

`endDate` is written from `commitmentEndDate` / `requestedCancellationDate` at
approval, and the same value is passed to Stripe as `cancel_at`
(`migration/[id]/approve:509-518`). So the local row says both "renews" and
"ends on 2026-09-16". `stripeSnapshot` is empty on all but one row, so the DB
**cannot** tell us whether Stripe actually holds those `cancel_at` values.

This must be reconciled against Stripe **before** any autopay or renewal work in
this phase ships — see §8.11. It is pre-existing and not caused by Phase 8, but
Phase 8 is the first thing that will read those fields for money.

---

## 8.1 Option identity — `optionId`

**Add a stable, opaque `id` to every option, and `MemberSubscription.optionId`.**

```jsonc
// Membership.options — an entry after this phase
{
  "id": "opt_k3f9c1qa",          // minted once, never reused, never derived
  "label": "Monthly 2 days (Tue/Thu)",
  "price": 110,
  "billingPeriod": "MONTHLY"
}
```

**Why an id rather than "make labels unique".** The label is what the member
sees on the portal card, on receipts, on the price-change email. Owners rename
it — that is the whole point of a display label — and Kellan Lister is the
receipt for what a rename costs today. The billing period is not an identity
either: MS/HS has two MONTHLY options now and will have four after the collapse.
An opaque id is the only field that can be simultaneously stable under rename,
unique within a plan, and meaningless enough that nobody is tempted to parse it.

**Resolution order for a subscription's option** — one function,
`lib/membershipOptions.ts resolveSubscriptionOption(sub, plan)`:

1. `sub.optionId` matches an option id → **exact**.
2. `optionId` is null → infer by unique `(billingPeriod, price)` match against
   the plan's options. Exactly one match → **inferred**, flagged.
3. Zero or multiple matches → **unresolved**. Never guessed.

Every screen renders the three states differently. An inferred option is never
silently presented as fact — the price tool shows it as *"matched by price"*,
and an unresolved one shows *"option not identified"* and is excluded from
bulk selection.

**The backfill is deterministic today. Exact figures, dry-run against
production:** 27 live (`active|pending|past_due`) subscriptions on non-deleted
plans → **18 resolve to exactly one option, 9 resolve to none, 0 are
ambiguous.**

The nine that do not resolve, and why — every one is either a known-open item or
a deliberate override:

| Member | Plan | Stored | Why no match |
|---|---|---|---|
| Barrett David | MS/HS | MONTHLY $0 | comp — `migrationPriceOverride = 0.00`, still not marked `deliberateFree` |
| Paul Ortega | MS/HS | MONTHLY $0 | comp — same, still not marked |
| Wyatt Eastman | MS/HS | MONTHLY $0 | prepaid annual with no recorded payment (open since 2026-08-14) |
| Colton Waite | MS/HS | MONTHLY $530 | quarterly lump on a row labelled MONTHLY (open since 2026-08-14) |
| Adelynn Bergen | Girls Jr Frogs | ANNUAL $750 | legacy rate; plan lists $1000 |
| Riley Bergen | Jr Frogs | ANNUAL $750 | legacy rate; plan lists $900 |
| Aylen Grubusic | Sunday Funday | MONTHLY $80 | plan lists $75 |
| Clint Dwyer | Sunday Funday | MONTHLY $80 | plan lists $75 |
| John Doe | Jr Frogs | MONTHLY $5 | test row |

Those stay `optionId = null` and get a report, not a guess. **Zero ambiguous is
the load-bearing result** — it means the inference is safe to run once, now,
before anyone buys the $110 Tue/Thu option. After that, `(MONTHLY, 110)` on
MS/HS is still unique, so the inference stays safe; it only breaks if two
options share both period *and* price, which the option editor should refuse to
create.

**Where `optionId` must be written going forward** (all currently label-only):
`/api/member/memberships/subscribe`, `/api/members/subscribe`,
`/api/members/migration/[id]/approve` (which also stops writing
`optionLabel: planName`), `/api/members/migration/activate/[token]`,
`/api/approvals/membership-purchase`, `/api/reactivate/[token]/confirm`,
`/api/members/[id]/billing-admin` (the offer editor), and the price tool's
`moves` path. `optionLabel` keeps being written as a **display snapshot** — it
is what the member saw when they bought, and receipts should not retroactively
change.

`PendingApproval.payload` and the reactivation offer JSON also carry
`optionLabel` today; both gain `optionId` and resolve by id first, label second.

---

## 8.2 Terms move onto the option

Three plan columns become per-option, with the plan column kept as the fallback:

| Field | On the option | Plan column | Read order |
|---|---|---|---|
| `contractMonths` | `number \| null` | keep `Membership.contractMonths` | option → plan → none |
| `autoRenewDefault` | `boolean` | keep `Membership.autoRenewDefault` | option → plan → `true` |
| `allowManualRenewal` | `boolean` | keep `Membership.allowManualRenewal` | option → plan → `true` |

**No column is dropped and no value is migrated.** An option with the key absent
inherits the plan, which is today's behaviour exactly. That is what makes this
shippable without touching a single existing subscription.

**`contractMonths` and `billingPeriod` are independent, and the option must
carry both.** This is the brief's point 4, stated as a rule:

- *billingPeriod* — how often money moves. `MONTHLY`, `QUARTERLY`, `ANNUAL`.
- *contractMonths* — how long the member is committed. Independent of the above.

| Option | price | billingPeriod | contractMonths |
|---|---|---|---|
| Monthly Full Membership | 175 | MONTHLY | `null` (no minimum) |
| Monthly 2 days (Tue/Thu) | 110 | MONTHLY | `null` |
| 3 Months | 160 | MONTHLY | **3** |
| 12 months | 150 | MONTHLY | **12** |
| 3 months Upfront | 450 | QUARTERLY | **3** |
| 1 year | 1500 | ANNUAL | **12** |

Six options, four of them MONTHLY, three distinct commitment lengths. One card.
That is the whole ask, and it is unrepresentable today.

**English is derived, never typed.** `lib/membershipOptions.ts` exports
`describeOption(option)` producing the member-facing sentence from the
structured fields:

- `{160, MONTHLY, 3}` → *"$160 per month for 3 months"*
- `{450, QUARTERLY, 3}` → *"$450 every 3 months"*
- `{110, MONTHLY, null, days:[2,4]}` → *"$110 per month · Tue & Thu · no minimum"*

Nothing else in the app is allowed to concatenate a price sentence. The reason
is on the current card: *"3 Months $160"* and *"12 months $150"* are two labels
that encode a term the database does not hold, which is precisely how the
second plan came to be wrong.

**`allowManualRenewal` gets a reader or gets deleted.** It has none today
(§8.0.3-D4). Recommendation: keep the field, and give it its one honest
meaning — *"when this term ends and autopay is off, the club may re-open it as a
manual period rather than requiring a new purchase."* If that is not a real
workflow, drop it from the option shape and from the edit UI rather than
carrying a switch that does nothing. **Decision D5, §8.12.**

---

## 8.3 Day entitlements

### 8.3.1 The data

A fourth optional key on the option:

```jsonc
{
  "id": "opt_k3f9c1qa",
  "label": "Monthly 2 days (Tue/Thu)",
  "price": 110,
  "billingPeriod": "MONTHLY",
  "contractMonths": null,
  "entitlement": { "kind": "DAYS", "days": [2, 4] }
}
```

```ts
type Entitlement =
  | { kind: "ALL" }                          // default when the key is absent
  | { kind: "DAYS"; days: number[] }         // 0=Sun … 6=Sat, same convention
                                             // as RecurringClass.daysOfWeek
  | { kind: "COUNT"; perWeek: number };      // RESERVED — not built in Phase 8
```

`ALL` is the default for a missing key, so every existing option keeps behaving
exactly as it does today. `COUNT` ("any two sessions a week") is a real club
shape but needs a per-week usage ledger and a "which two did they use" answer
that attendance alone cannot give — it is **reserved in the discriminant now and
deferred**, so that adding it later is a code change and not a second reshape of
stored data.

`days` uses the same 0=Sunday convention as `RecurringClass.daysOfWeek`, on
purpose: the two arrays are intersected constantly and a second convention would
be a permanent off-by-one hazard.

### 8.3.2 How it interacts with the class's own schedule

They are different questions and both must be answered:

- **`RecurringClass.daysOfWeek` (+ `dayOverrides`)** — when the class meets.
  Owned by the class. Generates `ClassSession` rows.
- **`option.entitlement.days`** — which weekdays the member bought. Owned by the
  membership option. Grants nothing on its own.

Coverage of one `ClassSession` is the conjunction:

```
covered =
     class accepts the member's plan            (existing pricingOptions check)
  && subscription is active                     (existing)
  && countsAsMembership(subscription)           (existing, lib/memberTracks.ts)
  && ( entitlement.kind === "ALL"
       || entitlement.days.includes(dowUTC(session.date)) )
```

`dowUTC` reads `ClassSession.date.getUTCDay()` — see §8.0.4. No `Club.timezone`
conversion, deliberately, with that reasoning written on the function.

### 8.3.3 The editor

On each option row in the membership edit screen, a day picker that appears only
when at least one class accepts this plan, **seeded from the union of those
classes' `daysOfWeek`**. For MS/HS that is `{Mon, Tue, Thu}` from Olympic
Season and Preseason plus `{Sun}` from Sunday Funday — so the coach picks from
the four days the club actually runs, not an abstract seven-day grid, and the
picker names the classes each day comes from.

Two rules on the picker:

- Selecting **every** offered day stores `{kind:"ALL"}`, not the enumerated
  list. An option that enumerates today's schedule silently un-covers its
  members the day the club adds a Wednesday session. `ALL` means "everything
  this plan is accepted for" and stays true.
- A day-restricted option shows a live count: *"12 members are on this option —
  changing these days changes what they are entitled to."* Because entitlement
  is **not snapshotted** (§8.3.4), this is the honest warning.

### 8.3.4 Entitlement tracks the option; price does not

Price is snapshotted onto `MemberSubscription.price` at purchase — that is the
whole reason the bulk price tool exists. Entitlement is **read live from the
option**. The asymmetry is deliberate and has to be stated because it will look
like an inconsistency:

- A price change moves money and must never happen without the owner ticking a
  row. Hence the snapshot.
- An entitlement change is the club changing what it offers. Two people on
  "Tue/Thu" must mean the same thing, or the front desk cannot answer a question
  from the card. Hence no snapshot.

The cost is that a coach editing days changes existing members' access with no
per-member review. That is mitigated by the count warning above, and by
`member_subscription_events` recording the option edit against every affected
subscription so the change is auditable after the fact.

**D3 answered, 2026-08-16: live, not snapshotted.** The owner's reasoning is the
better statement of the rule and is recorded verbatim: *"If I change what an
option grants, it should apply to everyone on it. A snapshot means a silent
second tier nobody can see."* So there is no `entitlementSnapshot` column, and
the option editor's affected-member count is a required part of the UI rather
than a nicety — it is the only thing between a coach and a silent access
change.

### 8.3.5 The day sets — settled, except for one class-acceptance question

**Owner correction, 2026-08-16: the $110 option is Tue/Thu only. It does not
include Sunday.** An earlier note suggesting otherwise was stale.

**D1 answered: the day set is absolute** — these weekdays, everywhere this plan
is accepted.

**What the class table actually says** (verified, all active classes):

| Class | Days | Time | Accepted plans | Drop-in |
|---|---|---|---|---|
| Ms/HS Olympic Season | Mon·Tue·Thu | 18:30–20:30 | Girls MS/HS, **MS/HS** | $25 |
| MS/HS Preseason | Mon·Tue·Thu | 19:00–20:30 | Girls MS/HS, **MS/HS** | $25 |
| **Sunday Funday** | **Sun** | 11:00–13:00 | Girls Jr Frogs, Girls MS/HS, Jr Frogs, **MS/HS**, Sunday Funday | $25 |
| Jr Frogs | Mon·Wed | 17:30–18:30 | Girls Jr Frogs, **Jr Frogs** | $25 |
| Girls Class | Fri | 17:00–18:30 | Girls Jr Frogs, Girls MS/HS, Girls Only | $40 |
| Tadpoles | Wed·Sun | 17:30–18:15 | Tadpoles | $25 |

So **MS/HS is accepted for Sunday Funday today**, at the plan level — a $175
member currently gets Sunday free, and so would a $110 Tue/Thu member, because
acceptance is plan-wide and nothing looks at the option.

**Both day sets are settled, and neither depends on the Sunday answer:**

| Option | `entitlement` |
|---|---|
| Monthly Full Membership | `{kind:"ALL"}` |
| Monthly 2 days (Tue/Thu) | `{kind:"DAYS", days:[2,4]}` |

Under absolute, `days:[2,4]` excludes Sunday Funday for the $110 member, which
is exactly what the option is sold as. **No live member loses anything** —
nobody is on the $110 option yet.

**The Sunday question is not an option question.** *"Does $175 include Sunday?"*
is answered on the Sunday Funday class's accepted-plans list, not on the MS/HS
option:

- **Keep MS/HS accepted for Sunday Funday** → `ALL` means Mon·Tue·Thu·Sun. A
  $175 member gets four days, and the separate $80 Sunday Funday plan is for
  people who want *only* Sunday.
- **Remove MS/HS from Sunday Funday's accepted list** → `ALL` means
  Mon·Tue·Thu, because those become the only classes MS/HS is accepted for.
  Sunday then needs the $80 plan or the $25 drop-in.

**D1a answered, 2026-08-16: Sunday Funday stays included** for MS/HS and every
other plan currently on it. No class-acceptance edit. So a $175 Full member is
entitled Mon·Tue·Thu·Sun, and the $110 Tue/Thu member is entitled Tue·Thu only —
which is the one behaviour change in this area, and it affects nobody today
because the $110 option has no subscribers.

**Never enumerate `days:[1,2,4]` on the Full option to express this.** It gives
the same behaviour today and silently un-covers every full member the day the
club adds a Wednesday session. Acceptance controls *which classes*; `ALL` then
means "all of them" and stays true as the schedule changes. That is why `ALL` is
a distinct kind and not sugar for a full day list.

**Related finding, its own decision.** Aylen Grubusic and Clint Dwyer each pay
$80/month for the Sunday Funday plan — for a class every MS/HS, Girls MS/HS, Jr
Frogs and Girls Jr Frogs member already attends free under the current
acceptance list. If Sunday is meant to be separately sold, that list is where it
leaks. (Their $80 is also above the plan's listed $75 — §8.11 X7.)

---

## 8.4 Attendance enforcement — the warning

This is what makes the entitlement real. It is a **warning with a reason and an
amount, never a block.**

### 8.4.1 One resolver

`lib/entitlements.ts` — pure, no Prisma, fed by the caller, so a fixture can
construct every branch by hand (same discipline as `lib/memberTracks.ts` and
`lib/bulkPriceChange.ts`).

```ts
export type CoverageReason =
  | "COVERED"
  | "NO_ACTIVE_MEMBERSHIP"     // no sub, or the sub doesn't countAsMembership
  | "PLAN_NOT_ACCEPTED"        // has a plan; this class doesn't take it
  | "DAY_NOT_INCLUDED"         // the one this phase adds
  | "TERM_ENDED"               // sub active but endDate/paidThroughDate passed
  | "OPTION_UNIDENTIFIED";     // optionId null and inference failed

export type CoverageVerdict = {
  covered: boolean;
  reason: CoverageReason;
  /** One front-desk sentence. Never a stack of clauses. */
  message: string;
  planName: string | null;
  optionLabel: string | null;
  optionResolution: "exact" | "inferred" | "unresolved" | "none";
  entitledDays: number[] | null;
  sessionWeekday: number;
  /** From the class's existing pricingOptions. Null when none is configured. */
  dropIn: { amount: number; source: "dropin" | "nonmember" } | null;
};
```

**`OPTION_UNIDENTIFIED` fails open.** `covered: true`, and the message reads
*"Could not identify which option Colton is on — coverage not checked."* It
never claims a member owes money. A warning system that cries wolf on the nine
rows in §8.1 would be switched off within a week, and the nine rows are exactly
the members whose billing is already unusual. **Warn only on a positive day
mismatch.**

`dropIn` reads the class's existing `pricingOptions` — `dropin` price first,
then `nonmember`. If neither is configured, `dropIn: null` and the message says
*"no drop-in price is set on this class"* rather than inventing one.

### 8.4.2 Where it surfaces

| Surface | Change |
|---|---|
| `GET /api/attendance/[sessionId]` | add `coverage: CoverageVerdict` per existing attendance row; add `acceptedOptions` alongside the existing `acceptedMemberships` |
| `GET /api/attendance/[sessionId]/coverage?memberIds=…` | **new**, read-only. Feeds `QuickAddForm`'s search results so the chip is visible *before* staff click Add |
| `POST /api/attendance` | return `coverage` in the response. **Never a 4xx on a coverage verdict** |
| `POST /api/attendance/charge` | same |
| `POST /api/classes/[id]/charge` | same — and when `coveredByMembership` would be returned on a `DAY_NOT_INCLUDED` day, it must **not** be; the member falls through to the priced tier with the verdict attached |
| `POST /api/member/classes/book` | same rule on the self-serve path. A Tue/Thu member booking Monday is quoted the drop-in, not booked free |
| `GET /api/member/schedule` | `bookingLabel` stops saying *"Included in your membership"* on a non-entitled day; says *"Drop-in $25 — your plan covers Tue & Thu"* |
| `POST /api/member/checkin/[id]` | verdict decides `PRESENT` vs `TRIAL`-equivalent; today it is `covered ? PRESENT : TRIAL` |

**Staff paths warn. Member self-serve paths price.** A coach can always record
attendance; a member self-booking a day they did not buy gets quoted rather than
silently given a free session. That asymmetry is the point — the front desk has
judgement, the portal does not.

### 8.4.3 The UI

Reuse the **`OwesChip`** pattern already in `app/dashboard/attendance/page.tsx`
(a chip on the row plus an expandable panel, with the existing precedent
*"Attendance allowed — payment still due; the chip stays until it's
recorded"*). Do not invent a second warning idiom.

Copy, on the row:

> **Tue/Thu plan** · Monday isn't included · Drop-in $25

Expanding gives the sentence and one action: **Record drop-in**, which opens the
existing drop-in sub-panel pre-filled with `dropIn.amount` and the member
selected. It does **not** create a new payment path — it points at the one that
already handles cash / check / comp / invoice / saved card / Stripe checkout.

If staff record attendance and take no payment, the existing **Owes** chip is
the follow-through, and it already persists until money is recorded. The two
chips are complementary: *not entitled* is about the plan, *owes* is about the
money.

### 8.4.4 What it must not do

- Never block. `requirePermission(session, "attendance", "edit")` is the only
  gate; entitlement is information.
- Never write. The coverage endpoint is read-only, like the price preview.
- Never fire on `OPTION_UNIDENTIFIED`, `TERM_ENDED` where `paidThroughDate` is
  null (unknown ≠ expired), or on a member with no plan at all — that last case
  is already served by the existing non-member pricing and would double up.

---

## 8.5 Does class acceptance have to become option-level?

**No — and this is the cheap answer, which is why it is the recommended one.**

The brief's worry is correct in general and does not bite here: *"If MS/HS
collapses to one plan, a $110 two-day member gains access to three-day classes."*
With §8.3, they do not. They are accepted by Olympic Season at the plan level
and blocked on Monday by the day rule. Acceptance answers *which classes*; the
entitlement answers *which days*. The pair covers the actual shape.

**What option-level acceptance would additionally buy:** the ability to exclude
an option from a class on *every* day that class runs, while another option with
the *same* days is included. That configuration does not exist in the club today
and there is no plan to create it.

**What it would cost, if ever wanted:** `pricingOptions` entries grow an
optional field —

```jsonc
{ "type": "membership", "membershipId": "cmq9zoo3n…", "optionIds": ["opt_a","opt_b"] }
```

— `null`/absent meaning "all options on this plan", so every existing row keeps
working. Then **all nine coverage call-sites in §8.0.5 need the extra predicate**,
plus the class editor's "Accepted Memberships / Purchase Options" checkbox list
becomes a two-level tree, plus `trialCoversClass` and the free-trial scoping
need the same treatment. That is roughly the same surface area as §8.4 itself,
for a case with no current instance.

**Recommendation: ship day entitlements, keep acceptance plan-level, and
reserve `optionIds` in the `pricingOptions` shape** so adding it later needs no
data reshape. **Decision D2, §8.12.**

---

## 8.6 Autopay per member

### 8.6.1 The field the schema does not have

`MemberSubscription.autoRenew` is currently doing two jobs and only names one.
They must be separated before anything is built:

- **Auto-renew** — *does this membership continue after this term.* Stripe
  expresses it: `cancel_at_period_end` / `cancel_at`. Today's `autoRenew: false`
  on the Stripe path is implemented as `cancel_at` computed at creation
  (`approve:509-518`), which goes stale the moment the anchor moves.
- **Autopay** — *is the club charging a card automatically, or collecting cash
  each period.* Stripe expresses it by the **existence of a subscription**.
  There is no field: today it is implied by
  `billingType === "MANUAL" || stripeSubscriptionId === null`.

The brief's item 5 is about **autopay**. It already states the right conclusion
and this spec confirms it: *both directions are subscription lifecycle events,
not toggles.*

**No new column for autopay.** It is derivable, and a stored flag that can
disagree with Stripe is worse than a derived one. Add a *transition*, not a
field.

### 8.6.2 The two transitions

**Autopay ON → OFF** (Stripe-billed → MANUAL):

1. Refuse unless a period end is known (`currentPeriodEnd` or
   `paidThroughDate`). Without it nobody knows when cash is next due, and the
   member silently stops being billed. Offer "reconcile from Stripe first".
2. `stripe.subscriptions.update(id, { cancel_at_period_end: true })` — **not**
   an immediate cancel, which voids time already paid for.
3. Read back and verify before writing locally (same discipline as the price
   tool's apply).
4. On the `customer.subscription.deleted` webhook: set
   `billingType: "MANUAL"`, `stripeSubscriptionId: null`,
   `stripePriceId: null`, keep `price`, stamp
   `paidThroughDate` from the last paid invoice, keep `status: "active"`.
5. `member_subscription_events` row, `kind: PLAN_CHANGED`,
   `fromAmount = toAmount` (nothing about the money changed),
   `detail: { autopay: "off", stripeSubscriptionId: "sub_…" }`.
   Per the brief, `PLAN_CHANGED` is the right kind and churn reads it.
6. `BillingAuditLog`.

Between (2) and (4) the row is *"autopay ending on <date>"* — a real state the
billing centre must render, not a gap.

**Autopay OFF → ON** (MANUAL → Stripe-billed):

1. Require a verified, attached payment method —
   `resolveChargeablePaymentMethodId` (the Mack Munroe guard). No card →
   `CARD_SETUP_REQUIRED`, send the setup link, **change nothing**. Never flip
   optimistically.
2. Amount = `recurringUnitWithFee(Math.round(sub.price * 100), club.passProcessingFees)`
   — from **the subscription's own price**, not the plan's option price. Reading
   the option here is how you silently reprice a member who holds an override.
   `stripeUnitAmountCents` already does exactly this and must be reused.
3. `trial_end` = `paidThroughDate ?? currentPeriodEnd`, so the first charge lands
   when the paid period ends. Never charge on the day the toggle is flipped —
   the same rule the migration-approve path already follows.
4. Create the subscription with a params-hashed idempotency key (the Mack Munroe
   burned-key lesson: a static per-member key is permanently poisoned by one
   failure).
5. Write `stripeSubscriptionId`, `stripePriceId`, `billingType: "RECURRING"`;
   `PLAN_CHANGED` + `BillingAuditLog` as above.

**One row, not two.** `stripeSubscriptionId` is `@unique`, so the OFF path must
null it before a later ON path can attach a new one. The alternative — a new row
chained by `renewedFromId` — keeps a cleaner Stripe history but changes which
row every other reader considers "the" subscription (the billing centre, all
nine coverage call-sites, the price tool, `countsAsMembership`). Recommend one
row, with both Stripe ids recorded in the event `detail` so the history is
recoverable. **Decision D6, §8.12.**

### 8.6.3 Who can do it

| Actor | Route | Behaviour |
|---|---|---|
| Owner / staff | `POST /api/members/[id]/billing-admin/actions` → `action: "set_autopay"` | `billing:full`, `confirm: true` required, audited. Same shape as the existing `set_deliberate_free`. Executes immediately. |
| Member / guardian | `POST /api/member/subscriptions/[id]/autopay` | **queues a `PendingApproval`**, kind `MEMBERSHIP_AUTOPAY_CHANGE`. Returns 202. |

The member path queues for the same reason `request-cancel` queues: the
subscription lifecycle is the club's money, and members have never been given a
Stripe Customer Portal button. It also means "turn autopay on" cannot be used to
start a charge the club did not agree to. The approvals queue shows the exact
next charge date and amount before the owner approves. **Decision D8, §8.12.**

The confirm dialog on both sides states, verbatim from the computed values:
*"Autopay off — Stripe will stop after 16 Sep 2026. From then the club collects
$175 every month by cash or check."* / *"Autopay on — first card charge $180.08
on 16 Sep 2026."* (The $180.08 is the $175 sticker with the club's 2.9%
passthrough; the dialog must show what the card will actually be charged, not
the sticker.)

### 8.6.4 Auto-renew gets a writer too

Separately from autopay, add `action: "set_auto_renew"` on the billing-admin
actions route. On a Stripe row it maps to `cancel_at_period_end`, **not** a
recomputed `cancel_at` — a `cancel_at` calculated at creation time is the reason
eleven rows now say `autoRenew: true` next to an `endDate` (§8.0.8). New writes
use `cancel_at_period_end`; the existing `cancel_at` values are a data question,
not a code question.

---

## 8.7 The bulk price tool starts from the membership

### 8.7.1 What changes

| Today | After |
|---|---|
| Entry: `{optionLabel, billingPeriod, newPrice?}` | Entry: `{}` — the whole plan. Option filter optional. |
| Matcher: `(membershipId, billingPeriod)` | Matcher: `optionId` → inferred `(billingPeriod, price)` → unresolved bucket |
| 409 `AMBIGUOUS_PERIOD` when two options share a period | Gone. `resolveOption`'s ambiguity refusal existed only because the period was the identity. |
| One `newPrice` for the whole run | Per-row target: `toPrice?` and/or `toOptionId?` |
| `moves[]` as a separate array, offline-only | Folded into the same per-row change. Still offline-only, same reason. |

### 8.7.2 The screen

One list per the brief: **every member on MS/HS**, grouped by resolved option,
with an *Option not identified* group at the bottom.

```
MS/HS — 11 members

  Monthly Full Membership · $175/mo · no minimum          (6)
    Levi Schanzenbach   $175  stripe   [$175 ▾] [move ▾] [leave]
    Max Hall            $175  offline  [$175 ▾] [move ▾] [leave]
    …
  3 months Upfront · $450 per 3 months · 3-month term      (1)
    Kellan Lister       $450  stripe   ⚠ stored label "Upfront"
  1 year · $1500/yr · 12-month term                        (2)
  Monthly 2 days (Tue/Thu) · $110/mo · Tue & Thu           (0)
  Option not identified                                    (2)
    Colton Waite       $530  offline  ⚠ $530 on a MONTHLY row
    Wyatt Eastman        $0   offline  ⚠ $0 with no comp marker
```

Per row, three mutually exclusive choices — exactly the brief's three cases:
**new rate for their option** · **different option** · **leave alone**.

Everything that already exists is preserved per row: channel badge, `onListPrice`
vs override, upfront credit / additional-due with `UNKNOWN` when no period end
is stored, Stripe-status warnings, discount-code warning, and
`canChangeOption: false` on Stripe rows with the existing reason — *changing a
Stripe subscription's billing interval in place re-anchors the cycle*. **That
constraint is not reopened.** Moving a Stripe member to a different option
remains a billing-centre operation (cancel-at-period-end plus a new subscription
anchored with `trial_end`), which is now exactly the machinery §8.6.2 builds —
so the price tool can *link* to it rather than refuse silently.

### 8.7.3 API shape

```
POST /api/memberships/[id]/price-change/preview
  {}                                        // whole plan
  { optionId?: string }                     // one option
→ { membership, options[], groups[{ optionId, option, rows[] }], unresolved[],
    summary, moveTargets, notes }

POST /api/memberships/[id]/price-change/apply
  { changes: [{ memberSubscriptionId, toPrice?, toOptionId?, toMembershipId? }],
    notifyBeforeDate?, notify, notifySubscriptionIds?, memo?, reconcileLabel,
    clientKey }
→ { results: ApplyRowResult[] }             // per-row outcomes, unchanged
```

`optionLabel`/`billingPeriod` stay accepted on preview for one release so the
existing modal keeps working; the option-index entry point from the edit screen
(`initialOptionIndex`) becomes a pre-applied filter on the full list rather than
the only way in.

**Unchanged and non-negotiable:** `requireOwner` on both routes (repricing the
book of business is not `billing:full`); preview writes nothing; increases refuse
without a future effective date (`validateNotice` + `directionForRows`, which
already compute direction per row and therefore already handle a mixed run);
`proration_behavior: "none"`; Stripe-first-verify-then-DB with per-row rollback;
`member_subscription_events` on every change.

---

## 8.8 Stripe — what it can and cannot express

### 8.8.1 Contract term — Stripe cannot hold it, and nothing technical stops a cancellation

**Stripe has no minimum-term primitive.** Subscription Schedules define phases
and an `end_behavior`; they do **not** prevent cancellation —
`subscriptions.cancel()` and `cancel_at_period_end` still work on a scheduled
subscription. There is no field, on any Stripe object, that means "this customer
may not leave before March."

**So the commitment lives entirely on our side**, in two places:

1. **`MemberSubscription.minimumTermEndsAt`** — computed at purchase from
   `option.contractMonths` and the billing anchor. Null = no minimum.
2. **The cancellation door.** This is the part that actually works, and it
   already exists: `POST /api/member/subscriptions/request-cancel` does not
   cancel anything. It files a `MEMBERSHIP_CANCEL` `PendingApproval`, and
   `/api/approvals/membership-cancel` performs the real Stripe cancellation
   after an owner approves. **AthletixOS has never exposed a Stripe Customer
   Portal cancel button.** The club's approval queue *is* the enforcement point.

**What Phase 8 adds:** the cancellation request is still always accepted — never
silently refused — but when `now < minimumTermEndsAt` it is stamped
`earlyTermination: true` with months remaining and the amount implied by
`option.contractMonths × price`, and the approvals queue shows the owner what is
outstanding before they approve. The software surfaces the obligation; a person
decides.

**Name the field `minimumTermEndsAt`, not `commitmentEndDate`.** The existing
`Member.commitmentEndDate` means the **opposite**: it is passed to Stripe as
`cancel_at` and written to `MemberSubscription.endDate` — the date the
membership *ends*. A minimum term is a floor, not a ceiling. Reusing that name,
or that column, would put "cannot leave before" and "stops on" in one field, and
every reader would have to guess. Two names, both commented, pointing at each
other.

**What genuinely stops someone cancelling in month 2:** nothing in code, and the
spec should not pretend otherwise. The residual exposure is a card removal or a
chargeback, which no software prevents. If the club wants real recourse the
instrument is a signed agreement, and AthletixOS already has the machinery —
`Document.requiredAt: ["PURCHASE"]` plus the signature table. Recommendation:
**an option with `contractMonths` set may name a required document**, so buying
a 12-month term collects a signature at purchase. That is the only enforcement
that survives contact with a dispute. **Decision D7, §8.12.**

### 8.8.2 Per-member autopay — both directions are lifecycle events

Confirmed, and specified in §8.6.2. Restated as the plain answer to the brief's
question:

- **Autopay OFF on a Stripe member** = `cancel_at_period_end: true`, then on the
  deletion webhook flip the row to `billingType: "MANUAL"` with
  `stripeSubscriptionId: null` and a stamped `paidThroughDate`. Not an immediate
  cancel — that would void paid time. Not a field write.
- **Autopay ON for a cash member** = create a subscription, which requires a
  verified attached payment method, the member's own `price` passed through
  `recurringUnitWithFee`, and `trial_end` at the paid-through date so the first
  charge is not today.
- Neither is free or reversible-for-free: each ON mints a new Stripe
  subscription id. `stripeSubscriptionId` is `@unique`, so the OFF path must
  null it first (§8.6.2).
- Both write `member_subscription_events` `PLAN_CHANGED` with equal from/to
  amounts, because the money did not change — only the mechanism. Churn
  reporting must not read an autopay change as a price move.

### 8.8.3 Day entitlements never reach Stripe

**Confirmed: nothing about entitlements needs to reach Stripe, and nothing
will.** Stripe holds a customer, an amount, an interval, and a status. It has no
concept of a weekday grant and no place to put one that would be enforced. The
only Stripe-visible consequence of the Tue/Thu option is its `unit_amount`:
$110 → $113.19 with the club's 2.9% passthrough, against $175 → $180.08 for the
full option.

One optional, non-authoritative addition: stamp
`metadata: { athletixOptionId }` on new subscriptions, purely so a Stripe
dashboard row can be traced back to an option during an incident. It must be
documented as **never read back for authorization** — the same discipline as
the existing `athletixMembershipId` product metadata.

Also worth recording, because it shapes the ON path: **`Membership.stripePriceIds`
is `{}` on every plan in production.** Subscriptions are created with inline
`price_data`, not catalog Price ids (`ensureRecurringPrice` exists but has never
populated a map). Nothing in Phase 8 depends on catalog prices, and the ON path
should keep using inline `price_data` rather than introduce a second mechanism
mid-phase.

---

## 8.9 Schema

**Everything is additive. No column is dropped, no enum shrinks, no destructive
backfill. No migration is written in this spec.**

### 8.9.1 DDL — one migration, two columns, one index

| # | Change | Type | Purpose |
|---|---|---|---|
| P8-1 | `MemberSubscription.optionId TEXT NULL` | Additive | §8.1. Null on every existing row; readers fall back to inference and then to "unresolved". No FK — the target is a key inside a JSON array, not a table. |
| P8-2 | `MemberSubscription.minimumTermEndsAt TIMESTAMPTZ NULL` | Additive | §8.8.1. Null = no minimum, which is every existing row. Deliberately **not** `commitmentEndDate` — opposite meaning, see §8.8.1. |
| P8-3 | `@@index([membershipId, optionId])` on `member_subscriptions` | Additive | The price tool groups a plan's subscribers by option. |

No new table ⇒ no new RLS policy. Folder timestamp must sort after
`20260815000000_member_created_via`.

**Ordering is load-bearing, and there is a precedent for getting it wrong.**
`schema.prisma` must not name `optionId` until the column exists in production —
Prisma selects every scalar a model declares, so declaring it early takes down
*every* subscription read, not just the new code. That is the exact failure the
`Member.createdVia` migration comment warns about. Apply, verify the live column,
then edit the schema.

### 8.9.2 JSON shape — no DDL, but a real contract

`Membership.options` is a `Json` column that stores a JSON **string** (verified:
`jsonb_typeof(options::jsonb) = 'string'`, which is why `parseMembershipOptions`
double-parses). Its entries gain four optional keys:

```jsonc
{
  "id":            "opt_k3f9c1qa",   // §8.1  — minted, stable, never reused
  "label":         "Monthly 2 days (Tue/Thu)",
  "price":         110,
  "billingPeriod": "MONTHLY",

  "contractMonths":     null,        // §8.2  — absent ⇒ inherit Membership.contractMonths
  "autoRenewDefault":   true,        // §8.2  — absent ⇒ inherit plan column
  "allowManualRenewal": true,        // §8.2  — absent ⇒ inherit plan column
  "entitlement":  { "kind": "DAYS", "days": [2, 4] }   // §8.3 — absent ⇒ {kind:"ALL"}
}
```

Validated on read by `lib/membershipOptions.ts`, extending the existing
`parseMembershipOptions` discipline: an entry missing `label`, `billingPeriod`
or a finite `price` is **skipped**, and a malformed `entitlement` degrades to
`{kind:"ALL"}` rather than to "no access". Degrading toward *more* access is the
right direction for a field that gates a child's class.

The option editor must **refuse to save two options sharing both
`billingPeriod` and `price`** on the same plan — that is the only condition
under which the §8.1 inference fallback becomes ambiguous, and refusing at
write time is cheaper than resolving it forever after.

### 8.9.3 Reserved, not built

- `pricingOptions` entry: `optionIds?: string[]` (§8.5) — reserve in the type,
  do not read it.
- `Entitlement` discriminant: `{kind:"COUNT", perWeek}` (§8.3.1) — reserve,
  do not build.
- Option key: `requiredDocumentIds?: string[]` (§8.8.1) — reserve pending D7.

### 8.9.4 No migration needed for

`PendingApproval.kind` is a free string — `MEMBERSHIP_AUTOPAY_CHANGE` needs no
DDL. `MemberSubscriptionEvent.kind` already includes `PLAN_CHANGED`, which is
the right kind for every Phase 8 transition per the brief.

---

## 8.10 Migration path — collapsing two live plans into one

**Precondition: §8.1 and §8.2 are shipped and the option-id backfill has run.**
The collapse puts four MONTHLY options on MS/HS. Doing it before subscriptions
name their option leaves the price tool permanently unable to tell $175, $160,
$150 and $110 members apart.

The whole collapse touches **one live subscription** and **zero Stripe objects**.

### Step 0 — Interim: give commitment members class coverage now (data)

**Only if the collapse is not running this week.** D4 says commitment members
should be covered, and Maximus Alexander is being drop-in priced today. The
collapse (Steps 3–8) fixes this structurally and makes Step 0 unnecessary — so
run Step 0 *only* as a stopgap, and expect to undo it.

Add each commitment plan to exactly the classes its parent plan is already
accepted for:

| Plan to add | Add to these classes | Because |
|---|---|---|
| `MS/HS 3 or 12 months Commitment` `cmspjh1bq…` | **Ms/HS Olympic Season**, **MS/HS Preseason** | the two classes MS/HS is accepted for |
| — | **Sunday Funday** — only if D1a keeps MS/HS on it | match MS/HS exactly; do not grant more than the parent plan |
| `Jr Frogs Monthly Commitment` `cmsqv1ldd…` | **Jr Frogs**, **Sunday Funday** | the two classes Jr Frogs is accepted for |

Mechanically this is appending `{"type":"membership","membershipId":"<id>"}` to
each class's `pricingOptions` array — the same edit the class editor's "Accepted
Memberships / Purchase Options" checkboxes make, so it can be done in the UI
without a script.

**Jr Frogs Monthly Commitment has zero subscribers**, so adding it changes
nothing today; it is purely defensive against someone buying it before the
collapse. **Only Maximus Alexander benefits**, and only from the MS/HS row.

**Step 8 must then also un-add these**, or the deactivated plans stay listed in
six class configs forever. That undo is the reason to prefer just doing the
collapse.

### Step 1 — Mint option ids (data)

`scripts/mint-option-ids.ts`, dry-run by default, `--apply` to write. Idempotent:
options that already carry an `id` are skipped. Runs across every plan including
soft-deleted ones, so historical rows can still resolve.

### Step 2 — Backfill `MemberSubscription.optionId` (data)

`scripts/backfill-subscription-option-id.ts`. Unique `(billingPeriod, price)`
match only. **Expected result, measured against production: 18 stamped, 9 left
null, 0 ambiguous** (§8.1). The nine are printed with member name, plan, stored
label and the reason — that report is the deliverable, not a side effect.

### Step 3 — Add the two options to MS/HS (data)

Append to `MS/HS.options`, each with a fresh id:

```jsonc
{ "label": "3 Months",  "price": 160, "billingPeriod": "MONTHLY", "contractMonths": 3  }
{ "label": "12 months", "price": 150, "billingPeriod": "MONTHLY", "contractMonths": 12 }
```

MS/HS now has six options and four MONTHLY ones. No pair shares both period and
price, so §8.1's inference stays unambiguous.

### Step 4 — Set per-option terms on the four existing MS/HS options (data)

| Option | `contractMonths` |
|---|---|
| Monthly Full Membership | `null` |
| Monthly 2 days (Tue/Thu) | `null` |
| 3 months Upfront | `3` |
| 1 year | `12` |

`Membership.contractMonths` stays `1` as the fallback for anything unset. Nothing
reads it today (§8.0.3-D3), so this changes no behaviour until §8.8.1 ships.

### Step 5 — Set entitlements (data)

| Option | `entitlement` |
|---|---|
| Monthly Full Membership | `{kind:"ALL"}` — **not** `[1,2,4]`; see §8.3.3 |
| Monthly 2 days (Tue/Thu) | `{kind:"DAYS", days:[2,4]}` |
| 3 months Upfront · 1 year · 3 Months · 12 months | `{kind:"ALL"}` (omit the key) |

**D1 answered — these sets are final** (§8.3.5). Under absolute day sets the
Tue/Thu option no longer covers Sunday Funday; nobody is on that option yet, so
no live member is affected. Whether the **$175 Full** option covers Sunday is
settled separately, on the Sunday Funday class's accepted-plans list (D1a), and
does not change any value in this table.

### Step 6 — Repoint the one live subscriber (data)

Maximus Alexander — "12 months", $150 MONTHLY, Stripe, active, `endDate`
2027-08-09.

```
UPDATE member_subscriptions
   SET "membershipId" = <MS/HS>, "optionId" = <12-months option id>
 WHERE id = <his subscription id>;
```

**Nothing Stripe-side is touched.** `price` stays $150, `billingPeriod` stays
MONTHLY, `stripeSubscriptionId` is untouched, no interval change, no anchor
change, no proration. The brief's constraint — *changing a Stripe subscription's
billing interval in place is unsafe, do not reopen it* — is respected because
this operation goes nowhere near it. What changes is which local plan row the
subscription points at.

Write one `member_subscription_events` row:

```
kind:        PLAN_CHANGED
fromPlan:    "MS/HS 3 or 12 months Commitment"
toPlan:      "MS/HS"
fromAmount:  150.00
toAmount:    150.00        ← equal, deliberately
actorUserId: <owner>
source:      OWNER_ACTION
detail:      { reason: "plan collapse", stripeUntouched: true,
               fromMembershipId, toMembershipId, toOptionId }
```

Equal amounts matter: churn and revenue reporting read this table, and a
`PLAN_CHANGED` with unequal amounts would show as a price movement in a month
where no money moved.

### Step 7 — Repoint `Member.membershipId` (data)

Same member. His `Member.membershipId` currently points at the commitment plan.
Leaving it stale would make `resolveOfferPricing` quote him against a
deactivated plan.

### Step 8 — Deactivate the old plan, do not delete it (data)

```
UPDATE memberships SET active = false WHERE id = 'cmspjh1bq…';
```

**Do not set `deletedAt` and do not delete.**
`MemberSubscription.membershipId` is `onDelete: Cascade` — a hard delete would
destroy subscription history. And several readers filter `deletedAt: null`
(including the price-change preview), so a soft delete would make historical
rows fail to resolve their plan name. `active = false` removes it from every
purchase surface (which all filter `active: true`) and from the price tool's
`moveTargets`, while leaving every historical row readable. That is exactly the
behaviour wanted.

### Step 9 — Verify the coverage change is intended

Repointing Maximus to MS/HS **grants him class coverage he does not have today**
(§8.0.6). That is a fix, not a side effect, but it changes what he can book and
what the club can charge him — confirm before Step 6. **Decision D4, §8.12.**

### Step 10 — Jr Frogs, same shape, easier

Append `{"3 months", 90, MONTHLY, contractMonths: 3}` and
`{"12 months", 80, MONTHLY, contractMonths: 12}` to Jr Frogs; deactivate
`Jr Frogs Monthly Commitment`. **Zero live subscribers** — Steps 6, 7 and 9 are
no-ops. Set `Monthly` → `{kind:"ALL"}`; Jr Frogs classes run Mon·Wed and Sun and
there is no day-restricted Jr Frogs option today.

### Step 11 — Explicitly out of scope

`Girls MS/HS` and `Girls Jr Frogs` still carry the pre-2026 price list
($190/$530/$2000 and $110/$300/$1000) and have their own subscribers. Do not
fold, reprice or restructure them in this pass — that is a separate decision
with its own review screen.

### Step 12 — Note, do not fix: the plan generator

`/api/reactivate/[token]/confirm:270` **creates a new `Membership`** per
reactivation offer, with a single synthetic option. That is the source of the
seven soft-deleted `Continued membership` plans and two `Elite National Champ`
plans in production. It will keep manufacturing one-option plans. Out of scope
for Phase 8; worth its own item.

---

## 8.11 Code vs data corrections

### Code (ships once, applies to everyone thereafter)

| # | Item | Files |
|---|---|---|
| C1 | `lib/membershipOptions.ts` — parse/validate, mint ids, `resolveSubscriptionOption`, `describeOption` | new |
| C2 | `optionId` written on every purchase path | `member/memberships/subscribe`, `members/subscribe`, `migration/[id]/approve` (also stops writing `optionLabel: planName`), `migration/activate/[token]`, `approvals/membership-purchase`, `reactivate/[token]/confirm`, `members/[id]/billing-admin` |
| C3 | Per-option terms in the editor + API | `dashboard/memberships/page.tsx`, `api/memberships/{route,[id],[id]/duplicate}` |
| C4 | `lib/entitlements.ts` — the coverage resolver | new |
| C5 | Coverage wired into the nine call-sites (§8.0.5) | per §8.4.2 |
| C6 | Attendance warning chip + `/coverage` endpoint | `dashboard/attendance/page.tsx`, `api/attendance/[sessionId]/coverage` |
| C7 | Autopay transitions | `members/[id]/billing-admin/actions` (`set_autopay`, `set_auto_renew`), `member/subscriptions/[id]/autopay`, `approvals/`, `stripe/webhook` |
| C8 | `minimumTermEndsAt` stamped at purchase; early-termination flag on cancel requests | purchase paths, `member/subscriptions/request-cancel`, `approvals/membership-cancel`, approvals UI |
| C9 | Price tool: membership-first entry, per-row targets, option grouping | `lib/bulkPriceChange.ts`, both price-change routes, `components/BulkPriceChangeModal.tsx` |
| C10 | Tests | `scripts/entitlements-tests.ts` (new), extend `bulk-price-change-tests`, `billing-admin-tests`, `member-tracks` |

**None of C1–C10 repairs a row already written.**

### Data corrections — Julian runs these, dry-run by default, `--apply` to act

| # | Script / action | Scope |
|---|---|---|
| X1 | `scripts/mint-option-ids.ts` | every plan, incl. soft-deleted |
| X2 | `scripts/backfill-subscription-option-id.ts` | 27 live subs → 18 stamped, 9 reported |
| X3 | `scripts/collapse-membership-plans.ts --plan MS/HS` | Steps 3–9 |
| X4 | `scripts/collapse-membership-plans.ts --plan "Jr Frogs"` | Step 10 |
| X5 | **`scripts/audit-stripe-cancel-at.ts` — run this first, ahead of everything else in the phase** | 12 active Stripe subs carry a local `endDate`; 11 of those also say `autoRenew: true`, and `stripeSnapshot` is empty on all but one, so the DB cannot say which side is true. Read-only, no `--apply`, only `subscriptions.retrieve`. Four of the twelve read as ending within five weeks. §8.0.8 |
| X6 | Still open from 2026-08-14, and now blocking X2's clean report | Barrett David + Paul Ortega → `set_deliberate_free`; Wyatt Eastman (prepaid annual, no transaction); Colton Waite ($530 on a MONTHLY row); Devin Eggleston (comp with no subscription) |
| X7 | Optional | Adelynn Bergen / Riley Bergen ($750 annual legacy rate), Aylen Grubusic / Clint Dwyer ($80 vs $75 list) — deliberate overrides or drift? The price tool can settle these once it starts from the membership (§8.7). |

X6 is not cosmetic here. Four of the nine unresolved rows in X2 are those exact
members, and a coverage warning on an unidentifiable option fails open (§8.4.1) —
so until they are settled, four members are outside the entitlement system.

---

## 8.12 Decisions needed before building

| # | Question | Recommendation |
|---|---|---|
| ~~**D1**~~ | Does `{kind:"DAYS", days:[2,4]}` gate **every** class the plan is accepted for? | ✅ **ANSWERED 2026-08-16 — absolute.** Day sets settled: Full = `ALL`, 2-day = `DAYS[2,4]`. §8.3.5 |
| ~~**D1a**~~ | Should MS/HS stay in the **Sunday Funday class's** accepted-plans list? | ✅ **ANSWERED 2026-08-16 — yes, Sunday Funday stays included** for MS/HS and the rest. No class-acceptance edit. `ALL` on the Full option therefore means Mon·Tue·Thu·Sun. §8.3.5 |
| **D2** | Should class acceptance become option-level? | **No** — reserve `optionIds`, do not read it. Cheap to add later, expensive to remove. §8.15.1 |
| ~~**D3**~~ | Does a member's entitlement snapshot at purchase, or track the option? | ✅ **ANSWERED 2026-08-16 — live, not snapshotted.** No `entitlementSnapshot` column; the editor's affected-member count becomes required UI. §8.3.4 |
| ~~**D4**~~ | Repointing Maximus grants him class coverage he lacks today. Intended? | ✅ **ANSWERED 2026-08-16 — yes, fix it; commitment members should be covered.** See §8.10-0 for the interim fix that does not wait on the collapse. §8.0.6 |
| **D5** | `allowManualRenewal` has no reader. Give it one, or delete it? | **Drop it** from the option shape and the editor; keep the column. D11's modes answer the question it was gesturing at. §8.15.2 |
| **D6** | Autopay OFF→ON: one row with a churning `stripeSubscriptionId`, or a new row chained by `renewedFromId`? | **One row, transition completed synchronously — not on the deletion webhook.** The closest call on this list. §8.15.3 |
| **D7** | Should an option with `contractMonths` require a signed document at purchase? | **Yes, option-level**, built alongside the term work. The club-wide PURCHASE mechanism cannot express it. §8.15.4 |
| **D8** | Member-initiated autopay change: queue for approval, or immediate? | **Queue**, matching `request-cancel`. Trivially reversible, and an asymmetric middle exists. §8.15.5 |
| **D9** | `resolveOfferPricing` quotes five of eleven MS/HS members wrong today (§8.0.7). Fix in Phase 8, or as its own item? | Its own item — but it **depends on** `optionId`, so land §8.1 first and schedule it immediately after. |
| ~~**D11**~~ | **`autoRenew` conflates two things.** Boolean, or a three-value renewal mode? | ✅ **APPROVED 2026-08-16 — three modes**, `OPEN_ENDED` / `TERM_THEN_ENDS` / `TERM_THEN_RENEWS`, derived, no new column; `autoRenew` redefined to "Stripe will bill this again", written from Stripe on Stripe-billed rows. §8.14.2 |
| **D12** | Should a staff-entered **End date** on a card-billed recurring membership become a Stripe `cancel_at`, or keep being refused? | **Yes — but only through D11's renewal-mode control, never as a bare date field.** The one one-way door on this list. §8.15.6 |
| ~~**D13**~~ | **Titus Hall:** local `endDate` 2027-07-14, Stripe holds no `cancel_at`. Which is true? | ✅ **ANSWERED 2026-08-16 — he does not renew.** The local `endDate` is right and Stripe is wrong; a `cancel_at` has to be set. Data correction, §8.14.3. |
| **D10** | "Monthly Full Membership" — `ALL`, or explicitly Mon·Tue·Thu? | **`ALL`.** Enumerating today's schedule silently un-covers members when a day is added. §8.3.3 |

---

## 8.13 Build order

Each step is independently shippable and leaves the app correct.

| # | Step | Gate |
|---|---|---|
| 8.13.1 | `lib/membershipOptions.ts` + migration P8-1/P8-2/P8-3 applied and verified live **before** `schema.prisma` names the columns | tsc + build clean; every existing membership read unchanged |
| 8.13.2 | X1 + X2 (mint ids, backfill) | report shows 18/9/0; the nine are the nine in §8.1 |
| 8.13.3 | Per-option terms (§8.2) — editor, API, `describeOption` | an option with no keys behaves identically to today |
| 8.13.4 | Price tool from the membership (§8.7) | MS/HS preview returns 11 members grouped by option, no 409 |
| 8.13.5 | X3 + X4 — the collapse | MS/HS shows six options; Maximus is on MS/HS at $150; Stripe untouched |
| 8.13.6 | Day entitlements (§8.3) — data shape + editor, **no enforcement yet** | saving days changes nothing observable |
| 8.13.7 | `lib/entitlements.ts` + coverage on read-only surfaces (§8.4.2 rows 1–2) | the chip appears; no write path behaves differently |
| 8.13.8 | Coverage on the write paths (§8.4.2 rows 3–8) | staff still record freely; member self-serve gets quoted |
| 8.13.9 | X5 — Stripe reconcile | the 11 contradictory rows resolved |
| 8.13.10 | `minimumTermEndsAt` + early-termination flag (§8.8.1) | cancel requests still always accepted |
| 8.13.11 | Autopay transitions (§8.6) | both directions verified against a real Stripe test subscription |
| 8.13.12 | Tests (C10) + full regression on the nine coverage call-sites | `tsc --noEmit` + `npm run build` clean |

**Acceptance, in the brief's own terms.** One MS/HS card. Six options. Each
carries its own price, billing period, contract length, renewal behaviour and
day grant as structured data. A $110 Tue/Thu member added to a Monday session
produces a chip reading *"Tue/Thu plan — Monday isn't included — Drop-in $25"*,
and the coach records them anyway. Opening the price tool on MS/HS lists all
eleven members, shows which option each is on and what each pays, and takes a
per-member decision. No existing Stripe subscription's interval, anchor or
amount was changed to get there.

---

## 8.14 Renewal semantics — the `autoRenew` question (D11)

Raised by the owner on 2026-08-16 after the `cancel_at` audit: *"'renews
forever' and 'has a term then ends' may need to be two different things rather
than one boolean."* That is the right instinct, and the audit proves it.

### 8.14.1 What the field means today, and why it lies

`MemberSubscription.autoRenew Boolean @default(true)` is written from
`Membership.autoRenewDefault` at creation and then almost never again. Its only
mechanical consequence is one branch in the checkout webhook: when it is
`false`, the webhook calls `cancel_at_period_end: true` on the new Stripe
subscription **and writes the true end date back** from Stripe's
`current_period_end`. When it is `true`, nothing happens — including nothing
that clears an `endDate` somebody typed.

So the flag does not describe the subscription. It describes a decision made at
creation. Eleven live rows say `autoRenew: true` while Stripe holds a real
`cancel_at`, because the end date arrived through a different door
(`Member.commitmentEndDate` → the approve route's `cancel_at`) that never
touched the flag.

### 8.14.2 The recommendation: three modes, derived, no new column

Do not add a second boolean. Derive a **renewal mode** in `lib/` from fields
that already exist, and give `autoRenew` one narrow meaning it can actually
keep:

```ts
export type RenewalMode =
  | "OPEN_ENDED"        // no end date. Bills until somebody cancels.
  | "TERM_THEN_ENDS"    // endDate set; Stripe holds cancel_at / cancel_at_period_end.
                        // Needs a re-sign conversation — this is the queue in §8.14.4.
  | "TERM_THEN_RENEWS"; // minimumTermEndsAt set, endDate null. Committed for a
                        // term, then keeps billing.
```

- **`autoRenew` is redefined to mean exactly "Stripe will bill this again"**,
  and on any Stripe-billed row it is *written from Stripe*, never authored
  locally. On MANUAL rows it stays locally authored, because there is no Stripe
  fact to mirror.
- With that definition the contradiction becomes structurally impossible:
  `autoRenew` and `endDate` would both come from the same read, so they cannot
  disagree.
- `TERM_THEN_RENEWS` is the mode the collapsed commitment options need — "3
  Months $160" and "12 months $150" are a *minimum term*, not an end date. It
  is exactly the distinction §8.8.1 draws between `minimumTermEndsAt` (a floor)
  and `endDate` (a ceiling), and it is why §8.2 moves `autoRenewDefault` onto
  the option: the same plan now has options that want different modes.

**Mapping the live rows:** the eleven with a genuine commitment end date are
`TERM_THEN_ENDS`. Girls Only, Tadpoles and Oren Oren are `OPEN_ENDED`. Nothing
is `TERM_THEN_RENEWS` yet — that mode arrives with the collapse.

**No member data changes to adopt this.** The mode is computed; the eleven rows
keep their dates. What changes is that `autoRenew` stops being displayed as
"renews" next to an end date, because the display reads the mode.

### 8.14.3 Titus Hall — the one row the audit could not settle (D13)

| Source | Says |
|---|---|
| `MemberSubscription.endDate` | 2027-07-14 |
| Stripe | no `cancel_at` — will keep billing |
| `Member.commitmentEndDate` | 2027-07-20 |
| `Member.membershipStartDate` | 2026-07-20 |

**How it diverged.** His live row was created 2026-07-14 through the staff
assign-membership modal (`components/members/MemberModals.tsx` → `POST
/api/members/subscribe`), whose form has a free-text **End date** field. That
route wrote `endDate` to the local row and sent nothing about it to Stripe —
Checkout has no `cancel_at` in `subscription_data`, and the webhook's only
end-date mechanism is the `autoRenew === false` branch, which did not run
because his `autoRenew` is `true`. The date has been decoration ever since.

**This is the exact inverse of the cancellation bug**: there, Stripe was told
and the answer was discarded; here, the local row was told and Stripe never
heard.

**Answered 2026-08-16: Titus does not renew.** The local `endDate` is the true
record and Stripe is the side that is wrong, so a `cancel_at` has to be set on
`sub_1TtE7BEIplcCMoSodSBfE6nd`.

The safe instrument is `cancel_at_period_end: true` rather than an absolute
`cancel_at`: it lets Stripe resolve the exact boundary from its own billing
period, and the F1 write-back pattern then stamps the resolved date onto
`endDate`, so the two sides end up agreeing by construction instead of by
coincidence. That is a Stripe write plus a DB write — Julian's to run, and
there is no UI for it until §8.6.4 ships `set_auto_renew`.

Note also the 6-day gap between `endDate` (2027-07-14) and `commitmentEndDate`
(2027-07-20), and that `membershipStartDate` is recorded as 2026-07-20 while the
subscription starts 2026-07-14. Worth settling in the same pass.

### 8.14.4 What shipped on 2026-08-16, ahead of the rest of the phase

Three fixes. **No member data was touched by any of them.**

| # | Fix | File |
|---|---|---|
| F1 | **Cancellation now writes the real end date back.** `PERIOD_END` already had Stripe's `current_period_end` in hand — it was used for the member's email and discarded. It is now written to `endDate`, and only when Stripe actually returned it. | `app/api/approvals/membership-cancel/route.ts` |
| F2 | **A recurring card membership can no longer be given an End date that Stripe never hears.** 400 with the two real alternatives (Auto Renew off, or assign as manual). Forward-only; `ONE_TIME` unaffected. | `app/api/members/subscribe/route.ts` |
| F3 | **Ending memberships are surfaced.** The `EXPIRING_MEMBERSHIP` probe went from a 14-day rollup naming at most three people to per-member cards over **120 days**, severity by proximity (≤14d high, ≤45d medium, else low), each independently snoozable, with an overflow card past 20 that states how many it stands for. A new `endingSoon` roster queue backs the drill-through. | `lib/reportsActionItems.ts`, `lib/membersQuery.ts` |
| F4 | **Six dead Action Item links fixed** — see §8.14.5. | `lib/reportsActionItems.ts` |

F3 is the one that answers *"nothing tells me to re-sign them"*: on the day it
was written, all eight of Frog Empire's memberships ending between 2026-08-27
and 2026-11-23 were outside the old window, so the Action Center showed none of
them.

### 8.14.5 Six dead Action Item links, not one

Writing the test for F3 turned the known `?filter=expiring` bug into a class.
Every one of these shipped in 2.5.1a and every one was silent — a dead query
parameter renders a perfectly good page, it just renders the wrong contents, so
nothing ever failed:

| Action Item | Linked to | Why it did nothing |
|---|---|---|
| `EXPIRING_MEMBERSHIP` | `/dashboard/members?filter=expiring` | `filter` is not a parameter the roster parses |
| `UPCOMING_RENEWAL_LARGE` | `/dashboard/members?filter=upcoming_renewals` | same |
| `UNRECONCILED_DEPOSIT` | `/dashboard/financials?tab=stripe` | Financials parses **no** query parameters — `tab` is `useState` |
| `OFFLINE_PAYMENT_PENDING` | `/dashboard/financials?tab=offline&filter=pending` | same |
| `UNCATEGORIZED_LARGE_BANK` | `/dashboard/financials?tab=bank&filter=needs_review` | same |

`EXPIRING_MEMBERSHIP` now points at the real `?queue=endingSoon`. The other four
were reduced to bare links: giving `UPCOMING_RENEWAL_LARGE` its own roster queue,
or teaching Financials to read its tab from the URL, are features, not bug fixes,
and inventing them inside a fix batch is how the original mistake got made.

**Two guards now pin this**, both in `scripts/renewal-surfacing-tests.ts`:

- `MEMBER_FILTER_PARAM_KEYS` + `MEMBER_NON_FILTER_PARAM_KEYS` are exported from
  `lib/membersQuery.ts`, and the suite sweeps **every** static
  `/dashboard/members?…` link in `lib/`, `app/` and `components/` — 648 files —
  failing on any parameter the roster does not read. A companion assertion
  proves each declared key genuinely changes the parsed filter, so a stale
  entry in the list fails too.
- Narrow assertions that no `href` in the probe file carries `filter=`, and that
  none deep-links Financials.

The guard also self-checks: it asserts it can still detect the exact string that
shipped broken (`?filter=expiring`), so it cannot rot into a test that passes
because it stopped looking.

### 8.14.6 The window is 120 days, not 90

90 was the first number, and the test caught it: Orson Chorba's membership ends
99 days out, so a 90-day window still missed the furthest of the eight on the
day it was written. `ENDING_SOON_WINDOW_DAYS = 120` lives in `lib/membersQuery.ts`
and the Action Item imports it, so the card and the queue cannot drift. Every one
of the eight real dates is pinned in the suite.

---

**F2 is a refusal, not a policy.** Whether an End date *should* become a Stripe
`cancel_at` is D12, and it is the same question as D11 — until renewal mode is
settled, refusing is the only answer that cannot make anything worse.


---

## 8.15 The six open decisions — recommendation and cost to reverse

Written 2026-08-17 so all six can be cleared in one pass. Each says what I would
do, why, and — the part that usually decides it — **what it costs to change your
mind later.** They are not equally reversible, and two of them are not really
reversible at all.

### 8.15.1 D2 — should class acceptance become option-level?

**Recommend: no.** Ship day entitlements (§8.3), keep acceptance plan-level,
reserve `optionIds?: string[]` in the `pricingOptions` entry shape and never
read it.

**Why.** The only thing option-level acceptance buys beyond day entitlements is
one configuration: exclude an option from a class on *every* day that class
runs, while a different option with the *same* days stays included. No such
case exists at Frog Empire and none is planned. The Tue/Thu problem — the one
that actually motivated this — is fully solved by the day rule.

**Cost to reverse (add it later): moderate, and entirely safe.** Additive
optional key on a JSON blob, absent meaning "all options", so every existing row
keeps working. The work is the nine coverage call-sites in §8.0.5 gaining one
predicate, the class editor's checkbox list becoming a two-level tree, and
`trialCoversClass` getting the same treatment. No migration, no data rewrite,
nothing to undo.

**Cost to reverse the other way (build it now, then decide against): high.** You
would be stripping a predicate out of nine hot paths and un-teaching coaches a
two-level UI they had learned. That asymmetry *is* the argument — not building
is cheap to undo, building is not.

### 8.15.2 D5 — `allowManualRenewal` has no reader

**Recommend: drop it from the option shape and hide it from the membership
editor. Keep the column.**

**Why.** It has had no reader since it shipped and nobody has reported missing
it. Carrying it onto six options multiplies a dead control sixfold and invites a
coach to toggle something that does nothing — which is worse than not having it,
because a switch that does nothing teaches people the settings are unreliable.
And with **D11 approved**, the question it was vaguely gesturing at now has a
precise home: "what happens when a term ends" is `TERM_THEN_ENDS` vs
`TERM_THEN_RENEWS`, which is a better answer than a boolean.

**Cost to reverse: trivial.** The column stays — nothing is dropped, nothing is
backfilled, and any value an owner has already set is preserved untouched.
Re-surfacing it is rendering a field and reading it.

**One caveat worth naming:** it is currently a *visible* toggle in the membership
editor. Removing a control an owner can see is a change they may notice even
though it changes no behaviour. If that matters, leave it visible and disabled
with a note; I would just remove it.

### 8.15.3 D6 — autopay OFF→ON: one row, or two chained rows?

**Recommend: one row — and complete the transition synchronously rather than
waiting for the deletion webhook.** This is the closest call on the list and the
recommendation changed while writing it.

**Why it changed.** The obvious one-row design was "set `cancel_at_period_end`,
then flip the row to MANUAL when `customer.subscription.deleted` arrives." That
does not work. That handler (`app/api/stripe/webhook/route.ts`) does an
unconditional `updateMany` setting `status: "canceled"` on **any** row matching
the subscription id. An autopay handoff would land as a cancellation, the member
would read as churned, and `recomputeMemberStatus` would flip them inactive.

Two ways out: teach the webhook to tell a handoff from a termination — which
needs a marker on the row, i.e. exactly the new column D6 was trying to avoid —
or don't wait for the webhook.

**Don't wait for it.** `cancel_at_period_end: true` means Stripe will not bill
again, and the current period is already paid. So at the moment of the
transition everything is already known: read back `current_period_end`, then in
one write set `billingType: "MANUAL"`, `paidThroughDate = current_period_end`,
`stripeSubscriptionId = null`, and leave `status: "active"`. The deletion
webhook later matches no row and is a harmless no-op. No new column, no webhook
change, one row, every existing reader untouched.

**Late-webhook safety, checked rather than assumed:** `invoice.paid` already has
a metadata fallback that resolves the member from subscription metadata when the
local row lookup misses, and `charge.refunded` / `charge.dispute.created` resolve
by charge rather than subscription. So nulling the id does not orphan money
events arriving afterwards.

**Cost to reverse: moderate-to-high — the one I would push back on.** If you
later want per-Stripe-subscription rows (say, a billing-history tab that lists
every subscription a member has ever had), the history exists only inside
`member_subscription_events.detail` as JSON. Reconstructing rows from it is a
migration plus a JSON-parsing backfill. Not lossy, but not cheap, and the
two-row shape is far easier to collapse into one than one is to expand into two.

**So: if you have any instinct that Stripe subscription history should be
first-class rows rather than audit entries, say so now and I will spec two rows
instead.** Everything else about the phase is unaffected by which you pick.

### 8.15.4 D7 — required document on `contractMonths` options?

**Recommend: yes, option-level, and build it with the term work rather than
ahead of it.**

**Why.** §8.8.1 concluded that nothing in code stops a month-2 cancellation and
the only instrument that survives a dispute is a signed agreement. The machinery
already exists — `Document.requiredAt: ["PURCHASE"]` plus the audited
`DocumentSignature` table. What does *not* work here is the existing club-wide
PURCHASE mechanism: the collapsed MS/HS card carries both a no-minimum option
and a 12-month option, and a club-wide purchase document would gate both
identically. It has to be per-option — `requiredDocumentIds?: string[]`, already
reserved in §8.9.3.

**Cost to reverse: low.** Additive optional JSON key, read at purchase. Removing
it means no longer reading it; signatures already collected stay valid and stay
in the audit trail. No migration either way.

**Caveat worth knowing before you turn it on:** it adds a step to the member
purchase flow for those options. That is the point, and it will still cost some
conversion on the 12-month option.

### 8.15.5 D8 — member-initiated autopay: queue, or immediate?

**Recommend: queue**, filing a `MEMBERSHIP_AUTOPAY_CHANGE` `PendingApproval`
exactly the way `request-cancel` files a cancellation.

**Why.** Both directions move money. OFF stops a card being charged and hands
collection to the front desk, which the club has to know about or the money
simply stops arriving. ON creates a Stripe subscription with a first-charge
date, and getting that date wrong is a surprise charge on a family's card.
Members have never been able to self-cancel for precisely this reason; an
immediate self-serve autopay switch would be the first place a member could
change their own billing without the club seeing it.

**Cost to reverse: trivial** — one branch. And there is an asymmetric middle
available at any time if the queue proves to be friction: make OFF immediate (it
never charges anybody) while keeping ON queued.

### 8.15.6 D12 — should a staff End date become a Stripe `cancel_at`?

**Recommend: yes — but only through D11's renewal-mode control, never as a bare
date field. Keep today's refusal (F2, §8.14.4) until those modes ship.**

**Why.** D11 gives "this membership ends on a date" a first-class name:
`TERM_THEN_ENDS`. Once the staff form asks the question outright — *renews* /
*ends on `<date>`* / *minimum term until `<date>`* — an End date stops being an
ambiguous input and becomes an instruction, which can be honoured by setting
`cancel_at_period_end` (or an absolute `cancel_at` when the date genuinely is
not a period boundary) and writing the resolved date back. The bare "End date"
input disappears in the same change. That input is what produced Titus Hall.

**Cost to reverse: this is the one-way door.** Once staff can set a membership to
end, memberships will end — on real families' accounts, with money stopping.
Reversing means those dates quietly stop being honoured, which recreates exactly
the divergence just fixed, except now with owners who have learned to trust the
field. So build it with the mode selector or do not build it. **Do not ship a
version where the date is honoured sometimes.**

### 8.15.7 Suggested order

D5 and D8 are free and can be answered in any order. D2 and D7 are additive and
low-risk. **D6 is the one to think about**, because it is the only one whose
reversal costs a migration. D12 should be answered last and built last, after
D11's modes exist — it is the only decision that changes what happens to money
on accounts that are working correctly today.


---

## 8. Final Deliverable

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
