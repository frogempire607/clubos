# Handoff: Membership panel (AthletixOS / clubos) — B13

## Overview

Replaces the **Current membership** card on the member profile (`web/app/dashboard/members/[id]/page.tsx`, the `SubRow` + `EditSubscriptionModal` pair) with one panel that owns every membership action for one athlete:

| Screen | Replaces / adds |
| --- | --- |
| **3a** Membership panel (five states) | `Current membership` card, `SubRow`, the profile's status pill, "Assign membership" link |
| **3b** Assign | roster menu → *Assign membership* (`PurchaseMembershipModal`), billing centre → *Activate this setup now* / *Record payment & renew*, *Create offer* |
| **3c** Change plan | billing centre → *Change plan* (B12, Stripe rows); bulk price tool's per-row option move (offline rows) |
| **3d** Change dates | `EditSubscriptionModal` start/end/paid-through; billing centre Edit's commitment date |
| **3e** Record payment | `EnrollAlreadyPaidCard` ("Already paid?"), `OfflinePaymentsCard` |
| **3f** Pause / Resume | `MemberModals` status dropdown → PAUSED (a label with no date and no Stripe effect) |
| **3g** Cancel | `EditSubscriptionModal` status → canceled; `DELETE /api/members/subscriptions/[subId]` (no button calls it today) |
| **3h** Comp | `CompToggle` in the billing centre's subscriptions list |

### The problem it fixes

"Changing or cancelling a membership is too hard" is not a missing feature — every action above exists. It is a **placement and vocabulary** problem, observed on 2026-09-22 while diagnosing Colton and Orson:

| Today | Where | What it actually writes |
| --- | --- | --- |
| Assign a membership | roster row menu only | `MemberSubscription` (cash) or checkout |
| Edit dates / price / status of a row | profile → Current membership → Edit | local row only; a Stripe row keeps billing its own amount |
| Move offline rows between options | Memberships → bulk price change | local rows; Stripe rows refused |
| Change a Stripe row's plan | billing centre → Change plan (since B12) | Stripe + local |
| Cancel | profile Edit → status "canceled" | local only — Stripe keeps charging. The route that cancels Stripe too is `DELETE`, which nothing calls |
| Pause | Edit member → status PAUSED | a label. No date, no Stripe pause, no resume |
| Set up a future/offline activation | billing centre → Edit → Create offer | a draft, until the **client** confirms |
| Activate the saved setup | billing centre → Activate this setup now (since B9) | Stripe sub or cash row |
| Record cash | billing centre → Already paid? | row + Transaction |

Five screens, six routes, three vocabularies ("subscription", "setup", "offer"), and the screen that looks like the control panel (the billing centre) is mostly a migration draft editor. The owner's first instinct — open the athlete, look at the membership card — lands on the one place that can *edit a row* but cannot *change the membership*.

**One rule for this handoff: the panel says what will happen to Stripe before anything happens.** Every dialog ends with a **consequence line** — "Stripe: price changes at the next invoice, Oct 22. Nothing is charged today." / "Stripe: nothing — this membership is billed offline." / "Stripe: cancels at the period end, Oct 22. No further charges." — computed from the row, never typed. A charge that would run *today* is always behind an explicit checkbox that names the amount (the B9 rule).

The billing centre stays, renamed in the panel's footer link to **Advanced billing** (payment methods, migration triage, reactivation offers, history). Nothing that lives there is removed; the panel simply becomes the front door.

## About the design file

`Membership panel.html` is a **design reference created in HTML** — a self-contained interactive prototype (vanilla JS, no build). **Do not port its structure.** Recreate the designs in the existing clubos environment: Next.js App Router client components, Tailwind v4 with the `@theme` tokens in `web/app/globals.css`, `lucide-react` icons, following the patterns already in `web/app/dashboard/members/[id]/page.tsx`, `web/app/dashboard/members/[id]/billing/page.tsx` (its `CardActivateModal` / `PlanChangeModal` are the closest existing components) and `web/components/members/`.

Every colour in the prototype is a literal copy of a token in `globals.css`; implement with the token (`bg-brand`, `text-text-muted`, `border-app-border`, `var(--color-warn-surface)`…), never the hex.

Open the file in a browser. The state switcher at the top of 3a flips the panel through its five states; every dialog is live — change an option, a date or a payment method and the summary and the consequence line recompute. **The derived copy is the specification.**

## Fidelity

**High-fidelity.** Final copy, spacing, sizes and rules. Phone-first: the panel is a card at 393px; dialogs are bottom sheets on phones and centred modals from `sm:` up; every control is 44px tall on phones.

---

## Screens

### 3a — Membership panel

A single card, `lg:col-span-2` on the profile grid, replacing "Current membership". Four regions:

1. **Headline** — `{plan} · {option}` in 16px/600, then the **state pill** (Active · Paused · Pending · Past due · None — the pill is derived from the active row's `status` + `stripeStatus`, never from `Member.status`). Under it, the **money line** in one sentence, chosen by state:
   - Stripe, renewing: `$154.35 monthly on the saved card · next charge Oct 22`
   - Stripe, ending: `$450 every 3 months · ends Dec 10 — no renewal`
   - Offline: `$175 monthly, paid by cash · paid through Nov 30`
   - Paused: `Paused since Sep 23 · resumes Jan 5` or `Paused since Sep 23 · until you resume it`
   - Pending: `Setup saved — 12 months · $150 monthly · not active yet`
   - Committed: append `· committed through Oct 22, 2027` when `minimumTermEndsAt` is in the future
2. **Facts row** — three or four small cells: **Pays with** (`Visa ····4242` / `Cash / check` / `No card on file`), **Started** (`startDate`), **Renews** (`Yes · auto` / `No — ends {date}`), **Payer** (guardian name when the payer is not the athlete). Each cell is a fact, not an input.
3. **Action row** — the state decides the set (table below). Primary is filled `bg-brand`; the rest are outlined; destructive is red text. On phones the row wraps to two lines; on desktop it is one.
4. **Footer** — `Advanced billing →` (the billing centre) and, when there is history, `Membership history (n)` which expands the existing history rows in place.

| State | Primary | Others | ⋯ menu |
| --- | --- | --- | --- |
| **Active · Stripe** | Change plan | Change dates · Pause · Cancel | Sync from Stripe · Transfer to another athlete · Make it free |
| **Active · offline** | Record payment | Change plan · Change dates · Pause · Cancel | Transfer · Make it free |
| **Paused** | Resume | Change dates · Cancel | Transfer |
| **Pending** (draft/offer/card setup) | Activate now | Send offer · Edit setup (→ Advanced billing) · Cancel setup | — |
| **None** | Assign membership | — | — |
| **Past due** (Stripe) | Retry payment (→ Stripe portal link) | Change plan · Cancel | Sync from Stripe |

Empty state (**None**) shows the athlete's last membership in one grey line if there was one (`Last: MS/HS · Monthly $175 · ended Sep 8`), so "assign" can default to it.

### 3b — Assign (one dialog, three ways to pay)

Header `Assign a membership`. Three cards, top to bottom:

1. **Plan & option** — a select of every active plan's sellable options (`{plan} · {label} — $x {period}{, n-mo commitment}`), pre-selected to the last membership's option when there was one. Under it a derived **terms line**: `$150 monthly · 12-month commitment · then ends` / `· then renews monthly`. **Price override** (collapsed behind "Different price?") shows the option price as placeholder; a $0 override flips the dialog into **3h Comp**.
2. **Starts** — date, default today. When the option carries a commitment the line reads `Committed through {start + months}`.
3. **How they pay** — three exclusive cards:
   - **Saved card** (disabled with reason when there is none: "No card on file — send the offer, or collect a card in Advanced billing") → sub-line **First charge**: `Today — $154.35 charged now` (checkbox required) / a date picker → `Nothing today; first charge {date}`.
   - **Cash / check** → **Amount received** (prefilled option price), **Method** cash/check, **Paid through** (derived: start + one period; editable), **Note**.
   - **Send the offer to the family** → **To** (guardian email prefilled), **Note to the family**. The CTA becomes `Send offer`.

Consequence line per path: `Stripe: creates a subscription on Visa ····4242 — $154.35 today, then monthly. Ends Oct 22, 2027.` / `Stripe: nothing — recorded as a cash membership, paid through Oct 22.` / `Stripe: nothing until the family confirms and pays.`

Backed by: `activate_card` (billing-admin/actions), `POST /api/members/[id]/enroll-paid`, `POST /api/members/[id]/reactivation` + `/send`. **The dialog writes the draft fields the routes read** (`migrationMembershipId`, `migrationSelectedOption`, `migrationPriceOverride`, `billingAnchorDate`, `commitmentEndDate`, `requestedPaymentMethod`) in the same request, so a route that "reads the setup" sees the one the owner just chose — no second Edit step.

### 3c — Change plan

B12's dialog, generalised:

- **Stripe row** → exactly B12 (same-interval options enabled, others disabled with the reason; preview from live Stripe: effective date = period end / trial end, commitment counted from it, auto-renew override, `proration_behavior: none`). A **different-interval** option is no longer a dead end: it becomes a two-step **Switch** — `Ends the current plan on {period end}; starts {option} on the same day, first charge {period end}` — implemented as `cancel_at = period end` on the old sub + a new sub created with `trial_end = period end` on the same card (the mechanism the bulk tool's comment named on 2026-09-22). Both steps run in one action, audited as one.
- **Offline row** → local: the option, price and period change **from the next payment** (`paidThroughDate` untouched), commitment recomputed from that date; consequence `Stripe: nothing — billed offline. Next payment due {paidThrough} at $x.`

### 3d — Change dates

Which dates are editable depends on who bills:

| Row | Start | Paid through | Ends | Commitment |
| --- | --- | --- | --- | --- |
| Stripe | read-only (Stripe owns the cycle) | read-only (`currentPeriodEnd`) | editable → `cancel_at` (clear = renews) | editable (local floor; capped at Ends) |
| Offline | editable | editable | editable | editable |

Consequence: `Stripe: cancel date moves to {date}; charges continue until then.` / `Stripe: nothing.` Clearing **Ends** on a Stripe row says `Stripe: cancel date removed — renews until cancelled.`

### 3e — Record payment (offline rows)

`Amount received` (prefilled: option price, or the outstanding amount when the row is past its paid-through), `Method` cash/check/other, `Covers through` (derived: `paidThrough + one period`, editable, with the sentence `Extends from Nov 30 to Dec 30`), `Note`. Consequence `Stripe: nothing. Records $175 cash and moves paid-through to Dec 30.` Backed by `enroll-paid` (revive/extend) and `offline-payment` (Transaction).

### 3f — Pause / Resume

**Pause**: `Until` — a date, or **"Until I resume it"**. Sentence: `No charges and no access from {today} to {until}. Attendance is still recorded if they show up.` Consequence for Stripe: `Stripe: collection paused (invoices voided) until {until}; resumes automatically.` (`pause_collection: { behavior: "void", resumes_at }`), for offline: `Stripe: nothing. Paid-through moves out by the paused days when you resume.` Writes `pausedAt`, `pausedUntil` on the **row** and sets `Member.status = PAUSED` (the sticky label B1/B14 already honour).

**Resume**: one button, sentence `Resumes today. Next charge {date}.` Clears the pause; for offline rows extends `paidThroughDate` by the paused days (so a family who paid for a month gets a month).

### 3g — Cancel

`When` — **At the end of the paid period** (default; shows the date) / **Right now**. `Reason` chips (Moving · Cost · Injury · Season over · Other) — stored on the event `detail`, optional. Sentence: `{First} keeps access until {date}. No refund is issued from here.` Consequence: `Stripe: cancels at the period end, Oct 22 — no further charges.` / `Stripe: cancelled immediately. The paid period is not refunded.` / `Stripe: nothing — billed offline.` The CTA is red and reads `Cancel membership`. Backed by `DELETE …/subscriptions/[subId]` (immediate) and a new `cancel_at_period_end` path; both record `CANCELED` with `fromPlan`/`fromAmount` (Reports counts churn from this).

### 3h — Comp (make it free)

Reached from ⋯ → *Make it free*, or a $0 override in Assign. One sentence and one checkbox: `{First}'s membership becomes $0, marked as a comp on purpose (not a placeholder). Access is unchanged.` For a Stripe row the consequence is `Stripe: cancels the subscription at the period end; the comp row continues locally.` Writes `deliberateFree: true`, `price: 0`, audit `MEMBERSHIP_COMPED`.

---

## Interactions & rules

- **Consequence line on every dialog**, derived from: row kind (Stripe / offline), the chosen values, and live Stripe facts where the action touches Stripe (period end, trial end, current unit amount — fetched by a preview GET, never cached in the page). It is the last thing above the buttons and is rendered in the info tint (`rgba(109,93,246,.06)` / `.25` border).
- **Money today needs a checkbox** that names the amount (`I understand the saved card is charged $154.35 right now`). Nothing else in the panel is gated.
- **Undo is stated, not implied.** Dialogs whose effect can be reversed say how (`You can resume any time`); those that cannot say so (`This can't be undone from here`).
- **Disabled means explained.** A greyed option or path always carries its reason inline (no card on file; different billing cycle; Stripe not connected; past-due).
- **One vocabulary**: *membership* (what the athlete has), *plan · option* (what they are on), *setup* is retired from owner-facing copy (it survives only in Advanced billing). "Subscription" appears only in Stripe consequence lines.
- **Derived everywhere**: the headline, money line and facts row read the same active row the pill reads; the Assign terms line and the panel's `committed through` read `resolveTerms` / `minimumTermEnd`; every date sentence uses the same formatter (UTC, date-only).
- **Audit**: every commit writes `BillingAuditLog` with a `note` that is the consequence line the owner confirmed, and a `MemberSubscriptionEvent` where the lifecycle changes (CREATED / ACTIVATED / PLAN_CHANGED / PRICE_CHANGE / PAUSED / RESUMED / CANCELED). The panel's history list is those two tables merged, newest first.

## Data changes (one additive migration)

```
member_subscriptions
  pausedAt      TIMESTAMP NULL   -- when the pause began
  pausedUntil   TIMESTAMP NULL   -- null while paused = open-ended
  cancelReason  TEXT NULL        -- the chip, optional
```

`Member.status = PAUSED` stays the roster label (B14 counts it); the row carries the dates. No new tables. Reports' `RENEWING_SOON` and B14's `paused` queue read `pausedUntil` for "resumes in n days".

## API mapping

| Action | Route | Exists? |
| --- | --- | --- |
| Assign · saved card | `POST …/billing-admin/actions` `activate_card` | yes (B9) |
| Assign · cash/check | `POST /api/members/[id]/enroll-paid` | yes |
| Assign · send offer | `POST /api/members/[id]/reactivation` + `/send` | yes |
| Assign · write the draft in the same call | `PATCH /api/members/[id]/billing-admin` | yes — the panel calls it first |
| Change plan · Stripe, same interval | `GET …/plan-change` + `change_stripe_plan` | yes (B12) |
| Change plan · Stripe, different interval | **new** `switch_stripe_plan` (cancel_at + new sub with trial_end) | build |
| Change plan · offline | `PATCH /api/members/subscriptions/[subId]` (+ option/period fields) | extend |
| Change dates | `PATCH …/subscriptions/[subId]`; Stripe `cancel_at` via **new** `set_stripe_cancel_at` | extend + build |
| Record payment | `enroll-paid` / `offline-payment` | yes |
| Pause / Resume | **new** `pause_membership` / `resume_membership` (Stripe `pause_collection`) | build |
| Cancel · at period end | **new** `cancel_at_period_end` | build |
| Cancel · now | `DELETE …/subscriptions/[subId]` | yes |
| Comp | `set_deliberate_free` (+ price 0) | yes (extend) |
| Sync from Stripe | `sync_stripe` | yes (B12) |
| Transfer | `POST /api/member-subscriptions/[id]/transfer` | yes |

## Suggested slices

1. **Panel + Assign + Cancel + Comp** (no migration): 3a's five states reading existing rows; 3b wired to the three existing routes with the draft PATCH folded in; 3g at-period-end (new action) and now (DELETE); 3h. Roster menu *Assign membership* opens 3b. Retire `EditSubscriptionModal` from the profile.
2. **Pause / Resume + Change dates** (the migration): `pausedAt/pausedUntil/cancelReason`; Stripe `pause_collection`; `set_stripe_cancel_at`; offline date edits; B14's Paused queue shows "resumes {date}".
3. **Change plan for everyone**: offline rows (local, from next payment) and the two-step Stripe switch across intervals; the bulk price tool loses its per-row option move.
4. **Cleanup**: billing centre becomes Advanced billing — its pricing card's *Edit* stays for migration drafts; *Activate this setup now* / *Record payment & renew* move into the panel and the billing centre links to them.

## Not in this handoff

Member-facing self-service (the portal's change/cancel requests — those routes exist and keep working; the panel shows a pending request as a banner with Approve/Decline in a later slice). Refunds (Stripe dashboard). Family-wide actions (pause all three kids) — one athlete at a time.
