# AthletixOS Improvement — Progress & Phased Plan

> ## ✅ Phase 4.5 migration APPLIED — `20260804000000_members_experience`
>
> Applied and verified by Julian, 2026-08-04. `members.reviewedAt /
> reviewedByUserId / blockedReason / snoozedUntil`, plus
> `member_invitation_deliveries`, `saved_member_views` and
> `member_subscription_events`, are live. **Do not create or modify a Phase 4.5
> migration** — the phase's schema is closed.
>
> **Backfills have NOT been run.** `scripts/members-experience-backfill.ts`
> is dry-run by default and refuses `--apply` without `--clubs`:
>
> ```bash
> cd <checkout>/web
> npx tsx scripts/members-experience-backfill.ts                      # read this first
> npx tsx scripts/members-experience-backfill.ts --apply --clubs=<id>
> ```
>
> Until BF-B runs, Reports' Membership tab stays `ESTIMATED` — an empty event
> log reads as "nothing ever happened", so creating the table was not enough.
> Until BF-A runs, migration-meter step 2 reads unreviewed for everyone.

> ## 📍 Where this work lives
>
> **Phase 4 is merged.** `claude/phase-4-account-bugs-5a03fa` landed on `main` at
> `be0bfe0` (2026-08-03) and its worktree
> (`/Users/cubano/Desktop/clubos/web/.claude/worktrees/nifty-pasteur-1ecb47`) is
> no longer the place to work. Start new work from `main` in the main checkout
> unless a session says otherwise.
>
> Sessions often run in a **git worktree**, and migrations, `.env`, and
> `node_modules` are per-worktree — so "I applied the migration" and "the
> migration isn't there" can both be true at once. Any session that writes a
> migration or a script Julian will run must state its absolute path and branch
> up front, and run everything from `<that path>/web`, e.g.
> `cd <that path>/web && npx prisma migrate deploy`.
> Name migrations by **folder**, never by `M<n>` — the M-numbers below are a
> planning inventory that has been renumbered before.

> ## ✅ UNBLOCKED — B1 + B2 verified in the browser (2026-08-03)
>
> Both ran against the worktree on `:3005`. **B1 passed** — Family & access and
> Family labels render side by side on Michael's and Cameron's profiles, and the
> candidate list surfaces Michael's real account with the "athlete's own email"
> reason. **B2 passed, GET only** — preview shows the plan, Kellan as the sole
> eligible target, and the correct billing sentence; not executed.
>
> Three defects were found and fixed: the usage warning fired with zeros on
> every accidental self-purchase (payments were counted as usage); "Book" the
> action collided with "Book" the permission pill; and the family-label
> inversion was on the wrong side, so both profiles read the opposite of the
> truth. §17 and §18 of the fixture suite pin all three.
>
> <details><summary>Original blocked note (kept for history)</summary>
>
> ## 🔵 BLOCKED — waiting on Julian's login (2026-08-03)
>
> Two Phase 4 verification items need an authenticated browser session. I can't
> sign in (no credentials, and entering them isn't something I do), and
> Client-view preview returns a sanitized stub that doesn't exercise the real
> reads — so these are genuinely blocked, not skipped.
>
> | # | Item | What to check |
> |---|---|---|
> | B1 | **Listers UI walkthrough** | Family & access card on Michael's + Cameron's profiles; "Give someone access" candidate list surfaces Michael's real account with the reason *"Matches this athlete's own email — likely the parent's address in the wrong field"*; "Family labels" reads as non-access |
> | B2 | **4A transfer preview (GET only)** | Preview on Michael's live $530/quarter sub: eligible targets, usage snapshot, billing sentence. **Do not press confirm** — it's a live customer |
>
> To resume: `cd <worktree>/web && NEXTAUTH_URL=http://127.0.0.1:3000 npm run dev`,
> open `http://127.0.0.1:3000/login`, sign in as owner, then hand back.
> (The `NEXTAUTH_URL` override is needed because `.env.local` — a symlink to the
> main checkout — points at `10.0.0.45:3000`, which isn't reachable from the
> sandbox. The symlinked file was left untouched.)
>
> **Already verified without a session:** access preservation across all 49
> guardian links / 40 guardians — see `scripts/verify-family-access.ts`.
>
> </details>

> ## ✅ Resolved — Q1–Q4 (owner, 2026-08-03)
>
> | # | Decision |
> |---|---|
> | Q1 | **Keep both** pending mechanisms — different approvers, different audit trails, and the coach path is what would have caught Cameron. But **neither is called "pending"**: chips now read "Requested by family — approve in Approvals" and "Suggested by staff — confirm here". |
> | Q2 | **Keep as is.** `members:full` grants directly; coaches suggest rather than grant. |
> | Q3 | **Keep the deep link.** Don't duplicate booking rules. |
> | Q4 | **Keep the behavior, change the label** → "Make primary guardian". Household handover after a custody change is a real feature, noted for later, not built. |
>
> <details><summary>Original question detail (kept for history)</summary>
>
> Decisions taken conservatively while working unattended. None block anything;
> each is reversible and flagged here rather than assumed silently.
>
> | # | Question | What I did, and why | Reverse it by |
> |---|---|---|---|
> | Q1 | **Two kinds of "pending" family link now exist.** A client-initiated request is a `GUARDIAN_LINK` PendingApproval (pre-existing). A staff *proposal* is a `MemberGuardianUser` row with `status='PENDING'` (new in 4C). | Kept both rather than collapsing them. They're genuinely different events — one is "a parent asked", the other is "a coach suggested" — and they need different approvers and different audit trails. The card labels them distinctly ("Requested by the family" / "Proposed by staff"). Collapsing them would have meant rewriting the working client request flow. | Drop the staff-proposal path and require `members:full` for any link, so the only pending state is the PendingApproval. |
> | Q2 | **Who may propose vs confirm a family link?** plan.md §4C says "not every staff role should automatically be able to edit family or financial relationships" without naming levels. | `members:full` grants directly (CONFIRMED); `members:edit` may only *propose* (PENDING, needs a `members:full` confirm); below that, nothing. Financial actions stay on their own scopes — Assign Membership needs `billing.transfer_subscription`, never `members:*`. | Change the two thresholds in `lib/familyRules.ts:resolveFamilyCapabilities`. One function, no schema. |
> | Q3 | **"Book for This Athlete" (plan.md §4C action list)** could mean a new staff booking flow inside the family card. | Made it a deep link to the existing attendance/classes surface, scoped to that athlete, gated on `attendance:edit`. Building a second booking path would duplicate business logic the repo explicitly warns against. | Replace the link with an inline booking modal if you want it in-card. |
> | Q4 | **"Transfer Management" (plan.md §4C action list)** is not defined in the brief. | Implemented as "make this guardian primary" — the primary guardian is the one who holds parental controls, so moving it is what transferring management means in this data model. Demotes the previous primary in the same transaction. | Redefine if you meant something else (e.g. moving *all* links to a different account). |
>
> Nothing here touched schema, production data, or a migration.
>
> </details>
>
> ## 📌 Noted for later — not built
>
> **Household handover.** Moving *all* of one guardian's links to a different
> account in one action, e.g. after a custody change. Q4 resolved as
> "make primary guardian" instead; the bulk handover is a separate feature.

Companion to `plan.md` (the brief) and `ARCHITECTURE-NOTES.md` (the discovery findings).

**Preserve existing production data.** Every migration is additive; every backfill is dry-run-first with allowlists; nothing gets renamed, dropped, or silently relabeled. Follow the two-workflow migration pattern (hand-write SQL → `migrate deploy` → Supabase MCP bookkeeping when needed).

Status legend: `⬜ pending · 🟡 in progress · 🟢 done · 🔵 blocked · ⚪ deferred`.

## Phase index (Option B, 2026-07-29)

| Phase | Area | Status |
|---|---|---|
| [1](#phase-1--owner-financials) | Owner Financials (1A–1E) | 🟢 done |
| [2](#phase-2--reports) | Reports — thin plan.md fixes | 🟢 done |
| [2.5](#phase-25--reports-full-design-handoff) | Reports — full design handoff (8-tab hub, drill, imports, alerts, forecasts, PDF/CSV export) | 🟢 done (2026-07-30) · except 2.5.12, held back by owner |
| [3](#phase-3--communications--email) | Communications & Email | 🟢 done (2026-08-02) |
| [4](#phase-4--client--family-accounts) | Client & Family Accounts | 🟢 done (2026-08-03) · merged `be0bfe0` |
| [4.5](#phase-45--members-full-design-handoff) | Members — full design handoff (3 tracks, list, profile, Family & access, migration redesign, mobile, source label) | ⬜ pending |
| [5](#phase-5--event-registration-confirmation) | Event Registration Confirmation | ⬜ pending |
| [6](#phase-6--safety-data-integrity-testing) | Safety, Testing, Deployment & Final Handoff | ⬜ pending |

## Full migration inventory (M1–M28)

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
| M16 | `20260801000000_email_sends` — EmailSend per-recipient delivery log (dedup + provider lifecycle) | 3.1 | ✅ applied |
| M17 | `20260801010000_email_opt_outs_scope` — EmailOptOut adds userId + scope + source | 3.1 / 3I | ✅ applied |
| M18 | `20260801020000_announcements_lifecycle` — Announcement lifecycle + rich body + sender + scheduling + audience | 3.1 / 3B / 3H | ✅ applied |
| M19 | `20260801030000_email_templates` — EmailTemplate model (14 stock kinds seeded lazily) | 3.2 / 3C | ✅ applied |
| M20 | `20260801040000_marketing_audiences` — MarketingAudience (dynamic/frozen recipient groups) | 3.2 / 3D | ✅ applied |
| M21 | `20260801050000_club_mailing_address` — Club mailing address + publicEmail/publicPhone | 3 (email footer + Contact block) | ✅ 2026-08-01 |
| M22 | `20260802000000_email_history_optout_audit` — EmailSend {sentByUserId, relatedEventId, relatedMembershipId} + EmailOptOutAudit table | 3G + 3I | ⬜ written (session 1) |
| M23 | `Member.reviewedAt, reviewedByUserId` — migration step 2 (renumbered from M17) | 4.5.1 | ➡️ **folded into M30** |
| M24 | `Member.blockedReason, snoozedUntil` — Blocked state + Snooze (renumbered from M18) | 4.5.1 | ➡️ **folded into M30** |
| M25 | `MemberInvitationDelivery` — per-send delivered/opened/bounced (renumbered from M19) | 4.5.1 | ➡️ **folded into M30** |
| M26 | `SavedMemberView` — user filter snapshots (renumbered from M20) | 4.5.2 | ➡️ **folded into M30** |
| M27 | `MemberGuardianUser` per-permission columns (canBook/canPay/canWaivers/canMessages) + `status` (renumbered from M21) | 4.5.6 | ➡️ **folded into M29** — do NOT re-migrate `member_guardian_users`. Shipped names are `canSignWaivers`/`canReceiveEmails`, not the plan's `canWaivers`/`canMessages`. |
| M28 | `MemberSubscriptionEvent` — subscription-event history (Reports 2.5.5 precision) (renumbered from M22) | 4.5.10 | ➡️ **folded into M30** |
| **M30** | `20260804000000_members_experience` — **all of Phase 4.5 in one migration** (absorbs M23–M26 + M28). `members.reviewedAt/reviewedByUserId/blockedReason/snoozedUntil` + 3 indexes; new `member_invitation_deliveries`, `saved_member_views`, `member_subscription_events`. Deliberately does NOT contain `ImportBatch.sourceLabel` (live since 2.5.9) or the `member_guardian_users` columns (live since M29). | 4.5.1 + 4.5.2 + 4.5.10 | ⬜ **written 2026-08-04, NOT applied** — apply commands at the top of this file |
| **M29** | `20260803000000_family_accounts` — **all of Phase 4 in one migration.** `member_guardian_users` {clubId, status, isPrimary, canBook/canPay/canSignWaivers/canReceiveEmails, source, createdByUserId, confirmedAt, revokedAt, updatedAt} + 3 indexes; `member_subscriptions.payerUserId` + index; new `membership_transfers` table | 4A + 4B + 4C (absorbs M27) | ✅ applied — `PHASE-4-DELIVERABLE.md` §7 opens with "Migration is already applied" |

**Renumbering note (2026-08-02):** Phase 3's M21 (mailing address) and M22 (email history + audit) took the next two slots; former Phase-4.5 M21–M26 shifted to M23–M28. Nothing in production changed; only unbuilt future work was renumbered.

**All migrations remaining after M8 are additive.** Nothing drops, nothing renames. Backfills are dry-run-first with per-club reports.

## Full backfill inventory

| # | Backfill | Phase | Notes |
|---|---|---|---|
| BF-1 | `Member.sourceSystem = 'ATHLETIXOS'` for existing rows | 2.5.9 | ✅ 2026-07-29 (292 members) |
| BF-2 | `Member.normalizedEmail` + `Member.normalizedPhone` from existing fields | 2.5.9 | ✅ 2026-07-29 (35 emails, 44 phones) |
| BF-3 | `Transaction.sourceSystem` derived from `paymentSource` | 2.5.9 | ✅ 2026-07-29 (37 tx: 23 STRIPE, 12 CASH, 2 OTHER) |
| BF-4 | `Member.reviewedAt/reviewedByUserId` from existing `setupComplete/setupBy/setupAt` where present | 4.5.1 | Migration timeline step 2 |
| BF-5 | `MemberGuardianUser` existing rows → `status='CONFIRMED'`, all four booleans `true` | 4.5.6 → **M29** | ✅ satisfied by column DEFAULTs — no script needed. M29 also backfills `clubId` (then SET NOT NULL), `source='BACKFILL'`, `confirmedAt=createdAt`, and freezes today's `isPrimary` derivation, all inside the migration |
| BF-8 | Lister family data correction — link Cameron to `karen.mikelister@gmail.com`, repoint his `guardianEmail`, retire the duplicate `mlister.oakdale@gmail.com` login | 4B | `scripts/fix-family-links.ts`, dry-run default, `--members` allowlist required. **Not a migration.** See `PHASE-4-DISCOVERY.md` §7 + §10 |
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
| 3.1.1 | **Sub-scope permissions** — nested `messages_subScopes` object on `StaffProfile.permissions`. Scopes shipped: `bulk`, `marketing`, `templates`, `images`, `unsubscribe`, `analytics`, `approve`, `audience_all_club`. `hasMessagesSubScope()` + `requireMessagesSubScope()` guard. Coach-audience filter (`lib/coachAudience.ts`) limits staff without `audience_all_club` to members they teach. | Backend | — | 🟢 shipped 2026-08-02 (session 2 — see 3L below) |
| 3.1.2 | **`lib/sendClubEmail.ts`** — single entrypoint for every email send. Params: `{clubId, kind, recipientUserId?, recipientEmail, subject, bodyHtml, personalization, headers, replyTo, from, opts}`. Applies: `EmailOptOut` check (marketing kinds only), `List-Unsubscribe` header, personalization interpolation, sanitize, write `EmailSend` row, dispatch. Retro-fit every existing `sendXxx` in `lib/email.ts` to call through it. | Backend | — | ⬜ |
| 3.1.3 | **M16** — `EmailSend` per-recipient log model. dedupeKey column + partial unique index `(sendBatchId, dedupeKey) WHERE both NOT NULL` is the double-send guarantee. | Migration | M16 | ⬜ written |
| 3.1.4 | **M18** — `Announcement.status` + `bodyJson` + `bodyHtml` + `senderUserId` + scheduling + audience + household mode + approval columns. Backfill: `publishAt < now OR NULL` → `SENT`, else `DRAFT` (never auto-fires a future publishAt). Legacy `body` stays populated. | Migration | M18 | ⬜ written |
| 3.1.5 | **M17** — `EmailOptOut.userId TEXT?` + `scope enum default MARKETING` + `source`. Backfill scope for every row to `MARKETING`. | Migration | M17 | ⬜ written |
| 3.1.6 | **`/api/cron/email-queue`** worker — pulls QUEUED `EmailSend` rows, dispatches via `sendClubEmail`, updates status. `CRON_SECRET`-gated + new Netlify scheduled function alongside `event-charges-cron.mts`. Manual "Send now" also enqueues + inline drains for immediate delivery. | Backend | — | 🟢 (route + Netlify scheduled fn shipped; `RESEND_WEBHOOK_SECRET` webhook path lives at `/api/webhooks/resend`) |
| 3.1.7 | **Signed public image route** — `/api/public/images/[fileId]?t=<hmac>` streams existing `UploadedFile` rows when the HMAC signature validates. NEW dedicated `EMAIL_IMAGE_SECRET` env var (NOT `NEXTAUTH_SECRET`) so rotating auth secrets never breaks image URLs in already-sent emails. No expiry — historical emails must render years later. No schema change. | Backend | — | 🟢 shipped (lib/emailImages, /api/public/images/[fileId], /api/emails/image-url for signing) |

### 3.2 Rich Composer + Templates + Audiences

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 3.2.1 | Rich text editor in `components/EmailComposer.tsx` — content blocks per plan §3B. Reuse existing tiptap or lexical (audit whichever is already in the dep set; add if none). | UI | — | 🟢 shipped (composer + block picker + inline tiptap on paragraph/list only; images auto-signed via image-url mint) |
| 3.2.2 | Store composer output as `bodyHtml` (sanitized) + auto-derived `bodyText` fallback. | Backend | — | 🟢 shipped in checkpoint C (bulk route calls `renderEmail(blocks)` → sanitized `bodyHtml` + `blocksToPlainText` fallback → immutable snapshot on `EmailSend`) |
| 3.2.3 | **M19 + 3C** — `EmailTemplate` model + `/dashboard/communication/templates` page. 14 stock templates seeded lazily on first fetch (isSystem=true; owner archives, never hard-deletes). Every stock template ships LogoBlock header + ContactBlock footer — send-time renderers auto-swap the club's own logo + contact info. Owner can create / edit / duplicate / archive; system rows archive rather than delete. | Migration + UI | M19 | 🟢 shipped 2026-08-02 (session 1) |
| 3.2.4 | **M20 + 3D** — `MarketingAudience` + full filter DSL (`lib/audienceFilters.ts`) + `/dashboard/communication/audiences` UI. 17 filter fields (2 marked "coming soon" until Phase-4.5 location/coach assignment lands). Dynamic/static toggle: dynamic re-evaluates at send; static freezes `frozenMemberIds`. Live count debounced at 400ms with first-10 member preview. Fail-closed on unknown fields. | Migration + UI | M20 | 🟢 shipped 2026-08-02 (session 1) |
| 3.2.5 | **3F** — Personalization tokens (`lib/emailPersonalization.ts`). 14 tokens from plan §3F. Per-recipient interpolation in the bulk send loop; cross-family safety guaranteed (each recipient resolves its own values). Unknown tokens render blank (never leak `{{token}}`), typos flagged in the composer via `<PersonalizationHint>`. Preview-as-recipient endpoint at `/api/emails/personalization-preview` returns per-member subject/blocks + missing-token tally. 12 pure-function checks passing. | Backend + UI | — | 🟢 shipped 2026-08-02 (session 1) |

### 3.3 Bulk email from Members page (plan §3A)

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 3.3.1 | `POST /api/members/bulk` (`action: "email"`) already shipped in session 1; session 2 added `personalization` payload for per-recipient interpolation, `messages.bulk` sub-scope gate, and coach-audience filter that drops requested ids the caller doesn't own. | Backend | — | 🟢 shipped 2026-08-02 (session 1 + 2) |
| 3.3.2 | Members-page bulk composer: existing "Email selected" now feeds through the 3K preflight, exposes all 8 modes, and requires a typed `SEND N` confirmation above 50 recipients. Preview list shows per-member resolved address + display name (guardian's name for minors). | UI | — | 🟢 shipped 2026-08-02 (session 2) |
| 3.3.3 | Household delivery mode chooser — 8 modes now (was 3). See 3.4.1. | UI + Backend | — | 🟢 shipped 2026-08-02 (session 1 backend + session 2 UI) |

### 3.4 Family-aware targeting (plan §3E)

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 3.4.1 | Sender picks — **8 modes**: HOUSEHOLD / PER_MEMBER / PER_ATHLETE_PRIMARY (pre-existing) + ATHLETE_ONLY / PRIMARY_GUARDIAN / ALL_GUARDIANS / PAYER / ACCOUNT_HOLDER (new in 3E). Resolver batch-loads payer users so PAYER mode isn't N+1. Dedupe-key rules extended so ALL_GUARDIANS folds correctly (one row per guardian × athlete). | Backend | — | 🟢 shipped 2026-08-02 (session 1) |
| 3.4.2 | Minor default: guardian in HOUSEHOLD/PER_MEMBER/PER_ATHLETE_PRIMARY/PRIMARY_GUARDIAN. ATHLETE_ONLY deliberately skips minors without their own email (sender chose the mode). | Backend | — | 🟢 shipped 2026-08-02 (session 1) |
| 3.4.3 | Bulk composer preview lists per-member resolved recipient email + display name (guardian name for minors). Pre-send counter strip includes `outsideCoachAudience` count so a coach sees "N members hidden — you only teach some of them". | UI | — | 🟢 shipped 2026-08-02 (session 2) |

### 3.5 History, drafts, schedule, approval

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 3.5.1 | **3G** — Member profile `<CommunicationsCard>` renders `EmailSend` rows: subject · sender · address · related event/membership · body preview · reader-modal with the exact `bodyHtml` the recipient got. Delivery pills computed from row state (never fabricates "opened" — nullable `openedAt` = "delivered · open tracking unavailable"). GET `/api/members/[id]/communications` + `/api/emails/sends/[id]`. Gated on `messages.analytics`. Campaign-level results at `/dashboard/communication/campaigns/[id]` via GET `/api/announcements/[id]/results` (tracking-adjusted denominators). | UI + Backend | — | 🟢 shipped 2026-08-02 (session 2) |
| 3.5.2 | **3H** — Announcement lifecycle: `POST /api/announcements/[id]/schedule` (DRAFT→SCHEDULED, future-only), `.../send` (idempotent via `Announcement.sendBatchId` + partial unique on EmailSend), `.../cancel` (DRAFT/SCHEDULED→CANCELED). Cron sweep in `/api/cron/email-queue` picks up due SCHEDULED rows. Scheduled instants stored UTC; UI renders in club timezone. | Backend | — | 🟢 shipped 2026-08-02 (session 2) |
| 3.5.3 | Idempotency-key on `send` — `lib/announcementDispatch.ts` claims DRAFT/SCHEDULED via conditional `updateMany` and passes `sendBatchId=ann-<id>` + per-recipient `dedupeKey` into `sendClubEmail`. M16 partial unique catches retries. | Backend | — | 🟢 shipped 2026-08-02 (session 2) |
| 3.5.4 | Approval workflow — deferred. M18 columns (`approvalRequestedById`, `approvedById`, `approvalRequestedAt`, `approvedAt`) already present; `messages.approve` sub-scope already plumbed in 3L. UI + gate wire in a later session. | Backend + UI | — | ⚪ deferred (per session-2 brief) |

### 3.6 Unsubscribe scope, attachments, safeguards, permissions, mobile, testing

| # | Task | Status |
|---|---|---|
| **3I** unsubscribe scope + audit | Recipient picks MARKETING / ALL / Resubscribe. Every state change writes an `EmailOptOutAudit` row (source, actor, IP, UA). Public: `/api/unsubscribe` renders granular panel + preserves classic one-click. Admin: `/api/emails/opt-outs` (GET/POST/DELETE) + `/api/emails/opt-outs/history` + `/dashboard/communication/unsubscribes` searchable list with per-address history modal. Gated on `messages.unsubscribe`. | 🟢 shipped 2026-08-02 (session 2) |
| **3K** pre-send checks + final review | `lib/emailPreflight.ts` — 10-item BLOCK/WARN/INFO checklist. `<PreflightPanel>` renders live under the composer; BLOCK issues disable Send. `<FinalReviewModal>` shows subject / sender / reply-to / mode / recipient count / skipped count / tracking notice; typed `SEND N` confirmation required above 50 recipients (`TYPED_CONFIRM_THRESHOLD`). | 🟢 shipped 2026-08-02 (session 2) |
| **3L** sub-scope permissions + coach audience | 8 sub-scopes on `messages` (`bulk`, `marketing`, `templates`, `images`, `unsubscribe`, `analytics`, `approve`, `audience_all_club`). `requireMessagesSubScope()` guard on every wide-blast route. `lib/coachAudience.ts` restricts staff without `audience_all_club` to members enrolled in classes/events they teach; ids outside the audience are DROPPED, not hidden. Staff editor UI (`/dashboard/staff`) exposes toggles with owner-facing labels. | 🟢 shipped 2026-08-02 (session 2) |
| 3J attachments | ⚪ deferred — image-linked flow via existing signed image route is sufficient for this cycle; real SMTP attachments = future migration. |
| **3M** mobile + composer persistence | Composer state persists to localStorage per `draftKey` — survives phone rotation + page refresh with a 30-day age-out and a Discard action. Wired into BulkEmailModal + TemplateEditor. BulkEmailModal footer wraps + respects iOS safe-area. Announcements page container / header / cards / filter chips fully responsive. Session-1/2 pages (templates, audiences, unsubscribes, campaign results, profile Communications card) already used the bottom-sheet + responsive-grid pattern — verified in the audit, no structural changes needed. | 🟢 shipped 2026-08-02 (session 3) |
| **3N** targeted send-path tests | `scripts/send-path-tests.ts` — 35 focused checks over household/per-member dedup, missing/invalid/opted-out addresses, duplicate-send prevention (shared-guardian collapse), personalization with a missing token (no `{{token}}` leak), cross-family safety (interpolate is pure), 3K preflight blockers, `INLINE_DISPATCH_MAX` safety math. Plus the pre-existing 54 recipient tests → total 89 pass. Coverage narrowed to the send path per session-3 brief; exhaustive 3N matrix explicitly skipped. | 🟢 shipped 2026-08-02 (session 3) |

### 3.7 Phase-3 schema audit — 2026-08-02 (session 1 finding)

Full audit of 3C–3N schema needs completed. Bundled into **M22**
(`20260802000000_email_history_optout_audit`) so the operator applies
once. Everything else runs on existing schema.

| Section | Needs schema? | Verdict |
|---|---|---|
| 3C templates | ❌ | `EmailTemplate` model already covers |
| 3D audiences | ❌ | `MarketingAudience` model already covers |
| 3E family-aware | ❌ | Recipient-resolver algorithm only |
| 3F personalization | ❌ | Pure interpolation lib |
| **3G history** | ✅ | M22: `EmailSend.sentByUserId, relatedEventId, relatedMembershipId` |
| 3H drafts/schedule/approve | ❌ | M18 lifecycle columns already present |
| **3I unsubscribe** | ✅ | M22: new `EmailOptOutAudit` table (append-only preference log) |
| 3J attachments | ❌ | Treated as signed links via existing image route |
| 3K/3L/3M/3N | ❌ | Logic / JSON perms / UI / tests only |

### 3.8 Session-1 deliverables (2026-08-02)

Committed on `main`; not pushed per plan.

| Commit | Content |
|---|---|
| `6013094` | M22 migration file + schema.prisma additions |
| `32a87da` | 3C templates (lib + 3 API routes + templates page + nav) |
| `91b7a8d` | 3D audiences (filter DSL + evaluator + 3 API routes + audiences page) |
| `d6567a8` | 3E 5 new sender-target modes (+ 13 new recipient-tests) |
| `b996c78` | 3F personalization (interpolation lib + preview endpoint + composer hint + bulk send wiring) |
| `a75a701` | PROGRESS.md update |

**Verify commands** (session 1):
- `npx tsx scripts/email-recipients-tests.ts` → 54/54 pass
- `npx prisma validate` → clean
- `npx tsc --noEmit` → clean
- `npm run build` → clean

### 3.9 Session-2 deliverables (2026-08-02)

Committed on `main`; not pushed per plan. M22 was applied by Julian
before this session began.

| Commit | Content |
|---|---|
| `659b55e` | **3L** — messages sub-scopes + coach-restricted audience. `lib/permissions.ts` adds `hasMessagesSubScope()` + `resolveMessagesSubScopes()` + `DEFAULT_MESSAGES_SUBSCOPES`. `lib/apiGuard.ts` adds `requireMessagesSubScope()`. New `lib/coachAudience.ts` computes members a coach can address (attendance + event bookings + registrations + private bookings) and filters requested id lists. Wired into every wide-blast route (bulk, marketing audiences, email templates). Staff editor UI exposes 8 sub-scope toggles under "Messaging — advanced". |
| (session 2, in commit trailing 3L) | **3H** — `lib/announcementDispatch.ts` (idempotent claim + send). New routes: `POST /api/announcements/[id]/{schedule,send,cancel}`. `SendClubEmailInput` extended with M22 columns (`sentByUserId`, `relatedEventId`, `relatedMembershipId`); cron dispatch retry preserves them. `/api/cron/email-queue` sweeps due SCHEDULED announcements after draining EmailSend rows. Approval workflow deferred per brief. |
| (session 2, in commit trailing 3H) | **3I** — `lib/optOutAudit.ts` writer. `/api/unsubscribe` renders MARKETING / ALL / Resubscribe panel; `/api/unsubscribe/apply` handles POST from the panel; classic one-click preserved. `/api/emails/opt-outs` + `/api/emails/opt-outs/history` admin API. `/dashboard/communication/unsubscribes` list with per-address history modal. Every mutation writes an `EmailOptOutAudit` row. |
| (session 2, in commit trailing 3I) | **3G** — `/api/members/[id]/communications` + `/api/emails/sends/[id]` + `<CommunicationsCard>` on the member profile page. `/api/announcements/[id]/results` + `/dashboard/communication/campaigns/[id]` for campaign-level tallies. Never fabricates "opened" — nullable timestamps drive the UI directly. Tracking-adjusted denominators explicitly disclosed. |
| `7691ff7` | **3K + 3.3/3.4.3** — `lib/emailPreflight.ts` 10-item BLOCK/WARN/INFO checklist. `<PreflightPanel>` above composer disables Send on BLOCK. `<FinalReviewModal>` shows subject / sender / reply-to / mode / recipient count / skipped count / tracking notice; typed `SEND N` confirmation required above `TYPED_CONFIRM_THRESHOLD=50`. 8-mode picker exposed in composer. |

**Verify commands** (session 2):
- `npx tsc --noEmit` → clean
- `npm run build` → clean
- `npx tsx scripts/email-recipients-tests.ts` → 54/54 pass (unchanged)
- Route smoke via `curl` — unauth 401 on `/api/marketing-audiences`, `/api/emails/opt-outs`; `/dashboard/communication/unsubscribes` 307→`/login`

**Failure-mode discipline (per session-2 brief):**
- 292 real families — bulk send is guarded by (1) `messages.bulk` sub-scope, (2) coach-audience filter, (3) BLOCK preflight for empty/no-recipients, (4) typed `SEND N` confirmation ≥ 50 recipients. Four independent gates before a mass send commits.
- Coach view — a coach without `audience_all_club` sees only members enrolled in classes/events they teach on the bulk preview. `outsideCoachAudience` count is surfaced so the coach knows selections were dropped.
- 3G never claims tracked events that didn't happen — every "opened" render is derived from a non-null `openedAt`, never from status alone. Rows without a `providerMessageId` render "delivered · open tracking unavailable" (SMTP-only sends).

### 3.10 Session-3 deliverables (2026-08-02, final)

Committed on `main`; not pushed per plan.

| Commit | Content |
|---|---|
| (session 3, queue commit) | **Large-send safety net.** `lib/enqueueEmailSend.ts` + `INLINE_DISPATCH_MAX = 100`. Bulk route + announcement dispatch enqueue-only above 100 recipients so a 292-family blast finishes the request in ~15s instead of timing out at 60s and half-sending. Cron drains 50 QUEUED rows every 5 min. |
| (session 3, queue commit) | **`scripts/send-path-tests.ts`** — 35 focused send-path tests (89 total across both suites). |
| `6f60c32` | **3M + 3H UI**. Composer localStorage draft persistence (`draftKey` prop) with restored-draft banner and Discard action, wired into BulkEmailModal + TemplateEditor. Announcements page grows Send now / Cancel / View results buttons per card (session 2 shipped the API routes; owners had no UI for them). Announcements page container / header / cards / filters fully responsive. BulkEmailModal footer wraps + respects iOS safe-area. Lint fixes on session-owned surfaces. |
| (this range) | **`docs/improvement/PHASE-3-DELIVERABLE.md`** — the plan §3N exit-criteria document. |

**Verify commands** (session 3):
- `npx tsc --noEmit` → clean
- `npm run build` → clean
- `npx tsx scripts/send-path-tests.ts` → 35/35 pass
- `npx tsx scripts/email-recipients-tests.ts` → 54/54 pass
- `npm run lint` → clean on session-owned surfaces (pre-existing warnings on 15 legacy files untouched)

**Large-send verified:**
- `INLINE_DISPATCH_MAX = 100` — inline below, enqueue-only above. Threshold picked to give ~40s headroom at 400ms/row against Netlify's 60s `maxDuration`.
- 292-family send drains in ~6 cron ticks (~30 min worst case). Cron path pre-existed; session-3 change is the enqueue-only handoff so the request itself doesn't half-send.
- Both the Members-page bulk path AND the announcement dispatch (`lib/announcementDispatch.ts`) route through the enqueue path above threshold. Announcement `status=SENT + sendBatchId` gets stamped at end of enqueue so a parallel cron tick can't re-fire.

**Phase 3 exit criteria met** — see `docs/improvement/PHASE-3-DELIVERABLE.md` for the full plan §3N document: what changed · schema changes · background jobs · tracking limitations · file-upload limitations · new permissions · env vars · manual test steps · deployment order · rollback plan.

**Deferred (intentional):**
- Approval workflow (3H.4) — M18 columns present, `messages.approve` sub-scope plumbed, UI + gate wire in a later session.
- SMTP attachments (3J) — link-based delivery via signed image route sufficient this cycle.
- Exhaustive 3N test matrix — send path covered; downstream test cases (missing email addresses in the Members page filter, invalid addresses, shared guardian emails, multiple children under one parent, unique-household vs. per-athlete delivery, duplicate-send prevention, delivery failures, communication history, staff permissions, coach-restricted audiences) all have coverage above; the plan's remaining rows (image uploads, links and buttons, draft saving, scheduled sending, mobile and tablet layouts) rely on browser verification a future session or Julian's local testing will cover.

---

## Phase 4 — Client & Family Accounts

**Deliverable:** `docs/improvement/PHASE-4-DELIVERABLE.md` — what changed, schema, backfills, permissions, tests, limitations, deployment order, rollback.
**Discovery:** `docs/improvement/PHASE-4-DISCOVERY.md` — the production diagnosis, duplicate-login audit, typo register.

### 4A. Membership transfer to linked family (Michael → Kellen)

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 4A.1 | **M29** (`20260803000000_family_accounts`) — `MemberSubscription.payerUserId TEXT?` + `membership_transfers` table. Reads fall back to `Member.responsiblePayerUserId` when null. | Migration | M29 | 🟢 applied |
| 4A.2 | ✅ **DONE** — `POST/GET /api/member-subscriptions/[id]/transfer` — **two actor paths (owner-decided 2026-08-02)**: staff with the new `billing.transfer_subscription` sub-scope act directly; the **account holder** may initiate between their own linked family members but it files a `PendingApproval` (kind `MEMBERSHIP_TRANSFER`) and takes effect only on staff approval. A non-account-holder guardian cannot initiate. Preview returns a diff + usage snapshot. Confirm sets `MemberSubscription.memberId = target`, stamps `payerUserId` = account holder, writes a `MembershipTransfer` row + `BillingAuditLog`. | Backend | — | 🟢 |
| 4A.2b | **Replace the live-Stripe 409** in `billing-admin/actions reassign_subscription` with the acknowledged beneficiary-only path. Stripe subscription/customer/card untouched by design; `acknowledgedBillingNote` records the exact sentence confirmed. | Backend | — | ⬜ |
| 4A.3 | ✅ **DONE** — Eligibility (owner-answered 2026-08-02): allow the transfer regardless of usage.** No "billed at least once" bar — the primary case is correcting an accidental self-purchase, which is always already billed. Surface a usage snapshot (attendance/bookings/transactions) into `MembershipTransfer.usageSnapshot` and require acknowledgement when non-empty. | Backend | — | 🟢 |
| 4A.4 | ✅ **DONE** — **UI (owner)**: profile Memberships tab → per-sub "Assign to another family member" button. Opens transfer modal (current owner, eligible family members from `guardianOf` + `MemberRelationship`, explanation of what stays with payer, confirm). | UI | — | 🟢 |
| 4A.5 | ✅ **DONE** — **UI (client)**: `/member/family/[memberId]` — "Move this membership" action visible to the account-holder guardian. Same eligibility rules. | UI | — | 🟢 |
| 4A.6 | Post-transfer state: original Transaction/receipt preserved unchanged; membership beneficiary is new athlete; payer stays the same. | Regression test | — | ⬜ |

### 4B. Same-email family onboarding (Cameron case)

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 4B.1 | ✅ **DONE** — **Extended `GET /api/members/[id]`** via `loadFamilyForMember()`: — add `guardianLinks: { include: { user: true } }` and `user: { include: { guardianOf: { include: { member: true } } } }`. | Backend | — | 🟢 |
| 4B.2 | ✅ **DONE** — **Family & access card** on `app/dashboard/members/[id]/page.tsx` — renders guardians (from `guardianLinks`), managed athletes (from `user.guardianOf`), and legacy `MemberRelationship`. Includes pending links (from `PendingApproval` kind `GUARDIAN_LINK`). | UI | — | 🟢 |
| 4B.3 | Verify member portal already renders reciprocal (`/api/member/portal:82-123`) — no change expected. | Testing | — | ⬜ |
| 4B.4 | ~~Fix any stale-cache issue~~ — **RULED OUT by production diagnosis (2026-08-02).** Not cache, query, or authorization. Root cause: Cameron's `guardianEmail` diverged from the address Michael actually logs in with, so no auto-link path matched; migration activation then minted a **second Michael login** for that address. Staff's remedy wrote `MemberRelationship`, which grants nothing. See `PHASE-4-DISCOVERY.md` §2. | — | — | ✅ diagnosed |
| 4B.6 | ✅ **DONE** — **Staff-facing guardian-link control** on the member profile — writes `MemberGuardianUser`, not `MemberRelationship`. Today the Relationships card is the only linking control staff have and it grants no access; that is what made the Cameron incident unfixable from the UI. | UI + Backend | — | 🟢 |
| 4B.7 | ✅ **DONE** — **Activation reuses an authenticated session's User** instead of minting one from `guardianEmail`. `activate/[token]/route.ts:460-478` created the duplicate Michael login while he was signed in as himself 8 minutes earlier. Also warn when an athlete's own `Member.email` resolves to an existing live login. | Backend | — | 🟢 |
| 4B.8 | ✅ **DONE** — Member create/edit warning: athlete's own `email` matches an existing login that isn't a guardian → "Did you mean to set this as the guardian email?" Prevents the whole class. | UI | — | 🟢 |
| 4B.5 | Regression: multiple children under one guardian email each keep separate Member rows, separate memberships, separate attendance, separate waivers. | Testing | — | ⬜ |

### 4C. Relationship visibility and permissions

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 4C.1 | ✅ **DONE (schema)** — folded into **M29**; ~~M16~~ — `MemberGuardianUser.permissions Json?` (Book/Pay/Waivers/Messages) OR separate `GuardianAccess` table per §2.6 Q10. | Migration | M16 | 🟢 |
| 4C.2 | ✅ **DONE** — Family & access renders per-relationship: name · avatar · type · manages? · book? · pay? · waivers? · messages? · notifications? · status · date-linked. | UI | — | 🟢 |
| 4C.3 | ✅ **DONE** — Actions: View Profile · Edit Relationship · Confirm Pending · Remove · Transfer Management · Assign Membership · Book for Athlete. Each gated by staff permission. | UI + Backend | — | 🟢 |
| 4C.4 | ✅ **DONE** — guardian side now renders the same four permissions with the same words as staff (Book · Pay · Waivers · Emails), editable by the primary guardian only, and nobody may edit their own row. `isPrimary` reads the stored column instead of re-deriving from `guardianEmail`. The two axes are now named unmistakably: "What {child} can do" (child autonomy) vs "What each grown-up can do for {child}" (guardian access). Guardian-editable grid on `/member/family/[memberId]` (parent side) mirrors owner view (subject to the primary-guardian rule from CLAUDE.md). | UI | — | 🟢 |

### 4D. Testing (plan §4D)

| # | Task | Class | Status |
|---|---|---|---|
| 4D.1 | ✅ **DONE** — `npm run test:phase4` = 105 assertions, no DB: `family-accounts-tests.ts` (28) + `family-fixtures-tests.ts` (77 across 16 sections; §1–§14 named to match the brief, §15 the Cameron case, §16 the self-referential link). Plus `npm run verify:family-access` as a standing read-only regression tool over all 49 links. Fixture-based test suite: parent+one child · parent+multi-child same email · child linked after onboarding · child linked before · membership purchased by parent + assigned to child · staff-transfer · client-transfer · relationship removed · duplicate relationship attempt · reciprocal visibility · guardian permissions · staff permissions · unused-vs-used transfer. Extend `scripts/billing-admin-tests.ts` pattern. | Testing | 🟢 |

**Note:** Phase 4B's `guardianLinks` include fix + Phase 4C's per-permission grid land here in Phase 4 for the base data model. The redesigned Family & access surface (4.5.6) reads them.

### Phase 4 closed — 2026-08-03

**Phase 4 is done and merged to `main` at `be0bfe0` ("Merge Phase 4 — Client & Family Accounts (4A/4B/4C/4D)").** Migration `20260803000000_family_accounts` is applied. B1 and B2 were verified in the browser (see the banner at the top of this file), which cleared the last blocked items, and three defects found during that verification were fixed in `1642ef7`. Deliverable: `PHASE-4-DELIVERABLE.md`. Discovery: `PHASE-4-DISCOVERY.md`.

Four rows above are still `⬜`, and they are **not** blockers on Phase 4 — they are open by their own terms:

| # | Why it's still open |
|---|---|
| 4A.2b | `billing-admin/actions reassign_subscription` still returns the live-Stripe 409. The new transfer endpoint (4A.2) is the supported path; this row is the cleanup of the *old* one. |
| 4A.6, 4B.3, 4B.5 | Written as standalone regression checks. 4D.1's 105-assertion fixture suite covers the same ground (staff-transfer, client-transfer, reciprocal visibility, multi-child same email), so these are believed covered — **but nobody has mapped assertion-to-row**, so they stay open rather than be marked done on an assumption. |

**One operator step from `PHASE-4-DELIVERABLE.md` §7 has not been run:** `scripts/fix-family-links.ts` (deploy steps 4–6). Cameron is still linked to the duplicate account. Dry-run with `--audit` first; `--apply` needs the explicit member allowlist. This is Julian's to run from his own terminal.

---

## Phase 4.5 — Members Full Design Handoff

**Source of truth:** `docs/improvement/design_handoff_members_experience/` (`README.md`, `Members Experience Redesign.dc.html` sections `1a`–`1k`). See `plan.md` §Phase 4.5 for complete acceptance criteria per sub-phase.

**Core problem:** one vocabulary was doing three jobs. Split into 3 tracks, `nextAction(member)` next to every person, imports source label owner-typed.

**Owner-approved adjustment (2026-07-29):** every 4.5.x sub-phase has explicit mobile acceptance criteria. Sub-phase 4.5.9 remains the cross-cutting audit + Capacitor shell regression, not the first attention to mobile.

**Dependency reminder:** 4.5.10's `MemberSubscriptionEvent` closes Phase 2.5.5's ESTIMATED churn caveat. Reports Membership tab flips to COMPLETE reliability after the 4.5.10 backfill.

---

### Session D — QUEUED (Julian's local testing, 2026-08-05)

Julian merged after session 3. He confirmed working: roster cutover, profile
tabs, family switcher, and the ⋯ menu on lower rows. **Finding #1 (password
reset email) was answered and closed** — see below. Three items remain.

#### ✅ #1 CLOSED — password reset resolves the LOGIN account, correctly

The dialog offered `hello@athletix-os.com` while the edit drawer showed the
`julianramirez1181@gmail.com` he had just typed. Verified against production —
that is John Doe, and they are genuinely two different columns:

```
members.email (contact) = julianramirez1181@gmail.com
users.email   (login)   = hello@athletix-os.com
```

`resolveTarget` reads `member.user.email`, falling back to a CONFIRMED
guardian's login email. It never reads `members.email` for a send. Behaviour was
right; the copy was the problem. Both the dialog and Account & security now say
"account email … not the contact email on the profile."

**Editing a contact email does NOT move a login** — confirmed by reading the
PATCH: it writes `members.email` only, and its single `prisma.user` reference is
a *read* looking for a guardian account to link. Keep it that way.

#### D-1 — Duplicate detection flags siblings (ROOT CAUSE FOUND: data, not algorithm)

Julian: "siblings share a guardian email and phone by definition. Never key
duplicate detection on guardian contact fields."

The detector already believes it doesn't — its keys are `email:` from
`m.email`, `namedob:`, and `phone:` from `m.phone` + last name, and its header
comment says minors carry guardian contact on `guardianEmail`. **But the
guardian's contact was copied into the child's own columns at import.** Measured
read-only against production:

| | count |
|---|---|
| Live minors whose **own** `members.email` equals their guardian's email | **27** |
| Live minors whose **own** `members.phone` equals their guardian's phone | **42** |
| Live minors with any own email at all | 34 |

So 27 of 34 minors with an own email have the guardian's. Siblings collide on
`email:`, and on `phone:`+lastName (siblings share a surname). The algorithm is
keying on guardian contact — just laundered through the wrong column.

Two pieces of work, in this order:

1. **Make the detector defensive regardless of data.** Skip an `email:`/`phone:`
   key whenever that value equals the same row's `guardianEmail`/`guardianPhone`.
   A shared address is evidence of a shared *guardian*, never of a shared person.
   This must hold even after the data is cleaned, because the next import can
   reintroduce it.
2. **Then a data correction** for the 27 + 42 rows — null the child's own
   email/phone where it duplicates the guardian's, per the contact rule in
   CLAUDE.md. Dry-run by default, allowlist to act, **Julian runs it** (same
   shape as `scripts/fix-status-truth.ts`). Do NOT fold this into the detector.

#### D-2 — Merge button does nothing

Reported on both a sibling pair and the one genuine duplicate. The client path
looks wired (`openPreview` → modal → `confirmMerge` → `POST /api/members/merge`),
so **reproduce before changing anything** — seed a real duplicate pair locally;
session 3's fixture has none, which is why this was not caught.

First hypothesis to test: `/api/members/merge` refuses to merge two records that
both have a login (documented in CLAUDE.md). That returns a 4xx whose message
goes to `setMsg`, and if that banner renders above the fold it would read as
"nothing happened". Check the network response before assuming the button is
dead.

#### D-3 — Work-queue cards show "—" for blocked / missing contact / duplicates

Not a counting disagreement — **those three were never wired.**
`WorkQueueStrip` in `components/members/MembersRoster.tsx` renders
`counts && c.key === "neverInvited" ? counts.midMigration : "—"`. Only the first
card has a number, and even that one is borrowing `midMigration` rather than
counting never-invited.

All four need real counts. `memberWhere` already has the exact predicates —
`queue: "blocked" | "missingContact" | "neverInvited"` — so the counts must come
from those same clauses or the card and the list it opens will disagree. The
duplicates count comes from the duplicates detector, so it depends on D-1: wire
it AFTER the sibling fix, or the card will advertise a number Julian knows is
wrong.

#### D-4 — Edit drawer scope

Julian: "I need to edit everything about a member except birthday and password."

**Covers today** (`components/members/EditMemberDrawer.tsx`): first name, last
name, email, phone, guardian name, guardian email, guardian phone.

**Missing**: street address, city, state, zip, gender, emergency contact, notes,
tags, custom fields, and profile photo. `PATCH /api/members/[id]` already
accepts every one of those — `streetAddress`, `city`, `state`, `zipCode`,
`gender`, `notes`, `tags`, `customFieldValues`, `profileImageUrl` are all in its
Zod schema. **This is a UI gap only; no API or migration work.**

Correctly excluded, keep excluded: **birthday** (guardian-owned, `birthdayLockedAt`
— the locked row explains who changes it and where) and **password** (never
settable by staff; the reset flow is the only path).

Note `MemberModal` in `MemberModals.tsx` already renders the full field set
including custom fields — the drawer should reuse that field list rather than
grow a second, drifting copy of it.

---

### Session 3 — 2026-08-05 · half-wired work finished, 4.5.6–4.5.8 built

**No migration created or modified.** Phase 4.5's schema stays closed.

Julian tested session 2's branch locally and found it half-wired. Four reports,
all fixed and browser-verified before any new work started.

#### 1. One members route, one list

`/dashboard/members` **is** the redesigned roster now. The old 2,400-line page
is gone. Its five modals (Add/Edit member, CSV import, membership purchase, bulk
message, bulk email) moved verbatim to `components/members/MemberModals.tsx` and
the roster owns them — that extraction is what made the swap possible without
putting those flows at risk. `/dashboard/members/roster` redirects here so links
made during the session-2 window still land somewhere real. `?add=1` still opens
the Add-member modal, so the dashboard quick-action and the empty-state CTA keep
working.

#### 2. The profile renders the 4.5 components

`MemberProfileHeader`, `EditMemberDrawer`, `MemberActionsMenu` and
`PasswordResetDialog` existed and were mounted by nothing — "I can't edit a
member at all." All four are now on `/dashboard/members/[id]`: IdentityHeader
reading the same derived tracks as the roster row, ProfileTabs (variant 1c) with
counts and a red dot only where someone must act, the edit drawer, and
AccountSecurityCard sharing one reset implementation with the ⋯ menu.

**The family switcher needed a server fix to work at all.** `family` answers
"who can act for this member" and "who can this member act for"; neither answers
"who else is in this family". A sibling is reachable only through a shared
guardian, and a minor has no login, so both lists came back empty for exactly
the case the switcher exists for — Cameron Lister's profile showed no family
despite Rory being correctly linked to the same parent. `GET /api/members/[id]`
now also returns `familyMembers`: other athletes this member's **CONFIRMED**
guardians manage. Pending links are excluded — they grant nothing and must not
place someone in a family they may not belong to.

#### 3. Every ⋯ item does something

Three new routes, each a thin wrapper over machinery that already existed:

| Route | Notes |
|---|---|
| `POST /api/members/selection` | Resolves the query-scoped bulk selection into ids. `resolveSelection` had been sitting uncalled since session 2; without it "Select all N matching this filter" could only ever act on the loaded page. |
| `GET/POST /api/members/[id]/password-reset` | Reuses the forgot-password token machinery. **The destination address is resolved server-side and there is deliberately no client-supplied email field** — a staffer who could post one could redirect any member's reset link to their own inbox. |
| `POST /api/members/[id]/resend-invitation` | Single-member wrapper over `sendActivation`. `isReminder` is derived from send history, not passed, so the copy a family reads doesn't depend on which button was clicked. |

Bulk **Assign membership** deliberately refuses and says why: plan, price and
start date differ per family, so one bulk choice would be a billing mistake at
scale.

#### 4. The 281 vs 293 gap — answered

**All 12 are soft-deleted.** Verified read-only against production:

```
293 rows · 281 live · 12 deleted · 0 historical-only
```

The header no longer leaves it to be inferred — it reads
`N active records · … · N archived, not shown`.

That query surfaced a **latent gap worth knowing about**: `memberWhere` filtered
only `deletedAt`, so `isHistoricalOnly` rows — which 2.5.9 says belong in "no
active rosters, billing or messaging" — were counted as active people **and were
selectable by bulk actions**. An invitation sweep would have emailed people who
left years ago. Frog Empire has zero such rows, so no number Julian has seen
changes; the local fixture has five and they were being counted before the fix.

#### Two bugs only clicking could find

1. **The ⋯ menu was unreachable on most of the roster.** The table sits in an
   `overflow-x-auto` wrapper; CSS resolves the other axis to `auto` too, so the
   absolutely-positioned dropdown was clipped — fine on the top rows, cut off
   below. Now a portal with fixed coordinates that flips above the button when
   there's no room under it. (First attempt closed the menu on scroll, which
   broke the common case: clicking a ⋯ near the fold scrolls it into view and
   dismissed the menu the same gesture opened.)
2. **The family permission toggle silently reverted.** It PATCHed `?linkId=` in
   the query string; the handler reads `linkId` from the parsed body. The request
   400'd and the optimistic flip rolled back, so the switch appeared to work.

#### 4.5.6 Family & access — reconciled, not replaced

Phase 4's card was verified correct against the Lister family, so this adds only
what 4.5.6 asks for:

- **Permissions editable in place.** They were read-only pills, so the only way
  to change what a parent could do was to remove access and re-grant it —
  destructive for a correction as small as "Sam shouldn't be paying", and it
  discards the link's history. Toggles are optimistic and roll back on failure.
- **PENDING links show permissions but can't edit them.** The row grants nothing
  until confirmed; editing would imply an authority it doesn't have.
- Header count line, and each link states its origin ("matched the guardian
  email on file", "added by staff at the desk") — how a link came to exist is
  what decides whether to trust it.

Columns are the shipped `canBook` / `canPay` / `canSignWaivers` /
`canReceiveEmails` throughout (J-9: code wins). **No migration.**

⚠️ The spec asks for the creating staff member's *name* ("Added by Coach Ben").
The payload carries only `createdByUserId`, so this states the origin rather
than inventing an attribution — a wrong name is worse than an unnamed one.
Adding the name is a payload change for a later pass.

#### 4.5.7 Migration dashboard — the funnel replaces the eight KPI tiles

The eight tiles never added up to anything. The funnel's seven segments are one
sequence — the same steps `lib/memberTracks.ts` already resolves — so each
person is counted at the furthest step completed, the segments descend by
construction, and the drop between any two is a clickable population.

- `GET /api/members/migration/funnel` derives every number from
  `migrationMeterFor`. **There is no funnel column and there must not be one.**
- Clicking a segment adds `?step=N`, which the queue route resolves through the
  **same** resolver and intersects by id. A second derivation path would be a
  second set of rules to keep in sync.
- Sublines flag the drop *out of* their own segment, so the number tells you what
  clicking will show.
- **Cut-over advisory** answers "when can I stop paying for my previous system?"
  from real numbers, and errs conservative: anyone below step 6 has no confirmed
  membership here, and cancelling the old system while that is true is how a
  family ends up charged by nobody at all.

#### 4.5.8 Migration detail drawer

664px over the queue, so the filter behind it survives (verified: 2 rows before,
2 after). Header with `Step N of 7 · imported <date> · legacy <id>`, the 7-step
timeline with **timestamps and actors** pulled from `MemberMigrationEvent` rows
that nothing was reading, contextual invite actions on the invitation step
itself, and an imported-data table whose "As imported" column is headed with the
owner's **own** label for their previous system — never a hardcoded vendor name.

#### Verification

Genuine browser testing this session, unlike sessions 1–2: local Postgres 16 on
:55432 with all 89 migrations applied, `scripts/seed-local-browser-test.ts`
fixtures (23 members covering every roster state plus the Lister family), dev
server, and Chromium via Playwright. Every screen listed above was clicked.

`npx tsc --noEmit` clean · `test:phase45` 153 + 70 green · grep guards at
baseline 8 · `test:phase4` 93/93.

#### Still open

| # | Item |
|---|---|
| S-1 | Saved views — the "Save as view" control renders and `saved_member_views` exists; no route yet. |
| S-2 | Snooze / mark-reviewed routes — columns applied, nothing writes them. So funnel step 2 reads unreviewed for everyone until BF-A runs. |
| S-3 | `member_invitation_deliveries` is never written; bounce history in the reset dialog is therefore always empty. |
| S-4 | Balance column is always "—" — no balance source wired. |
| S-5 | Bulk "Add tag" removed rather than left as a dead button. |
| K-1 | Person-type labels still awaiting Julian's pick (options were listed in session 2). |
| 4.5.9 | Mobile audit + Capacitor regression — deferred once already; dark mode is item 1 per J-8. |
| 4.5.10 | `MemberSubscriptionEvent` writes + BF-B backfill. |

---

### Session 2 — 2026-08-04 · J-decisions applied, 4.5.2–4.5.5 built

**Migration applied.** No migration was created or modified this session.

#### J-1 … J-10 — all resolved

| # | Decision | What was done |
|---|---|---|
| J-1 | accepted | `sourceLabel` not re-added. Render-side only; `resolveSourceLabel` reads `ImportBatch.sourceLabel` then `Member.legacySource`. |
| J-2 | accepted **with the union** | Column stays TEXT. `BLOCKED_REASONS` is a `readonly` tuple, `BlockedReason` its union, `BLOCKED_REASON_LABELS` a `Record<BlockedReason, string>` — so a new reason cannot be added without its label, and a typo is a compile error. `asBlockedReason()` narrows what the column actually holds; unknown values read as no-reason rather than printing a raw token at an owner. |
| J-3 | accepted | `PROFILE_INCOMPLETE` kept. |
| J-4 | accepted | `legacySource` fallback kept. |
| J-5 | accepted | Billing gating unchanged; **no exception built for Sal.** On `billing:full` he clears every members-surface gate except owner-only Archive — asserted in `member-ui-tests.ts` §2 so it stays true. |
| J-6 | accepted | A blocked member still surfaces through a snooze. |
| J-7 | accepted | Ratchet at baseline 8; must reach 0 for phase exit. |
| J-8 | accepted, **re-raised** | Dark mode is now the FIRST item of plan.md §4.5.9, with "deferred once already" recorded in the text. |
| J-9 | fixed | plan.md §4.5.6 corrected to `canSignWaivers` / `canReceiveEmails`, and its "Migration required: M21" block replaced — that migration was absorbed by `20260803000000_family_accounts`. |
| J-10 | tabs + **split** | `1c` tabs built. The Prospect question had a real answer — see below. |

#### J-10: the Prospect conflation was real

`!everHeldMembership → PROSPECT` asked only *"have they ever bought anything"*. So a walk-in who trialled last Tuesday and a name typed into the roster months ago and never contacted rendered the **identical pill**. Imported names were already excluded by the never-Prospect rule, so the collapse hit exactly the manually-added group.

The fix is a **split, not a rename**, because the two need opposite next actions — the trialler needs a membership offered, the untouched name needs somebody to make contact at all. `hasTouchedTheClub()` separates them on attendance / any trial ever granted / their own login, and `nextAction` gained `MAKE_CONTACT`, gated on `members:edit` rather than billing (phoning a lead is not a money action).

#### Shipped

| Sub-phase | What | Where |
|---|---|---|
| 4.5.1 wiring | `MEMBER_TRACK_SELECT` live behind `GET /api/members?paginated=1`; `GET /api/members/[id]` additively returns `tracks` / `nextAction` / `sourceLabel` | `lib/membersQuery.ts`, both routes |
| 4.5.2 | Members list — work-queue strip, segmented control with server counts, search, Filters sheet, active-filter chips, query-scoped bulk bar, table + card list, footer | `components/members/MembersRoster.tsx`, `app/dashboard/members/roster` |
| 4.5.2 §1g | `⋯` menu — nine actions, fixed order, permission-denied items visible + locked with the role named | `components/members/MemberActionsMenu.tsx` |
| 4.5.3 | Profile — identity header, single family switcher, 11 tabs, locked-birthday row, ownership legend, Account & security | `components/members/MemberProfileHeader.tsx` |
| 4.5.4 | Edit drawer — info strip, grouped fields, corrected-field Revert, locked block, attributed footer | `components/members/EditMemberDrawer.tsx` |
| 4.5.5 | Password reset — three states, copy verbatim, live countdown | `components/members/PasswordResetDialog.tsx` |
| 4.5.11 | `npm run test:phase45` → 153 fixtures + 70 UI assertions + 2 grep guards | `scripts/member-*-tests.ts` |

**Legacy `/api/members` is deliberately unchanged.** The new envelope is opt-in via `?paginated=1`; the migration page, attendance add-panel and several modals index the bare array and would all break in one commit otherwise.

#### Still open in 4.5

| # | Item |
|---|---|
| S-1 | **Roster cutover** (K-3) — port the Add-member modal, CSV import mapping, custom-field editor and membership purchase flow, then point `/dashboard/members` at the new list and retire the old page. Guard 2's ratchet reaches 0 here. |
| S-2 | **Bulk actions are wired to nothing.** The bar renders and `resolveSelection()` exists server-side; `POST /api/members/bulk` does not yet accept `{mode:'allMatching', filter}`. |
| S-3 | **Saved views** — `saved_member_views` exists, no route yet. |
| S-4 | **Snooze / Mark reviewed** — columns exist, no route sets them. |
| S-5 | **Invitation deliveries are never written.** `lib/migrationServer.ts` still only bumps the Member counter, so Blocked derivation falls back to "3 sends, never opened" and cannot yet tell a bounce from an ignore. |
| S-6 | **Balance column always reads —.** Needs a transaction aggregate; deliberately not added to the page-load hot path yet. |
| S-7 | 4.5.6 Family & access, 4.5.7 migration dashboard, 4.5.8 detail drawer, 4.5.9 mobile+dark audit, 4.5.10 source-label surfaces + Reports flip. |

---

### Session 1 — 2026-08-04 · what shipped, what is blocked

**Migration `20260804000000_members_experience` is WRITTEN, NOT APPLIED.** Apply commands are at the top of this file.

#### Shipped and green (no migration needed)

| Piece | Where | Notes |
|---|---|---|
| Status model + `nextAction` resolver | `lib/memberTracks.ts` | PURE — no Prisma import. Three tracks, 7-step meter with whose-turn, one resolver shared by row / banner / mobile card. Source-label resolution that degrades instead of naming a vendor. |
| Prisma-facing serializer | `lib/memberDisplay.ts` | `serializeMemberForList` + `MEMBER_TRACK_SELECT` + segment counts. **Written and type-checked, deliberately NOT wired** — see blocked list. |
| 4.5.11 fixtures | `scripts/member-tracks-tests.ts` | 146 assertions, no DB. `npm run test:member-tracks`. |
| 4.5.11 grep guards | `scripts/members-grep-guards.ts` | `npm run test:members-guards`. Vendor-literal guard is a HARD FAIL and is green. Deprecated-vocabulary guard is a ratchet at baseline 8. |
| Track components | `components/members/MemberTracks.tsx` | Role chips, membership pill, account-setup cell, 7-segment meter, vertical timeline, whose-turn pill, next-action button + banner, avatar. |
| Semantic tokens | `app/globals.css` | The handoff's "New semantic pairs" table as `@theme` entries. |
| Backfills | `scripts/members-experience-backfill.ts` | Dry-run default; `--apply` refuses to run without `--clubs`. |
| **Vendor name removed from the UI** | `app/dashboard/members/migration/page.tsx` | The import wizard's "Previous software" field shipped `placeholder="e.g. Jackrabbit, Mindbody, spreadsheet"` — two real products named in the UI of a third, in a `.tsx`, which is exactly what 4.5.10 forbids. Now a neutral placeholder plus a line explaining how the value is used. Guard 1 fails the build if it comes back. |

**A real bug the fixtures caught on first run.** `derivedBlockedReason()` put a red *"Blocked · no email on file"* dot on any imported member with no email — **including members who had already finished setup**, typically a minor onboarded entirely through a guardian's address. Blocking someone for lacking an invite address *after* they have used the invitation is precisely the wrong-but-defensible label this phase exists to kill. Fixed with `hasStartedSetup()`; three regression assertions pin it.

#### ⛔ Blocked on `20260804000000_members_experience`

Everything here is written against `schema.prisma` and type-checks clean. None of it can execute until the migration is applied, because the columns do not exist in the database yet.

| # | Blocked item | Why | First thing to do after apply |
|---|---|---|---|
| B-1 | **Wiring `MEMBER_TRACK_SELECT` into `GET /api/members`** | The select names `reviewedAt`, `reviewedByUserId`, `blockedReason`, `snoozedUntil`. Handing it to Prisma before apply throws and takes the members list down. | Swap the select in `/api/members` + `/api/members/[id]`, return `{ tracks, nextAction }` per row. |
| B-2 | **Server-side paging, search and segment counts (4.5.2)** | Depends on B-1, and on the two new indexes for acceptable performance at 5,000 members. | Add `?page&pageSize&search&filter&sort`; counts from the query, never the page. |
| B-3 | **Migration meter step 2, "Information reviewed"** | Needs `members.reviewedAt`. Until then the meter honestly reads step 1 for every unreviewed import — no fabrication, but no step 2 either. | Run BF-A, then surface `Mark reviewed` in the queue's bulk bar. |
| B-4 | **Blocked state from real delivery data (4.5.1, 4.5.10)** | Needs `member_invitation_deliveries`. Today `derivedBlockedReason` falls back to `Member.activationEmailSendCount`, which cannot tell a bounce from an ignore — and those need opposite actions. | Write a delivery row per send in `lib/migrationServer.ts`; add the Resend webhook branch. |
| B-5 | **Snooze 7 days (4.5.3 banner, 4.5.7 queue)** | Needs `members.snoozedUntil`. The resolver already honours it; nothing can set it. | `PATCH /api/members/[id]/snooze`, gated on `members:edit`. |
| B-6 | **Save as view (4.5.2)** | Needs `saved_member_views`. | `GET/POST/DELETE /api/members/views`. |
| B-7 | **Reports churn `ESTIMATED` → `COMPLETE` (4.5.10)** | Needs `member_subscription_events` **and** BF-B to have run for that club. Creating the table empty is not enough — an empty log would read as "nothing ever happened". | Run BF-B, write events from every `MemberSubscription` mutation, then flip `reliability` in `lib/reportsMembership.ts`. |

#### 🙋 Needs Julian's call

**Session 1's J-1 … J-10 are all RESOLVED (owner, 2026-08-04)** and recorded in the session-2 block below. What follows is new.

| # | Decision | Status |
|---|---|---|
| K-1 | **Person-type labels — YOURS TO PICK.** Options below; I built nothing that forecloses any of them. | ⬜ open |
| K-2 | **Prospect / Lead naming.** The split is built and correct; only the two words are provisional. | ⬜ open |
| K-3 | **Roster cutover.** The new list is at `/dashboard/members/roster`. Making it the default means porting the Add-member modal, CSV import mapping, custom-field editor and membership purchase flow off the 2,400-line page. | ⬜ open |
| K-4 | **Browser pass owed.** Nothing in session 2 was verified in a browser — see the honesty note below. | ⬜ open |

##### K-1 — the four person-type labels

Current segmented control reads: **Everyone · Athletes · Parents · Account holders · Prospects · Inactive**.

The friction is that "Parents" and "Account holders" overlap heavily but not completely — a parent who doesn't pay, and a grandparent who pays but isn't a guardian, both exist — and staff read "Account holders" as a billing concept rather than a person concept.

| Slot | Current | Option A — plain | Option B — role-first | Option C — job-first |
|---|---|---|---|---|
| 1 | Athletes | Athletes | Athletes | Who trains |
| 2 | Parents | Parents & guardians | Guardians | Who's responsible |
| 3 | Account holders | Payers | Account holders | Who pays |
| 4 | Prospects | Prospects | Prospects | Not joined yet |

**My recommendation: Option A.** "Parents & guardians" is what staff actually say out loud, and it stops a legal guardian who isn't a parent reading as excluded. "Payers" is shorter than "Account holders", is unambiguous about what it means, and doesn't collide with the billing vocabulary elsewhere in the app. Option C reads well in isolation but makes the control much wider, which is the one thing this row cannot afford at 375px. Option B keeps "Account holders", which is the term I'd most want to lose.

##### K-2 — Prospect / Lead

Your definition is now implemented: **Prospect = attended a practice or did a free trial, never joined. Lead = a name nobody has contacted.** `hasTouchedTheClub()` separates them on attendance, any trial window ever granted, or their own portal login.

"Lead" is a placeholder. Alternatives, if it reads too salesy for a club: **Prospect / Enquiry**, **Trialled / Prospect** (shifts both words), or **Prospect / Not contacted** (longest but zero ambiguity). Renaming is one line in `MEMBERSHIP_LABELS`; the derivation stays as-is either way.

#### ⚠️ Honesty note — what was NOT verified in session 2

The brief said to browser-test as I built. **I could not.** There is no `.env` in this container and the sandbox cannot reach the database (CLAUDE.md records this as a standing limitation), so no page renders against real data.

What I did instead, and what it is worth:

- `npm run test:member-ui` — 70 assertions. Server-renders every component through `react-dom/server` and asserts the handoff's final copy appears. **This proves components mount and say the right words. It does not prove they look right, that the layout holds at 375px, or that any interaction works.**
- `npm run build` — clean, which catches render-time crashes in server components.
- `npm run test:member-tracks` — 153 assertions over the pure rules.

**Still owed, and none of it is optional before the roster goes live:** click through the list at 375 / 414 / 768 / 1280, confirm the `⋯` popover positions correctly near the viewport edge, confirm the filters sheet scrolls on a short screen, watch the `Resend in m:ss` countdown actually tick, and confirm the query-scoped "Select all N" really does reach rows on page 2+.

One harness limit worth recording: `MemberActionsMenu` cannot be server-rendered in the smoke because it calls `useRouter()`, which throws outside Next. Its order and gating are asserted against the data instead, which is where those rules live — but the rendered lock affordance is unverified.

---

### 4.5.1 Status model + `nextAction` resolver

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 4.5.1.1 | `lib/memberDisplay.ts serializeMemberForList(member)` returning `{ tracks: {role, membership, accountSetup}, nextAction: {label, kind, permission}, ... }`. | Backend | — | 🟢 written + type-checked 2026-08-04. **Not wired** — its select names the new columns (B-1). |
| 4.5.1.2 | `nextAction(member)` — **one function** used by row action + banner + mobile card. | Backend | — | 🟢 `lib/memberTracks.ts`. 12 canonical states pinned; §9 of the fixtures asserts row/banner/mobile agree. |
| 4.5.1.3 | Server-side derivation in `GET /api/members`, `GET /api/members/[id]`, `GET /api/members/migration`. | Backend | — | ⛔ **B-1** — blocked on M30. |
| 4.5.1.4 | Retire "Un-invited" for manual-add + "Profile completed (reviewed)" everywhere. Deprecate `displayStatusOf` / `onboardingStatusOf`. | Backend | — | 🟡 the new vocabulary is written and §5 of the fixtures asserts neither label can be produced. The old functions still exist in `app/dashboard/members/page.tsx` and die with 4.5.2's rewrite. |
| 4.5.1.5 | `Member.reviewedAt` + `reviewedByUserId`. Backfill from the attributable NOTE migration event. | Migration + Backfill | M30 + BF-A | ⬜ written, not applied |
| 4.5.1.6 | `Member.blockedReason` + `snoozedUntil`. | Migration | M30 | ⬜ written, not applied. TEXT not enum — see J-2. |
| 4.5.1.7 | `MemberInvitationDelivery` (per-send delivered/opened/bounced). | Migration | M30 | ⬜ written, not applied |
| 4.5.1.8 | Migration-meter derivation: `Step N of 7` + whose-turn label + segment color per state. | Backend | — | 🟢 `migrationMeterFor()`. Ordinal backfill included, so a member activated before `reviewedAt` existed renders no hole mid-meter. |
| 4.5.1.9 | Presentational kit for the three tracks + meter + next action. | UI | — | 🟢 `components/members/MemberTracks.tsx` |
| 4.5.1.10 | Fixtures for every rule above. | Testing | — | 🟢 `npm run test:member-tracks` — 146 assertions |

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

### 5.0 Ownership boundary vs the 2026-08-03 events/billing hotfix line (recorded 2026-08-03)

The Frog Empire Road Trip incident produced work that touches the same tables Phase 5 plans to touch. This records who owns what so neither side builds it twice.

**Shipped OUTSIDE Phase 5 (branch `claude/frog-empire-invoice-bug-qq3q0i`, merged to `main` 2026-08-03, plus two follow-ups merged 2026-08-04). Phase 5 must not re-spec these:**

| Item | Where it lives | Phase 5 relationship |
|---|---|---|
| `lib/eventRepricing.ts` — pricing resolution + reprice lock rules | shipped | Not in plan.md Phase 5 at all. Phase 5 §5.2.2's `renderableRegistrationState` should read amounts through it rather than re-deriving. |
| Reprice preview + apply (`/api/events/[id]/reprice-registrations`) | shipped | Not in Phase 5. |
| `bill-registrants` preview mode + `AMOUNT_MISMATCH` 409 | shipped | Phase 5 §5.0 names `bill-registrants` as the escalation lever and says do not fork it — the escalation cron calls the same route, so it inherits preview/mismatch for free. |
| Registration removal (`DELETE /api/events/[id]/registrations/[regId]` → CANCELED) | shipped | Phase 5 §5.5.1 (capacity parity) depends on CANCELED being the removal state. Now true. |
| `/pay/complete` — payment confirmation for events with no public slug | shipped | **Overlaps Phase 5 §5.2.3 / PROGRESS 5.2.4–5.2.5.** Phase 5 OWNS the final surface (`/e/[slug]/registered/[registrationId]`, live state, confirmation code). `/pay/complete` is the interim 404 fix and is **superseded** when 5.2.4 lands — delete it then, and repoint `bill-registrants` + `eventAutoCharge` return URLs at the Phase 5 route. |
| Per-row cash/check settlement on the Registrations roster | shipped | Not in Phase 5. Phase 5 §5.2.5 row "Offline payment recorded" only governs the receipt email's dedupeKey. |
| `POST …/registrations/[regId]/resend-receipt` | shipped | **Adjacent to PROGRESS 5.2.6 `resend-confirmation`** — different artifacts. Receipt = proof of payment (money). Confirmation = proof of registration (state). Phase 5 keeps 5.2.6; it must NOT absorb or replace resend-receipt. |
| Roster **Contact** column — shows where the invoice will actually be sent, per registration | shipped `00012f8` (2026-08-04) | Not in Phase 5. Phase 5's confirmation surface (§5.2.7) shows the registrant; this column answers the different question "who gets billed". |
| `BILLING_CONTACT` recipient mode — bill the guardian, not the athlete | shipped `e6c523a` (2026-08-04) | Not in Phase 5. Phase 5 §5.2.8 keeps its own rule (one confirmation email per registration, deliberately) — that is about *confirmations*, not invoices, and the two must not be collapsed. |

**Phase 5 KEEPS ownership of (do not build in the hotfix line):** the server-rendered confirmation surface + confirmation code (§5.2.3), `renderableRegistrationState` (§5.2.2), the lifecycle email matrix + dedupe keys (§5.2.5), coach approval / proposed change / escalation cron (§5.3–5.6), `EventRegistration.status` as an enum (M17), the email-uniqueness constraint (M18), `Booking.bookedByUserId` (M19), and capacity parity (§5.5.1).

**Open model question (owner decision pending, 2026-08-03):** whether `Booking` remains a separate table. plan.md §5.4 already declares the intended split — `Booking` = confirmed-spot/roster primitive, `EventRegistration` = the registration + money record, no Booking row until approval on approval-gated events. The hotfix line surfaced that the two tables can disagree in production. **If the owner approves collapsing them, that work belongs to Phase 5 §5.4, not to the hotfix line**, because §5.4 already owns Booking's write path and M19 already migrates the table.

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

- 2026-08-04 (session 2) — **Phase 4.5: J-decisions applied, 4.5.2–4.5.5 built, no migration touched.** The owner resolved J-1…J-10; all ten are recorded in the Phase 4.5 section. Two changed the code rather than just the docs. **J-2**: `blockedReason` stays TEXT in the database but its TYPE is now a union with a `Record`-typed label map, so a new reason cannot be added without its label and a typo fails the build; `asBlockedReason()` narrows whatever the column holds. **J-10**: the Prospect conflation was real — `!everHeldMembership → PROSPECT` asked only "have they ever bought anything", so a walk-in who trialled last Tuesday and an uncontacted name in the roster rendered the identical pill. The fix is a split, not a rename, because they need opposite next actions; `hasTouchedTheClub()` separates them and `nextAction` gained `MAKE_CONTACT` (gated on members, not billing). LEAD is a placeholder name — K-2 is the owner's call. J-9 corrected plan.md §4.5.6, which named two columns that do not exist. J-8 moved dark mode to the FIRST item of 4.5.9 with the prior deferral recorded. **Built**: the serializer wired behind `GET /api/members?paginated=1` with server-side paging, search, filters and query-derived segment counts (`counts:null` past COUNT_CAP rather than a wrong number); `GET /api/members/[id]` additively returning tracks; the members list with work-queue strip, segmented control, filters sheet, query-scoped bulk bar, table + mobile cards; the `⋯` menu with permission-denied items visible-and-locked; the profile's identity header, single family switcher, 11 tabs and locked-birthday row; the edit drawer with its three load-bearing rules enforced; and password reset's three states with verbatim copy. Tests: `npm run test:phase45` = 153 fixtures + 70 UI assertions + 2 grep guards. **Not verified in a browser** — no `.env` and no database reachable from the sandbox; the UI coverage is `react-dom/server` renders that prove components mount and say the right words, not that they look right or that interactions work. Seven items remain open in 4.5 (S-1…S-7), the largest being the roster cutover off the 2,400-line members page.

- 2026-08-04 — **Phase 4.5 session 1: one migration written (NOT applied) and the status-model spine built.** `prisma/migrations/20260804000000_members_experience` carries every schema need across 4.5.1–4.5.11 in one folder: `members.reviewedAt/reviewedByUserId/blockedReason/snoozedUntil`, new `member_invitation_deliveries` (one row per SEND — the existing timestamp+counter cannot tell a bounce from an ignore, and those need opposite actions), `saved_member_views`, `member_subscription_events` (the sidecar that lets Reports churn stop saying ESTIMATED), plus three indexes for server-side paging and the funnel's seven per-load counts. Additive only, reverse SQL in the footer, no RLS policies (matching every table added since `20260702000000_enable_rls`). **Two things the plan lists as 4.5 migrations were deliberately omitted because they are already in production** — `ImportBatch.sourceLabel` (2.5.9) and the `member_guardian_users` permission columns (M29, which absorbed M27) — and the migration header documents both omissions at length so a later session doesn't "fix" them. Built on top: `lib/memberTracks.ts` (PURE, no Prisma — three tracks, the 7-step meter with whose-turn, and `nextAction()` as ONE resolver shared by row, banner and mobile card), `lib/memberDisplay.ts` (the Prisma-facing serializer — complete and type-checked but deliberately NOT wired, since its select names columns that don't exist yet), `components/members/MemberTracks.tsx` (the presentational kit), the handoff's semantic token pairs in `app/globals.css`, and `scripts/members-experience-backfill.ts` (dry-run default, `--apply` refuses without a `--clubs` allowlist). Tests: `npm run test:phase45` — 146 fixture assertions plus two grep guards. **The fixtures caught a real bug on first run**: `derivedBlockedReason()` put a red "Blocked · no email on file" dot on imported members who had *already finished setup*, typically a minor onboarded entirely through a guardian's address — blocking someone for lacking an invite address after they have used the invitation is exactly the wrong-but-defensible label this phase exists to kill; fixed with `hasStartedSetup()` and pinned by three regression assertions. **The vendor-literal guard also found a live violation**: the import wizard's "Previous software" field shipped `placeholder="e.g. Jackrabbit, Mindbody, spreadsheet"` — two real products named in the UI of a third, in a `.tsx` — now replaced with a neutral placeholder. `tsc --noEmit` and `npm run build` clean throughout. Ten decisions taken conservatively and logged under "Needs Julian's call" in the Phase 4.5 section; seven items logged as blocked on the migration with the first step for each after apply.

- 2026-08-04 — **Docs housekeeping (no code).** `plan.md` §4 Implementation Order now reflects reality: Phases 2.5, 3 and 4 marked ✅ Done, remaining work is 4.5, 5, 6 (there is no Phase 4.6 anywhere in this plan — noted in the table so it stops being asked). Phase 2.5's one carve-out — 2.5.12, the mobile/responsive audit the owner deliberately held back — is called out under the table so "Done" isn't read as covering it. `plan.md` §5.12 rewritten from eight open questions into **eight recorded decisions**, each carrying the owner's answer inline; a future session must not re-ask them. §5.6.7's cron gate got a pointer to the §5.12 item-5 timezone decision so the two can't drift. New `plan.md` §4a-i closes the imports/`sourceLabel` shared-migration plan (see the entry below). Here in `PROGRESS.md`: phase index updated for 2.5/3/4, M29 corrected to applied, Phase 4 section statuses synced to the ✅ DONE markers already in the task text, a "Phase 4 closed" note added naming the four rows still genuinely open and the one unrun operator script, and the two 2026-08-04 invoice/roster commits recorded on the §5.0 ownership-boundary table. Per-task checkboxes inside 2.5.x, 3.x and 4.5.x were **not** swept — marking those done would be asserting verification this session didn't do.

- 2026-08-04 — **The 2.5.9 ↔ 4.5.10 shared-migration dependency is resolved, not broken.** §4a said imports and 4.5.10's `sourceLabel` should ship in one migration so `Member` and `Transaction` were altered only once. 2.5.9 shipped first and did exactly that: `20260731030000_historical_imports` (applied 2026-07-29) created `import_batches` **including `sourceLabel`**, and both tables were altered once. So the constraint the shared migration existed to enforce was satisfied, and there is nothing left to share. **4.5.10 now needs exactly one migration of its own: `MemberSubscriptionEvent`** (inventory row M28, renumbered from M22) — new `member_subscription_events` table + `kind`/`source` enums + indexes on `(clubId, at)` and `(memberSubscriptionId, at)` + an RLS policy, additive, with no column added to `member_subscriptions`. The source-label half of 4.5.10 needs **no** schema change at all — it is rendering, copy degradation, and the vendor-literal grep guard against a column that already exists in production. Full detail in `plan.md` §4a-i.

- 2026-08-04 — **Invoice/roster follow-ups merged to `main`.** `00012f8` — the Registrations roster gained a **Contact** column showing where the invoice will actually be sent for each registration. `e6c523a` — **`BILLING_CONTACT` recipient mode**: bill the guardian rather than the athlete. Both recorded on the §5.0 ownership-boundary table so Phase 5 does not re-spec them; neither is Phase 5 work.

- 2026-07-31 — **Phase 3 checkpoints D + E shipped.** Checkpoint D: `components/EmailComposer.tsx` — canonical `EmailBlock[]` DSL is the store format (NOT tiptap ProseMirror JSON); block picker inserts heading/paragraph/list/button/image/divider/spacer/contact/logo; tiptap runs ONLY inside paragraph + list-item rich-text fields (bold/italic/underline/link) with a tiny DOM-based `htmlToRuns` normalizer that emits `InlineRun[]` directly — no lossy round-trip. Desktop + mobile (375px) preview panels. Wired into `/dashboard/members` bulk bar as **"Email selected"** → new `BulkEmailModal` that calls `/api/members/bulk/email-preview` for the plan §3A pre-send review (household mode picker + counts + skip categories + per-recipient preview) then `/api/members/bulk` `action=email` with a stable per-modal `clientKey` for idempotency. Composer dynamic-imported (SSR off) so tiptap's ~90 KB stays out of the /dashboard/members initial bundle unless the modal opens. Checkpoint E: `lib/emailImages.ts` + `/api/public/images/[fileId]?t=<hmac>` — HMAC-SHA256 with dedicated `EMAIL_IMAGE_SECRET` (NEVER `NEXTAUTH_SECRET`; no expiry, IMAGE-kind only, immutable cache); `/api/emails/image-url` mints the signed URL server-side (session-gated, club-scoped) so the composer never touches the secret. Resend webhook at `/api/webhooks/resend` — verifies Svix v1 signature against `RESEND_WEBHOOK_SECRET` (base64-decoded, `whsec_` prefix stripped), maps `email.sent/delivered/bounced/complained/opened/clicked/failed/delivery_delayed` to `EmailSend` lifecycle updates; never regresses terminal states (BOUNCED > DELIVERED > SENT), openCount/clickCount monotonic, unknown providerMessageId returns 200 (no retry storm). `/api/cron/email-queue` + `netlify/functions/email-queue-cron.mts` (`*/5 * * * *`) drain any stuck QUEUED rows via delete-then-reinsert-through-`sendClubEmail` under one transaction — the (sendBatchId, dedupeKey) partial unique index makes concurrent retries P2002 without double-send. Required tests: `scripts/email-recipients-tests.ts` — 43 pure-function tests via new `resolveRecipientsPure()` export (pure algorithm split from DB-facing `resolveRecipients()`); covers the schema-review constraint (guardian with 2 children → 1 row HOUSEHOLD, 2 rows PER_MEMBER, 2 rows PER_ATHLETE_PRIMARY) + duplicate-send prevention (retry-stable dedupeKeys per mode; adults at shared address collapse in HOUSEHOLD only) + all 4 skip reasons + legacy `guardianEmail` fallback. Verification: `npx tsx scripts/email-recipients-tests.ts` 43/43 pass; `npx tsc --noEmit` clean; `npm run build` clean (`/dashboard/members` 10.5 → 14.6 KB from the composer wiring, one pre-existing `htmlnano` webpack warning). Browser test via curl round-trip: signed image with correct HMAC → past sig check to 404 on missing row; wrong secret → 403. Svix-signed webhook: bad sig → 401, valid sig → 200. `EMAIL_IMAGE_SECRET` set in `.env` before running the composer locally. Chrome MCP extension wasn't connected in this session so the full UI click-through in a browser wasn't run — endpoint boundaries were exercised with curl, the dev server compiled every route cleanly, and the production build includes the new bundle at expected size. Not committed by this session (owner reviews + commits).

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

## Session handoff — 2026-07-30 (end of Phase 2.5.13 session)

### What's done

- Phase 2.5.13 (test suite) shipped and pushed to `main` at commit `84114ba`.
- 238-test pure-function suite in `scripts/reports-tests.ts` — no DB, no Stripe, no network. Runs via `npx tsx scripts/reports-tests.ts` and exits non-zero on any failure.
- Six additive extractions across the reports libs so calculation cores can be unit-tested without Prisma. Zero call-site behavior changes.
- Real bug fixed at the `sumColumns` root — every newly onboarded club with no data in range was getting `NaN` for `netProfit` and `undefined` for `grossIncome` across every column. Four permanent regression tests lock the fix.
- `npx tsc --noEmit` clean, `npm run build` clean, `npm run lint` unchanged from HEAD (253 pre-existing warnings/errors, 0 introduced).

### What's still open in Phase 2.5.13 (deferred, not blocking)

**Route-level integration tests.** Every `buildXxx` function that calls Prisma is covered at its pure calculation core (`computePnl`, `detectTransferPairs`, `classifyPlaidRow`, `classifyEndedSub`, `computeChurnRates`, `computeUnitEconomicsCore`, `resolveBehavior`, `trailingPeriods`, `isUnusualIncrease`). What is NOT covered: the `buildXxx` wrappers themselves, the route handlers, and the DB queries. To close this, either:
1. Add a lightweight Prisma mock harness (module cache swap for `@/lib/prisma`) and re-run the same tests through the `buildXxx` wrappers, or
2. Add integration tests that hit a scratch DB and assert real payload shapes. Needs sandbox DB access (or Julian runs the test script locally with his creds).

**21 DB-dependent import rules from spec 06 §Historical imports.** The pure logic is covered — matching signals (`resolveMatch`, HIGH auto-match, HIGH-vs-HIGH → REVIEW, name-only → CREATE, external-id-collision → REVIEW), normalizers, `makeDedupeHash` determinism, CSV parse, row validators. The DB-dependent rules that are NOT yet under test:
- Idempotent members import (importing the same file twice creates no duplicates) — route-level.
- Idempotent transactions via the `(clubId, sourceSystem, externalTransactionId)` unique constraint — Prisma P2002 path.
- Composite fingerprint dedupe path (rows with no external tx id).
- The five review outcomes each write the right records (MEMBER, HISTORICAL_RECORD, IMPORT_ROW, etc.).
- Merge semantics — survivor = native, never overwrites non-empty native fields.
- Imports trigger no email, no invite, no billing, no campaign — assertion-worthy in `commit` route.
- Undecided rows survive commit as `PENDING_REVIEW`; the rest of the batch still commits.
- Rollback within 30 days removes created records + detaches history + reverses merges.
- Rollback leaves alone any created record that has since gained activity.
- Rollback after 30 days is refused.
- Rollback is refused for non-owners.
- Audit log has one row per CSV line (including excluded ones).
- `errors.csv` contains the original rows verbatim plus an error column.
- 50,000-row file completes; 50,001-row file is rejected with a clear message.

**Other DB-dependent assertions from spec 06 not yet route-tested.** Same-story: covered at calc core, needs route/integration to prove end-to-end.
- Payroll leak — verified at the route SOURCE (grep asserts the route strips payroll when caller lacks `reports.payroll`), but not exercised through a real request.
- Coach revenue scoping on `groupBy=coach` — server-side denial.
- Tier gating returns `UPGRADE_REQUIRED` with the existing body shape.
- Hidden tabs unreachable by direct URL.
- Every reliability `href` resolves to a real route (grep-verified in the reliability module; not fetched).

### What's next per PROGRESS.md ordering

**Phase 2.5.12 — Mobile + responsive audit + regression pass.** DO NOT start until the user asks. Session brief explicitly held this back.

### Notes for a fresh session

- The extracted pure cores are the API surface for future tests. Import them from `@/lib/reports*` — every extraction is a NAMED EXPORT alongside the existing `buildXxx` function.
- `PnlFixtures` type in `lib/reportsPnl.ts` documents exactly what `buildPnl` fetches from Prisma. Any future test that mocks Prisma for `buildPnl` should populate `{txs, expenses, donations, allSubs, payrollPerCol}` in that shape.
- The `sumColumns(arrays, cols)` signature change is intentional — do NOT re-introduce a fallback to `arrays[0]?.length ?? 0`. The empty-input case is a real production path (any club with no data in range), and returning `[]` corrupts every downstream summary.
- The 4 empty-section regression tests are the invariant that keeps this from regressing. They live in `scripts/reports-tests.ts` under "P&L calculations" (empty range) and "Refunds" (same-row full refund) and "Cash + offline" (comp $0) and "Partial periods" (weekly rolling avg no-NaN check).
- Pre-existing lint debt in the reports libs — `let recognized` in `reportsPnl.ts:189`, unused `nextMonMidnight` in `reportsRange.ts:141`, unused `ALL_ON` in `reportsPermissions.ts:44`, unused `_` in `reportsRevenue.ts:354`. None introduced this session; leave for a global lint sweep unless the file is being touched.
- Database is unreachable from the Claude Code sandbox. All migrations M1–M15 are applied to production. Do not create new migrations without owner instruction.
- Production was wiped and restored the night of 2026-07-29. Read the "Database safety" section in root `CLAUDE.md` before running anything that could touch prod.
- `/dashboard/financials` and `/api/financials/*` are the regression-guard surface — any change to Reports must not modify those. Snapshot test in `scripts/reports-tests.ts` asserts (a) the page file exists, (b) the 6 known route files exist, (c) the page never fetches `/api/reports/`. If any of those flip false, the Reports work has bled into Financials.

---

*See `ARCHITECTURE-NOTES.md` for the discovery findings that back this plan.*
