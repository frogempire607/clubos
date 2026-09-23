# AthletixOS / Frog Empire — Backlog

Tick `[x]` when an item is done. Add a one-line note under it if something's left over.
Claude reads this file before every 8am check-in and asks about what's still open.

Rhythm: the human items are **not** on fixed days. Each one is pulled forward when the code
item that needs it comes up. The only two dated items are A1 (overdue) and A2 (Oct 2).

## Next up

- **Julian, do first:** ship B15 (branch/build/push in chat), then A3 (four minors), A2 Wyatt → Paused, Orson profile price 150 + Nov 22 cancel decision, A9 three Stripe checks.
- **Next Claude Code session:** B11 Events slice 2 (go given 2026-09-23; money answer in chat first), then B14, B12 (Orson worked example; inside AthletixOS only), B10 slice 2. B2 = flip the flag after A3.
- **Julian, to unblock code:** A3 four minors → guardians (then B2 = flip FEATURE_PARENTAL_CONSENT on Netlify)

---

## A — Only Julian can do (billing centre, calls, account work — no code)

- [x] **A1 · Colton Waite** · DONE 2026-09-23 via B9 — Stripe sub `sub_1UIrbnEIplcCMoSoCit2bU6q`, 3 months
  Upfront $450 quarterly, charged Sep 23, ends Dec 10, non-renewing. Member ACTIVE. Verified in DB.
  Small follow-up (not urgent): row's minimumTermEndsAt is Dec 23 (3 contract months from today) while
  endDate is Dec 10 — the term floor should never exceed the end. Cap it at endDate in activate_card.

- [ ] **A2 · Wyatt Eastman — mark him PAUSED (taking a break, will renew on return)** · not a payment task
  Profile → Edit → Status → **Paused** → Save. PAUSED is owner-controlled and sticky: when his $0 row
  expires on Oct 2 the recompute leaves him Paused, not Inactive. He shows under the roster's Paused
  filter. A return DATE has nowhere to live yet — see B14 decision.

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

- [ ] **A5 · Reprice Girls MS/HS and Girls Jr Frogs**
  Both plans currently have zero subscriptions.

- [ ] **A6 · Comps: Barrett David, Paul Ortega; activate then comp Devin Eggleston**

- [ ] **A7 · Fix three date problems**
  Riley Bergen: null end date. Skylor Day: dates disagree with Stripe. Titus Hall: bills past
  his intended end.

- [ ] **A8 · ~17 members training unbilled**
  Decide each one: bill, comp, or trial/drop-in.

- [ ] **A9 · Stripe check** · 2026-09-23: Kellan is $450 in Stripe (overcharge reimbursed in cash by Julian); Jacob paid, year runs; Levi renewing soon. Remaining: the local "trialing" labels are stale until B12's sync; the five status↔subscription mismatches below.
  Kellan Lister `sub_1TqMhGEIplcCMoSoBDwCp2xq` (Stripe last synced Jul 7 at $545.37/qtr = $530 base; row
  says $450 "Upfront"); Jacob Vann `sub_1U4INfEIplcCMoSoPkZNCC8i` (1 year $1,500, first charge was due
  Aug 16, row still "trialing", endDate Aug 13 2027 but autoRenew true); Levi Schanzenbach
  `sub_1TvhawEIplcCMoSo3NnrLnhG` (row canceled Sep 18 — confirm Stripe agrees and is not still billing).
  Also the older five status↔subscription mismatches (Jeffrey Clark, Kelly Merrill, AJ Dorn, Weston
  Knowlton, Parker Strickland) — re-check after B1.

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

- [ ] **B12 · Change a live Stripe membership (plan change + commitment) from inside AthletixOS** · own item, after B14
  WORKED EXAMPLE — Orson Chorba: wanted 12-month commitment at $150. On 2026-09-22 Julian changed the price by
  hand in Stripe (sub_1TsknzEIplcCMoSozcu32ldG). Everything that left open is B12's scope:
  1. Local record didn't follow: row still says Monthly $175. The webhook skips CONNECT subscription.updated
     and lib/stripeSync refreshes stripePriceId/status/snapshot but never `price`/`optionLabel`/`optionId`;
     nothing in the UI even runs that sync. Fix: reconciler mirrors price + option; a "Sync from Stripe" action.
  2. The commitment isn't recorded anywhere (minimumTermEndsAt null) — Stripe only knows amount + interval.
  3. Julian could NOT reach the connected account's customers from the platform dashboard (Express has no
     Customers tab) → B12 must do the whole change from AthletixOS: pick option → preview (what changes, when,
     proration) → confirm → Stripe update (price swap at period end, or cancel_at_period_end + new sub anchored
     trial_end = old period end) → local mirror + minimumTermEndsAt + audit.
  Until then: fix the local price on the profile (Current membership → Edit → Price; local-only PATCH).

- [ ] **B13 · One Membership panel (assign / change / dates / record payment / pause / cancel)** · DESIGN FIRST
  "Too hard to change or cancel" = design problem: actions spread over roster menu, profile card, billing
  centre and bulk tool. Write a handoff like events/products, then build. Not started.

- [ ] **B14 · "Renewing this week" roster queue** · Julian chose (b) 2026-09-22 · waits for events slice 2
  New `renewingSoon` queue in lib/membersQuery (currentPeriodEnd or endDate within 7 days), roster chip,
  and UPCOMING_RENEWAL_LARGE card href → `/dashboard/members?queue=renewingSoon`. ~1 hour, no migration.
  Julian 2026-09-23: (a) — a "Paused" card in the same strip, no date, no migration. `pausedUntil` goes
  to B13 when the Membership panel lands.

- [x] **B15 · Invite a guardian to create a parent account (owner action)** · SHIPPED 2026-09-23 on main (d09e7e4)
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

- [ ] **B3 · Phase 9 — Family & Group Discounts** · ready, needs a clear run
  Spec merged, all §4.6.12 decisions settled, nothing built. Biggest remaining job — don't
  start it in a gap between other items.

- [x] **B4 · Four dead Action Item links** · SHIPPED 2026-09-14, commit c3dea2a on main
  Done: Financials reads `?tab=` + `?show=` and writes tab back to the URL; Stripe/Offline/Bank got
  the matching toggles; three cards + the Alert now deep-link correctly; guard test added.
  OPEN (Julian decides): UPCOMING_RENEWAL_LARGE still opens the bare roster — no 7-day renewal
  queue exists. (a) point at `?queue=endingSoon` (120-day window), (b) build a `renewingSoon`
  queue, (c) leave bare. Write-up in docs/improvement/PROGRESS.md (2026-09-14, second entry).

- [ ] **B5 · 2.5.12 Reports — mobile + accessibility** · ready

- [ ] **B6 · Phase 4.5 backlog: 13 partial, 16 missing** · needs Capacitor shell
  Mostly the mobile-native layer.

- [ ] **B7 · Phase 8 Steps 6–7 — collapse the two MS/HS plans** · BLOCKED: class "Accepted
  Memberships" must become option-aware first
  Maximus, Chase and Blake need repointing once merged.

- [x] **B8 · Review `claude/elated-noether-46e7d6`** · DONE — branch deleted (confirmed gone 2026-09-22). Was:
  `cd ~/Desktop/clubos && git worktree remove --force web/.claude/worktrees/nifty-pasteur-1ecb47 && git branch -D claude/elated-noether-46e7d6 && git worktree prune`
  then tick. 3 of 5 commits already on main (cherry-picked, byte-identical); the other 2 are a
  duplicate coverage-resolver implementation that main's `8ece3b1`/`b2b94e0` supersede (main is
  further along: loader, QuickAdd chip, charge-route DAY_NOT_INCLUDED, more tests). Write-up in
  docs/improvement/PROGRESS.md (2026-09-14, third entry).

- [ ] **B10 · Products redesign (design handoff)** · SLICE 1 BUILT 2026-09-22, on disk (uncommitted) —
  Julian: `git checkout -b claude/products-slice-1`, then `cd web && npm run test:product-settings &&
  npx tsc --noEmit && npm run build`, commit, push. Slice 1 = typed v2 settings + parser
  (lib/productSettings.ts), editor 2a (variant matrix, tiers, durations, add-ons, questions, photos ×4,
  storefronts), cards 2b, 51 tests. No migration, no API change, buy route untouched.
  Spec: docs/improvement/design_handoff_products/README.md. Slice 1 (no migration): 2a editor with
  structured variants/tiers/durations/add-ons/questions stored as typed JSON in `Product.settings`
  + a parser for today's free-text, and 2b product cards reading the same variant ledger. Then
  2g Sell-by-variant + 2e store detail (one additive migration; merge COPPA first — it gates
  `api/member/products/[id]/buy`), then 2c inventory, then 2d/2f bookings (new model), then
  /p/[slug] + QR. No Phase 9 overlap. Scoping in PROGRESS.md 2026-09-22.

- [ ] **B11 · Event editor + Attendees redesign (design handoff)** · SLICE 1 SHIPPED 2026-09-22
  (merged 0c38253, Netlify live, Julian verified: rows render, Attendees matches Registrations).
  SLICE 2a BUILT 2026-09-23 (on disk): migration `20260923000000_event_pricing_model` (additive, backfilled),
  schema, lib/eventPricingModel.ts (55 tests, `npm run test:event-pricing-model`), events create/PATCH write
  BOTH vocabularies + exclusion rules + sessions keep their ids (409 if a removed session has paid
  registrations), register route DROP_IN + sessionIds[] = per-session purchase via quoteSessions, public
  route/register read signupAccess. Money rule honoured: no existing registration is touched.
  SLICE 2b BUILT 2026-09-23 (on disk, same branch): components/events/EventEditor.tsx replaces EventModal
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

## C — Done, don't resurrect

- [x] Class-time duplicate bug + the `(classId, date)` unique constraint (Phase 10)
- [x] Attendance confirmation when marking a non-member present
- [x] Supabase password rotation and DIRECT_URL repoint
- [x] Phase 9 spec — merged, decisions settled

---
_Last reviewed: 2026-09-23 (B9+B15 shipped; events slice 2a merged, 2b built; A9 mostly clear)_
