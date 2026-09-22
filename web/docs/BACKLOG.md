# AthletixOS / Frog Empire — Backlog

Tick `[x]` when an item is done. Add a one-line note under it if something's left over.
Claude reads this file before every 8am check-in and asks about what's still open.

Rhythm: the human items are **not** on fixed days. Each one is pulled forward when the code
item that needs it comes up. The only two dated items are A1 (overdue) and A2 (Oct 2).

## Next up

- **Julian, do first:** A1 Colton Waite (overdue since Sep 8) · then A2 Wyatt Eastman by Oct 2
- **Next Claude Code session:** Julian's pick between B3 Phase 9 (clear run) and B10 Products slice 1 (unblocked, no migration). B11 Events waits. B2 blocked by A3; B8 waiting on Julian's `git branch -D`. Julian still owes: UPCOMING_RENEWAL_LARGE link (B4), where B9 slots
- **Julian, to unblock code:** A3 four minors → guardians (blocks B2 COPPA)

---

## A — Only Julian can do (billing centre, calls, account work — no code)

- [ ] **A1 · Colton Waite — fix the overdue term** · due Sep 8 (overdue) · unblocks B9
  Three steps in the billing centre, correcting in place (never cancel-and-recreate):
  1. Edit → re-freeze the right option and clear the $0 override
  2. Bulk price change → "Move to" the right option
  3. Record the offline payment with `coversPeriods`
  The membership his dad asked for was added but never went through — B9 investigates why.

- [ ] **A2 · Wyatt Eastman — same three-step fix** · due Oct 2
  Term ends Oct 2. Same Edit → Move to → record offline payment. His amount is not in the
  system — take it from your own records.

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

- [x] **B1 · Member.status is a label, not an authority** · SHIPPED 2026-09-14, commit 7efbe0e on main
  Done: portal label + profile-switcher derived from subscription rows; `|| member.status`
  removed from both event pricing routes; profile-page fallback pill derived; 12-month
  prospect lapse rule (attendance-based, reclassifies nobody until mid-2027). Write-up in
  docs/improvement/PROGRESS.md (2026-09-14).
  Definitions: **Active** = has a membership. **Prospect** = trialed or attended, no
  membership. **Inactive** = was active and isn't, or a prospect with no return in 12 months.

- [ ] **B2 · COPPA — merge branch `claude/laughing-golick-2b9c76`** · BLOCKED by A3
  Written in July, never merged (migration 20260705010000_parental_consent,
  lib/parentalConsent.ts, guardian-consent routes, ParentalConsentGate).

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

- [ ] **B8 · Review `claude/elated-noether-46e7d6`** · REVIEWED 2026-09-14 — verdict: DELETE. Julian runs:
  `cd ~/Desktop/clubos && git worktree remove --force web/.claude/worktrees/nifty-pasteur-1ecb47 && git branch -D claude/elated-noether-46e7d6 && git worktree prune`
  then tick. 3 of 5 commits already on main (cherry-picked, byte-identical); the other 2 are a
  duplicate coverage-resolver implementation that main's `8ece3b1`/`b2b94e0` supersede (main is
  further along: loader, QuickAdd chip, charge-route DAY_NOT_INCLUDED, more tests). Write-up in
  docs/improvement/PROGRESS.md (2026-09-14, third entry).

- [ ] **B10 · Products redesign (design handoff)** · ready — can start now
  Spec: docs/improvement/design_handoff_products/README.md. Slice 1 (no migration): 2a editor with
  structured variants/tiers/durations/add-ons/questions stored as typed JSON in `Product.settings`
  + a parser for today's free-text, and 2b product cards reading the same variant ledger. Then
  2g Sell-by-variant + 2e store detail (one additive migration; merge COPPA first — it gates
  `api/member/products/[id]/buy`), then 2c inventory, then 2d/2f bookings (new model), then
  /p/[slug] + QR. No Phase 9 overlap. Scoping in PROGRESS.md 2026-09-22.

- [ ] **B11 · Event editor + Attendees redesign (design handoff)** · SLICE 1 ON BRANCH
  `claude/events-attendees-slice-1` @ 1e75b60 (pushed 2026-09-22, tests 42/42 + build green, NOT
  merged — Julian's call when). PR: github.com/frogempire607/clubos/pull/new/claude/events-attendees-slice-1
  Slice 1 = 1e rows (Money/Compact/Cards toggle) + read-only Attendees screen + endpoint; no schema,
  member routes untouched. Slice 2 (editor, per-session prices, migration) waits on COPPA.
  Spec: docs/improvement/design_handoff_event_editor/README.md. First slice when unblocked (no
  migration): 1e event-row money treatments + 1c/1d read-only Attendees list via a new
  `GET /api/events/[id]/attendees` joining Booking + EventRegistration (tables stay separate —
  registration is the money spine). Editor rewrite 1a/1b is slice 2 and needs a migration
  (EventSession.price, pricingModel, signupAccess, splitInvoiceWhen). Scoping in PROGRESS.md.

- [ ] **B9 · Owner-added membership never went through** · BLOCKED by A1 · placement TBD
  Colton's dad asked for a membership, Julian added it in the dashboard, and it never took
  effect. Root-cause the owner add-membership path. Julian decides where this slots in.

## C — Done, don't resurrect

- [x] Class-time duplicate bug + the `(classId, date)` unique constraint (Phase 10)
- [x] Attendance confirmation when marking a non-member present
- [x] Supabase password rotation and DIRECT_URL repoint
- [x] Phase 9 spec — merged, decisions settled

---
_Last reviewed: 2026-09-22 (B11 slice 1 on branch 1e75b60)_
