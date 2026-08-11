# Feature Spec: Bulk Price Change on a Membership

## What I'm trying to do (plain English)

When I edit a membership's price (e.g. drop MS/HS Monthly from $190 to $175), I want a
review screen that lists **every member currently on that plan**, shows what each one
pays today, and lets me **check off which members get the new price**. Members I skip
keep their current price as a per-person override. Everyone stays on the same membership
either way.

The screen must handle two kinds of members differently:

1. **Stripe month-to-month members** — just move them to the new price; Stripe bills the
   new amount next cycle. No refund math.
2. **Offline / cash upfront members** — they already paid a lump sum for a period. Show
   the new price AND a computed credit/refund line ("credit owed: $X") based on unused
   time remaining. If they're already marked paid, do NOT change their paid status —
   just display the new price and the credit figure.

---

## How the data actually works (verified against production)

- `memberships.options` is JSON, e.g. for MS/HS:
  `[{"label":"Monthly","price":190,"billingPeriod":"MONTHLY"}, {"label":"Upfront","price":530,"billingPeriod":"QUARTERLY"}, {"label":"1 Year","price":2000,"billingPeriod":"ANNUAL"}]`
- Each subscriber's billed price is copied onto **`member_subscriptions.price`** — this is
  the source of truth for what a person actually pays. Editing `memberships.options` does
  NOT touch existing subscribers. That's the whole reason a bulk tool is needed.
- Relevant `member_subscriptions` columns:
  `price`, `optionLabel`, `billingPeriod`, `billingType`, `status`,
  `stripeSubscriptionId`, `stripePriceId`, `stripeStatus`, `currentPeriodEnd`,
  `effectiveStartDate` / `startDate`, `endDate`, `autoRenew`.
- **Stripe vs offline test:** treat a subscription as Stripe-billed if
  `stripeSubscriptionId IS NOT NULL`. Otherwise it's offline/cash.
- There is already a **`member_subscription_events`** table with
  `kind`, `fromPlan`, `toPlan`, `fromAmount`, `toAmount`, `actorUserId`, `source`, `detail`
  — every price change MUST write a row here for audit. Use this; don't invent a new table.
- Note: `memberships.stripePriceIds` is currently `{}` (empty). So price changes for the
  offline members are pure DB updates, but the Stripe members will need a Stripe price
  update via the API (see below). Confirm how the current checkout maps a member to a
  Stripe price before assuming.

---

## Build steps

### 1. Backend endpoint: "preview"
`POST /api/memberships/[id]/price-change/preview`
Input: the option label being changed (e.g. "Monthly") + the new price.
Returns a list of affected subscribers, each with:
- memberId, member name, optionLabel
- `currentPrice` (from `member_subscriptions.price`)
- `channel`: "stripe" | "offline" (based on `stripeSubscriptionId`)
- for offline upfront (`billingPeriod` = QUARTERLY/ANNUAL): `creditOwed`, computed as
  `(oldPrice - newPrice) * (daysRemaining / daysInPeriod)`, using `currentPeriodEnd`
  or `endDate` for daysRemaining. Round to cents. Never negative — if newPrice > oldPrice
  on an already-paid upfront member, show "additional due: $X" instead.
- for stripe monthly: no credit, just old → new.

### 2. Frontend: review modal
- Triggered from the membership edit screen when a price field changes.
- Table: checkbox | name | channel badge | current price | new price | credit/due (offline only).
- "Select all Stripe monthly" quick action (those are the safe, no-refund ones).
- Offline upfront rows visually separated so I review each one deliberately.
- Confirm button shows a summary: "N members updated, total credits owed $X".

### 3. Backend endpoint: "apply"
`POST /api/memberships/[id]/price-change/apply`
Input: array of memberSubscriptionIds to update + the new price.
For each selected subscription, in a transaction:
- update `member_subscriptions.price` to the new price
- write a `member_subscription_events` row (`kind: "PRICE_CHANGE"`, from/to amount, actor = me, source = "bulk_price_change")
- **Stripe members:** call Stripe to update the subscription's price so the next invoice
  is correct. **Verify rather than trust** — after the Stripe call, read the subscription
  back and confirm the new price is live before marking the DB row done. If Stripe fails,
  roll back that row and report it; don't leave DB and Stripe out of sync.
- **Offline members:** DB update only. Do NOT flip paid status. The credit figure is
  recorded in the event row's `detail` for the refund/credit report — it does not
  auto-issue money.

### 4. Guardrails (important — verify rather than trust)
- Dry-run / preview must never write.
- The apply endpoint should be idempotent-safe: re-running with the same input shouldn't
  double-charge or double-credit.
- Log every change to `member_subscription_events` so I have a full audit trail.
- Do NOT touch `memberships.options` and the per-member prices in the same silent step —
  update the plan's option price separately and explicitly.

---

## Open questions for Claude Code to answer before writing code
1. How does the current checkout flow map a member to a Stripe price given
   `memberships.stripePriceIds` is empty? Is price passed inline per-subscription?
   This determines exactly what the Stripe update call looks like.
2. What populates `member_subscriptions.currentPeriodEnd` / `endDate` for offline upfront
   members — is it reliably set at purchase? The credit math depends on it.
3. Is there an existing refund/credit report where the offline credit figures should surface?

Answer these first, then implement. Start with the preview endpoint and the modal (read-only,
zero risk), let me eyeball it against real members, and only then wire up apply.
