# Billing Administration & Reactivation — Implementation Plan (2026-07-10)

Branch `claude/athletixos-billing-reactivation-ecc23d` off `main@670342a`.
Safety envelope: no live subscription is charged/approved/canceled/converted during this build; all
scripts stay dry-run; Joseph B. / Mack M. / Sawyer M. untouched; `migrate-manual-to-stripe.ts --apply`
is never run.

## Schema changes (ONE additive migration: `20260710000000_billing_control`)

1. `members` — new nullable columns (all additive, no backfill needed):
   - `migrationGroup TEXT` — operational classification: `A | B | C | LEAVE_ALONE | FUTURE_FOLLOW_UP | NEEDS_PAYMENT_METHOD`.
   - `migrationFinalAction TEXT` — `MANUAL_APPROVE | ACTIVATION_EMAIL | LEAVE_ALONE | FUTURE_FOLLOW_UP | NEEDS_CARD | OWNER_REVIEW`.
   - `migrationGroupNote TEXT` — owner triage note.
   - `migrationFinalBillingDate TIMESTAMP(3)` — the owner-approved FINAL first-charge date (planning value;
     approval/reactivation read it as the proposed anchor and still validate it is in the future).
   - `responsiblePayerUserId TEXT` — deliberate payer assignment (a guardian-linked portal user). Bare id
     (same convention as `actorUserId`), resolved to a name at read time.
   - `billingUpdatedAt TIMESTAMP(3)`, `billingUpdatedById TEXT` — "who last changed billing setup, when"
     (cheap roster display; the full trail lives in the audit table).
2. New table `billing_audit_logs` (`BillingAuditLog`): `id, clubId, memberId?, actorUserId?, action TEXT,
   before JSONB?, after JSONB?, note TEXT?, createdAt`. Append-only; indexes `(clubId, createdAt)`, `(memberId)`.
   EVERY billing mutation writes one row with a before/after diff.
3. New table `membership_reactivations` (`MembershipReactivation`): `id, clubId, memberId, token UNIQUE,
   tokenExpires, offerVersion INT DEFAULT 1, offer JSONB, personalNote TEXT?, status TEXT DEFAULT 'DRAFT'
   (DRAFT|SENT|CONFIRMED|CANCELED|SUPERSEDED), emailSentAt?, emailSendCount INT DEFAULT 0, sentToEmail?,
   viewedAt?, confirmedAt?, confirmedByUserId?, consent JSONB?, memberSubscriptionId?, createdById?,
   createdAt, updatedAt`. Indexes `(clubId, status)`, `(memberId)`.
   `offer` snapshot: `{ membershipId, planName, optionLabel, price, billingPeriod, startDate,
   firstChargeDate, commitmentEndDate, paymentMode: CARD|OFFLINE|FREE, payerUserId? }` — re-read and
   re-validated server-side at confirm; the client never supplies price/dates.

Apply with `npx prisma migrate deploy` (using the main checkout's working `.env`; the worktree copy is
stale) BEFORE the code is pushed/deployed.

## Permission

New `billing` key in `lib/permissions.ts` (`PERMISSION_CATALOG` + `PermissionKey` union +
`DEFAULT_PERMISSIONS: "none"`), levels `none|view|full`. Owners bypass (existing `requirePermission`
behavior). Staff editor UI picks it up automatically from the catalog. Money-mutating routes
(billing-admin PATCH/actions, payment methods, reactivation create/send, migration **approve**, and the
billing fields of the migration PATCH) now require `billing`; read surfaces require `billing:view`.
Group/triage fields on the migration PATCH stay `members:edit` (operational, never charge).

## New lib modules

- `lib/billingAdmin.ts` — pure + server helpers: group/action constants, `deriveReadiness()`
  (READY | WAITING_OWNER | WAITING_CLIENT | HOLD | LEAVE_ALONE + reasons), `chargeTiming(firstChargeDate)`
  (`immediate` vs future + label), `resolveOfferPricing(member, plan)` (extracted precedence: plan option →
  member-selected option → owner override), `pmRef(pmId)` (sha256 16-hex opaque ref so raw Stripe payment-
  method ids are never exposed), `writeBillingAudit()`.
- `lib/reactivation.ts` — `buildOffer(member…)`, `createOrRegenerateReactivation()`,
  `reactivationStatusFor()`, expiry (14 days).

## API surface

Billing control center (`app/api/members/[id]/billing-admin/…`):
- `GET route.ts` (billing:view) — the full per-athlete panel: identity, guardians + payer, plan/option/
  price/frequency, membership + start/next-billing/anchor/commitment dates, internal billing mode
  (STRIPE_RECURRING | MANUAL | FREE | PENDING_ACTIVATION | PENDING_APPROVAL | INCOMPLETE | CANCELED | NONE),
  all `MemberSubscription`s with Stripe snapshot (cached; `?refresh=1` re-reads the one linked Stripe sub,
  read-only), last successful payment, saved payment-method summaries for BOTH customers (brand, last4,
  exp, cardholder, wallet/Link, which guardian owns it, opaque `ref`), charge-timing preview, activation
  email + reactivation status, `billingUpdatedBy/At`, merged history (BillingAuditLog + MemberMigrationEvent).
  No raw Stripe ids in the payload.
- `PATCH route.ts` (billing:full) — plan / option / price override / frequency / start / anchor /
  commitment / group fields / final billing date / responsible payer / mark-free. Supports `preview: true`
  → returns `{before, after}` diff WITHOUT writing (drives the confirm dialog); real write stamps
  `billingUpdatedAt/ById` + audit row. Never touches Stripe.
- `POST actions/route.ts` (billing:full) — discrete confirmed actions:
  `cancel_pending_activation` (invalidate token, approvalStatus→null, status back to IMPORTED unless
  COMPLETED; history preserved), `reassign_subscription` (MANUAL/pending subs only — live Stripe subs are
  blocked with an explanation), each with audit.

Payment methods (`app/api/members/[id]/payment-methods/…`):
- `GET route.ts` (billing:view) — list PMs across `stripeSetupCustomerId` + `stripeCustomerId` (dedup by
  fingerprint), each `{ref, type card|link, brand, last4, expMonth/Year, cardholder, isDefault, customerRole,
  usedByLiveSubscription, ownerName}`.
- `POST setup/route.ts` (billing:full) — owner-initiated **setup-mode Stripe Checkout** on the connected
  account (`metadata.saveCardMemberId` so the EXISTING webhook capture branch stores the PM — no webhook
  change), `success_url` back to the billing page. Card entry happens only on Stripe-hosted UI.
- `POST make-default/route.ts` (billing:full) — the REPLACE confirm step: body `{ref}`; verifies the PM is
  attached, shows-then-sets customer default + live subscription `default_payment_method`. Old card is NOT
  detached here.
- `POST remove/route.ts` (billing:full) — safety-gated removal: blocked when the PM backs a live/trialing/
  past_due subscription or a pending activation with no replacement; otherwise detach + clear member
  pointer fields; audit. Payment/invoice history untouched.

Reactivation (`app/api/members/[id]/reactivation/…` + public `app/api/reactivate/[token]/…`):
- `POST reactivation` (billing:full) — build server-side offer snapshot; REQUIRES an explicit future (or
  explicitly-acknowledged today) `firstChargeDate`; supersedes any open offer; new token.
- `GET reactivation` (billing:view) — offer + consent history. `GET reactivation/preview` — rendered email
  HTML + page URL for the owner preview modal.
- `POST reactivation/send` (billing:full) — sends `sendMembershipReactivationEmail` (club-branded,
  membership details, explicit charge timing, optional personal note block, support + security copy);
  marks SENT, audit.
- Public `GET /api/reactivate/[token]` — token+expiry validated; returns offer, club branding, athlete,
  payer, saved-card summary, personal note, terms; stamps `viewedAt`.
- Public `POST /api/reactivate/[token]/payment-setup` — setup-mode Checkout for the no-card path
  (same webhook capture), success back to the reactivate page.
- Public `POST /api/reactivate/[token]/confirm` — re-reads the offer server-side; validates token, status,
  intended athlete/payer; **preflights `customerHasLiveSub`** on both customer ids; requires captured PM
  (unless FREE/OFFLINE offer → MANUAL sub); if `firstChargeDate <= now` requires
  `acknowledgeImmediateCharge: true` else 409; claims the offer atomically (`updateMany` status guard) and
  creates the Stripe subscription with `trial_end` = future anchor and idempotency key
  `aox-reactivation-<id>-v<offerVersion>`; records consent `{at, email, offerVersion, ip, userAgent}`;
  completes token; sets member ACTIVE/APPROVED/COMPLETED; writes audit + migration event; sends
  confirmation email. Refresh/double-click safe (status claim + Stripe idempotency key).

Hardening of the existing approve route (`/api/members/migration/[id]/approve`):
- gate on `billing` (was `members:edit`);
- add a Stripe idempotency key (`aox-migration-approve-<memberId>` — closes the double-submit fork gap);
- past/today anchor now requires explicit `confirmImmediateCharge: true` (409 `IMMEDIATE_CHARGE_CONFIRM_REQUIRED`
  otherwise) instead of silently charging now — per the "force a new explicit future date" rule.

## UI

- **`/dashboard/members/[id]/billing`** — the control center page (owner desktop + 375px mobile): summary
  card set (athlete/guardians/payer, membership & pricing, dates & timing, payment methods, Stripe state,
  activation/reactivation status, who-changed-what), edit modal with before/after diff confirm,
  payment-method list with Add / Replace / Remove flows, reactivation composer (date + personal note +
  email preview + send), consent record, merged history timeline. Entry points: member profile page card
  ("Manage billing"), migration Set-up drawer link, duplicates page per-member "Review billing" link
  (+ conflict badge when 2+ dupes both carry memberships/payments — client-side from existing `counts`).
- **Migration roster** — Group chip column + editable group/final action/final date/notes in the drawer;
  readiness indicator column (Ready / Waiting on owner / Waiting on client / Hold / Leave alone) derived
  server-side; new filters (by group, by readiness); CSV export button + PDF export extended with the new
  columns. Classification edits never touch Stripe.
- **`/reactivate/[token]`** — public, club-branded, mobile-first confirmation page: preloads club, athlete,
  membership, price, frequency, start/first-charge/recurring dates, commitment (auto from membership),
  saved card summary, payer, personal note, terms/authorization. Primary button:
  `Confirm membership — first payment <date>`; immediate-charge variant requires an extra explicit
  checkbox and says `…— you will be charged $X today`. No-card path opens Stripe setup Checkout inline.

## Scripts & safeguards

- `scripts/migrate-manual-to-stripe.ts` — add `--members <id|email,…>` allowlist REQUIRED for `--apply`
  (refuses to run apply against everyone without `--i-really-mean-all-eligible`), charge-timing line per
  member, BillingAuditLog row on apply, post-run verification query. Dry-run stays the default.
- NEW `scripts/billing-plan-report.ts` — read-only report of the reviewed plan (group, readiness, final
  date, charge timing, PM status) for every migrating member; `--csv` output. Never writes.
- Separate authorizations stay separate: PM metadata backfill (`backfill-setup-payment-methods.ts`,
  existing), anchor edits (UI/PATCH), subscription creation (approve/confirm/migrate script), missed-amount
  collection (NOT automated — flagged as an owner decision in the report).

## Tests & verification

- `scripts/billing-admin-tests.ts` (tsx, no DB/Stripe): readiness matrix, charge-timing (future/today/past),
  offer pricing precedence, removal-safety decisions, immediate-charge gate, pm-ref opacity, permission
  catalog/billing defaults.
- After each checkpoint: `npx prisma generate && npx tsc --noEmit && npm run build` (delete stale
  `*.tsbuildinfo` if tsc looks suspiciously clean).

## Checkpoints

1. Permissions key + schema + migration SQL + lib modules. 2. Billing-admin + payment-method APIs +
approve hardening. 3. Control center UI + entry points. 4. Roster groups/readiness/filters/export.
5. Reactivation APIs + email + public page + confirm. 6. Scripts, tests, docs, CLAUDE.md update,
migration applied to prod DB.
