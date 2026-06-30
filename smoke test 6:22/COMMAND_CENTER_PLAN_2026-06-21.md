# Owner / Staff Dashboard → Command Center — Plan

Date: 2026-06-21. Scope: turn the Owner & Staff dashboards into an operational command center so nothing important (private requests, messages, onboarding/approvals, tournament billing, payouts) gets missed. Built per the required loop: review → draft → score → find weaknesses → rewrite → repeat to 9+/10.

**Status: PLAN ONLY. No code changed yet.** Implementation is phased and sequenced below for Julian to land in checkpoints (he runs all git + migrations).

---

## 1. Current-state review (what already exists)

The platform already has most primitives. The job is mostly **surfacing + connecting**, not building from zero.

| Spec area | What exists today | The actual gap |
|---|---|---|
| **1. Prospect/non-active onboarding** | Members page already has row selection (`selectedIds`) + status filters (ALL/ACTIVE/PROSPECT/INACTIVE/PAUSED). `sendJoinInvite()` = activationKind `JOIN` = free, **no-payment** onboarding link. `ensureActivationToken()` issues a token without email. `migrationStatus`/`activatedAt` track progress. | No **bulk** "select all prospects / non-active → send onboarding link"; no onboarding-status column/filter; bulk send must avoid the known serverless timeout. |
| **2. Private visibility** | `PrivateBooking.coachId` nullable; status `REQUESTED` (unassigned) → `PENDING_COACH` (assigned). `ASSIGN_COACH` action exists. `sendPrivateLessonRequestedEmail()` exists. Eligible coaches resolvable from `PrivateLessonType.eligibleCoachIds` + per-priceOption `coachIds`. | Unassigned requests notify **nobody** (email only fires to a chosen coach). Privates not surfaced on dashboards. No "waiting for assignment" visibility for owner/staff. |
| **3. Membership public registration links** | `/e/[slug]` public event registration; `JOIN` invite flow; member signup wizard. | No public **membership** URL that opens directly to a chosen plan, preserves pricing/onboarding/branding. |
| **4. Tournament invoice workflow** | `Event.isTournament`, `tournamentMode` (HOST/ATTEND), `variableCostEnabled`, `variableCostMode` (ESTIMATED/OFFICIAL), `variableCostTotal`, `variableCostBilledAt`. `EventRegistration.amountDue/amountPaid/invoicedAt/invoiceCount/paymentUrl`. `bill-registrants` route batches Stripe Checkout + email. | No **send-invoice date** (schedule future), no **expense line-item breakdown** (entry/coaching/hotel/etc. + receipt), no parent-facing cost detail, no **official-price-not-finalized reminder** when registration closes. |
| **5. Payout expansion** | `StaffCompensation`, `CompensationBonus`, `CompensationAssignment` (scopeType incl. `EVENT`), `Contractor`, `ContractorPayment` (no status), `PrivateLessonPayRate`, `EventStaffAssignment` (roster). `payroll.ts` computes totals **on-demand**. | No **stored payout** with PENDING/PAID status + history. No unified guest/contractor/event-worker payout. No "assign event compensation" separate from payroll. |
| **6. Notifications / visibility** | `/api/approvals` already **synthesizes** a permission-filtered queue (GUARDIAN_LINK, MEMBERSHIP_CANCEL, MIGRATION_BILLING). Dashboard is widget-based (`WIDGET_CATALOG`, `/api/dashboard/summary`, `/api/dashboard/widgets`), customizable. Stat tiles for pending/failed payments, unread messages, docs. | No unified **Action Center** spanning all action types; no top-bar badge/bell; no single "what needs me now" surface. |

**Architecture facts that constrain the plan**
- Permissions: 10 keys (`lib/permissions.ts`). Every action-item must be permission-filtered (owners bypass). `finances`=payouts/invoices, `staff`=contractors, `members`=onboarding/guardian, `events`=privates/tournaments, `messages`=messaging.
- DB migrations on this Supabase: hand-write SQL → `prisma migrate deploy` (never `migrate dev`). Build = `prisma generate && next build`.
- Known serverless gotcha: row-by-row loops over the pooler time out (~10s). Bulk sends must batch (concurrency≈5, `maxDuration=60`) — same fix used for member import.
- Mobile = Capacitor remote-URL wrapper; web deploy auto-updates the app. Safe-area + touch targets matter.
- Member portal stays light/club-branded; owner dashboard flips with theme tokens.

---

## 2. The scoring loop

Five axes, each /10. **"Risk" = safety: 10 = lowest chance of breaking working flows.** Target: every axis ≥ 9. Stop at 5 rounds.

### Round 1 — naïve "build everything now"
Persisted `Notification` model with writes injected into every triggering route; full dashboard rewrite; new `Payout` model; rebuild tournament invoicing — all in one drop.

| Owner | Staff | Visibility | Scalability | Risk(safety) | Total |
|---|---|---|---|---|---|
| 8 | 7 | 8 | 7 | **3** | 33/50 |

Weaknesses: huge blast radius; notification writes touch dozens of money/booking routes (high regression risk); dashboard rewrite risks the iOS WebView layout already hard-won; duplicates the existing Approvals synth and variable-cost invoicing; can't ship or verify incrementally.

### Round 2 — synthesize instead of persist
Reuse the Approvals synth pattern for a read-only **Action Center**; keep the widget-based dashboard (extend the catalog, don't rewrite). Still ship all 6 areas + 2–3 migrations at once.

| Owner | Staff | Visibility | Scalability | Risk(safety) | Total |
|---|---|---|---|---|---|
| 9 | 8 | 9 | 7 | **5** | 38/50 |

Weaknesses: synth that scans many tables on every load gets heavy for large clubs; still one giant unsequenced drop with migrations; official-price reminder needs a trigger and there's no cron; public-membership purchase path unverified; bulk send could hit the serverless timeout.

### Round 3 — phase it + make synth cheap
Split into P0 (no-migration backbone: Action Center + privates visibility + bulk onboarding + public links), P1 (tournament invoicing, migration), P2 (payouts, migration). Action Center uses parallel indexed `COUNT` + small `LIMIT` lists, brief per-club cache. Reuse `bill-registrants`. Permission-filter every item.

| Owner | Staff | Visibility | Scalability | Risk(safety) | Total |
|---|---|---|---|---|---|
| 9 | 9 | 9 | 8 | **8** | 43/50 |

Weaknesses: synth scalability at very large clubs still a question; no "mark as read" (mitigated since the queue is self-clearing — items vanish when resolved); public-membership link still needs a safe purchase/onboarding path; bulk send timeout not yet addressed; payout items in the Action Center can't exist before the P2 model (must not show fake items).

### Round 4 — close the remainders
- **Action Center scale:** one `/api/dashboard/action-center` endpoint returning only **counts + top-5 per category**; queries are `COUNT` against indexed columns, run in parallel, cached 30–60s per club. Full lists live on existing pages (privates, approvals, events) — no heavy feed assembled on the hot path. Add indexes in the migration phases that need them.
- **Bulk onboarding timeout:** batch with concurrency≈5 + `export const maxDuration = 60` (the proven import fix); return a per-member result summary.
- **Public membership link:** reuse the `JOIN` + member-signup flow with a `membership` preselect param — the public page opens that plan, applies branding, and routes through the **existing** onboarding (no new billing surface invented). If self-serve card capture isn't already safe for that path, P0 ships "opens the plan + routes through existing signup/onboarding"; live auto-charge stays in the existing approve flow.
- **Official-price reminder without cron:** synthesize it as an Action Center item (registration deadline passed + `variableCostMode=OFFICIAL` + `variableCostTotal` null) **and** offer a `scheduled-task` that emails the responsible coach. No new cron infra.
- **No fake items:** payout/contractor/event-payout Action Center items are added only in P2 alongside their model. P0/P1 omit them rather than show placeholders.
- **Additive only:** new widgets default visible but removable via the existing Customize modal; no existing widget/route deleted.

| Owner | Staff | Visibility | Scalability | Risk(safety) | Total |
|---|---|---|---|---|---|
| **9** | **9** | **9** | **9** | **9** | **45/50** |

**Converged at Round 4 (≥9 on every axis). This is the version to implement.**

---

## 3. Winning architecture (the 9+ version)

### 3.1 Action Center (the backbone — P0, no migration)
A single read-only, permission-filtered, self-clearing aggregator.

- **`GET /api/dashboard/action-center`** → `{ items: [{ kind, count, severity, href, sampleLabel }], total }`. Each `kind` runs a cheap indexed `COUNT` (+ optional top-5 `LIMIT`), all in `Promise.all`, cached 30–60s per club. Reuses `requirePermission` so staff only see what their permissions allow; owners see all.
- **Kinds (P0):** `UNASSIGNED_PRIVATES` (events), `PENDING_PRIVATES` (awaiting coach accept), `UNREAD_MESSAGES` (messages), `GUARDIAN_LINK` + `MEMBERSHIP_CANCEL` + `MIGRATION_BILLING` (reuse Approvals), `PENDING_EVENT_PAYMENTS` (existing summary), `DOCS_NEEDING_SIGNATURE`, `ONBOARDING_IN_PROGRESS` (invited-not-activated).
- **Kinds added in P1:** `TOURNAMENT_INVOICE_DUE`, `TOURNAMENT_PRICE_MISSING`.
- **Kinds added in P2:** `PENDING_PAYOUTS`, `EVENT_PAYOUT_REQUESTS`, `CONTRACTOR_PAYOUTS`.
- **Surfacing:**
  1. New dashboard **section widget** `actionCenter` (default visible, top of order) — grouped cards with counts + deep links; empty state "You're all caught up."
  2. New **top-bar bell** with a badge = sum of high-severity counts, opening a dropdown of the same items (reuses the endpoint). Lives in the dashboard header alongside `GlobalSearch`.
  3. New stat tiles (optional, via catalog) for the highest-signal counts.
- **Why safe:** purely additive read path; no writes to existing routes; items disappear when the underlying record resolves (no read-state to manage).

### 3.2 Area 1 — Bulk prospect / non-active onboarding (P0, no migration)
- Members page: "Select all prospects", "Select all non-active" helpers on the existing selection; bulk bar **"Send onboarding link"**.
- **`POST /api/members/onboarding-invites/bulk`** `{ memberIds }` → loops `sendJoinInvite` (activationKind `JOIN`, **no payment**) in batches (concurrency 5, `maxDuration=60`); returns `{ sent, skipped, failed[] }`. Skips members with an active subscription (already covered by `sendJoinInvite` guard).
- Onboarding **status column** + filter chip ("Invited", "Activated", "Completed") from existing `migrationStatus`/`activatedAt` — no new fields.
- Keeps the Migration tool focused on imports; this is plain Members management.

### 3.3 Area 2 — Private lesson visibility (P0, no migration)
- **Unassigned email fan-out:** at the request create site (`/api/member/privates`), when `coachId` is null, email **every eligible coach** (resolve from `eligibleCoachIds` ∪ priceOption `coachIds`) **and the owner**, reusing `sendPrivateLessonRequestedEmail` (add a "needs assignment" variant line). When a coach *is* chosen, behavior is unchanged.
- **Dashboard:** `UNASSIGNED_PRIVATES` is the top-severity Action Center item; add a `privatesQueue` section widget (unassigned first, then pending-coach) deep-linking to `/dashboard/privates`.
- **Messages about privates** surface via the existing `UNREAD_MESSAGES` kind.

### 3.4 Area 3 — Membership public registration links (P0, no migration if reusing JOIN/signup)
- Memberships UI: **"Copy public link"** per plan → `/join/[clubSlug]?m=<membershipId>` (or extend `/e`-style public route).
- Public page opens that plan, applies club branding, routes through the **existing** member signup/onboarding (preserves pricing config). No new billing surface.
- Verify during build whether the existing public signup can pre-select a membership; if not, add a thin read-only public membership endpoint. (Flagged as the one P0 item that may need a tiny API.)

### 3.5 Area 4 — Tournament invoice workflow (P1, **1 migration**)
- **Migration `20260622000000_tournament_invoicing`:** add `Event.invoiceScheduledAt DateTime?`; new model `EventExpenseItem { id, eventId, clubId, label, kind (ENTRY|COACHING|HOTEL|TRANSPORT|UNIFORM|MISC), amount Decimal, description?, receiptFileId? , createdAt }`; index on `Event(clubId, isTournament, registrationDeadline)` for the reminder synth.
- **Send-invoice date:** owner picks "invoice now" or a future date; `bill-registrants` honors `invoiceScheduledAt` (a `scheduled-task` or on-load synth triggers the batch when the date arrives).
- **Expense breakdown:** CRUD on `EventExpenseItem` with optional receipt upload (reuse `/api/upload` + `/api/files/[id]`); per-head total = sum of items; **parent invoice email + portal show the line-item breakdown** so families see exactly why.
- **Official-price reminder:** Action Center `TOURNAMENT_PRICE_MISSING` (deadline passed + OFFICIAL + total null) + optional coach email via `scheduled-task`.

### 3.6 Area 5 — Payout expansion (P2, **1 migration**)
- **Migration `20260623000000_payouts`:** new model `Payout { id, clubId, payeeType (STAFF|GUEST|CONTRACTOR|EVENT_WORKER), payeeUserId?, contractorId?, eventId?, kind (PAYROLL|CLINIC|CAMP|TOURNAMENT|GUEST|CONTRACTOR|EVENT), amount Decimal, status (PENDING|PAID|VOID), method?, paidAt?, notes?, createdById, createdAt }`. Add `ContractorPayment.status` (optional, for parity).
- **Event compensation:** from an event, owner "Assign event payout" → creates a `Payout(kind=EVENT, eventId, payeeType, status=PENDING)`, **separate from payroll**, trackable, with history.
- **Surfacing:** Payouts tab shows PENDING vs PAID + history across staff/guests/contractors/event-workers; Action Center `PENDING_PAYOUTS` / `EVENT_PAYOUT_REQUESTS` / `CONTRACTOR_PAYOUTS` (finances-gated).

### 3.7 Permissions matrix (who sees each Action Center item)
| Item | Permission gate |
|---|---|
| Unassigned/pending privates | `events:view` (+ staff sees only their eligible/assigned) |
| Unread messages | `messages:view` |
| Guardian link / onboarding | `members:view` |
| Membership cancel / migration billing | `finances:view` / `members:edit` |
| Pending event payments, tournament invoice/price | `finances:view` / `events:view` |
| Docs needing signature | `documents:view` |
| Pending/event/contractor payouts (P2) | `finances:view` (contractor also `staff:view`) |

Owners bypass all gates (existing behavior).

---

## 4. File-level implementation blueprint

### Phase 0 — Command-center backbone (NO migration, highest value, lowest risk)
**New**
- `lib/actionCenter.ts` — synth + permission filter + per-club cache.
- `app/api/dashboard/action-center/route.ts` — GET endpoint.
- `components/ActionCenterWidget.tsx` — dashboard section widget.
- `components/NotificationBell.tsx` — top-bar bell + badge + dropdown.
- `app/api/members/onboarding-invites/bulk/route.ts` — batched JOIN-invite send.

**Modify**
- `lib/dashboardWidgets.ts` — add `actionCenter` + `privatesQueue` to catalog + default order.
- `app/dashboard/page.tsx` — render the two new section widgets.
- dashboard header (where `GlobalSearch` mounts) — mount `NotificationBell`.
- `app/dashboard/members/page.tsx` — select-all-prospects/non-active, bulk "Send onboarding link", onboarding-status column/filter.
- `app/api/member/privates/route.ts` (+ `lib/email.ts`) — fan-out unassigned-request email to eligible coaches + owner.
- memberships UI (`app/dashboard/memberships/page.tsx` or purchase-options) — "Copy public link".
- `app/join/[slug]` (or public route) — accept `?m=` membership preselect (small new public read may be needed).

**Risks:** header edit must not disturb the iOS WebView layout; bulk send must batch (timeout); public link must reuse existing onboarding, not a new billing path. All additive.

### Phase 1 — Tournament invoicing (1 migration)
**New:** `prisma/migrations/20260622000000_tournament_invoicing/migration.sql`; `app/api/events/[id]/expenses/route.ts` (+ `[itemId]`); expense-breakdown UI in the event editor; parent-facing breakdown in invoice email + portal.
**Modify:** `prisma/schema.prisma` (Event field + `EventExpenseItem` + index); `app/api/events/[id]/bill-registrants/route.ts` (honor `invoiceScheduledAt`, include breakdown); `lib/email.ts` (invoice email shows line items); `lib/actionCenter.ts` (+ `TOURNAMENT_INVOICE_DUE`, `TOURNAMENT_PRICE_MISSING`).
**Run order:** `migrate deploy` → `prisma generate` → push code.

### Phase 2 — Payout expansion (1 migration)
**New:** `prisma/migrations/20260623000000_payouts/migration.sql`; `lib/payouts.ts`; `app/api/payouts/route.ts` (+ `[id]`); `app/api/events/[id]/payouts/route.ts`; Payouts UI (extend `/dashboard/staff/payroll` or new "Payouts" tab) with PENDING/PAID + history; "Assign event payout" from the event view.
**Modify:** `prisma/schema.prisma` (`Payout`, optional `ContractorPayment.status`); `lib/actionCenter.ts` (payout kinds); contractor page (log payout with status).
**Run order:** `migrate deploy` → `prisma generate` → push code.

---

## 5. Testing checklist (post-implementation)

**Onboarding links**
- [ ] Prospect bulk: select-all-prospects → Send onboarding link → each gets a JOIN link, **no payment** required, status → Invited.
- [ ] Non-active bulk: select-all-non-active → send → links delivered; members with active subs are skipped (reported).
- [ ] Onboarding status column/filter reflects Invited / Activated / Completed correctly.
- [ ] Bulk send of 100+ does not time out (batched).

**Membership public registration links**
- [ ] "Copy public link" copies a working URL; opening it lands directly on the selected plan with correct pricing + club branding; routes through existing onboarding.

**Private requests**
- [ ] Assigned request: only the chosen coach is emailed (unchanged); appears as pending-coach.
- [ ] Unassigned request: **every eligible coach + owner** emailed; appears as `UNASSIGNED_PRIVATES` in Action Center + privates widget; assigning a coach clears it.

**Notifications / email**
- [ ] Staff see only permission-allowed Action Center items; owner sees all.
- [ ] Bell badge count matches the widget; deep links land on the right page; resolving an item removes it.
- [ ] Private-related messages surface via unread-messages.

**Tournament invoicing (P1)**
- [ ] Invoice immediately vs future date both work; future date fires on/after the date.
- [ ] Expense breakdown (entry/coaching/hotel/transport/uniform/misc) with description + amount; receipt attaches and is viewable; per-head total = sum; parent sees the breakdown.
- [ ] Official price not finalized + registration closed → `TOURNAMENT_PRICE_MISSING` + responsible-coach reminder.

**Payouts (P2)**
- [ ] Create payouts for staff / guest / contractor / event-worker; PENDING vs PAID tracked; history visible.
- [ ] Event compensation assigned from an event is separate from payroll and trackable.
- [ ] `PENDING_PAYOUTS` / `EVENT_PAYOUT_REQUESTS` / `CONTRACTOR_PAYOUTS` appear (finances-gated) and clear when paid.

**Regression / permissions (every phase)**
- [ ] Owner & staff login, permission gating, navigation, and existing widgets unchanged.
- [ ] iOS/Capacitor: header + new widgets render correctly, safe-area intact, no layout overflow.
- [ ] `npx tsc --noEmit` + `npm run build` pass; existing Approvals/Migration/privates/payroll flows unregressed.

---

## 6. Recommended sequencing
1. **Phase 0 first** — delivers the command-center feel immediately, no migration, lowest risk, independently shippable.
2. **Phase 1** — tournament invoicing (1 migration, builds on existing variable-cost).
3. **Phase 2** — payouts (1 migration, most net-new).

Each phase is an independent checkpoint: code on disk → Julian runs `migrate deploy` (P1/P2 only) → `tsc`/`build` → push.
