# Verifying §8.6 autopay against a live Stripe subscription

A step-by-step check for turning autopay **off** and then back **on** against one
real subscription — written for John Doe's $5/month, but nothing here is
specific to him.

These are the branches the automated tests cannot reach. `dev-local.sh` blanks
`STRIPE_SECRET_KEY`, so the local suite proved the routing, the gates, the
refusals and the queue, and proved nothing about what Stripe actually does. This
document is that missing half.

**The single thing this is really testing:** that turning autopay off produces a
*handoff* and not a *cancellation*. Everything else is bookkeeping around that
one question.

---

## 0. Baseline — capture this before touching anything

Take these five values first. Every later check is a comparison against them, and
without a baseline "it looks right" is not a finding.

```sql
SELECT id, "memberId", "optionLabel", price, "billingPeriod", "billingType",
       status, "autoRenew", "stripeSubscriptionId", "stripePriceId",
       "currentPeriodEnd", "paidThroughDate", "endDate", "canceledAt"
FROM member_subscriptions
WHERE "stripeSubscriptionId" = 'sub_XXXX';
```

```sql
SELECT id, "firstName", "lastName", status, "membershipId"
FROM members WHERE id = '<memberId from above>';
```

In the **Stripe dashboard** (the club's *connected* account, not the platform
account — switch accounts first or you will be looking at the wrong subscription
list), open the subscription and note:

- **Status** — should be `Active`
- **Next invoice** — date and amount

Write down: subscription id, current period end, member's `status`, the
subscription row's `autoRenew`, and the next-invoice amount.

> **Amount to expect.** The fee passthrough is a flat 2.9% added to the sticker,
> no fixed component (`lib/fees.ts`). A $5.00 membership bills **$5.15**
> (`round(500 × 0.029) = 15¢`). If Stripe shows $5.00, `passProcessingFees` is
> off for this club and every amount below shifts accordingly.

---

## 1. Autopay OFF

Owner path — Billing centre → the `set_autopay` action, or directly:

```
POST /api/members/<memberId>/billing-admin/actions
{ "action": "set_autopay", "confirm": true, "subscriptionId": "<row id>", "autopay": false }
```

The confirm sentence should read like:
*"Autopay off — Stripe will stop after \<date\>. From then the club collects
$5.00 every month by cash or check."* — the **sticker**, $5.00, because that is
what the club now collects by hand. Not $5.15; nobody hands over the card fee.

### What MUST change in Stripe

| Where | Before | After |
|---|---|---|
| Subscription status | `Active` | **still `Active`** |
| Cancellation | none | **"Cancels on \<period end\>"** banner |
| `cancel_at_period_end` | `false` | `true` |

### What must NOT change in Stripe

- **No new invoice.** Check the Invoices tab — the count is unchanged.
- **No charge, no refund.** The Payments tab is unchanged.
- **The subscription is not canceled yet.** If status reads `Canceled` rather
  than `Active — cancels on …`, something called `subscriptions.cancel` instead
  of `update`, and the member has just lost the rest of a period they paid for.
  Stop and say so.
- The customer and the saved card are untouched.

### What MUST change locally

```sql
SELECT "billingType", status, "autoRenew", "stripeSubscriptionId", "stripePriceId",
       "currentPeriodEnd", "paidThroughDate", "canceledAt", notes
FROM member_subscriptions WHERE id = '<row id>';
```

| Column | Expected |
|---|---|
| `billingType` | `MANUAL` |
| `stripeSubscriptionId` | **`NULL`** |
| `stripePriceId` | `NULL` |
| `paidThroughDate` | the period end Stripe just reported |
| `currentPeriodEnd` | same |
| `status` | **`active`** — unchanged |
| `canceledAt` | **`NULL`** — unchanged |
| `autoRenew` | **whatever it was** — unchanged |
| `price` | **unchanged** — the money did not move |

`stripeSubscriptionId` going null is deliberate and is the whole mechanism: when
Stripe finally deletes the subscription at period end, the webhook's
`updateMany` matches **zero rows** instead of stamping this one `canceled`.

### The handoff-vs-cancellation test

This is the check worth doing carefully. Both outcomes leave a subscription in
Stripe that is going away; only one leaves a member who still belongs to the club.

| Signal | Clean handoff ✅ | Cancellation ❌ |
|---|---|---|
| `member_subscriptions.status` | `active` | `canceled` |
| `canceledAt` | `NULL` | a timestamp |
| `billingType` | `MANUAL` | unchanged (`RECURRING`) |
| `members.status` | `ACTIVE` | `INACTIVE` |
| Event kind | `PLAN_CHANGED` | `CANCELED` |
| Member portal | shows the membership, next payment due \<date\> | shows no membership |

```sql
SELECT kind, "fromPlan", "toPlan", "fromAmount", "toAmount", source, detail, at
FROM member_subscription_events
WHERE "memberSubscriptionId" = '<row id>' ORDER BY at DESC LIMIT 3;
```

Expect exactly one new row: `kind = PLAN_CHANGED`, `fromAmount = toAmount`
(nothing about the money changed — only the mechanism), and
`detail = {"autopay":"off","stripeSubscriptionId":"sub_XXXX","endsAt":"…"}`.

**A `CANCELED` row here means the design failed** and churn reporting will count
this member as lost. That is the specific failure this build was shaped to avoid.

```sql
SELECT action, before, after, note, "createdAt" FROM billing_audit_logs
WHERE "memberId" = '<memberId>' ORDER BY "createdAt" DESC LIMIT 2;
```
Expect `AUTOPAY_OFF` with the before/after ids.

### Then wait for the period to roll — this is the real test

Everything above happens in one second. The design's actual claim is about what
happens **at the period end**, when Stripe deletes the subscription and fires
`customer.subscription.deleted`.

On or just after \<period end\>, check:

- Stripe: subscription now `Canceled`. Expected and fine.
- `/dashboard/settings/diagnostics` → the webhook log shows the
  `customer.subscription.deleted` event **received and processed with no error**.
- **The member row is untouched**: `status` still `active`, `canceledAt` still
  `NULL`, `members.status` still `ACTIVE`.

If the member flipped to canceled at period end, the row was still carrying the
Stripe id when the webhook landed — meaning step 1 did not complete its local
write. Check `billing_audit_logs` for an `AUTOPAY_OFF` row; if it is missing, the
Stripe call succeeded and the local write did not, which is the one ordering this
code is built to avoid but is worth confirming.

---

## 2. Autopay ON

### Before you press it — the immediate-charge trap

`trial_end` is what stops the card being charged the moment you flip this. It is
taken from `paidThroughDate ?? currentPeriodEnd`, and **only applied if that date
is more than a minute in the future**. If both are null or in the past, Stripe
charges **immediately** on subscription creation.

After a clean step 1 both are stamped, so an OFF → ON cycle is safe. Confirm it
anyway:

```sql
SELECT "paidThroughDate", "currentPeriodEnd" FROM member_subscriptions WHERE id = '<row id>';
```

If that date has already passed by the time you do step 2, **an immediate $5.15
charge is the correct behaviour** — the covered period genuinely ran out. Decide
whether you want that before pressing, not after.

Then:

```
POST /api/members/<memberId>/billing-admin/actions
{ "action": "set_autopay", "confirm": true, "subscriptionId": "<row id>", "autopay": true }
```

Confirm sentence: *"Autopay on — first card charge $5.15 on \<date\>, then every
month."* — **$5.15 here, not $5.00.** This is the number the card is charged, and
showing one figure while charging another is how a dispute starts. If it says
$5.00, the fee passthrough is off; if it says anything else, stop.

### What MUST appear in Stripe

- A **new subscription**, status **`Trialing`** (not `Active`) — the trial is the
  anchor, not a free period.
- **Trial end = the date from the confirm sentence.**
- Recurring amount **$5.15/month**.
- **Product**: the plan's catalog product, reused — *not* a new throwaway product
  per member. If a new product appears named after the option rather than the
  plan, `ensureMembershipProduct` failed and fell back; harmless, but worth knowing.
- **Metadata**: `memberSubscriptionId`, `memberId`, `clubId`.
- **Default payment method**: the family's existing saved card. It must be one
  already on the customer, not a new one.

### What must NOT appear

- **No invoice, no charge today.** If a paid invoice exists dated today, the
  trial anchor did not apply — check `paidThroughDate` above. This is the only
  step in the whole sequence that can move real money unexpectedly.
- No second subscription. There must be exactly **one** active/trialing
  subscription on this customer. Two means the create ran twice; cancel the
  newer one immediately and note both ids.

### What MUST change locally

| Column | Expected |
|---|---|
| `billingType` | `RECURRING` |
| `stripeSubscriptionId` | the **new** `sub_…` (different from the baseline) |
| `stripePriceId` / `stripeProductId` | populated |
| `stripeStatus` | `trialing` |
| `status` | still `active` |
| `price` | **still 5.00** — the stored price is the sticker; the fee lives only in the Stripe amount |

Event: a second `PLAN_CHANGED` with `detail.autopay = "on"` and the new
subscription id. Audit: `AUTOPAY_ON`.

Between them, the two event rows record **both** Stripe ids, so the history is
recoverable even though only one local row ever existed.

### One behaviour to be aware of

Turning autopay ON sets `autoRenew: true`. That is not a bug — the new Stripe
subscription genuinely will renew, and the local field has to match the Stripe
object rather than contradict it. But if this membership had auto-renew **off**
before (i.e. it was scheduled to end), turning autopay on quietly makes it
continue.

So: check `autoRenew` in your baseline. If it was `false`, set it back
afterwards with `set_auto_renew`, which maps to `cancel_at_period_end` and will
show as "Cancels on …" in Stripe. Whether the ON path should instead refuse, or
preserve the old intent automatically, is a decision worth making — flagging it
rather than choosing for you.

---

## 3. If something goes wrong

Nothing here is destructive, and every failure mode leaves you able to reconstruct
the state — but the recovery differs by where it broke:

- **Stripe changed, local did not** (audit row missing, Stripe shows "cancels
  on"): the code returns before writing on any Stripe failure, so this means the
  process died mid-request. The subscription is still in Stripe with its id still
  on the row — simply re-run the action.
- **Local changed, Stripe did not**: cannot happen on the OFF path — the Stripe
  call is first and hard-fails. If you see it, that is a real finding.
- **A charge landed that should not have**: refund it from Stripe, and capture
  `paidThroughDate` / `currentPeriodEnd` from the baseline — the trial anchor is
  the only thing that governs this and those two values explain it entirely.
- **Member shows as churned**: `status` and `canceledAt` on the subscription row,
  then `members.status`. Both are recoverable with an UPDATE, but capture the
  `member_subscription_events` rows first — the wrong event kind is the diagnosis.

Whatever happens, the pair of `member_subscription_events` rows is the record of
what the system believed it was doing. Read those before concluding anything.
