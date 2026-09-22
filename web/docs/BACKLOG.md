# AthletixOS / Frog Empire — Backlog

Tick `[x]` when an item is done. Add a one-line note under it if something's left over.
Claude reads this file before every 8am check-in and asks about what's still open.

Rhythm: the human items are **not** on fixed days. Each one is pulled forward when the code
item that needs it comes up. The only two dated items are A1 (overdue) and A2 (Oct 2).

## Next up

- **Julian, do first:** A9 Stripe check (3 trialing subs) + A3 (four minors → guardians). A1/A2 are blocked on B9 — don't touch those records yet. Orson: change his Stripe price by hand before Sep 24 or accept $175
- **Next Claude Code session:** B9 (activate from billing centre) — Julian's call, ahead of everything. Then B14 renewing queue (small), then B11 Events slice 2 on go, B12, B10 slice 2. B2 = flip the flag after A3. Both open decisions settled 2026-09-22 (b → B14; i → B9 first).
- **Julian, to unblock code:** A3 four minors → guardians (then B2 = flip FEATURE_PARENTAL_CONSENT on Netlify)

---

## A — Only Julian can do (billing centre, calls, account work — no code)

- [ ] **A1 · Colton Waite — put him on 3 months Upfront ($450)** · overdue since Sep 8 · BLOCKED by B9
  CORRECTED 2026-09-22: the old three-step recipe was wrong — his $530 row has EXPIRED, so there is nothing
  to "Move to", and the billing-centre Edit writes only a draft. Once B9 ships: billing centre → Activate
  this setup now (final period already paid) → record the $450 offline payment with coversPeriods.

- [ ] **A2 · Wyatt Eastman — put him on 1 Year** · his $0 MANUAL row ends Oct 2 · BLOCKED by B9
  Draft already says "1 Year". Once B9 ships: Activate this setup now with start Oct 3, then record the
  offline payment (amount from Julian's own records — none is in the system).

- [ ] **A3 · Give the four paying minors a guardian with portal access** · blocks B2 COPPA
  André Serra, Jacob Vann, Aylen Grubusic, Clint Dwyer. Verify Jacob's email before sending
  anything. COPPA can't merge until these four have a guardian link.

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

- [ ] **A9 · Three Stripe subscriptions with no recorded payment** (was "five mismatches")
  Jeffrey Clark + Kelly Merrill are soft-deleted (Jul 13/15) — nothing to fix. AJ Dorn ($175),
  Weston Knowlton ($110), Parker Strickland ($75): active Stripe-linked rows with ZERO succeeded
  transactions in AthletixOS. Check each in Stripe: if invoices were paid, the webhook missed
  them (code bug → tell Claude); if unpaid/trialing, the PROSPECT roster label is correct.

## B — Claude Code sessions (priority order; start at the top unless blocked)

- [ ] **B9 · Activate a membership from the billing centre (owner action)** · NEXT — Julian's call 2026-09-22: ahead of A1/A2
  DIAGNOSED 2026-09-22 (PROGRESS.md): not a crash — the billing centre Edit only writes the migration DRAFT on
  Member; nothing owner-side turns it into a MemberSubscription, and nothing owner-side can change a live
  Stripe plan. Colton: draft saved Sep 11, his only sub is the imported $530 row, now EXPIRED. Orson: draft
  says 12mo, live Stripe sub still Monthly $175 (bills Sep 24). Build: "Activate this setup now" in the
  billing centre (no live Stripe row) → creates the sub via /api/members/subscribe logic, audit, recompute;
  "Assign membership" on the profile card; readiness COMPLETED+final-paid → READY. No migration. A1/A2 run
  through this once it ships — DO NOT touch Colton/Wyatt records before then.

- [ ] **B12 · Change a live Stripe membership (subscription replacement)** · own item, after B9
  cancel_at_period_end on the old sub + new sub anchored trial_end = old period end; local mirror; audit.
  Orson is the first case. Stopgap: change his price in the Stripe dashboard before Sep 24.

- [ ] **B13 · One Membership panel (assign / change / dates / record payment / pause / cancel)** · DESIGN FIRST
  "Too hard to change or cancel" = design problem: actions spread over roster menu, profile card, billing
  centre and bulk tool. Write a handoff like events/products, then build. Not started.

- [ ] **B14 · "Renewing this week" roster queue** · Julian chose (b) 2026-09-22
  New `renewingSoon` queue in lib/membersQuery (currentPeriodEnd or endDate within 7 days), roster chip,
  and UPCOMING_RENEWAL_LARGE card href → `/dashboard/members?queue=renewingSoon`. ~1 hour, no migration.

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
  SLICE 2 = collapsible editor (1a/1b) + per-session prices + pricingModel/signupAccess/splitInvoiceWhen
  — carries ONE migration and edits the member register route. Planned, NOT started — Julian says go.
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
_Last reviewed: 2026-09-22 (B9 diagnosed; decisions b + i filed; B12/B13/B14 added)_
