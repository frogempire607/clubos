# AthletixOS / Frog Empire — Backlog

Tick `[x]` when an item is done. Add a one-line note under it if something's left over.
Claude reads this file before every 8am check-in and asks about what's still open.

Rhythm: the human items are **not** on fixed days. Each one is pulled forward when the code
item that needs it comes up. The only two dated items are A1 (overdue) and A2 (Oct 2).

## Next up

**Start with `docs/HANDOFF.md`** (written 2026-09-24) — the full state: shipped, on disk, Julian's to-do, next session's order.

- **Julian, do first:** ship `claude/events-signin-and-questions` (below), then ask Titus's mom to register again from
  the link (she'll be sent to sign in, then asked weight class + division). Then the production looks from HANDOFF.md
  (panel on Colton / Orson look-only / a cash member / nobody; product tiles), then A3.
- **Deploy rhythm (Netlify credits):** each merge to `main` = 1 production deploy (15 credits). Branch pushes are free.
  Work a phase on ONE branch, push freely, merge to main once per phase. Docs-only merges skip the build (netlify.toml).
- **Check-in order (filed 09-26 from the staff dashboard audit):** B17, B18, B19 MERGED 09-26 → B24 + B20 built 09-26 on
  `claude/b20-renames` → B25 audit which tests really gate the build → B21 staff profiles / B23 mockups → B21 staff profiles → B22 App Store 4.2 (own project,
  gates submission) → B23 Claude Design mockups after B20. Section D below.
- **Next Claude session (after 09-25):** B3 slices 1–2, B10, B13, B16 all built/shipped. B5 and B7 done 09-25. Remaining: B2 (waits on A3); B6 built 09-26 (device regression pass left). Julian: A8 worksheet, duplicates review, A3 guardians.
- **Julian, after that merge:** Finger Lakes → Edit → Roster & entries → "Match rosters to position names" → check the chips → Save.
- **Julian, after shipping B13 slice 3:** try Change plan on one cash member (look at the preview, cancel) and one Stripe
  member picking a different billing cycle (preview only — the switch is real Stripe when confirmed).
- **Julian, to unblock code:** A3 four minors → guardians (then B2 = flip FEATURE_PARENTAL_CONSENT on Netlify)

---

## A — Only Julian can do (billing centre, calls, account work — no code)

- [x] **A1 · Colton Waite** · DONE 2026-09-23 via B9 — Stripe sub `sub_1UIrbnEIplcCMoSoCit2bU6q`, 3 months
  Upfront $450 quarterly, charged Sep 23, ends Dec 10, non-renewing. Member ACTIVE. Verified in DB.
  Small follow-up (not urgent): row's minimumTermEndsAt is Dec 23 (3 contract months from today) while
  endDate is Dec 10 — the term floor should never exceed the end. Cap it at endDate in activate_card.

- [x] **A2 · Wyatt Eastman** · PAUSED 2026-09-23 (taking a break, will renew on return). Row left alone.

- [ ] **A3 · Give the four paying minors a guardian with portal access** · blocks B2 COPPA · steps in chat 2026-09-23
  None of the four guardians has a portal account (checked users table). Clint Dwyer + Aylen Grubusic:
  INVITED, links expired → roster row menu → Resend invitation → parent completes → approve PROFILE ONLY.
  André Serra: **B15** "Invite Luis to create a parent account" on Family & access (luisfilipeserra@hotmail.com,
  no account exists). Jacob Vann: DO NOT use B15 — his dad ALREADY has a portal login, vannjudson@gmail.com
  (last sign-in Aug 18), vouched as guardian of the placeholder record "Judson Vann" instead of Jacob.
  Fix: Jacob → Family & access → Give someone access → search vannjudson@gmail.com → Give access; change
  Jacob's guardian email from jvann@tessy.com to vannjudson@gmail.com; then ARCHIVE the "Judson Vann" member
  record (empty: 0 subs / 0 attendance / 0 payments) — not merge; it is a parent, not a duplicate athlete.

- [ ] **A4 · Call the Lawell family**
  Get the parent's actual name and confirm the email on file is theirs. The account fix
  (rename User to the parent → create guardian link → then null Member.userId → re-sign docs
  as GUARDIAN) waits on this call.

- [x] **A5 · Girls plans repriced** · done 2026-09-23

- [x] **A6 · Comps (Barrett, Paul, Devin)** · done 2026-09-23

- [ ] **A7 · Three date problems** · resolved 2026-09-23, two actions left
  Riley Bergen: cash row, set end date to July 2027 (profile → Current membership → Edit → End date).
  Skylor Day: not returning — billing centre Triage → Leave alone (+note); Stripe sub already canceled, ends Oct 26.
  Titus Hall: leave as is.

- [ ] **A8 · Training unbilled — worksheet delivered 2026-09-23** (unbilled-worksheet.html in chat)
  59 people with a check-in in 90 days and no membership: 21 regulars (A), 8 faded (B), 30 one-offs (C).
  Three choices per person: comp (4 steps today → B13), plan (B9), gone (archive).

- [ ] **A9 · Stripe / status check** · 2026-09-23: everyone clear except AJ Dorn
  AJ Dorn = SELF_GUARDIAN (shape A). Fix = `scripts/fix-family-shapes.ts --only SELF_GUARDIAN` (one member,
  --parent-email adamjdorn@gmail.com --parent-name "Adam J Dorn Sr"), then CHILD_EMAIL for the same id.
  Possible duplicate "Adam Dorn" (imported, DOB 2011-09-15, empty record) — same parent email + phone as
  AJ (DOB 2012-09-15). Confirm the birth year with the dad; if one child → archive the empty record.

## B — Claude Code sessions (priority order; start at the top unless blocked)

- [x] **B9 · Activate a membership from the billing centre (owner action)** · SHIPPED 2026-09-23 on main (2f30dfb, 4959b70, 37386f8); Colton activated through it
  CORRECTED DIAGNOSIS: an owner-side activation DID exist — the "Already paid?" card (lib/enrollPaid.ts,
  since Aug 26) records the cash and creates/revives the MANUAL row. Two real problems: (1) it was
  unfindable — the prominent action, Edit, saves a draft nothing consumes, and the card sat two sections
  down, unconnected to that draft; (2) a genuine bug — reviving an existing row kept its OLD endDate, so
  Colton's revived row (end Sep 8) would have been re-expired by the sweep on the next roster load.
  Built: enrollPaid revive resets endDate/startDate; **Activate this setup now** / **Record payment &
  renew** button on the pricing card, pre-filled from the saved setup (plan, option, amount, commitment
  date; says so when the draft names an option the plan no longer sells); **Assign membership** on the
  profile card (→ billing?enrol=1); readiness no longer says "leave alone" for a COMPLETED migration
  with no active row; "Next billing" comes only from the subscription (Orson's stale Jul 24 gone);
  honest copy under Edit. Tests: scripts/billing-admin-tests.ts (+7, 151 pass), `npm run test:billing-admin`.
  ADDED 2026-09-23 (Julian: "Colton is paying by saved card"): the first cut only handled cash/check. Now
  the button follows the member's payment method — **saved card** → confirm screen (amount incl. fee, first
  charge date, end date) → `activate_card` creates the Stripe subscription off the saved card via
  `lib/cardActivation.ts` (extracted from migration approve, which now calls the same helper); **cash/check**
  → the pre-filled enroll form. Card path refuses: offline members, live Stripe subs (local + live check),
  no saved card, unsellable draft option, $0. Supersedes a $0 offline placeholder row. Spelling: enroll.
  Not in B9: Stripe plan changes (B12), collect-later / pending rows, the single panel (B13).

- [x] **B12 · Change a live Stripe membership (plan change + commitment) from inside AthletixOS** · SHIPPED 5f43b4e
  WORKED EXAMPLE — Orson Chorba (sub_1TsknzEIplcCMoSozcu32ldG): Julian set $150 by hand in Stripe on 09-22; the row
  still says Monthly $175, never synced (stripeSnapshot null). What shipped:
  1. **Sync mirrors price + option.** lib/stripeSync now writes `price` (Stripe unit_amount with the processing fee
     stripped back out when the club passes fees — lib/stripePlanChange.baseFromUnitAmount), `billingPeriod` (from
     the interval), and `optionId`/`optionLabel` (the UNIQUE plan option at that price + period; the row's own option
     is kept if it still matches; no unique match ⇒ optionId cleared, label kept). PRICE_CHANGE / PLAN_CHANGED event +
     `STRIPE_SYNC_MIRRORED` audit when something moved. Nightly reconcile and the button share one code path.
  2. **"Sync from Stripe"** button on every live Stripe-billed row in the billing centre (`sync_stripe` action).
  3. **"Change plan"** on the same rows → picks any recurring option of the SAME billing interval (other cycles listed
     disabled with the reason) → preview from live Stripe values (GET …/billing-admin/plan-change: new charge, effective
     date = current period end / trial end, commitment from that date, end date or "keeps renewing", auto-renew override)
     → confirm → `change_stripe_plan`: ONE `subscriptions.update` (price_data on the plan's catalog product,
     `proration_behavior: none`, `cancel_at` set or cleared) → row mirrored (price/option/plan, minimumTermEndsAt,
     autoRenew, endDate = cancel_at, stripePriceId) → event + `STRIPE_PLAN_CHANGED` audit. Never charges or refunds today.
     Interval changes are refused with the recipe (auto-renew off → ends at period end → activate the new setup).
  Also: `billingPeriodToStripeInterval` learned QUADRIMESTRAL (month/4). Tests: scripts/stripe-plan-change-tests.ts (29).
  For Orson: Sync first (row → $150, option "12 months" since it is the only $150 monthly option), then Change plan →
  "12 months" to stamp the 12-month commitment and the end date (auto-renew default OFF on that option ⇒ ends 12
  months after the next invoice; pick "Keeps renewing" if he should roll on). Fee note: if Julian typed 15000 (not
  15435) into Stripe, the sync reads it as $150 with the fee NOT folded and says so — Change plan re-prices it to
  $150 + fee. Not in B12: new-subscription flow for interval changes, member-facing email on plan change.

- [x] **B13 · One Membership panel (assign / change / dates / record payment / pause / cancel)** · SLICES 1–4 BUILT (slice 4 09-25: Stripe pause drift sync, Paused card "next back", billing page → Advanced billing) · SLICE 1 SHIPPED 80f9b28 ·
  SLICE 2 SHIPPED e621b26 (+ eb106d4, be070cc).
  Handoff: `docs/improvement/design_handoff_membership_panel/`. Slice 2 = migration `20260925000000_membership_pause`
  (`member_subscriptions.pausedAt/pausedUntil/cancelReason`, additive) + **Pause/Resume for real**
  (`lib/membershipPause.ts`: Stripe `pause_collection {behavior: void, resumes_at}` / cleared on resume; offline rows
  get the paused days added back to paidThrough/end on resume; `resumeLapsedPauses` runs with the roster sweep and on
  the panel GET so a dated pause ends itself; Member.status PAUSED kept in step for the B14 queue) + **Change dates**
  (`set_dates` action: Stripe rows move only End → `cancel_at` (clear = renews) and Commitment; offline rows move all
  four; commitment capped at End; rules in `resolveDatesEdit`, tested) + `cancelReason` persisted by
  cancel_at_period_end. Panel: PauseDialog (date / until I resume), Resume confirm with the days returned, DatesDialog;
  the old edit modal is no longer reached from the panel (still on the history rows). Tests 31 → 46.
  Slice 1 recap: panel replacing *Current membership* (`lib/membershipPanel.ts`, `GET …/membership-panel`), Assign
  (card → `activate_card`, cash → `enroll-paid`, offer → reactivation, $0 → comp), Cancel (`cancel_at_period_end` /
  DELETE now / `keep_membership`), Make it free (`comp_membership`), roster Assign → `?assign=1`, Stripe Change plan →
  `billing?changePlan=`.
  SLICE 3 BUILT 2026-09-24 (on disk, no migration): one Change plan for every row — SAME_INTERVAL (B12), SWITCH
  (Stripe, different cycle: new sub on the same card from the period end, old sub cancel_at that day, rollback if step 2
  fails) and OFFLINE (from the next payment, paid-through untouched). `change_plan` action + `kind` on the preview. Bulk
  price tool's per-row move → a Change plan link. Tests 29 → 48 (stripe-plan-change).
  Next: slice 4 = billing centre → Advanced billing; B14 Paused card "resumes {date}" (deferred from slice 2). Decision 2026-09-24: MS/HS
  Monthly stays auto-renew OFF (Julian).

- [x] **B14 · "Renewing this week" queue + "Paused" card** · SHIPPED a417f90
  lib/membersQuery: `renewingSoon` (active row whose currentPeriodEnd / paidThroughDate / endDate lands within
  7 days; Paused excluded) and `paused` (status PAUSED); both counted in the roster strip, which grows from
  4 cards to 6. Financials UPCOMING_RENEWAL_LARGE card → `?queue=renewingSoon`. renewal-surfacing tests +8
  (45 pass; also fixed a stale B4-era assertion there). `pausedUntil` → B13.
- [x] **B15 · Invite a guardian to create a parent account** · shipped d09e7e4, HOTFIX shipped 8d6adbe (JOIN links to COMPLETED members showed "all set" and created nothing — André/Luis).
  `POST /api/members/[id]/invite-guardian` → sendJoinInvite(guardianLogin) → parent-account email variant →
  activation JOIN branch creates the guardian login + CONFIRMED link, no billing. Button on Family & access
  when a minor has a guardian email and no account holder. Refuses if that email already has a login.
  Also in this batch: Colton follow-up (term floor capped at the subscription end in lib/cardActivation).

- [x] **B1 · Member.status is a label, not an authority** · SHIPPED 2026-09-14, commit 7efbe0e on main
  Done: portal label + profile-switcher derived from subscription rows; `|| member.status`
  removed from both event pricing routes; profile-page fallback pill derived; 12-month
  prospect lapse rule (attendance-based, reclassifies nobody until mid-2027). Write-up in
  docs/improvement/PROGRESS.md (2026-09-14).
  Definitions: **Active** = has a membership. **Prospect** = trialed or attended, no
  membership. **Inactive** = was active and isn't, or a prospect with no return in 12 months.

- [ ] **B2 · COPPA — turn it ON** · BLOCKED by A3 (the four minors need guardians first)
  CORRECTION 2026-09-22: COPPA was merged to main on 2026-07-05 as PR #4 (`add3322`) and the
  migration `20260705010000_parental_consent` has been applied in production since 2026-07-05.
  It is flag-gated: `FEATURE_PARENTAL_CONSENT` (lib/parentalConsent.ts) — gates are off until the
  env var is true; recording consent always works. The branch `claude/laughing-golick-2b9c76` is
  an obsolete pre-squash copy (main has rewritten signup since — MINOR_SELF, Aug 16). DELETE IT.
  Remaining work = A3, then set `FEATURE_PARENTAL_CONSENT=true` in Netlify and redeploy.

- [x] **B3 · Phase 9 — Family & Group Discounts** · SLICE 1 SHIPPED (events, be954f3) · SLICE 2 SHIPPED (membership siblings, a69bb33) · SLICE 3 BUILT 09-25 on `claude/b3-group-rates` (club-named membership group rates, receipt discount lines; migration `20261002000000_membership_group_rates`)
  Julian 09-25: events first (Finger Lakes). Sibling = automatic (no code); group rate = same school/team, N+ athletes,
  coach sets it per event (label, number, amount, optional pick-list); coach can also set a $/% discount at approval.
  Deviation from plan.md §9.12 #6 ("memberships only at launch") is Julian's call; the membership half keeps the
  spec's detect-and-recommend rule. Slice 2 note: plan.md §9.0/§9.6 say no live-subscription reprice exists — B12/B13
  built one (`commitAnyPlanChange`), so "apply a recommendation" can go through Change plan.
  Spec merged, all §4.6.12 decisions settled, nothing built. Biggest remaining job — don't
  start it in a gap between other items.

- [x] **B4 · Four dead Action Item links** · SHIPPED 2026-09-14, commit c3dea2a on main
  Done: Financials reads `?tab=` + `?show=` and writes tab back to the URL; Stripe/Offline/Bank got
  the matching toggles; three cards + the Alert now deep-link correctly; guard test added.
  OPEN (Julian decides): UPCOMING_RENEWAL_LARGE still opens the bare roster — no 7-day renewal
  queue exists. (a) point at `?queue=endingSoon` (120-day window), (b) build a `renewingSoon`
  queue, (c) leave bare. Write-up in docs/improvement/PROGRESS.md (2026-09-14, second entry).

- [x] **B5 · 2.5.12 Reports — mobile + accessibility** · BUILT 2026-09-25 on `claude/b5-reports-mobile` (no migration).
  Shared `components/reports/responsive.tsx` (live `useMediaQuery`/`usePhone`, `useBodyScrollLock`, `ScrollTable` =
  momentum scroll + pinned first column + right-edge fade) on every wide table; P&L on phones = one period at a time
  (chip row, label/value rows, tap → drill); P&L drill = full-screen sheet on phones; reliability strip wraps one row
  per section, 44px rows; range sheet locks page scroll, custom dates stacked; KPI 4→2→1 (Unit economics); cash-flow
  waterfall fits 375px; unlayered `@media (pointer: coarse)` rule makes every control in `.reports-touch` ≥ 44×44.
  Bugs fixed: Snapshot bars were labelled a month early in US time zones (`new Date("YYYY-MM-01")` is UTC) and the
  Snapshot/churn bar charts' % heights had no definite parent height. Guard `npm run test:reports-mobile` (58).
  Not done here: a real-device pixel pass at 375/414/768 — needs Julian signed in; I couldn't reach a logged-in browser.
  Same branch: **products** — bulk pricing (`settings.quantityBreaks`, "2+ $35 each", never raises a lower
  member/size price, applied in member buy, public link and front-desk sell) + product photos and event covers load
  for logged-out buyers via `/api/public/media/{product|event}/{ownerId}/{fileId}` (only files that owner uses; IMAGE
  only; club logo on /p now uses the public logo route). Tests `npm run test:product-bulk-pricing` (39).

- [x] **B6 · Phase 4.5 backlog: 13 partial, 16 missing** · BUILT 2026-09-26 (groups 2–4 on `claude/b6-complete`, no migration) — only the on-device Capacitor regression is left (Julian)
  **Group 1 (front desk on a phone) BUILT 2026-09-25** on `claude/front-desk-app` (no migration):
  `/dashboard/front-desk` (today's class auto-picked → search / New walk-in → door rule → Check in · Start free
  trial · drop-in by card on file / cash / check / emailed link / collect later); sticky "Check in · Billing" bar on
  member profiles (phones); "Walk-in" pill FAB on Members (phones); "Desk" replaces Classes in the phone bottom nav.
  **Door rule** `lib/doorAccess.ts` (Julian 09-25): no covering membership → free trial if still available, else
  pay the drop-in. Applied to the QR self check-in too: it now starts the trial or asks for the drop-in
  ("Pay $X now" via Stripe → back to check-in, or "I'll pay cash at the desk" → flagged). Before, anyone without a
  plan was silently checked in as TRIAL for free. Tests `test:door-access` (23).
  **App store prep:** Universal Links / App Links (door QR opens the app), `/.well-known` routes, iOS entitlements,
  Android intent filter, `@capacitor/app` deep-link router, camera/photo permission strings, store badges on /c/.
  Julian's steps: `docs/APP-STORE-LAUNCH.md`. Tests `test:app-links` (14).
  **Groups 2–4 BUILT 2026-09-26** on `claude/b6-complete` (no migration):
  Members list — Filters panel now holds tag / gender / age / custom field (+ chips); family rows collapse (chevron,
  indent, spine; "N more in family" chip on phones); A–Z jump (`?letter=`); bulk "Add tag" (`add_tag`); work-queue
  cards arm the matching bulk action; phone "Needs you" 2-card scroller. Tests `test:members-list-b6` (81).
  Profile — `⋯` menu is a bottom sheet on phones; phone 2×2 facts (Balance · Waiver · Last seen · Migration);
  migration progress card; recent activity; money summary; attendance 3 figures; staff notes stamped with the
  staffer's name (PATCH `appendNote`); 1.55fr/1fr layout; Payments rows → P&L month; account-holder card +
  transfer card on Family & access. Tests `test:member-profile-b6` (54).
  Migration — whose-turn segments, 4 "Needs you" cards, Waiting-on pill, bulk Mark reviewed
  (`/api/members/migration/review`), send result "N sent · M skipped" with reasons + "Fix these N" for undelivered,
  non-blocking Stripe banner, empty-search names the filters + "Did you mean". Fixes select-all/exports ignoring the
  funnel step filter. Tests `test:migration-b6` (56).
  Group 4 — topbar/search/bell/user menu 44px on phones; dark-mode fixes on the step dots.
  Member portal — membership options can carry a description (set per option in Memberships) shown under
  Book now with auto facts (days/visits, commitment, renewal). Tests `test:option-facts` (10).
  Still open: on-device Capacitor regression pass (Julian).

- [x] **B7 · Phase 8 Steps 6–9 — collapse the commitment plans** · DONE 2026-09-25 — steps 6/7/8 applied, step 9 ✓ fully collapsed for both plans (Maximus, Blake → MS/HS; chase → Jr Frogs; both commitment plans active=false, off every class). Code shipped fc15c75 on `claude/b7-option-acceptance`
  (no migration); DATA STEPS are Julian's (dry run → review → --apply, one step per run).
  Unblocker shipped: class "Accepted Memberships" is option-aware — a pricingOptions row may carry `optionIds`
  (absent = every option, so every existing class means what it meant). `lib/acceptedPlans.ts` (pure) +
  `resolveSessionCoverage({acceptedPlans})` → new reason `OPTION_NOT_ACCEPTED` (warns, drop-in quoted), wired through
  coverageQuery (attendance panel, staff charge, member booking), member schedule, and self check-in. Class editor:
  per plan "Every option / Only some" with option checkboxes (shows day limits). Tests `npm run test:accepted-plans` (33).
  `scripts/collapse-membership-plans.ts` now has steps 6 (repoint subs + equal-amount PLAN_CHANGED, Stripe untouched),
  7 (Member.membershipId), 8 (active=false + remove from class/event pricingOptions; refuses while live subs remain),
  9 (verify, read-only). Commitment plans are looked up incl. soft-deleted.
  Live data 09-25: Maximus (12 months $150 → MS/HS opt_3xh5n1p2ax, endDate 2027-08-09 kept), Blake (3 Months $160,
  optionId null → opt_yci81fy0r7, no member pointer), chase (Jr Frogs 3 months $90 → opt_ol0m4moqyy) — chase's plan
  "Jr Frogs Monthly Commitment" was SOFT-DELETED 08-25 while his Stripe sub still pointed at it. Coverage unchanged
  for all three (Step 0 stopgap had the commitment plans on the same classes as their parents).
  Not in scope: Jr Frogs has no "12 months $80" option any more (nobody on it); minimumTermEndsAt is null on all three.

- [x] **B8 · Review `claude/elated-noether-46e7d6`** · DONE — branch deleted (confirmed gone 2026-09-22). Was:
  `cd ~/Desktop/clubos && git worktree remove --force web/.claude/worktrees/nifty-pasteur-1ecb47 && git branch -D claude/elated-noether-46e7d6 && git worktree prune`
  then tick. 3 of 5 commits already on main (cherry-picked, byte-identical); the other 2 are a
  duplicate coverage-resolver implementation that main's `8ece3b1`/`b2b94e0` supersede (main is
  further along: loader, QuickAdd chip, charge-route DAY_NOT_INCLUDED, more tests). Write-up in
  docs/improvement/PROGRESS.md (2026-09-14, third entry).

- [x] **B10 · Products redesign (design handoff)** · SLICE 1 SHIPPED 1ca6d0c · SLICE 2 SHIPPED ed63f9c · SLICE 3 (the rest: 2c inventory, 2d/2f bookings, 2h public page + QR, 11 types, time windows, product money → Financials) BUILT 2026-09-25 on `claude/b10-products-complete`, migration `20261001000000_products_complete`. Was:
  migrate + branch/build/push. Slice 2 = **2g Sell by variant + 2e member store detail**, one additive migration
  `20260924000000_product_sale_variant` (`product_sales.variantId TEXT NULL`). What shipped:
  - `lib/productSettings`: `checkStock` (a product with variants REQUIRES a pick; else the plain count), `unitPriceFor`
    (variant price > member price in the portal > base), `applyVariantSale` (never below 0), `findVariant`, `stockMessage`.
    `lib/productStock.releaseStock` = the ONE write path for units leaving: variant ledger + derived `inventory` in a
    transaction, or the plain count. Tests 51 → 69 (`npm run test:product-settings`).
  - Sell route + member buy route accept `variantId`, price the variant, name the Stripe line "{product} — {variant}",
    store `variantId` on the sale; cash sales release stock at once, Stripe sales when the webhook lands (webhook now
    calls releaseStock too). Member portal buys at `settings.memberPrice` when set (variant price still wins).
  - `GET /api/member/products` + new `GET /api/member/products/[id]` return `lib/productStore.storeView` (photos, member
    price, option groups, per-variant stock/price/status) — no SKUs/thresholds/internal notes leave the dashboard.
  - `app/member/products/[id]/page.tsx` (2e): carousel, member price with struck list price + "Members save $X",
    Buying-for switcher, one picker per option group showing per-value stock (a pick in one group greys out the other
    group's sold-out values), derived banner, quantity stepper clamped to stock, discount code, sticky
    `Checkout · $X` above the bottom nav ("Sold out" / "Pick your options" when it can't). List page → cards link to it.
  - `components/products/SellModal.tsx` (2g): variant tiles with stock (sold-out disabled), member, qty, note,
    discount, Cash/Manual vs Stripe Checkout, Record sale / Generate link. One line per sale; multi-line cart later.
  Julian: `cd web && npx prisma migrate deploy && npx prisma generate` FIRST (tsc shows 5 `variantId` errors until
  generate runs), then `npm run test:product-settings && npm run build`.
  Spec: docs/improvement/design_handoff_products/README.md. Next: 2c inventory, then 2d/2f bookings (new model), then
  /p/[slug] + QR (2h), the 11-type expansion, structured time windows.

- [ ] **B11 · Event editor + Attendees redesign (design handoff)** · SLICE 1 SHIPPED 2026-09-22
  (merged 0c38253, Netlify live, Julian verified: rows render, Attendees matches Registrations).
  SLICE 2a BUILT 2026-09-23 (on disk): migration `20260923000000_event_pricing_model` (additive, backfilled),
  schema, lib/eventPricingModel.ts (55 tests, `npm run test:event-pricing-model`), events create/PATCH write
  BOTH vocabularies + exclusion rules + sessions keep their ids (409 if a removed session has paid
  registrations), register route DROP_IN + sessionIds[] = per-session purchase via quoteSessions, public
  route/register read signupAccess. Money rule honoured: no existing registration is touched.
  SLICE 2a + 2b MERGED (2b = 138139c on main; checked 09-26): components/events/EventEditor.tsx replaces EventModal
  (events page 4,458 → ~3,000 lines): seven collapsible cards with derived summaries, phone sheet /
  desktop 1fr+316px with "What a family sees" preview + conflict panel, pricing-model cards, per-session
  prices on session rows, exclusion rules live, bundle sanity, tournament host/attend sets the model.
  Member portal: "Pick sessions" checklist → per-session registration. Attendees: "2 of 6 sessions".
  Approvals for events are the EXISTING Phase 5 coach-approval settings, now edited in the "Who signs up"
  card — not new. Classes/waitlist are separate (Classes page); not in this handoff.
  No longer waits on COPPA (see B2: COPPA is already on main).
  SLICE 2 PLAN: (1) migration `event_pricing_model`: EventSession.price Decimal?, Event.pricingModel
  (FREE|FIXED|SPLIT, backfilled from variableCostEnabled/prices), Event.signupAccess
  (MEMBERS|PUBLIC_LINK|STAFF_ONLY, backfilled from visibility/purchaseAccess/publicRegistration),
  Event.splitInvoiceWhen + sellIndividualSessions — all additive/backfilled, old columns kept as
  history, `migrate deploy` BEFORE push; (2) lib/eventPricingModel.ts PURE: derive pricingModel /
  signupAccess from old columns and back, exclusion rules (chargeOnApproval ⇒ no CARD, SPLIT/FREE ⇒
  no methods, STAFF_ONLY ⇒ no link), bundle-sanity check, tests; (3) editor 1a/1b as
  components/events/EventEditor.tsx replacing EventModal (4,614-line page shrinks); (4) events API
  create/update accept the new fields, keep writing the old ones; (5) register route: DROP_IN branch
  → per-session purchase (sessionIds[] on the registration's formResponses or a new column),
  isActiveMember unchanged; (6) public /e/[slug] reads signupAccess. ~2 sessions.
  Spec: docs/improvement/design_handoff_event_editor/README.md. First slice when unblocked (no
  migration): 1e event-row money treatments + 1c/1d read-only Attendees list via a new
  `GET /api/events/[id]/attendees` joining Booking + EventRegistration (tables stay separate —
  registration is the money spine). Editor rewrite 1a/1b is slice 2 and needs a migration
  (EventSession.price, pricingModel, signupAccess, splitInvoiceWhen). Scoping in PROGRESS.md.

- [x] **B16 · Event entries: roster positions, multiple entries, generic questions** · SHIPPED 2026-09-25 (ed1ca65 + guest card + positions-per-roster)
  Handoff: `docs/improvement/design_handoff_event_entries/README.md`. Decided: capacity per roster cell, full cell ⇒
  waitlist, same-roster-twice is a per-event toggle, entry price = same each OR separate extra-entry price (coach
  picks), whole-registration approval with proposals, event requests in the main Approvals inbox, discounts via B3,
  public link allowed per event. Slices: (1) approvals inbox + generic question types, (2) roster builder + grid
  PDF/CSV (migration), (3) multiple entries, (4) discounts via B3.
  SLICE 1 BUILT 2026-09-24 on branch `claude/b16-event-entries` (not merged — merge once with slice 2+): event requests
  in the Approvals inbox (approve / decline with reason / link to propose), question-type chips replace sport presets.
  SLICE 2 BUILT 2026-09-25 on the same branch: migration `20260926000000_event_roster_entries` (apply BEFORE the merge),
  roster builder card, spot picker (public + portal), approve re-checks cells, coach grid page + PDF/CSV. 34 tests.
  Migration applied + verified in production 2026-09-25 (3 tables, RLS policy on each, 5 events columns).
  SLICE 3 scope (Julian 2026-09-25): multiple entries + per-entry questions + both entry-price rules + public-link
  toggle + proposals that move/drop an entry, AND:
  - **"Build roster from dropdowns" converts existing registrations too** — each registration whose old dropdown answers
    match a roster cell gets that spot automatically (no-match ones listed under "signed up without a spot"). This is
    what makes Finger Lakes work without anyone re-registering.
  - **Duplicate event, done properly.** The existing ⋯ → Duplicate (`/api/events/[id]/duplicate`) copies the event row
    and sessions only: it drops session prices, the roster, staff, event documents, and leaves signupAccess PUBLIC_LINK
    with no public slug. Fix: copy rosters/positions/capacities, session prices, staff assignments, document links;
    mint a fresh public slug when the source had public signup; open the editor on the copy with name + dates +
    charge date highlighted to change. Never copies registrations, entries or money.
  SLICE 3 BUILT 2026-09-25 on the branch (no migration). B16 is complete — merge to main once. Then: Finger Lakes →
  editor → Roster & entries → "Build the roster from your dropdowns" → capacities → (optional) allow 2 entries → Save. Useful before Finger Lakes (cards charged Nov 14, event Nov 21).

## D — Staff dashboard audit (filed 2026-09-26)

Source: `docs/improvement/staff-dashboard-ia-and-design-audit.md` (1,040 lines, commit 69e4197 on
`claude/ui-design-spree`). Worked in THIS order. Three findings that change the picture:
the Capacitor shell already ships (iOS + Android committed, drawer + bottom nav wired), so phone defects are
live, not future; App Store 4.2 is a configuration problem, not a design one (B22); Edit Staff has a live data bug (B18).

- [x] **B17 · Sport-terms guard scans `lib/`** · MERGED 2026-09-26 (b5276b5 lib/ added + 2f8927d guard now FIRST in
  `npm run build`). Before this the guard was never in the build chain (only `test:phase5` or by hand), so it protected
  nothing for weeks. One live hit had reached production: a stock email template telling every club about weigh-ins,
  seeded into each club on first open of the templates page — code fixed.
  OPEN: the fix changes the template for clubs that haven't opened the page yet; copies ALREADY SEEDED into existing
  clubs keep the old text. Check the saved templates rows for "weigh" and correct them (read-only query first).
  `scripts/sport-terms-guard.ts` SCAN_DIRS = app/dashboard, app/member, app/e, components — `lib/` is not scanned,
  but every nav label lives there (`dashboardNav.ts`) plus `payouts.ts` labels, `permissions.ts` PERMISSION_CATALOG,
  `reportsRevenue.ts` row labels. Add `lib` (comments are already stripped) or an allowlist of copy-bearing files
  (`eventCategories.ts` keeps its existing exception). Must land BEFORE B20.

- [x] **B18 · Edit Staff modal: one save boundary per section** · MERGED 2026-09-26 (6ce92f8) — check live: toggle a lesson
  type then Cancel; edit comp then Save changes. `report:staff-save-damage` looks for damage the old bug already did.
  Was: LIVE BUG (audit §4.2) · verified in code 09-26
  `app/dashboard/staff/page.tsx` EditStaffModal has four write boundaries in one scroll: identity/portal/permissions
  on Save changes (PATCH /api/staff/:id); compensation on its own "Save compensation plan" (:1064); private-lesson
  toggles write IMMEDIATELY (:1112, PATCH /api/private-lessons/types/:id); staff documents on upload.
  Result: Cancel persists lesson toggles; Save changes silently discards an unsaved compensation plan.
  Minimum fix now (before B21): say "saves as you toggle" on lessons, warn/block Save changes when the comp plan is
  dirty (or save both), dirty-state guard on close. Also stop round-tripping dead `appointmentPrice` (:500, :543).

- [x] **B19 · One URL per screen: `purchase-options/*` alias** · MERGED 2026-09-26 (08d3302, tests `test:dashboard-nav`)
  Was: Critical (audit §3.2(1)) · no design
  `app/dashboard/purchase-options/{memberships,privates,products}/page.tsx` re-export the bare pages, so each screen
  is mounted twice. Global search, reportsRevenue drill-downs, classes, calendar and actionCenter link the bare
  path → sidebar shows no active item. Pick one path, redirect the other (next.config), repoint the links;
  products children (`/dashboard/products/inventory|bookings`) must sit under the same parent.

- [x] **B24 · Build-chain follow-up: wire the new checks into `npm run build`** · BUILT 09-26 on `claude/b20-renames`:
  test:staff-comp-draft + test:dashboard-nav added; report:staff-save-damage deliberately left out (DB read).
  Was: · one commit · UNBLOCKED (all three
  branches merged 09-26) · kept out of the three branches on purpose so they didn't each edit the same build line.
  Add `test:staff-comp-draft` (B18) and `test:dashboard-nav` (B19). Decide on `report:staff-save-damage` separately:
  it queries the production database and exits 1 when it finds something, so in the build it would make every deploy
  depend on a DB read and block on a data finding — probably run it once by hand rather than gate on it.

- [ ] **B25 · Audit: which `test:*` scripts actually gate the build** · after B24
  The sport-terms guard was believed to gate the build and didn't. Check every test the backlog/handoffs describe as
  gating. Today `build` runs 4 of 45 `test:*` scripts: sport-terms, subscription-truth, permission-boundary,
  attendance-billing. The group scripts (`test:phase45`, `test:phase5`, `test:phase6`) and every per-feature suite
  (B6, door-access, app-links, accepted-plans, member-duplicates, option-facts, …) run only by hand. For each: in the
  build, deliberately by hand, or dead. Watch the order — `build` runs the tests BEFORE `prisma generate`; suites that
  import `lib/prisma` rely on `postinstall` having generated the client (members-list-b6 exits 1 without it).
  Output: a list, then one commit to the build line. Grep the docs for "gates the build" claims and correct them.

- [x] **B20 · IA renames** · BUILT 09-26 on `claude/b20-renames` (labels only, URLs unchanged; Julian's names):
  "Stripe"/"Payments"/"Payments & billing" → **Member payments**; "Plan & Billing" → **AthletixOS plan** (lives ONLY in
  Settings now — the duplicate plan block on /settings/billing is gone, Stripe checkout/portal return to
  /dashboard/settings?section=plan); App Design / Branded App / Branded mobile app / Branded app editor → **Mobile app**
  (duplicate sidebar link removed; the section links to the editor); diagnostics cards renamed, last "ClubOS" gone;
  /dashboard/schedule → redirect to Staff → Availability; Payroll h1 "Payroll", "Total pay", link to Payouts.
  Full §3.3 menu restructure NOT done — waits for the B23 mockups.
  Was: after B17 (audit §1.2, §3.1, §3.2(2))
  - Plan & Billing (club → AthletixOS) vs "Stripe"/"Payments"/"Payments & billing" (members → club) vs diagnostics'
    "ClubOS billing": two money flows, name each by the job, drop the vendor name; kill the last rendered "ClubOS".
  - App Design / Branded App / Branded mobile app / Branded app editor → one name for `/settings/branded-app`.
  - `/dashboard/schedule` — orphan titled "Staff Schedule" editing the same availability data as
    `/dashboard/staff/availability` → redirect it there.
  - Payroll page `<h1>` says "Payroll & Payouts" and its tile "Total payout" → "Payroll"; add a handoff link from a
    computed figure to "record it" on Payouts. Do not merge the two (calculator vs ledger).

- [ ] **B21 · Staff profiles at `/dashboard/team/[id]` with tabs** · replaces the Edit Staff modal (audit §4.5)
  Model on the member profile: route not modal, `?tab=` in the URL, reuse ProfileTabs, Overview curated.
  Tabs: Overview · Personal info · Access · Pay · Schedule · Lessons · Portal profile · Documents. New
  `lib/staffEditableFields.ts` mirroring `lib/memberEditableFields.ts`. One save boundary per tab, stated in the tab.
  Access gets a plain-words confirm ("Jordan will see every member's payment methods") + write attribution.
  Locked block for password. Keep a light Add-staff modal. Fixes 5 unguarded grids, 10px/11px type on staff pages.

- [ ] **B22 · App Store Guideline 4.2 compliance** · its own project · GATES App Store submission (audit §6)
  Configuration (no design): (a) `server.url` points at the live origin — binary ships no web assets, Airplane Mode
  on first launch shows "Can't reach AthletixOS"; bundle the shell, keep data on /api. (b) one plugin
  (`@capacitor/app`), zero device capabilities, no `plugins` block. (c) `limitsNavigationsToAppBoundDomains: false`.
  (d) camera/photo usage strings declared for features nothing uses natively.
  Interaction: 71 `confirm()`/`alert()` calls → system dialog titled with the hostname → ConfirmDialog for truly
  destructive actions + Undo toast for the rest, and a `no-native-dialogs` guard; hamburger AND tab bar at once,
  25 of 29 destinations drawer-only → one persistent tab bar (never hides on scroll), More = pushed list screen;
  no swipe-back / swipe-to-dismiss / pull-to-refresh anywhere; BackButton is web chrome and its
  `document.referrer` gate jumps home in WKWebView; Android `backButton` unhandled; deep links hard-reload
  (`window.location.href` → `router.push`); splash + status bar + keyboard plugins; 43 bare "Loading…" pages.
  Native feature that answers 4.2 cheapest: **native QR scanner at the door** — door codes (`/c/[id]`),
  Universal Links and the camera permission string already exist; it also justifies NSCameraUsageDescription.
  Next: push notifications (actionCenter already computes the queue), offline check-in, haptics, biometric unlock.
  **Modal primitive:** `DashboardMobileDrawer` is already correct (role="dialog", aria-modal, Escape, backdrop,
  scroll lock) — EXTRACT it as `components/Sheet.tsx` (+ grabber, swipe-to-dismiss) and move the 30 hand-rolled
  modals onto it (only 1 of 30 has role="dialog"). Don't design a new one.
  Folded in from `docs/APP-STORE-LAUNCH.md`: account deletion (member portal has it at /member/profile — confirm
  staff/owner accounts have a path too), in-app link to the privacy policy (athletix-os.com/privacy), reviewer
  demo credentials (test member at Frog Empire), App Review notes explaining the native features.
  Also fail CLOSED when /api/me errors (staff briefly see full nav today); `100vh` → `min-h-dvh`.

- [ ] **B23 · Claude Design mockups** · AFTER B20 lands (audit §9 "What to hand Claude Design")
  Hand over in the `design_handoff_*` format: the §3.3 nav tree, the §4.5 staff profile, §6.6 native navigation,
  Staff Schedule below md (needs 1,070px today — one day or one person at a time), Settings with its own
  layout.tsx, merged Check-in (Attendance + Front desk as one destination, two modes), sidebar child contrast
  (3.79:1 → ≥4.5:1, 13px), `text-brand` in dark mode (3.76:1), `:focus-visible` in the nav, PageHeader on every page.
  Remaining Tier 3 items (audit §9) ride along or get their own lines later.

## C — Done, don't resurrect

- [x] Class-time duplicate bug + the `(classId, date)` unique constraint (Phase 10)
- [x] Attendance confirmation when marking a non-member present
- [x] Supabase password rotation and DIRECT_URL repoint
- [x] Phase 9 spec — merged, decisions settled

---
_Last reviewed: 2026-09-26 (staff dashboard audit filed as B17–B23); before that 2026-09-24 night (events sign-in + questions fix; B10 s2, B12, B13 s1–2 are shipped)_
