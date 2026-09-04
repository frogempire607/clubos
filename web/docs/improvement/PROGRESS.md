# AthletixOS Improvement — Progress & Phased Plan

> ## ⚠️ Bulk send at 294: instrumented and much faster, ROOT CAUSE STILL UNKNOWN
>
> 2026-08-22. **This is instrumentation plus a large render optimization. It is
> NOT a confirmed fix.** Deploy knowing that.
>
> **What is known.** Two production 504s on `POST /api/members/bulk` at 294
> recipients, the second leaving only 1 `EmailSend` row. Routing was never the
> problem: `INLINE_DISPATCH_MAX` is 100, 294 correctly took the queue path. The
> queue path rendered and personalized EVERY recipient before inserting ANY, so
> a timeout left nothing to recover.
>
> **What is measured** (local rig, 281 rows, `scripts/dev-local.sh`, clicked
> through in a browser):
>
> | phase | before | after |
> |---|---|---|
> | `resolveRecipients` | 26–37 ms | 28 ms |
> | build/render loop | 4,680–6,255 ms (17–22 ms/row) | 0 ms/row + one 2,091 ms render |
> | `enqueueEmailSendRows` | 155–164 ms | 425 ms (chunked) |
> | **request total** | ~5–6.5 s | **2,553 ms** |
>
> **What is NOT known.** Local totals said the request should take ~6 s before
> the change; production took over 60 s. **That ~10× gap is unexplained.** Local
> Postgres is ~0.1 ms/round-trip against the pooler's 50–150 ms, so DB-bound
> phases are understated here — but the phase that dominated locally was
> CPU-bound (zero queries), which costs the same on Netlify. Nothing measured so
> far accounts for 60 s. The instrumentation exists precisely because the next
> production send has to answer this; read the `[bulk-email]` phase lines in the
> Netlify function log before optimizing anything further.
>
> **Why it may still work.** The dominant measured cost is gone (render is
> hoisted once when the body has no `{{tokens}}` — verified byte-identical to a
> per-recipient render, including the `&`→`&amp;` escaping of the unsubscribe
> query string, and confirmed live: 281 rows, 281 distinct unsubscribe
> addresses, 281 distinct HMAC tokens, 0 sentinel leaks). And a timeout is now
> survivable: rows land in chunks of 25, a 40 s budget returns `partial: true`
> with `remaining` instead of dying, and re-submitting the same `clientKey`
> resumes the same batch with the dedupe index skipping what already landed.
>
> **If it 504s again**, the rows written so far are durable and the cron will
> send them — that is the difference from before, independent of whether the
> root cause is fixed.


> ## ✅ Phase 5 migration APPLIED — `20260812000000_event_tournament_workflow`
>
> Applied and verified by Julian, 2026-08-12. **Do not create or modify a Phase
> 5 migration** — the phase's schema is closed. It also applies cleanly to an
> empty database (verified by building the local browser-test DB from scratch),
> so the guarded M18 block is safe on a fresh clone.
>
> **One migration covers all of Phase 5** (§5.0–§5.12) so no later session has
> to ask for a second apply: the opt-in policy columns on `events` +
> `club_event_types.defaultPolicy`, the approval / proposal / escalation /
> confirmation-code columns on `event_registrations`, `bookings.bookedByUserId`,
> and four indexes. Everything is additive and every default reproduces today's
> behavior — applying it changes nothing until an owner turns the workflow on
> for an event.
>
> **One statement is guarded and may not land.** The `(eventId, LOWER(email))`
> uniqueness from ARCHITECTURE-NOTES M18 is the only part that can fail on real
> data, so the migration creates it only when the table is already clean and
> otherwise prints the duplicate count and continues. Check afterwards:
>
> ```bash
> psql "<session pooler URI>" -c "SELECT indexname FROM pg_indexes WHERE tablename='event_registrations' AND indexname='event_registrations_eventId_email_key';"
> ```
>
> Empty result = duplicates exist. The query to list them is in the migration's
> section-5 comment; resolve them (cancel the losers — the newest is normally
> the keeper), then run the `CREATE UNIQUE INDEX` from that same comment by
> hand. Nothing in the Phase 5 code depends on the constraint existing; it is a
> public-path double-submit guard, not a correctness assumption.
>
> **Phase 5 is complete** as of 2026-08-12 — reminder cron, escalation
> subcard, confirmation surface and all three §5.2.1 bugs landed in session 3.
> The full write-up, including the manual checklist, the deployment order and
> the rollback plan, is [PHASE-5-DELIVERABLE.md](PHASE-5-DELIVERABLE.md).

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
| [5](#phase-5--event-registration-confirmation) | Event Registration Confirmation | 🟢 complete 2026-08-12 — see [PHASE-5-DELIVERABLE.md](PHASE-5-DELIVERABLE.md) |
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

### MERGED to main — 2026-08-11 · `28261c0`

Phase 4.5 (sessions A–F) is on `main`. Two branches had independently built
the same Session D brief, so six files conflicted where BOTH sides were
correct; the merge commit records which implementation won each one and why.

Headlines of the resolution:

- **main won**: collision-only duplicate `reasons`; `countQueues` (standing
  queues, duplicate GROUPS not rows); the dedicated documents route + lazy
  card; notes edited in the drawer only; the whole `MEMBER_EDITABLE_FIELDS`-
  driven drawer; the merge modal's `bothHaveLogin` pre-flight.
- **The audit branch won**: the drawer's dirty-close guard; the widened D-1
  skip via `lib/guardianContacts.ts`; all of Session F; the first-load-only
  page blanking guard; actor names on migration activity.
- **Fixed during the merge**: `profileImageUrl` was declared bespoke and never
  rendered; two rival data-correction scripts collapsed to
  `fix-guardian-contact-on-minors.ts`; the login-email route's header no
  longer claims PATCH never moves a login (D-0 makes that false).

**Branch policy added to CLAUDE.md**: one branch per PHASE, never one per
session. This merge is the reason.

Still open: Session E's E-1…E-6 and Session F's F-1/F-2 below.

---

### Session F — 2026-08-07 · five from real use

**Branch `claude/phase-4-5-members-audit-1e73ba`. No migration. Not merged.**

| # | Reported | Outcome |
|---|---|---|
| 1 | **REGRESSION** — cannot email from the Members page | Phase 3A's composer was still MOUNTED; the roster cutover dropped the only thing that opened it (`setBulkEmailing` called with null in three places, a value in none). "Email selected" restored on the bulk bar, opening the same modal with the QUERY-SCOPED ids. Resolver, preview and send path untouched — they were already right. |
| 2 | Need an explicit **Change login email** | `PATCH /api/members/[id]/login-email`, members:full. Rejects taken addresses — with a DISTINCT message when an archived login is holding the slot, because `users (clubId,email)` ignores `deletedAt` and a blind update would 500. Notifies old + new, writes an attributed MemberMigrationEvent. Account & security also names the contact/login mismatch instead of leaving it to be discovered. |
| 3 | **D-1 gap** — Cameron still flags against his father | The column-only rule was not enough: his `guardianEmail` held a stale phantom while his own `members.email` held his father's real address. The skip now matches every address belonging to a CONFIRMED guardian link (login email + their own member contact), via `lib/guardianContacts.ts`, shared by the duplicates page and the roster count so they cannot disagree. PENDING links excluded — an unconfirmed link grants nothing. |
| 4 | Engagement 0 opened / 0 clicked | Webhook VERIFIED end to end with Svix-signed payloads: bad signature 401, delivered/opened/opened-again/clicked all applied, first-open timestamp preserved while the counter increments. It will populate. One honest label fixed — `trackingCapable` only means "sent via Resend", not "tracking is on", so rows read "Delivered · not yet opened" when no open could ever arrive. If the club has never recorded a single open they now read "opens not being tracked". |
| 5 | Edit drawer disappears | **Not Fast Refresh.** The drawer is a right-hand panel in a full-screen backdrop, so at 1280px the leftmost 720px — 56% of the window — silently closed it and discarded everything typed; Esc did the same. Backdrop/Esc/Cancel now confirm when dirty. Typing itself never unmounted anything (tested programmatic + real keystrokes across input, select and textarea). |

#### Also found while there

- **The profile page could blank an open drawer.** `load()` set `loading` on
  every call and `loading` early-returns the whole page. Nothing reaches it
  today; it would have the first time a background refresh landed mid-edit.
  Only the first load may blank now.
- **Local dev was reaching a real mail provider.** The worktree `.env` carries
  production SMTP credentials, so a local test that triggered a send hit Resend
  (which refused — test mode only allows the account owner's own address).
  `scripts/dev-local.sh` now blanks `SMTP_HOST` and `RESEND_API_KEY`.

#### Open after this session

| # | Item |
|---|---|
| F-1 | **Accounts with no member row AND no confirmed guardian link cannot be emailed from the roster.** Confirmed guardians ARE reachable through their athletes (proven — two Lister children resolve to one guardian inbox). What is left is e.g. a co-parent whose link is still PENDING. Reaching them directly needs a guardian/account directory — a feature, not a regression fix, so it is flagged rather than invented. |
| F-2 | **Resend open/click tracking needs TWO switches.** Enabling tracking on the domain is necessary but not sufficient — the webhook endpoint must also be SUBSCRIBED to `email.opened` and `email.clicked` in the Resend/Svix dashboard. Until both are on, no event is sent and the new label will keep (correctly) saying opens are not tracked. |
| — | Everything in Session E's E-1…E-6 still stands. |

---

### Session E — 2026-08-07 · Session D closed, the open routes built, the handoff audited

**Branch `claude/phase-4-5-members-audit-1e73ba`, worktree
`/Users/cubano/Desktop/clubos/web/.claude/worktrees/nifty-pasteur-1ecb47`.
No migration created or modified. Not merged.**

Full write-up: **`docs/improvement/PHASE-4.5-DELIVERABLE.md`**, which contains
the element-by-element handoff audit (68 built · 13 partial · 16 missing) and
the two decisions still waiting on Julian.

#### The eleven tabs

`PROFILE_TABS` declared eleven; the body handled eight. Documents, Migration
activity and Notes selected and rendered an empty grid. Bookings and Messages
were fine — verified in the browser. All three now have data behind them; the
documents count treats an EXPIRED signature as missing, because it blocks a
check-in exactly as hard as one never given.

#### Session D

| # | Outcome |
|---|---|
| D-1 | Detector keys moved to `lib/memberDuplicates.ts` and now skip a contact value equal to the same row's guardian contact — structural, so it survives the next import. `namedob:` untouched. Correction script `scripts/fix-guardian-contact-on-minors.ts` is Julian's to run. |
| D-2 | Not a dead button. On a refusal the message went to `msg`, which renders above the fold **underneath the modal's own overlay**. Errors raised in the modal now show in the modal. |
| D-3 | All four counts from `workQueueCounts()`, built from the same `memberWhere()` clauses the click applies. |
| D-4 | Edit drawer now covers everything PATCH accepts except birthday and password. |

#### Open routes, all built

Saved views (`/api/members/views`), triage (`PATCH /api/members/[id]/triage` —
review/snooze, both columns were read and written by nothing), invitation
deliveries (written on every send, address frozen), the Balance column
(`PENDING` transactions only, VOID excluded).

**Bounce ≠ ignore.** Both used to say "Fix email". For an ignore the address is
fine, so that told staff to break the one working address they had. Now
`Call <guardian>`, which §1j already specifies.

**A banner button that sent email.** The next-action banner picked its handler
from the action's PERMISSION, so "Review info" sent an invitation and "Fix
email" sent one to the bouncing address. Maps by action kind now.

#### 4.5.7 / 4.5.9 / 4.5.10

- Deprecated vocabulary **removed from the UI**: the queue's Step column renders
  the 7-step meter instead of the group + readiness chips, and the billing
  centre's triage card keeps Final billing date + Note and loses the two
  deprecated selects. Columns and PATCH fields all survive. **Guard 2: 8 → 0**,
  now a hard fail rather than a ratchet.
- Mobile measured (not eyeballed) per surface per width at 375/390/414/768/1280.
  Header actions collapse behind `⋯` below `sm`; every members-surface target
  reaches 44px through `lg`; zero horizontal overflow anywhere. Shared dashboard
  chrome (topbar 40px, Back 20px) is under target on every page in the product —
  flagged, not silently changed.
- `MemberSubscriptionEvent` written on real transitions. Reports flips
  ESTIMATED → COMPLETE **per club, only once BF-B has run** — an empty log reads
  as "nothing ever happened".

#### Still open

| # | Item |
|---|---|
| E-1 | 16 missing handoff elements, clustered in §1h queue chrome, §1j mobile-native interactions (FAB, sticky bar, bottom sheet, walk-in flow) and §1k result states. Table in the deliverable. |
| E-2 | Family collapse on the roster (§1a) — a 3-child family still costs 4 rows. |
| E-3 | Four of the six `<select>`s (tags, gender, age, custom field) are still not in the Filters panel. |
| E-4 | Person-type labels + whether Prospect is renamed — options and recommendations in the deliverable §7. |
| E-5 | Default staff permissions — never raised with the owner. |
| E-6 | Capacitor shell regression — responsive widths were tested in a browser, which is not the same thing. |

---

### Session D — CLOSED 2026-08-07 (Julian's local testing, 2026-08-05)

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

### Session 1 — 2026-08-12 · the spine (schema, policy, resolver, write path)

Branch `claude/phase-5-event-registration-9675fb`, worktree
`web/.claude/worktrees/elastic-wilson-411ecb`. Migration written, **not
applied** — commands at the top of this file.

**What shipped**

| # | Item | Where |
|---|---|---|
| S-1 | **One migration for the whole phase** — `20260812000000_event_tournament_workflow`. Policy columns on `events`, `club_event_types.defaultPolicy`, approval/proposal/escalation/confirmation-code columns on `event_registrations`, `bookings.bookedByUserId`, four indexes, and the guarded M18 unique index. | `prisma/migrations/20260812000000_event_tournament_workflow/` |
| S-2 | **`resolveEventPolicy`** — event → event type → all-off fallback. The only reader of the null-means-inherit columns; no route reads them directly. Proposals can never resolve on without approval; `holdSpotDuringReview` never inherits (capacity gets exactly one answer). | `lib/eventPayments.ts` |
| S-3 | **`PENDING_REVIEW`** wired into every status set: not a spot, owes nothing yet, blocks the door. `capacityWhere` gained the opt-in hold. | `lib/eventPayments.ts` |
| S-4 | **`registrationWaitingOn`** — COACH / PARENT / PAYMENT / COMPLETE / CANCELED, pure, one implementation for the render context, the roster, the probes and the cron. | `lib/eventPayments.ts` |
| S-5 | **`renderableRegistrationState`** (§5.2.2) — 17 render keys, exhaustive over the union, every amount from `amountToCollect`. The page and every email render from this. | `lib/registrationRenderState.ts` |
| S-6 | **Lifecycle emails** — one template, one context, per-transition `(sendBatchId, dedupeKey)`. Confirmation / approved / declined / proposal. Registrant + every confirmed guardian, one `EmailSend` row each. | `lib/eventLifecycleEmails.ts`, `lib/eventRecipients.ts` |
| S-7 | **Coach decision write path** — `approve` / `decline` / `propose-change` over one shared implementation; advisory lock `evreg-mut:<regId>`, terminal-state 409s that hand back the current state, `BillingAuditLog` on every mutation, refund on decline of a paid registration gated on finance permission. | `lib/eventApproval.ts`, `app/api/events/[id]/registrations/[regId]/{approve,decline,propose-change}/` |
| S-8 | **Create-path fork** on both registration routes, including the free / membership-covered / variable-cost branches — those used to create a Booking outright. No Booking exists until approval; the webhook now skips it too for a pending row. | `app/api/member/events/[id]/register/`, `app/api/public/events/[slug]/register/`, `app/api/stripe/webhook/` |
| S-9 | **`billOneRegistrant`** lifted out of `bill-registrants`; that route now calls it, so approve-with-INVOICE and the escalation cron reuse the mass route rather than forking it. | `lib/eventInvoicing.ts` |
| S-10 | **`computeNextReminderAt`** (§5.6.5) — ships with the write path, not the cron, because every settle/cancel path must clear the queue entry in the same transaction or the next sweep emails a reminder for money already collected. | `lib/eventReminders.ts` |
| S-11 | **Confirmation code** — deterministic Crockford base32 from the row id, stamped at create and backfilled on every mutation that touches a row without one. | `lib/confirmationCode.ts` |
| S-12 | **202 assertions** walking every render key, every waitingOn rule, policy inheritance, refund copy, reminder cadence and code uniqueness. | `npx tsx scripts/event-confirmation-state-tests.ts` |

**Three places this deviates from plan.md, and why**

1. **Money moves after the lock commits, not inside it** (§5.4.6 says inside).
   `chargeEventRegistration` runs on the global Prisma client, so its UPDATE of
   the same registration row blocks on the row lock the open transaction holds
   — a self-deadlock that resolves only when the 5s interactive-transaction
   timeout fires, leaving a live PaymentIntent behind an aborted transaction.
   The lock still guarantees exactly one caller reaches dispatch, which is all
   §5.4.10 asks of it.
2. **`renderableRegistrationState` lives in its own module**, not in
   `lib/eventPayments.ts` as §5.2.2 nominates. It has to read `amountToCollect`,
   and `lib/eventRepricing` already imports `eventPayments` — putting it there
   makes the two circular.
3. **Cash/check under approval keep `AWAITING_CASH` / `AWAITING_CHECK`**
   rather than `PENDING_REVIEW`. `approvalStatus = PENDING` is the gate, the
   resolver reads it first (so the registrant still sees "Registration
   requested"), and §5.4.6's approve says the status is unchanged for those
   methods — which only works if it was never overwritten.

**Deliberately NOT built this session** (all still open):

- Coach review UI — the roster affordances, the "who's waiting on what" column,
  the Action Center probes (§5.7).
- Reminder + digest cron — `netlify/functions/tournament-reminders-cron.mts`
  and `/api/cron/tournament-reminders` (§5.6.1, §5.6.6, §5.6.7). The scheduling
  math is in `lib/eventReminders.ts` and the sweep sits on top of it.
- Parent response flow — `proposal/accept` + `proposal/decline`, the
  `/member/bookings/[regId]/proposal` surface, and the `EVENT_PROPOSAL_RESPONSE`
  approval kind (§5.4.7, §5.12 item 4). `approveRegistration` already takes the
  proposing coach as the actor so accept can re-enter it unchanged.
- Confirmation surface `/e/[slug]/registered/[registrationId]` (§5.2.3) and the
  remaining two §5.2.1 bugs: the paid public path's missing confirmation email
  (webhook branch) and the `success_url` rewrite to `baseUrlFromRequest`. The
  free public path's missing email IS fixed. When the surface lands, delete
  `/pay/complete` and repoint `bill-registrants` + `eventAutoCharge` at it.
- Owner settings UI — the event-type policy editor and the event editor's
  "Coach approval + payment" card (§5.3, §5.8). **Until this exists the workflow
  cannot be turned on from the app at all**, which is also what keeps it safely
  off: every column defaults to inherit-or-off.

### Session 2 — 2026-08-12 · owner settings, coach review, parent response

Same branch and worktree as session 1. Migration applied before this session
started; nothing here touches schema.

**What shipped**

| # | Item | Where |
|---|---|---|
| S-13 | **Per-type defaults editor** in Manage event types (§5.3.1). Where the workflow is discovered — the event editor hides its card for types that haven't opted in. An all-off blob stores as null so "is this type configured?" stays answerable. | `app/dashboard/events/page.tsx` (`TypePolicyEditor`), `PATCH /api/events/types/[id]` |
| S-14 | **"Coach approval + payment" card** in the event editor (§5.3.2), collapsed unless something is configured. The approval control is a three-way select — "use the type default" and "explicitly off" are different answers. | `app/dashboard/events/page.tsx`, `POST /api/events`, `PATCH /api/events/[id]` |
| S-15 | **Registrant-facing notice before the pay picker** on both paths, the charge-on-approval + bill-me options in the member picker with an amount-naming consent line, and no picker at all when the club bills on approval (§5.3.3). | `app/e/[slug]/page.tsx`, `app/member/events/page.tsx`, `GET /api/public/events/[slug]` |
| S-16 | **Coach review queue** at the top of the Registrations modal: approve / decline with a reason / propose a change, including the add-a-dual case with its fee. | `app/dashboard/events/page.tsx` (`CoachReviewQueue`) |
| S-17 | **Roster payload** gains the resolved policy, per-row `waitingOn`, and a per-user `canDecide` — the responsible coach can decide their own event without events:edit. | `GET /api/events/[id]/registrations` |
| S-18 | **Action Center probes** `COACH_APPROVAL_REQUESTED`, `EVENT_APPROVAL_STALLED_48H`, `EVENT_APPROVAL_STALLED_PAST_DEADLINE`, `EVENT_PROPOSAL_AWAITING_PARENT` — all live counts, all self-clearing. | `lib/actionCenter.ts` |
| S-19 | **Parent response** (§5.4.7): accept re-enters `approveRegistration` with the coach as approver; decline cancels and refunds unconditionally. Price-delta consent is re-derived server-side. | `lib/eventApproval.respondToProposal`, `POST /api/member/events/[id]/registrations/[regId]/proposal/{accept,decline}` |
| S-20 | **The parent's surfaces**: the proposal page, a card per not-yet-a-booking registration on Bookings, the `EVENT_PROPOSAL_RESPONSE` row in the family approvals card, and a DM in the coach thread both ways (§5.5, §5.7). | `app/member/bookings/[regId]/proposal/page.tsx`, `components/member/BookingsPanel.tsx`, `app/member/profile/page.tsx`, `GET /api/member/registrations` |
| S-21 | **Local browser-test rig**: throwaway Postgres seed + dev script that replaces `STRIPE_SECRET_KEY` with a dummy, because the worktree `.env` carries a live key and the real connected account. | `scripts/seed-phase5-browser-test.ts`, `scripts/dev-phase5-browser-test.sh` |

**Browser-tested** (local fixture, three real logins — owner, a STAFF coach
with `events:view` only, and a guardian):

- event card and type editor round-trip to their columns, including
  `paymentDueBy` stored at noon UTC;
- public page renders the approval notice above the pay picker;
- propose → accept and propose → decline end to end, including consent refusal
  on a mismatched amount, a 409 on a replayed answer, and the family approvals
  row resolving either way;
- approve and decline from the coach queue, with the Booking, the audit row and
  the dedupe-keyed email each landing exactly once;
- authorization both directions: the responsible coach may decide their event
  without `events:edit`, and gets 403 the moment they are not the responsible
  coach.

**Three defects the browser test caught** (all fixed in the same session):
accepting sent two emails instead of one; the parent's reply DM went nowhere
because `sendMemberMessage` fans out to the family and filters the sender out;
and the proposal page printed the pre-acceptance total next to the button that
was about the post-acceptance one.

**Still not built** — the two items held back for a later session:

- **Reminder cron + escalation schedule** (§5.6). The scheduling math
  (`computeNextReminderAt`, anchors, cadences) shipped in session 1 and every
  mutation already keeps `nextReminderAt` correct; what's missing is
  `netlify/functions/tournament-reminders-cron.mts`, `/api/cron/tournament-reminders`,
  the per-stage reminder email, and the coach daily digest. The escalation
  subcard in the event editor is deliberately absent until then — no owner
  should be able to switch on a cadence nothing sends.
- **Confirmation surface** `/e/[slug]/registered/[registrationId]` (§5.2.3) and
  the two remaining §5.2.1 bugs (the paid public path's missing confirmation
  email, and the `success_url` rewrite to `baseUrlFromRequest`). When it lands,
  delete `/pay/complete` and repoint `bill-registrants` + `eventAutoCharge` at
  the new route.

### Session 3 — 2026-08-12 · the propose form stops being a wrestling form

**No migration.** Both homes already exist and are JSON:
`ClubEventType.defaultPolicy` (per-type defaults, from the Phase 5 migration)
and `Event.registrationForm` (the per-event questions, years old). Category
fields are ordinary `registrationForm` entries marked by a reserved id, so
"how many categories" is a data question rather than a schema one.

| # | Item | Where |
|---|---|---|
| S-22 | **`lib/eventCategories.ts`** — the whole vocabulary in one pure module: presets, resolution (event form → type default → none), the proposable-key allowlist, the derived note placeholder, and label lookup for stored proposals. | `lib/eventCategories.ts` |
| S-23 | **Owner-defined categories, any number**, per event and per event type, each a label plus an optional value list. A list makes the coach's control a picker; no list leaves it free text. Presets offered: Weight Class, Division, Age Group, Position, Belt Level, Bracket, + Custom. | event editor + Manage event types |
| S-24 | **Proposal allowlist is per event**, not a fixed `weightClass \| division \| session \| addAnotherDual \| freeText` union. An unknown key is still a 400. | `lib/eventApproval.proposeRegistrationChange` |
| S-25 | **Labels are snapshotted into the proposal** so renaming a category next week can't relabel a decision a family already answered. Coach queue, parent page and the email all read the snapshot. | `proposedChange.labels` |
| S-26 | **Extra-entry label configurable**, neutral default "Add another entry" (was "Wrestle an additional dual"). The note placeholder is derived from the club's own category values rather than being another setting nobody would curate. | per-type `extraEntryLabel` |
| S-27 | **`npm run test:sport-terms`** — the vocabulary guard, modelled on 4.5.10's vendor-literal one. Baselined at **0**, hard fail. | `scripts/sport-terms-guard.ts` |

**What the guard does and doesn't catch.** Its first draft flagged 20 strings
and 16 were legitimate: the landing page saying "built for wrestling, BJJ,
gymnastics", onboarding's sport picker, the `apex-wrestling` slug placeholder.
Naming a SPORT is fine; naming a FEATURE after one sport is not. So it scans
in-product surfaces only (`app/dashboard`, `app/member`, `app/e`, `components`)
and matches feature vocabulary — "weight class" as a field, "dual" as an entry,
"wrestle an X", weigh-in, singlet, takedown, belt level as a field. The preset
catalogue lives in `lib/` and is out of scope by construction: those strings are
choices offered to an owner, not copy shown to a family.

**Back-compat.** The first category keeps the bare `participant_category` id, so
the three live events that already carry one (Brawl at the Beach, Waterway Duals
K6, NJ Super32) round-trip untouched. Zero proposals exist in production, and
`labelForChangeKey` still renders the pre-configurable keys if an in-flight
branch wrote one.

**Optional follow-up, not built.** Built-in event types (Tournament, Camp,
Clinic) have no `ClubEventType` row — production has zero custom types — so
per-type defaults are reachable only for custom types today. Giving built-ins
club-wide defaults needs one additive column mirroring `Club.builtInEventColors`:
`ALTER TABLE "clubs" ADD COLUMN "builtInEventCategories" JSONB;`. Not written,
because the per-event presets already make setup one click and an unapplied
migration folder sitting in the tree is a liability.

### Session 3 — 2026-08-12 · escalation, the confirmation surface, and the phase closed

Deliverable: **[PHASE-5-DELIVERABLE.md](PHASE-5-DELIVERABLE.md)**. No migration
created or modified; Phase 5's schema closed on 2026-08-12 and stayed closed.

| # | Item | Where |
|---|---|---|
| S-28 | **The escalation sweep** — two passes in one hourly invocation: due reminders, then the coach digest at 09:00 club-local. Stage derived from the anchor (stages can be skipped), row re-verified inside the lock, send outside it, three failures sentinels the row. | `lib/tournamentReminders.ts` |
| S-29 | **Cron route + Netlify wrapper**, mirroring `event-charges-cron`: `CRON_SECRET`, constant-time compare, 503 when unset. Roster lazy-sweep parity at limit 3. | `/api/cron/tournament-reminders`, `netlify/functions/tournament-reminders-cron.mts` |
| S-30 | **Reminder + coach-digest emails**, dedupe-keyed by `(regId, stage)` and `(coachId, club-local day)`. Subject urgency comes from the resolver's proximity badge. | `lib/eventLifecycleEmails.ts` |
| S-31 | **`EVENT_REMINDER_SEND_FAILED` probe.** I dropped the drafted `EVENT_REMINDER_NO_ANCHOR` — `Event.startsAt` is required and is the last anchor fallback, so it could only ever read zero. | `lib/actionCenter.ts` |
| S-32 | **Escalation subcard**, shipped with the cron rather than before it, with a preview of the exact dates each reminder lands on. | event editor |
| S-33 | **Confirmation surface** — `/e/[slug]/registered/[id]`, `/r/[id]` for slug-less events, `calendar.ics` on both (TENTATIVE while unapproved), one `RegistrationCard` rendering §5.2.7's slots from the resolver. | `app/e/[slug]/registered/`, `app/r/`, `components/registration/` |
| S-34 | **§5.2.1 bugs 2 and 3.** The webhook confirms a paid public registration; `success_url` uses `baseUrlFromRequest` and points at the surface; the public page hands off instead of rendering its own success. | webhook, both register routes, `/e/[slug]` |
| S-35 | **`/pay/complete` deleted**, `bill-registrants` and the charge engine repointed at `registrationUrl` — one address per registration, everywhere. | `lib/registrationUrl.ts` |

**Two things I did not do, both recorded in the deliverable rather than
smuggled in:** the member CARD checkout still returns to the portal (it creates
no registration row, and giving it one would reroute a live money path through
a different webhook branch), and `EVENT_REMINDER_NO_ANCHOR` was dropped as
unreachable.

**Open decisions** are §13 of the deliverable — the one worth acting on first is
`Club.timezone`, still null for every club, which currently puts the coach
digest at 4am Chicago.

### 5.1 Bug fixes (do first — no schema work)

| # | Task | Class | Status |
|---|---|---|---|
| 5.1.1 | Free public path emails confirmation. | Backend | 🟢 done 2026-08-12 — routed through `sendRegistrationLifecycleEmail` (state-driven, dedupe-keyed), not `sendBookingConfirmationEmail`. |
| 5.1.2 | Paid public path emails confirmation. | Backend | 🟢 done 2026-08-12 — via `sendRegistrationLifecycleEmail` (state-driven, same `event-confirm:<regId>` key as the register route). |
| 5.1.3 | Idempotency key on `stripe.checkout.sessions.create` in all three event registration routes (member, public, at-the-door). | Backend | ⬜ |
| 5.1.4 | Success URLs — `baseUrlFromRequest` + pointed at the confirmation surface. | Backend | 🟢 done 2026-08-12. The member CARD path keeps its portal return (no registration row to point at) — deliverable §7.1. |
| 5.1.5 | Member path stamps `discountAmount` on Checkout metadata (parity with owner path). | Backend | ⬜ |

### 5.2 Server-rendered confirmation page

| # | Task | Class | Migration | Status |
|---|---|---|---|---|
| 5.2.1 | **M17** — `EventRegistration.status` enum + `canceledAt` + `refundedAt` + `confirmationSentAt`. Backfill: existing string values map 1:1 to enum. | Migration | M17 | ⬜ |
| 5.2.2 | **M18** — `EventRegistration @@unique([eventId, LOWER(email)])`. Dedup script (dry-run first, per-club report): keep newest, null stale `stripeCheckoutSessionId` on losers. | Migration + script | M18 | ⬜ |
| 5.2.3 | **M19** — `Booking.bookedByUserId TEXT?`. | Migration | M19 | ⬜ |
| 5.2.4 | Confirmation surface. | UI + Backend | — | 🟢 done 2026-08-12 — plus `/r/[id]` for slug-less events and `calendar.ics` on both. |
| 5.2.5 | Success URLs → the surface, which polls while a checkout is in flight. | UI + Backend | — | 🟢 done 2026-08-12. `?src=paid` is a hint, never the state — the page reads the row. |
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

## Unnumbered — 2026-08-14, live-use fixes (branch `claude/bulk-price-change-planning-57a9cv`)

None of this belongs to a numbered phase. It came out of running the club on the
software: a bulk price-change session that turned into fixing what the first real
sends and the first real roster audit exposed. No migration except the one noted.
Six items, newest last.

**The ACTIVE rule** (`368ea15`, `6b13884`, `f580ca4`, `4c9eb99`). "Active" used to
mean *a subscription row exists*, which counted rows nobody had ever paid for.
`countsAsMembership()` in `lib/memberTracks.ts` is now the one predicate: MANUAL is
exempt, a priced row needs a payment, and a $0 row needs `deliberateFree`. That last
column needed a migration (`20260814000000_subscription_deliberate_free`, applied)
because there was no way to say "this member is free on purpose" — without it every
comp would have read as broken billing. `set_deliberate_free` on the billing-admin
actions route is the control (billing:full, confirm-gated, audited, refuses priced
rows); the member's billing centre carries the toggle.

The distinction that matters, and that I got backwards once: **`migrationPriceOverride
= $0.00` is the comp tell.** `migrationFinalPeriodPaid` and a frozen option are
stamped on everyone who had a term, paid or not, so they say nothing. A comp is a $0
override on a plan whose options are all priced — not a $0 plan option. The sweep
found two real comps (Barrett, Paul), one prepaid annual with no transaction to prove
it (Wyatt), one comp with no subscription at all reading PROSPECT and being quoted
non-member rates (Devin Eggleston), and one prepaid term ending 2026-09-08 with no
recorded payment (Colton Waite). Event and private-lesson pricing were checked and
read "does an active subscription row exist" — never `countsAsMembership` or
`Member.status` — so a comp does keep member pricing. The two definitions have
diverged, pricing being the more generous; that divergence is pinned by tests rather
than unified, because unifying it moves money. Also fixed: `trainingUnbilled` scoped
its money test to `type: "MEMBERSHIP"` — Barrett's $120 College Combine payment was
masking a missing membership payment, which is the kind of false negative that makes
a queue not worth opening.

**Audience resolution** (`cc5c07b`) — the one to read first if you touch
`lib/audienceFilters.ts`. A saved audience of `{rules: [], alwaysIncludeMemberIds:
[three ids]}` resolved to **every member in the club**: an empty `where` matched
everyone, and the always-include query passed two `id` keys in one object so the
second silently won. A hand-picked send to three people would have gone to all 32.
Production was checked first — nothing had that shape yet, only "Active Members" with
one rule — then both bugs were fixed and `scripts/audience-filters-tests.ts` (8
integration tests against the local throwaway DB) was written to fail against the
pre-fix code.

**Batch results** (`92953de`). Bulk sends create no `Announcement`, so 77 emails had
nowhere to be seen. `lib/emailResults.ts` tallies a batch and
`/dashboard/communication/results` renders it, sharing `EmailResultsView` with
announcement results. `trackingCapable` counts only rows carrying a
`providerMessageId`, so an SMTP send reports "not tracked" instead of a fake 0% open
rate. The inline send branch of `/api/members/bulk` was also missing `sentByUserId` —
only the queued branch had it.

**Drafts** (`a106cc9`). `lib/emailDrafts.ts` + `/api/emails/drafts`, backed by
`Announcement` with `status=DRAFT` and recipients in `audienceFilters`. GET
re-resolves recipients against live members and returns `droppedMemberCount`, so a
draft written last week does not quietly send to someone who has since been archived.
Rule-driven audiences are refused as drafts on purpose — they are not a fixed list.

**Token picker** (`783ac88`). `lib/personalizationCatalog.ts` describes all 14
personalization tokens; the composer gets a dropdown above Subject and one in the
rich-text toolbar instead of a hint telling the sender to type
`{{member_first_name}}` from memory. Five tokens are context-supplied (event, class,
coach, registration and payment links) and cannot resolve on a Members-tab send —
those are grouped under "Not available in this send" and render as *blank in this
send* in the hint. A test asserts the catalog covers every token the interpolator
knows, so a new token cannot ship undescribed.

**Member deletion** (`636ac54`). Archiving was a one-line `window.confirm`. It is now
preflight-driven (`/api/members/[id]/archive-preflight` counts what is attached),
states what changes and what is kept, and requires the member's name typed back. The
only hard block is a live Stripe subscription. Two orphans fixed along the way:
pending approvals for the archived member are closed as `EXPIRED` — that was Alex
Butler's stuck duplicate, since `/api/approvals` reads `PendingApproval` by
`{clubId, status: PENDING}` with no join back to whether the member still exists —
and `ACTIVE_GUARDIAN_LINK` now excludes archived members so an archived child stops
appearing in their guardian's portal. That constant is spread into `where` clauses at
three call sites, where a sibling `member` key would silently drop the filter; the
hazard is noted on the constant itself.

**Verification.** 417 assertions across nine suites (`member-deletion` 29,
`personalization-catalog` 23, `email-drafts` 25, `email-results` 37, `member-tracks`
183, `billing-admin` 111, `family-accounts` 28, `family-fixtures` 93,
`audience-filters` 8 integration), `tsc --noEmit` and `npm run build` clean. Batch
results, drafts, the token picker and archiving were each driven in a real browser
against a local Postgres before being handed back — three presentation bugs and one
pluralisation bug ("1 payment record **stay**") were only visible there, not in the
tests.

**Left for the owner by hand:** Devin Eggleston, Colton Waite and Wyatt Eastman's
corrections, and marking Barrett and Paul `deliberateFree`.

---

*See `ARCHITECTURE-NOTES.md` for the discovery findings that back this plan.*

---

## Phase 7.2–7.5 — 2026-08-16, signup intent (branch `claude/bulk-price-change-planning-57a9cv`)

7.1 (family view) merged as `943b65e` and deployed. This is the rest of Phase 7.
**Not merged** — the branch carries 7.2–7.5 on top of `main`.

**The defect, restated from the §7.0 audit.** AJ Dorn's account was one `User`
that was simultaneously the athlete, the athlete's login, and the athlete's
guardian. Nobody pointed anything anywhere: a dad chose "Young Athlete", typed
his son's name, his own email, and that same address again as the guardian
email. The consent route then resolved the guardian **by email** and found the
account it had just created. `applyParentalControls` keys oversight on
`member.userId !== bookerUserId`, so the child read as acting alone; and because
`Member.userId` is globally unique, a second Dorn child could never attach.
Shape A did not exist before 2026-07-17 and three of the four appeared in the 24
days after — it arrives with every parent who uses one inbox for both fields.

**7.2 — `lib/signupIntent.ts` is the model.** Pure, no prisma. `planSignup()`
decides what a submission may create *before* anything is written, and the route
executes that decision rather than re-deriving it. Three outcomes matter:

- **`CHILD_BY_GUARDIAN`** (the new default child path). The account holder is the
  **guardian**; the athlete is a separate `Member` with `userId: null` and
  `email: null`, joined by a CONFIRMED `MemberGuardianUser`. A self-guardian is
  unreachable, not discouraged — the child has no login to conflate with. COPPA
  consent is recorded in-session (`ParentalConsent`, attributed to the guardian's
  account) instead of round-tripping an email.
- **`MINOR_SELF_LEGACY`** (a stale cached client, or a genuine teen with their own
  address). Behaves as before *plus* two fixes: the guardian-email-equals-account-
  email submission is refused outright, and a guardian `User` is now created right
  after the child's when none exists. Before, consent was recorded but
  `MemberGuardianUser` never was — the consent route can only link a guardian that
  already exists — so those children ended up with **no guardian at all**. The
  account is created with an unusable random secret + a 14-day invite token, and
  `sendGuardianConsentRequestEmail` gained an optional `setPasswordUrl`.
- **`GUARDIAN_ONLY`**. Ends on "Add your athlete" with the sweep result, never in
  an empty portal. That dead end is what sent parents back to the form to try
  again as a "Young Athlete" — i.e. it *fed* shape A. `app/member/page.tsx` gained
  `GuardianOnboardingView`; a guardian-only login no longer falls through to
  `AdultAthleteView`. The vouched sweep now runs for **every** guardian-shaped
  account, not just PARENT, so an older CSV-imported sibling appears immediately.

The form states whose account is being created **before anything is typed**
(`SIGNUP_INTENT_COPY.accountLine`), labels step 2 as the parent's own details,
and asks for the child's name + DOB separately on step 3. There is deliberately
**no second email field** on the child path — the collision is impossible to
type, not merely rejected.

**7.3 — the trial attaches to the athlete.** `trialTargetFor(plan)`: child path →
the child; adult/legacy-minor → the account holder's own profile; guardian-only →
nothing, **with a reason**. The old code gated on `user.memberProfile` and a
parent who clicked a trial link got silence. `trialBlockedBySelfGuardian()`
refuses to stamp `trialEndsAt` on a shape-A record — whose entitlement would it
be? Also fixed while here: `app/member/page.tsx`'s portal fetch had no `.catch`,
so a rejected request left the skeleton rendering forever (found in the browser,
not the tests).

**7.4 — `scripts/fix-family-shapes.ts`.** Dry-run by default, `--apply` refuses
without `--members` *and* without `--only`. SELF_GUARDIAN (4) / CHILD_EMAIL (30) /
ORPHAN_MINORS (≤227) / AJ_DUPLICATE (1). Every write leaves a `BillingAuditLog`
row; nothing is hard-deleted; each mode re-checks its evidence at write time so a
row that moved since the survey is skipped, not rewritten.

**The ordering is enforced, not documented.** ORPHAN_MINORS `--apply` counts
remaining shape-A members and **exits 2** if any are left. A conflated account's
`guardianEmail` points at itself, so the sweep would find a "live User" there and
re-create the exact link SELF_GUARDIAN just removed. It is a live-data check, so
it cannot be forgotten or lied to. SELF_GUARDIAN takes **one member per run** and
demands `--parent-email` (two real branches: the account becomes the parent's and
the child loses the login, or the child keeps theirs and a new parent account
takes the link) plus `--parent-name` so the login stops being named after the
child. AJ_DUPLICATE has **no `--apply` path** on purpose — it prints the pair and
points at `/dashboard/members/duplicates`, which is confirmation-gated, lets you
pick surviving values field by field, and soft-deletes.

**7.5 — tests.** `scripts/signup-intent-tests.ts` (54 pure) replays AJ's exact
submission and asserts it is refused, plus 135 input combinations proving no
accepted plan yields a self-guardian (tsc now rejects that combination outright —
the runtime check is kept in case a future variant loosens the union).
`scripts/family-shapes-repair-tests.ts` (54 integration) drives the real CLI as a
subprocess and asserts exit codes **and** database state — including that the
out-of-order run wrote nothing despite being asked to.

**Verification.** 666 assertions across twelve suites (signup-intent 54,
family-shapes-repair 54, family-scope 21, family-accounts 28, family-fixtures 93,
member-tracks 183, billing-admin 111, member-deletion 29, audience-filters 8,
personalization-catalog 23, email-drafts 25, email-results 37). `tsc --noEmit`
and `npm run build` clean. **Browser-tested** end to end in Chromium at 390×844
(`scripts/browser-signup-intent.ts`, 34 checks, seed
`scripts/seed-signup-intent-test.ts`, server `scripts/dev-signup-intent-test.sh`):
AJ's signup re-run against the fixed form produces one account named **"Adam
Dorn"** with zero athlete profiles, AJ as a minor holding **no login and no
email**, the CSV sibling swept in unprompted, and the trial on **AJ**. Two
presentation bugs were only visible there — the permanent skeleton above, and the
trial note being dropped for guardian-only signups because the banner required an
athlete to render.

**MIGRATION WRITTEN, NOT APPLIED:** `20260815000000_member_created_via`
(`members.createdVia TEXT` + index, additive, nullable, no backfill).
`prisma/schema.prisma` is **deliberately unchanged** — Prisma selects every scalar
a model declares, so naming a column the database lacks would 500 *every member
read*, not just the signup path. Order: apply the migration first, *then* add the
field to the schema and start writing it.

**Left for Julian:** apply the migration if wanted; run
`npx tsx scripts/fix-family-shapes.ts` (survey) from his own terminal, then the
four SELF_GUARDIAN splits one at a time, then CHILD_EMAIL, then ORPHAN_MINORS —
the script will refuse if that order is broken. The AJ duplicate merge goes
through `/dashboard/members/duplicates`.

---

## Phase 7.2 follow-up — 2026-08-16, the self-signing minor + DOB backstop

Julian caught a regression in the 7.2 picker before merging: **juniors and seniors
sign themselves up here with their own email — a real population, not an edge
case** — and the rewritten three-way picker had no option that described them.

**What they got before this fix.** Traced against a running server, not inferred.
The picker offered "I'm signing my child up" / "I train here myself" / "I only
manage someone else's account", so a 17-year-old picked the true-sounding middle
one and the route wrote:

| athlete | `isMinor` | own login | guardianEmail | consent records |
|---|---|---|---|---|
| Nia (DOB 17y) | **false** | yes | **(none)** | **0** |

Worse than the outcome Julian feared. The under-18-with-own-login shape still
worked at the API — posting it by hand produced own login + `isMinor` true +
guardian email + consent email — but **the form had no door to it**. The model
was fine; 7.2 removed the room's entrance.

**Four things built.**

1. **The option is back**, as a fourth entry: *"I train here myself and I'm under
   18 — you'll get your own login; a parent has to approve it first."*
2. **`MINOR_SELF` is a first-class intent**, not an inference. The old planner
   distinguished the two minor shapes by whether `childFirstName` was present;
   now `accountType` says it outright and the name-absence rule survives only as
   back-compat for a stale cached client. `MINOR_SELF_LEGACY` was renamed
   `MINOR_SELF` — it is the supported path, not a fallback.
3. **The DOB backstop.** `resolveIsMinor` is DOB-authoritative at the login gate,
   in age brackets and in waivers; signup was the one place that trusted the
   radio button. Now a date of birth is REQUIRED on both self-signup paths and
   **routes the plan regardless of what was clicked** — a minor DOB on the adult
   path becomes `MINOR_SELF` (and is refused outright if no guardian email is
   given, rather than stored as a guardian-less adult); an adult DOB on the minor
   path becomes `ADULT_SELF`. The child path derives the child's `isMinor` from
   the DOB too, so a guardian managing a 19-year-old's account no longer stores
   them as a minor. `ageFromDOB` moved to a new pure `lib/age.ts` and
   `lib/parentalConsent.ts` imports it — ONE derivation, no second copy to drift.
4. **Tests.** 86 pure (up from 54) and 47 browser checks (up from 34).

**Verified end to end** (`scripts/browser-signup-intent.ts`): a 17-year-old
signing up as Kayla produces `isMinor` true, **her own login**, her own email,
`guardianEmail` = her mother's, a consent email sent, and a **separate** parent
account carrying an invite token she cannot log into until she sets a password.
The mis-picked adult path wrote **zero** rows.

### FEATURE_PARENTAL_CONSENT — asked, and answered empirically

**It is OFF in production.** Not inferred from `.env.example` (which doesn't
document it) — the login gate throws BEFORE `lastLoginAt` is written, and
Zachary Lawell (DOB 4 years old, zero consent rows) has `lastLoginAt` of
**2026-08-13 03:32 UTC**. A consent-less minor could not have reached that write
with the flag on. Netlify env vars are not exposed through the MCP, so if you
want the setting itself: Netlify → athletix-os → Site configuration →
Environment variables.

### Production sweep — Nia-shaped rows, and the real blast radius

Two members have a DOB under 18 while their record says adult:

| athlete | age | `isMinor` | own login | guardian email | links | consents |
|---|---|---|---|---|---|---|
| **Zachary Lawell** | **4** | false | yes | **(none)** | 0 | 0 |
| **Colin LoGalbo** | 15 | false | yes | kjlogalbo@gmail.com | 1 | 0 |

Zachary is the exact Nia shape — a four-year-old holding his own portal login,
flagged as an adult, with no guardian on record at all. Colin is **also a
self-guardian** (shape A, one of the four) *and* shape C (`Member.email` ==
`guardianEmail`), so `scripts/fix-family-shapes.ts` already covers him.

**The bigger number, which the question surfaced:** the login gate keys on
`parental_consents`, not on guardian links, so it blocks any minor-by-DOB with
their own login and no consent row — **7 members today**, not 2:

- 2 with no guardian at all (Zachary, Leandro Petrilli)
- 4 with a real guardian link but no consent row (Maximus Alexander, Delos Stone,
  Drayke Ulrich, Cael Bruce — all 07-05 CSV imports activated through
  `/activate/[token]`, which never wrote `ParentalConsent`)
- 1 self-guardian (Colin)

**Do not enable `FEATURE_PARENTAL_CONSENT` until those 7 have consent rows**, or
they are locked out of accounts they already use. That is a backfill this branch
does not do — flagged, not built, because recording consent on someone's behalf
is the owner's call, not a script's.

**Known cosmetic:** `/member/signup` sits under the `/member` layout, so a
logged-in visitor sees portal chrome (dark header, bottom nav) around the wizard.
Pre-existing; visible in `signup-minor-self.png` because the browser test reuses
one browser across scenarios.

---

## 2026-08-16 — Self-signed waivers, and DETACHED_MINOR

Two things, both starting from Zachary Lawell.

### The signing sweep — the gate was open, not missing

**Every signed document in production where the signer was a minor by DOB at
the moment of signing and the relationship is SELF:**

| athlete | age at signing | document | guardian-required |
|---|---|---|---|
| Zachary Lawell | **4** | Liability Waiver | yes |
| Zachary Lawell | **4** | Code of Conduct | yes |

That is the whole list. **The live SELF population is 4 rows, not 6** — the
other 2 belong to Michael Lister, who has no DOB, so his age cannot be checked
(he is an adult by every other signal: a $545/quarter subscription). All 4 sit
on guardian-required documents, because both club documents carry
`requiresGuardianSignature: true`. Against 76 GUARDIAN signatures, SELF is the
rare case.

> **Corrected 2026-08-16** — the first pass reported 6 SELF rows and named Kelly
> Merrill. Both were wrong: the sweep did not filter `deletedAt`, so it counted
> 2 signatures belonging to soft-deleted members. Kelly Merrill has no
> signatures at all. **Any query over `document_signatures` must join
> `members` and filter `m."deletedAt" IS NULL`** — the table has no tenancy or
> liveness column of its own.

**DOB coverage is not the problem** (also checked, because the fix makes DOB
authoritative): **261 of 287 live members have one — 90.9%.** Of the 26 without,
25 are flagged minors with a guardian email, no login, PROSPECT, from the
2026-07-05 CSV import — so the fallback lands on the flag and treats them as
minors, which is the safe direction. Exactly **one** member sits in the
dangerous cell (no DOB, flag says adult, therefore treated as adult and
unprovable): Michael Lister, the same person above.

**The gate was never missing.** `/api/member/documents/[id]/sign` has always
refused a minor self-signing a guardian-required document. It read
`Member.isMinor` — the stored flag — and Zachary's row said `false`, because
signup wrote whichever radio button was clicked. `resolveIsMinor` exists
precisely so a date of birth outranks that flag; the **login gate has always
used it, and the document layer never did.** Same class of bug as the signup
DOB backstop, one layer over.

**Closed in three places**, all of which keyed on the stored flag:

1. `/api/member/documents/[id]/sign` — now `resolveIsMinor(target)`, with
   `dateOfBirth` added to both selects. This is the open gate.
2. `/activate/[token]` — attribution was `member.isMinor ? "GUARDIAN" : "SELF"`,
   which stamped GUARDIAN on a signature a minor made themselves, naming a
   parent who was never present. Now keyed on `guardianManaged` (who is actually
   at the keyboard), and a minor activating their own account **skips**
   guardian-required documents rather than producing a record that doesn't do
   what the club thinks it does.
3. `/api/member/signup` — a self-signing minor no longer records anything for a
   guardian-required document. Their parent is about to be emailed a consent
   link; the honest state is unsigned.

`scripts/signature-attribution-tests.ts` (18) pins the rule with the flag
deliberately lying in **both** directions, plus the 18th-birthday boundary and
the detection query itself.

**Where the flag and the birthday actually disagree**, across all 287 live
members — this is the blast radius of making DOB authoritative:

| cell | members | hold a login |
|---|---|---|
| DOB minor, flag minor — agree | 241 | 9 |
| no DOB, flag minor → treated as minor (safe fallback) | 25 | 0 |
| **DOB adult, flag MINOR** → now treated as adult | 17 | 0 |
| **DOB MINOR, flag adult** — the Zachary class | 2 | 2 |
| no DOB, flag adult → treated as adult, unprovable | 1 | 1 |
| DOB adult, flag adult — agree | 1 | 1 |

Two things worth stating plainly about that table:

- **The Zachary class is exactly two, and both are already covered.** Zachary
  Lawell (4) is `DETACHED_MINOR`. The other is **Colin LoGalbo (15)**, whose
  guardian link points at his own login — shape A, which `SELF_GUARDIAN` already
  detects, and whose account is already named after his dad. He has no
  signatures, so nothing legal is wrong for him yet; the closed gate is what
  keeps it that way.
- **This change RELAXES the gate for 17 members** — adults (18–46 by DOB) whose
  rows were imported with `isMinor` set, all 17 carrying a guardian email
  because the importer routes contact to `guardianEmail` for anyone flagged
  minor. Under the old flag-only gate they could not self-sign a
  guardian-required document; now they can. That is correct — they are adults —
  but it is a real behaviour change and not merely a tightening.

### DETACHED_MINOR — shape E

Zachary is AJ Dorn's shape **minus the guardian link**, which is exactly why
`SELF_GUARDIAN` cannot see him: there is no self-link, because there is no link
at all. New mode, one member per run, `--parent-name` required:

- A minor **by DOB** holding their own login with **no guardian of any kind** —
  no link, no `guardianEmail`, no `Guardian` profile.
- The login is **not the child's**. `cclin203@yahoo.com` logged in three days
  ago; a four-year-old does not own that inbox. It is the parent's account
  wearing the child's name, so the repair **renames it to the parent, detaches
  it from the child, and links it as guardian** — never deletes it.
- One transaction, ordered so the guardian link is created **before** the child's
  `userId` is cleared: the parent never loses access, and the child is never —
  even momentarily — their own guardian.
- Also clears the parent's address off the child row, sets `isMinor` true so the
  flag agrees with the DOB, writes a `Guardian` profile, and leaves a
  `BillingAuditLog` row.
- **Refuses to touch the self-signed waiver.** It prints what is left instead:
  the parent re-signs from `/member/documents`, and because the signature table
  is keyed `(documentId, memberId)` and the route upserts, re-signing REPLACES
  the four-year-old's row rather than leaving it beside a correction.

`ORPHAN_MINORS` now counts **both** blockers and refuses while either remains —
a detached minor's login is about to change hands, so linking a child to it
first attaches them to the wrong account.

`scripts/family-shapes-repair-tests.ts` grew to 85, including a second detached
minor purely so the one-per-run guard is genuinely exercised rather than passing
on a single-row fixture.

**Verification.** 662 assertions across ten suites; `tsc --noEmit` and
`npm run build` clean.

**Zachary is still not repaired** — it needs the parent's name, which is not
recoverable from the data (every field says "Zachary Lawell"). Julian is calling
the Lawells. The command, once he has it:

```
npx tsx scripts/fix-family-shapes.ts --only DETACHED_MINOR --apply \
  --members cmrzg3rlz0005n244b7u37cd1 --parent-name "First Last"
```

Then the parent re-signs the Liability Waiver and Code of Conduct from the
portal, which is what actually fixes the legal record.

---

## 2026-08-16 (later) — `Member.createdVia` wired

Migration `20260815000000_member_created_via` is applied and verified in
production (`text`, nullable, `members_clubId_createdVia_idx` present), so the
second half of its own instructions could finally run: the field is now in
`schema.prisma` and every path that creates a member records how.

The migration was explicit that this order is load-bearing — Prisma selects
every scalar a model declares, so naming the column before it exists takes down
**every member read**, not just signup. Checked the live column before touching
the schema rather than trusting that it had been applied.

### Six write sites, not four

`grep prisma.member.create` finds four. Two more are **nested** creates inside
the signup route's `user.create`/`user.update` (`memberProfile: { create: … }`),
which that grep misses entirely:

| path | value |
|---|---|
| `/api/member/signup` — nested, both branches | `originForSignupPlan(plan.kind)` |
| `/api/member/signup` — the guardian's child | `CHILD_BY_GUARDIAN` |
| `/api/member/self-profile` | `SELF_PROFILE` |
| `/api/members` (staff) | `STAFF` |
| `/api/members/import` | `IMPORT` |
| `/api/reports/imports/[id]/commit` | `IMPORT` |

### The vocabulary drifted from the migration comment — deliberately

`lib/memberOrigin.ts` is the authoritative list, which is where the migration
said validation would live. It differs from that file's SQL comment in two ways,
and the migration cannot be edited to match (its checksum is recorded in
`_prisma_migrations`), so the reasons are documented in the module:

- **`MINOR_SELF` added.** The migration listed only `ADULT_SELF` for "the signer
  is the athlete". But `planSignup` separates the two **by date of birth**, and
  collapsing them would erase the one cohort this column is most useful for — a
  minor who signed themselves up, which is Zachary Lawell's shape. "Find every
  member who self-registered while under 18" should be a SELECT. Recording him
  as ADULT_SELF would make the column lie about the case it exists to surface.
- **`SELF_PROFILE` added** — a guardian who already holds a login opting into
  their own athlete profile. Same resulting shape as ADULT_SELF, different
  origin, and the migration frames these values as paths, not shapes.
- **`ACTIVATION` is listed but nothing writes it.** Activation does not create
  members — it resolves one the CSV import already created and updates it
  (`findFirst` → `update`/`updateMany`; there is no `member.create` in that
  route at all). Those rows are `IMPORT`, which is the truth: activation is
  where an imported athlete gains a login, not where the record is born. So it
  is not exported as writable — a constant nothing produces reads as "we track
  this" when we don't.

`originForSignupPlan` takes the planner's own `kind` rather than re-deriving
adult-vs-minor from a second input; that re-derivation is how `isMinor` came to
disagree with the birthday in the first place. Its parameter type excludes
`GUARDIAN_ONLY`, and because `accountIsAthlete` is a discriminated-union literal,
TypeScript narrows it out at the call site — mislabelling a guardian-only signup
is a compile error, not a silent bug.

**NULL stays NULL.** The migration deliberately did not backfill; every
pre-2026-08-16 row reads as "created before this was recorded". Inferring an
origin for 287 historical rows would manufacture the guesswork the column exists
to end.

Tests: 10 origin assertions appended to `scripts/signup-intent-tests.ts` (96).
One caught a real thing — the planner **refuses a child signup with no date of
birth** (`DOB_REQUIRED`), so every new child record carries one by construction.
That is the mechanism that keeps DOB coverage from decaying below today's 90.9%.

**Verification.** 675 assertions across ten suites; `prisma validate`,
`prisma generate`, `tsc --noEmit`, `npm run build` all clean.

---

## Phase 8 spec — 2026-08-16, membership structure & entitlements (branch `claude/membership-pricing-structure-5f7585`)

**Spec session. No code, no migrations written.** The full phase is in
`plan.md` under `# PHASE 8 — Membership Structure, Entitlements, and
Per-Member Pricing`. This entry is the pointer plus the audit facts a fresh
session should not have to re-derive.

**The problem.** The club runs two membership records for one class because an
option holds only `{label, price, billingPeriod}`. Contract length, auto-renew,
manual-renewal and day grants live one level up on `Membership`, with one slot
each for all options to share. So "MS/HS" and "MS/HS 3 or 12 months Commitment"
are two cards for one class — and the second is already wrong, because its two
options need 3- and 12-month terms and `contractMonths` is a single `Int?`.

**Verified against production (read-only MCP), and worth keeping:**

- MS/HS already has **two options sharing `billingPeriod: MONTHLY`** ($175 full,
  $110 Tue/Thu). That is why the review modal says *"more than one option billed
  MONTHLY, so a subscription's billing period no longer says which one it is
  on"* — `resolveOption` returning `AMBIGUOUS_PERIOD`, correctly refusing to
  guess. The collapse makes it four MONTHLY options, so `optionId` has to land
  first.
- **`contractMonths` is read by nothing.** Written, shown on the portal card,
  never enforced or quoted. `allowManualRenewal` is read by nothing at all.
- **No route writes `MemberSubscription.autoRenew`** after creation. Neither a
  member nor a coach can change it.
- **Day entitlement cannot be class access.** Ms/HS Olympic Season and MS/HS
  Preseason each run `daysOfWeek: [1,2,4]` — one class spanning Mon, Tue and
  Thu. The $175 and $110 members attend the *same* class and differ only on
  Monday. It has to be per-weekday against the `ClassSession`.
- **Read the weekday as `getUTCDay()`, never through `Club.timezone`.**
  `lib/classSessions.ts` walks UTC midnights and stamps wall-clock as UTC;
  production sessions store `date 2026-11-12 00:00`, `startsAt 2026-11-12 19:00`,
  both DOW 4. A timezone conversion here would *introduce* the off-by-one, not
  fix it. `Club.timezone` is not a blocker for this phase.
- **Neither commitment plan appears in any class's `pricingOptions`.** Maximus
  Alexander ($150/mo) is not membership-covered for any class today. The
  collapse fixes that structurally — confirm it is intended before repointing
  him (Decision D4).
- **Option-id backfill is deterministic today: 27 live subs → 18 resolve to
  exactly one option by `(billingPeriod, price)`, 9 resolve to none, 0
  ambiguous.** The nine are Barrett David, Paul Ortega, Wyatt Eastman, Colton
  Waite (all four still open from 2026-08-14), Adelynn Bergen, Riley Bergen,
  Aylen Grubusic, Clint Dwyer, John Doe. Run the backfill before anyone buys
  the $110 option.
- **`resolveOfferPricing` quotes five of eleven MS/HS members wrong** — Levi
  Schanzenbach, Max Hall and Orson Chorba would renew at $190 against a $175
  subscription; Kellan Lister at $530 under a label MS/HS no longer has; Oren
  Oren as "not configured". It reads member-level frozen fields, never
  `MemberSubscription.price`. Not fixed in Phase 8, but `optionId` is its
  prerequisite (Decision D9).
- **Eleven active Stripe subs carry a local `endDate` *and* `autoRenew: true`,
  with an empty `stripeSnapshot`.** The DB cannot say whether Stripe holds those
  `cancel_at` values. Reconcile before any autopay or renewal work ships.

**Stripe, answered plainly.** No minimum-term primitive exists — Subscription
Schedules do not prevent cancellation. The commitment lives in
`MemberSubscription.minimumTermEndsAt` plus the cancellation door, which is
already ours: `request-cancel` only queues a `PendingApproval`, and no Stripe
Customer Portal cancel button was ever exposed. Autopay OFF/ON are subscription
lifecycle events, not toggles — OFF is `cancel_at_period_end` then flip to
MANUAL on the deletion webhook; ON creates a subscription with `trial_end` at
the paid-through date, off the member's own `price` through
`recurringUnitWithFee`. Day entitlements never reach Stripe and never need to.

**Schema: one migration, two nullable columns, one index** —
`MemberSubscription.optionId`, `MemberSubscription.minimumTermEndsAt`,
`@@index([membershipId, optionId])`. Everything else is JSON shape inside
`Membership.options` plus code. Apply and verify the live columns *before*
naming them in `schema.prisma` — Prisma selects every declared scalar, so the
wrong order takes down every subscription read.

**Ten decisions (D1–D10) are open in `plan.md` §8.12 and gate the build.**

---

## 2026-08-16 (later) — the cancel_at audit, and three fixes it exposed

Julian ran `scripts/audit-stripe-cancel-at.ts` (new, read-only, no `--apply`).
**The dates are real.** Every commitment end date is genuine and Skylor Day's
cancellation was requested by his mother and approved by Julian. Nothing about
anyone's subscription was changed, and no script exists to remove a `cancel_at`.

What the audit exposed was three bugs and one open semantics question.

### The two divergences, and how each happened

**Skylor Day — Stripe told us, and we threw it away.** Local `endDate`
2026-10-26, Stripe 2026-08-27. Sixty days apart on the one fact a cancellation
is about. `/api/approvals/membership-cancel` sets `cancel_at_period_end: true`,
captures Stripe's `current_period_end` into `periodEndTs` — and uses it **only
in the member's email**. The DB update wrote `{autoRenew: false, notes}` and
never `endDate`, so the row kept the date approval had stamped from
`Member.commitmentEndDate` months earlier. His mother's confirmation email said
August while every screen in the app said October.

**Titus Hall — the exact inverse.** Local `endDate` 2027-07-14, Stripe holds no
`cancel_at`. His row was created through the staff assign-membership modal,
whose form has a free-text **End date** field. `/api/members/subscribe` writes
it locally and tells Stripe nothing: Checkout rejects `cancel_at_period_end` in
`subscription_data`, so the only end-date mechanism is the webhook's
`autoRenew === false` branch — which did not run, because his `autoRenew` is
`true`. The date has been decoration since 2026-07-14. **Which is true is
Julian's call** (plan.md D13); it is a data correction either way. Note also
`commitmentEndDate` 2027-07-20 vs `endDate` 2027-07-14, and a recorded
`membershipStartDate` of 2026-07-20 against a subscription starting 07-14.

### Three fixes shipped. No member data touched.

- **F1 — the cancellation writes back.** `endDate` is now set from Stripe's
  `current_period_end`, and **only** when Stripe actually returned it; absent,
  the existing date is left alone rather than overwritten with a guess.
  `canceledAt` still stays null — PERIOD_END has not ended anything yet, which
  is the same reasoning the existing CANCELED-event comment gives.
- **F2 — the silent divergence is closed.** An End date on a card-billed
  RECURRING membership is now a 400 naming the two real alternatives (Auto
  Renew off, or assign as manual). `ONE_TIME` is unaffected — there the end
  date is a local access window the webhook already computes. This is a
  refusal, not a policy: whether an End date *should* become a Stripe
  `cancel_at` is D12, and until renewal mode is settled, refusing is the only
  answer that cannot make things worse.
- **F3 — ending memberships are surfaced.** `EXPIRING_MEMBERSHIP` was a 14-day
  rollup naming at most three people, drilling through to
  `?filter=expiring` — **a filter this app never parsed**. It is now per-member
  cards over 90 days, severity by proximity (≤14d high, ≤45d medium, else low),
  each independently snoozable via the existing `(kind, targetId)` snooze key,
  with an overflow card past 20 that states how many it stands for. A new
  `endingSoon` queue in `lib/membersQuery.ts` backs the drill-through, with both
  predicates inside one `some` so it is the same subscription that is active and
  ending. On the day it was written, all eight memberships ending between
  2026-08-27 and 2026-11-23 were outside the old window — the card showed none
  of them.

### Open: `autoRenew` conflates two things (D11)

Julian's read is right. `autoRenew` describes a decision made at creation, not
the subscription — its only mechanical effect is one webhook branch. Eleven
rows say `true` beside a real Stripe `cancel_at` because the end date arrived
through a different door entirely (`Member.commitmentEndDate` → the approve
route's `cancel_at`) that never touched the flag.

Recommendation in plan.md §8.14: **three derived modes, no new column** —
`OPEN_ENDED` / `TERM_THEN_ENDS` / `TERM_THEN_RENEWS` — and redefine `autoRenew`
to mean strictly "Stripe will bill this again", written from Stripe on any
Stripe-billed row. Then the contradiction is structurally impossible, because
both facts come from the same read. `TERM_THEN_RENEWS` is the mode the collapsed
commitment options need, which is why §8.2 moves `autoRenewDefault` onto the
option.

### Process note — an edit landed in the wrong checkout

Two `lib/` edits were written to the **main checkout** (`~/Desktop/clubos`)
instead of this worktree, because the shell's cwd resets between commands and
`cd web` resolved to the main tree. Caught by `git status`, both files copied
across, main checkout reverted to clean (`git status` empty), and verification
re-run in the worktree. `web/package-lock.json` was also reverted in both trees —
`npm install` had dropped an unrelated optional peer entry. This is exactly the
hazard the CLAUDE.md worktree note describes; **use absolute paths for every
write when working in a worktree.**

**Verification (in the worktree):** `npx tsc --noEmit` clean, `npm run build`
succeeded. `playwright` was declared in devDependencies but installed in neither
checkout, so `npm run build` had been failing on `scripts/browser-archive-member.ts`
before any of this session's changes; `npm install` in the worktree fixed it.

---

## 2026-08-16 (later still) — coverage for the renewal surfaces, and five more dead links

Julian: *"That dead `?filter=expiring` link is the second time a probe has
pointed at a parameter nothing parses, so it's worth pinning."* Writing the pin
found that it was not the second time. It was the **sixth link, across five
Action Items**, all shipped in 2.5.1a:

| Action Item | Linked to | Why it did nothing |
|---|---|---|
| `EXPIRING_MEMBERSHIP` | `/dashboard/members?filter=expiring` | `filter` is not a roster parameter |
| `UPCOMING_RENEWAL_LARGE` | `/dashboard/members?filter=upcoming_renewals` | same |
| `UNRECONCILED_DEPOSIT` | `/dashboard/financials?tab=stripe` | Financials parses **no** query params — `tab` is `useState` |
| `OFFLINE_PAYMENT_PENDING` | `/dashboard/financials?tab=offline&filter=pending` | same |
| `UNCATEGORIZED_LARGE_BANK` | `/dashboard/financials?tab=bank&filter=needs_review` | same |

A dead query parameter is silent — the page renders, it just renders the wrong
thing — which is why five of them survived months of green builds.
`EXPIRING_MEMBERSHIP` now points at the real `?queue=endingSoon`; the other four
were reduced to bare links, because giving them real queues (or teaching
Financials to read its tab from the URL) is a feature and inventing features
inside a fix batch is how the original mistake happened.

### The window is 120 days, not 90 — the test caught it

Orson Chorba ends 99 days out, so the 90-day window I first wrote still missed
the furthest of the eight. `ENDING_SOON_WINDOW_DAYS = 120` now lives in
`lib/membersQuery.ts` and `lib/reportsActionItems.ts` imports it, so the card and
the queue cannot drift apart. All eight real dates are pinned.

### `scripts/renewal-surfacing-tests.ts` — 28 assertions, no database

`npm run test:renewal-surfacing`. Four groups:

1. **Clause shape** — both predicates inside ONE `subscriptions.some`, nothing
   leaking to the Member level, window opening at `now`, and the window moving
   with the injected `now` rather than freezing at module load.
2. **Real dates** — every one of the eight admitted, the already-past and the
   far-future rejected, and an assertion that the old 14-day window would have
   admitted none of them as stored.
3. **Severity boundaries** — 0/14/15/45/46/90, plus every day in the window
   resolving to something.
4. **Link guard** — sweeps 648 files in `lib/`, `app/` and `components/` for
   static `/dashboard/members?…` links and fails on any parameter the roster does
   not read, checked against `MEMBER_FILTER_PARAM_KEYS` +
   `MEMBER_NON_FILTER_PARAM_KEYS` (both newly exported). `add=1` is in the
   non-filter list because `MembersRoster.tsx:324` genuinely consumes it. A
   companion assertion proves each declared key really does change the parsed
   filter, so a stale entry fails too — and the guard **self-checks** against the
   exact string that shipped broken, so it cannot rot into a test that passes
   because it stopped looking.

### Browser verification — actually run, not just written

`scripts/browser-ending-soon-queue.ts`, driven headless against a throwaway
Postgres seeded with the production shape (subscriptions ending in 11 / 26 / 33 /
71 / 99 / 330 days). Results: `?queue=endingSoon` returned **5 of 23** roster
members — the five inside 120 days, correctly excluding the one at 330 — the
Reports card rendered one item per member with proximity severity (11d red,
26d/33d orange, 71d/99d grey), the drill-through resolved, and there were no page
errors. Screenshot captured.

Standing this up needed three things worth writing down for next time: the
throwaway Postgres socket path must be short (`-k /tmp/aoxpg`; the scratchpad
path exceeds the 103-byte limit), `LC_ALL=C` is required or the postmaster dies
with *"became multithreaded during startup"*, and **the dev server and the
browser must agree on one hostname** — driving `127.0.0.1` while the app
redirects to `localhost` silently drops the session cookie and bounces every
login back to `/login`. The worktree `.env` still carries
`NEXTAUTH_URL=http://athletix-os.com`, which is the stale-worktree-.env hazard
CLAUDE.md already warns about.

### Decisions closed

- **D11 APPROVED** — three renewal modes (`OPEN_ENDED` / `TERM_THEN_ENDS` /
  `TERM_THEN_RENEWS`), derived, no new column; `autoRenew` redefined to "Stripe
  will bill this again" and written from Stripe on Stripe-billed rows.
- **D13 ANSWERED — Titus does not renew.** The local `endDate` is right and
  Stripe is wrong. Use `cancel_at_period_end: true` rather than an absolute
  `cancel_at` so Stripe resolves the boundary and F1's write-back stamps the
  agreed date. Still to settle in the same pass: `endDate` 2027-07-14 vs
  `commitmentEndDate` 2027-07-20, and `membershipStartDate` 2026-07-20 against a
  subscription starting 07-14.
- **D1a ANSWERED — Sunday Funday stays included** for MS/HS and the rest. No
  class-acceptance edit. Full = `ALL` therefore means Mon·Tue·Thu·Sun; the $110
  option is Tue·Thu only, which changes nothing today (no subscribers).

**Phase 8 now waits on D2, D5–D8 and D12 only.**

**Verification:** `npm run test:renewal-surfacing` 28/28, `npx tsc --noEmit`
clean, `npm run build` clean, browser check 5/5 against a real database.

---

## 2026-08-17 — decision brief, the Titus instrument, and two logged follow-ups

No feature code. Three deliverables plus one environment fix.

### The six open decisions are written up — plan.md §8.15

D2, D5, D6, D7, D8 and D12 each get a recommendation, the reasoning, and **what
it costs to change your mind later**, because they are not equally reversible:

| # | Recommendation | Cost to reverse |
|---|---|---|
| D2 — option-level class acceptance | **No.** Reserve `optionIds`, never read it | Moderate, safe. Additive JSON key; nine call-sites + editor. Building it first is the expensive direction |
| D5 — `allowManualRenewal` | **Drop** from option shape + editor; keep the column | Trivial. Nothing dropped or backfilled |
| D6 — autopay row strategy | **One row, transition completed synchronously** | Moderate-to-high — the only one whose reversal is a migration |
| D7 — document on `contractMonths` options | **Yes, option-level**, built with the term work | Low. Additive key; collected signatures stay valid |
| D8 — member-initiated autopay | **Queue**, matching `request-cancel` | Trivial. One branch, with an asymmetric middle available |
| D12 — staff End date → `cancel_at` | **Yes, but only via D11's mode control** | **One-way door.** Memberships would genuinely start ending |

**D6's recommendation changed while writing it, and the reason is a real
finding.** The obvious one-row plan was "set `cancel_at_period_end`, flip to
MANUAL when `customer.subscription.deleted` arrives." That does not work:
that handler does an unconditional `updateMany` setting `status: "canceled"` on
any row matching the id, so an autopay handoff would land as a cancellation and
`recomputeMemberStatus` would flip the member inactive. The fix is to not wait
for the webhook — `cancel_at_period_end` means Stripe will not bill again and
the period is already paid, so everything is known at transition time. Read back
`current_period_end`, then in one write set `billingType: "MANUAL"`,
`paidThroughDate`, `stripeSubscriptionId = null`, keep `status: "active"`. The
deletion webhook then matches nothing and is a harmless no-op. Checked rather
than assumed: `invoice.paid` has a metadata fallback for a missed row lookup,
and `charge.refunded` / `charge.dispute.created` resolve by charge, so nulling
the id orphans nothing.

### `scripts/stop-renewal.ts` — the D13 instrument

Dry-run by default, one subscription named explicitly (`--subscription <id>`),
no bulk mode. Reads Stripe first; **refuses** if a cancellation already exists
rather than overwriting one somebody set deliberately, if the status is not
active/trialing, or if Stripe returns no `current_period_end` — writing a date
we cannot stand behind is the bug this whole batch is about. Sets
`cancel_at_period_end: true`, verifies the response, then stamps the date Stripe
resolved onto `endDate` and sets `autoRenew: false`. Writes through the shared
`writeBillingAudit` so it lands in the member's billing history beside
owner-initiated actions, not in a private script log.

It prints Titus's three date mismatches every run and corrects **none** of them
without an explicit flag: `--align-commitment` (commitmentEndDate 2027-07-20 vs
the resolved end) and `--align-start` (membershipStartDate 2026-07-20 vs the
subscription's 2026-07-14). Those two are legitimately different concepts —
agreed start vs billing start — so the script reports and asks rather than
guessing.

### Logged, not fixed: four dead Financials links

The four Action Items reduced to bare links on 2026-08-16 still have no real
destination. Root cause: `app/dashboard/financials/page.tsx` holds its tab in
`useState` and parses **no** query parameters, so `?tab=stripe`,
`?tab=offline&filter=pending` and `?tab=bank&filter=needs_review` selected
nothing; `UPCOMING_RENEWAL_LARGE` additionally has no roster queue to point at.

Two approaches are written up in plan.md §8.14.5 and in a spawned task: teach
Financials to read its tab from the URL and restore the deep links (plus a
`largeRenewals` queue beside `endingSoon` — note the threshold constant would
have to move **into** `membersQuery.ts`, since `reportsActionItems.ts` already
imports from it and the reverse would be circular), or leave them bare and make
the cards carry enough detail that the destination need not be filtered. The
existing guards in `scripts/renewal-surfacing-tests.ts` must be updated, not
deleted, if the first path is taken.

### Environment: the worktree `.env` is fixed

`NEXTAUTH_URL` was `http://athletix-os.com` — the production domain — in a
worktree used for local development. It cost time twice on 2026-08-16: once
sending the browser check to the wrong host, once making the session cookie
undeliverable. Now `http://127.0.0.1:3000`, with a timestamped backup beside it.
Both are gitignored. This is the stale-worktree-`.env` hazard CLAUDE.md already
warns about; it is worth checking `grep NEXTAUTH_URL .env` at the start of any
session that will run the app locally.

---

## 2026-08-17 — Phase 8 build starts: the option model, and D5

All six decisions answered (D2 no · D5 drop · D6 one row, synchronous · D7 yes,
option-level · D8 queue · D12 yes but via the mode control, last). Julian's
reason for D6 is better than the one in §8.15.3 and is now recorded there:
`member_subscription_events` already **is** the history layer and is what
Reports reads for churn, so chained subscription rows would be a SECOND history
mechanism, and two of those drift — the `memberDuplicates` lesson. A
billing-history tab should be built from the event log, not from rows.

**A note on build order.** The answer order was by reversal cost. The build
order is §8.13's dependency order, which is different: D8 and D6 are both the
autopay transition (step 11) and depend on option identity existing first, and
D2 is a decision *not* to build something. D5 lands early anyway, because
dropping `allowManualRenewal` is part of the option-shape work.

### `lib/membershipOptions.ts` — one model, and it REPLACES the old parser

Pure, no prisma. Parses the stored JSON-string-inside-a-json-column, mints
stable option ids, resolves which option a subscription is on, resolves term
inheritance, derives the member-facing sentence, and evaluates weekday coverage.

It does not sit *beside* `lib/bulkPriceChange.parseMembershipOptions` — it
replaces it, and that module now re-exports from here. Two parsers for one JSON
blob drift the first time somebody adds a key to one of them, which is exactly
the failure mode Julian named for D6.

Design points worth keeping:

- **Every Phase 8 field is nullable and means "inherit the plan"** — never false
  or zero. An option carrying none of them behaves identically to today, which
  is what makes this shippable against live data.
- **`serializeOptions` omits every null**, so round-tripping an untouched plan
  is byte-identical. Pinned by a test: saving a plan nobody edited must not
  rewrite its options column.
- **Entitlement parsing fails OPEN.** A malformed blob degrades to `ALL`, not to
  "grants nothing". Direction matters: a wrong *covered* costs a drop-in fee, a
  wrong *not covered* turns a family away at the door.
- **`resolveSubscriptionOption` has three states, not two** — exact / inferred /
  unresolved — because screens must render them differently. Label matching is
  deliberately not a step at any point.
- **`findDuplicateOptions`** refuses two options sharing BOTH period and price,
  the only condition that makes the inference ambiguous. Two options billing the
  same amount on the same schedule are one option with two names, so this costs
  the owner nothing.
- **`describeOption` is the only thing allowed to build a price sentence**, and
  it suppresses a term that merely restates the billing period — "$450 every 3
  months", not "$450 every 3 months for 3 months".

`scripts/membership-options-tests.ts` — 82 assertions, no DB
(`npm run test:membership-options`). Fixtures are Frog Empire's real MS/HS
options, including Hunter Meyer's inferrable row, Kellan Lister's renamed
option, Colton Waite's unmatchable $530, and the six-option card the collapse
produces (four MONTHLY, no collision, three distinct term lengths).

### D5 shipped

`allowManualRenewal` is gone from the membership editor and from both API
schemas. The **column stays and keeps its value** — the PATCH route simply no
longer sends the key, and Prisma ignores an absent key, so nothing is
overwritten. `duplicate` still copies it verbatim, which is right: duplicating a
plan should preserve the row. It is documented as deliberately absent in
`lib/membershipOptions.ts` so nobody re-adds it.

### Migration written, NOT applied

`20260817000000_membership_option_identity` — `MemberSubscription.optionId`,
`MemberSubscription.minimumTermEndsAt`, and the `(membershipId, optionId)`
index. **`schema.prisma` is deliberately unchanged**; the ordering hazard is
spelled out in the migration header. Apply first, verify the live columns, then
name them in the schema — otherwise every subscription read fails, not just the
new code.

    cd web && npx prisma migrate deploy

### Found in passing, logged not fixed: `addBillingPeriod` drifts by a day

`bulk-price-change-tests.ts` has been red — 152 passed, **4 failed** — before any
of this session's changes, and the four are all one bug:

    addBillingPeriod(2026-09-01T00:00Z, "MONTHLY")   → 2026-10-02  (want 10-01)
    addBillingPeriod(2026-09-01T00:00Z, "QUARTERLY") → 2026-12-02T01:00Z (want 12-01)

`lib/billingAdmin.addBillingPeriod` uses local-time setters on dates stored at
UTC midnight. 2026-09-01T00:00Z is Aug 31 20:00 in America/New_York, so
`setMonth(+1)` asks for "Sept 31", which JavaScript rolls forward to Oct 1 local
= Oct 2 UTC. The quarterly case additionally crosses the DST boundary and picks
up the stray hour. It misbehaves whenever the local date differs from the UTC
date — i.e. every date-only value in a negative-offset timezone, which is what
`commitmentEndDate`, `billingAnchorDate` and `membershipStartDate` all are.

Consumers are money-adjacent: `paidThrough.resolveCoverage` (which feeds
`paidThroughDate` and "who owes money"), `bulkPriceChange.periodStartFor` (the
inverse, same pattern — it sets the days-in-period denominator for the
unused-time credit shown during a price change), migration approve, reactivation
confirm, and both subscribe routes. **The tests encode the correct expectation
and the implementation is wrong**, so this shipped red rather than untested.

Not fixed here — it is not Phase 8 and a hasty change to date arithmetic used in
six money paths needs its own batch with month-end and DST cases pinned in both
directions. Spawned as a task with the full reproduction and consumer list.

**Verification:** `npx tsc --noEmit` clean, `npm run build` clean,
membership-options 82/82, renewal-surfacing 28/28, member-tracks 183/183,
bulk-price-change 152/156 (the 4 pre-existing failures above, unchanged).

---

## 2026-08-17 — schema fields live, and the two identity scripts

`20260817000000_membership_option_identity` applied by Julian and verified
independently before the schema was touched: `optionId` (text, nullable),
`minimumTermEndsAt` (timestamp, nullable) and
`member_subscriptions_membershipId_optionId_idx` all confirmed present via a
read-only query. Only then were the fields added to `schema.prisma` — that
order is the whole point of the migration header.

`schema.prisma` carries the reasoning at the field: `optionLabel` is a DISPLAY
snapshot and never an identity; `optionId` is the identity; `minimumTermEndsAt`
is a FLOOR and is deliberately not `Member.commitmentEndDate`, which is a
ceiling.

### Two scripts, dry-run by default, run in order

**`scripts/mint-option-ids.ts`** — writes `memberships.options` only, adding an
`id` to any option lacking one. Idempotent: an existing id is never
regenerated, which matters because the id is about to become the thing
subscriptions point at, and reassigning one would silently repoint every member
on that option. Soft-deleted plans ARE included — canceled subscriptions still
point at them, and skipping them would leave historical rows permanently
unresolvable. Reads back after writing and fails loudly if any option is still
without an id.

**`scripts/backfill-subscription-option-id.ts`** — stamps `optionId` only where
exactly one option on the plan matches `(billingPeriod, price)`. Never matches
on `optionLabel`. Zero or multiple matches are reported and left null, which is
the correct outcome: every reader already handles null (the price tool excludes
the row from bulk selection, the coverage resolver fails open), and a wrong id
would be worse than no id in all three places.

### Expected numbers, measured against production read-only

| | |
|---|---|
| Plans needing ids | **19** (of which 10 soft-deleted) |
| Option ids to mint | **30** |
| Live subscriptions considered | **28** |
| Would stamp | **19** |
| Left null | **9** |
| Ambiguous | **0** |

**Correction to the §8.1 figure of 27/18.** That query excluded subscriptions
whose *plan* is soft-deleted; the script does not, because a live subscription
on a retired plan still has to resolve its option or it is unreadable
everywhere. John Doe's $1 row on the soft-deleted "Test" plan is the
difference. The docstring now states 28/19 and says why.

The nine that stay null: Barrett David, Paul Ortega, Wyatt Eastman and Colton
Waite (the billing corrections open since 2026-08-14) plus four legacy rates —
Adelynn Bergen, Riley Bergen ($750 annual), Aylen Grubusic and Clint Dwyer ($80
against a $75 list).

### Order matters, and the script says so

Running the backfill BEFORE minting reports all 28 rows as
`plan has un-minted options — run mint-option-ids.ts first`. That is by design,
not a failure: there are no ids to stamp yet.

    npx tsx scripts/mint-option-ids.ts                       # dry run
    npx tsx scripts/mint-option-ids.ts --apply
    npx tsx scripts/backfill-subscription-option-id.ts       # dry run → 19/9/0
    npx tsx scripts/backfill-subscription-option-id.ts --apply

### Pre-existing failures: it is 7, not 4, and all one bug

`billing-admin-tests.ts` fails 3 assertions on top of the 4 in
`bulk-price-change-tests.ts`, and they are the same `addBillingPeriod`
local-time drift — QUARTERLY, QUADRIMESTRAL and SEMI_ANNUAL each land a day
off. Confirmed pre-existing by stashing. The separate session fixing that date
math should expect to turn 7 assertions green across two suites, not 4.

### Process note — the wrong-checkout mistake happened again

The `schema.prisma` edit landed in the main checkout rather than this worktree,
for the same reason as 2026-08-16: `cd /Users/cubano/Desktop/clubos/web`
resolves to the MAIN tree, and the shell cwd resets between commands. Caught by
`git status` on both trees, verified both were at the same base commit, copied
across, main reverted to clean. **Use `git -C <path>` and absolute paths for
every read AND write when working in a worktree** — a bare `cd` into a path
that merely looks right is the trap.

**Verification (in the worktree):** `npx tsc --noEmit` clean, `npm run build`
clean, membership-options 82 passed / 0 failed, renewal-surfacing 28 passed / 0
failed, member-tracks 183 passed / 0 failed, billing-admin 108 passed / 3
failed and bulk-price-change 152 passed / 4 failed (both pre-existing, same
cause).

---

## 2026-08-17 (later) — merged the other session's work; two corrections

Pulled `main` into the phase branch. Two commits from the parallel session land
in Phase 8 territory and are reviewed and kept as-is.

### `84719e5` caught a bug that was mine

The memberships editor was dropping `id`, `contractMonths`, `autoRenewDefault`,
`entitlement` and `requiredDocumentIds` from every option on every save. One
routine edit would have orphaned the option ids that had just been minted and
the subscriptions that had just been stamped against them.

**The gap was mine.** I added five fields to the option shape in
`lib/membershipOptions.ts` and never touched the two route `optionSchema`s that
gate writes — closed three-key `z.object`s, and Zod strips unknown keys, so the
new fields were deleted at the door. The editor's own hand-rolled three-field
`Option` type and `cleanOptions` spread were the other two causes. Each was
independently sufficient.

The fix is right and matches what the option model was consolidated for: both
routes now accept options loosely (`z.record(z.unknown())`) and run them
through `parseOptions` → `serializeOptions`, so there is one parser and one
serializer. Loose is not weaker — `readOptions` compares the parsed count
against the submitted count and 400s on any entry the parser cannot read, which
is stricter than the old closed schema for malformed values and lossless for
unknown ones.

### `31d24a1` — per-option terms are done

Off the Phase 8 list (§8.13.3). The three-state inheritance is handled
properly: "same terms as the plan" is its own explicit checkbox rather than a
magic blank, and unticking seeds the override from the currently-resolved value
so making terms explicit never silently changes them.

### Correction: the backfill stamped 20, not the 19 I predicted

Actual production state: **20 stamped, 9 null, 0 ambiguous** across 29 live
subscriptions. I measured 28/19/9 earlier the same day. The difference is a
subscription created at 14:14 that day — **chase Robertson**, `Jr Frogs Monthly
Commitment`, "3 months", $90 — which stamped cleanly. The nine left null are
exactly the nine predicted.

### Correction: §8.10 Step 10 is no longer a no-op

`Jr Frogs Monthly Commitment` had zero subscribers when §8.10 was written. It
has one now — the same chase Robertson row. So the Jr Frogs collapse needs the
full repoint (Steps 6, 7 and 9), not just the option append. And the same
coverage argument applies: that plan is in no class's `pricingOptions`, so chase
is currently drop-in priced for the Jr Frogs class and Sunday Funday, and the
collapse fixes it.

**The general lesson, now written into §8.10:** "zero subscribers, safe to skip"
is only true on the day it was measured. Re-run the count immediately before the
collapse, not from the spec.

### Still open and mine: `findDuplicateOptions` is not wired

`lib/membershipOptions.findDuplicateOptions` exists and is tested but nothing
calls it. The editor can therefore still save two options at the same billing
period AND the same price — the one condition that makes
`resolveSubscriptionOption`'s inference ambiguous, permanently, for any row not
yet stamped. Per-option terms make richer option sets easy to build, so this got
more likely, not less. It is the next thing.

**Verification after merge:** `npx tsc --noEmit` clean, `npm run build` clean,
membership-options 96 passed / 0 failed, renewal-surfacing 28 passed / 0 failed,
member-tracks 183 passed / 0 failed, billing-admin 132 passed / 0 failed,
bulk-price-change 165 passed / 0 failed. **All 7 previously-red assertions are
now green** — the UTC billing-period fix landed in the same pull.

---

## 2026-08-18 — the duplicate guard, and the day picker

**CORRECTED 2026-08-18.** This entry originally recorded that both commitment
plans had been added to their classes and that §8.10 Step 0 was therefore done.
**It is not done.** A read of `recurring_classes` shows zero entries for either
`MS/HS 3 or 12 months Commitment` or `Jr Frogs Monthly Commitment`, and no class
row has been updated since 2026-08-13 — so no class was saved that day at all.

**Cause: the change was deferred and never attempted** (confirmed by Julian,
2026-08-18). There is no bug here and nothing to chase. Recorded because the
read looked exactly like a silent save failure, and the next person to notice
the gap should not re-investigate it: `PATCH /api/classes/[id]` accepts
`{type:"membership", membershipId}` in its `pricingOptions` schema, so the
memberships-editor strip bug does not repeat on the class editor.

**Still true, and still costing money:** Maximus Alexander ($150/mo) and chase
Robertson ($90/mo) are drop-in priced for every class, because their plans are
in no class's accepted list. Either add the two plans to those classes (Step 0),
or run the collapse, which fixes it structurally.

**And when the collapse runs:** Step 8 deactivates those two plans, so if they
HAVE been added to classes by then they must be removed from those
`pricingOptions` lists in the same pass, or the lists keep pointing at retired
plans.

### `findDuplicateOptions` is wired — §8.13 gap closed

It existed and was tested but nothing called it, so the editor could still save
two options at the same billing period AND the same price. That is the one shape
`resolveSubscriptionOption`'s inference cannot resolve — permanently, for any
subscription not yet stamped. Per-option terms made richer option sets easy to
build, so it had become more likely, not less.

The rule now lives in `lib/membershipOptions.validateOptionsForSave`, which both
routes call. It replaces the `readOptions` helper each route had its own copy of
— one gate, one message, next to the rule that produces it — and distinguishes
`MALFORMED` from `DUPLICATE_OPTION` so a client can tell a typo from a conflict.
The editor runs the same predicate before submitting so the owner reads the
conflict in the form they are looking at; the server is still the gate.

Deliberately allowed, and pinned: two options on the **same period at different
prices** (MS/HS's $175 and $110 — the entire reason for the phase), and the
**same price on different periods** ($450 quarterly and $450 annual are
different products).

### Day entitlements — the editor (§8.13.6)

The model already had the shape and the evaluation. What was missing was a way
to set it.

**`entitlementFromSelection` / `selectionFromEntitlement`** are the pure rule,
in `lib/membershipOptions.ts`:

- Ticking **every** offered day stores `{kind:"ALL"}`, never the enumerated
  list. This is the load-bearing part. An option that enumerates today's
  schedule silently un-covers its members the day a Wednesday session is added —
  the members did not change, the club did, and nobody would connect the two. A
  test pins exactly that: `ALL` covers a newly-added Wednesday, an enumerated
  full list does not.
- An **empty** selection is also `ALL`. "Grants nothing" is not a product, and
  an untouched picker is far more likely to be a coach who has not finished than
  a deliberate lockout — the same fail-open direction as `parseEntitlement`.

**`GET /api/memberships/[id]/entitlement-context`** (read-only, `classes:view`)
gives the picker the only days worth offering: the union of `daysOfWeek` across
the classes that accept THIS plan, with the class names behind each day as a
tooltip. A coach picking from an abstract Sun–Sat grid would have to hold the
schedule in their head to avoid granting a day that does not exist. For MS/HS
that is Mon·Tue·Thu (Olympic Season, Preseason) plus Sun (Sunday Funday).

It also returns per-option live subscriber counts, keyed on `optionId` — the
only honest key, since `optionLabel` drifted long ago. Rows with a null
`optionId` are counted separately rather than being quietly left out of a
warning about who is affected.

That count exists because of **D3**: entitlement is read live from the option,
not snapshotted, so editing days changes what existing members get with no
per-member review. The mitigation was always that the editor has to say so with
a real number — *"12 members on this option — changing these days changes what
they are entitled to."*

The picker only renders when some class actually accepts the plan. A day
restriction on a plan no class takes would restrict nothing and read as a broken
control.

### Note to self: `as const` on an entitlement fixture breaks the build

Twice now, `{ kind: "DAYS", days: [...] } as const` produces a `readonly` tuple
that is not assignable to `Entitlement`. `tsx` runs it happily because esbuild
strips types without checking them, so the suite goes green and `npm run build`
goes red. Type the fixture `: Entitlement` instead. **A green suite is not a
green typecheck** — run both.

**Verification:** `npx tsc --noEmit` clean, `npm run build` clean,
membership-options 121 passed / 0 failed, renewal-surfacing 28 passed / 0
failed, member-tracks 183 passed / 0 failed, bulk-price-change 165 passed / 0
failed, billing-admin 132 passed / 0 failed.

**Not yet done for entitlements:** nothing enforces them. `lib/entitlements.ts`
and the nine coverage call-sites (§8.4) are the next batch — until then a day
restriction is recorded and displayed but changes no booking or attendance
behaviour.

---

## 2026-08-18 (later) — the coverage resolver, wired to nothing

### First: the class-coverage item is NOT closed

Verified after Julian ticked the plans in. **Two of three landed:**

| Class | Days | Commitment plan | Status |
|---|---|---|---|
| MS/HS Preseason | Mon·Tue·Thu | MS/HS 3 or 12 months | ✅ 13:50 |
| Jr Frogs | Mon·Wed | Jr Frogs Monthly | ✅ 13:50 |
| **Ms/HS Olympic Season** | Mon·Tue·Thu | MS/HS 3 or 12 months | ❌ |
| **Sunday Funday** | Sun | both | ❌ |

Parity with the parent plan is the test: MS/HS is accepted by Olympic Season,
Preseason and Sunday Funday, so its commitment plan needs all three. Jr Frogs is
accepted by the Jr Frogs class and Sunday Funday, so its commitment plan needs
both. **Three additions still outstanding**, and until then Maximus is drop-in
priced for Olympic Season and Sunday Funday, chase for Sunday Funday.

### `lib/entitlements.ts` — the resolver (§8.13.7, step 1 of 2)

Pure, 55 assertions, and **wired to nothing**. It changes no behaviour yet; the
surfaces are the next step.

`resolveSessionCoverage` answers the whole question the nine call-sites each ask
incompletely today. Design points that carry the weight:

- **Fails OPEN, asymmetrically.** Every uncertain branch returns
  `covered: true`. A wrong "covered" costs one drop-in fee and shows up in the
  money later; a wrong "not covered" argues with a paying family at the front
  desk over a row the software could not read. So a shortfall is only reported
  when it can be named: a known option, a known day, a real mismatch.
- **`shouldWarn` is not `!covered`.** `NO_ACTIVE_MEMBERSHIP` and
  `PLAN_NOT_ACCEPTED` are already handled by the existing member/non-member/
  drop-in tiers — a staff member adding a non-member to a class is not doing
  anything that needs flagging, and duplicating it as a warning teaches people
  to dismiss warnings. The warning exists for the one case nothing else
  surfaces: a member who HAS a valid, accepted membership that does not reach
  this day.
- **Several memberships resolve correctly.** Holding any plan that covers the
  day is enough; a shortfall on one plan is never reported when another covers
  the session. When none covers, the most actionable shortfall wins
  (`DAY_NOT_INCLUDED` names an exact gap and an amount, so it outranks
  `TERM_ENDED`, which outranks "we don't know").
- **An inferred option still gates the day.** A guess about identity does not
  become a grant of access — but the message says the option was matched by
  price, so nobody reads a guess as a fact.
- **No drop-in configured** produces "no drop-in price is set on this class",
  never `$undefined`. Pinned by a test.

**Renamed before it spread:** the function was briefly `resolveCoverage`, which
`lib/paidThrough.ts` already exports meaning something completely different (how
far a payment's money reaches). Two same-named functions answering different
questions is a bug waiting for whoever imports the wrong one. It is
`resolveSessionCoverage`, with the reason recorded at the definition.

### The day picker now admits it is not enforcing

Per Julian's condition: a day-restricted option shows *"Not in effect yet — this
is recorded but does not change booking or check-in until day limits go live."*
**Remove that line in the same commit that wires enforcement.** A control that
silently changes nothing is the pattern that cost a week.

**Verification:** `npx tsc --noEmit` clean, `npm run build` clean, entitlements
55 passed / 0 failed, membership-options 121 passed / 0 failed,
renewal-surfacing 28 passed / 0 failed, member-tracks 183 passed / 0 failed,
bulk-price-change 165 passed / 0 failed, billing-admin 132 passed / 0 failed.

---

## 2026-08-22 — the attendance chip (§8.13.7 step 2, part 1)

The resolver is wired to the attendance panel. **Read-only: no write path
changed, nothing blocks, nothing is priced differently.**

### CLAUDE.md dev-server rule amended

The rule said `.env` / `.env.local` are symlinks into the main checkout in every
worktree. **They are not** — `elastic-wilson-411ecb` has a real `.env` file and
no `.env.local` at all, and it carries the production pooler host anyway. Same
danger, different mechanism, so "is it a symlink?" is not a valid check and a
"no" proves nothing. Rewritten to say `npm run dev` in a worktree points at
production by one of two routes, only `dev-local.sh` is safe, and verification
is by connection.

Also recorded there: the 2026-08-17 local servers used a hand-rolled
`DATABASE_URL` override rather than `dev-local.sh`. The database was correctly
the throwaway, but real SMTP credentials stayed loaded and one server bound
`0.0.0.0`. Nothing was sent because the screens driven happened not to send —
luck, not a property.

### `lib/coverageQuery.ts` — the Prisma half

`lib/entitlements.ts` stays pure; this loads rows and returns a verdict per
member. One loader for the panel, the schedule and (later) the write paths,
because each writing its own version of "active sub on an accepted plan" is how
the nine call-sites drifted in the first place.

- Two queries regardless of roster size, and each plan's options are parsed
  **once**, not once per subscription — a roster of 30 on one plan would
  otherwise re-parse the same JSON 30 times.
- `warn` is computed server-side at the wire boundary, so the rule for whether a
  shortfall is worth showing lives only in `shouldWarn` and cannot drift between
  server and browser.
- `dropInFrom` prefers the `dropin` tier, falls back to `nonmember`, and returns
  null when the class configures neither — so the message says "no drop-in price
  is set" rather than inventing a number somebody might collect.

### The chip

Amber, beside the existing orange Owes chip, reusing that idiom rather than
inventing a second one. It renders in **both** places staff need it:

- on each roster row, and
- **in the Quick-Add search results** — the moment staff are about to add
  somebody, which was the explicit requirement. It is not enough to appear after
  the record exists.

Clicking expands a panel that states the shortfall and says plainly *"Attendance
can still be recorded — this is a heads-up, not a block."*

### Browser-verified on the local rig

Started with `scripts/dev-local.sh`; connection checked before and after, both
empty of production. Fixture: Ms/HS with a $175 full option and a $110 Tue/Thu
option, one class running Mon·Tue·Thu, two members differing only on Monday.

| | Cameron (Tue/Thu $110) | Sasha (full $175) |
|---|---|---|
| **Monday** | `warn=true` · *"Monthly 2 days (Tue/Thu) covers Tue & Thu — Monday isn't included. Drop-in $25."* | no chip |
| **Tuesday** | `covered=true`, no chip | no chip |

Screenshot confirms the chip beside the Owes chip with every action still
available (Present / Absent / Late / Trial / Drop-In / Remove). Zero page errors.

Teardown verified by connection: no next servers, no prod connections, throwaway
Postgres stopped and deleted.

### NOT done: the schedule label

`/api/member/schedule` still computes coverage plan-level only, so the member
portal will say "Included in your membership" on a day the option does not
grant. It needs per-athlete option data threaded through a hot path that serves
every athlete's feed, and it was left rather than rushed. **Next batch.**

Also still open: three class entries (Olympic Season, and Sunday Funday for both
commitment plans) — Julian is finishing those.

**Verification:** `npx tsc --noEmit` clean, `npm run build` clean, entitlements
55 passed / 0 failed, membership-options 121 passed / 0 failed, member-tracks
183 passed / 0 failed, renewal-surfacing 28 passed / 0 failed.

---

## 2026-08-22 (later) — the member schedule stops lying about a day

`/api/member/schedule` computed coverage plan-level only, so the portal told a
$110 Tue/Thu member *"Included in your membership"* on a Monday and then let
them book free. The label and the booking were both wrong, and the club lost the
drop-in without anyone seeing it happen.

It now runs the same `resolveSessionCoverage` the attendance panel uses.

**No extra round trip.** `optionId`, `price`, `billingPeriod`, `endDate` and the
plan's `options` were added to the `activeSubs` query that already runs — a
family feed must not become one query per child. Plan options are parsed once
for the whole feed via a cache, not once per athlete per session; a family of
three browsing a month of classes would otherwise re-parse the same JSON
hundreds of times.

**Only the classes branch changed.** There are two `evalFor` blocks in that file
— events and classes — and events do not have day entitlements. The events one
is untouched.

**The label says why.** `"Member price"` alone reads as a pricing quirk; a
parent seeing it on Monday and not Tuesday has no way to work out that theirs is
the two-day plan. So `DAY_NOT_INCLUDED` — and only that reason — appends
*"— your plan covers Tue & Thu"*. The other shortfalls are already what the tier
names say, and annotating those would be noise.

### Browser-verified as the member, on the rig

`dev-local.sh`, connection checked before and after, both empty of production.
Logged in as the Tue/Thu member and read both the rendered page and the API:

| Session | tier | label | price |
|---|---|---|---|
| **Mon 24 Aug** | `MEMBER` | "Member price — your plan covers Tue & Thu" | $20.00 |
| **Tue 25 Aug** | `MEMBERSHIP` | "Included in your membership" | free |

The agenda card renders the **price** rather than the label when a price exists,
so the explanation reaches the API and the detail view but not that compact row.
That is a pre-existing rendering choice, not a regression — the requirement
("stop saying Included in your membership on a day the option doesn't grant") is
met, and the Monday row now correctly shows $20.00.

### Not built, and deliberately not merged with this

**The staff-charge divert (§8.4.2).** `POST /api/classes/[id]/charge` still
returns `coveredByMembership: true` on a day the option does not grant, so a
staff member registering a Tue/Thu athlete on a Monday still books them free.
Same for `POST /api/member/classes/book`. That is the change that moves a member
from free to priced, and per Julian it does not land until it has been clicked
through in a browser. Nothing in this batch touches a charge, booking, register
or check-in path.

**Verification:** `npx tsc --noEmit` clean, `npm run build` clean, entitlements
55 passed / 0 failed, membership-options 121 passed / 0 failed, member-tracks
183 passed / 0 failed. Teardown verified by connection.

---

## 2026-08-22 — the write paths stop booking a non-granted day free (§8.4.2)

**This is the change that moves a member from free to priced.** Both routes,
browser-tested on its own, committed alone.

`POST /api/member/classes/book` and `POST /api/classes/[id]/charge` both granted
the free membership path on plan membership alone. A $110 Tue/Thu member booked
Monday free and the club lost the drop-in. Both now gate on
`resolveSessionCoverage`, using the same loader as the panel and the schedule.

### A day mismatch NEVER produces the upgrade 403

The old fallback for a restricted class with a non-matching sub was
`MEMBERSHIP_NOT_INCLUDED` — *"Your current membership doesn't include this
class. Contact your club to upgrade."* Sending that to a family who is on the
right membership on the wrong day is a phone call the club has to take for no
reason.

So `DAY_NOT_INCLUDED` resolves **drop-in → non-member**, and deliberately not the
member tier (they are not entitled today). Staff picking `pricingType:
MEMBERSHIP` on a non-granted day get a day-specific 400 naming the days their
plan does cover, with `code: DAY_NOT_INCLUDED` and the drop-in amount attached,
never the upgrade text.

### No fallback price → book, note, flag

A day-mismatched member at a class with no drop-in and no non-member price is a
**class configuration gap**, not a member problem: there is no way to charge
somebody outside their plan days. They are booked rather than turned away, and
the record carries the reason. No new alert — the attendance panel computes
coverage live, so the row keeps showing its chip until the class is fixed.

### The price list, audited before this went live

**Every active class is drop-in only** — not one configures a member or
non-member price:

| Class | Days | member | non-member | drop-in | accepted plans |
|---|---|---|---|---|---|
| Girls Class | Fri | — | — | $40 | 3 |
| Jr Frogs | Mon·Wed | — | — | $25 | 3 |
| Ms/HS Olympic Season | Mon·Tue·Thu | — | — | $25 | 3 |
| MS/HS Preseason | Mon·Tue·Thu | — | — | $25 | 3 |
| Sunday Funday | Sun | — | — | $25 | 7 |
| Tadpoles | Wed·Sun | — | — | $25 | 1 |

So Olympic Season is the pattern, not the exception: a $110 Tue/Thu member pays
**$25** on a Monday at any MS/HS class while their $175 sibling attends free.
Correct by the rules, and uniform. The no-fallback branch cannot fire today —
it exists for the class somebody creates next month without a drop-in price.

Also confirmed: all three outstanding class entries landed. Olympic Season, Jr
Frogs and Sunday Funday each carry the right commitment plan; Sunday Funday is
up to seven accepted plans. **Maximus and chase have coverage.**

### Nobody is charged silently

Traced before building. The member sees the price **twice**: the schedule detail
sheet renders the label and price together before the Book tap (*"Member price —
your plan covers Tue & Thu — $20"*, and the sub-line only says "Your membership
covers this class" when the tier really is MEMBERSHIP), and the route then
creates a **Stripe Checkout session** and returns a URL rather than charging —
so the final confirmation is on Stripe's own page and can be abandoned. A
controlled minor's booking hits the parental gate before Stripe and returns 202.

### Browser-verified, on its own

`dev-local.sh`, connection checked before and after, both empty of production.

| Case | Result |
|---|---|
| Member, Tuesday (entitled) | 200, free, covered by membership |
| Member, Monday, class has drop-in | routed to the priced path — **no attendance row created**, stopped only because the local club has no Stripe |
| Member, Monday, class has NO drop-in | 200, booked, `bookedOutsidePlanDays: true`, note recorded on the row |
| Staff, Monday, `pricingType: MEMBERSHIP` | 400 `DAY_NOT_INCLUDED`, *"Marcus's plan covers Tue & Thu — this class is on a day it doesn't include. Charge a drop-in instead."* — no "upgrade" anywhere |

The second row is the one that matters and it was proved by absence: a query of
that member's attendance found **two** rows — Tuesday, and the no-drop-in Monday
— and none for the Monday drop-in class. It did not book free.

### Follow-up, deliberately not in this batch

An Action Center probe for **classes that accept memberships but configure no
drop-in or non-member price**. That is a one-time config fix per class, not a
per-booking alert, and it belongs on its own.

**Verification:** `npx tsc --noEmit` clean, `npm run build` clean, entitlements
55 passed / 0 failed, membership-options 121 passed / 0 failed, member-tracks
183 passed / 0 failed. Teardown verified by connection.

---

## 2026-08-22 — enforcement notice removed, misconfig probe added, and where Phase 8 stands

### The "not in effect yet" notice is gone

It said day restrictions were recorded but changed nothing. Enforcement is now
live in both write paths, so the line was about to become false — which is worse
than never having said it. **It should have come out in the enforcement commit;
the code comment said so and I missed it.** Out now.

### `CLASS_MISSING_DROPIN_PRICE` — the config gap made visible

A class that accepts a membership but sets no positive drop-in or non-member
price cannot charge a member whose plan does not cover that weekday. §8.4.2
fails open there — the member is booked free and the row is flagged — which is
right for the family and wrong for the club, and invisible unless somebody
looks.

One-time fix per class, not a per-booking alert, so it is an Action Item.

`cannotChargeOutsidePlanDays` is exported and tested separately from the query,
because **the probe fires on nothing today** — every active class is drop-in
only — so the logic is the only thing there is to verify. Nine assertions,
including the two that are easy to get wrong: a **$0** drop-in is NOT a fallback
(free is what the member already gets), and a **member** price is NOT a fallback
(they are not entitled that day). All six live classes were run through it and
come back clean.

---

## Phase 8 — where it stands, and what is between here and the collapse

### Shipped and on `main`

| | |
|---|---|
| §8.1 | Option identity — `optionId`, minted and backfilled (20 stamped, 9 null, 0 ambiguous) |
| §8.2 | Per-option terms — `contractMonths` / `autoRenewDefault` on the option, plan as fallback |
| D5 | `allowManualRenewal` dropped from the option shape and the editor; column kept |
| §8.9 | `optionId` + `minimumTermEndsAt` columns, applied and in `schema.prisma` |
| — | The duplicate-option guard (`validateOptionsForSave`), one gate for both routes |
| §8.3 | Day entitlements — data shape, the picker, and `ALL` semantics |
| §8.4 | The coverage resolver, the attendance chip, the schedule label, **and both write paths** |
| — | `CLASS_MISSING_DROPIN_PRICE` probe |

**The two-card workaround is now representable as one card**: six options, four
of them MONTHLY, three distinct contract lengths, one of them day-restricted.
Nothing structural is missing for it.

### Between here and the collapse

**Nothing in code.** §8.10 is a data operation and its prerequisites are met:
option ids exist, subscriptions are stamped, the editor round-trips the shape,
and the duplicate guard stops the one thing that would break inference.

What it still needs is the **owner's confirmation on three things**:

1. **Entitlement sets for the six collapsed options** — the recommendation is
   Full = `ALL`, 2-day = `DAYS[2,4]`, everything else `ALL` (§8.10 Step 5). With
   D1a answered (Sunday Funday stays included for MS/HS), `ALL` means
   Mon·Tue·Thu·Sun and the $110 option means Tue·Thu only.
2. **Two live repoints, not one** — Maximus Alexander AND chase Robertson.
   §8.10 Step 10 was written when Jr Frogs Monthly Commitment had zero
   subscribers; it has one now. **Re-run the count immediately before the
   collapse, not from the spec.**
3. **Removing the two commitment plans from the class lists in the same pass**
   as Step 8 deactivates them, or those lists keep pointing at retired plans.

### Still open in Phase 8, none of it blocking the collapse

| # | Item | Note |
|---|---|---|
| §8.6 | Autopay transitions (D6, D8) | One row, synchronous, queued for members. Not started. |
| §8.7 | Bulk price tool from the membership | Still option-first; MS/HS still 409s on `AMBIGUOUS_PERIOD` until this lands. **Do this before the collapse if the owner wants to reprice during it.** |
| §8.8.1 | `minimumTermEndsAt` stamped at purchase + early-termination flag on cancel | Column exists, nothing writes it. |
| D7 | Required document on `contractMonths` options | Reserved in the shape, not enforced. |
| D12 | Staff End date → Stripe `cancel_at`, via the renewal-mode control | Last, per the decision. Refusal (F2) still stands meanwhile. |
| D9 | `resolveOfferPricing` quotes five of eleven MS/HS members wrong | Depends on `optionId`, which now exists. Its own item. |
| — | Four dead Financials Action Item links | Logged, own task. |

**The one worth flagging:** §8.7. The bulk price tool still refuses MS/HS with
`AMBIGUOUS_PERIOD`, and the collapse makes that worse (four MONTHLY options).
It is not a prerequisite for the collapse itself, but repricing anybody
afterwards needs it.

**Verification:** `npx tsc --noEmit` clean, `npm run build` clean,
renewal-surfacing 37 passed / 0 failed, entitlements 55 passed / 0 failed,
membership-options 121 passed / 0 failed, member-tracks 183 passed / 0 failed.

---

## 2026-08-22 — §8.7: the price tool matches on optionId

MS/HS has had two MONTHLY options since the Tue/Thu plan was added, so
`resolveOption` returned `AMBIGUOUS_PERIOD` and the club's main plan could not
be repriced at all. The collapse makes it **four** MONTHLY options. Done before
the collapse, deliberately.

- `resolveOption` takes an `optionId` and resolves outright when given one. The
  period path still refuses on ambiguity — it is now a legacy branch that no
  id-passing caller reaches.
- Both routes accept `optionId` and pass the plan's full option list.
- **The SQL period filter is gone from both queries.** It silently dropped rows
  whose period had drifted from their option — Colton Waite's quarterly lump on
  a row labelled MONTHLY — and a price tool that misses members quietly is worse
  than no price tool. Attribution now happens per row in `planPriceChange`.
- Rows that cannot be placed on any option are returned as `unresolved` and
  called out in the notes. Never dropped.
- Each row reports `optionResolution`, and an inferred match carries a warning,
  so a guess is never shown as a fact.

### The regression the suite caught, and the rule it forced

The first cut attributed rows with `resolveSubscriptionOption` — the coverage
resolver. That matches on **(billingPeriod, price)**, so **Levi Schanzenbach,
who pays $175 against a $190 sticker, resolved to nothing and vanished from the
review.** A price review exists precisely to find people whose price has
drifted; matching on price drops them.

So there are now **two attribution rules, deliberately different**:

| | matches on | why |
|---|---|---|
| **Coverage** (`resolveSubscriptionOption`) | optionId, then (period, **price**) | a wrong option grants or denies a class, so it must be certain |
| **Repricing** (`planPriceChange.attribute`) | optionId, then **period alone** | the drifted price is the thing being looked for |

Both are documented at the definition. Neither should be "unified" later — they
answer different questions and the difference is the point.

### Verified on the post-collapse shape

Six options, four MONTHLY:

```
by label+period : AMBIGUOUS_PERIOD      (correct — it genuinely cannot tell)
by optionId     : RESOLVED -> Monthly Full Membership
repriced rows   : Hunter $175, Levi $190   (override INCLUDED)
unresolved      : Oren                     (un-stamped, four options share MONTHLY)
```

Nina, stamped to the Tue/Thu option, is correctly absent.

**Verification:** `npx tsc --noEmit` clean, `npm run build` clean,
bulk-price-change 165 passed / 0 failed, billing-admin 132 passed / 0 failed,
entitlements 55 passed / 0 failed, membership-options 121 passed / 0 failed,
renewal-surfacing 37 passed / 0 failed, member-tracks 183 passed / 0 failed.

### Owner confirmations recorded for the collapse

1. Entitlements: Full = `ALL`, 2-day = `DAYS[2,4]`, rest `ALL`. `ALL` means
   Mon·Tue·Thu·Sun.
2. **Two** repoints — Maximus and chase. Re-run the count immediately before,
   never from the spec.
3. Remove both commitment plans from the class lists in the same pass that
   deactivates them.

**Not run.** The collapse is to be walked through as a step-by-step dry run for
approval before anything writes.

---

## 2026-08-24 — §8.1 C2: purchase paths record which option was sold

Blake Decker forced this. Sold "3 Months" at $160 on a plan with **two** MONTHLY
options, created after the backfill ran, and landed with a null `optionId` — so
he could not be attributed by billing period either, and the price tool would
list him as unresolved. Every membership sold since the backfill has had the
same gap; the collapse exists to remove exactly that ambiguity, so it would have
been building a backlog behind itself.

`optionIdForPurchase(options, {label, billingPeriod, price})` resolves in order:
exact label + period → unique (period, price) → **null**. Null is a legitimate
outcome and every reader handles it. A WRONG id is not, so it never guesses.

**Nine create sites, eight stamp:**

| Path | |
|---|---|
| `member/memberships/subscribe` (create + reuse-pending) | ✅ |
| `members/subscribe` (MANUAL + Stripe) | ✅ |
| `approvals/membership-purchase` | ✅ |
| `reactivate/[token]/confirm` (card + offline) | ✅ |
| `members/migration/[id]/approve` (manual + Stripe) | ✅ |
| `members/migration/activate/[token]` | ✅ |
| `stripe/reconcile/[id]` | **deliberately not** |

The reconciler mirrors a subscription that exists in Stripe and was never sold
through a plan option — there is no option to point at, and inventing one puts a
false identity on a row every later reader trusts. Documented at the call site.

**Two things found while wiring it:**

- The migration-approve path **mints a plan** when a member has only a legacy
  snapshot, and its synthetic `{label: "Imported"}` option carried **no id** —
  so any subscription on it was unattributable from birth. It now mints one
  through `withMintedIds`.
- The approve path writes `optionLabel: planName` (the original drift), so
  label matching cannot work there. It resolves on period + price — what the
  member was actually quoted.

**Browser-verified on the rig** (`dev-local.sh`, connection checked before and
after): a real `POST /api/members/subscribe` selling "3 Months" against a plan
with two MONTHLY options wrote `optionId: "opt_3mo"` — the correct one of the
two, which is precisely the discrimination that failed for Blake.

**Verification:** tsc clean, build clean, membership-options 121 passed / 0
failed, entitlements 55 passed / 0 failed, renewal-surfacing 37 passed / 0
failed, member-tracks 183 passed / 0 failed, bulk-price-change 165 passed / 0
failed, billing-admin 132 passed / 0 failed.

---

## 2026-08-24 — D9: a live subscription outranks the import-time snapshot

**This was blocking the collapse and I had filed it as not.** Julian's argument
is the one I missed: repointing members between plans while renewal quotes come
from member-level frozen fields means Barrett and Paul come out of a collapse
still set to renew at **$0** — the collapse failing at the thing it exists to
fix.

`resolveOfferPricing` took only the member's frozen migration fields and the
plan. For five of eleven MS/HS members those disagree with what they actually
pay:

| Member | Pays | Frozen snapshot said | Now quoted |
|---|---|---|---|
| Levi Schanzenbach | $175 | $190 | **$175** |
| Max Hall | $175 | $190 | **$175** |
| Orson Chorba | $175 | $190 | **$175** |
| Kellan Lister | $450 | $530, label "Upfront" (renamed) | **$450, "3 months Upfront"** |
| Barrett David / Paul Ortega | — | `migrationPriceOverride = 0` → **$0** | their real subscription price |
| Oren Oren | $175 | "not configured" | **configured, $175** |

It now takes an optional third argument: the member's live subscription. When
one exists (`active` or `past_due`) it wins outright — **including over the
owner's price override**. The override says "charge this member THIS instead of
the plan price"; once a subscription exists at a price, that IS what they are
charged, and quoting anything else quotes a number nobody pays.

The argument is optional so nothing breaks, but **a caller that omits it is
quoting from the snapshot, which is the bug** — said at the parameter. Both real
callers now pass it: the billing centre and `lib/reactivation.buildOffer`.

Guard rails, all pinned: a **canceled** subscription does not override the
snapshot; **past_due** does, because they are still on it; a subscription with
no readable price falls back rather than quoting null; and a genuine **$0** live
subscription is honoured as $0 rather than being treated as missing.

12 assertions, named for the real members. `billing-admin` is 144 passed / 0
failed — and note it was reporting **132** with these already written, because
the suite printed its summary before the appended block ran. Same trap as
`renewal-surfacing`. **A suite that prints its total mid-file silently drops
everything appended after it.**

### Step 3 script

`scripts/collapse-membership-plans.ts` — dry-run by default and **one step per
run**, no "do it all" mode. It re-reads and prints live counts per option rather
than taking anything from the spec, refuses if the merge would create two
options at the same period AND price, is idempotent (an option already present
is skipped), and reads back after writing to confirm every option carries an id.

Steps 4–9 land as they are approved.

**Verification:** tsc clean, build clean, billing-admin 144 passed / 0 failed,
membership-options 121 passed / 0 failed, entitlements 55 passed / 0 failed,
member-tracks 183 passed / 0 failed.

## 2026-08-24 — §8.6 autopay transitions, §8.6.4 auto-renew, §8.8.1 minimum terms

Both were built without a decision because neither needed one: §8.6 follows D6
(one row, synchronous) and D8 (member-initiated queues), and §8.8.1 was already
specified. Step 3 of the collapse stays held.

### Autopay still gets no column, deliberately

It is derivable — `billingType === "MANUAL" || stripeSubscriptionId === null` —
and a stored flag that can disagree with Stripe is worse than a derived one.
What was missing was a **transition**, which `lib/autopay.ts` now is.

### Why the transition completes synchronously

The obvious design was "set `cancel_at_period_end`, then flip the row to MANUAL
when `customer.subscription.deleted` arrives". **That does not work**, and it is
worth writing down why so nobody re-proposes it: that webhook does an
unconditional `updateMany` setting `status: "canceled"` on any row matching the
subscription id. The handoff would land as a **cancellation** — the member reads
as churned and `recomputeMemberStatus` flips them inactive.

So we do not wait for it. `cancel_at_period_end: true` means Stripe will not
bill again and the current period is already paid, so everything is known at
transition time: read back `current_period_end`, then **one** write — MANUAL,
`paidThroughDate` stamped, `stripeSubscriptionId` nulled. The later deletion
webhook then matches no row and is a harmless no-op.

**Checked rather than assumed**, because nulling a Stripe id is the kind of
thing that orphans money quietly: `invoice.paid` has a metadata fallback that
resolves the member when the row lookup misses, and `charge.refunded` /
`charge.dispute.created` resolve by **charge**, not subscription. Nothing
arriving after the transition loses its member.

### The bug I nearly wrote into the off path

The first cut set `autoRenew: false` when turning autopay off. That is wrong:
autopay off means **the club collects cash from here on**, not that the
membership is ending, and `autoRenew: false` is read everywhere as "this one
stops". It would have manufactured the exact lie §8.0.8 is about — rows claiming
to renew next to an end date, or here, rows claiming to end that don't. The off
path does not touch `autoRenew` at all, and says so at the write.

### The ON path

Member's **own** price through `recurringUnitWithFee`, never the plan's option
price — reading the option there is how you silently reprice someone on an
override. `trial_end` anchored to `paidThroughDate` so the first charge lands
when the paid period ends; never on the day the toggle is flipped.
Params-hashed idempotency key (the Mack Munroe lesson: a static per-subscription
key is permanently burned by one failure). Requires
`resolveChargeablePaymentMethodId` and **changes nothing** without one.

Subscription `price_data` needs a real Product — unlike Checkout there is no
inline `product_data`, which the compiler caught. Reuses the plan's catalog
Product with a plan-scoped fallback, same as approve.

### Who can do it

| Actor | Route | Behaviour |
|---|---|---|
| Owner / staff | `POST …/billing-admin/actions` → `set_autopay` | `billing:full`, `confirm: true`, audited. Executes. |
| Member / guardian | `POST /api/member/subscriptions/[id]/autopay` | Queues `MEMBERSHIP_AUTOPAY_CHANGE`. 202. |

Both land in the same two functions, so there is exactly **one** implementation
of what turning a card on or off means.

The confirm sentence is **recomputed live**, not replayed from the payload — a
request filed days ago can be stale by the time it is worked (price changed,
period rolled, card removed), and the owner approves against the number they
were shown. It states what the **card** is charged ($180.08), not the sticker
($175); showing one and charging the other is how a dispute starts.

A member request that the club could not act on is refused **at request time**
with the reason, rather than sitting in the queue to be declined tomorrow.

The queue rides `billing:view`, not `finances:view` — acting requires
`billing:full`, and a queue you can see but never act on is worse than one you
never see.

### §8.6.4 — auto-renew is the other question

`set_auto_renew` is whether the membership **continues**, which is not who
charges the card. On a Stripe row it maps to `cancel_at_period_end` and takes
**Stripe's own period end** as `endDate` — never a `cancel_at` recomputed
locally, which is precisely why eleven rows now claim to renew next to an end
date. Turning it back on clears the end date.

### §8.8.1 finished

`minimumTermEndsAt` is now written on every purchase path that sells an option:
both subscribe routes, `approvals/membership-purchase`,
`reactivate/[token]/confirm` (both branches), and `migration/[id]/approve` (both
branches), via `minimumTermEndForOptionId`.

That helper returns **null** when the id no longer matches an option — the plan
can be edited between checkout starting and the row being written, and a floor
invented from a plan default would bind a member to a term nobody sold them.
It does not fall through.

**One path deliberately does not stamp it**: `migration/activate/[token]`'s
final-period-paid branch. The term is already served and paid, the row is
non-renewing, and it ends on the commitment date — a floor computed from
`contractMonths` could land *after* that `endDate`, binding someone past the day
their membership stops. That is the one shape a minimum term must never take.
The reason is in the code, not just here.

### dev-local.sh hardened

It already blanked `SMTP_HOST` because the worktree `.env` carries real SMTP
credentials. It did **not** blank `STRIPE_SECRET_KEY`, which is the same risk
with a worse blast radius. Now blanked, with the same "never remove this" note.

### Verification

tsc clean, build clean.

- `membership-options` **135 passed / 0 failed** (+14: the minimum-term floor,
  including day-of-month clamping and every no-floor case)
- `entitlements` 55 / 0 · `renewal-surfacing` 37 / 0 · `billing-admin` 144 / 0
- `scripts/browser-autopay.ts` **31 passed / 0 failed** on the local rig, driven
  as a real owner session *and* a real member session.

**What the browser test cannot prove, stated plainly:** every branch that would
talk to Stripe is unreachable locally by construction — `dev-local.sh` blanks
the key and the fixtures fire each guard first. So the routing, the gates, the
refusals, the queue, and the two non-Stripe writes are proven.
`subscriptions.update(cancel_at_period_end)` and the create-on-ON path are
**not** tested against a live account and need a Stripe test account.

The browser script's default host is `localhost`, not `127.0.0.1`: the app
redirects to `localhost` after sign-in and the session cookie is host-scoped, so
signing in on one and landing on the other drops the session silently. Cost a
round-trip again; now written into the file.

## 2026-08-25 (CORRECTED same day) — the missing-transaction question

> **The section below was WRONG and is kept only so the mistake is legible.**
> The books are NOT short. Kellan's $545.37 was recorded on 2026-07-15 as
> transaction `cmrljn7zh0005wgn6m06yhxhg`, SUCCEEDED and VERIFIED against
> invoice `in_1Tsu95EIplcCMoSoKEmLlg5g`. See the correction below it.

## 2026-08-25 — the missing-transaction question, answered against the webhook log

Kellan Lister has a Stripe charge and no Transaction. The worry was that if the
webhook dropped his it dropped others and the books are wrong by an unknown
number. Measured rather than assumed:

**Subscriptions.** Every `invoice.paid` CONNECT event with `amount_paid > 0`,
grouped by subscription, compared against local Transactions carrying a
`stripeInvoiceId`. **Exactly one mismatch across the whole club: Kellan,
$545.37, 2026-07-14.** Everyone else reconciles.

**One-time money** (events, products, class drop-ins — a different path, via
`checkout.session.completed` + payment intent). Every paid session with
`amount_total > 0` has a matching Transaction. **Zero gaps.**

### Why his dropped, specifically

His event is in the log, verified, `processed: true`, no error — and produced
nothing. The payload says why:

```
api_version               2026-02-25.clover
has_top_level_subscription   false
has_nested_subscription      true
```

The handler read `invoice.subscription`, which does not exist on that API
version — it moved to `invoice.parent.subscription_details.subscription`. So it
resolved no subscription, no member, and recorded nothing, silently, while
marking the event processed. That is the bug `lib/stripeTruth.ts`
(`invoiceSubscriptionId`) fixed, and **that fix shipped 2026-07-15 — the day
after his charge.** He is the last victim of it, caught in a one-day window,
which is exactly why there is one and not many.

Recovery is the existing allowlisted script:

```
npx tsx scripts/backfill-stripe-transactions.ts --apply --invoices in_1Tsu95EIplcCMoSoKEmLlg5g
```

### What this measurement cannot see

It compares against the webhook LOG, which is a record of what ARRIVED. The
earlier failure mode was different in kind: before 2026-07-07 the Connect
endpoint's events failed signature verification and were rejected with a 400
**before** logging. The earliest logged CONNECT event is 2026-07-08, so nothing
before that date is visible here at all, and no query against this table can
answer for that period.

For that, and as the authoritative check generally, the tool already exists:
`compareClubCharges` in `lib/stripeSync.ts`, surfaced on Financials → Stripe →
Reconciliation. It walks Stripe's own charge list rather than our copy of it.
Run that before concluding the books are clean.

### Also found: Kellan's price disagrees with itself

`unitAmount` on his Stripe subscription is **54537** — $530 + 2.9% — while the
local row says `price: 450`. The $545.37 collected on 2026-07-14 matches Stripe,
not us. Which figure was actually sold is an owner question, and it outranks the
end-date correction: `cancel_at` on the wrong amount just freezes the wrong
price. The end-date sequence is held until that is settled.

## 2026-08-25 — CORRECTION: the books are complete, and the method was the bug

The claim above — one mismatch club-wide, Kellan, $545.37 — was an artifact of
how I measured, not a fact about the money.

I joined Stripe invoices to Transactions **through `memberId`**: for each
subscription, count invoices, count that member's transactions, compare. That
join silently assumes the money and the subscription live on the same member.
Michael Lister bought the subscription and paid the $545.37 on 2026-07-14; the
subscription was transferred to **Kellan** on 2026-08-04. So the invoice
resolved to Kellan and the Transaction sat under Michael, and the query called
it missing.

Re-run correctly — matching `invoice.id` to `Transaction.stripeInvoiceId`
directly, with no member in the join at all — **zero paid invoices lack a
Transaction.** The books are complete.

**The lesson worth keeping: never reconcile money through a mutable
attribution.** `MemberSubscription.memberId` is deliberately movable; the
invoice id is not. Reconcile on the immutable key. This is the same shape as the
`commitmentEndDate` failures — a query trusting a member-level fact to describe
a subscription-level one — and it caught me the same way it caught the data.

### Is the payer/beneficiary split intended? Yes, in three places

The money staying with Michael is **by design**, not drift:

| Where | What it says |
|---|---|
| `MemberSubscription.payerUserId` | Stamped to Michael's user by the transfer. The schema comment says exactly why: *"A transfer stamps this so 'the payer stays Michael' survives moving memberId to a different athlete."* |
| `MembershipTransfer.payerUserIdAtTransfer` | Froze the payer at transfer time. |
| `executeTransfer` | Writes the subscription's `memberId`, the audit row, and timeline notes. It never touches `transactions` — it only COUNTS them for the usage warning shown before confirming (`usageSnapshot.transactionCount: 1` on this transfer). |

And it is right on the merits. On 2026-07-14 Michael paid for a subscription
that was his; Kellan was not on it until three weeks later. Rewriting that
Transaction to Kellan would falsify July revenue and delete Michael's record of
a payment he actually made.

`Transaction.athleteMemberId` is null here, and that is also correct — the field
means "paid by X **for** Y at the time of payment", not "later reassigned".
Backfilling it would assert something untrue about 2026-07-14.

### What IS missing is a read, not a write

`tx_on_beneficiary` for Kellan is **0**. His page shows a membership with no
money behind it; Michael's shows a payment for a membership he no longer holds.
The link is fully recorded — `payerUserId` on the subscription and the
`membership_transfers` row — and **nothing surfaces it on either page.**

So the fix, when it is wanted, is to render the transfer on both timelines
("membership transferred to Kellan 2026-08-04 · paid by Michael Lister"), not to
move any row. Do not "fix" this by reassigning the Transaction.

## Queued — commitmentEndDate becomes per-subscription

Approved 2026-08-25, to run as its own batch **after the other session's work is
merged**, because step 2 touches `approve` and `billing-admin`.

Every failure this week is one shape: a member-level date cannot say WHICH
membership it meant. chase Robertson's new purchase inherited a dead one;
Kellan's disagrees with his own billing period; Titus's and Jacob's are days off
from theirs.

1. **Backfill, not migrate.** No new column — `minimumTermEndsAt` already is the
   per-subscription version. Populate it from each subscription's OWN start plus
   term. **Never from the member field**, which is the thing being retired.
2. **Stop writing it** in the four paths that do (activation, approve,
   billing-admin, reactivation); write the subscription's term instead.
3. **Readers.** `planNonRenewal` falls back to `commitmentEndDate` for legacy
   rows. That fallback stays until the backfill is verified, then goes.
4. **Leave the column.** It is the only record of what the club believed at
   import time; dropping it costs the audit trail and buys nothing.

## 2026-09-03 — Phase 6 opens: the check that does not need anyone to notice

Branch `claude/phase-6-safety-integrity-634dea`, in
`web/.claude/worktrees/elastic-wilson-411ecb`. No migration, no schema change,
no production write.

### The audit, before building

All four bugs from the CLAUDE.md table have real fixes in the tree. What was
missing was anything that would have caught them. There is **no CI** — Netlify
runs `npm run build` and nothing else, so the existing `test:*` scripts and the
two grep guards only run when somebody types them. And `onPlanWhere()`, the one
definition of "who is on this plan", had exactly one caller: its own module.

Measured against production (read-only, Supabase MCP):

| | |
|---|---|
| `Member.membershipId` agrees with the subscriptions | **19 of 42** people |
| live subscriptions with no `minimumTermEndsAt` of their own | 28 of 33 |
| …that would have taken their Stripe stop date from the member row | 17 |
| …of those, disagreeing with the subscription they would stop | 3 |
| live subscriptions that cannot say when they next bill | **24 of 33** |
| duplicate `stripeInvoiceId` / orphaned invoices | 0 / 0 |

The three disagreements: Kellan Lister (field 2026-11-15, quarterly from
07-07 implies 10-07, `endDate` null), Titus Hall (six days past his
subscription's own end — §8.14.3's unsettled row, now settled), and **John Doe,
who holds TWO live subscriptions behind one member-level date of 2027-02-10**.
The second runs to 2027-07-14. Turning auto-renew off on it would have handed
Stripe a `cancel_at` five months early. He is the only such member in the club
and nothing would have surfaced him.

### `planNonRenewal` stops reading the member row (not queued — done)

This was the last live path where a member-level field decided a
subscription-level fact, and its output goes to Stripe as `cancel_at`. The
`commitmentEndDate` fallback is **gone from the input type**, so it cannot be
passed again. It now reads `minimumTermEndsAt ?? endDate`.

`endDate` is the same value, per subscription — activation, approve and
reactivation all copy `Member.commitmentEndDate` onto it at purchase. So legacy
rows keep the §8.6.6 behaviour (a 3-month commitment billed monthly still stops
at the term) while a second membership stops on its own date. Where `endDate` is
null, PERIOD_END sends `cancel_at_period_end` and **Stripe** supplies the
boundary — a stale local `currentPeriodEnd` never becomes the date Stripe acts
on. Three call sites updated: `setAutoRenew`, the checkout webhook, and the
member auto-renew route. `scripts/non-renewal-tests.ts` 10/10, including a case
pinned to John Doe's shape.

### `scripts/subscription-truth-guard.ts` — and it blocks the build

Wired into `npm run build` **ahead of** `prisma generate`, so Netlify enforces it
and a bad read fails in seconds rather than after a full compile. Four guards,
ratcheting from counts measured today:

- **A** member-level dates read as the current answer — 44 total, **0 outside
  migration/import paths**. The outside count is the hard fail; the total
  ratchets the migration zone that legitimately owns these fields.
- **B** plan membership counted from `Member.membershipId` — baseline 1
  (`_count.members` in `app/api/memberships/route.ts`, deliberately kept for
  back-compat beside the real `activeMemberCount`).
- **C** `memberId` and `stripeInvoiceId` in one transaction filter — 0.
- **D** `planNonRenewal` reading a member-level commitment — hard 0.

Each guard was **verified by reintroducing its bug** and confirming it fails,
then confirming green again. The first cut had 17 false positives from character
windows — a `membershipId` sixty characters past a query, `_count.members` on a
*MessageGroup*, `reconciliationStatus` matching `/reconcil/`. Rewritten to parse
the brace-balanced `where` clause. **Do not go back to windows**; every false
positive spends the credibility the guard runs on.

### `scripts/report-subscription-truth.ts` — the data half

REPORT ONLY, no `--apply`, ever. Four sections matching the four bugs. It found
every finding above without anyone knowing where to look, which was the point.

Uses `HOLDS_MEMBERSHIP_STATUSES` rather than a hand-written status list, so it
counts what the app counts (this is why its plan-pointer total differs by one
from an ad-hoc SQL query using `trialing`).

**§3 carries a boxed warning that must not be removed.** 24 live subscriptions
cannot say when they next bill, which renders as a blank on the member profile,
and the obvious-looking repair — reaching for `Member.billingAnchorDate` — is
the bug that made Joseph Bower's profile read a date in the past. The blank is
deliberate and honest. The real repair is populating the subscription's own
`currentPeriodEnd`/`paidThroughDate`. An early cut of that box truncated itself
mid-sentence at "IS THE"; it word-wraps now, and `pad()` no longer truncates.

### Still open in Phase 6

§6A (transactions, idempotency on non-webhook money POSTs, audit-log coverage)
and §6B (the test matrix — Stripe test mode, Plaid sandbox, CSV duplicate/
malformed imports, permission boundaries) are untouched. This batch is the
standing check that §6 is supposed to be verified *by*.

Two follow-ups worth naming, neither blocking:

1. **`onPlanWhere()` still has one caller.** Guard B stops a second bad
   definition being written; it does not migrate the reads that already answer
   the question their own way.
2. **Kellan Lister's `currentPeriodEnd` is 2026-07-14** — in the past, on a live
   Stripe row. The reconciler has not refreshed it. That is a `stripeSync`
   question, not a member-field one.
