# AthletixOS / Frog Empire — Backlog

Tick `[x]` when an item is done. Add a one-line note under it if something's left over.
Claude reads this file before every 8am check-in and asks about what's still open.

Rhythm: the human items are **not** on fixed days. Each one is pulled forward when the code
item that needs it comes up. The only two dated items are A1 (overdue) and A2 (Oct 2).

## Next up

- **Julian, do first:** A1 Colton Waite (overdue since Sep 8) · then A2 Wyatt Eastman by Oct 2
- **Next Claude Code session:** B1 is on disk awaiting Julian's build + push → then B4 dead Action Item links (B3 Phase 9 needs a clear run; B2 blocked by A3)
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

- [ ] **B1 · Member.status is a label, not an authority** · CODE ON DISK 2026-09-14 — Julian: run
  `cd ~/Desktop/clubos/web && npx tsx scripts/member-tracks-tests.ts && npx tsc --noEmit && npm run build`,
  then commit + push; tick when live
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

- [ ] **B4 · Four dead Action Item links** · ready
  /dashboard/financials parses no query params (tab is useState): UNRECONCILED_DEPOSIT,
  OFFLINE_PAYMENT_PENDING, UNCATEGORIZED_LARGE_BANK, UPCOMING_RENEWAL_LARGE.

- [ ] **B5 · 2.5.12 Reports — mobile + accessibility** · ready

- [ ] **B6 · Phase 4.5 backlog: 13 partial, 16 missing** · needs Capacitor shell
  Mostly the mobile-native layer.

- [ ] **B7 · Phase 8 Steps 6–7 — collapse the two MS/HS plans** · BLOCKED: class "Accepted
  Memberships" must become option-aware first
  Maximus, Chase and Blake need repointing once merged.

- [ ] **B8 · Review `claude/elated-noether-46e7d6`** · ready
  5 commits never merged, nobody has looked at them. Decide: merge, cherry-pick, or delete.

- [ ] **B9 · Owner-added membership never went through** · BLOCKED by A1 · placement TBD
  Colton's dad asked for a membership, Julian added it in the dashboard, and it never took
  effect. Root-cause the owner add-membership path. Julian decides where this slots in.

## C — Done, don't resurrect

- [x] Class-time duplicate bug + the `(classId, date)` unique constraint (Phase 10)
- [x] Attendance confirmation when marking a non-member present
- [x] Supabase password rotation and DIRECT_URL repoint
- [x] Phase 9 spec — merged, decisions settled

---
_Last reviewed: 2026-09-14 (B1 built)_
