# AthletixOS Improvement — Architecture Notes

Discovery pass for `docs/improvement/plan.md` Section 2. **No implementation.** Findings from four parallel code surveys against the current `main` branch (tip `afb8a77`, working dir `/Users/cubano/Desktop/clubos/web`).

Companion doc: `PROGRESS.md` (phased plan).

Design-handoff status: the Members redesign handoff is under `docs/improvement/design_handoff_members_experience/` and read. **The Reports handoff mentioned in plan §1 is not present in the repo** — flagged as an open item (see §7).

---

## 1. Executive summary

The platform's data foundations are in strong shape: Stripe truth is centralized (`lib/stripeTruth.ts`, `lib/stripeSync.ts`), payment sources have a canonical vocabulary (`lib/paymentSources.ts`), billing state has a server-side derivation engine (`lib/billingAdmin.ts` — `deriveBillingState`, `deriveReadiness`), and the migration/reactivation flow is fully audited.

The gaps the plan targets are **presentational, integration, and coverage** — not foundational:

1. **Financials** — the "Stripe" tab is really an "all transactions" tab (never filters by `paymentSource=STRIPE`); Plaid is capped at a hardcoded 30-day live-fetch window with zero persistence; the Money Out matching UX and Tax Summary exclusions the plan describes are absent. Data foundations (`Transaction.paymentSource`, `reconciliationStatus`, `stripeFeeAmount/netAmount`, `plaidConnectionId`) are already in place; new work is UI + a few narrowly-scoped columns (recorded-by, receipt link, refund fields) + a Plaid persistence table.
2. **Reports** — solid KPI page but the 12-month revenue chart is hardcoded to `NOW() - INTERVAL '12 months'` regardless of the range param, and members/subscriptions counts show "current state" not "in-range" history. All-time export exists only for three fixed CSVs. Design-handoff not in repo — needs to be requested.
3. **Communications** — the biggest lift. Composer is a plain `<textarea>`; no rich text, no templates, no drafts (beyond `publishAt=null`), no audience filtering (blast is all-active-members), no personalization tokens, no per-recipient delivery log, no image support, no queue/idempotency. The `Campaign` model exists but is analytics-only. Bulk "Email Selected Members" from the Members page has no backend action (bulk `"message"` exists — DMs, not email). Permissions collapse to one `messages` key for everything.
4. **Client & Family Accounts** — the "Cameron symptom" is a specific missing join: `GET /api/members/[id]` never returns `guardianLinks` (guardians of this member) or `user.guardianOf` (kids this login manages). The member portal reads `guardianOf` correctly; the dashboard profile does not. Membership assignment/transfer between linked family members exists in TWO places (owner `billing-admin/actions reassign_subscription` — MANUAL/pending only; guardian `member/family/[memberId]/purchases` — repoints memberId). Neither is exposed as the "Michael → Kellen" transfer flow the plan requires. Payer vs beneficiary is only half-modeled (`Member.responsiblePayerUserId`; nothing per-subscription).
5. **Event registration confirmation** — three concrete bugs and one architectural gap. Bugs: (a) free public-path success page says "confirmation has been sent to {email}" but **no email is ever sent** (line 147 early-returns); (b) paid public-path webhook branch also never calls `sendBookingConfirmationEmail`; (c) success page shows "you're registered" the instant Stripe redirects — before the webhook has written the DB row (real race, no polling, no server-rendered confirmation). Architectural gap: `Booking` and `EventRegistration` coexist with asymmetric capacity math and no shared confirmation surface.
6. **Safety** — most patterns are already established (StripeWebhookEvent dedup, BillingAuditLog, sanitizeRichHtml on Documents, canonical payment vocab). Extensions needed: dedup on non-webhook idempotent writes, per-recipient email log, `EmailOptOut` enforcement on the transactional path, and stricter guards where the plan lands new mutations.

**Existing production data preservation:** every proposed change is either additive (new nullable columns, new tables, new endpoints) or a display-layer swap. The three risky places — Transaction model, Member migration state, Announcement send — get new columns not new required fields, and legacy rows continue to compute the way they compute today. No column drops, no enum shrinks, no destructive backfills.

---

## 2.1 — Existing implementation review (per plan phase)

### Phase 1 — Owner Financials

**Files:** `app/dashboard/financials/page.tsx` · `app/api/financials/{summary,report,manual-payment,export}/route.ts` · `app/api/transactions/route.ts` · `app/api/plaid/{transactions,connections,exchange,link-token}/route.ts` · `lib/financials.ts` · `lib/financialReports.ts` · `lib/paymentSources.ts` · `lib/stripeTruth.ts` · `lib/stripeSync.ts` · `lib/fees.ts` · `prisma/schema.prisma` (Transaction 1309-1374, Expense 1573-1607, PlaidConnection 211-232, StripeWebhookEvent 1464-1483).

**Actual current state:**

- **Financials page has 7 tabs** (`page.tsx:76-83`), not 6: Overview · Money In · Money Out · Donations · Tax Summary · Stripe · Bank. All tabs share a header-level `entity`, `bank`, and date-preset filter (query-string `entity=…&from=…&to=…&bank=…`).
- **The "Stripe" tab does not filter by `paymentSource`.** `StripeTab` (`page.tsx:898-942`) fetches `/api/transactions` with no filters and renders every Transaction row for the club — including CASH/CHECK/COMP/EXTERNAL_READER. Its `totals` header labels this "Revenue / Stripe fees / Net", but Revenue is total transactions. The `ReconciliationCard` beneath it (`page.tsx:957`) is the actual Stripe-vs-local diff surface, backed by `/api/stripe/reconcile/charges` + `/api/stripe/reconcile`.
- **Cash/offline has no dedicated tab.** Cash/check drop-ins are recorded via `/api/financials/manual-payment` (Money In tab) and `/api/attendance/charge`; they land in `Transaction` with `paymentSource ∈ {CASH,CHECK,EXTERNAL_READER,COMP}` and `reconciliationStatus ∈ {OFFLINE,UNVERIFIED,VERIFIED,REVIEW}`. There is no page that filters or focuses on them as a group.
- **Plaid is a live pass-through with a hardcoded 30-day window.** `/api/plaid/transactions/route.ts:68-71` computes `thirtyDaysAgo` in-line, calls `plaidClient.transactionsGet({ start_date, end_date, options: { count: 50 } })`, and returns per-connection results. **Nothing is persisted** — no `PlaidTransaction` model exists. Every dashboard load re-hits Plaid live. No pagination beyond `count:50`.
- **Money Out and matching UX is thin.** `Expense` has `category`, `kind`, `paymentMethod`, `receiptUrl`, `reimbursable`, `plaidConnectionId` (`schema.prisma:1573-1607`). No `Expense.reviewedAt/reviewedById`, no split lines, no `matchedPlaidTransactionId`, no per-vendor auto-match rules. Bank tab shows Plaid-suggested categories (`app/api/plaid/transactions/route.ts:92 suggestExpenseCategory`) but there is no accept-suggestion flow beyond manually creating an expense.
- **Tax Summary uses transactions, not bank data.** `TaxSummaryTab` (`page.tsx:831-895`) calls `/api/financials/report` → `lib/financialReports.ts:63-301 buildReport('pnl')`. Revenue = `SUM(Transaction.amount WHERE status=SUCCEEDED AND reconciliationStatus != VOID)`. Expenses = `SUM(Expense.amount) + computePayrollTotalForRange()`. **No transfer / owner-draw / loan exclusion category.** Because Stripe payments count once as Transactions and payouts hit the bank later, using bank-side data (per the plan) would introduce a genuine double-count risk — the plan is right to call this out.
- **Mobile:** tables use `overflow-x-auto` wrappers (`page.tsx:356, 537, 726, 877, 920, 1302`) — scroll but do not reflow to cards. Row action clusters (`page.tsx:372-380` "Assign / Mark paid / Delete") are `flex gap-1` in a `<Td>` — cramped on phone. Tax Summary chip row (9 chips) spills to 3–4 lines below 400px.

**Missing columns on Transaction that the plan's Cash/Offline row requires:**

| Requirement | Today | Status |
|---|---|---|
| Date | `txDate` / `createdAt` | ✅ |
| Client / payer | `memberId` FK; free-text `source` | ⚠️ payer ≠ beneficiary is not modeled |
| Athlete (when ≠ payer) | none | ❌ single `memberId` — needs `payerUserId` **or** `athleteMemberId` split |
| Item purchased | `type` + `category` + `description` | ✅ |
| Payment method | `paymentSource` + legacy `paymentMethod` | ✅ (canonical vocab exists) |
| Amount | `amount` | ✅ |
| Staff who recorded | none | ❌ needs `recordedByUserId` |
| Notes | `notes` | ✅ |
| Receipt status | none on Transaction (only on Expense/Donation) | ❌ needs `receiptUrl` + `receiptSentAt` **or** a `TransactionReceipt` link |
| Refund/reversal status | none first-class; refunds surface only via `reconciliationStatus=VOID` after Stripe reconciliation | ❌ needs `refundedAmount`, `refundedAt`, optionally `refundReason` |

**Two overlapping payment-method vocabularies:**
`lib/financials.ts:37-46 PAYMENT_METHODS` (CASH/CARD/STRIPE/BANK/CHECK/INVOICE/COMP/OTHER) — UI picker set.
`lib/paymentSources.ts:6-14 PAYMENT_SOURCES` (STRIPE/CASH/CHECK/EXTERNAL_READER/COMP/MANUAL_ADJUSTMENT) — truth set.
Every summary consults both (`/api/financials/summary/route.ts:117-124`). Simplification target — see §3.

### Phase 2 — Reports

**Files:** `app/dashboard/reports/page.tsx` · `app/api/reports/overview/route.ts` · `app/api/export/{members,attendance,transactions}/route.ts`.

- **KPIs today:** Revenue (with %-delta vs previous), Net (after expenses), New members, Attendance total. Below: 12-month revenue bar chart, Revenue-by-source, Members-by-status, Subscriptions, Attendance breakdown, Top events, Expenses-by-category, three CSV export links.
- **Date window** (`route.ts:12-49 resolveRange`): `month · last_month · last_30 · last_90 · ytd · year · all`.
- **The 12-month chart is hardcoded** to `NOW() - INTERVAL '12 months'` (`route.ts:145-156`), independent of the selected range. "All time" as range still shows a 12-month chart.
- **Members/subscriptions counts are "current state", not historical.** `allMembers` (`route.ts:100-103`) filters `deletedAt: null` and returns every status (tallied at `route.ts:173-178`). Subscription counts (`route.ts:107-115`) filter `status ∈ {active, past_due, pending}` — no cancelled/expired.
- **Tier gating** (`route.ts:63-71`) on `features.reports` — Growth is blocked (`403 UPGRADE_REQUIRED`).
- **Exports** — three fixed CSVs (`/api/export/members`, `/api/export/attendance`, `/api/export/transactions`); no saved views, no PDF, no custom report builder.
- **The Reports design handoff referenced by plan §1 is not in the repo.**

### Phase 3 — Communications & Email

**Files:** `app/dashboard/{announcements,messages,communication/campaigns}/page.tsx` · `app/api/announcements/**` · `app/api/messages/**` · `app/api/messages/audience/**` · `app/api/campaigns/overview/route.ts` · `lib/email.ts` · `lib/memberMessaging.ts` · `lib/unsubscribe.ts` · `lib/sanitizeHtml.ts` · `prisma/schema.prisma` (Announcement 1266-1283, AnnouncementEngagement 1285-1307, Message 1243-1264, MessageGroup 1640-1660, GroupMessage 1674-1687, EmailOptOut 2395-2405, Campaign 1376-1401, CampaignAttribution 1403-1428).

**Two composers, both `<textarea>`s:**
- Announcements (`announcements/page.tsx:438`) — plain string body. Channels: `app / email / sms / push` toggles but only `email` actually delivers (SMS + push are UI-only, no provider). Optional `publishAt`/`unpublishAt`. Optional "Send email immediately" checkbox on create only.
- Messages / DMs / Groups (`messages/page.tsx:954`) — plain string.

**Announcement blast** (`app/api/announcements/route.ts:110-169`):
- Recipients = every ACTIVE member (`route.ts:112-127`). No audience filter. Minor → guardian email; adult → own email. `Set<string>` collapses siblings sharing one guardian email. Then subtracts `EmailOptOut` (line 130-134).
- Delivery is **inline synchronous** nodemailer per address in a `for` loop (`route.ts:140-162`). No queue, no background job, no per-recipient send log, no dedup on the send (only the incoming request's transaction guards). A duplicate POST double-sends.
- Body is rendered raw in an HTML template with `white-space: pre-wrap`; **never sanitized** — `sanitizeRichHtml` is currently wired only to `Document.body`.
- `List-Unsubscribe` + CAN-SPAM footer included only on announcement broadcasts.

**Engagement** (`AnnouncementEngagement`):
- **Seen** — the member-portal LIST fetch upserts on read (`/api/member/announcements/route.ts:37-49`) — rendering the announcement in-app is "seen".
- **Opened / Clicked** — client POSTs to `/api/member/announcements/[id]/engagement`. No open-pixel or link-redirect tracking in email. `openedAt` / `clickedAt` are portal telemetry.

**Owner-side DM path** (`lib/memberMessaging.ts:71 sendMemberMessage`):
- Fans out to member's User + all guardians (via `guardianLinks`, `Guardian.userId`, `guardianEmail` lookup, lines 43-54).
- Tags with `Message.subjectMemberId` (per-DM scope column, added 2026-06-21).
- Member → member requires an existing thread; member → staff freely allowed.

**Bulk plumbing** (`/api/members/bulk/route.ts:17-21`):
- `delete` (soft-delete + null `userId`, ≤5000)
- `message` (DM each, ≤200 — this is the pattern to reuse for bulk email)
- `send_registration_link` (join invite each, ≤200)
- **No `email` action** — the plan's "Email Selected Members" bulk needs one, ideally routing through a shared `broadcastEmail(recipients, subject, body)` that reuses the announcement pipeline.

**What's missing entirely:**
- No `EmailTemplate` model.
- No `MarketingAudience` model (Campaign has `audienceFilters Json` but is analytics-only).
- No `EmailImage` / image library. Attempting to embed an `/api/files/[id]` URL in an email body fails because that route is session-gated. Club logo has a one-off escape hatch at `/api/public/club-logo/[clubId]`.
- No `EmailSend` per-recipient log (queue/status/error/delivered/bounced).
- No approval/draft state on Announcement beyond `publishAt=null`.
- No personalization tokens (`{{first_name}}` etc.).
- No `EmailOptOut` admin surface + no permission gate. Keys on `(clubId, email)` — email-address-scoped, does not distinguish transactional vs marketing.

**Permissions collapse to one `messages` key.** No sub-key for bulk vs individual, drafts, marketing, templates, images, unsubscribe, analytics, or approval. `permissions.ts:17-28` — 11 keys today; adding sub-scopes without breaking legacy JSON is straightforward because `resolvePermissions` (`permissions.ts:75-86`) already reads any JSON blob.

**No coach-restricted audience mechanism.** `StaffProfile` has no `assignedMemberIds` / audience-rule column. Indirect scoping (a coach teaches a class → members enrolled in that class) exists via `RecurringClass.assignedStaffIds`, `EventStaffAssignment`, `PrivateBooking`, `CompensationAssignment`. Would need either `StaffProfile.audienceRule Json?` or a `MemberCoach` join table.

**Dead code to remove during Phase 3.** `/api/messages/route.ts:19-49` is a legacy announcement-POST-alias — no tier gate, no email path, no opt-out enforcement, just creates an `Announcement` row. Delete before extending, to avoid rebuilding parity in two places.

### Phase 4 — Client & Family Accounts

**Files:** `lib/memberLink.ts` · `lib/guardianLink.ts` · `lib/parentalControls.ts` · `lib/reactivation.ts` · `lib/billingAdmin.ts` · `app/api/members/[id]/route.ts` · `app/api/members/[id]/relationships/**` · `app/api/members/[id]/guardians/approve/route.ts` · `app/api/members/[id]/billing-admin/actions/route.ts` · `app/api/member/family/[memberId]/{controls,purchases}/route.ts` · `app/api/member/memberships/subscribe/route.ts` · `prisma/schema.prisma` (Member 536-720, MemberGuardianUser 936-948, MemberRelationship 826-844, Guardian 915-932, PendingApproval 241-275, MemberSubscription 846-911).

**Three link tables, three jobs — but the dashboard profile only reads one.**

- **`MemberGuardianUser`** (portal-access link, `User↔Member`, `@@unique([userId, memberId])`) — the security invariant. Its existence IS the authorization to book/message/pay/see docs for the linked member.
- **`MemberRelationship`** (Member↔Member social label, SIBLING/COUSIN/PARENT/CHILD/…) — descriptive only, no auth.
- **`Guardian`** (legacy family profile) — email-keyed, one row per club/email; kids sharing a guardian share this row. Still populated by imports.

**The Cameron symptom, precisely located.** `GET /api/members/[id]/route.ts:92-105` includes only `relationshipsFrom`, `relationshipsTo`, and `guardian.members` (siblings sharing legacy Guardian row). It does **not** include `guardianLinks` (guardians of this member) or `user.guardianOf` (kids this User manages). The dashboard "Relationships" card (`app/dashboard/members/[id]/page.tsx:210-243`) renders only `MemberRelationship`. The member portal (`/api/member/portal/route.ts:82-123`) reads `guardianOf` correctly, so a parent sees kids in-portal but a staff member looking at the parent's dashboard profile does not. Fix is additive: extend the include + render a Family & access card.

**Membership purchase target resolution.** `/api/member/memberships/subscribe/route.ts:69-75` resolves via `resolveFamilyContext(userId, clubId, email, memberId)` — the guardian passes explicit `memberId` for the child; else defaults to self; else first child. `MemberSubscription.memberId` is that resolved member (line 192). **There is no beneficiary-transfer flow after the purchase completes.**

**Two transfer/reassign endpoints exist but don't cover the Michael → Kellen case.**

- **Owner** — `/api/members/[id]/billing-admin/actions/route.ts:15 action="reassign_subscription"`. MANUAL/pending subscriptions only; refuses live Stripe subs (`route.ts:107-115`). Writes `BillingAuditLog`. Requires `billing:full`.
- **Guardian** — `/api/member/family/[memberId]/purchases/route.ts:100-110`. Reassigns `MemberSubscription.memberId` (or `ProductSale.memberId`) between accessible family profiles. No Stripe change; local FK repoint only.

The Michael case: guardian bought via `/subscribe` → `MemberSubscription.memberId = Michael`. The guardian endpoint would repoint memberId to Kellen — but this is exactly the flow the plan asks for, and today there is **no UI surface** exposing it, no "eligible members" preview, no "already-used" guard, no attribution audit line beyond a JSON `BillingAuditLog`. Also, if the subscription is a live Stripe sub (not MANUAL), the owner endpoint refuses and the guardian endpoint silently repoints while Stripe keeps billing the original customer — that's a landmine to close.

**Payer vs beneficiary — half-modeled.**
- `Member.responsiblePayerUserId` (`schema.prisma:684`) is a scalar userId (no FK), set by billing-admin PATCH. Member-wide, not per-subscription.
- `MemberSubscription` has one `memberId` (beneficiary). No `payerUserId` column.
- `Transaction` has one `memberId` (beneficiary of the charge). No payer column, no `athleteMemberId` split.

The plan lists five roles: payer · account holder · membership owner · athlete using the membership · guardian or manager. Today they collapse to two: `Member.responsiblePayerUserId` (payer) + `MemberSubscription.memberId` (everything else). The design handoff's Family & access grid needs per-relationship permissions (Book · Pay · Waivers · Messages) — `parentControls Json?` today is per-child, not per-(child × co-guardian).

**Same-email onboarding is already correct.** `/api/member/signup` parent branch (lines 265-310) reuses existing Users and auto-links owner-vouched children (`child.guardianEmail == signup.email`), else queues a `GUARDIAN_LINK` PendingApproval and grants nothing. The migration activate route (`/api/members/migration/activate/[token]`) groups siblings sharing a guardian email into one guardian User. **The plan's "Cameron isn't linking" symptom is the Members-profile read gap above, not an onboarding logic bug.**

### Phase 5 — Event Registration Confirmation

**Files:** `app/api/public/events/[slug]/{route,register}/route.ts` · `app/api/events/[id]/{route,charge,register,bookings,bill-registrants}/route.ts` · `app/api/member/events/[id]/register/route.ts` · `app/api/stripe/webhook/route.ts` · `app/e/[slug]/page.tsx` · `lib/email.ts` (`sendBookingConfirmationEmail` 248-299) · `lib/baseUrl.ts` · `prisma/schema.prisma` (Event 1028-1112, EventSession 1140-1152, Booking 1226-1241, EventRegistration 1158-1189, EventBundle 1193-1211).

**Five registration paths, per fork survey:**

| # | Path | Route | DB writes (when) | Email fires? |
|---|---|---|---|---|
| 1 | Member, free / membership-covered | `member/events/[id]/register/route.ts:161-176, 236-251, 322-338` | `Booking` immediate | ✅ inline |
| 2 | Member, paid → Stripe | same route, `:373-414` | Nothing local; `Booking + Transaction` on webhook `:510-566` | ✅ from webhook |
| 3 | Guest / non-member, free | `public/events/[slug]/register/route.ts:116-148` | `EventRegistration` immediate; no `Booking` | ❌ **no email** — route returns `{ok, free, registrationId}` |
| 4 | Guest / non-member, paid | same public route + webhook `:727-770` | `EventRegistration` immediate; status→PAID + `Transaction` + `Booking` (only if `reg.memberId` matched) on webhook | ❌ **no email** — the `eventRegistrationId` webhook branch does not call `sendBookingConfirmationEmail` |
| 5 | Parent → child, paid | same as path 2 with `body.memberId=childId` | same as path 2 | ✅ from webhook, guardian resolved via `memberContact(memberId)` |

**Three concrete bugs to fix in Phase 5:**

1. **Free public path silently drops the email.** `public/events/[slug]/register/route.ts:147` returns early before any send. The success page at `app/e/[slug]/page.tsx:249-254` renders *"A confirmation has been sent to {email}"* — a lie.
2. **Paid public path also drops the email.** Webhook `eventRegistrationId` branch (`stripe/webhook/route.ts:727-770`) does the DB writes but never calls `sendBookingConfirmationEmail`. The success page shows the same misleading copy.
3. **Success page shows "you're registered" before webhook writes.** For the paid public path, success_url (`register/route.ts:184`) is `${baseUrl}/e/${slug}?registered=true`. Stripe redirects the browser in parallel with the webhook, so the page renders green success before the `Transaction`/`Booking` row exists. No polling, no server confirmation lookup. Also — `getAppBaseUrl()` is used instead of `baseUrlFromRequest(req)`, so Netlify preview deploys bounce the visitor to production, where the local row doesn't exist yet. This is the same class of bug the 2026-07-13 launch-blocker batch fixed in the migration/reactivation flow.

**Architectural gap: `Booking` and `EventRegistration` both exist and don't share a source of truth.**
- `Booking` (`schema.prisma:1226-1241`) — required `memberId`, `@@unique([eventId, memberId])`, used for member paths (1/2/5) and guest paid + email-matched-member.
- `EventRegistration` (`schema.prisma:1158-1189`) — nullable `memberId`, carries `name/email/phone/formResponses`, `amountDue/amountPaid`, `stripeCheckoutSessionId`. Used for guest paths (3/4) and variable-cost events on both sides.
- Overlap: guest paid + matched member creates **both** rows. Member variable-cost creates **both** rows.
- Capacity math is asymmetric: public route counts `bookings + registrations`; member route counts `bookings` only. Guest signups do not reduce capacity from a member's viewpoint until a `Booking` materializes.
- `Transaction` has no FK to either row; the link is loose (`Transaction.memberId` + `Transaction.description` string like `"Event booking: X"`).

**Additional gaps identified:**
- **No idempotency-key on `stripe.checkout.sessions.create`** in any of the three event registration routes (contrast: migration approve sets one). A route retry that races the webhook dedup could produce two PaymentIntents.
- **`EventRegistration` has no unique on `(eventId, email)`** — a guest double-clicking Register creates two rows + two checkouts.
- **`Transaction.stripePaymentIntentId` is unique in schema.prisma but `stripeInvoiceId` is NOT** — subscription dedup is app-side per CLAUDE.md, which is correct today but worth reconfirming.
- **Discount codes**: full support on member + owner paths (member path only stamps `discountCode`, not `discountAmount`, on Checkout metadata — small consistency bug); **zero support on the public path**. Zod schema at `public/events/[slug]/register/route.ts:9-14` does not accept a code.
- **`sendBookingConfirmationEmail` template has no cancellation policy copy, no location/directions link, no calendar attach.** Plan §5 requires all three.

**Mobile posture on `/e/[slug]`:**
- Container `max-w-2xl mx-auto px-4` — works at 375px.
- Email/phone are in `grid-cols-2 gap-3` (line 279) — stays 2-up on mobile, cramped.
- No `autoCapitalize="none"` / `autoCorrect="off"` on email/name inputs — iOS may capitalize.
- No `env(safe-area-inset-bottom)` — Capacitor home indicator can cover the primary CTA.
- Uses raw `bg-stone-*` classes intentionally (matches the member portal light theme).

### Phase 6 — Safety, Data Integrity & Testing

**Files:** `lib/apiGuard.ts` · `lib/permissions.ts` · `lib/ratelimit.ts` · `lib/sanitizeHtml.ts` · `lib/billingAudit.ts` · `prisma/schema.prisma` (StripeWebhookEvent, BillingAuditLog, MemberMigrationEvent, PendingApproval).

Foundations in place:
- **Webhook idempotency** by `stripeEventId` (`StripeWebhookEvent`).
- **Billing audit log** append-only (`BillingAuditLog`).
- **Member-scoped migration event log** (`MemberMigrationEvent`).
- **HTML sanitization** on write for Documents (`sanitizeRichHtml`).
- **Rate limiting** (`lib/ratelimit.ts`) — in-memory buckets, per-IP or per-session, on auth + messaging + booking + upload routes.
- **Tenant isolation** — Task 2 audit closed the last known cross-club Stripe-metadata reads.

Gaps for Phase 6 to close as it lands new mutations:
- **No unique constraint** on `EventRegistration(eventId, email)`; **no unique** on `stripeInvoiceId` (dedupe is app-side); **no unique** on `Transaction.stripeChargeId` (it's declared unique — verify at schema audit).
- **Non-webhook idempotency** on POSTs that trigger money-side effects (bulk email send in Phase 3, subscription transfer in Phase 4, event registration retry in Phase 5) needs an explicit `idempotencyKey` from the client or a server-computed dedup key.
- **`EmailOptOut` is not honored on transactional emails** (welcome, booking, payment failed, parental approval notify) — this is deliberate today but the plan §3I formalizes the distinction transactional vs marketing.
- **CSP is still Report-Only** (`next.config.mjs`) — promotion to enforcing after two weeks of clean reports is a pre-existing follow-up.

---

## 2.2 — Current architecture map

### Database

Schema is 63 models. The plan touches:

- **Members & family**: Member (536-720), MemberGuardianUser (936-948, `@@unique([userId, memberId])`), MemberRelationship (826-844, `@@unique([memberId, relatedMemberId])`), Guardian (915-932), PendingApproval (241-275, free-string `kind`), MemberMigrationEvent (725-742, append-only), ParentalConsent + GuardianConsentRequest (419-474).
- **Billing**: MemberSubscription (846-911, `stripeSubscriptionId @unique`), Membership (950-992, options JSON, trial fields), Transaction (1309-1374, `paymentSource + reconciliationStatus + stripeFeeAmount + netAmount + discountCode + discountAmount + plaidConnectionId`), Expense (1573-1607), StripeWebhookEvent (1464-1483, `stripeEventId @unique`, source PLATFORM|CONNECT), PlaidConnection (211-232), BillingAuditLog (748-771), MembershipReactivation (783-820), InvoiceSplit (286-311).
- **Communications**: Announcement (1266-1283), AnnouncementEngagement (1285-1307), Message (1243-1264, `subjectMemberId?`), MessageGroup (1640-1660, `eventId? @unique`), GroupMessage + GroupMessageReceipt, EmailOptOut (2395-2405, `@@unique([clubId, email])`), Campaign + CampaignAttribution.
- **Events**: Event (1028-1112, `publicSlug @unique`, `registrationForm Json?`, `imagePositionX/Y`, tournament + variable-cost fields), EventSession, Booking (`@@unique([eventId, memberId])`), EventRegistration, EventBundle + EventBundleItem, ClubEventType, EventStaffAssignment, EventExpenseItem.
- **Discounts**: Discount (`appliesTo: Json` including MEMBERSHIP/EVENT/CLASS/PRODUCT/PRIVATE_PACK).
- **Misc**: LegalEntity, LegalAcceptance.

### API routes

- `/api/members` (list) — no pagination, no search, no filter params beyond `guardianEmail`. Runs `expireEndedManualSubscriptions(clubId)` on every load.
- `/api/members/[id]` (GET/PATCH) — does not include `guardianLinks` / `user.guardianOf`.
- `/api/members/bulk` — `delete | message | send_registration_link`, capped at 5000 / 200 / 200.
- `/api/members/duplicates`, `/api/members/merge`, `/api/members/import` (batched to concurrency=5, `maxDuration=60`).
- `/api/members/migration/**` — approve requires `billing:full`, refuses `!canCharge` for a card-intended member (409), preflights duplicate subs on both customer ids, idempotency-key on Stripe.
- `/api/members/[id]/billing-admin/**` — the single authoritative billing service; `PATCH` with `preview:true` for diff; `actions POST` for cancel/reassign; PMs addressed by opaque `pmRef` sha256.
- `/api/announcements` — synchronous nodemailer fanout, per-recipient try/catch counting, no per-recipient log row.
- `/api/plaid/transactions` — hardcoded 30-day live-fetch, `count:50` no pagination.
- `/api/stripe/webhook` — multi-secret verify (platform + connect); dedupes by `stripeEventId`; owns all subscription money via `invoice.paid`.
- `/api/public/events/[slug]/register` — creates `EventRegistration` before Stripe, no dedup on `(eventId, email)`.
- `/api/member/events/[id]/register` — inline `Booking` on free paths, Stripe Checkout on paid.

### Stripe

Truth centralized in `lib/stripeTruth.ts` (`invoiceSubscriptionId`, `invoicePaymentIntentId`, `moneyFactsFor*`, `verifiedStripeTxFields`). Sync in `lib/stripeSync.ts` (`reconcileClubBilling`, `compareClubCharges`, `fillChargeFees`). Catalog in `lib/stripeCatalog.ts` (`ensureMembershipProduct`, `ensureRecurringPrice`). Fees in `lib/fees.ts` (2.9% passthrough, `feeBreakdown` for display). Two webhook endpoints at the same URL — platform + connect — verified against two secrets.

### Plaid

Passthrough only. `plaidClient.transactionsGet` with 30-day window and `count:50`; `PlaidConnection` model stores auth tokens; **no `PlaidTransaction` model**.

### Reports

`/api/reports/overview` — `resolveRange` (`month/last_month/last_30/last_90/ytd/year/all`), tier-gated on `features.reports`. 12-month bar chart is a `$queryRaw` with a hardcoded interval. Aggregates use `SUM(Transaction.amount)` filtered by `status=SUCCEEDED` + `reconciliationStatus != VOID` (via `EXCLUDE_VOID` constant).

### Communications

`Announcement` blast is a synchronous single-request loop with `EmailOptOut` subtraction, minor→guardian routing, and sibling-dedup by shared guardian email. No queue, no per-recipient send log, no bounce/complaint capture, no dedup on the send itself. Composer is plain textarea.

### Members

Server payload includes subscriptions, guardian legacy row, and guardianLinks-of-caller only. Display status (`displayStatusOf`) and onboarding label (`onboardingStatusOf`) are computed CLIENT-side in `app/dashboard/members/page.tsx:103-149`, and duplicated inline on the profile page (`[id]/page.tsx:106-111`). The DB `MemberStatus` enum has 4 values (ACTIVE|PROSPECT|INACTIVE|PAUSED); `MIGRATING` / `PENDING` are display-only. Server-side derivations that **do** exist and could be reused: `lib/billingAdmin.ts:308 deriveBillingState` and `:109 deriveReadiness` — currently only wired into billing-admin and migration APIs.

### Family relationships

`MemberGuardianUser` (auth), `MemberRelationship` (social label), and legacy `Guardian` (family profile) coexist. Auto-linking on owner-vouched guardian emails works correctly at signup and migration activation. The dashboard `/api/members/[id]` payload does not return the guardian-link data, which is the Cameron symptom's proximate cause.

### Permissions

11 keys × 5 levels (`none/view/send/edit/full` — send and edit are the same rank). `finances` gates the Financials/Reports pages; `billing` is the narrower money key added 2026-07-10 for member-billing setup. OWNER bypasses every gate. STAFF permissions are a JSON blob (`StaffProfile.permissions`) — nested sub-keys can be added without breaking existing rows.

### Migrations

Two-workflow shop: (a) Prisma `migrate deploy` for normal schema evolution when it works; (b) hand-written SQL under `prisma/migrations/<ts>_name/migration.sql` when the shadow-db is blocked (default state on this Supabase). Recent additive migrations are applied via Supabase MCP with a matching `_prisma_migrations` bookkeeping row (checksum-verified). Every migration in this plan will need to follow the hand-write + apply + bookkeeping pattern.

---

## 2.3 — Simplification opportunities

Ordered by leverage:

1. **Server-derive member status once, reuse everywhere.** Extract `displayStatusOf` + `onboardingStatusOf` from `app/dashboard/members/page.tsx:103-149` (and the duplicate at `[id]/page.tsx:106-111`) into `lib/memberDisplay.ts serializeMemberForList()`. Reuse `deriveBillingState` / `deriveReadiness` from `lib/billingAdmin.ts` for the Membership + Account-setup tracks. Ship as an additive field on `GET /api/members`. This is a prerequisite for the design handoff's 3-track model AND removes the drift risk.
2. **Unify payment-method vocabulary.** `lib/financials.ts:37-46 PAYMENT_METHODS` (UI picker) and `lib/paymentSources.ts:6-14 PAYMENT_SOURCES` (truth) diverge. Consolidate to one canonical enum + a display mapper. Every summary bucket that consults both (`/api/financials/summary/route.ts:117-124`) collapses to one lookup.
3. **One `computePnl(clubId, range, entity?)` in `lib/financialReports.ts`.** Three implementations exist today (`/api/financials/summary`, `/api/reports/overview`, `lib/financialReports.ts:buildReport(pnl)`) and they already disagree on payroll/contractor inclusion. Consolidate.
4. **Split the Stripe tab into "All transactions" (default) + "Stripe only" (segmented control).** Currently the Stripe tab is really an All-transactions tab; the plan asks for an offline-only tab. Rather than duplicating, use one component with a `paymentSource` filter.
5. **Delete the legacy `/api/messages/route.ts` announcement POST.** It's a parity-hazard cousin of `/api/announcements` (no tier gate, no email, no opt-out). Deleting before Phase 3 lands prevents rebuilding features in two places.
6. **Route every email send through one `sendClubEmail(recipient, kind, ctx)`.** Centralize opt-out check (marketing only), `List-Unsubscribe` header, personalization interpolation, per-recipient `EmailSend` row. Today `lib/email.ts`'s 20+ send helpers each rebuild these bits inline.
7. **Members list unified "Family" section on the dashboard profile.** One card reading `guardianLinks + guardianOf + MemberRelationship + guardian.members`, with the design handoff's per-relationship permission grid. Removes the Cameron blind-spot and consolidates three today-scattered mini-panels.
8. **Migrate Plaid to `transactionsSync` + persist to a new `PlaidTransaction` model.** Unlocks Phase 1B (date filters, "All Time" with clear earliest-available), Phase 1C (matched/reviewed/split — hangs off a persistent bank row), and takes the Bank tab from live-fetch to a real ledger view. Single migration, single sync job, three UX wins.
9. **Lift `/api/messages/audience` filter shape into a first-class `MarketingAudience` type + optional saved row.** Reused by the new bulk-email path, the new campaign composer, and the members-page filter panel — one filter schema everywhere.
10. **Make `Guardian` a legacy read-only shim.** Phase 4 is a good time to declare `MemberGuardianUser` authoritative and stop writing to `Guardian` on new paths. Legacy reads keep working; new features don't have to keep two data models in sync.

---

## 2.4 — Required changes (migrations, backfills, indexes, permissions, APIs)

**All changes are additive** unless flagged. Existing rows keep working. No column drops, no enum shrinks, no destructive backfills.

### Migrations

| # | Migration | Type | Purpose |
|---|---|---|---|
| M1 | `Transaction.recordedByUserId TEXT?` + FK (soft) | Additive | Phase 1A — "staff who recorded" column for cash/offline rows. Nullable; historical rows stay null. |
| M2 | `Transaction.athletePayerSplit`: add `athleteMemberId TEXT?` (nullable) + keep existing `memberId` as beneficiary | Additive | Phase 1A + 4A — payer ≠ beneficiary. Backfill: for rows where `Member.responsiblePayerUserId` matches a User with a Member row, copy → athlete; else leave null. Nullable throughout; no consumer break. |
| M3 | `Transaction.refundedAmount NUMERIC?`, `refundedAt TIMESTAMPTZ?`, `refundReason TEXT?`, `refundedByUserId TEXT?` | Additive | Phase 1A — first-class refund/reversal. Backfill: rows with `reconciliationStatus=VOID` get `refundedAt = updatedAt` best-effort; otherwise null. |
| M4 | `Transaction.receiptUrl TEXT?`, `receiptSentAt TIMESTAMPTZ?` | Additive | Phase 1A — receipt status per Transaction (Expense has this; Transaction doesn't). |
| M5 | `PlaidTransaction` model + `PlaidSyncCursor` model + `Expense.matchedPlaidTransactionId TEXT?` | Additive | Phase 1B + 1C — persist Plaid transactions via `transactionsSync`, link Expenses to bank rows. New tables; no touch to existing tables beyond one nullable FK on Expense. |
| M6 | `Expense.reviewedAt`, `reviewedByUserId`, `excludedFromTax BOOL default false`, `taxCategory TEXT?`, `splits Json?` | Additive | Phase 1C — Money-Out matching/split/excluded flags. Existing rows continue to compute the way they compute today. |
| M7 | `TransactionCategoryRule` model (per-club auto-categorization rules) | Additive | Phase 1C — persist "vendor X → category Y" rules the owner accepts. |
| M8 | `AllTime` support: no schema change; index audit only | — | Phase 2 — verify indexes on `Transaction(clubId, createdAt)`, `Transaction(clubId, txDate)`, `Member(clubId, joinedAt)`, `AttendanceRecord(clubId, createdAt)` support unbounded scans with reasonable perf. |
| M9 | `EmailTemplate` model (per-club, kind enum) | Additive | Phase 3C |
| M10 | `MarketingAudience` model (per-club, filters JSON, name, isDynamic) | Additive | Phase 3D |
| M11 | `EmailImage` model (per-club UploadedFile subset, public URL) OR `/api/public/images/[imageId]` route on top of UploadedFile | Additive | Phase 3B/J — need unauthenticated URLs for `<img>` in email HTML. |
| M12 | `EmailSend` model (announcementId? campaignId? templateKey? recipient email, status DRAFT/QUEUED/SENT/DELIVERED/BOUNCED/FAILED/OPENED/CLICKED, providerMessageId?, sentAt, error) | Additive | Phase 3G — per-recipient delivery log. |
| M13 | `Announcement`: `status DRAFT/SCHEDULED/APPROVED/QUEUED/SENT/CANCELED` (default DRAFT for new rows; backfill existing: `SENT` if `publishAt < now`, else DRAFT). `senderUserId`, `approvalRequestedById?`, `approvedById?`. `bodyHtml TEXT?` (rich-text; keep legacy `body` populated as plain-text fallback so all legacy readers keep working). | Semi-additive | Phase 3B/C/H. Nullable additions + one enum with a default — existing rows are unaffected until the new UI reads them. |
| M14 | `EmailOptOut`: add `userId TEXT?`, `scope: TRANSACTIONAL/MARKETING/ALL default MARKETING`. Backfill existing rows to `MARKETING`. | Additive with backfill | Phase 3I. Existing behavior (marketing opt-out) preserved on backfill. |
| M15 | `MemberSubscription.payerUserId TEXT?` (nullable, no FK) | Additive | Phase 4A — per-sub payer distinct from beneficiary. Reads fall back to `Member.responsiblePayerUserId` when null. |
| M16 | `MemberGuardianUser.permissions Json?` (Book/Pay/Waivers/Messages) | Additive | Phase 4C — per-(child × co-guardian) grid. |
| M17 | `EventRegistration.status` becomes an enum (`REGISTERED, PAID, CANCELED, REFUNDED`) + `canceledAt` + `refundedAt` + `confirmationSentAt` | Semi-additive | Phase 5. Legacy string values `"REGISTERED"`/`"PAID"`/`"CANCELED"` map 1:1 to new enum members. |
| M18 | `EventRegistration @@unique([eventId, email])` — with dedup: if any dupes exist, keep newest and null the older stripeCheckoutSessionId | Non-trivial | Phase 5 — needs a pre-migration dedup script + report. |
| M19 | `Booking.bookedByUserId TEXT?` | Additive | Phase 5 + 4 — attribution parity with the earlier known gap. |

### Backfills

- **M2 (`athleteMemberId`)**: dry-run first — count rows where `memberId` is present, `Member.responsiblePayerUserId` resolves to a different User with a Member row in the same club. Populate best-effort; leave null when ambiguous.
- **M3 (refund fields)**: `reconciliationStatus=VOID` rows → `refundedAt = updatedAt`, `refundReason = 'reconciled_void'` best-effort. Non-VOID rows stay null. Never guess amounts.
- **M13 (`Announcement.status`)**: existing rows → `status = SENT` if `publishAt < now`, else `status = DRAFT`.
- **M14 (`EmailOptOut.scope`)**: every existing row → `MARKETING` (semantically correct — the system today only opt-outs marketing).
- **M18 (`EventRegistration` dedup)**: script that groups by `(eventId, LOWER(email))`, keeps the newest, null-out any stale `stripeCheckoutSessionId` on losers, writes to `MemberMigrationEvent`-style audit table (or just a BillingAuditLog entry). Must run in dry-run first with a per-club report.

### Indexes

- **Members**: `Member(clubId, migrationStatus)`, `Member(clubId, status, deletedAt)`, `Member(clubId, joinedAt)` — verify all exist for server-side pagination + status-count queries. Server-side listing with search will benefit from a `pg_trgm` index on `firstName || ' ' || lastName + email` (Postgres; check if extension is enabled on Supabase).
- **Transactions**: composite `Transaction(clubId, txDate)`, `Transaction(clubId, paymentSource, status)`, `Transaction(clubId, memberId, status)`.
- **EventRegistration**: after M18, `(clubId, eventId, LOWER(email))` unique; `(clubId, eventId, status)` for capacity queries.
- **Announcement**: `Announcement(clubId, status, publishAt)` for scheduler.
- **EmailSend**: `EmailSend(clubId, sentAt)`, `EmailSend(announcementId)`, `EmailSend(campaignId)`, `EmailSend(recipient, sentAt)` for dedup lookups + timeline queries.
- **PlaidTransaction**: `(clubId, plaidConnectionId, date)`, `(clubId, categorized, reviewedAt)`.

### Permission changes

- **`messages` sub-scopes** — `messages.bulk` (email bulk), `messages.marketing` (audiences, templates, campaigns), `messages.approve`, `messages.templates`, `messages.images`, `messages.unsubscribe`, `messages.analytics`. Implement as nested JSON under the existing `messages` key so legacy `messages: "send"` still works. `hasPermission` gains an optional 3rd arg (sub-scope).
- **`billing.transfer_subscription`** (Phase 4A) — the "assign membership to linked family member" flow. Owner + guardian-of-payer only.
- **`billing.mark_received`** already exists (2026-07-16 cash/check receipt flow) — verify it gates every Phase 1A "record received" surface.
- **New `PATH_PERMISSIONS` entries** (`lib/permissions.ts:101-125`) for `/dashboard/financials/{cash-offline,tax-summary,bank}`, `/dashboard/communications/{campaigns,templates,audiences,unsubscribes}`, `/dashboard/reports/all-time`.

### API updates

- `GET /api/members` — add `?page`, `?pageSize`, `?search`, `?filter=<key>=<val>&…`, `?sort=`. Return payload adds `tracks: {role, membership, accountSetup}` and `nextAction: {label, kind, permission}` per row. Also `pagination: {total, page, pageSize}` + `counts: {everyone, athletes, parents, accountHolders, prospects, inactive}` (server-computed for the segmented control).
- `GET /api/members/[id]` — include `guardianLinks: { include: user }` + `user: { include: { guardianOf: { include: { member: true } } } }`. Add `tracks + nextAction` to top level.
- `POST /api/members/bulk` — add `action: "email"` + `emailKind: TEMPLATE_ID or "custom"`.
- `POST /api/announcements` — accept `bodyHtml`, `templateId?`, `audienceId? | audienceFilters?`, `personalization` map, `scheduleAt?`, `requiresApproval?`. Enqueue an `EmailSend` per resolved recipient rather than inline-sending. Deliver via a background worker (Netlify scheduled function or a `/api/cron/email-queue` route protected by `CRON_SECRET`).
- `GET /api/messages/audience` — reused; add `?saveAs=<name>` to persist a `MarketingAudience`.
- `GET /api/plaid/transactions` — replace 30-day live-fetch with a query over the new `PlaidTransaction` table + range params + pagination. Add a `sync` endpoint that runs `transactionsSync` for one connection.
- `POST /api/plaid/expenses/match` — accept `{ plaidTransactionId, expenseId | createExpense: {…}, split?: [{amount, category}] }`.
- `POST /api/member-subscriptions/[id]/transfer` — new Phase 4A endpoint. Owner OR authorized guardian, preview + confirm, allowed only for eligible subs (defined below), attributes to actor, writes `BillingAuditLog`. Refuses live Stripe subs by default unless the caller is Owner AND explicitly accepts the "beneficiary label only — Stripe keeps billing the original customer" caveat.
- `POST /api/public/events/[slug]/confirm` — new server confirmation lookup called by the success page to poll for the actual DB row (fixes race). Or ship a dedicated `/e/[slug]/registered/[registrationId]` route that server-renders the confirmation from real state.
- `POST /api/events/registrations/[id]/resend-confirmation` — used by the profile Communications tab and by fix-up UIs.
- `PATCH /api/announcements/[id]/schedule`, `POST /api/announcements/[id]/send`, `POST /api/announcements/[id]/cancel`, `POST /api/announcements/[id]/approve` — separate the lifecycle from bare CRUD.

---

## 2.5 — UI-only vs backend/schema classification

| Issue | Class | Notes |
|---|---|---|
| 1A — Stripe tab filtered to `paymentSource=STRIPE` | UI + API | Add a query param; no schema change. |
| 1A — Cash & Offline tab | UI + API | Uses existing fields except recorded-by (M1), athlete-vs-payer (M2), receipt (M4), refund (M3). |
| 1B — Plaid date filters | UI + Backend | Requires `PlaidTransaction` (M5) + `transactionsSync` migration. |
| 1C — Money Out matching, split, reviewed, categorized, transfer | UI + Backend | Requires M5 + M6 + M7. |
| 1D — Tax Summary (bank-based, no double-count) | UI + Backend | Uses new `PlaidTransaction` + Expense.excludedFromTax + `MarkedAsTransfer` flag (M6). |
| 1E — Mobile Financials | UI-only | Card layout on <md; use existing `useMediaQuery` pattern. |
| 2 — Reports (all-time + expanded) | UI + Backend | 12-month chart to honor range; add "all-time" mode; possibly a saved-view model. **Blocked on missing Reports design handoff.** |
| 3A — Bulk email from Members page | UI + Backend | `bulk` action `"email"` + composer reuse. |
| 3B — Rich composer | UI + Backend | `bodyHtml`, image library (M11), sanitize. |
| 3C — Templates | UI + Backend | M9. |
| 3D — Dynamic recipient groups + saved audiences | UI + Backend | M10. |
| 3E — Household + per-guardian targeting | UI + Backend | Reuses `guardianLinks` + adds sender-target enum. |
| 3F — Personalization tokens | UI + Backend | Interpolation lib + preview endpoint. |
| 3G — Per-member communication history | UI + Backend | M12 (`EmailSend` per-recipient log). |
| 3H — Drafts, schedule, approval, idempotent send | UI + Backend | M13 (Announcement lifecycle) + queue endpoint. |
| 3I — Unsubscribe scope, transactional vs marketing | UI + Backend | M14. |
| 3J — Attachments & links & images | UI + Backend | M11 + validation. |
| 3K — Pre-send checks + final review | UI-only | Pure validation layer over composer. |
| 3L — Communications permissions | Backend | Sub-scopes on `messages` key. |
| 3M — Mobile composer | UI-only | |
| 4A — Membership transfer to linked family | UI + Backend | New endpoint + M15. |
| 4B — Same-email family onboarding | UI-only | The onboarding logic already links; the dashboard profile just doesn't show it. Fix the read (`GET /api/members/[id]` include) + render. |
| 4C — Relationship permissions grid | UI + Backend | M16. |
| 5 — Registration confirmation | UI + Backend | Bug fixes + `EmailSend` idempotency + server-rendered confirmation lookup + M17/M18/M19. |
| 6 — Safety & tests | Backend + Testing | Idempotency-key on money POSTs; per-recipient email dedup; unique constraints; regression tests. |

---

## 2.6 — Risky assumptions & open questions

**Risky assumptions to challenge before writing code:**

1. **"Stripe events only" on the Stripe tab is truly the desired scope.** Some clubs record CARD payments as `EXTERNAL_READER` at the door (Square, terminal) — are those "Stripe-like" for the owner or genuinely "offline"? Plan §1A says offline; verify by asking the owner.
2. **Bank-based Tax Summary must not silently exclude cash income the owner recorded in AthletixOS** (plan §1D). Current draft leaves cash off the bank-based summary "unless the owner separately recorded and categorized them as cash income" — the flow to categorize cash as tax income doesn't exist yet. Needs an explicit toggle.
3. **Plaid `transactionsSync` migration is one-way per Item.** Once we've called `sync`, Plaid updates the cursor and legacy `transactionsGet` calls can still work but they return a fixed window. Test in sandbox before flipping production connections.
4. **"All time" reports on a 500+ member roster with 10k+ transactions** — verify query performance before shipping. `Transaction.txDate` may need a partial index by clubId.
5. **Marketing opt-out backfill (M14) applies retroactively to what today are transactional-adjacent emails** (welcome, payment failed). If we widen `EmailOptOut` enforcement to any marketing kind, we must classify each `sendXxx` helper as transactional or marketing to avoid regressing legitimate transactional delivery.
6. **Membership transfer on a live Stripe subscription** — the plan says "Do not rewrite payment ownership." Today's owner endpoint refuses live Stripe subs (safe); the guardian endpoint silently repoints memberId (unsafe: Stripe keeps billing the original customer, and now the AthletixOS side thinks it's paying for the child). Need explicit UI + audit + billing-admin coordination.
7. **The design handoff describes retiring `migrationGroup` / `migrationFinalAction` / `readiness` from UI, keep columns.** Confirm we do not read these anywhere the redesign wants to remove — grep before deletion.
8. **`stripeInvoiceId` on Transaction is not unique** (dedup is app-side) — this is deliberate per CLAUDE.md but a future consumer that grows to expect uniqueness will break. Consider adding a `@@unique` after auditing for any legit non-invoice rows.
9. **`Booking @@unique([eventId, memberId])`** means a member cannot register for the same event twice, even if the event is a multi-session series where re-registration might be legitimate (rare). Verify with owner before treating as invariant.
10. **`MemberGuardianUser.permissions Json?` (M16)** — is this the right model, vs a per-(guardian × child) row in a separate `GuardianAccess` table? A JSON blob is faster but harder to query. Choose based on whether we'll ever need "find every child where guardian X has Book but not Pay" — if yes, use rows; if no, JSON is fine.
11. **`Announcement.status = SENT` backfill assumes any `publishAt < now` announcement was sent.** True today because there's no "scheduled but not sent" state — but if an owner has drafts with a past `publishAt` and no email, they'll be relabeled SENT. Low risk (drafts today have `publishAt = null`); verify with a pre-migration count.
12. **Reports handoff missing.** Building Phase 2 without it means guessing the intended report set. **Blocker for Phase 2 start.**

**Open questions for the owner:**

- On the design handoff: which status treatment (`1b` A vs B vs C)? Which profile structure (`1c` tabs vs `1d` scroll+rail)? Rename Prospect? Person-type labels?
- Coach-restricted audiences (Phase 3L): what defines a coach's "assigned members"? Enrollment in their taught classes/events + private-lesson relationships? Or explicit `StaffProfile.audienceRule`?
- Approval workflow (Phase 3H): default off, or on for certain roles? Which roles can approve — owner only, or `messages.approve` sub-scope?
- Refund UI on Transaction (M3): does the owner want a full refund workflow in AthletixOS (with a Stripe refund call) or just a "mark refunded" flag? Today the plan implies the flag; a Stripe refund call is a substantial new feature.
- Membership transfer eligibility (Phase 4A): what disqualifies a sub? "Already used" — does that mean "has any attendance recorded under this sub"? Or "has been billed at least once"? Or "is in commitment period"? Multiple candidate rules.
- Confirmation-page polling vs webhook wait (Phase 5): willing to add a 3-5s wait state with a spinner + "your registration is being processed" if the webhook hasn't landed, vs eagerly show success and let the email be the source of truth?

---

## 3. Design handoff conformance notes

The Members handoff (`docs/improvement/design_handoff_members_experience/README.md`) is complete and prescriptive. Key implementation implications already captured in the plan below:

- Server-derive the three tracks (`role`, `membership`, `accountSetup`) in `GET /api/members` — see M-none (no migration; just derivation) + the `serializeMemberForList` helper.
- Server-side pagination + search + filter + counts (segmented control uses per-segment count).
- `nextAction(member)` resolver in `lib/memberDisplay.ts` — one shared source for the row action button, the profile next-action banner, and the mobile card next-action.
- Query-scoped selection (send `filter + count`, not 500 ids) — implement as a `selection: {mode:'ids'|'allMatching', filter, count}` shape at the API boundary.
- Retire `migrationGroup` / `migrationFinalAction` / `readiness*` from the UI; keep columns. Grep every reader first.
- Import source label (`Import.sourceLabel`) — not modeled today; the plan schema will need an `Import` model (per-batch, per-club) so the UI can label "As imported from <Owner-typed source>" without hardcoding a vendor name.
- Migration timeline needs `reviewedAt/reviewedById` (step 2), invitation delivery `delivered/opened/bounced` per send (drives "Blocked" state), `blockedReason` enum, `snoozedUntil`.

**Reports handoff — NOT in the repo.** Phase 2 planning is on hold pending that document. §7 of the plan explicitly says "Before implementing, review the Reports design handoff and report back with the full list of reports, metrics, filters, and export options it specifies, plus anything you recommend adding."

---

## 4. Working notes for the plan

- Every migration goes through the hand-write SQL + `migrate deploy` path because Supabase's shadow DB is blocked.
- After every migration, run `npx prisma generate && npx tsc --noEmit && npm run build` before continuing. Delete `web/*.tsbuildinfo` if a suspiciously clean tsc follows an edit (stale incremental cache).
- Follow the "additive first, remove later" pattern from the 2026-07-15 status-truth batch: new column → dual-write → new readers → retire old readers → drop old column (usually never).
- Use `baseUrlFromRequest(req)` in every new user-facing URL built in a route handler (Phase 5 fix); reserve `getAppBaseUrl()` for webhooks/cron.
- Every mutation on a migrating member or on a Transaction must write to the corresponding audit log (`MemberMigrationEvent`, `BillingAuditLog`).
- New idempotency-keyed writes (bulk send, subscription transfer, event registration) use `client-generated-key + server-validated-context` — the pattern from `/api/attendance/charge-card` (`clientKey`).
- Do not couple Phase 1B (Plaid) with Phase 1C (matching) in the same PR unless we're confident in the sync-vs-get switchover. Ship 1B (persistence + wider window) first, 1C (matching UX) second.

---

*Discovery complete. See `PROGRESS.md` for the phased implementation plan.*
