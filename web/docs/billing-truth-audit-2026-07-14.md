# Billing Truth & Reconciliation Audit — 2026-07-14 (Phase 0)

**Read-only audit. No production data, Stripe object, member, subscription, offer, or email was created, modified, canceled, charged, refunded, or sent during this audit.** Sources: production Postgres (Supabase, SELECT-only), Stripe connected account `acct_1Ti19mEIplcCMoSo` (GET-only), current `main` code (worktree branch `claude/athletixos-billing-reliability-3d57df`, fresh off `main` @ `d651d52`).

---

## 1. Transaction-level Stripe vs AthletixOS comparison

**Stripe truth (lifetime of the connected account): exactly 4 succeeded charges, 0 refunds.**

| Date (UTC) | Stripe charge | Customer | Gross | Stripe fee | Net | What it was | In AthletixOS Financials? |
|---|---|---|---|---|---|---|---|
| 2026-07-13 04:54 | `ch_3TsbtBEIplcCMoSo0kxe8Zxc` | John Doe (test) | $5.15 | $0.45 | $4.70 | Reactivation v3 confirm, Jr Frogs $5/mo + fee | **MISSING** |
| 2026-07-14 01:24 | `ch_3Tsv5UEIplcCMoSo0GSKlga1` | Michael Lister | $545.37 | $16.12 | $529.25 | MS/HS "Upfront" quarterly, trial ended | **MISSING** |
| 2026-07-14 20:44 | `ch_3TtDBkEIplcCMoSo10QguspH` | John Doe (test) | $1.03 | $0.33 | $0.70 | One-time "Test/Monthly" checkout | ✅ recorded ($1.03) |
| 2026-07-14 21:43 | `py_3TtE7CEIplcCMoSo0J63y4Hb` | Titus Hall (payer Shannan Hall) | $1,543.50 | $45.06 | $1,498.44 | MS/HS "1 Year" self-serve w/ code `S1B25` | **MISSING** |

Totals: Stripe gross **$2,245.05**, fees **$61.96**, net **$2,183.09**. AthletixOS recorded **$1.03** of it. **$2,094.02 (93%) of real card revenue is missing from Financials**, while **$80.00 of fake "card" revenue (Drayke + Milo) is counted**. Zero local Transactions carry a `stripeInvoiceId`; `platformFee` is null on every row, so every fee/net figure in Financials, Reports, and the Stripe tab is structurally $0/gross.

---

## 2. Root cause #1 — the webhook drops ALL subscription money (systemic)

`app/api/stripe/webhook/route.ts` `invoice.paid` handler:

```ts
const subscriptionId = invoice.subscription as string | null;
if (!subscriptionId) break;               // ← every subscription invoice exits here
```

The Stripe account's webhook events are delivered on API version **`2026-02-25.clover`**. In that shape `invoice.subscription` and `invoice.payment_intent` **no longer exist at the top level** — the subscription id lives at `invoice.parent.subscription_details.subscription` (verified in the stored payloads of all three dropped events), and the payment intent lives under `invoice.payments`. So the handler breaks on the first line for **every** subscription invoice, silently (`processed=true`, no error). The member-resolution metadata it needs (`memberId`, `memberSubscriptionId`, `clubId`) is present in every payload — the handler just reads a dead field.

Consequences, all confirmed in production:
- $5.15, $545.37, $1,543.50 invoice payments have no Transaction rows.
- `invoice.payment_failed` reads the same dead field — dunning/`past_due` handling is also broken.
- Every future renewal (Michael's Oct quarterly, Orson Chorba's ~$195.51 when his trial ends, Titus's 2027 renewal, John Doe's monthly) will also be dropped until fixed.
- No receipt is ever sent for `invoice.paid` (the app sends none; Stripe's own `receipt_email` is null on the charges).

## 3. Root cause #2 — attendance "Card" records fake Stripe-look revenue (Drayke, Milo)

`app/api/attendance/charge/route.ts`: the at-the-door "Card" option (`paymentMethod: "CREDIT"`) creates `Transaction { status: "SUCCEEDED", manual: true }` with **no Stripe ids** — it records an assumption that money was collected on an external reader; it never charges anything.

- Drayke Ulrich: `cmri1nk1q0001lbd9ebs9w392`, $40, 2026-07-12 17:05 UTC, "Card payment — Drayke Ulrich — Sunday Funday".
- Milo Brehm: `cmri1uqca0001j82e5vkgydlo`, $40, 2026-07-12 17:10 UTC.
- No corresponding Stripe object exists (both members have no/unused Stripe customers). No evidence any external payment was collected.
- Financials `summary` counts them: filter is `status="SUCCEEDED"` only, and `isCashMethod` matches CASH/CHECK only → CREDIT lands in **cardIn**, indistinguishable from verified Stripe revenue in every total, report (`cash_vs_card` buckets it "Card / online"), and CSV.
- The **label** fix ("collected outside AthletixOS — no Stripe charge") merged in PR #7 (`439764e`) after these rows were created; the *classification* (SUCCEEDED, counted as card revenue) is unchanged even for new rows.
- Note: Drayke Ulrich has a **duplicate member row** (`cmr7b5u40…` ACTIVATED with a saved card, `cmr7b5yaw…` IMPORTED bare) — flag for the duplicates tool, not for this fix.

Owner decision recorded: take the hit — remove the two $40 "payments" from revenue without deleting history (see correction plan).

## 4. Michael Lister — complete trace, 10 answers

Member `cmr9w9m4o0003aty2oy7mvon9`, Stripe customer `cus_Uq2mEflgKI7Xdd`, one local sub `cmr9wc74h000111ekuff7fxzl` ↔ one Stripe sub `sub_1TqMhGEIplcCMoSoBDwCp2xq`. Self-served checkout Jul 7 00:14 UTC (`cs_live_a1p1xu…`), MS/HS "Upfront" option ($530/quarter per plan options), club 7-day free trial applied (`clubs.freeTrialConfig`, active for MS/HS).

1. **What was the $545.37?** The first *real* charge of his subscription: quarterly price $530 + 2.9% processing-fee passthrough ($15.37; `clubs.passProcessingFees=true`, `recurringUnitWithFee` folds it into the Stripe price). It "came in today" because his **7-day free trial ended** at Jul 14 00:17 UTC = **Jul 13, 7:17 PM local** — hence "around July 13" in Stripe Express. Stripe labels a trial→active cycle charge "Subscription update". Invoice `in_1Tsu95EIplcCMoSoKEmLlg5g`, `billing_reason=subscription_cycle`, line: "1 × MS/HS — Upfront (at $545.37 / every 3 months)".
2. **$530 vs $0:** the member profile reads the `MemberSubscription` row directly (MS/HS · Upfront · $530 · active — correct). The billing center prices via `resolveOfferPricing`, which only reads **migration** config + `member.membershipId`. Michael is self-serve: `member.membershipId` is **NULL** (the checkout flow never set it) and he has no migration fields → it falls to the default "**Continued membership**" at **$0** → "Free".
3. **The $15.37 difference** is exactly the 2.9% fee passthrough. No tax, no proration, no extra line item. (Actual Stripe fee was $16.12 — 2.9% + 30¢ of the grossed-up total — so the club nets $529.25, 75¢ under sticker. Policy decision below.)
4. **Missing from Financials:** root cause #1 (dead `invoice.subscription` field).
5. **"Free / Continued membership" vs "MS/HS Upfront":** answer 2, plus the "Scheduled for activation / trialing" chip comes from the **cached** `stripeStatus` snapshot last synced **Jul 7 22:47** — the sub is actually `active` now. Nothing refreshes snapshots automatically (reconcile is a manual API with no UI/cron caller).
6. **Duplicate local subs?** No — exactly one, correctly linked.
7. **Authoritative:** Stripe `sub_1TqMhG…` (active, $545.37/quarter) mirrored by local `cmr9wc74h…`. Backfill `member.membershipId → MS/HS` so the billing center resolves correctly (one-field correction, needs approval).
8. **Another charge scheduled?** **Yes** — auto-renews quarterly, no `cancel_at`: next **$545.37 around Oct 13–14, 2026**, and every 3 months after. Confirm this matches what "Upfront" was sold as.
9. **Receipt?** **No.** Stripe `receipt_email` is null and the app sends nothing on `invoice.paid`. A Stripe-hosted `receipt_url` exists if you want to forward one manually.
10. **Client billing portal customer?** Correct — resolves `stripeSetupCustomerId ?? stripeCustomerId` = `cus_Uq2m…`, the customer that was charged.

## 5. Titus Hall — the "controlled production test" already happened (today)

At 2026-07-14 21:43 UTC, Shannan Hall completed a **self-serve** MS/HS "1 Year" purchase with discount code `S1B25` ($2,000 − $500): charged **$1,543.50** ($1,500 + 2.9%), Stripe fee $45.06, **net $1,498.44**, annual auto-renew, correct customer (`cus_UpYB…`). Local sub `cmrl6h22a…` created and linked; member ACTIVE; the 3 old placeholder subs were already canceled; no duplicate live sub. So the intended test is **done and structurally healthy**, and it confirmed the exact gaps: **no Transaction row** (root cause #1), **no receipt**, and the staged reactivation offer (v1 DRAFT, first-charge Jul 20) was bypassed — client paid **6 days early** via self-serve. The DRAFT offer is now stale and should be canceled (approval item). Nothing further should be "tested" on Titus.

## 6. Code paths per mismatch

| Symptom | Code path |
|---|---|
| All subscription revenue missing from Financials | `app/api/stripe/webhook/route.ts` `invoice.paid` (`invoice.subscription` dead in API `2026-02-25.clover`); same bug in `invoice.payment_failed` |
| Fees/net always $0 | webhook never expands the charge's `balance_transaction`; `Transaction.platformFee`/`stripeChargeId` never written; financials/reports/Stripe-tab sum a never-written column |
| Fake $40 card revenue | `app/api/attendance/charge/route.ts` CREDIT → SUCCEEDED; `lib/financials.ts isCashMethod` buckets CREDIT into cardIn; `lib/financialReports.ts cash_vs_card` same |
| Billing center "Free/Continued membership" for a paying member | `lib/billingAdmin.ts resolveOfferPricing` is migration-centric; self-serve checkout never sets `member.membershipId` |
| "Trialing / next billing Jul 14 / last payment $0" staleness | `lib/stripeSync.ts` snapshots refresh only on manual `POST /api/stripe/reconcile` (no UI, no cron) |
| No receipt on renewals/first charges | `invoice.paid` handler sends no email; checkout `receipt_email` not set |
| Reconciliation can't recover missing money | `reconcileClubBilling` covers **subscriptions only** — no charges/invoices/refunds, no Transaction backfill |

## 7. Smallest safe correction plan (each step gated on explicit owner approval)

**Code (no data mutation):**
1. **Webhook truth fix** — version-safe extraction (`invoice.parent.subscription_details.subscription ?? invoice.subscription`, payment intent/charge from `payments`/expanded retrieve), apply to `invoice.paid` **and** `invoice.payment_failed`; write `stripeChargeId` + exact `fee`/`net` from the expanded balance transaction; send a receipt email on real (>$0) `invoice.paid`; keep `stripeInvoiceId` dedup. Unit tests over both payload shapes.
2. **Classification fix** — attendance CREDIT rows become payment source `EXTERNAL_CARD`, excluded from *verified Stripe* revenue and shown in their own Financials bucket (never blended into "Card/online").

**Data corrections (allowlisted script, dry-run default, preview + before/after + audit rows; run only after approval):**
3. Backfill the **3 missing Transactions** from their Stripe invoices (dedup by `stripeInvoiceId`; exact gross/fee/net): `in_1TsbtB…` $5.15, `in_1Tsu95…` $545.37, `in_1TtE7B…` $1,543.50.
4. **Void Drayke + Milo $40 rows** (status → CANCELED + explanatory description + BillingAuditLog; rows preserved).
5. Backfill `member.membershipId` for members whose active sub carries one (Michael, +any others found).
6. Cancel Titus's stale DRAFT reactivation offer (status → SUPERSEDED/CANCELED, never deleted).
7. Refresh Stripe snapshots (existing reconcile — read-only refresh of cached status).

## 8. Schema changes required (additive only, one migration)

On `transactions`: `stripeFeeAmount Decimal?`, `netAmount Decimal?`, `paymentSource String?` (STRIPE | CASH | CHECK | EXTERNAL_READER | MANUAL_ADJUSTMENT — derived backfill for existing rows), `reconciliationStatus String?` (VERIFIED | UNVERIFIED | REVIEW | VOID). Optionally a `stripe_charge_reconciliations`-style review table for unmatched Stripe charges / unmatched local card rows (or extend `stripe_reconciliations` with an `objectType`). No destructive change; `platformFee` keeps its AthletixOS-fee meaning.

## 9. Shared services to become authoritative

- `lib/billingTruth.ts` (new): one resolver for *effective plan/price/state per member* that prefers the live `MemberSubscription`+snapshot over migration config (fixes billing-center "Free"), used by billing center, member profile, client portal, approvals, reactivation, migration tool.
- `lib/financials.ts` (extended): single source of payment-source labels + verified/unverified/gross/fee/net definitions, used by Financials, reports, exports, receipts.
- `lib/stripeSync.ts` (extended): subscriptions + charges + invoices + refunds; scheduled refresh; Transaction backfill proposals (review-gated, never auto-write).

## 10. Checkpoint plan (each ends with `npx prisma generate && npx tsc --noEmit && npm run build` + targeted tests)

- **CP1** Webhook truth fix + fee/net capture + receipt + payload-shape tests. *(Deploy ASAP — Orson's trial-end charge is at risk of dropping next.)*
- **CP2** Additive migration (§8) — applied via Supabase MCP before code referencing it deploys.
- **CP3** Reconciliation completion (§9 stripeSync) + read-only owner review UI + gated backfill actions.
- **CP4** Financials/report truth: source buckets, verified vs unverified, real gross/fee/net.
- **CP5** Approved data corrections (§7 items 3–7), one allowlisted script run each, with before/after output.
- **CP6** Phase 1: attendance saved-card charging (PaymentIntent, confirm dialog, idempotency, payment-link fallback, external-reader kept as record-only).
- **CP7** Phase 2: remove Group A/B/C from UI (fields deprecated, hidden; exports updated).
- **CP8** Phase 3: Approvals as the billing review station (reuses billing-admin + reactivation engines).
- **CP9** Phase 4: client change requests on reactivation offers.
- **CP10** Phase 5 verification matrix + Phase 6 docs/handoff.

## 11. Open owner decisions (blocking the respective steps)

1. Approve CP1 webhook fix for immediate build+deploy (code only)?
2. Approve the 3-invoice Transaction backfill allowlist?
3. Approve voiding the two $40 Drayke/Milo rows?
4. Michael: is $545.37/quarter recurring what "Upfront" should mean (next charge ~Oct 13)? Forward his Stripe receipt manually?
5. Cancel Titus's stale DRAFT reactivation offer?
6. Fee-passthrough policy: current formula (2.9%, no 30¢, no gross-up) nets the club slightly under sticker ($529.25 on $530; $1,498.44 on $1,500). Keep, or recover the 30¢/gross-up? Also: surfaces should display "+2.9% processing fee" so $530 vs $545.37 never looks like a discrepancy again.
7. Approve the additive migration (§8)?
