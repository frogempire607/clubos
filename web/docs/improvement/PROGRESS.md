# AthletixOS Improvement — Progress & Phased Plan

Companion to `plan.md` (the brief) and `ARCHITECTURE-NOTES.md` (the discovery findings).

**Preserve existing production data.** Every migration is additive; every backfill is dry-run-first with allowlists; nothing gets renamed, dropped, or silently relabeled. Follow the two-workflow migration pattern (hand-write SQL → `migrate deploy` → Supabase MCP bookkeeping when needed).

Status legend: `⬜ pending · 🟡 in progress · 🟢 done · 🔵 blocked · ⚪ deferred`.

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

---

*See `ARCHITECTURE-NOTES.md` for the discovery findings that back this plan.*
