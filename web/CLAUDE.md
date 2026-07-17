# AthletixOS Project Context

**2026-07-17 (later) — Hourly event-charge scheduler + event payroll (guest clinicians) + reusable event documents (branch `claude/event-scheduler-payroll-docs`). ONE additive migration added AND APPLIED via Supabase MCP (+bookkeeping, checksum `b59cf5c8…`): `20260718000000_event_comp_documents` (`transactions.eventId/refundedAmount`; `events.compNoRefunds`; `documents.appliesToAllEvents/eventRequirement`; new `event_comp_assignments` + `event_document_links`).**

1. **Scheduler**: the repo's FIRST Netlify scheduled function — `netlify/functions/event-charges-cron.mts` (current .mts format, in-code `export const config = { schedule: "0 * * * *" }`, `Netlify.env.get()`, zero new deps). It is ONLY an HTTP wrapper: POSTs `/api/cron/event-charges?limit=50` on the site's own `URL` with `Authorization: Bearer CRON_SECRET`. All idempotency lives in the route (see the double-charge defence rules below), so duplicate/failed runs log but never double-charge. Cron is **UTC**; charges land within ~1h after `scheduledChargeAt`. **`CRON_SECRET` lives ONLY in the Netlify environment — never commit it, never write it into code, docs, or tests.**
2. **Event payroll — `lib/eventComp.ts` is the model (PURE — keep prisma out).** `EventCompAssignment` = who works an event (STAFF userId or CONTRACTOR contractorId — guest clinicians are `Contractor` rows) + method (FLAT $ | PERCENT % | NONE informational) + basis. **Revenue basis rules (owner-approved): GROSS_COLLECTED = actually collected, after discounts and after refunds/chargebacks, before processing fees; NET_COLLECTED = gross − known `stripeFeeAmount`. Pending cash/check, failed and abandoned payments NEVER count** (only SUCCEEDED/REFUNDED, non-VOID, non-REVIEW `transactions.eventId` rows). Refunds reduce the basis via `Transaction.refundedAmount`, maintained by NEW webhook handlers `charge.refunded` (partial→refundedAmount; full→status REFUNDED too) and `charge.dispute.created` (chargeback = refund + REVIEW flag) — **do NOT assume SUCCEEDED-only filters exclude refunded money**; a partially-refunded row stays SUCCEEDED on purpose. `events.compNoRefunds` = owner's explicit NO-REFUNDS checkbox (percent comp ignores clawbacks). **`transactions.eventId` must be stamped on every event-money Transaction create** (webhook event branches, auto-charge, offline pending, at-the-door) — attribution starts 2026-07-17; older rows are null. "Create payout records" (`POST /api/events/[id]/comp/generate-payouts`, finances:edit) mints PENDING `Payout` rows (kind EVENT, payeeType STAFF/GUEST) reviewed on the existing payouts page; `assignment.payoutId` (unique) is the never-pay-twice guard. **Nothing ever auto-sends money.** Comp routes are finances-gated, NOT events-gated — a coach who edits events must not set their own pay. Tests: `npx tsx scripts/event-comp-tests.ts` (21).
3. **Event documents — `lib/eventDocuments.ts`.** Reuses the EXISTING Document/DocumentSignature system (guardian rules, drawn signatures, `signatureValidForDays` expiry, audit): `documents.appliesToAllEvents` auto-covers future events until unset; `EventDocumentLink` scopes to one/selected events (event card → Documents button; the document editor shows linked events). `documents.eventRequirement`: INFO (display) | ACKNOWLEDGE (tick to register — recorded as a typed-acknowledgement DocumentSignature upsert) | SIGN_REQUIRED (valid signature blocks member registration AND event check-in; check-in gate fails OPEN on lookup errors). **Anonymous public registrants can only acknowledge** (stamped into `formResponses.__documentsAcknowledged`) — a full audited signature needs an account; don't build anonymous e-sign.
4. **Operator steps (Julian)**: (a) verify `CRON_SECRET`'s env scope includes Functions; the scheduled function registers itself on the next production deploy — no other Netlify setting. (b) **Add `charge.refunded` + `charge.dispute.created` to BOTH Stripe webhook endpoints' event lists** (platform + Connect) or refunds won't reduce comp bases.

**2026-07-17 — Event registration requires a payment decision (branch `claude/event-payment-decision`). ONE migration added AND APPLIED via Supabase MCP (+ `_prisma_migrations` bookkeeping, checksum `4babc385…`): `20260717000000_event_payment_decision` — additive only (`events.paymentMethods/autoChargeDate/requirePaymentBeforeCheckin`; `event_registrations.paymentMethod/autoChargeConsent/scheduledChargeAt/chargeAttempts/lastChargeError/paidAt/paidVia/receivedById/checkReference/transactionId` + 2 indexes). No row rewritten; all 6 existing events read `paymentMethods=null` → card-only (pre-feature behavior). Tests: `npx tsx scripts/event-payment-tests.ts` (40).**

**EVENT PAYMENT RULES (`lib/eventPayments.ts` is the model — no second event payment system):**
1. **Owners configure per event** which methods registration offers: `CARD | AUTO_CARD | CASH | CHECK` (Events editor → "How registrants may pay"). **null/empty = `["CARD"]`** — every pre-existing event behaves exactly as before. At least one method must stay enabled.
2. **Registrants must decide when money is owed.** Free / membership-covered / variable-cost (billed-later) registrations never ask. Server picks for them only when exactly one method is selectable; otherwise 400 `PAYMENT_METHOD_REQUIRED` (member route returns `options` — the UI prompt is driven by the server so the choice can't drift from what it accepts).
3. **Status is the money truth** (`EventRegistration.status`): `PENDING_PAYMENT` (card checkout started, NOT finished — holds no spot, owes nothing, excluded from capacity counts; this is the College-Combine bug class) → `PAID` via webhook. `SCHEDULED` (AUTO_CARD consented) · `AWAITING_CASH`/`AWAITING_CHECK` · `PAYMENT_FAILED` · `PAID` · `CANCELED`. `ACTIVE_/UNPAID_REGISTRATION_STATUSES` are the only membership tests — never hand-roll `status !== "PAID"`.
4. **AUTO_CARD** requires a chargeable saved card (`resolveChargeablePaymentMethodId`) **and** explicit client consent (stored as an audit snapshot in `autoChargeConsent`: at/userId/email/ip/userAgent/buttonLabel/amount/chargeOn). Charges run in `lib/eventAutoCharge.ts` — off-session PaymentIntent, `aox-eventreg-<id>-a<attempt>` idempotency key, prior-PI retrieve-before-create, exactly one VERIFIED Transaction (dedup on PI id) + receipt + `EVENT_AUTO_CHARGED` audit. Decline/no-card ⇒ `PAYMENT_FAILED` + a fresh Checkout payment link emailed (the normal billing workflow), never a silent retry loop.
5. **There is still NO cron.** Due charges run via (a) lazy sweep when the registrations roster loads (`runDueEventCharges`, capped at 3/open + `maxDuration=60` so Stripe round-trips can't 500 the page) and (b) `POST/GET /api/cron/event-charges` gated on `CRON_SECRET` (**503 when unset — never open by default**; constant-time compare) for an external scheduler. Both are idempotent. **OPERATOR: set `CRON_SECRET` in Netlify + point a scheduler at it hourly** for timely charges; without it charges still run whenever staff open the roster, and `EVENT_CHARGE_OVERDUE` surfaces anything stuck >24h.

**DOUBLE-CHARGE DEFENCE (the rules that keep `lib/eventAutoCharge.ts` honest — do not weaken):**
- **Never rotate the idempotency key on an unresolved attempt.** Ambiguous errors (timeout/5xx/connection drop) may mean Stripe charged and we lost the response. `chargeAttempts` is bumped ONLY after a *definitively dead* PaymentIntent (canceled / requires_payment_method) or a real decline. Use `noteChargeError()` — never a raw `chargeAttempts: { increment: 1 }` — on an unresolved path. (The first cut of this code did the opposite and would have double-billed on a timeout.)
- **Fail CLOSED when a prior charge can't be verified**: a stored-PI retrieve that throws, or a metadata search that errors, returns without charging. Layering: <24h Stripe replays the key; >24h the `metadata['eventRegistrationId']` search finds the orphan; if neither can answer, don't charge.
- **Every unresolved attempt must be visible** — `lastChargeError` + the `EVENT_CHARGE_OVERDUE` probe. Failing closed silently is money quietly never collected while the client thinks they've paid.
- **Offline money has no unique key** (unlike `stripePaymentIntentId @unique`), so `/offline-payment` claims the registration with a conditional `updateMany` before any money write — a double-click at the front desk must not book the same cash twice.
- **Capacity**: use `capacityWhere()` — in-flight card checkouts hold a spot for `CHECKOUT_HOLD_MS` (30 min), abandoned ones release it. Dropping in-flight rows entirely lets N people pay for one spot (N-1 refunds); counting them forever burns spots on abandoned checkouts. Both are bugs; the hold is the fix.
- **A confirmed Stripe payment must NEVER produce zero rows.** Payment landing on an already-PAID registration writes a REVIEW-flagged Transaction (it counts as revenue — the money really arrived — until refunded) + `EVENT_DUPLICATE_PAYMENT` in the Action Center. Note `EXCLUDE_VOID` only filters VOID; REVIEW is *not* excluded from revenue.
6. **Cash/check acceptance ≠ payment** (identical rule to memberships): registration confirms as `AWAITING_*` + ONE **PENDING** offline Transaction (`type:"EVENT"`, `category:"events"`, paymentSource CASH/CHECK, `reconciliationStatus:"OFFLINE"`, `manual:true`) = amount due, never revenue, no receipt. Staff records receipt via `POST /api/events/[id]/registrations/[regId]/offline-payment` (**billing:full**) → Transaction SUCCEEDED (+txDate, check ref, receiver audited) → registration PAID → receipt "… Paid by Check" + `EVENT_OFFLINE_PAYMENT_RECEIVED` audit. Keyed on the REGISTRATION (not the member) because registrants are often not members — `Transaction.memberId` is nullable.
7. **Never double-collect**: `SCHEDULED` is excluded from `bill-registrants` targets (server + UI); a registrant who chose cash but pays online has their PENDING offline row VOIDed by the webhook.
8. **`requirePaymentBeforeCheckin`** (owner opt-in) blocks check-in via the single gate `checkinPaymentBlock()` (402 `PAYMENT_REQUIRED`). `SCHEDULED`/`PAID` never block (money is committed); it **fails OPEN** with no registration row or $0 due — a payment setting must not lock out membership-covered/free/staff-added attendees.
9. Public `/e/[slug]` never offers AUTO_CARD (anonymous, no saved card). A club with no Stripe Connect can only offer cash/check; card-only + no Stripe = 503 with a "contact the club" message rather than a half-registered stranding.
10. The public-registration webhook branch now sends a **receipt** (it never did) and stamps `paidAt/paidVia/transactionId`.

**2026-07-16 — Staff payment-method control + discount dropdown + cash/check receipt flow (branch `claude/staff-discount-picker`). THREE migrations added AND APPLIED via Supabase MCP (+bookkeeping): `20260716000000_offline_payments_discount_identity` (clubs.offlineActivationPolicy; transactions.discountCode/discountAmount), `20260716010000_member_discount_code` (members.migrationDiscountCode).**

**SHARED PAYMENT/DISCOUNT RULES:**
1. **`lib/staffPayments.ts` is the ONLY model** for staff payment methods (SAVED_CARD/NEW_CARD/CASH/CHECK/EXTERNAL_READER), payment states (Client accepted / Awaiting cash / Awaiting check / Paid — "Approved" NEVER means paid), discount resolution (`resolveStaffDiscount` — invalid code = HARD block, one discount max, no stacking by construction), and pricing quotes (`quotePayment` — clamps ≥$0, refuses sub-$0.50 card charges; offline records have no minimum). No page implements its own variant.
2. **Discount dropdown**: `GET /api/discounts/eligible?itemType=&membershipId=` (billing:view) feeds every staff surface; clients keep type-a-code. Amounts always recomputed server-side; codes only cross the wire. Identity persists: `transactions.discountCode/discountAmount`, MemberSubscription discount columns, checkout `metadata.discountCode` → webhook stamps it, receipts say "<name> Discount Applied".
3. **Offers freeze `paymentMethod` + `discount`** (with server math: amountOff/finalPrice); `offerEffectivePrice(offer)` is what the client pays (card charge, offline amount due, email/page display). Changing method or discount stales open offers (diffOffer) → regenerate new version. A stored-but-now-invalid discount BLOCKS offer creation (400 DISCOUNT_INVALID), never silently drops.
4. **Cash/check acceptance ≠ payment**: confirm creates the MANUAL sub (status per `clubs.offlineActivationPolicy` — default ON_PAYMENT = pending, member NOT active) + ONE PENDING Transaction (paymentSource CASH/CHECK, OFFLINE) representing the amount due — never revenue, no receipt. Staff records physical receipt via `POST /api/members/[id]/offline-payment` (billing:full): Transaction → SUCCEEDED (+txDate, check #/ref, receiver audited), pending sub → active, member recomputed, receipt email "… Paid by Check". ON_ACCEPTANCE (explicit owner setting, Settings → Billing) activates at confirm with payment still due. NO Stripe object for cash/check ever.
5. **billing-admin PATCH** gained `discountCode` (validated) + `paymentMethodPreference` (CARD/LATER/CASH/CHECK → member.requestedPaymentMethod) — both money-gated (billing:full), audited, never charge.
6. Tests: staff-payment quote/label/staleness cases appended to `scripts/billing-admin-tests.ts`.

**2026-07-15 (later) — Status truth, profile labels, guardian accounts, "Continued membership" eliminated (branch `claude/status-truth-fixes`). NO schema change.**

**STATUS & PROFILE RULES (owner-defined; enforce everywhere):**
1. **ACTIVE ⇔ valid membership.** Only a real active subscription (Stripe, manual, or DELIBERATE $0) makes a member ACTIVE. PROSPECT = never had a valid membership (may still have completed profile, guardian, saved card, login, attendance). INACTIVE = a membership ended. "Migrating" is a display bucket only while migration is genuinely in process. Profile approval, signup, saved cards, and guardian accounts NEVER set ACTIVE — member self-signup now creates PROSPECT (was the Kelly-Merrill ACTIVE bug, `app/api/member/signup/route.ts`).
2. **"Continued membership" is DEAD.** `resolveOfferPricing` returns `configured:boolean`; unconfigured members have NO membership — billing-admin returns `billing.configured:false` with null plan/price, UIs show "No membership" (never "Free"/"charges immediately"), reactivation create returns 400 `PLAN_REQUIRED`, and migration approve refuses to mint placeholder plans (409 `PLAN_REQUIRED` when no plan and no imported plan name).
3. **Approval ≠ activation.** `POST /api/members/migration/[id]/approve` with `{profileOnly:true}` closes the review (APPROVED + COMPLETED) with NO membership/subscription/charge — the member stays PROSPECT. The approvals station offers "Approve profile (no membership)" for unconfigured members; billing activation stays a separate explicit action.
4. **ONE profile-label vocabulary** (`onboardingStatusOf`, members page): "Profile completed" (activatedAt | migrationStatus ACTIVATED/COMPLETED | userId | minor with a registered guardian link via new `hasGuardianAccount`), "Invited"/"Un-invited" ONLY for migration-outreach members, "Profile incomplete" for manually-added members. Never the bare "Completed" label. Membership status chips stay separate.
5. **Guardian-only accounts are not members.** PARENT signups create a User with NO member row; on signup every child whose `guardianEmail` matches is auto-linked (owner-vouched `requestGuardianLink` sweep). A guardian becomes an adult member only by explicit action (self-profile, purchase, or staff add).
6. **Attendance add-panel**: one "Drop-in" action (Present · Trial · Drop-in) containing all payment choices (cash/check/saved card/external reader/comp/invoice + a separated "Or open a Stripe checkout page" tier section). Behavior unchanged.
7. **Data corrections** for existing bad rows go through `scripts/fix-status-truth.ts` (dry-run default, allowlist `--apply --members`, audit rows, nothing hard-deleted): PLACEHOLDER (cancel $0 "Continued membership" subs → PROSPECT), PROFILE_ONLY (close review, no billing), GUARDIAN_FIX (link guardian to child, soft-hide the guardian's member row), LINK_PLAN (point member.membershipId at their real sub's plan).

**2026-07-15 — Billing truth & revenue reliability (branch `claude/athletixos-billing-reliability-3d57df`). TWO migrations added AND ALREADY APPLIED via Supabase MCP (+ `_prisma_migrations` bookkeeping, checksum-verified): `20260715000000_billing_truth` (transactions: `stripeFeeAmount/netAmount/paymentSource/reconciliationStatus` + deterministic backfill + index) and `20260715010000_reactivation_change_request` (membership_reactivations: `changeRequest/…Status/…At/…ResolvedAt/…ResolvedById`). Full Phase-0 audit: `docs/billing-truth-audit-2026-07-14.md`. Approved production data corrections applied via MCP with BillingAuditLog rows: Drayke Ulrich + Milo Brehm $40 attendance-"Card" transactions → `reconciliationStatus=VOID` (rows preserved); Titus Hall's stale DRAFT reactivation → CANCELED (his self-serve sub/payment untouched). NO client was charged/emailed/refunded.**

**BILLING SOURCE-OF-TRUTH RULES (enforce on every future change):**
1. **Stripe is authoritative** for card charges, subscriptions, invoices, refunds, processing fees, payment status. `Transaction.stripeFeeAmount/netAmount` come ONLY from balance transactions (`lib/stripeTruth.ts moneyFactsFor*`) — never computed locally. `platformFee` = AthletixOS application fee (separate concept).
2. **NEVER read `invoice.subscription` / `invoice.payment_intent` directly.** Webhook events arrive on Stripe API `2026-02-25.clover` where those fields moved to `invoice.parent.subscription_details.*` / `invoice.payments`; the pinned SDK (14.25.0, apiVersion 2023-10-16) still RETRIEVES legacy shapes. Always use `invoiceSubscriptionId/invoicePaymentIntentId/invoiceSubscriptionMetadata` from `lib/stripeTruth.ts` (tests: `scripts/stripe-truth-tests.ts`). Reading the dead top-level fields silently dropped 93% of card revenue (audit 2026-07-14).
3. **Payment-source vocabulary lives in `lib/paymentSources.ts`** — `paymentSource` (STRIPE | CASH | CHECK | EXTERNAL_READER | COMP | MANUAL_ADJUSTMENT) + `reconciliationStatus` (VERIFIED | OFFLINE | UNVERIFIED | REVIEW | VOID). Only `verifiedStripeTxFields()` may mark a row STRIPE/VERIFIED. Attendance "Card (external)" = `CREDIT` method → EXTERNAL_READER/UNVERIFIED: **record only, AthletixOS never charges it, and it must never blend into verified card revenue.** Every revenue aggregate excludes `reconciliationStatus=VOID` (`EXCLUDE_VOID`).
4. **One Transaction per Stripe payment**, deduped by `stripeInvoiceId` (subscriptions) / unique `stripePaymentIntentId` (one-time + saved-card). `invoice.paid` owns ALL subscription money and now also sends the receipt (`sendPaymentReceiptEmail`); checkout branches own one-time money and stamp exact fee/net from the session's PI.
5. **Reconciliation**: `lib/stripeSync.ts` — `reconcileClubBilling` (subscriptions → snapshots + review rows) and NEW `compareClubCharges` (charge-level: missing local Transactions, unmatched local Stripe-claims, duplicates, unrecorded refunds, fee gaps) + `fillChargeFees` (the ONLY write: fills null fee/net/chargeId on matched rows, audit-logged). Surfaced on Financials → Stripe tab ("Reconciliation" card, `/api/stripe/reconcile/charges`). Missing Transactions are recovered ONLY via `scripts/backfill-stripe-transactions.ts` (allowlist-REQUIRED `--apply --invoices in_…`, dry-run default, dedup by invoice id, audits).
6. **Auto Renew**: `Membership.autoRenewDefault` is honored on EVERY path — self-serve/owner Checkout (webhook applies `cancel_at_period_end` after creation; `subscription_data.cancel_at_period_end` is NOT a valid Checkout param and 500s the session — never re-add it), migration approve + reactivation confirm (Stripe `cancel_at` / MANUAL `endDate` at commitment date, else first billing period via `addBillingPeriod`). Offers freeze `autoRenew` in the snapshot; flipping the plan setting stales open offers.
7. **Fee passthrough display**: club passes 2.9% (`lib/fees.ts`, the only fee-math location; `feeBreakdown()` for display). Every owner/client surface shows base + processing fee + total charged so local `price` ($530) vs Stripe charge ($545.37) never looks like a bug. Club nets slightly under sticker (no 30¢/gross-up) — owner-accepted 2026-07-15.
8. **Attendance saved-card charging** (`/api/attendance/charge-card`, billing:full only): GET preview (card brand/last4/cardholder, payer's other athletes, server-allowed prices, fee breakdown) → POST with client-generated `clientKey` (idempotency), server-validated amount (must match configured item prices), off-session PaymentIntent, explicit outcomes (succeeded/declined/requires_action/processing), exactly one VERIFIED Transaction + receipt + `ATTENDANCE_CARD_CHARGED` audit on confirmed success. No saved card → email a Stripe Checkout link via `/api/attendance/send-payment-link` (checkout.stripe.com URLs only; existing class-charge route mints them — no second billing engine).
9. **Group A/B/C are deprecated** (one-time WL migration shorthand): hidden from UI/exports (`displayGroupLabel`, `OPERATIONAL_GROUPS`), still stored/accepted for back-compat and honored by `deriveReadiness`. UI offers operational states only (Leave alone / Future follow-up / Needs payment method).
10. **Approvals = billing review station**: MIGRATION_BILLING cards expand a review panel fed by `GET /api/members/[id]/billing-admin` (the one authoritative billing service) with links into the billing center; offer create/preview/send reuses the reactivation engine. Editing never charges — only client confirmation or explicit owner activation does.
11. **Client change requests** (`POST /api/reactivate/[token]/change-request`): no price field, never mutates billing; sets `changeRequestStatus=OPEN` which LOCKS confirm (409 CHANGE_REQUEST_PENDING). Owner resolves via `POST /api/members/[id]/reactivation/change-request` — DENY unlocks the original; APPROVE regenerates a new offer version from the CURRENT setup (old token stale) for preview + send. Surfaced in Approvals (kind REACTIVATION_CHANGE_REQUEST).

**Operational notes:** Michael Lister's sub renews $545.37/quarter (~Oct 13); Orson Chorba's trial ends 2026-07-24 (deploy CP1 before then or recover via backfill); the 3 missing Transactions ($5.15 / $545.37 / $1,543.50) await the owner-approved backfill run after deploy. Tests: `npx tsx scripts/billing-admin-tests.ts` (88) + `npx tsx scripts/stripe-truth-tests.ts` (23).

**2026-07-10 — Billing control center + reactivation flow (branch `claude/athletixos-billing-reactivation-ecc23d`). ONE migration added AND ALREADY APPLIED (via Supabase MCP + `_prisma_migrations` bookkeeping row, checksum-verified — direct DB connections unreachable from the sandbox): `20260710000000_billing_control` (7 nullable `members` columns: `migrationGroup/FinalAction/GroupNote/FinalBillingDate`, `responsiblePayerUserId`, `billingUpdatedAt/ById`; new append-only `billing_audit_logs`; new `membership_reactivations`). NO live subscription/member was charged, approved, emailed, converted, or mutated during this build; Joseph B. / Mack M. / Sawyer M. untouched; no apply-mode script was run. Plan doc: `docs/billing-control-plan.md`.**

1. **New `billing` permission key** (`lib/permissions.ts`, levels none|view|full, DEFAULT none) — explicit financial control over member billing, distinct from `finances`. Staff editor picks it up from the catalog automatically. **Money-mutating routes now require it**: migration **approve** (was members:edit — a coach with members:edit can no longer start charges), billing-admin PATCH money fields, payment-method actions, reactivation create/send. Triage-only fields stay members:edit. Owners bypass as always.
2. **Billing control center** at `/dashboard/members/[id]/billing` (entry points: member-profile "Manage billing", migration drawer "Billing center", roster per-row "Billing", duplicates "Review billing" + a client-side "Billing conflict" badge when ≥2 dupes both carry memberships/payments). Data from `GET /api/members/[id]/billing-admin` (billing:view): mode/readiness/pricing/dates/guardians/payer/subscription snapshots/PM list/reactivation status/merged history (BillingAuditLog + MemberMigrationEvent). **No raw Stripe ids leave the server — payment methods are addressed by an opaque sha256 `ref`** (`pmRef` in `lib/billingAdmin.ts`; server re-lists and matches via `lib/paymentMethodsAdmin.ts locatePaymentMethod`). `PATCH` supports `preview:true` → before/after diff without writing (drives the confirm dialog); real writes stamp `billingUpdatedAt/ById`, write a `BillingAuditLog` row (`lib/billingAudit.ts writeBillingAudit` — EVERY billing mutation must), and a NOTE MemberMigrationEvent so the roster "Set up by" badge stays truthful. `POST …/billing-admin/actions`: `cancel_pending_activation` (token invalidated, history preserved), `reassign_subscription` (MANUAL/pending subs only; live Stripe subs are refused).
3. **Payment methods** (`/api/members/[id]/payment-methods/…`): `setup` opens a SETUP-mode Stripe Checkout on the connected account with `metadata.adminCardSetupMemberId` + intent ADD|REPLACE — a NEW webhook branch captures it (ADD → member pointers + paymentSetupStatus COMPLETE; **REPLACE attaches only** — old card keeps charging until `make-default`, which repoints customer default + live subs + `stripeSetupPaymentMethodId` in one confirmed step). `remove` is gated by `canRemovePaymentMethod` (lib/billingAdmin): **anything backing a live sub or pending activation/reactivation is never removable** — make the replacement default first; detach never deletes payment history. Cards are only ever typed on Stripe-hosted pages.
4. **Migration triage layer** (planning only, NEVER charges): Group A/B/C · Leave alone · Future follow-up · Needs payment method + final action + owner-approved `migrationFinalBillingDate` + note, editable in the billing center and surfaced on the roster (`/api/members/migration` GET now returns them + server-derived **readiness** — READY / WAITING_OWNER / WAITING_CLIENT / HOLD / LEAVE_ALONE from `deriveReadiness` in `lib/billingAdmin.ts`, DB facts only, owner classification always wins; a readiness *filter* pulls the candidate set (cap 1000) and paginates in memory). Roster gained group/readiness filter chips, a Group/Readiness column, "Export plan CSV", and the PDF now includes Group/Readiness/Final billing/Notes.
5. **Reactivation flow** (reusable, not Frog-Empire-specific): `MembershipReactivation` rows carry a server-built offer snapshot (`lib/reactivation.ts buildOffer` — pricing precedence identical to approval via `resolveOfferPricing`), 32-byte token, 14-day TTL, versioning (regenerate = SUPERSEDED, never deleted). Owner side: `POST/GET /api/members/[id]/reactivation`, `GET …/preview` (renders EXACTLY what `…/send` sends — same `loadReactivationEmailContext`), `POST …/send`. Email: `renderMembershipReactivationEmail`/`send…` in `lib/email.ts` (club-branded, explicit charge timing in the CTA, optional owner personal-note block, security/support copy). Public page `/reactivate/[token]` + `/api/reactivate/[token]` (GET offer; `payment-setup` reuses the `saveCardMemberId` webhook capture; **`confirm`** re-reads the offer server-side, preflights `customerHasLiveSub` on BOTH customer ids, recomputes charge timing NOW — a promised-future date that has passed demands `acknowledgeImmediateCharge` — claims the row atomically (DRAFT/SENT→CONFIRMING→CONFIRMED), creates the Stripe sub with `trial_end` anchor + idempotency key `aox-reactivation-<id>-v<version>`, records consent JSON {at,userId,email,offerVersion,ip,userAgent,buttonLabel}, FREE/OFFLINE offers make a MANUAL sub instead). Button wording is always explicit: "Confirm membership — first payment <date>" / "$X charged today".
6. **Approve route hardening** (`/api/members/migration/[id]/approve`): now billing-gated, has a Stripe `idempotencyKey` (`aox-migration-approve-<memberId>` — closes the double-submit fork), and a **past/today anchor returns 409 `IMMEDIATE_CHARGE_CONFIRM_REQUIRED`** unless `confirmImmediateCharge:true` (drawer shows the amount and double-confirms). Both branches write BillingAuditLog rows.
7. **Scripts**: `migrate-manual-to-stripe.ts` now REFUSES `--apply` without an explicit `--members <id|email>,…` allowlist (`--i-really-mean-all-eligible` to override), prints per-member charge timing, writes audit rows, and re-reads/verifies applied rows. NEW read-only `scripts/billing-plan-report.ts` (`--csv`) prints the reviewed plan per migrating member. NEW `scripts/billing-admin-tests.ts` — 57 pure-function tests (readiness matrix, mode, timing, pricing precedence, removal safety, pm-ref opacity, permission gates, offer parsing); run via `npx tsx`, no DB/Stripe.
8. Verified `prisma generate` + `npx tsc --noEmit` + `npm run build` clean at every checkpoint; tests 57/57. **Follow-up:** the two new tables (like every table added after the 2026-07-02 RLS migration: invoice_splits, stripe_reconciliations, parental_consents, …) don't have RLS enabled yet — fold them into the RLS rollout when that project resumes.

**2026-07-13 — launch-blocker fixes from Julian's preview testing (same branch, PR #6). NO schema change.**
1. **Both 404s were base-domain generation, not missing routes**: `getAppBaseUrl()` = the single `NEXTAUTH_URL` (production origin) for every Netlify context, so Stripe success/cancel returns and reactivation links generated ON the deploy preview pointed at `https://athletix-os.com/...` where the new routes don't exist until merge. Fix: **`baseUrlFromRequest(req)`** (`lib/baseUrl.ts`) — trusts the request's `x-forwarded-host`/`host` ONLY for the configured host, `*.netlify.app`, and localhost (host-header-injection safe; anything else falls back to `getAppBaseUrl()`), wired into every URL the current visitor navigates to next: payment-method setup success/cancel (admin + member + reactivate), reactivation links in API responses + the email, migration drawer activationUrl. **Rule: user-facing URLs built in a route handler use `baseUrlFromRequest(req)`; only context-free jobs (webhooks, cron) use `getAppBaseUrl()`.** Stripe WEBHOOKS still only hit production — card-capture pointers don't update while testing on previews (see fallback below).
2. **ONE authoritative billing state** — `deriveBillingState` (`lib/billingAdmin.ts`), strict precedence: live/trialing Stripe (ACTIVE_STRIPE/SCHEDULED) > OFFER_SENT/OFFER_DRAFT/PENDING_APPROVAL > **DRAFT_CONFIG** (paid configured price over a free/absent sub — a $5 override can never render as "Free") > MANUAL_OFFLINE > FREE (genuinely $0 only) > LEAVE_ALONE > INCOMPLETE/NONE. Billing page shows it as the lead chip + explanation banner. `deriveReadiness` reordered: an OPEN offer (SENT→waiting-client, DRAFT→waiting-owner) now outranks `migrationStatus=COMPLETED` (John Doe showed "Already active / leave alone" WITH a sent offer). "Will be charged on activation" badge only renders when something pending would actually charge (`hasPendingCharge`), plus explicit copy on Edit/triage: saving changes never charges — billing starts only on client confirmation or explicit authorized activation.
3. **Offers are immutable snapshots with COMPUTED staleness** — `diffOffer`/`compareOfferToCurrent` (`lib/reactivation.ts`) rebuild the current setup and diff (plan/option/price/frequency/paymentMode/first-billing-date (day-level vs `migrationFinalBillingDate ?? billingAnchorDate`)/commitment/payer; startDate deliberately excluded — non-deterministic when unset). Owner UI shows the frozen offer contents + version + last-updated + "matches current setup ✓ / out of date ✗ (changed: …)"; the public GET **and** confirm return 409 `OFFER_OUT_OF_DATE` (confirm also fails CLOSED if the comparison errors). Regenerate = new version + token, old rows kept.
4. **Confirm hardening**: live-Stripe-fallback PM resolution when the webhook pointer is missing (customer default, else the single card — never guesses among multiple; persists what it finds), and on success any standing non-Stripe active/pending sub is canceled-with-timestamp (never deleted) so a member can't hold two active memberships.
5. **UTC date rendering** — billing anchors/final/commitment/start are date-only 00:00-UTC values; local rendering showed "Jul 11" next to a "2026-07-12" input (Julian's conflicting-dates screenshot). All billing-date displays (billing page `fmtDateUTC`, roster next-billing, reactivate page + email `longDate`, consent button label) now format with `timeZone:"UTC"`. `anchorMismatch` flag + warning row when final date ≠ imported anchor (final wins).
6. Tests 81/81 (`scripts/billing-admin-tests.ts` — new: state-model precedence, offer diff, baseUrlFromRequest trust rules; note the tsx test process loads `.env` via @prisma/client, so env-dependent assertions compare against `getAppBaseUrl()` rather than hardcoding).

**2026-07-13 (later) — pre-migration safety pass (same branch/PR #6). NO schema change.**
1. **Self-serve Stripe customer capture**: membership webhook saves `session.customer` → `Member.stripeCustomerId` (never clobbers); subscribe route passes the existing customer into Checkout. **Approve duplicate-sub preflight**: local + live Stripe check on both customer ids, fail-closed (`409 ALREADY_SUBSCRIBED`).
2. **Approve nothing-configured guard** (`409 NOTHING_CONFIGURED`): approving a member with no plan/option/override/imported membership used to fall through to a $0 plan literally named "Continued membership" and flip them ACTIVE — this is what created the 6 placeholder members (audit-trail-confirmed, Jul 6–10). Explicit $0 override (mark-free) still approves free members deliberately.
3. **STATUS POLICY (owner-confirmed)**: PROSPECT = never had a valid membership, NEVER auto-ages to INACTIVE (30-day TTL decay REMOVED — `expireStaleProspects` deleted); INACTIVE = a membership ended. New `expireEndedManualSubscriptions(clubId)` lazily expires MANUAL non-renewing subs past `endDate` (Stripe-linked subs untouched) + recomputes members; wired where the TTL sweep was (`/api/members` GET).
4. **Financials correctness**: `invoice.paid` had a race — the FIRST invoice of a server-created subscription fires before the local sub row exists, so the Transaction was silently dropped (Julian's missing $5). Now falls back to resolving the member from subscription metadata, dedupes by `stripeInvoiceId`, skips $0 trial invoices; the checkout-completed membership branch records Transactions for ONE-TIME mode only (invoice.paid owns all subscription money — no double-count). At-the-door `CREDIT` label now says "collected outside AthletixOS — no Stripe charge" (it records, never charges — the Drayke/Milo $40 mystery).
5. **`scripts/fix-placeholder-memberships.ts`** — allowlist-REQUIRED (no all-mode), dry-run default: cancels $0 placeholder subs (signature-matched only), clears fake membershipId, → PROSPECT, rolls migrationStatus to ACTIVATED/INVITED/IMPORTED by what actually happened, audits, keeps accounts/cards/history; `--retire-plans` soft-deletes unreferenced "Continued membership" plan rows. NOT yet applied — owner list: Harrison Bossert, Oliver Stacconi, Colton Clark (2 subs), Colton Graham, Parker Strickland (Jackson Dolson deliberately excluded — reactivation planned).
6. **Titus Hall (owner-instructed, executed via Supabase MCP + Stripe API)**: verified customer `cus_UpY…` clean (no subs/invoices/charges/cards), EXPIRED the 2 still-open abandoned checkout sessions, retired the 3 pending $1,500 rows (canceled+note), configured the clean offer (MS/HS "1 Year" $2,000 option with $1,500 override, start/first-charge 2026-07-20, commitment 2027-07-20, payer Shannan Hall) and staged reactivation offer **v1 DRAFT — NOT SENT** pending owner preview approval.

**2026-07-08 — UX/verification batch (branch `claude/fable5-handoff-continuation-e0fc90`, from the payments-arc handoff §6). ONE migration added AND ALREADY APPLIED: `20260708000000_club_timezone` (`clubs.timezone TEXT NULL`). Verified `prisma generate` + `npx tsc --noEmit` + `npm run build` clean after every checkpoint. NO billing surface touched (Joseph B. / Mack M. untouched, still PENDING_APPROVAL).** Six tasks:

1. **Member billing card completes the per-person set.** `/api/member/billing` already served `stripeStatus` and `lastPayment` — `/member/profile` now renders them: the Status row appends the raw Stripe state when it differs (e.g. "Active · Trialing"), and a "Last payment" row ($amount on date, from the reconciled `stripeSnapshot.latestInvoice`) shows under the `showInvoices` visibility flag. Full per-person set is now plan · status(+Stripe) · price/frequency · next billing · last payment · card brand·last4·cardholder.
2. **Duplicate merge preview + field selection.** The Merge button on `/dashboard/members/duplicates` opens a side-by-side modal (winner vs duplicate) with one radio pick per **differing** field — name, DOB, email, phone, address (one decision carrying all four columns), gender, guardian fields — plus a summary of what history moves. Defaults keep the survivor's value, falling back to the duplicate's only where the survivor's is blank. `/api/members/merge` accepts an optional `fields` map (`column → "winner"|"loser"`, whitelisted in `MERGEABLE_FIELDS` — nothing billing/identity-critical); values are read server-side off the loser row, so the client picks a record but can never inject a value. Detection GET returns the extra profile columns. Still confirmation-gated, still soft-delete-only.
3. **Migration PDF verified end-to-end (no code change).** Exercised the page's exact jsPDF + autoTable options against the installed `jspdf@4.2.1` + `jspdf-autotable@5.0.7` and visually checked the output — title, filter line, and all 7 columns (name, contact, plan, price, next billing, status, setup) render. API serves every field the export reads.
4. **`Club.timezone` (IANA, nullable) resolves the class wall-clock-UTC residuals.** New `lib/datetime.ts` helpers `tzOffsetMs` / `wallClockUTCToInstant` (DST-safe two-pass via Intl, unit-tested incl. DST boundaries + midnight hour-24 quirk; invalid/missing tz = passthrough, i.e. the old behavior). Wired: **ICS** class `DTSTART`/`DTEND` emit the true instant (`buildIcs` takes the tz; events/privates never converted); **`/cal` embed** renders event/private instants in club-local time with a "times are in the club's local time" footer (bad tz degrades, never 500s); **check-in windows** — `/api/member/checkin/[id]` computes open/ended from converted `windowStartsAt/windowEndsAt` while the response keeps storage-convention stamps for display, and `BookingsPanel.withinCheckinWindow` converts class stamps client-side using the new `club.timezone` on the `/api/member/portal` payload (both club selects). Owner sets it at Settings → Club (Hours card): full `Intl.supportedValuesOf` list + "Use my timezone" shortcut; `/api/club/update` validates via Intl; `/api/club/info` serves it. **The club has NOT set a timezone yet (column is null → all behavior identical to before) — Julian should pick America/Chicago (or the club's actual zone) in Settings.** Migration applied to prod via `psql` with the matching `_prisma_migrations` bookkeeping row (checksum verified) because BOTH prisma and the worktree's stale `.env` creds fail in this sandbox — **the worktree copy of `.env` is outdated; the main checkout's `/Users/cubano/Desktop/clubos/web/.env` works.** A future `migrate deploy` sees it as applied.
5. **Setup badge shows who/when.** Every Set-up drawer PATCH already logs a NOTE `MemberMigrationEvent` with the actor; `/api/members/migration` now joins the latest per row into `setupBy`/`setupAt`. Badge reads "Set up ✓ · FirstName" with a full name+date tooltip; "Edit setup" button tooltip matches. `setupComplete` derivation verified unchanged.
6. This CLAUDE.md block.

**2026-07-07 — Payment-flow root cause + fixes (branch `claude/stoic-edison-8828cd`). "Members save cards + onboard but no payments arrive."** Root cause found from live data (read-only prod queries): **connected-account (Connect) webhook events were never verified.** The club runs TWO Stripe webhook endpoints at the SAME URL (`/api/stripe/webhook`) — a platform one (26 events) and a Connect one (6 events) — each with its OWN signing secret, but the app verified against a single `STRIPE_WEBHOOK_SECRET`, so the other endpoint's events failed signature verification and were dropped with a 400 *before* logging (0 `source=CONNECT` rows despite real connected-account `checkout.session.completed` events). Consequence chain: the setup-mode card-save webhook never fired → `Member.stripeSetupPaymentMethodId` never captured (0/278) → migration approval's `canCharge` was always false → **every approval silently fell into the MANUAL/offline branch** (16 MANUAL subs, no Stripe subscription, no charge). The one real Stripe sub is `trialing` (won't charge until trial end). Fixes:
- **Multi-secret webhook verification** (`app/api/stripe/webhook/route.ts`): tries every configured secret and accepts the first that verifies. Set BOTH in the environment — `STRIPE_WEBHOOK_SECRET` (platform endpoint; may be comma-separated) and `STRIPE_CONNECT_WEBHOOK_SECRET` (Connect endpoint). Loud console.error when an event verifies against none, so this can't silently swallow Connect events again.
- **No more silent MANUAL** (`app/api/members/migration/[id]/approve/route.ts`): a card-intended member with incomplete Stripe setup (no captured PM) is now BLOCKED with `409 CARD_SETUP_INCOMPLETE` + actionable message instead of being quietly set to manual. Genuine offline/free cases (cash/check, $0, Stripe off) still go MANUAL. Owner can override with `forceManual:true` in the approve body.
- **Backfill script** `scripts/backfill-setup-payment-methods.ts` (dry-run default, `--apply`): CUSTOMER-DRIVEN — scans connected-account customers, finds ones with a real saved card, matches to members via `metadata.migrationMemberId`/`memberId` (email fallback), and captures `stripeSetupCustomerId`+`stripeSetupPaymentMethodId`. Skips ambiguous (multi-card/no-default) and unmatched. Reads Stripe, writes only the two member card fields — never touches subscriptions. (Live finding: only ~2 members actually saved a card; most "stored customers" are empty — members abandoned card entry and need re-invite.)
- **MANUAL→recurring conversion** `scripts/migrate-manual-to-stripe.ts` (dry-run default, `--apply`): converts MANUAL active paid subs whose member has a captured card into real Stripe subscriptions, with the FIRST charge anchored (`trial_end`) to the member's NEXT due date so nobody is charged now / double-billed; pre-flights `customerHasLiveSub` to avoid duplicates; idempotency key per sub; never cancels/modifies existing subs. Skips $0 and no-card subs.

Verified `tsc --noEmit` + `npm run build` clean; both scripts dry-run-verified against live prod. **Operator runbook:** set `STRIPE_CONNECT_WEBHOOK_SECRET` (and keep `STRIPE_WEBHOOK_SECRET`) in Netlify → deploy → confirm a `source=CONNECT` row appears on the next card-save → `npx tsx scripts/backfill-setup-payment-methods.ts --apply` → `npx tsx scripts/migrate-manual-to-stripe.ts` (dry run, review) then `--apply` → approve the pending member to land the first real charge.

**2026-07-06 — Stripe product catalog + reconciliation (Phase A/B of the payments+membership+migration loop; branch `claude/stoic-edison-8828cd`). TWO migrations added, NOT yet deployed — run `npx prisma migrate deploy` BEFORE this code deploys: `20260706000000_membership_stripe_catalog` (`memberships.stripeProductId`, `memberships.stripePriceIds` JSONB) and `20260706010000_stripe_reconciliation` (`member_subscriptions.stripeProductId/currentPeriodEnd/stripeStatus/stripeSnapshot` + new `stripe_reconciliations` table). Verified `prisma generate` + `npx tsc --noEmit` + `npm run build` all clean; live Stripe NOT yet exercised (Julian runs live verification).**

Root cause found: **nothing in AthletixOS was registered as a persistent Stripe Product/Price** — every billable item charged via inline `price_data`/`product_data` on the connected account, and migration approval minted a throwaway `"…continued from…"` product per member. So each club's Stripe product catalog was empty. This batch is **additive + safe** (Stripe stays the billing source of truth; no live subscription is ever canceled/recreated/rescheduled).

- **Catalog — `lib/stripeCatalog.ts`.** `ensureMembershipProduct(membership, club)` lazily creates ONE reusable Stripe Product per plan on the club's CONNECTED account and caches `Membership.stripeProductId`; `ensureRecurringPrice(...)` caches reusable recurring Prices in `Membership.stripePriceIds` keyed `"<PERIOD>:<amountCents>"`. Idempotent (trusts cached ids; creates use a Stripe idempotency key), connected-account-only, and **returns null on any failure so it never blocks a sale** (caller falls back to inline `product_data` — charged amount identical). Wired into: member self-subscribe (`/api/member/memberships/subscribe`), owner subscribe (`/api/members/subscribe`), migration approve (`/api/members/migration/[id]/approve` now REUSES the plan Product instead of a per-member junk product), and plan creation (`POST /api/memberships` pre-provisions the Product). **Not yet wired:** plan rename/price-edit → Stripe (belongs to the "membership editing" checkpoint), and one-time items (events/products/privates still use inline `product_data` — a later phase gives each its own catalog Product).
- **Reconciliation — `lib/stripeSync.ts` + `/api/stripe/reconcile`.** `reconcileClubBilling(clubId)` pages the connected account's subscriptions (`status:"all"`, expands default PM + latest invoice + price + customer), and: (a) for subs already linked to a `MemberSubscription` (by our `memberSubscriptionId` metadata or stored `stripeSubscriptionId`) **refreshes the snapshot** — `stripeStatus`, `currentPeriodEnd` (= real next-billing), `stripePriceId/ProductId`, and `stripeSnapshot` JSON (card brand/last4, last invoice, cancelAt); (b) for subs with **no** local row, writes an OWNER-review row to `stripe_reconciliations` with a best-guess member (`EXACT` metadata / `CUSTOMER` stored id / `EMAIL` / `NONE`) — **never auto-creates billing from a guess.** `POST /api/stripe/reconcile` runs it (finances:edit), `GET` lists open review rows (finances:view), `PATCH /api/stripe/reconcile/[id]` resolves one (`LINK` a confirmed member → creates a local MemberSubscription MIRROR of the live sub, does NOT touch Stripe; or `IGNORE`). Matched snapshots surface in `GET /api/member/billing` (`nextBilling` now prefers `currentPeriodEnd`, plus `stripeStatus` + `lastPayment`). **Not yet built:** an owner UI page to trigger the scan / work the review queue (API is ready; UI deferred with the #6/#7 redesign until screenshots).

**2026-07-06 — Pre-migration polish batch (code-only, NO DB migration; scoped `tsc` on all changed files is clean, incl. real Prisma 5.7.0 + NextAuth types — type-check only, not `next build`/e2e; Julian runs the full `npm run build` gate). Type-check caveat: run `prisma generate` before `tsc`/build — the first Netlify build caught two errors a stale/absent Prisma client had hidden: (a) an `as const` Prisma `select` makes `status.in` a readonly tuple that Prisma rejects → use `Prisma.validator<Prisma.MemberSelect>()({...})` for reusable selects (see `app/api/member/billing`); (b) `Membership` has NO scalar `billingPeriod`/`price` (they live in an options JSON) — read period from the `MemberSubscription` snapshot.** Five fixes, Julian pushes.
1. **Calendar timezone consistency.** Two storage conventions coexist (see `lib/datetime.ts`): **ClassSession** times are the owner's wall clock pinned to UTC (a 5:30 PM class is stored 17:30Z → render with `timeZone:"UTC"`); **Events / private bookings** are TRUE INSTANTS from a datetime-local input (render device-local). The owner calendar already did this via `kindIsWallClockUTC(kind)`; the member surfaces did NOT — `lib/friendlyDate.ts` hard-coded UTC for everything, so events rendered hours off. Fixed: `friendlyDate`/`friendlyTime`/`friendlyTimeRange`/`friendlyDateTime`/`datePillParts` now take an explicit **`utc` param (default `false` = local/true-instant)**; every member surface passes `kindIsWallClockUTC(item.kind)` — `app/member/schedule`, `components/member/WeekCalendar` (+ `CalItem.kind`), `MonthGrid` (shares `CalItem`), `components/member/BookingsPanel` (normalizes class sessions into `b.event` with `b.kind` — was rendering classes local), `app/member/checkin/[id]`, `app/member/shop` (class chip), `app/member/page` (event `friendlyDateTime` auto-fixed by the local default). `lib/calendarFeed.ts` `FeedItem` gained `kind`; the `/cal/[clubId]/[token]` embed renders class times UTC-pinned. **Expectation going forward: class times ALWAYS render `timeZone:"UTC"`; event/private times render local; never hard-code one frame for a mixed feed.** Known residual (documented follow-up — **RESOLVED 2026-07-08 via `Club.timezone`, see top block**): the server-rendered `/cal` embed shows event *instants* in the server (UTC) tz and ICS `DTSTART` for classes emits `Z` — both need a real `Club.timezone` field to fully resolve; the in-app member experience (device-local) is correct for a viewer in the club's tz, which is the real-world case. The class-check-in *window* math (`BookingsPanel`, `1h before start`) still uses the stored instant and is off by the club offset for classes — pre-existing, also needs `Club.timezone`.
2. **Per-person billing visibility (mobile).** The `/member/profile` Payment & billing card rendered plan/status/price/next-billing for the **logged-in user's own** subscription only, so a guardian managing several children saw a bare "Card on file" per child. Now: **NEW `GET /api/member/billing`** returns billing for the account holder PLUS every managed child — plan, status, price/frequency, next-billing (migrated members use `billingAnchorDate`), and the saved card (**brand · last4 · cardholder** via **NEW `lib/memberCard.ts resolveCardSnapshot`** — READ-ONLY Stripe on the club's connected account, `stripeSetupCustomerId ?? stripeCustomerId`, graceful `null` on any error, **never charges**). The profile block was rebuilt to render a full billing sub-card per person; still respects `club.memberBillingVisibility` (null = show all). **Stripe card reads are isolated to this endpoint** (the profile page fetches it once, non-blocking) — deliberately NOT added to the hot `/api/member/portal` payload every page loads. Requirement: every client/parent must see plan · status · next billing · price/frequency · card last4 · **whose card** (cardholder name answers this when multiple guardians manage one athlete), and it must work for migrated memberships + mobile.
3. **Duplicate review + merge safety.** `/dashboard/members/duplicates`: owner/staff now **pick the main account** ("Keep this one" flips the primary) instead of accepting the auto-suggestion, plus a confirmation-gated, reversible **"Remove"** (soft-delete via `DELETE /api/members/[id]`, offered ONLY for zero-data + no-login junk; records with data must be merged, which preserves it). `/api/members/merge` **hardened**: memberId tables split into SAFE bulk-reassign vs **UNIQUE** (`bookings` eventId, `document_signatures` documentId, `member_guardian_users` userId) which **dedupe-then-reassign** (drop the loser row that would duplicate a winner row on the unique key, keep the winner's, reassign the rest) so a real merge can't 500 on a unique violation; `member_relationships` deduped BOTH directions; **`messages.subjectMemberId` repointed** loser→winner so coach↔guardian threads about the merged child survive. Still: refuses to merge two records that both have a login; soft-delete only (reversible, breadcrumbs in `notes`); **no auto-merge/delete — every action is confirmation-gated; nothing charged.**
4. **Migration staff setup indicator.** `/api/members/migration` derives **`setupComplete`** per row (owner configured a plan/option/price-override/final-paid, OR an invite was sent, OR status past IMPORTED — `billingAnchorDate` deliberately excluded, it can be CSV-imported). The migration table shows a **"Set up ✓"** badge and relabels the action button to **"Edit setup"** so a second staffer doesn't redo someone's setup.
5. **Migration roster PDF.** "Download migration PDF" button (top of the migration tool, by "Review duplicates") exports the WHOLE current-filter roster (loops all pages) as a table — name, contact, plan, price, next billing, status, setup state — via **`jspdf` + `jspdf-autotable` (already deps)**, client-side, no server route, no new dependency.

**2026-07-04 — Client Experience Redesign, Phases 0–7 (branch `claude/funny-meninsky-4488d3`, from the `design_handoff_client_experience` handoff).** Member-portal UX polish: nav is now **Home · Book · Schedule · Messages · More** for default AND branded clubs (`buildPortalNav` unified; Book targets `/member/shop`, custom Book label preserved; Store demoted to a category; Bookings folded under Schedule — `also` prefixes keep tabs highlighted on deep links). More sheet = three groups (Inbox / Your club / Your account; desktop 3-column hub; Esc closes). New member UI kit pieces in `components/member/`: `SegmentedControl`, `AthleteRail` (desktop rail; module-cached `/api/member/portal` shared with `ProfileSwitcher` via `useAthleteProfiles` — failures aren't memoized; call `invalidateAthleteProfiles()` after family mutations), `GuardianAvatars`, `GuardianList`, `PermissionToggleGrid`, `BookingsPanel` (extracted from old bookings page; desktop table + mobile cards), `WeekCalendar`/`MonthGrid`, `CategoryCard`/`ItemCard`, `InvoiceSplit`. Pages rebuilt: `/member/profile` (Account: identity → people → per-person docs → per-person billing), `/member/family/[id]` (Controls: toggle grid 1:1 with `parentControls`, Co-Guardians promoted, legacy sections collapsed), `/member/schedule` (Schedule|Bookings tabs, Agenda|Calendar views, `?tab=bookings` deep link synced via useSearchParams), `/member/shop` (Book hub: categories + search + mixed feed). Layout: `RAIL_ROUTES` widen desktop canvas + hide managing chips at `md` where pages render their own rail. **Additive API fields** (deliberate exception to the handoff's no-API-change rule — data existed nowhere): portal `guardianOf.member.guardianLinks` (names) and controls GET `guardians[]` (`isPrimary` mirrors `isPrimaryGuardian` OR semantics; UI says "Primary", never "Owner"). **Phase 7 invoice splitting** is behind `FEATURE_INVOICE_SPLIT=1` (off by default): `InvoiceSplit` model (**migration `20260705000000_invoice_split` ALREADY APPLIED**), member routes `/api/member/family/[id]/invoice-split` (propose/approve/decline/revoke, audit-trail JSON), guardian approval files a `PendingApproval` kind `INVOICE_SPLIT` into the owner queue (`lib/approvals.ts`), staff action `/api/approvals/invoice-split` (members:edit). Charge orchestration (auto-splitting purchases across guardians' own cards) is NOT built — an ACTIVE split is the standing agreement staff bill against. Known gap: per-booking "Booked by" attribution needs a `bookedByUserId`-style column (no data recorded today) — pair it with the Phase 7 follow-up.

**2026-07-03 (evening) — Feature batch (branch `claude/nifty-bohr-975a5e`, see `FEATURE_BATCH_2026-07-03.md` at repo root).** Six tasks, one commit each: **event group chats** (`MessageGroup.eventId @unique`, access follows live registration via `lib/eventChat.ts`, member thread route re-checks eligibility; dashboard group thread GET/POST now reject MEMBER sessions — was an open hole); **auto-updating calendar feeds** (stateless HMAC tokens per PUBLIC/MEMBER/STAFF scope, `lib/calendarFeed.ts`, ICS at `/api/public/calendar/[clubId]/[token]`, embed at `/cal/[clubId]/[token]`, share modals on `/dashboard/calendar` + `/member/schedule`); **booking UX** (My Schedule pins booked items then Find & book, events back in the schedule feed, Book Now = the one discovery hub, My Bookings = manage/history); **client check-in** from My Bookings/My Schedule (reuses `/api/member/checkin/[id]`; opens 1h before start; class booking no longer stamps `checkedInAt` — arrival does); **one athlete selector** (`components/ProfileSwitcher.tsx` now syncs to `lib/activeProfile` and renders a context note instead of a second pill row — the layout Managing bar is the single control); **discounts everywhere** (`Discount.appliesTo` item-type scope, `findValidDiscountFor`, wired into class/event/product/pack purchases incl. the pack cash/check approval; owner modal has an item-type chip row). **TWO migrations added and ALREADY APPLIED:** `20260704000000_event_group_chat`, `20260704010000_discount_applies_to`.

**2026-07-02 — Onboarding/migration production-readiness loop (branch `claude/elegant-saha-339455`).** See "Session log — 2026-07-02" below for the full batch list. Headlines: migrated members are no longer presented (or decayed) as Prospects — they're a "Migrating" bucket with Un-invited/Invited/Profile-completed onboarding labels, and `lib/memberStatus.ts` exempts `migrationStatus != null` from the 30-day prospect-TTL decay (that decay was silently flipping un-activated migrated members to INACTIVE); attendance rosters have a hard Remove (DELETE `/api/attendance?recordId=`, no record kept — Transaction rows keep the money); the mobile unread-messages bug was WebView GET caching of the mark-read GETs (fixed with no-store + an `aox:unread-refresh` badge event); announcements now badge unread across the member portal from `AnnouncementEngagement`; private price options carry an `audience` (ALL/MEMBER/NON_MEMBER) inside the `priceOptions` JSON for member vs non-member rates (no migration; enforced server-side in request + pack-buy); ~20 owner-hardcoded API routes moved to `requirePermission` (staff/payroll/comp/availability/discounts/event-types/custom-fields/credits/attendance/class-session); member cancel of a PAID private returns a refund-*request* (never auto-refunds); new member Club Profile page at `/member/club`; tablet header buttons + wide tables fixed (PageHeader wrap + `overflow-x-auto`). **No DB migration in this batch.**

Last updated: 2026-06-21. **Client UX Phases 1–2 (2026-06-20 → 06-21) landed since this header was last written** — see the new "Member Portal — Client UX, Family & Messaging" section below for the branded portal layer, the billing/onboarding/private-package/child-edit/owner-profile/donation fixes, the drawn signature pad, two-way family messaging, and the co-guardian invite. **Two DB migrations were added there — `npx prisma migrate deploy` MUST run before the new code deploys: `20260621000000_document_signature_image` (`DocumentSignature.signatureDataUrl`) and `20260621010000_message_subject_member` (`Message.subjectMemberId`).** Phase 1 + the signature pad are committed (`b2c6c74`); the messaging + co-guardian batch is on disk (Julian commits/pushes). New-column Prisma writes use `as Prisma.*Input` casts (the build regenerates the client). Earlier note: `main` tip `8999442` = `origin/main`; an **uncommitted on-disk hardening batch (2026-06-19)** adds shared member-contact validation (`lib/memberValidation.ts`) and document surface helpers (`lib/documents.ts`), fixes minor/adult contact edge cases, makes import/migration consistently treat minor email/phone as guardian contact, gates onboarding/signup required documents by their exact `Document.requiredAt` surface, and adds a focused regression script (`scripts/production-hardening-tests.ts`). Verification from this batch: `npx tsx scripts/production-hardening-tests.ts`, `npx tsc --noEmit`, and `npm run build` passed; `npm run lint` was run but still fails on pre-existing unrelated lint debt. Earlier **uncommitted on-disk batch (2026-06-18)** fixes the onboarding "invalid password" login bug (soft-deleted-login resurrect), makes member imports default to **PROSPECT** (never auto-ACTIVE), relaxes the minor guardian-import requirement to **name + email only**, and batches the member importer to avoid a serverless function timeout — details in "Member Migration & Activation" and "Critical Invariants"; ship with the current uncommitted changes. **Major systems added since 2026-06-07 — member migration & activation, the guardian/minor login model, parental controls, the unified Members → Approvals tab, member/parent billing management, and Supabase Storage uploads — now have their own current-state sections below ("Member Migration & Activation", "Guardian / Minor Model & Parental Controls", "Approvals", "Member Billing Management", "Critical Invariants & Serverless Gotchas"). Read those before touching members, activation, billing, guardian/minor, uploads, or DB migrations.** Earlier history (2026-06-03 → 06-05) shipped in order: **P1 UI/UX fixes** merged to main (was `feat/p1-ui-fixes`, 7 commits — dark mode contrast, sign-in logo link, calendar grid + mobile day-list, member nav Bookings + More sheet, owner dashboard Recent messages + Recent bookings widgets, iOS app icon regen, full unicode-glyph eradication across 46 files); **CX overhaul** (5 commits — pricing page rebuild with 14-day trial + email/3-5d/urgent-call support copy + Help Center references removed, SEO foundation with rich metadata + sitemap.ts + robots.ts + JSON-LD Organization & SoftwareApplication, landing page premium rewrite with hero/use-cases/value-props, member portal trial badge, signup trial reinforcement); **CY Android verification docs** (`docs/android-verification.md` — emulator + device setup, 8-min smoke checklist, keystore setup, Play Console first-time submission); **real-domain wiring** (`athletix-os.com` everywhere — SITE_URL fallback, EMAIL_FROM `noreply@athletix-os.com`, slug-prefix labels, support/hello/contact inbox routing; iOS+Android bundle ID `com.athletixos.app` preserved); **security audit Tasks 1-8** all complete with results in `SECURITY_AUDIT_RESULTS.md` (Task 2 multi-tenant isolation defense-in-depth fixes, Task 5 security headers + Report-Only CSP in `next.config.mjs`, Task 6 NextAuth login rate-limit + bcrypt cost 10→12 + explicit 14-day session, Task 7 email-test zod validation, Task 8 `/terms` + `/privacy` public pages + signup consent checkbox + `LegalAcceptance` model & migration applied + member-signup consent symmetry). Pinned versions preserved throughout (no new deps, no Prisma 7 upgrade). All 13 post-2026-06-03 commits pushed.

This file is the working context for the AthletixOS web app. Treat it as current-state documentation, not a product promise. Do not claim an area is complete unless it is visible in the app and verified.

## App Summary

AthletixOS is a multi-tenant SaaS app for sports clubs and gyms. It has:

- Club owner/staff dashboard for members, classes, events, purchase options, staff, documents, messages, attendance, financials, reports, and settings.
- Member portal for members/guardians to view bookings, documents, profile, and portal content. Guardian/minor flows with child-switching and audited document signatures.
- PostgreSQL database scoped by `clubId`.
- Two-sided Stripe integration: Stripe Connect for member → club payments, plus a separate platform-account subscription for clubs paying AthletixOS.

## Working Rules — read first on every task

These rules apply to every software-development task in this repo. They override looser defaults from training data. Follow them in order.

1. **Inspect before coding.** Before touching anything, read the project architecture, routes, layouts, auth, permissions, database relationships, and shared components that touch the task. Trace at least one end-to-end path through the area you're about to change.

2. **Auto-discover and use installed Claude Code capabilities.** On every task, scan for and use the relevant:
   - Skills
   - Agents
   - MCP servers
   - Plugins
   - Hooks
   - LSP integrations
   Don't rebuild functionality a skill or MCP already provides.

3. **Prefer these capabilities when they apply:**
   - `frontend-design` (or `impeccable` / `ui-ux-pro-max`) for UI work
   - `feature-dev` for new feature scaffolding
   - `systematic-debugging` for any bug, test failure, or unexpected behavior
   - `verification-before-completion` before claiming work is done
   - `review-local-changes` (or `review-pr`) before commit/merge
   - `subagent-driven-development` for plans with independent tasks
   - `dispatching-parallel-agents` for 2+ tasks without shared state

4. **UI/UX work specifically:**
   - Use **Magic (21st.dev) MCP** for inspiration and component generation.
   - Perform a UX audit before any redesign.
   - Propose a file plan (which files will be created/modified) **before** editing.

5. **iOS, Capacitor, React Native, mobile, navigation, auth, or WebView changes:**
   - Use `ios-simulator-skill`.
   - Validate behavior in simulator (or device) **before** claiming completion.

6. **Never perform broad rewrites** without understanding dependencies and impact.

7. **Before editing, present:**
   - The exact list of files affected
   - Known risks
   - A short implementation plan

8. **Work in small checkpoints**, not one giant commit.

9. **After each checkpoint, run:**
   - Lint
   - Build
   - Regression check on adjacent functionality

10. **Before claiming completion, verify:**
    - Auth still works
    - Permissions still gate the right surfaces
    - Navigation still routes correctly
    - Mobile/Capacitor behavior is intact
    - Existing functionality hasn't regressed

11. **Explicitly state** which skills, MCPs, plugins, and agents were used during the task in the final summary.

12. **Do not claim testing was performed** unless you actually ran it. If you only ran type-checks and build, say that; don't conflate it with end-to-end testing.

## Current Tech Stack

- Framework: Next.js 14.2.35, App Router.
- Language: TypeScript.
- Styling: Tailwind CSS v4 plus global CSS design tokens in `app/globals.css`.
- Auth: NextAuth v4 credentials provider with JWT sessions.
- Database: PostgreSQL via Prisma ORM.
- Prisma versions: `prisma` and `@prisma/client` pinned to 5.7.0.
- Payments: Stripe Connect (member → club) and Stripe platform subscription (club → AthletixOS).
- Bank integration: Plaid routes and settings present.
- Email: Nodemailer helper with transactional templates wired into key flows.
- File storage: **Supabase Storage** (private `uploads` bucket, accessed server-side with the service-role key) in production — Netlify's filesystem is ephemeral so disk MUST NOT be used there. Local dev falls back to on-disk `process.env.UPLOADS_DIR` (default `./storage/uploads`) when `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are unset. All bytes flow through `lib/storage.ts` (`putObject`/`getObject`); the only authenticated read gate is `/api/files/[id]` (club-scoped). Public, non-sensitive club logos are served unauthenticated via `/api/public/club-logo/[clubId]` (see Member Billing / email sections).
- Local dev port: `npm run dev` runs Next on `127.0.0.1:3000` (bound to `0.0.0.0` so the iOS simulator can reach it). Port 3001 was abandoned because it's on WebKit's restricted-network-ports blocklist.
- Local auth URL: `.env` should use `NEXTAUTH_URL=http://127.0.0.1:3000`. Using the literal IP (not `localhost`) avoids the macOS IPv6-first resolution that breaks the WKWebView connect.

Do not upgrade Next, NextAuth, Prisma, or Stripe casually. This project depends on pinned versions.

## Design System / Colors

The dashboard uses a modern dark-neutral palette with strong accents.

- Charcoal structure: `#1F1F23`
- Charcoal hover: `#2A2A2E`
- Background: `#F7F7F9`
- Surface/cards: `#FFFFFF`
- Border: `#E5E7EB`
- Text primary: `#111111`
- Text muted: `#6B7280`
- Primary accent violet: `#6D5DF6`
- Primary hover: `#5948E8`
- Success lime: `#A3E635`
- Warning/action orange: `#FF6A00`
- Error/destructive red is still allowed.

### Theming

The dashboard supports a per-browser light/dark toggle (`components/ThemeToggle.tsx`).
- Persisted in `localStorage["athletixos-theme"]` (no DB column).
- Applied via `<html data-theme="dark">`. A small no-flash inline script in `app/layout.tsx` runs before first paint.
- Dark mode overrides `--color-bg`, `--color-surface`, `--color-border`, `--color-text`, `--color-muted`, and the sidebar tokens in `:root`.
- Tailwind v4 `@theme` tokens (`--color-app-bg`, `--color-surface`, `--color-app-border`, `--color-text-primary`, `--color-text-muted`) reference the `:root` vars via `var()`, so utility classes (`bg-app-bg`, `bg-surface`, `text-text-primary`, etc.) flip with the theme automatically.
- Member portal pages intentionally use raw `bg-stone-*` / `bg-white` Tailwind classes and do **not** flip with the toggle — the portal stays light/club-branded regardless of the owner's preference.

Use the Tailwind v4 theme tokens from `app/globals.css`:

- `bg-brand`, `hover:bg-brand-hover`
- `bg-lime-accent`
- `bg-orange-accent`
- `bg-charcoal`, `bg-charcoal-hover`
- `bg-app-bg`, `bg-surface`
- `border-app-border`
- `text-text-primary`, `text-text-muted`

Avoid reintroducing random Tailwind color families such as `blue-*`, `green-*`, `amber-*`, `purple-*`, `stone-*`, or hardcoded old AthletixOS colors.

## Tier Model

**Three paid tiers** stored on `Club.tier` — there is NO free/Starter tier. Definitions live in `lib/tier.ts` (single source of truth; `normalizeTier()` maps any legacy/unknown value incl. `"starter"` → `growth`). `Club.tier` defaults to `growth`.

| Tier       | Monthly | Tx fee | Members   | Locations  | Notable extras                                                       |
|------------|---------|--------|-----------|------------|----------------------------------------------------------------------|
| Growth     | $50     | 0%     | 200       | 1          | Classes/events/attendance, memberships, private lessons, messaging, reports, CSV import |
| Pro        | $99     | 0%     | Unlimited | 3          | + Plaid, email/SMS, branded app, advanced analytics, priority support |
| Enterprise | $199+   | 0%     | Unlimited | Unlimited  | + API, SSO, advanced permissions, custom onboarding, enterprise reporting |

AthletixOS takes **0% per-transaction platform fee on every tier** (`lib/stripe.ts` `calculatePlatformFee` always 0). Clubs may optionally pass Stripe's processing fee to the customer at checkout — centralized in `lib/fees.ts` (`Club.passProcessingFees`), toggled on the billing settings page, never hardcoded elsewhere.

Tier enforcement: `/api/members` (maxMembers 200 on Growth → upgrade to Pro), `/api/club/locations` (maxLocations), `/api/reports/overview` (reports), `/api/plaid/*` (plaid), `/api/announcements` (emailSms). On platform-sub cancel the webhook keeps the tier and only sets `subscriptionStatus:"canceled"` (no Starter fallback).

## Staff Permissions

`lib/permissions.ts` is the single source of truth (10 keys: members, attendance, classes, events, schedule, messages, documents, finances, reports, staff). Permissions live in the JWT (set at login) + are surfaced live via `/api/me`. Middleware enforces per-section access for STAFF (owners bypass everything). `lib/apiGuard.ts` `requirePermission`/`requireOwner` guard API routes. **Permission-gating ≠ tier-gating** — never tier-gate cash/financial tracking.

## Member Migration & Activation

The flagship onboarding flow for clubs switching from other software. Files: `lib/migration.ts` (`MIGRATION_STATUS`, anchor helpers), `lib/migrationServer.ts` (`sendActivation`, `sendJoinInvite`), `app/dashboard/members/migration/*` (owner tool), `app/activate/[token]/page.tsx` (public page), `app/api/members/migration/activate/[token]/route.ts` (GET/POST), `app/api/members/migration/[id]/approve/route.ts` (owner approval).

Flow:
1. Owner **CSV-imports** members (`/dashboard/members/migration` — name is the only required field; for minors only guardian **name + email** are required (not phone); adult members require their own email or phone; date-format picker, second-pass membership matching). Imported members carry a legacy snapshot, start `migrationStatus=IMPORTED`, and **always `status=PROSPECT`** — import never auto-assigns ACTIVE (a member only becomes ACTIVE after activation/approval). For minors, generic imported `email`/`phone` columns are treated as **guardian contact by default** unless explicit guardian columns are present, and the child's own email/phone remain null; for adults those columns remain member contact. `lib/memberValidation.ts` is the shared contact-rule helper for manual create/edit/import. `normalizeStatus` maps everything except explicit inactive/paused to PROSPECT; the membership second-pass (`/api/members/import/memberships`) also downgrades a stale ACTIVE→PROSPECT when it pulls a member in (unless they have a live sub / already activated). The importer (`/api/members/import`) prefetches existing member emails (one query), resolves each unique guardian once, allows the same guardian email to connect to multiple children, and **creates rows in concurrent batches of 5** (`IMPORT_CONCURRENCY`, + `export const maxDuration = 60`) so a large or cold import can't hit the serverless function timeout — the old strictly-sequential per-row loop did, surfacing as a generic "Import failed" after a ~10s spin.
2. Owner **sends an activation email** (branded; `lib/email.ts sendMemberMigrationActivationEmail`). Member opens the **token-gated public page** `/activate/[token]`.
3. **Activation POST** sets a password when creating a new portal user — a **LIVE** existing user's password is NEVER overwritten from a token (the account-takeover guard) — but a **SOFT-DELETED** login (e.g. a member deleted then re-onboarded with the same email) is now **resurrected**: `deletedAt` cleared and the new password set, since it has no active credentials and the owner issued the token. (Before this fix, activation found the dead row via `findUnique` (which ignores `deletedAt`), skipped the create, never stored the password, and login then rejected the `deletedAt` user → the "onboarding completes but login says invalid password" bug; password resets couldn't help either because `authorize()` still rejected `deletedAt`.) GET `hasAccount` treats a soft-deleted login as no-account so the password field shows; `forgot-password`/`reset-password` skip soft-deleted users. Then it confirms profile, accepts autopay, signs every required **ONBOARDING** document, and for CARD members opens a Stripe **setup-mode** Checkout that saves a card with **NO charge**. Required-document enforcement is server-side and happens before account/billing state mutation; `Document.requiredAt=["SIGNUP"]` or `["PURCHASE"]` no longer accidentally blocks onboarding just because `Document.required=true` is mirrored. Member → migrationStatus=ACTIVATED, approvalStatus=PENDING_APPROVAL. Used tokens (ACTIVATED/COMPLETED) 409.
4. **Billing starts only on owner approval** (`/api/members/migration/[id]/approve`): creates the recurring Stripe subscription off the saved card with `trial_end` anchored to the agreed date (never charges on approval day), then sets the member **ACTIVE + `membershipId` + a `MemberSubscription`**. The `!canCharge` branch ($0/grandfathered, cash/check, or no card / Stripe off) now ALSO sets ACTIVE + membershipId + a **MANUAL** `MemberSubscription` (fixed 2026-06-17 — it previously left such members PROSPECT with no membership).

Variants: **registration options** (#5 — member picks a plan option / requests billing date / requests cancellation date / chooses CARD·CASH·CHECK; prices validated server-side against real options or the imported `legacyMembershipPrice` via `useCurrentRate`, never a client price; owner `migrationPriceOverride` always wins). **Fully-paid final period** (#6 — `migrationFinalPeriodPaid`: activates as a non-renewing membership, no card). **Free-join** (#7 — `activationKind="JOIN"`: a non-member registration link that creates a free portal account to browse/buy, no membership/billing). **Event bundles** (`EventBundle`/`EventBundleItem` — discounted packages that book all included events).

Key data: `MemberMigrationEvent` (per-member audit log) + `Member` fields `activationToken`/`activationTokenExpires`/`activationEmailSent*`, `migrationStatus`, `approvalStatus`, `activationKind`, `activatedAt`, `legacyMembershipName/Price`/`legacyBillingFrequency`/`legacySource`, `migrationMembershipId`, `migrationPriceOverride`, `migrationSelectedOption` (JSON), `migrationFinalPeriodPaid`, `requestedPaymentMethod`/`requestedBillingDate`/`requestedBillingNote`/`requestedCancellationDate`/`activationNote`, `stripeSetupCustomerId`/`stripeSetupPaymentMethodId`, `billingAnchorDate`/`commitmentEndDate`, `activationEditableFields` (JSON).

## Guardian / Minor Model & Parental Controls

`Member.userId` (`@unique`) is the member's **OWN** portal login. A guardian reaches a minor through the **guardian-link** system — `MemberGuardianUser` (relation `User.guardianOf` ↔ `Member.guardianLinks`) — **not** by pointing the minor's `userId` at the guardian's user (doing so inverts parental controls and, because `userId` is unique, makes a second child invisible).

- **Session → member resolution:** `lib/memberLink.ts findOrAutoLinkMember` (by `userId`, else an email fallback that **skips minors**). The member portal builds an account switcher from `self` (the user's own `memberProfile`) + `guardianOf` children (e.g. `resolveMemberContext` in `app/api/member/schedule`).
- **Linking authorization:** `lib/guardianLink.ts` — `isOwnerVouched` (the owner already typed this email into `Member.guardianEmail`) → auto-creates the `MemberGuardianUser` link; otherwise a `GUARDIAN_LINK` `PendingApproval` for the owner. Activation auto-links guardian-managed minors (`guardianManaged` = minor whose activation contact == `guardianEmail`) and names the created account after the guardian.
- **Contact rules:** minors do **not** require their own `Member.email` or `Member.phone`; they require guardian name + guardian email. Adult members require their own email or phone. The manual member modal mirrors this (club-required phone/email fields do not force a minor's own contact), and the API enforces it through `lib/memberValidation.ts`.
- **Family onboarding:** when a guardian-managed minor shares `guardianEmail` with siblings, activation groups pending siblings into the family payload so the parent can update one guardian account and then continue through each child. Existing guardian accounts are reused; the same guardian email may link to multiple `MemberGuardianUser` rows. Guardian-managed document signatures are attributed to the guardian account name, not the child name.
- **Parental controls:** `lib/parentalControls.ts` — `applyParentalControls` gates paid member-portal actions (CLASS_BOOK / EVENT_REGISTER / PRIVATE_REQUEST / PACKAGE_BUY / MEMBERSHIP_SUBSCRIBE / PRODUCT_BUY) → allow / block / queue; it keys oversight on `member.userId !== bookerUserId` (a guardian acting IS the oversight). `memberCanMessage` gates the minor's own messaging. Controls JSON on `Member.parentControls`: `requirePaymentApproval`, `monitoredMessaging`, `allowPackagePurchase`, `allowOwnMessaging`, `dailySpendLimit`. Per-child editor: `/member/family/[memberId]`.

## Approvals

Unified owner queue at `/dashboard/members/approvals` (a Members sub-tab; old `/dashboard/approvals` redirects here). `GET /api/approvals` returns three permission-filtered kinds:

- `GUARDIAN_LINK` (members:view) and `MEMBERSHIP_CANCEL` (finances:view) — real `PendingApproval` rows.
- `MIGRATION_BILLING` (members:edit) — **synthesized** from members in migrationStatus=ACTIVATED + approvalStatus=PENDING_APPROVAL (these live on the Member row, not `PendingApproval`, which is why they only showed in the migration tool before).

Action routes: guardian → `/api/members/[id]/guardians/approve`; cancel → `/api/approvals/membership-cancel` (mode `PERIOD_END | IMMEDIATE | IMMEDIATE_REFUND`); migration billing → `/api/members/migration/[id]/approve`. Kind constants: `lib/approvals.ts` (`MEMBERSHIP_CANCEL_KIND`), `lib/guardianLink.ts` (`GUARDIAN_LINK_KIND`); `lib/parentalControls.ts MEMBER_APPROVAL_KINDS` are the member-side family kinds (kept distinct so they never cross into the owner queue).

## Member Billing Management

Members/guardians **cannot self-cancel** — cancellation always routes through staff approval.

- `POST /api/member/billing-portal` opens the Stripe Billing Portal on the club's connected account (update card + invoices; `subscription_cancel` disabled by config). Accepts optional `memberId` so a guardian can manage a linked child's billing (authorized via `guardianOf`); resolves the customer as `stripeSetupCustomerId ?? stripeCustomerId`.
- `POST /api/member/subscriptions/request-cancel` → a `MEMBERSHIP_CANCEL` PendingApproval (guardian-aware); owner approves in the Approvals tab.
- UI: self billing on `/member/profile`; per-child "Manage billing" on `/member/family/[memberId]`.
- "Add-before-remove card" relies on Stripe's portal (it blocks removing the card backing an active subscription) — there is intentionally no custom card manager.
- Known follow-up: the self `/member/profile` "Update card/invoices" button is gated on `stripeCustomerId` only, so a migrated paying member (card on `stripeSetupCustomerId`) may not see it until that gate is widened.

## Member Portal — Client UX, Family & Messaging (2026-06-20 → 06-21)

Two client-experience batches. **Phase 1 + signature pad are committed (`b2c6c74`); the messaging + co-guardian batch is on disk — Julian commits/pushes.** Two migrations were added — run `npx prisma migrate deploy` BEFORE deploying: `20260621000000_document_signature_image` (`DocumentSignature.signatureDataUrl TEXT`) and `20260621010000_message_subject_member` (`Message.subjectMemberId TEXT` + index). New-column writes use `as Prisma.*Input` casts (the Netlify build regenerates the client, where both fields are first-class).

**Branding layer (visual only, scoped to the portal — the owner dashboard is untouched).** `app/globals.css` has a `.member-portal` block: `--club-accent*` tokens + helpers `.pcard` / `.pcard-hover` / `.pbtn-accent` / `.pseg-active` / `.pskeleton` / `.pfade`. `app/member/layout.tsx` injects `--club-accent*` from `Club.primaryColor` (only when it's a 6-digit hex) and tags the portal root `member-portal`. Reusable kit: `components/member/ui.tsx` (Card, SectionHeader, Pill, Avatar, EmptyState, Skeleton/CardSkeleton, StatTile, AccentButton/GhostButton, `useClubBrand()` module-cached `/api/member/club`). Friendly dates: `lib/friendlyDate.ts` (relative "Today/Tomorrow", `friendlyTimeRange`, `datePillParts`). `components/member/ProfileSwitcher.tsx` redesigned (always-on when ≥2 profiles, avatar pills, accent active). Home (`app/member/page.tsx`), profile, family, schedule, documents, privates restyled to `pcard`/accent.

**Phase 1 fixes (mostly no migration).** Manage-Billing no longer 400s for cash/check athletes — `memberHasBilling()` gates the button on `/member/profile` + `/member/family/[memberId]` (soft "no card on file" note otherwise); billing errors render inline, not a red top banner; the self gate now also accepts `stripeSetupCustomerId`. Minor label derives from DOB age (`showsAsMinor`) so a 25-yo linked as an athlete isn't shown "Minor". Onboarding (`app/activate/[token]`) sources guardian contact from `guardianEmail`/`guardianPhone`, never lets an email pre-fill the phone box (+ `type=email/tel`), and adds a confirm-password field; GET returns `guardianPhone`. Private packages (PERCENT/FIXED) now price off the chosen tier — `/api/member/private-packages/[id]/buy` accepts `lessonTypeId`+`priceOptionId` and uses `packageTotalForBasePrice`; the privates page shows packs AFTER the pricing option (fixes "$0 / Package not available"). Child name/DOB/contact editable on the family controls page (PATCH `profile` on `/api/member/family/[memberId]/controls`; GET also returns `phone`/`email`/`hasBilling`). Parent self-profile opt-in: `POST /api/member/self-profile` (idempotent — `findOrAutoLinkMember` else create an adult PROSPECT; respects the `members_userId` invariant). Donation links surfaced on `/member` home ("Support {club}" — added active `donationLinks` to `/api/member/club`). Owner portal profile: `GET/PATCH /api/me/portal-profile` upserts the caller's `StaffProfile` portal fields + a "Member portal profile" card on `/dashboard/my-account` (owners had no `StaffProfile`; `/api/member/staff` already includes OWNER, so they just needed `showOnPortal`). Schedule: in-page athlete switcher + day-window filter (All / Next 7 / Next 30) + relative date headers.

**Documents — drawn signature pad (#6, migration).** `components/member/SignaturePad.tsx` (canvas, pointer events, Clear) + `lib/signature.ts` (PNG data-URL validation, ~220 KB cap). `DocumentSignature.signatureDataUrl` stores the image. Wired into the member documents sign flow (`app/member/documents` — the Sign button now requires a drawn signature), the sign API (`/api/member/documents/[id]/sign`), and onboarding (one drawn signature applied to acknowledged docs via the activation route). Owner audit (`/dashboard/documents` → Signatures) renders the image; legacy rows show "Typed acknowledgement". The member **signup wizard** still uses the typed acknowledgement (follow-up).

**Two-way family messaging (#9, migration).** `Message.subjectMemberId` lets a guardian↔coach DM be "about" a specific child — **including children with no login**. `lib/memberMessaging.sendMemberMessage` (the owner-side DM path) already routed coach→minor to the guardian; it now tags those with `subjectMemberId`. `GET /api/member/messages` returns self + per-child subject threads + `subjects[]` for the composer (this REPLACED the old child-userId `childConversations` that the guardian could not actually open, since the thread route filters by the session user as a participant). `GET/POST /api/member/messages/dm/[userId]` take `?about=<memberId>` to scope/tag the thread. `GET /api/member/messages/recipients` lists OWNER+STAFF for the composer. The Messages page has a "New message" composer (recipient + about self/child) and "For {child}" tags. Member↔member still requires an existing thread; members may DM staff/owners freely.

**Co-guardian invite (#8b, no migration).** `POST /api/member/family/[memberId]/invite-guardian` files a standard `GUARDIAN_LINK` `PendingApproval` pointing at the co-parent's EXISTING portal account — reuses the owner Approvals queue + `/api/members/[id]/guardians/approve` with zero plumbing changes (the security invariant holds: no `MemberGuardianUser` row until the owner approves). The co-parent must already have a club account, else the parent gets a friendly "have them sign up first" message. UI on the child Manage page (`/member/family/[memberId]`).

## Other Systems (high level — schema is source of truth, 63 models)

Private lessons (`PrivateLessonType`/`PrivatePackage`/`PrivateCreditLedger`/`PrivateBooking`/`PrivateBookingPartner`/`PrivateLessonPayRate`; `lib/privateLessonRules.ts`, `privatePartners.ts`). Staff comp/payroll/contractors (`StaffCompensation`/`CompensationBonus`/`CompensationAssignment`/`Contractor`/`ContractorPayment`; `lib/compensation.ts`, `payroll.ts`). Discounts (`Discount`; `/api/discounts`). Products (`Product`/`ProductSale`). Donations (`Donation`/`DonationLink`). Recurring classes & attendance (`RecurringClass`/`ClassSession`/`AttendanceRecord`; `lib/classSessions.ts`). Email opt-out (`EmailOptOut`; `lib/unsubscribe.ts`, `/api/unsubscribe`).

## Critical Invariants & Serverless Gotchas

- **`members_userId` is a PLAIN GLOBAL unique index — it ignores `deletedAt`.** A soft-deleted member still holding a `userId` reserves that slot and makes any re-link 500 with `duplicate key value violates unique constraint "members_userId_key"`. So: (a) every member soft-delete path (`/api/members/[id]` DELETE, `/api/members/bulk`, `/api/member/me` DELETE) nulls `userId`; (b) activation releases stale soft-deleted holders before linking. Do not re-introduce a delete path that leaves `userId` set, and never point a minor's `userId` at the guardian.
- **A soft-deleted `User` (login) also reserves its `(clubId, email)` slot and blocks re-onboarding.** The `(clubId, email)` unique index is global (ignores `deletedAt`), and NextAuth `authorize()` rejects any user with `deletedAt`. Deleting a member soft-deletes its MEMBER login (`deleteOrphanedMemberLogins`), so re-onboarding the same email must **resurrect** that row (clear `deletedAt` + set the new password), never `create` a new one — a `create` 500s on the unique index, and a `findUnique`-then-skip silently drops the chosen password. This resurrect is implemented in activation (`/api/members/migration/activate/[token]`) and member signup (`/api/member/signup`); `forgot-password`/`reset-password` only act on live (non-deleted) users. This was the root cause of the "onboarding done but login says invalid password" bug.
- **Bulk member import must not run row-by-row sequentially.** `/api/members/import` does several writes per row; a strictly sequential loop through the cold connection pooler can exceed the platform's ~10s function limit even for <100 rows (the client showed a generic "Import failed"). The route prefetches existing emails, dedupes guardian upserts, and creates members in concurrent batches (`IMPORT_CONCURRENCY = 5`) with `export const maxDuration = 60`. Keep new per-row work off the hot path.
- **Member contact validation is centralized.** Use `lib/memberValidation.ts` for any new create/edit/import path. Minor athlete contact belongs on `guardianEmail`/`guardianPhone` by default; do not duplicate a guardian email into the child's own `Member.email` just to satisfy an email schema. Adult contact belongs on the member. This avoids duplicate login/account creation and keeps same-email family onboarding working.
- **Required documents are surface-specific.** `Document.requiredAt` is the source of truth for where a signature is mandatory (`ONBOARDING`, `SIGNUP`, `PURCHASE`, `EVENT`); `Document.required` is only a legacy/mirrored boolean. Use `lib/documents.ts` (`requiredDocumentSurfaceWhere`, `isDocumentRequiredAt`, `missingRequiredDocumentIds`) instead of checking `required=true` directly, otherwise a signup/purchase-only document can incorrectly block migration onboarding. Legacy rows with `required=true` and empty `requiredAt` are treated as ONBOARDING only.
- **DB migrations: `prisma migrate dev` FAILS on this Supabase** (shadow DB blocked by the pooler — "...shadow_db... is being accessed by other users"). Workflow: hand-write the migration SQL folder → `npx prisma migrate deploy` (no shadow DB) → `prisma generate`. `DIRECT_URL`/`directUrl` is the non-pooler URL migrations use. Netlify build = `prisma generate && next build`, so the deployed client is regenerated every deploy.
- **`isomorphic-dompurify` can crash the route at import.** It pulls in jsdom, which the Netlify serverless bundler mangles so the module throws while LOADING — a top-level import 500s the whole route (this was the "Create Document 500"). `lib/sanitizeHtml.ts` lazy-`require`s it inside try/catch and falls back to a regex `fallbackStrip`; `next.config.mjs` also externalizes it. Always sanitize via `sanitizeRichHtml()` before storing HTML rendered with `dangerouslySetInnerHTML`.
- **Email / public images must be absolute + unauthenticated.** `/api/files/[id]` requires a session, so it can't load in emails or for logged-out members. Club logos in emails and on the public activation page go through `/api/public/club-logo/[clubId]` (`lib/clubLogo.ts publicClubLogoUrl`, absolute via `getAppBaseUrl()`).
- **Mobile = Capacitor remote-URL wrapper.** `capacitor.config.ts` loads `NEXT_PUBLIC_APP_URL` in a WebView, so web deploys auto-update app content; only native-shell changes (icon/splash/plugins/server URL) need `npm run cap:sync` + an Xcode/Android Studio rebuild + store resubmit. Local dev binds `0.0.0.0:3000` with `NEXTAUTH_URL=http://127.0.0.1:3000` (not `localhost`, not `:3001`).

## Financial OS

Lightweight accounting/tax-prep helper (NOT QuickBooks), permission-gated on `finances`, **never tier-gated**. `lib/financials.ts` (categories, payment methods incl. CASH/COMP/INVOICE, `isCashMethod`/`isCompMethod`, disclaimers) + `lib/financialReports.ts` (`buildReport`/`reportToCsv`). Transaction/Expense/Donation carry `legalEntityId` + `category` + `paymentMethod`; `Transaction.manual=true` for cash/comp/invoice (only manual records are deletable — never delete Stripe records). Reports separate Card / Cash / Comp / Invoiced. Cash option exists everywhere via `/api/financials/manual-payment` (Money In tab) and `/api/attendance/charge` (at-the-door non-member drop-in/trial/guest). Disclaimer shown; never claims tax filing.

## Dashboard Navigation

Current dashboard sidebar structure:

- Dashboard
- Members (now a GROUP — `lib/dashboardNav.ts`)
  - All members (`/dashboard/members`)
  - Migration (`/dashboard/members/migration`)
  - Approvals (`/dashboard/members/approvals`)
- Staff
  - Directory
  - Schedule
  - Availability
  - Payroll / Payouts
- Purchase Options
  - Memberships
  - Privates
  - Products
- Classes & Events
  - Classes
  - Events
  - Calendar
- Communication
  - Messaging
  - Announcements
  - Campaigns
- Attendance
- Financials
- Reports
- Documents
- Settings

Important navigation notes:

- **Approvals moved under Members** (was a top-level item). `/dashboard/approvals` now redirects to `/dashboard/members/approvals`. The three Members pages share `components/MembersTabs.tsx` (a sub-tab bar). See the "Approvals" section.
- Memberships is not a top-level sidebar item.
- Purchase option grouped routes exist under `/dashboard/purchase-options/*` and re-export the existing top-level pages.
- Do not delete existing top-level routes yet; they may still be linked internally or bookmarked.

## Current Pages / Routes

Public/auth pages:

- `/` — marketing landing page (premium rewrite — hero with lime "All in one system." accent, value-prop trio, features grid, "Built for your sport" dark section with 4 use-cases, pricing snapshot, footer with Terms/Privacy/Contact links)
- `/pricing` — dedicated tier comparison page with 14-day free trial messaging throughout, support promise card ("Email support included · 3–5 business day response · urgent → call"), 18-row comparison table with lucide Check/Minus icons, FAQ; linked from landing nav and footer
- `/terms` — public Terms of Service page (renders from `app/terms/page.tsx`, source of truth `legal/TERMS_OF_SERVICE.md`, DRAFT blockquote hidden from public render). 720px reading width, Fraunces headings, brand-violet links, version hash from `legal/versions.ts`
- `/privacy` — public Privacy Policy page (renders from `app/privacy/page.tsx`, source `legal/PRIVACY_POLICY.md`). Same chrome as /terms, two-role + COPPA structure
- `/sitemap.xml` and `/robots.txt` — Next 14 generated from `app/sitemap.ts` + `app/robots.ts`. Sitemap lists `/`, `/pricing`, `/login`, `/signup`. Robots allows public marketing routes, disallows `/api/`, `/dashboard/`, `/member/`, auth flows, `/onboarding`, `/setup`
- `/login`
- `/signup` — gated by a required "I agree to the Terms of Service and Privacy Policy" checkbox; server enforces `acceptedTerms: z.literal(true)` and writes two `LegalAcceptance` rows (TOS + PRIVACY) capturing version + timestamp + IP + user-agent
- `/forgot-password`
- `/reset-password`
- `/onboarding`

Dashboard pages:

- `/dashboard`
- `/dashboard/members`
- `/dashboard/staff`
- `/dashboard/staff/schedule` — weekly grid of availability + class/event assignments per staff
- `/dashboard/staff/availability` — per-staff weekly slots + date exceptions
- `/dashboard/staff/payroll` — date-ranged payroll table with CSV export
- `/dashboard/purchase-options`, `.../memberships`, `.../privates`, `.../products`
- `/dashboard/memberships`, `/dashboard/privates`, `/dashboard/products`
- `/dashboard/classes`
- `/dashboard/events`
- `/dashboard/calendar` — unified Events + Classes + Private Lessons monthly grid with kind + subtype filters
- `/dashboard/messages`
- `/dashboard/announcements`
- `/dashboard/communication/campaigns` — campaign analytics shell with KPIs, lead source breakdown, funnel/stage tracking, revenue attribution, and campaign activity foundation
- `/dashboard/attendance`
- `/dashboard/financials`
- `/dashboard/reports` — KPI cards, revenue chart, breakdowns, top events, CSV exports (gated by tier)
- `/dashboard/documents`
- `/dashboard/custom-fields`
- `/dashboard/help` — searchable help/FAQ center (knowledge base `lib/helpContent.ts`; retrieval = `/api/help/search`, AI-assistant-ready, no AI built)
- `/dashboard/settings`
- `/dashboard/settings/billing` — Stripe Connect + ClubOS subscription upgrade/portal + Diagnostics link
- `/dashboard/settings/club`
- `/dashboard/settings/member-form`
- `/dashboard/settings/diagnostics` — Stripe diagnostics: setup checklist, env vars, webhook event log
- `/dashboard/settings/email` — SMTP status, sender identity, **Send test email** button
- `/dashboard/my-account` — self-service password change + name update for owner & staff
- `/dashboard/preview` — Client View launcher: Preview Member Portal + public link list
- `/dashboard/schedule` (legacy; kept for back-compat)

Public / setup pages (unauthenticated):
- `/setup?token=...&club=<slug>` — first-time staff account activation (sets password via existing `/api/auth/reset-password`)
- `/e/[slug]` — public event registration with optional Member sign-in CTA

Member portal pages:

- `/member`
- `/member/schedule` — full member-facing schedule for classes, events, and private lesson offerings; respects active parent/child profile selection and shows eligibility/status messaging
- `/member/bookings` — child-switcher for parents; shows bookings per accessible member
- `/member/documents` — child-switcher + sign / re-sign with audit trail and frequency-based expiry
- `/member/profile` — account profile plus Family & athlete access area for parent/guardian switching and child linking
- `/member/signup` — same gated Terms/Privacy checkbox on step 3 of the wizard; server writes the same two `LegalAcceptance` rows on success. Also fetches `SIGNUP`-required club documents from `GET /api/member/signup?clubSlug=...`, renders them readably in step 3, requires acknowledgement before submit, and `POST /api/member/signup` records `DocumentSignature` rows for acknowledged signup docs.
- `/member/announcements`
- `/member/messages`, `.../dm/[userId]`, `.../group/[id]`
- `/member/memberships`
- `/member/events`
- `/member/products`
- `/member/shop` — purchase-options hub
- `/member/staff` — visible coach/owner bios + contact

## Current API Routes

> This list predates the 2026-06-07→17 work and is not exhaustive. Newer route areas are documented in the systems sections above: `/api/approvals` + `/api/members/migration/*` + `/api/members/[id]/guardians/approve` (Approvals & Migration), `/api/member/billing-portal` + `/api/member/subscriptions/request-cancel` + `/api/approvals/membership-cancel` (Member Billing), `/api/public/club-logo/[clubId]`, plus `/api/event-bundles`, `/api/discounts`, `/api/private-lessons/*`, `/api/contractors/*`, `/api/member/family/*`. The route tree under `app/api/` is the source of truth.

Auth:

- `/api/auth/[...nextauth]` — login `authorize()` now rate-limits 10 attempts / 10 min per IP via `lib/ratelimit`; session JWT `maxAge` explicitly set to 14 days (was inheriting 30-day default)
- `/api/auth/signup` — schema requires `acceptedTerms: z.literal(true)` + `termsVersion` + `privacyVersion`; writes two `LegalAcceptance` rows (TOS + PRIVACY) on success with IP + user-agent
- `/api/auth/forgot-password`
- `/api/auth/reset-password`
- `/api/auth/change-password`
- `/api/me` (GET — live role + permissions), `/api/me/profile` (PATCH — change own first/last name), `/api/preview` (GET/POST/DELETE — Client view cookie)

Club/settings:

- `/api/club/update` — also writes `aboutUs`, `memberBillingVisibility`, branded-app fields; `sport/tagline/primaryColor` are now `nullable` so blank-input saves don't 400
- `/api/club/info` — returns logo, tier, subscriptionStatus, stripeSubscriptionId, `memberBillingVisibility`, etc.
- `/api/club/email-test` — owner sends a one-off test email through the configured SMTP transport; returns ok or transport error
- `/api/club/profile`
- `/api/club/tier` — promo-code path only; paid tier upgrades go through `/api/club/subscription/checkout` (returns 400 if a paid tier is set without promo)
- `/api/club/notifications`
- `/api/club/locations`, `/api/club/locations/[id]` — `maxLocations` enforced from tier
- `/api/club/legal-entities`, `/api/club/legal-entities/[id]`
- `/api/club/donation-links`, `/api/club/donation-links/[id]`
- `/api/club/member-form` — GET/PUT for member intake form config
- `/api/club/subscription/checkout` — start Stripe Checkout for the ClubOS-own subscription (platform Stripe account, not Connect)
- `/api/club/subscription/portal` — open Stripe Billing Portal for the club owner

Core dashboard:

- `/api/members`
- `/api/members/[id]`
- `/api/members/[id]/credits`
- `/api/members/import`
- `/api/members/subscribe` — manual MANUAL path now calls `recomputeMemberStatus` so members flip ACTIVE immediately on assignment; honors `Membership.trialEnabled/trialDays/trialAppliesToReturning`
- `/api/members/subscriptions/[subId]` (DELETE) — owner cancel: cancels on Stripe (if attached) + locally + recomputes member status
- `/api/memberships`, `/api/memberships/[id]` — schema accepts trial fields
- `/api/custom-fields`, `/api/custom-fields/[id]`
- `/api/classes`, `/api/classes/[id]` — supports `dayOverrides`; PATCH regenerates future non-canceled sessions when scheduling changes, preserving sessions with attendance
- `/api/classes/[id]/sessions`
- `/api/classes/[id]/charge` — emits booking confirmation email on free membership-covered path
- `/api/events`, `/api/events/[id]`
- `/api/events/[id]/bookings`
- `/api/events/[id]/charge` — emits booking confirmation email on free membership-covered path
- `/api/events/[id]/staff`
- `/api/events/types`, `/api/events/types/[id]`
- `/api/attendance`
- `/api/attendance/[sessionId]` — also returns the parent class's `pricingOptions` and resolved `acceptedMemberships`
- `/api/calendar` — unified feed of events + class sessions + confirmed private lessons (used by `/dashboard/calendar`)
- `/api/search?q=` — universal club-scoped, permission-filtered search (members/staff/classes/events/products/memberships/documents/messages) with deep links; powers the dashboard top-bar `GlobalSearch` (⌘K, recent searches)
- `/api/help/search?q=` — keyword retrieval over `lib/helpContent.ts` (the layer a future AI assistant will call)

Reports:

- `/api/reports/overview?range=…` — tier-gated; returns revenue / member counts / subscription counts / attendance / top events / 12-month revenue series

Messaging/documents:

- `/api/messages`, `/api/messages/[id]`
- `/api/messages/dm`, `/api/messages/dm/[userId]`
- `/api/messages/groups`, `/api/messages/groups/[id]`
- `/api/announcements`, `/api/announcements/[id]` — broadcast emails gated on `emailSms` tier flag
- `/api/announcements/[id]/engagement` — owner/staff engagement detail for a specific announcement (seen/opened/clicked member list)
- `/api/campaigns/overview?range=…` — communication/campaign dashboard analytics from member lead fields, transactions, and campaign attribution rows
- `/api/documents`, `/api/documents/[id]` — schema accepts `signatureValidForDays`
- `/api/documents/[id]/signatures` — owner audit trail listing every signature on a document

Files:

- `/api/upload` — writes to `process.env.UPLOADS_DIR` (default `./storage/uploads`, gitignored, outside `public/`) with random storage key; returns `/api/files/[id]` URL
- `/api/files/[id]` — authenticated file serving; verifies `session.user.clubId === file.clubId`

Financial/payment/product:

- `/api/transactions`
- `/api/expenses`, `/api/expenses/[id]`
- `/api/discounts`, `/api/discounts/[id]`
- `/api/products`, `/api/products/[id]`
- `/api/products/[id]/sell`
- `/api/stripe/connect`
- `/api/stripe/status`
- `/api/stripe/dashboard`
- `/api/stripe/webhook` — idempotent (skips known event IDs), logs every event to `StripeWebhookEvent`, handles Connect events (member sub activate / renewal / payment_failed) AND platform events (ClubOS-own subscription activate / update / cancel)
- `/api/stripe/diagnostics` — owner-only; returns Connect + platform status, env checklist, event counts, last 50 events
- `/api/plaid/link-token`, `/api/plaid/exchange`, `/api/plaid/transactions` — gated on `plaid` tier flag (Pro+)
- `/api/plaid/connections` (GET/POST), `/api/plaid/connections/[id]` (PATCH/DELETE) — multi-bank: list/add/rename/disconnect connections
- `/api/transactions?bank=<connectionId>` and `/api/expenses?bank=<connectionId>` — filter financials by Plaid connection

Private lessons/staff/export:

- `/api/private-lessons/types`, `.../types/[id]`
- `/api/private-lessons/packages`, `.../packages/[id]`
- `/api/private-lessons/bookings`, `.../bookings/[id]`
- `/api/staff`, `/api/staff/[id]` — POST supports `sendSetupLink:true` (emails an activation link via `/setup`) OR `password` (legacy temp-password); resurrects a soft-deleted match instead of 409
- `/api/staff/[id]/setup-link` — POST: regenerates the 14-day setup token and returns the absolute `setupUrl`; surfaced via "Setup link" button on the staff list
- `/api/staff/[id]/availability`, `/api/staff/[id]/availability/exceptions`
- `/api/staff/[id]/pay-rates`
- `/api/staff/schedule?from=&to=` — weekly schedule aggregator (availability + classes + events)
- `/api/staff/payroll?from=&to=` — computes scheduled hours, class teaching hours (from `RecurringClass.assignedStaffIds`), hourly pay, salary, private lesson pay
- `/api/export/members`, `/api/export/attendance`, `/api/export/transactions`

Member-side:

- `/api/member/signup` — GET returns signup-required documents for a club slug; POST enforces Terms/Privacy plus all `SIGNUP` required documents, creates/resurrects the MEMBER user, writes `LegalAcceptance`, and records `DocumentSignature` rows for acknowledged signup documents.
- `/api/member/portal` — also returns per-accessible-member `summaries` (attendance30d, upcoming bookings, active membership) + each member's upcoming class `attendanceRecords` for the unified My Bookings view + `club.memberBillingVisibility` for the portal billing card; honors preview cookie for owner/staff with a sanitized stub
- `/api/member/portal/link-child` — parent/guardian can link an existing same-club member by email into `MemberGuardianUser`
- `/api/member/me` — GET/PATCH/DELETE own profile
- `/api/member/club` — public club info for portal (logo, tagline, aboutUs)
- `/api/member/staff` — visible staff (only `showOnPortal=true`)
- `/api/member/announcements`
- `/api/member/messages` — also returns `childConversations[]` and `childGroups[]` for guardian sessions, each tagged with `forMember`
- `/api/member/classes/book` — POST: member-self class booking with auto-detected price tier (MEMBERSHIP / MEMBER / NON_MEMBER / DROP_IN); free path for covered subs, Stripe Checkout otherwise
- `/api/member/announcements/[id]/engagement` — records member portal announcement opens and URL link clicks
- `/api/member/schedule?memberId=…` — active-profile-aware schedule feed for member portal; combines visible events, class sessions, membership/price status, bookings, and private lesson offerings
- `/api/member/documents?memberId=…` — context-aware; returns docs + signature status for a given accessible member (self or linked child); signature includes `expiresAt`/`expired` based on `signatureValidForDays`
- `/api/member/documents/[id]/sign` — POST persists a `DocumentSignature` with relationship (SELF | GUARDIAN), IP, user agent; enforces that minors can't self-sign guardian-required docs
- `/api/member/messages`, `.../dm/[userId]`, `.../groups/[id]`
- `/api/member/memberships`
- `/api/member/memberships/subscribe` — honors trial rules
- `/api/member/billing-portal`
- `/api/member/events`
- `/api/member/events/[id]/register` — emits booking confirmation email on free paths; accepts a verified `memberId` so parents can register the selected child profile safely
- `/api/member/products`, `.../products/[id]/buy`
- `/api/member/privates` — member private lesson request flow; validates coach/tier combinations server-side and rejects invalid pairings

## Current Prisma Schema Status

`prisma/schema.prisma` is the source of truth — **63 models** as of 2026-06-17. Newer models added since this list was written include `MemberMigrationEvent`, `MemberGuardianUser`, `MemberRelationship`, `MemberSubscription`, `Guardian`, `EventBundle`/`EventBundleItem`, `Discount`, `Product`/`ProductSale`, `Donation`/`DonationLink`, `PrivateLessonType`/`PrivatePackage`/`PrivateCreditLedger`/`PrivateBooking`/`PrivateBookingPartner`/`PrivateLessonPayRate`, `StaffCompensation`/`CompensationBonus`/`CompensationAssignment`/`Contractor`/`ContractorPayment`, `RecurringClass`/`ClassSession`/`AttendanceRecord`, `UploadedFile`, `EmailOptOut`, `LegalEntity`, `ClubProfile`. See "Critical Invariants" for the `members_userId` global-unique gotcha and the Supabase migration workflow.

Core models currently present:

- Tenant/auth: `Club`, `Location`, `User`, `StaffProfile`
- Members/family: `Member`, `Guardian`, `MemberGuardianUser`
- Purchase options: `Membership`, `MemberSubscription`, `Discount`, `Product`, `ProductSale`
- Classes/events: `RecurringClass`, `ClassSession`, `Event`, `EventSession`, `Booking`, `ClubEventType`, `AttendanceRecord`, `EventStaffAssignment`
- Messaging/announcements: `Message`, `MessageGroup`, `MessageGroupMember`, `GroupMessage`, `GroupMessageReceipt`, `Announcement`, `AnnouncementEngagement`
- Campaigns/lead attribution: `Campaign`, `CampaignAttribution`; `Member` carries lightweight `leadSource`, `leadStage`, `leadSourceUpdatedAt`
- Documents/settings: `Document`, `DocumentSignature`, `CustomField`, `ClubProfile`, `LegalEntity`, `DonationLink`
- Financials: `Transaction`, `Expense`, `PlaidConnection`
- Private lessons/staff: `PrivateLessonType`, `PrivatePackage`, `PrivateCreditLedger`, `PrivateBooking`, `PrivateLessonPayRate`, `StaffAvailability`, `StaffAvailabilityException`
- Infra: `UploadedFile`, `StripeWebhookEvent`, `LegalAcceptance` (audit-grade Terms/Privacy acceptance — one row per (user, documentType); `User.legalAcceptances` + `Club.legalAcceptances` reverse relations)

Notable model fields added since 2026-05-03:

- `Document.signatureValidForDays Int?` — null = sign-once, otherwise days until re-signature required
- `Document.requiredAt String[]` — surfaces where signing is mandatory (`ONBOARDING`, `SIGNUP`, `PURCHASE`, `EVENT`). `required` is mirrored for legacy UI/back-compat but must not be used as the only gate for new code.
- `Membership.trialEnabled Boolean`, `trialDays Int?`, `trialAppliesToReturning Boolean`
- `RecurringClass.dayOverrides Json` — `[{ dayOfWeek, startTime, endTime }, …]` — overrides default start/end times on specific days
- `Club.subscriptionStatus String?`, `stripeSubscriptionId String? @unique` (used for platform-side billing)
- `Product.productType`, `visibility`, `showLocation`, `taxable`, `internalNotes`, `settings` — product type system foundation for gear, rentals, birthday packages, digital items, and custom products
- `AnnouncementEngagement` + `GroupMessageReceipt` — shared communication engagement layer for announcement seen/open/click data and group-message read receipts
- `Campaign` + `CampaignAttribution`, plus member lead fields — campaign analytics/revenue attribution foundation
- `RecurringClass.visibility String @default("MEMBERS_ONLY")` — PUBLIC | MEMBERS_ONLY | PRIVATE; PRIVATE classes are roster-only on member surfaces
- `Club.memberBillingVisibility Json?` — owner-controlled toggles for plan / next-billing / price / invoices on the member portal
- `Club.timezone String?` — IANA zone of the physical club (migration `20260708000000_club_timezone`, applied); resolves wall-clock-UTC class times to real instants for the ICS feed, `/cal` embed, and check-in windows (`lib/datetime.ts wallClockUTCToInstant`). null = pre-timezone behavior everywhere
- `PlaidConnection` (clubId, label, institutionName, accessToken, itemId, accountsCache, soft-delete) — multi-bank Plaid support; `Transaction.plaidConnectionId` and `Expense.plaidConnectionId` FKs for filtering

Migration folders currently present:

- `20260425040936_init`
- `20260426212544_stripe_fields`
- `20260429174803_guardian_profile`
- `20260429192044_add_missing_core_tables` — broad migration; drops `events.price`
- `20260429203000_add_class_assigned_staff` — adds `recurring_classes.assignedStaffIds` (JSONB, default `[]`)
- `20260503031252_add_member_form_about_staff_bios` — adds `clubs.memberFormConfig` (JSONB, nullable), `clubs.aboutUs` (text, nullable), and `staff_profiles.bio`/`publicEmail`/`publicPhone`/`photoUrl`/`showOnPortal`
- `20260503103157_add_club_public_profile` — adds `clubs.contactEmail`, `contactPhone`, `coverImageUrl`, `hoursOfOperation`, `socialLinks`, `websiteUrl`
- `20260514000000_add_document_signatures` — `document_signatures` table
- `20260514100000_uploaded_files_and_sig_frequency` — `uploaded_files` table + `documents.signatureValidForDays`
- `20260514110000_stripe_webhook_events` — `stripe_webhook_events` table
- `20260515000000_class_overrides_membership_trial` — `recurring_classes.dayOverrides`, `memberships.trialEnabled/trialDays/trialAppliesToReturning`
- `20260515200000_event_registrations_tournaments` — `EventRegistration`, tournament/variable-cost fields
- `20260516000000_member_relationships_staff_location` — `MemberRelationship`, GPS, perSessionRate
- `20260516120000_modular_compensation` — `StaffCompensation`/`CompensationBonus`/`CompensationAssignment`
- `20260517000000_event_invoicing_dashboard_widgets` — `event_registrations.invoicedAt/invoiceCount`, `users.dashboardWidgets`
- `20260518000000_contractors_permissions_session_overrides` — `Contractor`/`ContractorPayment`, `class_sessions.staffOverride/note/overridden`
- `20260519000000_member_migration_wizard` — Member migration fields + `MemberMigrationEvent`
- `20260520000000_new_tier_system_processing_fees` — `clubs.tier` default `growth` (+ Starter→growth backfill), `clubs.passProcessingFees/processingFeeNote`
- `20260521000000_financial_os` — Transaction/Expense entity+category+method+receipt, `clubs.defaultLegalEntityId`, `Donation` model (idempotent SQL)
- `20260522000000_attendance_payment_method` — `attendance_records.paymentMethod/amountCharged`
- `20260523000000_migration_approval_flow` — Member migration approval (PENDING_APPROVAL, Stripe setup, editableFields, requestedBillingDate)
- `20260524000000_branded_app_config` — `Club.brandedAppConfig` (JSONB)
- `20260526000000_club_email_identity` — `Club.emailFromName/emailReplyTo`
- `20260527000000_migration_price_override` — `Member.migrationPriceOverride/migrationDiscountNote`
- `20260528000000_class_color_event_public_pricing` — `RecurringClass.color/textColor`, `Event.publicPricingOption`
- `20260529000000_branded_app_expense_kind` — `Club.appFontFamily/appTextAlign/appHomeContent/appCopy`, `Expense.kind`
- `20260518000001_private_lesson_partners` — `PrivateBookingPartner` table + `PrivateLessonType.maxAthletes`
- `20260530000000_builtin_event_colors` — `Club.builtInEventColors` (JSONB) — owner overrides for built-in EventType badge colors
- `20260531000000_staff_documents` — `StaffDocument` table (owner-uploaded tax docs / contracts / agreements per staff user, with sharedWithStaff visibility flag)
- `20260601000000_private_packages_multi_types` — `PrivatePackage.lessonTypeIds` (JSONB) for multi-type packages
- `20260602000000_package_discounts_bonus_thresholds` — `PrivatePackage.pricingMode` (FLAT | PERCENT | FIXED) + `discountValue` (Decimal?); `CompensationBonus.minThreshold` + `maxThreshold` (Int?)
- `20260603000000_campaigns_lead_attribution` — `Campaign`, `CampaignAttribution`, and member lead source/stage fields
- `20260603010000_communication_engagement` — `AnnouncementEngagement` and `GroupMessageReceipt`
- `20260603020000_product_type_system` — product type/visibility/show-location/taxable/internal-notes/settings fields on `Product`
- `20260604000000_class_visibility_message_read_dates` — `RecurringClass.visibility` (PUBLIC/MEMBERS_ONLY/PRIVATE), `AnnouncementEngagement` / `GroupMessageReceipt` index work
- `20260605000000_member_billing_visibility` — `Club.memberBillingVisibility` JSONB
- `20260607000000_plaid_multiple_banks` — `plaid_connections` table + nullable `plaidConnectionId` on `transactions` and `expenses`; backfills legacy single-bank rows
- `20260610000000_minor_parental_controls` — `members.birthdayLockedAt`, `members.parentControls` (JSONB), `pending_approvals` table for guardian-approval gate (P4)
- `20260611000000_legal_acceptances` — `legal_acceptances` table (id, userId, clubId?, documentType, version, acceptedAt, ipAddress?, userAgent?) with `(userId, documentType)` + `(clubId, documentType)` indexes; FK to users ON DELETE CASCADE, FK to clubs ON DELETE SET NULL. Two rows written per signup (TOS + PRIVACY) by `/api/auth/signup` and `/api/member/signup`
- `20260619000000_document_required_surfaces` — adds `documents.requiredAt` (`TEXT[]`, default `[]`) and backfills legacy required docs to `ARRAY['ONBOARDING']`. Surface filtering now lives in `lib/documents.ts`.

Current migration status:

- `npx prisma migrate status` currently fails locally with a bare `Schema engine error:` even though direct `psql` checks work and the additive 20260603 migrations were applied locally.
- `npx prisma validate` passes.
- New libs: `lib/permissions.ts`, `lib/apiGuard.ts`, `lib/fees.ts`, `lib/financials.ts`, `lib/financialReports.ts`, `lib/migration.ts`, `lib/migrationServer.ts`, `lib/memberLink.ts`, `lib/dashboardWidgets.ts`, `lib/datetime.ts`, `lib/activeProfile.ts`, `lib/categoryMatcher.ts`, `lib/privatePartners.ts`, `lib/memberMessaging.ts`, `lib/eventTypeColors.ts`, `lib/ratelimit.ts`, `lib/sanitizeHtml.ts`, `lib/baseUrl.ts`, `lib/signOutEverywhere.ts`, `lib/dashboardNav.ts`, `lib/preview.ts`, `lib/memberStatus.ts`, `lib/memberValidation.ts`, `lib/documents.ts`.
- Repo-root non-code deliverables: `licenses.json` (Task 1 audit output, 704 packages), `SECURITY_AUDIT_RESULTS.md` (Tasks 1-7 final prioritized report).
- `legal/` directory: `legal/TERMS_OF_SERVICE.md`, `legal/PRIVACY_POLICY.md` (verbatim sources with DRAFT blockquote), `legal/versions.ts` (TERMS_VERSION + PRIVACY_VERSION constants imported by `/terms`, `/privacy`, `/signup`, `/member/signup` so they cannot drift).
- New docs: `docs/android-verification.md` (Android setup + smoke + keystore + Play submission), `docs/proposed-migration-legal-acceptance.md` (kept as historical reference for the now-applied migration).
- Major additions this cycle: member-portal club branding + auto-link, event mass-invoicing + tournament pricing fix, customizable dashboard, Guest/Contractor management, staff roles/permissions + restricted staff view, per-occurrence class schedule edits, Member Migration wizard, new 3-tier pricing + pass-through fees, Financial OS, attendance cash/comp/invoice for non-members.

## Migration Warning Notes

- Do not use `prisma db push` for normal schema evolution.
- Do not run `prisma migrate reset` unless data loss is explicitly intended.
- Use `npx prisma migrate dev` only when intentionally changing `schema.prisma`. If you can't (shadow DB perms issue), hand-write the migration folder + SQL and run `npx prisma migrate deploy` — that's the pattern the recent migrations use.
- The earlier guardian-profile migration was rewritten defensively (creates/renames tables safely, only backfills if legacy inline columns existed).
- `20260429192044_add_missing_core_tables` is a broad migration that adds many feature tables and alters core tables. Review it carefully before editing, especially because it drops `events.price`.
- If `next build` fails with missing page modules after a dev server was running, stop the dev server and clear ignored `.next` artifacts before rebuilding.
- `next/font` fetches Google Fonts during a clean build. In restricted network environments, build may need network permission.

## Built And Working

### Core platform
- Auth pages and dashboard protection.
- Dashboard shell/sidebar with current dark-neutral design system.
- Dashboard overview: stats, calendar preview, quick links, recent members, upcoming events.
- Light/dark dashboard theme toggle. Member portal stays light by design.
- Brand assets in `public/brand/` wired into nav, member layout, dashboard sidebar, login/signup, onboarding, manifest icons. Tagline drives the landing headline.

### Members & memberships
- Members page with listing, filtering, add/edit, custom fields, CSV import (mapping mirrors enabled form fields), guardian/minor fields, membership purchase modal, export menu.
- Member intake form builder (`/dashboard/settings/member-form`, stored on `Club.memberFormConfig` JSON). First-run gate on `/dashboard/members` until the owner saves a config.
- **Member status auto-flip**: assigning a manual membership flips status to ACTIVE; canceling the last active sub flips to INACTIVE (via `recomputeMemberStatus` in `lib/memberStatus.ts`).
- **Membership trial rules**: owner toggles "Offer a free trial" + days (1-365) + "Allow returning members to use the trial again". Both owner-side and member-self subscribe routes pass `trial_period_days` to Stripe when eligible.
- Memberships page supports plans, options, billing controls, discounts, and now trial rules.

### Classes & events & calendar
- Classes page supports recurring class management and session viewing.
- **Per-day class time overrides**: classes have a default start/end time; the editor shows each selected day with a Custom/Defaults toggle for per-day times. Sessions are regenerated on schedule changes, preserving sessions that already have attendance recorded.
- Events page with listing, filters, event types, pricing fields, bookings modal, sessions, visibility/access, Stripe charge wiring.
- Class & Event create/edit forms have a top-level "Accepted Memberships / Purchase Options" multi-select. Selection persists on edit. Memberships are stored as `pricingOptions: [{ type: "membership", membershipId }, ...]` on the existing JSON column.
- Membership-based free booking is wired (both Events and Classes); emits a booking confirmation email on the free path.
- Attendance panel "Add Member" has a pricing chooser (Use accepted membership / Member / Non-member / Drop-in). Header surfaces "Accepted memberships: …".
- Stripe webhook handles `classId + classSessionId` branch: records `Transaction` (`type="CLASS"`) and upserts `AttendanceRecord` to `DROP_IN`.
- **Calendar page** rebuilt as a unified feed: events + class sessions + confirmed private lessons in one grid, with kind chips (Events / Classes / Private lessons) and a secondary subtype chip strip auto-built from items in the visible range. Items color-coded per kind/type with start times. Detail panel with deep-link to source section. Backed by `/api/calendar`. **Classes are NOT an event type** — `CLASS` was removed from the events editor dropdown; recurring classes live only on `/dashboard/classes` (`RecurringClass`).
- **Calendar day detail (Phase 2)**: clicking a day NUMBER opens a Day Detail panel listing every item on that day with full info (time, type, location, coach, capacity, pricing, description). Per-item **Edit** deep-link is now per-occurrence by default: class items → `/dashboard/classes?session=<classSessionId>` opens a `SessionEditModal` (start/end time, cancel toggle, substitute staff via `staffOverride`, one-off `note`) and sets `overridden=true` so the series regenerator preserves the customization. The modal has an explicit "Edit entire series →" button that jumps to `?edit=<classId>`. Multi-day event session items (id `<eventId>:<sessionId>`) deep-link to `/dashboard/events?session=<id>`; single-day events fall back to `?edit=<id>`. PATCH endpoint `app/api/classes/[id]/sessions/[sessionId]/route.ts`.
- **Dashboard mini-calendar refetch**: the mini calendar on `/dashboard` now refetches `/api/calendar` with an explicit `from`/`to` window when the visible month changes — fixes the regression where only the initial month (±1) had data while navigating prev/next showed empty.

### Staff documents (Phase 3)
- New `StaffDocument` model (table `staff_documents`) — owner uploads tax docs (W-9, 1099), contracts, agreements, certifications, or anything else to a staff member's profile. Each row stores `title`, `kind` (W9 | 1099 | CONTRACT | AGREEMENT | CERTIFICATION | OTHER), the file URL/metadata, and a `sharedWithStaff` boolean that controls staff-side visibility.
- Files use the existing private `/api/upload` → `/api/files/[id]` flow (club-scoped). Schema also stores fileName/mimeType/sizeBytes for display.
- API:
  - `GET /api/staff/[id]/documents` — owner list (everything, regardless of share flag)
  - `POST /api/staff/[id]/documents` — owner upload (after `/api/upload`)
  - `PATCH /api/staff/[id]/documents/[docId]` — toggle `sharedWithStaff`, rename, change kind, notes
  - `DELETE /api/staff/[id]/documents/[docId]` — soft delete (`deletedAt`)
  - `GET /api/me/staff-documents` — staff-facing list: returns ONLY this staff user's docs where `sharedWithStaff=true`. Owner-only docs are invisible.
- Owner UI: EditStaffModal now has a "Documents" panel below the main form with title + kind + visibility toggle, a **multi-select file picker** (one staff doc row per file picked; the title gets a `(n/total)` suffix when multiple are selected at once), and a list of existing docs (each with a per-row Visible-to-staff checkbox and a Delete button).
- Staff UI surface (the page that consumes `/api/me/staff-documents`) is NOT built yet — endpoint is wired and ready for a small "My documents" card to be added under `/dashboard/settings` for STAFF role next batch.
- **Built-in EventType colors (Phase 1)**: owners can override the colors for `CLASS`/`PRIVATE`/`CLINIC`/`CAMP`/`TOURNAMENT`/`OTHER` via **Manage Event Types** modal (a swatch picker per built-in type, Reset to revert to defaults). Persisted in `Club.builtInEventColors` (JSONB), returned by `/api/club/info`, accepted by `/api/club/update`, and resolved server-side in `/api/calendar` so the unified calendar grid honors the overrides everywhere. Custom `ClubEventType` colors still take precedence over built-in overrides. Source of truth helper: `lib/eventTypeColors.ts`.
- **Calendar feed enrichment**: `/api/calendar` items now include `description`, `location`, `coach`, and `price` so the day-detail panel can render full context without follow-up fetches.
- **Per-class color**: `RecurringClass.color/textColor` set in the class editor (palette of 11 named swatches + Default). Surfaced on the unified calendar.
- **Per-event public-pricing selector**: `Event.publicPricingOption` (MEMBER | NON_MEMBER | DROP_IN, null = auto/non-member) chooses which price the `/e/<slug>` public registration charges. Honored by `/api/public/events/[slug]` and `…/register`.
- **Public / non-member event registration**: any event can enable a public link at `/e/[publicSlug]` (auto-generated slug, never changes once set). The page shows the event image, info, price, and an owner-defined custom form. `EventRegistration` model captures signups (matches an existing member by email when possible). Free signups confirm immediately; priced signups go through Stripe Checkout on the club's connected account → webhook marks `PAID`, writes a `Transaction` (type `EVENT`), and creates a `Booking` if a member matched.
- **Tournament modes**: when event type = Tournament the editor offers **Host** (we run it — attach a registration form, public link auto-enabled) vs **Attend** (taking a team — gather signups + optional shared-cost split).
  - **Variable cost** (Attend only): split a shared total across attendees. **Estimated (prior)** charges each signup `total ÷ expectedSignups` at registration. **Official (post)** collects free signups, then the owner clicks **Bill registrants** (`POST /api/events/[id]/bill-registrants`) which splits the official total across active registrants, creates a Stripe Checkout link per person, emails it, and stamps `variableCostBilledAt` (idempotent; supports re-bill-unpaid). This is the "on unpublish" billing action.
  - Owner-defined registration **form builder** in the event editor (text / long text / email / phone / dropdown / checkbox fields, each optionally required). Stored as `Event.registrationForm` JSON. Registrations modal on the events list shows every signup with their form answers + payment status.

### Documents & signatures
- Documents page with list, editor, type/required flags, **signature renewal frequency** (Once / 30 / 90 / 180 / 365 / 730 days), Signatures button per doc that opens an audit modal showing every signature with member, signer, relationship, timestamp, IP, and Valid-until / Expired status.
- Member documents page handles signing (with two-step confirm), shows "✓ Signed" / "Signature expired" / re-sign UX, and includes a child-switcher for parents so they can sign on behalf of linked minors.
- `DocumentSignature` model captures the full audit trail (signer name, relationship SELF | GUARDIAN, signed-at, IP, user agent). API enforces that minors can't self-sign guardian-required docs.
- Documents render through `.doc-prose` on owner/member/signup surfaces so stored rich HTML is readable (paragraphs, headings, lists, tables, blockquotes). Store owner-authored HTML only after `sanitizeRichHtml()`.
- Required documents are now surface-aware: ONBOARDING docs block migration activation; SIGNUP docs render and are acknowledged during `/member/signup`; PURCHASE/EVENT are stored and ready for purchase/event enforcement work. Do not gate a flow on `Document.required` alone.

### Member portal (guardian/minor)
- `/member` portal home with separate Adult / Minor / Parent views and Link Child modal.
- `/member/schedule` is the main member-facing schedule surface. It shows visible classes, events, and private lesson offerings even when the member cannot book them. Cards and the detail modal show time, type, coach, location, description, capacity/spots, price/status, and eligibility text such as "Included in your membership", "Purchase required", "Members only", or "Registration closed".
- The member layout bottom nav now points the schedule tab to `/member/schedule`; `/member/bookings` remains available for already-registered sessions/history.
- Parents see a shared active-profile switcher across the portal (via `lib/activeProfile.ts`) and child-aware views on `/member/schedule`, `/member/bookings`, and `/member/documents`.
- `/member/profile` now includes a Family & athlete access area. Parents can see linked athletes, switch the selected athlete, and link/request an existing same-club child/member by email through `/api/member/portal/link-child`.
- Child/minor accounts stay scoped to their own profile and do not get the child-linking form.
- `MemberGuardianUser` junction records portal access; guardians are still the family profile and not duplicated.
- Login separation: `/login` routes by the authenticated account's real role. Members who submit through the Club/Staff tab get a clear member-account redirect and land in `/member`; owners/staff land in `/dashboard`. Middleware redirects MEMBER away from `/dashboard` and redirects OWNER/STAFF away from `/member` because member APIs are role-scoped.

### Reports
- `/dashboard/reports` with KPI cards (revenue / net / new members / attendance), 12-month revenue bar chart, breakdowns (revenue by source, members by status, subscriptions, attendance, top events, expenses by category), and CSV export links for members / attendance / transactions.
- `/api/reports/overview` is tier-gated by feature flag; reports page shows an upgrade CTA when 403'd.

### Campaigns & communication engagement
- `/dashboard/communication/campaigns` is a first-pass Campaigns dashboard under the existing Communication group. It includes KPI cards (New Leads, Intro Offers Sold, First Time Bookings, Clients Won Back, Marketing Revenue), Leads by Source donut/table, Leads by Stage funnel, Revenue Attribution, and Campaign Activity empty state.
- Data architecture is real, not UI-only: `Campaign` stores campaign metadata (type/status/dates/audience/channel plan/revenue + lead attribution mode), and `CampaignAttribution` can link campaigns to members and transactions. `Member.leadSource/leadStage` provide a lightweight attribution foundation until owner-editable CRM flows exist.
- `/api/campaigns/overview` computes fallback analytics from existing members and transactions. SMS/push are marked as future-ready hooks only; there is no fake SMS/push delivery.
- Announcements now have per-user engagement via `AnnouncementEngagement`: member announcement list marks `seen`, opening the announcement detail marks `opened`, and clicking an `http(s)` URL inside the announcement body marks a **Link click**. Owner Announcements UI labels this clearly as Seen / Opened / Link clicks and the Engagement modal explains the distinction.
- Group messages now have per-user `GroupMessageReceipt` rows when users open a group thread. Group-message bubbles show "Read X" for messages the current user sent.
- Direct messages already had `Message.readAt`; UI now surfaces Sent/Read for sent DMs.

### Staff scheduling, availability, payroll
- `/dashboard/staff/availability` — pick a staff member, edit per-day recurring slots, add/remove date exceptions (`UNAVAILABLE` or `PARTIAL` with modified hours).
- `/dashboard/staff/schedule` — weekly grid (Sun-Sat columns × staff rows) showing availability windows, class assignments (expanded from `RecurringClass.assignedStaffIds`), event assignments (`EventStaffAssignment`), and date exceptions. Prev / This week / Next nav.
- `/dashboard/staff/payroll` — date range presets + custom; per-staff table of scheduled hours, **class teaching hours** (with per-class breakdown in expandable details), hourly pay, salary, private lesson pay. CSV export.
- Backed by `/api/staff/schedule` and `/api/staff/payroll`.

### Owner Dashboard follow-up phases 4-6
- **Private lesson duration/packages (Phase 4)**: private lesson type duration is now limited to owner presets in 15-minute increments from 15 minutes through 4 hours (`lib/privateLessonRules.ts`). API validation enforces the same rule. Private packages now support one or more lesson types via `PrivatePackage.lessonTypeIds` JSONB while preserving legacy `lessonTypeId`. Member private requests derive end time from the lesson duration; athletes no longer choose custom duration. When a member has usable package credits, they can submit multiple requested lesson dates/times up to their remaining package balance, creating one request per requested lesson.
- **Member private lesson tier/coach filtering**: member private requests now treat coach and pricing tier as linked choices. Selecting a coach filters to only that coach's assigned price options; selecting a price option filters to eligible coaches. Server-side `/api/member/privates` revalidates the pairing using `PrivateLessonType.priceOptions[].coachIds`, `eligibleCoachIds`, and all active owner/staff fallback, so invalid coach-tier combinations cannot be booked even if the UI is bypassed.
- **Staff bonus clarity (Phase 5)**: compensation UI now presents signup bonus as “pay on next paycheck” and class growth/retention as a per-kid/per-class incentive. Existing payroll computation uses `SIGNUP` for once-per-period signup/purchase bonuses and `ATTENDANCE` for scoped class/event attendance incentives.
- **Bonus thresholds**: every bonus row now supports optional `minThreshold` / `maxThreshold` (Int?). The engine in `lib/compensation.ts` only pays for the slice of items *above* min and *up to* max — e.g. "bonus starts after 10 athletes, caps at 25". REVENUE_SHARE applies the same slice to qualifying items in collection order so dollar revenue reflects the same window. Editor fields are surfaced under each bonus card on `/dashboard/staff`.
- **Tier-aware private packages**: `PrivatePackage.pricingMode` + `discountValue` let a package describe a per-lesson discount instead of a flat total — PERCENT (% off each tier price) or FIXED ($ off each tier price). The package modal shows a live tier-by-tier pricing preview, and the Assign Package modal picks lesson type + coach tier and shows the computed total. `lib/privateLessonRules.ts` exposes `packageTotalForBasePrice()` and `pricePerLessonAfterDiscount()` so the booking + member-side purchase flows can compute the correct prepaid total for the chosen tier. Legacy `FLAT` mode continues to honor the stored `price` field.
- **Payroll in Financials/Reports (Phase 6)**: `lib/payroll.ts` computes staff payout totals from the same compensation engine used by Payroll/Payouts. Reports and Financials fold computed staff payroll plus contractor payments into the `PAYROLL` expense category so owners do not have to manually enter payroll for accurate net/expense reporting.

### Product type system
- Sidebar remains **Purchase Options → Products**. Do not rename Products.
- `Product` now supports `productType` values: `GEAR`, `FACILITY_RENTAL`, `BIRTHDAY_PARTY`, `DIGITAL`, `OTHER`.
- Product metadata fields: `visibility` (`MEMBERS_ONLY`, `PUBLIC_ONLY`, `MEMBERS_AND_PUBLIC`, `INTERNAL_ONLY`), `showLocation` (`MEMBER_PORTAL`, `PUBLIC_CHECKOUT`, `INTERNAL_ONLY`), `taxable`, `internalNotes`, and flexible JSON `settings`.
- Owner Products form starts with product type selection and conditionally shows relevant sections:
  - Gear / Merchandise: inventory tracking, total stock, low-stock alert, variant/options notes, per-variant stock notes, fulfillment setting.
  - Facility Rental: available days, time windows, duration pricing, buffer, capacity, approval requirement, deposit/full/request mode, blackout dates, member price.
  - Birthday Party / Rental Package: package tiers, duration/price notes, max guests, add-ons, deposit/approval, custom form questions.
  - Digital Item: delivery instructions and access/file notes using the existing private-file strategy when files are needed.
  - Other: flexible custom questions and optional approval requirement.
- Existing gear/product sales remain backed by `ProductSale` and Stripe/manual sale routes. Member store filters out internal/public-only products and blocks rental/party types from old instant checkout until the product booking/request model is built.
- Full rental/party booking records, variant-aware checkout/inventory decrement, public checkout links, and automated digital file delivery are not complete yet. The owner form captures the needed configuration in `Product.settings` for the next booking/checkout phase.

### Stripe / billing / file storage
- Stripe Connect (member → club) onboarding, status sync, dashboard redirect, Checkout, webhook flows.
- Member subscription activation / renewal / cancellation through webhook handlers.
- **ClubOS platform subscription billing** (club → AthletixOS):
  - `/api/club/subscription/checkout` opens platform-account Stripe Checkout for the chosen tier (uses `STRIPE_PRICE_GROWTH / STRIPE_PRICE_PRO / STRIPE_PRICE_ENTERPRISE` env vars).
  - `/api/club/subscription/portal` opens Stripe Billing Portal for plan-swap / card / invoice / cancel.
  - Webhook handles platform `checkout.session.completed` (sets tier + `stripeCustomerId` + `stripeSubscriptionId` + `subscriptionStatus="active"`), `customer.subscription.updated` (status sync + tier swap via Price-ID mapping), and `customer.subscription.deleted` (keeps tier, sets `subscriptionStatus="canceled"`; no Starter fallback).
  - `/api/club/tier` PATCH blocks direct paid-tier set without a promo code; paid plans must go through Checkout.
- **Webhook hardening + observability**: `StripeWebhookEvent` table logs every event with idempotency (skips duplicates by `stripeEventId`). Failures are caught and the error stored on the row instead of 500'ing — Stripe doesn't retry-storm on persistent bugs.
- **Diagnostics page** at `/dashboard/settings/diagnostics`: setup checklist (env vars, Connect status, Price IDs), 24h / total / error counts, last 50 webhook events with status badges and live-mode indicators, copy-paste webhook URL.
- **Private file storage**: `/api/upload` writes to `./storage/uploads` (gitignored, outside `public/`) with random 32-hex storage keys + an `UploadedFile` row. Files served only via `/api/files/[id]` which enforces `session.user.clubId === file.clubId`. Old `/public/uploads/*` URLs from earlier uploads still resolve via Next static serving for back-compat.

### Email notifications (transactional)
Templates in `lib/email.ts`: `sendWelcomeEmail`, `sendStaffInviteEmail`, `sendPasswordResetEmail`, `sendBookingConfirmationEmail`, `sendMembershipActivatedEmail`, `sendPaymentFailedEmail`. Wired into:

| Trigger                                                        | Recipient                          |
|----------------------------------------------------------------|------------------------------------|
| Owner adds staff (`POST /api/staff`)                           | New staff member with temp password |
| Owner adds member (`POST /api/members`)                        | Member email (or guardian for minors); points to `/member/signup` |
| Free membership-covered event booking (owner-side charge)      | Member (or guardian)               |
| Free membership-covered class drop-in (owner-side charge)      | Member (or guardian)               |
| Member-side free / membership-covered event registration       | Self / guardian                    |
| Stripe checkout.session.completed (membership activated)       | Member                             |
| Stripe checkout.session.completed (paid event / class booking) | Member                             |
| Stripe invoice.payment_failed                                  | Member                             |
| Announcement broadcast with email channel selected             | All filtered recipients            |

All sends are `try/catch` + `console.error` — a failed email never breaks the underlying flow. Recipient resolution prefers guardian email for minors, then member email, then linked User email.

### Club personalization
- `Club.aboutUs`, `coverImageUrl`, `contactEmail`, `contactPhone`, `websiteUrl`, `socialLinks`, `hoursOfOperation` all editable on `/dashboard/settings/club`.
- `StaffProfile` has `bio`, `publicEmail`, `publicPhone`, `photoUrl`, `showOnPortal`. Edited on `/dashboard/staff` Edit modal in a "Member portal profile" section.
- `/member/staff` page shows photo, title, bio, mailto/tel links for staff with `showOnPortal=true`.
- Member portal home (Adult, Minor, Parent views) renders a `ClubBanner` with logo + name + tagline + About Us + contact info + hours.

### Misc
- Members CSV import mapping mirrors the Add Member form (name, email, phone, DOB, gender, full address, status, tags, notes, isMinor, guardian fields, active custom fields). Membership assignment via CSV was removed.
- Public marketing landing at `/` with embedded tiers; `/pricing` page with 4-tier card grid, comparison table, FAQ.
- Export endpoints (members, attendance, transactions) gated on `reports` tier flag.

### Staff invite & self-service (2026-06-06)
- **Setup-link invite flow**: Add Staff modal defaults to "Email setup link". `/api/staff` (POST) with `sendSetupLink:true` creates the user with a random throwaway hash + a 14-day `resetToken` and emails a link to `/setup?token=...&club=<slug>`. The user picks their own password via the existing `/api/auth/reset-password` endpoint (single-use by construction). Legacy temp-password mode is still available as a toggle.
- Owner-resilient invite: `POST /api/staff` returns the absolute `setupUrl` + `emailed`/`emailError` flags. The modal swaps to a confirmation panel with a "Copy link" button so the owner can hand-deliver the link if SMTP isn't configured or email lands in spam.
- **Resend setup link**: `POST /api/staff/[id]/setup-link` regenerates a fresh 14-day token and returns the URL. Staff list has a per-row **Setup link** button (next to Edit/Remove) that surfaces the URL via prompt.
- **Soft-delete + re-add**: `POST /api/staff` now resurrects a soft-deleted match (clears `deletedAt`, refreshes name/password/permissions) instead of returning 409. Active duplicates still 409 as before.
- **`/dashboard/my-account`**: Every signed-in dashboard user (owner OR staff, regardless of permissions) gets a self-service account page. Lets them change their password (existing `/api/auth/change-password`) and update first/last name (new `PATCH /api/me/profile`). Linked from the sidebar above "Client view" so staff have somewhere to go even with no other section access.
- Privates API mutations were hardcoded `role !== "OWNER"`; swapped to `requirePermission(session, "events", "edit"|"full")` so a head coach with `events:full` can now create / edit / duplicate / delete privates types & packages.

### Client / Preview mode (2026-06-06)
- `lib/preview.ts` defines a `PREVIEW_COOKIE = "aox_preview"` ("member" | "public"), an 8h HttpOnly SameSite=Lax cookie. Owner/staff only.
- `POST /api/preview { mode }` sets the cookie; `DELETE /api/preview` clears it; `GET /api/preview` reads it (member layout polls this to render the banner).
- Middleware: when an owner/staff session has `aox_preview=member`, the `/member/*` redirect-to-dashboard guard is skipped so the member layout renders for them.
- `/api/member/portal` and `/api/member/schedule` honor the cookie: when role is not MEMBER but cookie+role pass `canStartPreview()`, they return a sanitized PREVIEW payload (club brand only, no real bookings/subscriptions, empty schedule). Real member data never leaks.
- Member layout shows an amber **"Preview mode — Exit preview"** banner whenever the cookie is present. Exit calls `DELETE /api/preview` and bounces back to `/dashboard`.
- `/dashboard/preview` launcher: "Preview Member Portal" button + curated public-link list (landing, pricing, signup, sign-in with club prefilled, every `/e/<publicSlug>` the club has live). Tier-agnostic — every tier can use it. Linked from the sidebar as **"Client view"**.

### Member portal: nav + classes + family (2026-06-04 → 2026-06-05)
- **Class visibility**: `RecurringClass.visibility` enum (`PUBLIC | MEMBERS_ONLY | PRIVATE`, default `MEMBERS_ONLY`). 3-tile picker on `/dashboard/classes`. `/api/member/schedule` filters to `PUBLIC + MEMBERS_ONLY`; `PRIVATE` classes are roster-only.
- **Member schedule** hides events by default (gated by `INCLUDE_EVENTS_IN_SCHEDULE = false`); events live on `/member/events`.
- **Read receipts with timestamps**: DM bubbles show `Read Aug 24, 7:42 PM`. Group messages show `Read N` → expandable reader list with per-user timestamps (`AnnouncementEngagement` + `GroupMessageReceipt` rows; group messages route returns `readers[]`). Owner-side timestamps are now legible on the violet bubble — fixed `text-text-muted` → `text-white/75` for own messages.
- **Family switcher** on `/member/profile` shows DOB / computed age / `Minor` flag per linked athlete.
- **Parent quick-dashboard per child**: `/api/member/portal` returns per-member `summaries` (`attendanceLast30d`, `upcomingBookings`, `activeMembershipName`). `/member/profile` renders a 3-tile mini dashboard per linked athlete under DOB row.
- **Parent sees child messages**: `/api/member/messages` adds `childConversations[]` and `childGroups[]` for DMs/groups belonging to linked child User accounts, tagged with `forMember:{id,firstName,lastName}`. `/member/messages` renders a "Messages for your athletes" section with a "For \<child\>" chip per row.
- **Owner-controlled billing visibility**: `Club.memberBillingVisibility JSON?` ({showPlan, showNextBilling, showPrice, showInvoices}). Settings → **Member Portal** sidebar tab exposes the 4 toggles. `/member/profile` Payment & billing conditionally renders plan/next-billing/price + "View invoices" link based on these flags.
- **Member portal nav**: Layout nav has Home / Schedule / Messages / News (Announcements) / Docs / Profile so every section is discoverable. Home tiles include Bookings, Messages, Announcements, Documents, Our team.
- **My Bookings includes classes**: `/api/member/portal` returns each accessible member's upcoming class `AttendanceRecord`s (PRESENT/LATE/DROP_IN/TRIAL with future `classSession.startsAt`) + the recurring class's color + assignedStaffIds. `/member/bookings` merges them into the unified list with coach (resolved via `/api/member/staff`), sorted chronologically.

### Member class self-booking with auto-detected price (2026-06-05)
- `/api/member/schedule` computes a `bookingTier` per class (`MEMBERSHIP | MEMBER | NON_MEMBER | DROP_IN`) from the member's subscription state, plus `bookingLabel` and `price`.
- `POST /api/member/classes/book` validates the resolved tier server-side, creates an `AttendanceRecord` for the free path or opens Stripe Checkout on the club's connected account otherwise.
- `/member/schedule` modal shows resolved price + a **Book** button per class.

### Public event link improvements (2026-06-05)
- `/e/[slug]` header now has a **"Member sign in"** link (callbackUrl back to the same `/e/<slug>`) for signed-out visitors and a **"Member portal"** link for signed-in ones.
- Below the cost row, a banner tells members to register from the portal (so they get member pricing / membership coverage), and tells signed-out viewers they can sign in to use member pricing.

### Back button — universal (2026-06-07)
- `components/BackButton.tsx`: uses `router.back()` when history is poppable; falls back to `/dashboard` (owner/staff) or `/member` (members) — caller can override with `fallbackHref`.
- Dashboard layout puts a back button in the sticky topbar on every page except `/dashboard` home.
- Member layout puts a back button above page content on every `/member/*` page except `/member` home.

### Plaid multiple bank accounts (2026-06-07)
- **New model `PlaidConnection`** (clubId, label, institutionName, accessToken, itemId, accountsCache JSON, soft-delete). Legacy `Club.plaidAccessToken/plaidItemId` stay populated for back-compat; the new code lazy-migrates them into a `PlaidConnection` row on first read.
- Migration `20260607000000_plaid_multiple_banks` adds `plaid_connections` + nullable `plaidConnectionId` FK on `Transaction` and `Expense` (ON DELETE SET NULL), and backfills existing single-bank into a row.
- API: `GET/POST /api/plaid/connections` (list + add via Plaid Link); `PATCH/DELETE /api/plaid/connections/[id]` (rename + soft-disconnect). `/api/plaid/transactions` aggregates across every connection and accepts `?connectionId=` to filter. `/api/plaid/exchange` still works and now also creates a connection row.
- Tier-gating: `plaid` feature flag in `lib/tier.ts` stays Pro+. Multi-account is naturally Pro+ as a result. Plaid response 403s with `upgradeRequired: "pro"` on Growth.
- Filtering: `/api/transactions` and `/api/expenses` accept `?bank=<connectionId>`. `POST /api/expenses` accepts `plaidConnectionId`.
- UI: **Financials → Bank** tab lists every connection (label / rename / disconnect), shows a **+ Add bank** CTA, and a per-bank filter dropdown when 2+ banks are connected. Transactions table includes a Bank column.

### Event image cropping (2026-06-07)
- Schema columns `Event.imagePositionX/Y` (Int, default 50, 0–100%) were already present. Public `/e/[slug]` already uses them via CSS `object-position`. The missing piece was the editor UI.
- **`EventImageFocalPicker`** inside the event modal: click/drag inside a 16:9 preview (matches the public page) to set the focal point. Stored as percentages, applied via `object-position` — no re-encoding, no new files. Includes "Reset to center".

### Privates confirmation UX (2026-06-07)
- Requested-slot rows in the booking modal render as **"Thu, Jun 15 · 2:30 PM – 3:30 PM"** (locale weekday + AM/PM) instead of `YYYY-MM-DD · HH:mm` (which read like military time).
- Each requested-slot row has an **"Accept this time"** button that pre-fills `confirmedStart`/`confirmedEnd` from the slot and opens the confirm form in one click.
- The main **"Confirm or change time"** button also pre-fills with the first requested slot so the default action is a single click — owner can still tweak.
- `fmt()` forces `hour12: true` so the OS locale never falls back to 24h on the owner-facing UI.

### Email / SMTP (2026-06-07)
- `lib/email.ts` reads SMTP from env at runtime: `SMTP_HOST`, `SMTP_PORT` (default 587), `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`, `EMAIL_FROM`. Nothing hardcoded.
- New `POST /api/club/email-test` (owner only) sends a real email via the configured transport and returns `ok:true/false` + error message. Settings → Email shows a **"Send test email"** form with an optional recipient override (defaults to the owner's login email).
- Per-club `emailFromName` and `emailReplyTo` (existing) flow through `sendEmail()` so members see the club's friendly name in their inbox.

### Club profile persistence fix (2026-06-07)
- `/api/club/update` Zod schema now allows `null` on `sport`, `tagline`, and `primaryColor`. Previously the schema was `.optional()` only (not `.nullable()`); clients sent `null` for empty fields, Zod rejected the whole request, and only the required `name`/`slug` appeared to persist.
- Inline `ProfileSection` re-hydrates state with `useEffect` when the `club` prop changes after save, so the form never shows stale values.
- Inline Profile tab now links to `/dashboard/settings/club` for the extended fields (About Us, cover image, hours, contact, social links) so the full editor is discoverable.

### Native AthletixOS app shell setup (2026-06-07)

Checkpoint commit: `c5021307bf6718776acbf7e2cadc52fb602f9d56` on branch `native-app-shell`; pushed to origin. Not merged to `main`.

What was added:
- Capacitor config at `capacitor.config.ts`.
- Native iOS project under `ios/`.
- Native Android project under `android/`.
- Native fallback assets under `public/native-shell/`.
- Native source/icon placeholder under `assets/native/`.
- Internal launch checklist at `docs/native-launch-checklist.md`.
- NPM scripts: `cap:sync`, `cap:ios`, `cap:android`.

Current native shell decisions:
- This is one AthletixOS native shell, not React Native and not separate per-club apps.
- App name is `AthletixOS`.
- iOS bundle ID and Android package ID are both `com.athletixos.app`.
- The Capacitor shell points to the existing web/member portal and starts at `/member`.
- Default local native URL is `http://127.0.0.1:3000`.
- Release/native test URL should be set with `CAPACITOR_SERVER_URL=https://<production-domain>` before `npx cap sync`.
- Fallback server URL order in `capacitor.config.ts`: `CAPACITOR_SERVER_URL`, then `NEXT_PUBLIC_APP_URL`, then `http://127.0.0.1:3000`. `NEXTAUTH_URL` is intentionally NOT in this chain — a misconfigured `.env` would otherwise poison the WebView's start URL.
- Native shell appends `AthletixOSNativeShell` to the user agent.
- Native shell is portrait-oriented to match the member portal mobile flow.
- Placeholder native icons/splash assets are generated from the existing AthletixOS brand icon. Replace with final 1024x1024 app art before store submission.

Web/mobile changes made for the native shell:
- `app/layout.tsx` now sets `viewportFit: "cover"`.
- `app/globals.css` includes safe-area helpers and disables vertical overscroll bounce.
- `app/member/layout.tsx` applies iOS safe-area padding to the mobile header, content, and bottom nav.
- Existing PWA manifest and service worker path were preserved.
- Existing NextAuth credentials/JWT session flow was preserved; no native-only auth was added.
- Existing localStorage-based parent/athlete switching was preserved.
- Stripe checkout links still use the existing web redirect/window flows; verify on device because platform browser behavior can differ.

Branded App page reframe:
- `/dashboard/settings/branded-app` now labels itself as member portal branding.
- It explains what is available now: member portal branding, PWA branding, native AthletixOS shell.
- It explains future roadmap: separate per-club App Store apps, automated app submissions, native push.
- It hides the misleading unused per-club native sections from the editor UI for now, but does not delete saved `brandedAppConfig` data.
- The inline Settings > Branded App roadmap now says the native app is one AthletixOS shell and club branding happens inside the app after login.

Verification already run:
- `npx prisma validate` passed.
- `npx prisma generate` passed.
- `npx tsc --noEmit` passed.
- `npm run build` passed.
- `npx cap sync` passed.
- Browser smoke: mobile `/member` redirects to login when unauthenticated, and `public/native-shell/index.html` plus `native-shell-error.html` render.

Important follow-up tests:
- Run `CAPACITOR_SERVER_URL=https://<production-domain> npx cap sync` before release-device testing.
- Open iOS with `npm run cap:ios`, set signing team in Xcode, run simulator/device.
- Open Android with `npm run cap:android`, let Gradle sync, run emulator/device.
- In the native shell, test member login, member home, schedule, bookings, products, memberships, announcements, messages, documents, and profile switching.
- Test guardian/parent switching specifically.
- Test Stripe checkout/billing portal handoff and return behavior from inside iOS and Android webviews.
- Re-test PWA install from Safari and Chrome to confirm PWA behavior remains intact.

Manual launch checklist lives in `docs/native-launch-checklist.md` and covers Apple Developer, Google Play Console, icons, splash, privacy/support URLs, screenshots, demo login, and review prep.

## Built But Needs End-to-End Testing

These flows exist in code but haven't been verified against a live Stripe environment with webhook forwarding:

- Stripe Connect onboarding, status sync, dashboard redirect, Checkout, webhook (Connect events).
- ClubOS platform subscription Checkout end-to-end (need live Price IDs in env).
- Member subscription activation / renewal / cancellation through real Stripe webhooks.
- Trial period flow (Stripe should hold the first charge until trial ends).
- Product sales and Stripe payment path.
- Paid event/class drop-in via charge → Stripe Checkout → webhook creating `Transaction` and `Booking` / `AttendanceRecord`.
- Plaid link token / exchange / transactions flow.
- Email send-out under real SMTP credentials (currently `console.log` fallback if `SMTP_HOST` unset).
- Document signature re-sign flow once a signature actually expires by `signatureValidForDays`.

## Partially Built / Wired Inconsistently

- Some old top-level routes remain alongside newer grouped routes, especially purchase options.
- `/dashboard/schedule` and `/dashboard/staff/schedule` both exist; current sidebar points under Staff.
- Add Staff (invite) modal does not collect bio/photo/public-contact fields yet — only the Edit Staff modal does. Owner adds the staff member, then opens Edit to fill the public profile.
- Tier-gating helper `requireGrowth` in `/api/messages/*` is effectively a no-op since `directMessaging=true` on all current paid tiers. Leave in place if policy might flip.
- Member-side messaging, memberships, events, products endpoints check session but don't apply tier gating beyond what the owner's plan allows.
- Member portal stays light-themed intentionally; raw `bg-stone-*` / `bg-white` / `text-stone-*` classes there will not respond to the dashboard dark-mode toggle.

## Not Built Yet

- Multi-location full UX (schema + `maxLocations` gating in place, but the locations page is thin).
- Separate per-club native mobile apps.
- SMS broadcast delivery (template + UI flag exists; provider not wired).
- Push notifications.
- Full report builder (current `/dashboard/reports` is fixed-shape).
- Complete recurring class roster/enrollment product (sessions exist; UX for enrollment vs. attendance not finalized).
- Theme preference persisted to a User column (currently localStorage only).
- Bio/photo/public-contact fields in the Add Staff (invite) modal — currently Edit-only.
- Optimized/compressed brand assets (`logo.PNG` and `circle.PNG` are ~1 MB each; should be compressed before production rollout).

## Known Issues

- Build can fail if a dev server is writing `.next` while production build reads it. Stop dev server and clear `.next` if page manifest errors appear.
- Clean builds may require network access for Google Fonts.
- `pg_dump` from PostgreSQL 16 cannot dump the local PostgreSQL 18 database. Use `/Library/PostgreSQL/18/bin/pg_dump`.
- Dashboard design is mostly tokenized, but new pages must continue using the current tokens.
- Existing routes and APIs are broad; inspect before adding duplicates.
- Pending Prisma migrations silently break write paths long after schema/code look correct. Always check `npx prisma migrate status` first when a single model's writes start failing.
- The paid Events/Classes booking flow opens Stripe Checkout in a new tab and does not auto-create the booking client-side; the membership-covered branch creates it inline, the paid branch relies on the webhook.
- `prisma migrate dev` may fail on shadow-database permissions. The fix is to hand-write the migration folder + SQL and run `npx prisma migrate deploy` (the four most recent migrations were created this way).

## What To Avoid Next Time

- Do not rebuild existing features from scratch without reading current pages, APIs, schema, and migrations.
- Do not use `prisma db push`.
- Do not run `prisma migrate reset` unless explicitly intending to wipe local data.
- Do not create broad migrations that drop columns without a preservation/backfill plan.
- Do not reintroduce old color classes or random color families.
- Do not stage `.env`, `.next`, `node_modules`, local SQL backups, or debug archives.
- Do not store new uploads under `/public/uploads` — use the private storage flow via `/api/upload` so files are club-scoped.
- Do not leave dev server running while doing production build verification.
- Do not assume a feature is done because an API route exists.

## Required Env Vars

Documented in `.env.example`. Critical for production:

- `DATABASE_URL` — Postgres
- `NEXTAUTH_URL` — drives email links and Stripe success/cancel redirects
- `NEXTAUTH_SECRET`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_GROWTH` / `STRIPE_PRICE_PRO` / `STRIPE_PRICE_ENTERPRISE` — recurring Price IDs for the ClubOS-own tiers (different in test vs live mode)
- `NEXT_PUBLIC_SITE_URL` — production absolute URL (default fallback `https://athletix-os.com`); drives canonical/OG/JSON-LD/sitemap/robots
- `NEXT_PUBLIC_APP_URL` — the app's external URL the Capacitor native shell loads (and `getAppBaseUrl()` falls back from `NEXTAUTH_URL`); set to `https://athletix-os.com` in prod
- `DIRECT_URL` — **direct (non-pooler) Postgres URL for Prisma migrations.** Prisma's `directUrl` in `schema.prisma`. Required because migrations can't run through the Supabase pooler. See "Critical Invariants & Serverless Gotchas → DB migrations".
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_STORAGE_BUCKET` (default `uploads`) — production file storage (`lib/storage.ts`). When unset, storage falls back to local disk.
- `UPLOADS_DIR` (optional local-dev disk fallback; defaults to `./storage/uploads`)
- `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE` / `EMAIL_FROM` (optional; falls back to `console.log` if `SMTP_HOST` missing). Set `EMAIL_FROM=AthletixOS <noreply@athletix-os.com>` in prod
- `PLAID_CLIENT_ID` / `PLAID_SECRET` / `PLAID_ENV` (optional)
- `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` (optional) — when set, injects the cookieless Plausible analytics script
- `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` + sample-rate/env vars (optional error tracking)

## Session log — 2026-06-07 → 2026-06-17 (migration/activation, guardian model, parental controls, approvals, billing, storage, launch QA)

Everything below shipped to `main` after the 2026-06-05 log (tips `8532134` → `90533af`). Current-state detail lives in the new top sections (Member Migration & Activation, Guardian / Minor Model & Parental Controls, Approvals, Member Billing Management, Critical Invariants & Serverless Gotchas). Chronological summary by commit group:

- **Launch QA + infra:** `8532134` authorization gates on owner-only routes (4 blockers); `0bf76ee` Netlify build runs `prisma generate` + `directUrl` for migrations; `b2ef77c` `netlify.toml` Next runtime plugin.
- **Tier gating + import:** `390c263` tier gating + tenant fix + CSV full-name import; `71c5940` Plaid tier-gate/upgrade errors (Pro+); `5ecbfeb` CSV import name-only + date-format picker; `44761c5` second-pass membership matching; `a530718` editable billing frequency + late-activation billing.
- **Storage:** `29680bb` uploads moved to **Supabase Storage** (private bucket) — Netlify disk is ephemeral. All bytes via `lib/storage.ts`; read gate `/api/files/[id]`.
- **Legal/marketing:** `1648c06` DMCA + processor disclosure + CAN-SPAM unsubscribe; `9b0c292` sitemap +/terms +/privacy; `a888779` optional Plausible analytics; `c295eff` 14-day trial (was 30) + promotion codes.
- **Billing resilience + security:** `5188362` billing self-heal (never strand a club on stale Stripe ids); `8c24011` timezone (derive today from local date); `ad9bedd` gate guardian linking + close activation-token replay; `cf1d6cf` login-timing equalizer + stop leaking raw error text.
- **Migration/activation feature set:** `fd3a7c8` billing/onboarding gaps (cash/terminal bookings, owner-approved cancel via Stripe portal + `MEMBERSHIP_CANCEL` queue, billing-date notify, guardian-link approvals queue + `/dashboard/approvals`); `7b7a8f4` guard activation Stripe step + surface document save errors; `35be79d` registration options (plan/cash-check/cancel date) + expiring fully-paid flow; `ed209ef` event bundles; `4a7885f` free-join (JOIN) registration links; `5716df4` activation picker leads with the member's imported rate.
- **Production fixes (this session, `9d05b86` + `90533af`):** activation `members_userId` unique-constraint collision — root cause is the GLOBAL unique index ignoring `deletedAt`; fix releases soft-deleted holders + nulls `userId` on all delete paths; **separated minors from the guardian login** (guardian-link instead of `member.userId`). Document "save (500)" — `isomorphic-dompurify` crashing at module import in the Netlify bundle; fixed with lazy-load + `fallbackStrip` + `serverComponentsExternalPackages`. Branded email/activation-page logo — broken because `club.logoUrl` is a relative, session-gated `/api/files` path; added public `/api/public/club-logo/[clubId]`. `$0`/manual migration approval left members PROSPECT with no membership — fixed so the `!canCharge` branch also activates + attaches membership + a MANUAL subscription. Activation page now skips the password prompt when the account already exists (2nd-child case). Built the unified **Members → Approvals** tab (migration billing + guardian link + cancellation) and per-child "Manage billing".

## Session log — 2026-06-05 (CX overhaul + CY Android docs + real-domain wiring + Security audit Tasks 1-8 + Task 8 legal pages and migration)

All work below is on `main` and pushed to `origin/main`. Tip: `0e3aeaf`. 13 commits between 2026-06-03 and 2026-06-05.

### CX — public-facing UX overhaul (5 commits, merged from `feat/cx-overhaul`)

| SHA | Commit |
|---|---|
| `29270ce` | C1 pricing overhaul — remove ambiguous "Help Center" implication; explicit support promise ("Email support included · 3-5 business day response · urgent operational → call"); 14-day free trial messaging in hero pill + per-tier line + comparison row + FAQ + final CTA; lucide Check/Minus replace unicode glyphs; per-page metadata for SEO |
| `84f4156` | C2 SEO foundation — `app/layout.tsx` rich metadata (metadataBase, title template, OG, Twitter, Permissions-Policy, robots config) targeting wrestling/MMA/martial-arts/gymnastics/youth-sports keywords; new `app/sitemap.ts` + `app/robots.ts`; Organization + SoftwareApplication JSON-LD via `next/script` |
| `1dbe50b` | C3 landing page premium rewrite — bold hero with lime "All in one system." accent; trust-line under hero (no fake logos); value-prop trio (Replace 7 apps / 0% fee / Native shell); "Built for your sport" dark section (wrestling/BJJ-MMA/gymnastics/youth sports); pricing snapshot with "Compare every feature" link; gradient final CTA with dual buttons |
| `882d6c2` | C4 member portal trial badge — `/api/member/memberships` now returns `trialEnabled/trialDays/trialAppliesToReturning`; `/member/memberships` renders a lime Sparkles pill ("14-day free trial · new members" qualifier) when enabled |
| `6a7fa6f` | C5 signup trial reinforcement — `/signup` shows a violet-gradient "YOUR 14-DAY FREE TRIAL STARTS NOW" banner above the form (only in 'Create a club' mode), brand-violet submit button replaces stone-900 |

Merged to main as `2c22af9`.

### CY — Android verification & release docs (1 commit, `acb7723`)

`docs/android-verification.md` (310 lines, 10 sections): current Android setup table (com.athletixos.app, Capacitor 8, AGP 8.13, SDK 24-36, NO keystore yet), host setup (Android Studio + JDK + ANDROID_HOME + AVD), emulator dev loop (the `10.0.2.2:3000` gotcha vs iOS Simulator's `127.0.0.1`), physical-device LAN-IP setup, 12-row smoke test mirroring iOS, troubleshooting table, **keystore generation with hard warning that losing the .jks = permanent loss of update access to the Play listing**, signed AAB build, Play Console Data Safety form answers, routine maintenance schedule, what's still NOT built (push/FCM, per-club apps, deep linking).

### Real-domain wiring (1 commit, `6391605`)

User registered `athletix-os.com` (hyphenated) and set up `info@`, `support@`, `contact@`, `noreply@`, `hello@` inboxes. CX commits had used the placeholder `athletixos.app`. Fixed across 14 files:

- `app/layout.tsx`, `app/sitemap.ts`, `app/robots.ts` SITE_URL fallback → `https://athletix-os.com`
- `lib/email.ts` EMAIL_FROM default + baseLayout footer link
- `app/api/club/email-settings/route.ts` default sendingAddress
- 5 slug-prefix UI labels in onboarding + settings + member signup (`clubos.app/<slug>` → `athletix-os.com/<slug>`)
- Pricing FAQ support@ reference + Enterprise contact-sales mailto (`hello@`)
- Landing + pricing + terms + privacy footer Contact link (`contact@`)
- `scripts/native-dev-switch.mjs` + `scripts/native-shell-config.mjs` + `docs/android-verification.md` example URLs

**Bundle IDs preserved** — `com.athletixos.app` is App Store / Play Store immutable identity; domain doesn't have to match.

### Security audit (Tasks 1-8) — `SECURITY_AUDIT_RESULTS.md` at repo root

Pinned versions preserved (no Prisma 7.x upgrade despite nag). Pure read-only Tasks 1, 3, 4 produced no code commits beyond `licenses.json`. Action commits:

| SHA | Task | Closed |
|---|---|---|
| `c5e7aea` | 2 — Multi-tenant isolation | F-1: `recomputeMemberStatus(memberId)` → `recomputeMemberStatus(memberId, clubId)` with internal `findFirst({where:{id, clubId}})`; 7 callers updated. F-2: Stripe webhook `ClassSession` + `ProductSale` lookups switched from `findUnique({where:{id}})` to `findFirst({where:{id, clubId}})` using metadata clubId. F-3 (central `tenantDb` wrapper) deferred as security debt |
| `342d8ad` | 5 — Security headers | `next.config.mjs` sends HSTS (2y + subdomains + preload), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera/mic/geo/FLoC denied). CSP shipped Report-Only — script-src includes `'unsafe-inline'` (3 inline scripts in `app/layout.tsx`, nonce wiring deferred), pre-permits Stripe redirect + Plaid Link iframes + Capacitor WebView. Promote `Content-Security-Policy-Report-Only` → `Content-Security-Policy` after ~2 weeks of clean reports |
| `0c5c340` | 6 — Auth hardening | F-AUTH-1: NextAuth `authorize()` rate-limits 10 attempts / 10 min per IP via `lib/ratelimit`. F-AUTH-2: bcrypt cost 10 → 12 at all 7 hash sites (signup, password reset, change-password, member signup, member-migration activation, staff invite, contractor invite); existing hashes still verify. F-AUTH-3: `session.maxAge = 60*60*24*14` (was inheriting 30d). One-time user re-login after deploy |
| `6ad3a1b` | 7 — Input validation | `app/api/club/email-test/route.ts` validates optional `to` field through `z.string().email().optional()`. Audit found 114 of 131 mutate routes use Zod; remaining 17 verified safe (15 take only URL params, 1 is signature-verified webhook, 1 has manual enum validator). Zero `$queryRawUnsafe` anywhere; the one `$queryRaw` site (`/api/reports/overview`) is correctly parameterized |
| `47bb884` | — | `SECURITY_AUDIT_RESULTS.md` saved at repo root (Critical/High/Medium/Low prioritization, per-finding status, deferred security debt with rationale) |

Tasks 1 (license audit) + 3 (Stripe webhook signature) + 4 (secrets & git history audit) confirmed **clean** — no GPL/AGPL/LGPL/SSPL anywhere, signature verification correctly uses raw body + env secret + idempotency via `StripeWebhookEvent`, no real `sk_live`/`whsec_`/`DATABASE_URL` credentials in current code or 155-commit history.

### Task 8 — Legal pages, signup consent, LegalAcceptance migration (3 commits)

| SHA | What |
|---|---|
| `0849949` | `legal/TERMS_OF_SERVICE.md` + `legal/PRIVACY_POLICY.md` saved verbatim (DRAFT blockquote in source, NOT in public render). `app/terms/page.tsx` + `app/privacy/page.tsx` (720px reading width, Fraunces headings, brand-violet links, footer with legal links). `legal/versions.ts` single source of truth for `TERMS_VERSION` + `PRIVACY_VERSION`. Footer links added to landing + pricing. `/signup` checkbox required (links open new tab, server-enforced `z.literal(true)`). Initially used a feature-detection guard on `prisma.legalAcceptance` so the route worked before migration |
| `c4acb12` | **Migration applied** — `prisma/migrations/20260611000000_legal_acceptances/migration.sql` hand-written per project pattern. Schema gained `model LegalAcceptance` + `User.legalAcceptances` + `Club.legalAcceptances`. Verified live in Postgres via `\d legal_acceptances`. `npx prisma generate` v5.7.0 (pinned). `/api/auth/signup` now writes real DB rows on every signup |
| `0e3aeaf` | `/member/signup` symmetric consent — step 3 of the wizard has the same checkbox + server schema requires `acceptedTerms: z.literal(true)` + writes two `LegalAcceptance` rows (TOS + PRIVACY) on success |

**Audit trail per signup**: 2 rows in `legal_acceptances` with `documentType` (TOS/PRIVACY), `version` (e.g. `2026-06-05-draft`), `acceptedAt`, `ipAddress`, `userAgent`. Insert-only, never updated. Defensible proof of consent for attorney review.

### Cookie banner — not needed today

Zero third-party analytics (no GA, no FB pixel, no Hotjar, no Mixpanel). Only cookies are session, theme, preview — all "strictly necessary" and exempt from GDPR banner rules. Currently US-only per Privacy Policy. **Add cookie banner if you ever add analytics/marketing pixels.**

### What's queued / not started

P2 privates overhaul, P3 notifications, P4 minor parental controls were completed earlier (merged at `fbcc2c3`). No active backlog items from prior session logs are pending — the audit and Task 8 took the queue down to zero. Next operational items live in `SECURITY_AUDIT_RESULTS.md` "Items for the operator" section (live Stripe keys, prod env vars, promote CSP to enforcing after 2 weeks, etc.).

---

## Session log — 2026-06-03 (P1 UI/UX fixes — merged to main at 2c22af9)

Branch: `feat/p1-ui-fixes` off `main` 62ea801. Tip: `e48edf2`. **Merged to main 2026-06-05.**

### Commits this session (oldest → newest)

| SHA       | Topic                                                       |
|-----------|-------------------------------------------------------------|
| `b679af6` | dark mode contrast (lime tags + login inputs)               |
| `c25c8aa` | sign-in logo links back to landing page                     |
| `048c422` | dashboard calendar grid + mobile day-list                   |
| `bd4e9af` | member nav adds Bookings; secondary items move to More sheet|
| `a7fb59e` | owner dashboard adds Recent messages + Recent bookings      |
| `d2c89b6` | regenerate iOS app icon so the brand fills the badge        |
| `e48edf2` | **P1.H — fix remaining native app tofu icons (46 files)**   |

### P1 details

- **P1.B — dark mode contrast** (`b679af6`)
  - `app/dashboard/privates/page.tsx`: 4 sites (lines 817, 830, 862, 922) had `bg-lime-accent text-white` — invisible white text on lime in light mode AND `text-text-primary` flipped to light in dark mode. Switched to `bg-lime-accent text-charcoal font-medium` — the charcoal token (#1F1F23) is theme-locked, always dark-on-lime.
  - `app/login/page.tsx`: every stone-* class migrated to design tokens (`bg-app-bg`, `bg-surface`, `text-text-primary`, `border-app-border`, `focus:ring-brand`, `bg-charcoal`/`hover:bg-charcoal-hover` for the primary button). Added `.dashboard-root` to the outer wrapper so existing scoped dark-mode overrides in `app/globals.css` activate on /login. Sign-in now flips correctly in both directions.

- **P1.C — sign-in logo link** (`c25c8aa`)
  - `app/login/page.tsx`: img wrapped in `<Link href="/">` with aria-label, focus ring matching brand token, hover:opacity-90 transition. One-line semantic fix; safe on browser + native shell.

- **P1.D — calendar readability** (`048c422`)
  - `app/dashboard/calendar/page.tsx`: full grid restructure. Desktop (≥md): cells 110→140px, day-number button 24→28px, 4 chips per day (was 3), chip font 10→11px + tabular-nums, "+N more" is now a real button that opens the existing Day Detail panel via setSelectedDay. `bg-white` → `bg-surface` for dark mode. Border discipline via grid-level dividers. Mobile (<md): brand-new vertical day-list view — renders only days with items + today, each day = 40px pill (weekday + number, tabular-nums) plus full list of items below (no truncation), empty month shows "No items this month."
  - SkeletonLine fallback updated for new cell heights.

- **P1.E — member nav: Bookings + More sheet** (`bd4e9af`)
  - `app/member/layout.tsx`: bottom nav trimmed from 6 items to 5: Home / Schedule / **Bookings** / Messages / **More**. Bookings is a new top-level tab pointing at `/member/bookings` (previously buried inside Schedule). News / Documents / Privates / Our team / Profile moved into a new `MORE_ITEMS` array that renders inside a bottom-sheet modal when the More tab is tapped.
  - Bottom-sheet UI: backdrop tap closes, ESC closes via natural button semantics, includes a discoverable Sign out row that calls `signOutEverywhere`. State auto-closes on every route change.
  - New SVG icons: `CheckSquareIcon` (Bookings), `MoreIcon` (3 dots), `SignOutIcon`. Match the existing 20×20 viewBox + currentColor style.
  - `buildPortalNav` for branded-app config untouched — clubs that customize their nav still get their custom items; the hardcoded NAV is the default fallback.

- **P1.F — owner widgets: Recent messages + Recent bookings** (`a7fb59e`)
  - `lib/dashboardWidgets.ts`: added two new keys to `WIDGET_CATALOG` (`recentMessages`, `pendingBookings`, both `section` kind). Inserted into `DEFAULT_ORDER` between `quickNav` and `recentMembers` so new clubs see them immediately. Existing clubs with saved prefs get the new widgets auto-appended via `resolvePrefs`.
  - `app/api/dashboard/summary/route.ts`: two new parallel fetches — `recentMessagesRaw` (5 latest DMs to current owner/staff user, newest first, sender included) and `pendingBookingsRaw` (5 latest Bookings created in last 7 days, scoped via `event: { clubId }` because Booking has no direct clubId column). Response shape extended.
  - `app/dashboard/page.tsx`: `Summary` type extended; two new `sectionWidget` cases. Recent messages renders an avatar + sender + body excerpt + date + lime unread dot. Recent bookings renders member name + event + date + status pill (lime for CONFIRMED, orange for WAITLISTED, neutral otherwise). Both use existing `bg-surface rounded-xl border border-app-border overflow-hidden` shell.

- **P1.G — iOS app icon regeneration** (`d2c89b6`)
  - Previous `assets/native/athletixos-icon-1024.png` had a small A mark surrounded by heavy black padding → tiny inside iOS rounded badge.
  - Regenerated from `public/brand/circle.PNG` (the 512×512 brand circle that already fills its canvas) scaled to 1024×1024 via `sips -z 1024 1024 ... -s format png`. Copied to both source-of-truth files (`assets/native/athletixos-icon-1024.png` + `ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png`).
  - `assets/native/README.md` updated to document the regen command + the Android caveat (Android icons in `android/app/src/main/res/mipmap-*/` are NOT auto-regenerated by `cap sync`; need a separate `npx @capacitor/assets generate --android` step when source changes — left untouched per "don't take risky Android changes" instruction).
  - `cap sync` ran clean.

- **P1.H — eliminate native app tofu icons** (`e48edf2`) — 46 files, +307/-155
  - **Goal**: every remaining unicode/emoji/icon-font glyph that was rendering as a `?` / tofu box inside the iOS WebKit shell, replaced with lucide-react SVG components. Triggered by the user reporting persistent boxes on `/member/shop` (Book Now), bottom-nav Book Now icon, and several empty states even after the earlier sweep in commit `0e47830`. Python audit identified 54 distinct non-safe codepoints across `app/` + `components/`; all replaced or restructured.
  - **Member /shop ("Book Now") page** (`app/member/shop/page.tsx`): the 4 card icons (`◇ ◈ ◎ ▤`) were stored as string keys in a config array. Restructured the array shape from `icon: string` → `Icon: LucideIcon` (Ticket / CalendarRange / UserCheck / Package). Render site now uses `<c.Icon />` inside a 48×48 lime-tinted rounded circle, matching the rest of the member portal's icon language. Same pattern applied to `app/page.tsx` features array (6 entries: Users / CalendarDays / CreditCard / CheckCircle2 / MessageSquare / BarChart3) and `app/dashboard/announcements/page.tsx` CHANNELS array (Smartphone / Mail / Bell).
  - **buildPortalNav fix** (`app/member/layout.tsx:494`): the branded-app `book` nav key was wrongly mapped to `HomeIcon` — meaning clubs that configured a branded "Book Now" bottom-nav tab got a house silhouette instead of a booking icon. Added a new inline `BookNowIcon` (calendar with a plus inside, distinct from the `BookingIcon` calendar-with-check used for the default Schedule slot) and remapped `book → BookNowIcon`. All five branded keys (book / schedule / store / videos / more) now have semantically correct icons.
  - **Empty states (lime-circle-with-lucide pattern)**: every page-level empty state across both surfaces now follows the same shape — `mx-auto mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full bg-lime-accent/20 text-charcoal` wrapping an `h-7 w-7` lucide icon. Files: `app/member/{announcements,bookings,documents,events,memberships,messages,privates,products,staff}/page.tsx` + `app/dashboard/{announcements,classes,custom-fields,memberships,members,messages,products}/page.tsx`.
  - **Components migrated**: `GlobalSearch.tsx` (⌕ → Search; ⌘K shortcut hint → "Ctrl K"). `UserMenu.tsx` + `ExportMenu.tsx` (▾ → ChevronDown). `ThemeToggle.tsx` (☀/☾ → Sun/Moon). `StripeRequiredBanner.tsx` (⚠ → AlertTriangle, → arrow → ArrowRight). `ImageUpload.tsx` (default placeholder prop now a ReactNode defaulting to lucide ImageIcon — all callers' `placeholder="◉/◌"` strings removed). `BackButton.tsx` (← → ArrowLeft). `DashboardSidebar.tsx` (group-expand › → ChevronRight). `app/dashboard/layout.tsx` mobile hamburger (≡ → Menu).
  - **Navigation arrows**: dashboard widget reorder (▲▼ → ChevronUp/Down), dashboard mini-calendar prev/next (‹› → ChevronLeft/Right), `/dashboard/calendar` month nav, `/dashboard/attendance` day nav, `/dashboard/staff/schedule` week nav — all swapped to lucide. Reports KPI delta hint `▲/▼` → `+/−` plain ASCII (no glyph, no risk).
  - **Member message thread back chevrons**: `/member/messages/dm/[userId]` and `/member/messages/group/[id]` thread headers used `‹` for back. Replaced with `<ArrowLeft />` inline + aria-label.
  - **Member home wave**: `Hey {name}! 👋` → `Hey {name}!`. Member signup type-picker glyphs (🏋 / 🧒 / 👨‍👧) restructured from icon-string array entries to `Icon: LucideIcon` (User / Baby / Users). Member /staff contact rows (✉ / ☎) → Mail / Phone.
  - **Public surfaces**: `/e/[slug]` error/location/success glyphs (🚫 / 📍 / 🎉 / ✓) → AlertOctagon / MapPin / PartyPopper / CheckCircle2 + ArrowRight chevron on "Open portal" CTA. Onboarding "Launch club ✦" → "Launch club"; onboarding ← Back → ArrowLeft.
  - **Branded app preview** (`app/dashboard/settings/branded-app/page.tsx:987 navIcon()`): the preview-card "phone bottom nav" used `+/□/$/▶/…` for the 5 nav keys. Function rewritten to return `LucideIcon` refs (CalendarPlus / CalendarDays / ShoppingBag / Play / MoreHorizontal) so the preview matches what the actual native bottom nav now renders.
  - **Settings page sub-links**: `/dashboard/settings/{club,email,member-form,members[id],custom-fields,staff/schedule}` all had `← Back to X` / `‹ Back to X` text-arrows. Migrated to inline ArrowLeft. Documents toolbar (≡ bullet list, ✕ clear formatting) → List / Eraser. Settings PWA install hint "tap ⋮" → "tap the three-dot menu" (Chrome Android only — the user reads this hint, then sees the literal symbol in their browser). Settings /club Maps link (📍 Open in Maps) → MapPin + label.
  - **Decorative dot in members guardian-link UX** (`app/dashboard/members/page.tsx:834`): was `◉` rendered with `text-orange-accent`. Replaced with a CSS `<span>` 6px lime-orange disc — `inline-block h-1.5 w-1.5 rounded-full bg-orange-accent` — no glyph dependency.
  - **Verification (code-level only — simulator NOT yet smoke-tested)**:
    - `npx tsc --noEmit` — clean.
    - `npm run build` — clean (production build).
    - `npm run cap:sync` — clean (both iOS + Android updated).
    - `npm run lint` — only **pre-existing** warnings remain (lib/auth.ts `as any` casts, lib/apiGuard.ts, lib/migration.ts, lib/stripe.ts, plus pre-existing unescaped apostrophes in lines I did not touch). Diffed against a `git stash` baseline to confirm no NEW lint errors were introduced.
  - **Architectural note for future glyph audits**: a quick Python sweep over `app/` + `components/` for the target set `'◉◈◇◎▦▤✉☎☀☾⌕⌘≡✦◌▲▼▶‹›←✕'` (skipping `// ─` comment separators) catches almost every native-shell risk in one pass — keep that script handy. The same approach should be re-run after CX (landing redesign) since new copy is the most common reintroduction path.

### What's queued for tomorrow + beyond

User explicitly held P2 / P3 / P4 / landing / Android docs until P1 is merged and signed off. Approved plan from this session's audit (full details in this CLAUDE.md and earlier session-log discussion):

**P2 — Private lessons overhaul** (after audit by Explore agent `a035e592e050080d9` 2026-06-03):
- C8: `lib/email.ts` add `sendPartnerInviteEmail` + `sendPrivateLessonRequestedEmail`; wire into `activatePartnersOnAccept` in `/api/private-lessons/bookings/[id]/route.ts:79` so OUTSIDE partners actually receive their invite token URL by email (currently tokens are generated and never sent). Wire to `/api/member/privates/route.ts` POST so coach gets email + in-app DM on new request.
- C9: `app/member/privates/page.tsx` inline warning + submit gate when member picks coach+tier combo that fails the `optionCoachIds()` cascade.
- C10: better time selection UX in member request flow — calendar mini grid + suggested time chips from `StaffAvailability`.
- C11: `app/member/bookings/page.tsx` extend `Booking.kind` from `"event" | "class"` to `+"private"`; fetch + render PrivateBookings. Add to `app/member/page.tsx` Upcoming Bookings widget.
- **MIGRATION M1**: `PrivatePackage.publishedToMembers Boolean @default(false)` — ISOLATED COMMIT. Rollback risk: LOW (additive, default false). Hand-written SQL per CLAUDE.md pattern.
- C12: member-facing package shop at `app/member/shop/packages/page.tsx` + `app/api/member/private-packages/route.ts` GET + `/buy/route.ts` POST (Stripe Checkout). Webhook handler in `app/api/stripe/webhook/route.ts` `checkout.session.completed` creates `PrivateCreditLedger` row on success. MED risk (Stripe path).

**P3 — Notifications foundation** (after audit by Explore agent `ad8fbfd5e3bd8b9ef` 2026-06-03):
- **MIGRATION M2**: new `Notification` model. Rollback risk: LOW (isolated table, no FKs out). Schema: `{ id, clubId, userId, type, title, body?, link?, payload?, readAt?, createdAt }` + index on `(userId, readAt, createdAt)`.
- C13: `lib/notifications.ts` with `createNotification()`; new endpoints `/api/notifications` GET + `/api/notifications/[id]/read` POST + `/api/notifications/read-all` POST + `/api/notifications/unread-count` GET.
- C14: wire `createNotification` at 10 event source POST handlers (member messages DM + groups, classes book, events register, privates request, privates accept/decline, announcements, manual-payment, Stripe webhook checkout completed + invoice payment_failed). Each call wrapped in try/catch — never blocks the parent operation. MED risk (10 routes touched).
- C15: `components/NotificationBell.tsx` + add to `app/dashboard/layout.tsx` topbar + `app/member/layout.tsx` desktop header / mobile More slot.

**P4 — Minor accounts + parental controls** (after audit by Explore agent `a2bad139b5996a785` 2026-06-03):
- **MIGRATION M3**: `Member.birthdayLockedAt DateTime?`, `Member.parentControls Json?` (`{ requirePaymentApproval, monitoredMessaging, allowPackagePurchase, dailySpendLimit? }`), new `PendingApproval` model (`{ id, clubId, memberId, kind, payload, amount?, status (PENDING|APPROVED|DECLINED|EXPIRED), requestedAt, respondedAt?, respondedById? }`). Rollback risk: LOW (additive). Default state = no controls = existing behavior unchanged.
- C16: wire gates into `app/api/member/classes/book/route.ts`, `events/[id]/register/route.ts`, `privates/route.ts` — when `member.isMinor && parentControls.requirePaymentApproval && amount > 0` return 403 with `code: "PARENT_APPROVAL_REQUIRED"` and create PendingApproval row. Update DM POST to fire notifications for guardians when `monitoredMessaging`. PATCH `/api/members/[id]/route.ts` rejects DOB change from MEMBER role when `birthdayLockedAt` set.
- C17: birthday lock UI — disable DOB field on `app/member/profile/page.tsx` when locked; warning on owner-side `app/dashboard/members/page.tsx` Edit form.
- C18: per-child controls page at `app/member/family/[memberId]/page.tsx` + `/api/member/family/[memberId]/controls/route.ts` PATCH (parent-only).

**CX — Landing page redesign** (deferred — after P1–P4 are stable):
- Brainstorm aesthetic with `superpowers:brainstorming` skill before any code.
- Use Magic MCP for component inspiration.
- Targets: `app/page.tsx` (currently 463 lines, uses unicode glyph features + purple `#534AB7` brand color, cream `#F5F3EE` background, Inter font). Replace glyphs with lucide, recolor to lime/charcoal/athletic, new hero + conversion CTA. `app/pricing/page.tsx` polish.

**CY — Android verification docs** (no code, just instructions):
- Audit complete (Explore agent `a9926950a9bcbc3d9` 2026-06-03). Capacitor 8.3.4, Gradle 8.14.3, SDK 36 / min 24, single Activity (portrait, singleTask), INTERNET-only permission. **No keystore** — must be added before release builds (not blocking dev/test). `npm run cap:android` opens Android Studio.
- Instructions to write: how to test locally on emulator + device, how to set up keystore for release.

### Risk callouts (carried from approved plan)

| Commit | Risk |
|---|---|
| M1 / M2 / M3 | All additive; rollback SQL kept in commit body. Hand-written per CLAUDE.md migration pattern (shadow DB broken locally). |
| C8 (email send) | Real side effect; reuses nodemailer transport. |
| C12 (Stripe path) | New checkout flow + webhook handler; idempotent via `StripeWebhookEvent` dedupe. |
| C14 (notification wiring) | 10 routes; every `createNotification` wrapped in try/catch. |
| C16 (parental controls gates) | Default state = no controls; opt-in only. |

### Manual testing checklist user runs after merging P1 to main

| Item | Verification |
|---|---|
| Dark mode contrast | Toggle theme on dashboard; verify lime "Confirm" buttons in /dashboard/privates + login inputs legible in both modes |
| Sign-in logo navigation | On /login, click/tap logo → must land on / |
| Calendar — desktop | /dashboard/calendar shows 4 chips/day; "+N more" opens Day Detail panel |
| Calendar — mobile (375px) | Vertical day-list view; only days with items + today; full chip list per day |
| Member nav — Bookings | On /member at mobile, bottom nav has Bookings; tap → /member/bookings |
| Member nav — More sheet | Tap More in bottom nav → sheet appears with News / Docs / Privates / Our team / Profile / Sign out; backdrop tap closes |
| Owner widgets | /dashboard shows Recent messages + Recent bookings; Customize modal toggles visibility; reload persists |
| App icon | `npm run cap:ios`, build on simulator, check Springboard — AthletixOS brand circle fills the rounded badge |
| Android icons | NOT updated by this branch. Run `npx @capacitor/assets generate --android` from source when ready |
| **P1.H — Book Now page** | In iOS simulator, member portal → tap Book Now (bottom nav OR /member/shop directly). 4 cards: Memberships / Events / Private lessons / Shop. Each card shows a clear lucide icon (Ticket / CalendarRange / UserCheck / Package) inside a lime circle — **no `?` or tofu boxes anywhere**. |
| **P1.H — Bottom nav (default config)** | Member portal bottom nav: Home / Schedule / Bookings / Messages / More — all 5 slots render lucide-style icons. Active tab highlights correctly. |
| **P1.H — Bottom nav (branded config)** | If a club has set branded-app nav, the `book` slot should now show a calendar-with-plus icon (BookNowIcon), NOT a house. Test via `/dashboard/settings/branded-app` preview — phone preview's bottom nav should match what the simulator renders. |
| **P1.H — Member empty states** | With a fresh test club (no announcements / no events / no documents / no memberships / no messages / no privates / no products / no staff): visit each `/member/*` page and confirm the empty state shows a 56px lime circle with a clear lucide icon (Megaphone / CalendarRange / FileText / Ticket / Mail / UserCheck / Package / Users). NO `?`, NO tofu. |
| **P1.H — Dashboard empty states** | Same drill on the owner side: `/dashboard/announcements`, `/dashboard/classes` (Events tab), `/dashboard/custom-fields`, `/dashboard/memberships`, `/dashboard/members` (fresh club), `/dashboard/messages` (Announcements + Groups + DMs empty), `/dashboard/products`. Every empty state uses lime-circle + lucide. |
| **P1.H — Dashboard topbar** | Mobile dashboard: hamburger icon (left, Menu lucide), search bar with magnifying-glass lucide + "Ctrl K" badge on the right. UserMenu avatar dropdown shows ChevronDown next to name. |
| **P1.H — Sidebar group expanders** | Desktop dashboard sidebar — group items (Staff, Purchase Options, Classes & Events, Communication) show a small chevron that rotates 90° when opened. No bare `›` characters. |
| **P1.H — Theme toggle** | Sidebar bottom Theme button shows Sun (when dark) / Moon (when light) lucide — NOT ☀/☾ text. |
| **P1.H — Back buttons** | Every page-level back link (BackButton in topbar, `/dashboard/settings/*` "Settings" links, `/dashboard/members/[id]`, `/dashboard/custom-fields`, `/dashboard/settings/member-form`, onboarding) renders an ArrowLeft lucide + label. |
| **P1.H — Calendar / attendance / staff-schedule nav** | Month/day/week prev-next buttons all show ChevronLeft / ChevronRight lucide — no `‹ ›` glyphs. |
| **P1.H — Member messages thread** | Open a DM or group thread on `/member/messages/*` — back-to-list arrow at top-left is now ArrowLeft, not `‹`. Lime parent-child indicators still render correctly (unchanged from earlier commits). |
| **P1.H — Member signup type picker** | At `/member/signup`, Step 1 type-picker — Adult Athlete / Young Athlete / Parent rows each show a lucide icon (User / Baby / Users) next to the label. Final confirmation screen for ADULT_ATHLETE shows a User icon in a circle, not 🏋. |
| **P1.H — Public event page** | Open a `/e/<publicSlug>` page on Safari (logged out). Error state (try a bad slug) shows AlertOctagon icon. Location row shows MapPin + name. After successful registration, the green "Payment received" banner shows CheckCircle2. The "done" state shows PartyPopper. "Open portal" CTA shows ArrowRight. |
| **P1.H — Branded app preview** | `/dashboard/settings/branded-app` — the phone preview's bottom nav now shows lucide icons (CalendarPlus / CalendarDays / ShoppingBag / Play / MoreHorizontal) matching the live native nav. |
| **P1.H — Documents editor toolbar** | `/dashboard/documents` → edit a document. Toolbar's bullet-list and clear-formatting buttons now show List / Eraser lucide icons, not `≡ ✕`. |
| **P1.H — Reports KPI delta** | `/dashboard/reports` — Revenue KPI delta now reads `+12% vs previous` / `−12% vs previous` using ASCII `+` and `−` instead of `▲/▼`. Color (green/red) still correct. |
| **P1.H — Landing page features** | Visit `/` in browser (this is desktop-only marketing, not in the native shell). The 6-feature grid now uses lucide icons (Users / CalendarDays / CreditCard / CheckCircle2 / MessageSquare / BarChart3), not unicode glyphs. |

### Architectural notes for tomorrow's session

- The widget system in `lib/dashboardWidgets.ts` auto-merges new keys via `resolvePrefs` — adding more widgets in P2/P3/P4 is just: add to `WIDGET_CATALOG`, optionally add to `DEFAULT_ORDER`, add a `case` in `sectionWidget` on the dashboard page.
- Login page now lives inside `.dashboard-root` scope. Future auth-adjacent pages (`/signup`, `/forgot-password`, `/reset-password`) should follow the same pattern — set `.dashboard-root` on the outer wrapper and use design tokens, not stone-* / white hardcodes.
- The member layout MoreSheet pattern (bottom-anchored modal with backdrop) is a reusable template for any future mobile-only secondary menus.
- **lucide-react is the icon system across the entire app now** (P1.H finished the migration). When adding new UI: import the lucide icon directly (`import { X } from "lucide-react"`), use `className="h-N w-N"` for size + `strokeWidth={2}` for the standard weight. For empty states, wrap in the canonical lime-circle: `<div className="mx-auto mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full bg-lime-accent/20 text-charcoal"><Icon className="h-7 w-7" strokeWidth={2} /></div>`. Do NOT introduce new unicode glyph icons — they tofu in iOS WebKit.
- The `lib/dashboardNav.ts` `NAV` array + `app/member/layout.tsx` `NAV` array are the two sources of truth for icon mapping in primary navigation. Branded-app overrides go through `buildPortalNav()` in the member layout (the function with `byKey` Record<BrandedNavKey, …>).

### How to resume in a fresh Claude session

When the next terminal starts, read this CLAUDE.md top-to-bottom for full context. The TL;DR for resuming:

1. **Where we are**: branch `feat/p1-ui-fixes` at tip `e48edf2`. NOT pushed, NOT merged. 7 commits ahead of `main` (which is `62ea801`). All P1 work (B/C/D/E/F/G/H) is code-complete + tsc/build/cap:sync clean. Only blocker is the manual smoke test the user is about to run from this CLAUDE.md's "Manual testing checklist" table.
2. **If user reports the smoke test passed**: merge to main. Steps — `git checkout main && git merge --no-ff feat/p1-ui-fixes && git push origin main` (only push if explicitly asked). Then ask the user which queue item to start: P2 / P3 / P4 / CX / CY. Pick from the approved plan in "What's queued for tomorrow + beyond" above.
3. **If user reports a smoke test FAILED**: do NOT merge. Treat it as a P1 bug fix. Use `superpowers:systematic-debugging` skill before touching code. The specific items most likely to surface bugs are: (a) `buildPortalNav` Book Now mapping in clubs with branded-app config, (b) any empty state that I missed in P1.H (re-run the Python audit in the `Architectural note for future glyph audits` block of the P1.H details), (c) ImageUpload placeholder rendering — the prop type changed from `string` to `ReactNode` so any caller passing a string still works but the default is now an Image lucide icon, (d) dashboard widget reorder buttons (ChevronUp/Down replaced ▲▼ — make sure click targets are still big enough on mobile).
4. **Important: do NOT push or merge to main without explicit user approval.** Branch policy is locked.
5. **Required env state for any further work**: `.env` should have `NEXTAUTH_URL=http://127.0.0.1:3000` (the 127.0.0.1 literal — NOT localhost — and port 3000 — NOT 3001). Verify with `cat .env | grep NEXTAUTH_URL` before running the dev server.
6. **If starting P2 (privates overhaul)**: the audit was done by Explore agent `a035e592e050080d9` 2026-06-03. Plan is C8 → C9 → C10 → C11 → M1 → C12 in that order (M1 must be ISOLATED commit per migration policy). Re-read the audit findings in this CLAUDE.md's "P2 — Private lessons overhaul" subsection before touching code.
7. **If starting P3 (notifications)**: Explore agent `ad8fbfd5e3bd8b9ef`. Plan is M2 → C13 → C14 → C15.
8. **If starting P4 (parental controls)**: Explore agent `a2bad139b5996a785`. Plan is M3 → C16 → C17 → C18.
9. **If starting CX (landing redesign)**: REQUIRED skills first — `superpowers:brainstorming` to agree on aesthetic direction with user BEFORE any code, then Magic MCP for component inspiration, then `frontend-design` skill for execution. Do NOT just start editing `app/page.tsx`.
10. **If starting CY (Android docs)**: pure documentation task, no code changes. Explore agent `a9926950a9bcbc3d9` already audited the Android setup; just write the test/build/keystore instructions into a new file under `docs/`.

### P1.H rollback (if any smoke test exposes a critical regression)

The commit `e48edf2` is a single self-contained commit touching 46 files but ONLY swapping icon implementations. There are no schema changes, no auth changes, no API contract changes, and no runtime logic changes. Rollback options:

- **Full revert**: `git revert e48edf2` — produces a clean reverse commit, keeps the rest of P1 (B–G) intact.
- **Partial revert of one file**: `git checkout e48edf2~1 -- <path>` then commit — useful if exactly one page misbehaves.
- **Keep change, fix forward**: most likely case. The change is small per-file; fix the specific icon/sizing/alignment issue rather than reverting.

The pre-P1.H tip is `d2c89b6`. To revert past P1.H without touching other P1 commits, use `git revert e48edf2 --no-edit`.

## Session log — 2026-06-02 (visual sweep + iOS layout hardening + security pass)

Branch: `native-app-shell` (pushed: NO, merged: NO). Commits in order, oldest first:

| SHA       | Topic                                                     |
|-----------|-----------------------------------------------------------|
| `0e47830` | replace unicode glyph icons with lucide SVG               |
| `a80eb25` | surface child name on every parent-facing message thread  |
| `2c783ff` | redesign events page card — athletic scoreboard layout    |
| `ad5eab4` | polish dashboard schedule widgets — bigger pills/spacing  |
| `0f9a0ca` | fix iOS dashboard/calendar/member icon layout regressions |
| `1dc5cb4` | fix parent/child message context on native shell          |
| `cd1adcf` | API validation, sanitization, rate limiting               |

### Visual sweep (commits `0e47830`, `a80eb25`, `2c783ff`, `ad5eab4`)

- **`0e47830`** — replaced every unicode glyph icon (⌂ ◉ ◎ ◇ ◈ ✉ ✓ $ ▦ □ ⚙ ≡ ▤ ◐ ?) on the owner side with lucide-react SVG components. Touched `lib/dashboardNav.ts` (icon field type changed to `LucideIcon`), `components/DashboardSidebar.tsx`, `components/DashboardBottomNav.tsx`, `app/dashboard/page.tsx` (`sections` + `PRIMARY_QUICK_ACTIONS`), and all 6 `EmptyState` callers. `components/EmptyState.tsx` icon wrapper grew from 48px / app-bg / muted text to 56px / lime-tint background / dark-lime stroke. **New dep**: `lucide-react ^0.469.0`.
- **`a80eb25`** — child threads on `/member/messages` got a lime left border + lime `For <kid>` pill via shared `ChildBadge`. Child-thread links carry `?for=<id>&forName=<first>` to the DM and group thread pages. DM thread + group thread pages render the same pill in the header.
- **`2c783ff`** — `/dashboard/events` card rebuilt as a 4-row scoreboard: type-colored left stripe (jersey stripe), big tabular-nums date pill, name w/ `line-clamp-2`, lucide-icon meta row (Clock / MapPin / Users), lime/orange capacity progress bar, status pill row, multi-session sub-row. Desktop keeps the action button row; mobile uses a single kebab → bottom-sheet action menu. State `actionMenuFor`.
- **`ad5eab4`** — dashboard `upcomingEventsList` and `upcomingClassesList`: date pill widened to 48px with bold tabular-nums, names switched to `line-clamp-2`, type badge stacks under name on mobile / floats right on desktop, weekday + time gain `tabular-nums`.

### iOS hardening (commit `0f9a0ca`)

- **Dashboard horizontal overflow** (Upcoming events overlapping Recent members on iOS). Root cause: CSS Grid items default to `min-width: auto` which is the intrinsic min-content width of their children. Long unbroken content blew out the column track, causing adjacent widgets to visually overlap and the page to gain horizontal scroll. Fix: `min-w-0` on every grid wrapper around section widgets in `app/dashboard/page.tsx`; `overflow-x-hidden` added to `<main>` in `app/dashboard/layout.tsx` as a safety net.
- **Calendar widget squeezed / day numbers overlapping**. Same root cause + quickNav widget used `grid-cols-4` unconditionally for 11 tiles, blowing out the row width on phone widths and crushing the calendar column. Fix: calendar card gets `min-w-0`, cells get `aspect-square` and `gap-1` for guaranteed clickable space, `tabular-nums` on dates, lime event-day dots. quickNav widget responsive: `grid-cols-2 sm:grid-cols-3 lg:grid-cols-4`, tiles get `truncate` / `line-clamp-2` / `min-w-0`.
- **Member dashboard tiles still showing tofu/? boxes on iOS** — Phase 2C migration covered owner dashboard but NOT the member portal home page. `app/member/page.tsx` still used unicode glyphs `◷ ✓ ✉ 📣 ▤ ◎ ◉` for tiles and `✉ ☎ ↗` for ClubBanner contact lines. Fixed via new `TileLink` component (lime-tinted circle holding a lucide icon: CalendarDays / CheckSquare / MessageSquare / Megaphone / FileText / UserCircle2 / Users), used in both AdultAthleteView and ParentView tile grids. ClubBanner placeholder + contact rows + "View the full schedule" CTA chevron + LinkChild success state + "No children linked yet" empty state all migrated. Member portal bottom nav already used local SVG icon components (HomeIcon / BookingIcon / MessageIcon / etc. in `app/member/layout.tsx`) — untouched.

### Parent/child message context on native shell (commit `1dc5cb4`)

The previous implementation in `a80eb25` used Tailwind arbitrary values (`border-l-[5px] border-l-lime-500`, `bg-lime-100 text-lime-800 border-lime-300`). On Tailwind v4, lime-palette JIT + arbitrary-value compilation depend on content scanning + theme inclusion — not guaranteed to be in the iOS bundle's first-paint CSS after install. The lime classes silently no-op'd and the indicators rendered as bare 1px stone-200 default.

Fix:
- `app/member/messages/page.tsx` — top-of-file LIME / LIME_BG / LIME_BORDER / LIME_TEXT constants. ChildBadge and child-thread card backgrounds + 5px left border now use inline `style={{}}` instead of Tailwind classes. Bulletproof against any compile race.
- "Messages for your athletes" section always renders for any parent with linked children (pulled from `/api/member/portal` `guardianOf`), not only when child threads exist. Empty-state lime-tinted info card explains where child messages will appear + flags any linked kid without their own member login (a precondition for receiving coach DMs).
- DM thread page and group thread page lime "For <kid>" pill switched to the same inline-style approach.
- `app/api/member/portal/route.ts` — `guardianOf.member` include now also pulls `user: { id }` so the client can derive `hasOwnLogin` per linked child without an extra request.

### Security pass (commit `cd1adcf`)

**New helpers:**

- **`lib/ratelimit.ts`** — in-memory token-bucket rate limiter. Exports `rateLimit({ key, limit, windowMs })` → `RateLimitResult`, `rateLimitedResponse(rl, message?)` → `NextResponse` with `retry-after` + `x-ratelimit-reset` headers, `ipFromRequest(req)` → first IP in `x-forwarded-for` / `x-real-ip` / "unknown". Periodic janitor sweeps stale buckets every 5 min (interval is `.unref()`'d so it doesn't keep `next dev` alive). Test-only `_resetRateLimitForTests()` export.
- **CAVEAT**: in-memory state is per-process. On long-running Node servers (npm run dev, self-hosted prod) limits are global. On horizontally-scaled serverless deployments (Vercel) each warm instance has its own bucket → effective limit is `limit × warm_instances`. Acceptable best-effort throttling for AthletixOS scale; swap for `@upstash/ratelimit` + Redis if we ever need per-cluster limits.
- **`lib/sanitizeHtml.ts`** — wraps `isomorphic-dompurify` with an allowlist of safe rich-text tags (no `<script>`, no `<iframe>`, no `on*` event handlers, no `javascript:` URLs). Used at WRITE time so stored values are trustworthy on render. **New dep**: `isomorphic-dompurify ^2.36.0`.

**Validation gaps closed** (only 2 of 14 audited routes lacked zod):

- `app/api/messages/dm/route.ts` POST (owner → member DM): replaced manual `typeof` checks with `dmBodySchema` (memberId required, body trimmed, body ≤5000 chars).
- `app/api/upload/route.ts` POST (file upload): added `uploadFieldsSchema` for the `type` enum + explicit `File` instanceof check + empty-file rejection. Pre-existing size + MIME checks kept.

**XSS sanitization wired:**

- `app/api/documents/route.ts` POST and `app/api/documents/[id]/route.ts` PATCH now run `sanitizeRichHtml()` on `body` before storage. `Document.body` is the only field rendered via `dangerouslySetInnerHTML` (in both `/dashboard/documents` and `/member/documents`) — caps the blast radius even if a staff member with `documents:edit` permission tries to ship JS.

**Rate limits applied:**

| Endpoint | Limit | Window |
|---|---|---|
| `auth/forgot-password` (per IP) | 5 | 10 min |
| `auth/reset-password` (per IP) | 10 | 10 min |
| `auth/change-password` (per session) | 5 | 10 min |
| `auth/signup` (per IP) | 5 | 10 min |
| `member/signup` (per IP) | 10 | 10 min |
| `messages/dm` owner→member (per session) | 30 | 1 min |
| `member/messages/dm/[userId]` (per session) | 60 | 1 min |
| `member/messages/groups/[id]` (per session) | 60 | 1 min |
| `member/classes/book` (per session) | 20 | 1 min |
| `member/events/[id]/register` (per session) | 20 | 1 min |
| `public/events/[slug]/register` (per IP) | 10 | 10 min |
| `upload` (per session) | 30 | 1 min |

Each 429 returns a clean message + `retry-after` header + `x-ratelimit-reset` timestamp.

### Files touched this session

- New: `lib/ratelimit.ts`, `lib/sanitizeHtml.ts`, `components/EmptyState.tsx` (already existed; restyled in `0e47830`), `app/member/page.tsx::TileLink` (inline component).
- Modified visual: `lib/dashboardNav.ts`, `components/DashboardSidebar.tsx`, `components/DashboardBottomNav.tsx`, `components/EmptyState.tsx`, `app/dashboard/page.tsx`, `app/dashboard/layout.tsx`, `app/dashboard/events/page.tsx`, `app/dashboard/reports/page.tsx`, `app/dashboard/staff/page.tsx`, `app/dashboard/documents/page.tsx`, `app/member/page.tsx`, `app/member/messages/page.tsx`, `app/member/messages/dm/[userId]/page.tsx`, `app/member/messages/group/[id]/page.tsx`, `app/api/member/portal/route.ts`.
- Modified security: `app/api/messages/dm/route.ts`, `app/api/upload/route.ts`, `app/api/auth/{forgot-password,reset-password,change-password,signup}/route.ts`, `app/api/member/signup/route.ts`, `app/api/member/messages/dm/[userId]/route.ts`, `app/api/member/messages/groups/[id]/route.ts`, `app/api/member/classes/book/route.ts`, `app/api/member/events/[id]/register/route.ts`, `app/api/public/events/[slug]/register/route.ts`, `app/api/documents/route.ts`, `app/api/documents/[id]/route.ts`.
- New deps in `package.json`: `lucide-react ^0.469.0`, `isomorphic-dompurify ^2.36.0`.

### What's left when you return

1. **iOS simulator smoke** — the only blocker between this branch and merge. From the user's last check session:
   - Login works on Chrome + Safari + native shell ✓
   - Native simulator wouldn't open a window for the full manual sweep — re-run `npm run cap:ios`, ensure the App scheme + an iOS simulator device are selected in Xcode, hit ▶. Walk:
     - Dashboard home shows NO horizontal scroll, "Upcoming events" and "Recent members" do NOT overlap, calendar widget renders 7 columns × 5-6 rows with readable day numbers.
     - Member portal home — every tile (Schedule / My Bookings / Messages / Announcements / Documents / Our team or My Profile) shows a lucide icon in a lime circle. **No ? boxes anywhere.**
     - As a parent: `/member/messages` shows "Messages for your athletes" section always (even with zero child messages) + an explanatory lime info card. With actual child threads: each row shows a lime left stripe + "For <kid>" pill. Tap into a child thread — header shows the same pill + "This thread is about <kid>" subtitle.

2. **Untested 429 paths** — code-level clean but no E2E smoke. Quick browser check: 6× rapid "Forgot password" submissions → 6th gets a friendly 429 with a `Retry-After` header.

3. **Document sanitization smoke** — paste `<script>alert(1)</script>hello` into a document body in `/dashboard/documents`. Save. View on `/member/documents` — `<script>` should be gone; "hello" still renders.

4. **Routes NOT audited for zod** (carried over): the parallel audit covered 14 of 26 routes. The 12 not yet read:
   - `app/api/club/update`, `app/api/club/locations`
   - `app/api/transactions`, `app/api/expenses`, `app/api/financials/manual-payment`
   - All STAFF/OWNER-only — limited abuse surface, but should still get a zod-coverage check next pass.

5. **Phase 1 + 2 simulator end-to-end smoke** (carried over from earlier sessions): same checklist in the 2026-05-30 session log below — most items still apply, but the iOS-specific fixes from `0f9a0ca` and `1dc5cb4` need fresh verification.

6. **Pre-existing cleanup still open** (carried over): `lib/auth.ts` pre-existing `as any` casts on session/JWT, unused `allEvents` in `app/dashboard/page.tsx`, unescaped quotes in `app/dashboard/settings/page.tsx`, orphan `/dashboard/schedule/page.tsx`. Low priority.

### Architectural notes for future-me

- **Tailwind v4 arbitrary values are not bulletproof** on iOS WebKit's first paint after install. When a visual indicator MUST render correctly (e.g. a lime border distinguishing parent vs child threads), use inline `style={{}}` with CSS variables or hardcoded hex. This is what the `LIME` / `LIME_BG` / `LIME_BORDER` / `LIME_TEXT` constants in `app/member/messages/page.tsx` exist for.
- **CSS Grid items default to `min-width: auto`** which is the intrinsic min-content width. ALWAYS add `min-w-0` to grid item wrappers if their content includes long unbroken strings (event names, table rows, member names). The default is a footgun that surfaces as iOS-specific layout regressions.
- **lucide-react is now the standard for icons** across owner + member surfaces. No unicode glyphs in user-facing labels. Emojis (👋, ×, ✓ on small buttons) are still OK because the iOS system font carries those; but if in doubt, prefer the SVG.
- **Rate limit conventions**: keys are `${category}:${ip-or-userid}` (e.g. `messages:dm:${userId}`, `auth:signup:${ip}`). 1-minute windows for messaging/booking (operational), 10-minute windows for auth (anti-brute-force). Public routes use IP; authenticated routes use session.user.id.
- **HTML sanitization on WRITE not READ**: the `dangerouslySetInnerHTML` call sites trust their source (they HAVE to — the renderer doesn't get to revalidate). `sanitizeRichHtml()` is invoked once at WRITE time so every read is implicitly trusted.

## Session log — 2026-05-30 (Phase 1 native URL hardening + Phase 2A/B/C dashboard redesign foundation)

Branch: `native-app-shell` (pushed: NO, merged: NO). Commits in order:

| SHA       | Phase   | Title                                                 |
|-----------|---------|-------------------------------------------------------|
| `dfcc270` | 1       | harden native shell URL/redirect chain                |
| `0aeabae` | 2A      | mobile-aware dashboard shell                          |
| `4ae5923` | 2B      | mobile-responsive dashboard overview + primary CTA bar|
| `fc96f22` | 2C      | add EmptyState and LoadingSkeleton primitives         |
| `d5b4b67` | 2C      | apply primitives to reports page                      |
| `e122674` | 2C      | apply primitives to documents page                    |
| `7e606a6` | 2C      | apply primitives to calendar page                     |
| `6761ab7` | 2C      | apply primitives to attendance page                   |
| `f32cbb7` | 2C      | apply primitives to financials page                   |
| `7fc3fa7` | 2C      | apply primitives to classes page                      |
| `304b45b` | 2C      | apply primitives to staff page                        |
| `77efa9b` | 2C      | apply primitives to members page                      |
| `a99879c` | 2C      | apply primitives to events page                       |
| `80335df` | 2C      | apply primitives to settings page                     |
| `5c1fc5d` | log     | mark 2C section sweep complete in session log         |
| `53c4070` | 2D      | bottom-sheet modals + scroll tables + stack form grids|
| `b04cfcb` | log     | mark 2D + 2E complete + test checklist                |
| `b2b72d6` | 2E      | address HIGH/MEDIUM findings from code review         |

### Phase 1 — native shell URL/redirect hardening (DONE)

Root cause of yesterday's 5 native iOS symptoms was a chain: `.env` had a malformed `NEXTAUTH_URL="NEXTAUTH_URL=http://localhost:3001"` (literal key prefix inside the value, WebKit-restricted port, IPv6-first `localhost`). 26 inline `process.env.NEXTAUTH_URL || "http://localhost:300x"` fallbacks across the codebase shipped that malformed string into Stripe / email / redirect URLs. WKWebView blocked the `:3001` nav, fell back to `errorPath`, and the error page retried to `/` (the marketing landing) — silently sending the owner to the wrong surface.

Fixes (commit `dfcc270`):

- **`.env`** (uncommitted because gitignored): set `NEXTAUTH_URL=http://127.0.0.1:3000` (literal IPv4, allowed WebKit port).
- **`lib/baseUrl.ts` NEW** — `getAppBaseUrl()` parses `NEXTAUTH_URL` with `new URL()`, falls back to `http://127.0.0.1:3000` when missing OR malformed (the old `||` pattern only caught missing). Dev-only `console.warn` when fallback fires.
- **23 routes + libs** migrated from the inline fallback to `getAppBaseUrl()`. Full list: `app/api/auth/forgot-password`, `app/api/classes/[id]/charge`, `app/api/club/branded-app`, `app/api/club/subscription/checkout`, `app/api/club/subscription/portal`, `app/api/contractors/[id]/invite`, `app/api/events/[id]/bill-registrants`, `app/api/events/[id]/charge`, `app/api/member/classes/book`, `app/api/member/events/[id]/register`, `app/api/member/memberships/subscribe`, `app/api/member/products/[id]/buy`, `app/api/members/migration/[id]`, `app/api/members/migration/activate/[token]`, `app/api/members/route.ts`, `app/api/members/subscribe`, `app/api/public/events/[slug]/register`, `app/api/staff/[id]/setup-link`, `app/api/staff/route.ts`, `app/api/stripe/connect`, `app/api/stripe/webhook`, `lib/migrationServer.ts`.
- **`scripts/native-shell-config.mjs` NEW** + **`public/native-shell/server-config.js` NEW** — build-time injection of `window.NATIVE_SERVER_URL` from `CAPACITOR_SERVER_URL` / `NEXT_PUBLIC_APP_URL` so production builds retry against the real domain. Runs as part of `npm run cap:sync`.
- **`public/native-shell/native-shell-error.html`** — loads `server-config.js`, retries to `SERVER_URL + "/member"` instead of `/`. Middleware routes from `/member` based on session: valid → `/dashboard` or `/member`; invalid → `/login`. Marketing landing no longer hijacks failed reconnect attempts.
- **`package.json`** — `cap:sync` now runs `node scripts/native-shell-config.mjs && cap sync`.
- **`lib/auth.ts`** — removed temporary `[auth/authorize]` dev logging from yesterday. Kept explicit cookie config + `.trim().toLowerCase()` defensive normalization.
- **`.gitignore` + `git rm --cached -r android/.idea`** — 5 IDE files untracked.
- **Cosmetic 3001→3000** — `app/dashboard/settings/page.tsx:1012`, `app/dashboard/settings/diagnostics/page.tsx:140`, and four lines in this CLAUDE.md.

Verified at code level: `npx tsc --noEmit`, `npm run lint`, `npm run build`, `npm run cap:sync` all clean. **Simulator end-to-end NOT verified** — needs user to run the 5-minute smoke (cold launch, owner login, logout, re-login, force a connect failure to confirm the error-page retries to `/member`).

### Phase 2A — mobile-aware dashboard shell (DONE)

Dashboard had a fixed 248px sidebar on every screen and no mobile sign-out path (sign-out was buried in the sidebar footer; mobile = no sidebar = no logout).

Fixes (commit `0aeabae`):

- **`lib/dashboardNav.ts` NEW** — single source for `NAV[]` + `BOTTOM_NAV[]` + `isGroupActive()` / `isItemActive()`. Both desktop sidebar and mobile bottom nav consume it.
- **`components/DashboardSidebar.tsx` NEW** — extracts the 280-line inline sidebar from `app/dashboard/layout.tsx` verbatim. Desktop look pixel-identical (refactor only). Accepts `onNavigate` so the mobile drawer closes on link click. Preserves Phase 1 `signOutEverywhere` wiring on the sign-out button.
- **`components/DashboardMobileDrawer.tsx` NEW** — slide-in overlay at `< md`. Locks body scroll while open; closes on Escape, backdrop tap, or route change.
- **`components/DashboardBottomNav.tsx` NEW** — fixed bottom nav for mobile, 5 slots: Home / Members / Classes / Money / More. "More" opens the drawer. Charcoal background matches sidebar. `env(safe-area-inset-bottom)` for iOS home indicator.
- **`components/UserMenu.tsx` NEW** — avatar dropdown for the topbar. Click outside / Escape closes. Contents: My account / Client view / Need help? / Sign out (still through `signOutEverywhere`). Solves the no-sign-out-on-mobile gap.
- **`components/PageHeader.tsx` NEW** — shared `<PageHeader title description actions eyebrow />` primitive for section pages. Foundation for Phase 2C polish.
- **`app/dashboard/layout.tsx`** — rebuilt around new components. Desktop (`≥ md`): persistent sidebar + existing BackButton/GlobalSearch topbar + new UserMenu on the right. Mobile (`< md`): charcoal topbar (hamburger + AthletixOS wordmark + UserMenu), second sticky row with Back + Search, fixed bottom nav.

What did NOT change: member portal layout/theme/bottom nav, NextAuth, signOutEverywhere, preview cookie, `/api/me`, permission gating, sidebar content/order. All extracted verbatim.

### Phase 2B — mobile-responsive dashboard overview + primary CTA bar (DONE)

Three problems on the dashboard home: `grid-cols-4` overflowed on mobile; Quick Actions lived inside an optional widget so hiding it killed the fastest paths; `p-8` wasted mobile screen.

Fixes (commit `4ae5923`, single file: `app/dashboard/page.tsx`):

- Outer container: `p-4 sm:p-6 lg:p-8`.
- Stat grid: `grid-cols-2 sm:grid-cols-3 lg:grid-cols-4` — 2 cols on phone, 4 on desktop.
- Section grid: `grid-cols-1 lg:grid-cols-2`.
- StatCard padding + type sizing responsive; long values truncate cleanly.
- Greeting block stacks on mobile, returns to row on `sm+`. Customize button moves to `self-start`.
- **NEW `PRIMARY_QUICK_ACTIONS` bar** above the stats grid — always rendered regardless of widget config. First action ("Add member") is the violet brand-color CTA; the rest are neutral surface buttons. Horizontally scrollable on mobile so it never wraps. Action set: Add member, New class, New event, Send message, Client view.

Widget customize/order/hide system untouched. `/api/dashboard/summary` + `/api/dashboard/widgets` untouched.

### Phase 2C — primitives + full section sweep (DONE)

Primitives (commit `fc96f22`):

- **`components/EmptyState.tsx` NEW** — icon + title + description + action slot (link or onClick).
- **`components/LoadingSkeleton.tsx` NEW** — `SkeletonLine`, `SkeletonCard`, `SkeletonRow`, `SkeletonList`. Pulse-animated placeholders matching `bg-app-bg` / `bg-surface` tokens.

Section sweep (10 commits, one per page): applied `PageHeader` + `SkeletonList`/`SkeletonCard` + `EmptyState` (where structural) across `app/dashboard/{reports,documents,calendar,attendance,financials,classes,staff,members,events,settings}/page.tsx`. Every section page now:

- Uses `PageHeader` with `title` / `description` / `actions` slots — consistent typography and mobile-stacking layout across the dashboard.
- Replaces `"Loading…"` text fallbacks with `SkeletonCard`×N or `SkeletonList rows={N}` — the user sees the shape of what's loading rather than a blank line.
- Where appropriate, the page-level empty state uses `EmptyState` (`documents`, `staff`, `events`, `reports`-tier-blocked). In-card "No X in this range" text fragments left as small text — they're contextual fillers, not page-level zero states.
- Outer padding migrated from `p-8` → `p-4 sm:p-6 lg:p-8` — mobile-friendly density without sacrificing desktop airiness.
- Primary CTAs gain `w-full sm:w-auto` so they're full-width on mobile.
- Settings sub-nav stacks `flex-col md:flex-row` so the sub-section list is reachable without horizontal scroll on phone.

What did NOT change in this sweep: data fetching, API endpoints, business logic, widget customize/order system, sub-section page structure (settings sub-tabs, member-form builder, branded-app config, etc. retain their own structure and can adopt `PageHeader` incrementally).

Verified: full `npm run build`, `npx tsc --noEmit`, `npm run cap:sync` all clean. Pre-existing lint warnings in files (mostly `as any` casts and unescaped quotes) are unrelated — verified each is well outside the lines this sweep touched.

### Files touched this session
- New: `lib/baseUrl.ts`, `lib/dashboardNav.ts`, `scripts/native-shell-config.mjs`, `public/native-shell/server-config.js`, `components/DashboardSidebar.tsx`, `components/DashboardMobileDrawer.tsx`, `components/DashboardBottomNav.tsx`, `components/UserMenu.tsx`, `components/PageHeader.tsx`, `components/EmptyState.tsx`, `components/LoadingSkeleton.tsx`
- Modified (Phase 1): 23 API routes + libs (see Phase 1 list), `lib/auth.ts`, `lib/migrationServer.ts`, `package.json`, `public/native-shell/native-shell-error.html`, `app/dashboard/settings/diagnostics/page.tsx`, `.gitignore`, `CLAUDE.md`
- Modified (Phase 2A/B): `app/dashboard/layout.tsx`, `app/dashboard/page.tsx`
- Modified (Phase 2C sweep): `app/dashboard/{reports,documents,calendar,attendance,financials,classes,staff,members,events,settings}/page.tsx`
- Out of repo (`.env`): `NEXTAUTH_URL=http://127.0.0.1:3000`
- Untracked / removed: 5 `android/.idea/*` files (still on disk, just untracked)

### What's left when you return

Tasks below are ordered for resumption. Pick up at the top.

1. **Simulator verification of Phase 1** — REQUIRED before continuing. 5 minutes:
   - `npm run dev` (port 3000)
   - `npm run cap:ios` → run on simulator
   - Cold launch the app → confirm it lands on `/member` (not `/`). Xcode console should show **zero** "restricted network port" lines.
   - Owner login → confirm lands on `/dashboard`.
   - Sign out → confirm lands on `/login`.
   - Sign back in → confirm it works (this was the symptom-3 blocker).
   - Stop the dev server briefly, watch the "Reconnecting…" screen → confirm it auto-retries to `/member` not `/` once the server comes back.
   - Browser desktop smoke: same login/logout/Client View loop on Chrome / Safari to confirm browser flow is unchanged.

2. **Phase 2C section sweep** — DONE this session. All 10 section pages now use the primitives. Sub-tabs inside settings (Profile / Billing / Email / Branded App / Diagnostics / Club / Member Portal / Member Form) can adopt `PageHeader` incrementally in the next sweep if needed.

### Phase 2D — mobile polish sweep (DONE)

Bulk sed across 22 dashboard files via commit `53c4070`:

- **Modal pattern** applied across all 47 inline modal wrappers in 18 files:
  - Outer `flex items-center justify-center ... p-4` → `flex items-end sm:items-center justify-center ... p-0 sm:p-4` (bottom-sheet on mobile).
  - Inner `rounded-xl w-full` → `rounded-t-2xl sm:rounded-xl w-full` (top-corner-only rounding on mobile).
- **Tables**: 4 wrapper divs `bg-white rounded-xl border border-app-border overflow-hidden` containing `<table className="w-full">` swapped to `overflow-x-auto` so wide financial / product / privates tables scroll horizontally on mobile instead of being clipped.
- **Form grids**: `grid-cols-2 gap-3`, `grid-cols-2 gap-4`, and `grid-cols-3 gap-3` patterns globally rewritten to `grid-cols-1 sm:grid-cols-N gap-N` — two-up form rows stack on mobile.

What was deliberately left alone: calendar week grid (`grid-cols-7`), KPI grids that already had responsive classes from 2B, and `overflow-hidden` usages NOT direct-parent of a table.

### Phase 2E — final regression pass (CODE LEVEL DONE; E2E SMOKE BLOCKED ON USER)

What I verified at code level:

- `npx tsc --noEmit` — clean (no new errors).
- `npm run lint` — only pre-existing warnings/errors in files NOT touched by this branch.
- `npm run build` — full Next.js production build clean.
- `npm run cap:sync` — clean; native bundle re-synced.
- Outside review: dispatched the `review:code-reviewer` agent in background to read the diff and surface anything I missed. Findings (if any) need to be addressed by the user or in a follow-up commit before merging.

What needs a human at a browser / simulator to verify (test checklist below). This is the ONLY blocker between "branch complete" and "merge to main".

4. **End-to-end test checklist before merging to main** (covers BOTH Phase 1 and Phase 2):

   **A. Native iOS shell (Phase 1)** — ~10 min:
   1. `npm run dev` (binds 0.0.0.0:3000)
   2. `npm run cap:ios` → open in Xcode → run on simulator (cold launch from clean state).
   3. App loads to `/member` (NOT marketing `/` and NOT a "Can't reach AthletixOS" screen).
   4. Xcode console shows ZERO `restricted network port` errors during the full session.
   5. Sign in as OWNER via the "Club / Staff" tab → lands at `/dashboard`.
   6. Tap the avatar dropdown in the top-right → tap **Sign out** → lands at `/login`.
   7. Sign back in with the same credentials → re-lands at `/dashboard`. (This was symptom #3 — re-login after logout. The malformed `NEXTAUTH_URL` previously broke this.)
   8. With dev server running, stop it briefly (Ctrl-C in the terminal). Watch the WebView: should show "Reconnecting…" with the auto-retry spinner.
   9. Restart `npm run dev`. The WebView should automatically navigate back to `/member` (NOT `/`). Middleware then sends a signed-in OWNER to `/dashboard`.
   10. Sign out again, force-quit the app, relaunch cold: should land at `/login` (not the marketing landing).

   **B. Browser desktop login matrix (Phase 1)** — ~5 min:
   1. Chrome incognito + Safari private window, both fresh:
   2. `/login` → sign in as OWNER → `/dashboard` loads cleanly.
   3. Sign out (avatar menu, top right) → lands at `/login`.
   4. Sign in as STAFF (a club user with limited permissions). Verify `Staff view · <title>` badge appears in sidebar and bottom-of-page nav. Verify restricted sections are hidden from sidebar AND bottom nav.
   5. Sign in as MEMBER via the "Member / Parent" tab → lands at `/member`. Verify the member portal still renders LIGHT (no dark-mode flip).
   6. As MEMBER, try to manually navigate to `/dashboard/members` → middleware redirects to `/member`.
   7. As OWNER, try `/dashboard/preview` → "Client view" page loads → tap "Preview Member Portal" → amber "Preview mode — Exit preview" banner shows. Tap Exit → bounces back to `/dashboard`. Cookie cleared.

   **C. Desktop dashboard surface (Phase 2A/B/C)** — ~10 min at full desktop width (≥1280px):
   1. `/dashboard` home: hero greeting renders, primary CTA bar shows 5 actions, 4 stat cards in a row, section grid in 2 columns. Customize modal still opens/saves widget prefs.
   2. Sidebar: every section visible; clicking a section sets active state; group sections (Staff, Purchase Options, Classes & Events, Communication) expand/collapse correctly.
   3. Topbar: BackButton hidden on `/dashboard`, shows on every sub-page. GlobalSearch (⌘K) opens. UserMenu avatar at the right opens with My account / Client view / Need help? / Sign out.
   4. Each of these section pages renders the new PageHeader and shows a skeleton on initial load:
      - `/dashboard/members` (table list)
      - `/dashboard/classes` (Classes tab + Events tab)
      - `/dashboard/events`
      - `/dashboard/financials` (Summary / Money In / Money Out / Donations / Tax tabs all skeleton on load)
      - `/dashboard/reports` (KPI skeleton, then chart loads)
      - `/dashboard/staff`
      - `/dashboard/settings` (sub-nav still works)
      - `/dashboard/attendance` (skeleton on Suspense fallback)
      - `/dashboard/documents`
      - `/dashboard/calendar` (42-cell skeleton grid on month change)
   5. Empty states: with a fresh test club, `/dashboard/documents`, `/dashboard/staff`, `/dashboard/events` should each show the new EmptyState UI (icon + title + description + CTA), not raw "No X yet" text.

   **D. Mobile dashboard at 375px width (Phase 2A/D)** — ~10 min using Chrome DevTools device mode (iPhone SE) OR the native shell:
   1. Top app-bar shows: hamburger (left) + AthletixOS wordmark + UserMenu avatar (right). Charcoal background.
   2. Tap hamburger → drawer slides in from the left with full sidebar. Backdrop is dimmed. Body doesn't scroll behind drawer. Tap backdrop or press Esc → drawer closes.
   3. Bottom nav (fixed, charcoal): Home / Members / Classes / Money / More. Tap each — active state updates. "More" opens the drawer.
   4. Drawer "Sign out" works the same as desktop (lands at `/login`).
   5. Avatar menu in mobile topbar: My account / Client view / Need help? / Sign out all reachable. Closes on outside tap.
   6. Navigate to `/dashboard/members`, `/dashboard/financials`, `/dashboard/events`, `/dashboard/classes`. Verify:
      - No horizontal page scroll (the page itself never overflows; content stays within 375px).
      - Page header stacks: title and description on top, action buttons below in a wrapping row.
      - Stat-card grids render 2-up on mobile, not 4-up.
      - Tables (financials transactions, products list, privates packages) scroll horizontally inside their rounded card — the outer page does not.
   7. Open ANY modal on mobile (Add member, Edit class, etc.):
      - Modal slides up from the bottom edge (bottom-sheet style).
      - Modal has rounded TOP corners only (touches bottom edge).
      - Tap outside / backdrop closes it (where the original modal supported that).
      - Modal content scrolls inside the sheet; the underlying page does not.
   8. Open a form-heavy modal (Edit Class is good): two-up form fields stack to single-column on mobile.

   **E. Phase 1 + 2 do not regress what was working:**
   - Stripe checkout / payment flows: complete a member subscription (test mode) → ensure success/cancel URLs land back on the right page (not at `:3001`).
   - Email flows: trigger a staff invite, password reset, or booking confirmation → the link in the email uses `127.0.0.1:3000` (or the configured prod URL), NOT `localhost:3001`.
   - Webhook listening: `stripe listen --forward-to localhost:3000/api/stripe/webhook` works.
   - Client View preview: enter from `/dashboard/preview`, exit from the amber banner on the member portal — cookie cleared, lands at `/dashboard`.

   **F. Outside review** (done this session, follow-up items captured below):
   - The `review:code-reviewer` agent reviewed the Phase 1 + 2A + 2D diffs and surfaced 10 items. The 2 HIGH-severity and 3 of 4 MEDIUM-severity were fixed in commit `b2b72d6`. The remaining LOW items and one MEDIUM (#4 subpath deployments — documented inline) are captured in "Known follow-ups from review" below.

### Known follow-ups from review (LOW priority, not blocking merge)

These are review findings that did NOT block merging but should be addressed when next touching the affected file:

1. **Bulk-sed visual downgrades** — Phase 2D's form-grid sed rewrote *every* `grid-cols-3 gap-3` to stack on mobile. Most are form fields where stacking is correct, but a few short-label numeric KPI tiles (notably the Seen / Opened / Link clicks tiles on `app/dashboard/announcements/page.tsx` around line 263, and the City / State / Zip address row on `app/dashboard/members/page.tsx` around line 744) read better as 3-up even on small mobile. Audit and selectively revert these specific grids to `grid-cols-3 sm:gap-3` (without the `grid-cols-1 sm:` prefix) when convenient.

2. **NAV duplication** — `lib/dashboardNav.ts` `NAV` and `app/dashboard/page.tsx` `sections` array are two independent lists of the same routes with the same labels and same icons. They'll drift silently. Next time `app/dashboard/page.tsx` is touched, hoist `sections` out and derive it from `NAV`.

3. **/api/me redundant for OWNER** — `app/dashboard/layout.tsx` always fetches `/api/me`, but the session token already carries the OWNER role + null permissions. Skip the fetch when `session.user.role === "OWNER"` — saves one round-trip per dashboard page load for the most common user.

4. **Subpath deployment caveat** — `lib/baseUrl.ts:getAppBaseUrl()` uses `new URL(raw).origin` which strips path components. A `NEXTAUTH_URL=https://example.com/app` becomes `https://example.com`, dropping the `/app` prefix. Currently NO deploys use subpath URLs; if that ever changes, return `new URL(raw).href.replace(/\/$/, "")` instead. Caveat documented inline at the top of `lib/baseUrl.ts`.

5. **Pre-existing cleanup still open** (carried from yesterday + still relevant):
   - `lib/auth.ts` lines 94, 102-113 have pre-existing `as any` casts on session/JWT — type properly with `next-auth.d.ts` augmentation when convenient.
   - `app/dashboard/page.tsx:76` — unused `allEvents` state slot.
   - `app/dashboard/settings/page.tsx:997-1007` — pre-existing unescaped quotes in iOS/Android install instructions.
   - `app/dashboard/schedule/page.tsx` — orphan kept on purpose (back-compat), but nothing in source links to it anymore. Consider removing after the section sweep settles.

6. **Out of scope but still worth doing** (from prior sessions, unchanged):
   - Live Stripe end-to-end (`stripe listen --forward-to localhost:3000/api/stripe/webhook`) + live Price IDs.
   - Multi-location full UX.
   - SMS provider wiring for the announcement broadcast.
   - Add-Staff invite bio/photo (currently Edit-only).
   - Smoke scripts for: member-add → status flip, trial, document re-sign, calendar feed, class regenerate.

### Architectural notes for future-me

- `lib/baseUrl.ts` is the ONLY place that should derive an absolute URL from env. Never reintroduce `process.env.NEXTAUTH_URL || "http://..."` — the `||` pattern silently passes a malformed truthy value. A pre-commit grep for that pattern would catch regressions.
- The native shell error page reads `window.NATIVE_SERVER_URL` from `server-config.js`. For a TestFlight or production build, run `CAPACITOR_SERVER_URL=https://app.athletixos.com npm run cap:sync` so the generator writes the right URL into the bundle.
- `lib/dashboardNav.ts` is the single source for the nav tree. To add a section: add it to `NAV` (desktop sidebar uses it automatically) and decide whether it earns a `BOTTOM_NAV` slot (5 slots, max — fight for them).
- `components/DashboardSidebar.tsx` is used in TWO places: directly inside the desktop `<aside>` and inside `DashboardMobileDrawer`. Any styling changes affect both surfaces.
- The avatar in `UserMenu` uses `initialsOf(displayName, email)` — first letters of the first two words of the display name. Fallback is first letter of email. NextAuth's `session.user.name` is the source of truth; `/api/me` does NOT return name fields.

## Session log — 2026-05-29 (native auth + WebView reliability)

Branch: `native-app-shell` (pushed; not merged to `main`). Tip: `11c6493`.

### What changed (in commit order)
- `5d7db99` Login page now hard-navs (`window.location.href`) after `signIn` instead of `router.replace`, fixing the stuck-on-/login bug in iOS WKWebView and Safari.
- `b0a9506` Added `app/post-login/route.ts` — server-side reads JWT via `getServerSession` and 307s to `/dashboard` or `/member`. Eliminates all client-side session hydration races.
- `2c2980b` Safari Set-Cookie commit race: added a macrotask yield in the login page plus an HTML auto-retry page inside `/post-login` (`?retry=N`, max 2). If the cookie isn't visible to the server on first GET, the page reloads itself with a counter and the cookie is there by then.
- `e4857a4` Reverted `.trim()` on email/clubSlug — was an unnecessary change and surfaced a non-`CredentialsSignin` error string in the UI when present.
- `bdc0365` Two bug fixes in one:
  - Explicit cookie config in `lib/auth.ts` (`useSecureCookies` + `cookies.sessionToken/callbackUrl/csrfToken`), pinned to `NODE_ENV` instead of `NEXTAUTH_URL`. Reason: `.env` had `NEXTAUTH_URL="NEXTAUTH_URL=http://..."` (literal key prefix inside the value), which made NextAuth's auto-detection pick `__Secure-` cookies on http://localhost — Safari refuses to store those.
  - `cache-control: no-store, no-cache, must-revalidate` on every `/post-login` response so a previous OWNER login's cached 307 can't route a later MEMBER to `/dashboard`.
- `5b47b13` Real root cause of the simulator 401: iOS WKWebView's default soft keyboard auto-capitalized the club slug. `apex-wrestling` arrived as `Apex-wrestling`. Fix: `autoCapitalize="none"`/`autoCorrect="off"`/`spellCheck={false}` + appropriate `autoComplete`/`inputMode` on all three login inputs. Also added dev-only `[auth/authorize] …` logging (no passwords, no hashes) and defensive `.trim().toLowerCase()` on email + clubSlug server-side.
- `6ee0693` `capacitor.config.ts` default URL → `http://127.0.0.1:3000`. macOS resolves `localhost` to IPv6 `::1` first; Next dev was on IPv4 only, so the WebView's connect was refused. Removed `NEXTAUTH_URL` from the WebView fallback chain (malformed env was poisoning `server.url`).
- `5d447ca` Dev port moved from 3001 → 3000 because WebKit added 3001 to its restricted-network-ports blocklist (the "Not allowed to use restricted network port" Xcode error). Updated `package.json`'s `dev` script to `next dev -H 0.0.0.0 -p 3000` so the simulator + any LAN device can reach Next regardless of IPv4/IPv6 preference.
- `df12a40` Phase 1 reliability + logout pass:
  - `public/native-shell/native-shell-error.html` rewritten: dark themed, spinner, auto-retries the server URL every 2s for up to 4 attempts (tracked in `sessionStorage`), then surfaces a "Try again" button. Replaces the static "Can't reach AthletixOS / reopen the app" dead-end.
  - `lib/signOutEverywhere.ts` (new): calls `signOut({ redirect:false })`, `DELETE /api/preview` (clears the HttpOnly Client-View cookie), removes `athletixos-active-profile` from localStorage, then hard-navs to `/login`. Wired into `app/dashboard/layout.tsx` + `app/member/layout.tsx` (desktop + mobile sign-out buttons).
- `11c6493` End-of-day misc: `package-lock.json` from before the session, plus the `android/.idea/` IDE files (probably should be gitignored next session).

### Native shell state right now
- Dev port: **3000** (was 3001; WebKit-blocked).
- Default `server.url`: `http://127.0.0.1:3000/member` (was `http://localhost:3001/member`).
- `npm run dev` binds `0.0.0.0:3000` automatically.
- iOS simulator usually loads cleanly. If Next isn't up yet, the new dark "Reconnecting…" screen auto-retries instead of showing a dead "Can't reach" page.
- Sign out works identically in Chrome, Safari, and WKWebView (always lands on `/login`, clears local state + preview cookie).

### Tomorrow's queue

**Must-do (cleanup from today):**
1. **Fix `.env`** — the value is malformed and the port is wrong:
   ```diff
   - NEXTAUTH_URL="NEXTAUTH_URL=http://localhost:3001"
   + NEXTAUTH_URL=http://localhost:3000
   ```
2. **Remove the temporary `[auth/authorize] …` dev logging** from `lib/auth.ts` once you've confirmed login is stable across web + native. Search for `[auth/authorize]` to find the lines — gated on `NODE_ENV !== "production"` already, so it never runs in prod, just noisy in dev.
3. **Decide on `android/.idea/`** — committed today (5 files). If those are personal IDE config, add `android/.idea/` to `.gitignore` and revert that commit.

**Doc/UI sweep (no behavior impact, do when convenient):**
- CLAUDE.md still says port 3001 in a few places (this file's intro, native-shell section, Stripe CLI hint).
- `app/dashboard/settings/page.tsx:1012` — "Member portal URL: localhost:3001/member" hint.
- `app/dashboard/settings/diagnostics/page.tsx:140` — "stripe listen --forward-to localhost:3001/..." hint.
- The `|| "http://localhost:3001"` fallbacks in API routes (~10 places) — only fire when `NEXTAUTH_URL` is unset, so safe to leave, but worth a sweep.

**Phase 2 — Owner/staff dashboard redesign (not started):**
- Plan was: nav first, then overview cards, then per-section visual passes — incrementally, not a swing-for-the-fences rewrite.
- Sections in scope: sidebar/top nav, dashboard overview, members, classes/events, attendance, privates, financials, reports, staff tools, settings/personalization.
- Constraint: do not change APIs, auth, Stripe/Plaid, or role permissions. UI-only.
- Reuse design tokens from `app/globals.css` (no new color families).

**Phase 3 — Member dashboard polish (not started):**
- Keep direction/style; polish spacing, nav, empty states, buttons, mobile layout. Should feel like a real native app inside the WebView.

**Out-of-scope items still open from prior sessions** (unchanged by today):
- Live Stripe end-to-end + live Price IDs.
- Multi-location UX.
- SMS provider wiring.
- Add-Staff invite bio/photo (currently Edit-only).
- Smoke scripts for member-add → status flip, trial, doc re-sign, calendar feed, class regenerate.

### Files touched this session
- `web/app/login/page.tsx`
- `web/app/post-login/route.ts` (new)
- `web/lib/auth.ts`
- `web/lib/signOutEverywhere.ts` (new)
- `web/capacitor.config.ts`
- `web/package.json`
- `web/app/dashboard/layout.tsx`
- `web/app/member/layout.tsx`
- `web/public/native-shell/native-shell-error.html`

## Next Priorities

- Run live Stripe end-to-end with the CLI (`stripe listen --forward-to localhost:3000/api/stripe/webhook`) and verify the diagnostics page surfaces each event correctly.
- Configure live Stripe Price IDs in production env and verify ClubOS subscription upgrade flow round-trips.
- Build out a real multi-location UX (locations page is thin, even though schema/gating is in place).
- Wire SMS provider for the announcement broadcast flow (template + tier flag exist).
- Add Add-Staff (invite) bio/photo fields to remove the two-step "invite then edit" workflow.
- Add focused smoke scripts for: member-add → status flip, trial flow, document-sign + re-sign cycle, calendar feed, class schedule changes regenerating sessions.

## Next Build Script

Use this checklist for the next development session:

1. Inspect current state first:
   - `git status --short`
   - read relevant page/API/schema files before editing
   - check whether a feature already exists partially
2. Do not rebuild existing features from scratch.
3. Make one feature branch or one commit per feature.
4. Keep changes scoped to the feature.
5. For UI changes, use the current design tokens.
6. For schema changes:
   - First try `npx prisma migrate dev --name <name>`.
   - If shadow-DB permissions block it: hand-write a migration folder + `migration.sql`, then `npx prisma migrate deploy` + `npx prisma generate`.
7. Avoid `prisma migrate reset` unless explicitly intended.
8. Run before each commit:
   - `npx prisma validate`
   - `npx prisma migrate status`
   - `npx tsc --noEmit` (filter out the pre-existing `headers().get` and outer-repo `legalEntityId` errors)
9. Commit working checkpoints often.
10. Push after a clean checkpoint.

## Feature Ideas / To Review Later

- UI polish
- Color scheme refinements
- Full multi-location UX
- Complete document form builder (current renderer is HTML + acknowledgement; no field-by-field signature UI)
- Push / SMS delivery providers
- Full report builder / saved views
- Mobile / PWA / native app path
