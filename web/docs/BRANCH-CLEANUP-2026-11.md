# Branch and worktree clean-up — listed 2026-11-13

Nothing here has been deleted. This is a list plus the exact commands; run them yourself from
`/Users/cubano/Desktop/clubos` when you are ready. "Merged" means every commit on the branch is already in `main`,
so deleting the branch loses nothing. `git branch -d` (lower-case d) refuses to delete anything that is not merged,
which is the safety net — do not swap it for `-D` in section 1.

Order matters: remove worktrees (section 3) before deleting the branch a worktree has checked out.

## 1. Local branches already merged into main (95)

Safe to delete. Branches marked *(worktree)* are checked out in a worktree — do section 3 first.

| Branch | Last commit |
|---|---|
| `claude/approve-fix-event-links` | 2026-10-05 |
| `claude/assign-discounts` | 2026-09-30 |
| `claude/athletixos-accounting-phase-1-94d11d` | 2026-10-20 |
| `claude/athletixos-accounting-phase-2` | 2026-10-21 |
| `claude/athletixos-accounting-phase-3` | 2026-10-21 |
| `claude/athletixos-billing-reliability-3d57df` | 2026-07-14 |
| `claude/athletixos-phase-12-1` *(worktree)* | 2026-10-27 |
| `claude/attendance-non-member-confirm-187fa0` *(worktree)* | 2026-09-13 |
| `claude/attendees-finish` | 2026-09-28 |
| `claude/b10-products-complete` | 2026-09-25 |
| `claude/b11-b23-schedule` | 2026-09-28 |
| `claude/b12-stripe-plan-change` | 2026-09-23 |
| `claude/b13-membership-panel-1` | 2026-09-23 |
| `claude/b13-membership-panel-2` | 2026-09-24 |
| `claude/b13-membership-panel-3` | 2026-09-24 |
| `claude/b14-renewing-paused` | 2026-09-23 |
| `claude/b15-hotfix-join-completed` | 2026-09-23 |
| `claude/b15-invite-guardian` | 2026-09-23 |
| `claude/b16-event-entries` | 2026-09-24 |
| `claude/b20-renames` | 2026-09-26 |
| `claude/b21-staff-profile` | 2026-09-26 |
| `claude/b21-tab-freeze-fix` | 2026-09-26 |
| `claude/b25-build-gates` | 2026-09-28 |
| `claude/b29-event-money` | 2026-09-29 |
| `claude/b3-event-discounts` | 2026-09-25 |
| `claude/b3-group-rates` | 2026-09-25 |
| `claude/b3-membership-sibling` | 2026-09-25 |
| `claude/b5-reports-mobile` | 2026-09-25 |
| `claude/b6-complete` | 2026-09-25 |
| `claude/b7-option-acceptance` | 2026-09-25 |
| `claude/b9-activate-membership` | 2026-09-22 |
| `claude/calendar-discounts-bonuses-6nlTy` | 2026-05-25 |
| `claude/canonical-purchase-option-urls` | 2026-09-26 |
| `claude/card-owners` | 2026-11-03 |
| `claude/deploy-class-staff-tests-fix-910180` | 2026-11-10 |
| `claude/diego-club-slug-lookup-9e9613` | 2026-07-30 |
| `claude/ecstatic-kepler-1ce952` | 2026-05-15 |
| `claude/edit-staff-one-save` | 2026-09-26 |
| `claude/elegant-saha-339455` | 2026-07-02 |
| `claude/event-discount-codes-hyzoqd` | 2026-08-07 |
| `claude/event-payment-decision` | 2026-07-16 |
| `claude/event-scheduler-payroll-docs` | 2026-07-17 |
| `claude/events-attendees-slice-1` | 2026-09-22 |
| `claude/events-public-link` | 2026-09-24 |
| `claude/events-signin-and-questions` | 2026-09-24 |
| `claude/events-slice-2` | 2026-09-23 |
| `claude/fable5-handoff-continuation-e0fc90` | 2026-07-08 |
| `claude/family-discount-spec-69d6c0` | 2026-08-03 |
| `claude/followups-2026-11-b8cd8d` | 2026-11-12 |
| `claude/friendly-tharp-5d3dda` *(worktree)* | 2026-07-04 |
| `claude/front-desk-app` | 2026-09-25 |
| `claude/frosty-snyder-de0748` | 2026-05-24 |
| `claude/funny-meninsky-4488d3` | 2026-07-04 |
| `claude/funny-yonath-aa2f7b` | 2026-07-04 |
| `claude/guard-scan-lib` | 2026-09-25 |
| `claude/guest-saved-card` | 2026-09-25 |
| `claude/membership-pricing-structure-5f7585` | 2026-08-31 |
| `claude/merge-fix-duplicates` | 2026-09-25 |
| `claude/nav-and-pay-reminders` | 2026-09-28 |
| `claude/nifty-bohr-975a5e` | 2026-07-03 |
| `claude/one-billing-panel` | 2026-09-28 |
| `claude/phase-10-class-session-uniqueness` | 2026-09-13 |
| `claude/phase-4-5-members-audit-1e73ba` | 2026-08-09 |
| `claude/phase-4-6-spec-revision-ee1d5c` | 2026-09-09 |
| `claude/phase-4-account-bugs-5a03fa` | 2026-08-03 |
| `claude/phase-5-event-registration-9675fb` | 2026-08-12 |
| `claude/phase-6-safety-integrity-634dea` | 2026-09-09 |
| `claude/phase-9-family-discounts` | 2026-09-10 |
| `claude/plan-md-housekeeping-8pw61h` | 2026-08-07 |
| `claude/pricing-overhaul` | 2026-10-19 |
| `claude/private-share-link` | 2026-10-06 |
| `claude/products-slice-1` | 2026-09-22 |
| `claude/products-slice-2` | 2026-09-23 |
| `claude/rhode-island-super32-registrations-5edcac` *(worktree)* | 2026-08-31 |
| `claude/roster-positions-b13-4` | 2026-09-25 |
| `claude/schedule-visibility-booking-ff2090` | 2026-07-15 |
| `claude/sharp-cohen-59d046` | 2026-08-25 |
| `claude/staff-discount-picker` | 2026-07-15 |
| `claude/staff-scheduling-1` | 2026-10-07 |
| `claude/staff-scheduling-2` | 2026-10-07 |
| `claude/staff-scheduling-3` | 2026-10-07 |
| `claude/staff-security` | 2026-10-07 |
| `claude/status-truth-fixes` | 2026-07-15 |
| `claude/stoic-edison-8828cd` | 2026-07-08 |
| `claude/tadpoles-class-time-bug-c54990` | 2026-09-09 |
| `claude/team-payer` | 2026-10-29 |
| `claude/void-exclusion-sweep` | 2026-07-14 |
| `feat/cx-overhaul` | 2026-06-05 |
| `feat/p1-ui-fixes` | 2026-06-04 |
| `feat/p4-minor-parental-controls` | 2026-06-05 |
| `native-app-shell` | 2026-06-03 |
| `next-feature-round` | 2026-05-27 |
| `rls-tenant-isolation` | 2026-07-02 |
| `security/guardian-link-and-activation-token` | 2026-06-14 |
| `security/hardening-safe-batch` | 2026-06-15 |

Not in a worktree — delete now:

```bash
cd /Users/cubano/Desktop/clubos
git branch -d claude/approve-fix-event-links claude/assign-discounts claude/athletixos-accounting-phase-1-94d11d claude/athletixos-accounting-phase-2 claude/athletixos-accounting-phase-3 claude/athletixos-billing-reliability-3d57df
git branch -d claude/attendees-finish claude/b10-products-complete claude/b11-b23-schedule claude/b12-stripe-plan-change claude/b13-membership-panel-1 claude/b13-membership-panel-2
git branch -d claude/b13-membership-panel-3 claude/b14-renewing-paused claude/b15-hotfix-join-completed claude/b15-invite-guardian claude/b16-event-entries claude/b20-renames
git branch -d claude/b21-staff-profile claude/b21-tab-freeze-fix claude/b25-build-gates claude/b29-event-money claude/b3-event-discounts claude/b3-group-rates
git branch -d claude/b3-membership-sibling claude/b5-reports-mobile claude/b6-complete claude/b7-option-acceptance claude/b9-activate-membership claude/calendar-discounts-bonuses-6nlTy
git branch -d claude/canonical-purchase-option-urls claude/card-owners claude/deploy-class-staff-tests-fix-910180 claude/diego-club-slug-lookup-9e9613 claude/ecstatic-kepler-1ce952 claude/edit-staff-one-save
git branch -d claude/elegant-saha-339455 claude/event-discount-codes-hyzoqd claude/event-payment-decision claude/event-scheduler-payroll-docs claude/events-attendees-slice-1 claude/events-public-link
git branch -d claude/events-signin-and-questions claude/events-slice-2 claude/fable5-handoff-continuation-e0fc90 claude/family-discount-spec-69d6c0 claude/followups-2026-11-b8cd8d claude/front-desk-app
git branch -d claude/frosty-snyder-de0748 claude/funny-meninsky-4488d3 claude/funny-yonath-aa2f7b claude/guard-scan-lib claude/guest-saved-card claude/membership-pricing-structure-5f7585
git branch -d claude/merge-fix-duplicates claude/nav-and-pay-reminders claude/nifty-bohr-975a5e claude/one-billing-panel claude/phase-10-class-session-uniqueness claude/phase-4-5-members-audit-1e73ba
git branch -d claude/phase-4-6-spec-revision-ee1d5c claude/phase-4-account-bugs-5a03fa claude/phase-5-event-registration-9675fb claude/phase-6-safety-integrity-634dea claude/phase-9-family-discounts claude/plan-md-housekeeping-8pw61h
git branch -d claude/pricing-overhaul claude/private-share-link claude/products-slice-1 claude/products-slice-2 claude/roster-positions-b13-4 claude/schedule-visibility-booking-ff2090
git branch -d claude/sharp-cohen-59d046 claude/staff-discount-picker claude/staff-scheduling-1 claude/staff-scheduling-2 claude/staff-scheduling-3 claude/staff-security
git branch -d claude/status-truth-fixes claude/stoic-edison-8828cd claude/tadpoles-class-time-bug-c54990 claude/team-payer claude/void-exclusion-sweep feat/cx-overhaul
git branch -d feat/p1-ui-fixes feat/p4-minor-parental-controls native-app-shell next-feature-round rls-tenant-isolation security/guardian-link-and-activation-token
git branch -d security/hardening-safe-batch
```

In a worktree — after section 3:

```bash
git branch -d claude/athletixos-phase-12-1 claude/attendance-non-member-confirm-187fa0 claude/friendly-tharp-5d3dda claude/rhode-island-super32-registrations-5edcac
```

## 2. Remote (GitHub) branches already merged into main (77)

Safe to delete. This removes them from GitHub; `main` is untouched.

| Branch | Last commit |
|---|---|
| `origin/claude/approve-fix-event-links` | 2026-10-05 |
| `origin/claude/assign-discounts` | 2026-09-30 |
| `origin/claude/athletixos-accounting-phase-1-94d11d` | 2026-10-20 |
| `origin/claude/athletixos-accounting-phase-2` | 2026-10-21 |
| `origin/claude/athletixos-accounting-phase-3` | 2026-10-21 |
| `origin/claude/athletixos-billing-reliability-3d57df` | 2026-07-14 |
| `origin/claude/athletixos-phase-12-1` | 2026-10-27 |
| `origin/claude/attendance-non-member-confirm-187fa0` | 2026-09-13 |
| `origin/claude/attendees-finish` | 2026-09-28 |
| `origin/claude/b10-products-complete` | 2026-09-25 |
| `origin/claude/b11-b23-schedule` | 2026-09-28 |
| `origin/claude/b12-stripe-plan-change` | 2026-09-23 |
| `origin/claude/b13-membership-panel-1` | 2026-09-23 |
| `origin/claude/b13-membership-panel-2` | 2026-09-24 |
| `origin/claude/b13-membership-panel-3` | 2026-09-24 |
| `origin/claude/b14-renewing-paused` | 2026-09-23 |
| `origin/claude/b15-hotfix-join-completed` | 2026-09-23 |
| `origin/claude/b15-invite-guardian` | 2026-09-23 |
| `origin/claude/b16-event-entries` | 2026-09-24 |
| `origin/claude/b20-renames` | 2026-09-26 |
| `origin/claude/b21-staff-profile` | 2026-09-26 |
| `origin/claude/b21-tab-freeze-fix` | 2026-09-26 |
| `origin/claude/b25-build-gates` | 2026-09-28 |
| `origin/claude/b29-event-money` | 2026-09-29 |
| `origin/claude/b3-event-discounts` | 2026-09-25 |
| `origin/claude/b3-group-rates` | 2026-09-25 |
| `origin/claude/b3-membership-sibling` | 2026-09-25 |
| `origin/claude/b5-reports-mobile` | 2026-09-25 |
| `origin/claude/b6-complete` | 2026-09-25 |
| `origin/claude/b7-option-acceptance` | 2026-09-25 |
| `origin/claude/b9-activate-membership` | 2026-09-22 |
| `origin/claude/bulk-price-change-planning-57a9cv` | 2026-08-16 |
| `origin/claude/calendar-discounts-bonuses-6nlTy` | 2026-05-25 |
| `origin/claude/canonical-purchase-option-urls` | 2026-09-26 |
| `origin/claude/edit-staff-one-save` | 2026-09-26 |
| `origin/claude/event-discount-codes-hyzoqd` | 2026-08-07 |
| `origin/claude/event-payment-decision` | 2026-07-16 |
| `origin/claude/event-scheduler-payroll-docs` | 2026-07-17 |
| `origin/claude/events-attendees-slice-1` | 2026-09-22 |
| `origin/claude/events-public-link` | 2026-09-24 |
| `origin/claude/events-signin-and-questions` | 2026-09-24 |
| `origin/claude/events-slice-2` | 2026-09-23 |
| `origin/claude/fable5-handoff-continuation-e0fc90` | 2026-07-08 |
| `origin/claude/frog-empire-invoice-bug-qq3q0i` | 2026-08-03 |
| `origin/claude/front-desk-app` | 2026-09-25 |
| `origin/claude/funny-meninsky-4488d3` | 2026-07-04 |
| `origin/claude/funny-yonath-aa2f7b` | 2026-07-04 |
| `origin/claude/guard-scan-lib` | 2026-09-25 |
| `origin/claude/guest-saved-card` | 2026-09-25 |
| `origin/claude/merge-fix-duplicates` | 2026-09-25 |
| `origin/claude/nav-and-pay-reminders` | 2026-09-28 |
| `origin/claude/one-billing-panel` | 2026-09-28 |
| `origin/claude/phase-10-class-session-uniqueness` | 2026-09-13 |
| `origin/claude/phase-4-5-members-audit-1e73ba` | 2026-08-09 |
| `origin/claude/phase-5-event-registration-9675fb` | 2026-08-12 |
| `origin/claude/phase-6-safety-integrity-634dea` | 2026-09-09 |
| `origin/claude/phase-9-family-discounts` | 2026-09-10 |
| `origin/claude/plan-md-housekeeping-8pw61h` | 2026-08-07 |
| `origin/claude/private-share-link` | 2026-10-06 |
| `origin/claude/products-slice-1` | 2026-09-22 |
| `origin/claude/products-slice-2` | 2026-09-23 |
| `origin/claude/roster-positions-b13-4` | 2026-09-25 |
| `origin/claude/schedule-visibility-booking-ff2090` | 2026-07-15 |
| `origin/claude/sharp-cohen-59d046` | 2026-08-25 |
| `origin/claude/staff-discount-picker` | 2026-07-15 |
| `origin/claude/staff-scheduling-1` | 2026-10-07 |
| `origin/claude/staff-scheduling-2` | 2026-10-07 |
| `origin/claude/staff-scheduling-3` | 2026-10-07 |
| `origin/claude/staff-security` | 2026-10-07 |
| `origin/claude/status-truth-fixes` | 2026-07-15 |
| `origin/claude/stoic-edison-8828cd` | 2026-07-08 |
| `origin/claude/tadpoles-class-time-bug-c54990` | 2026-09-09 |
| `origin/claude/void-exclusion-sweep` | 2026-07-14 |
| `origin/feat/p1-ui-fixes` | 2026-06-04 |
| `origin/feat/p4-minor-parental-controls` | 2026-06-05 |
| `origin/native-app-shell` | 2026-05-29 |
| `origin/next-feature-round` | 2026-05-27 |

```bash
cd /Users/cubano/Desktop/clubos
git push origin --delete claude/approve-fix-event-links claude/assign-discounts claude/athletixos-accounting-phase-1-94d11d claude/athletixos-accounting-phase-2 claude/athletixos-accounting-phase-3
git push origin --delete claude/athletixos-billing-reliability-3d57df claude/athletixos-phase-12-1 claude/attendance-non-member-confirm-187fa0 claude/attendees-finish claude/b10-products-complete
git push origin --delete claude/b11-b23-schedule claude/b12-stripe-plan-change claude/b13-membership-panel-1 claude/b13-membership-panel-2 claude/b13-membership-panel-3
git push origin --delete claude/b14-renewing-paused claude/b15-hotfix-join-completed claude/b15-invite-guardian claude/b16-event-entries claude/b20-renames
git push origin --delete claude/b21-staff-profile claude/b21-tab-freeze-fix claude/b25-build-gates claude/b29-event-money claude/b3-event-discounts
git push origin --delete claude/b3-group-rates claude/b3-membership-sibling claude/b5-reports-mobile claude/b6-complete claude/b7-option-acceptance
git push origin --delete claude/b9-activate-membership claude/bulk-price-change-planning-57a9cv claude/calendar-discounts-bonuses-6nlTy claude/canonical-purchase-option-urls claude/edit-staff-one-save
git push origin --delete claude/event-discount-codes-hyzoqd claude/event-payment-decision claude/event-scheduler-payroll-docs claude/events-attendees-slice-1 claude/events-public-link
git push origin --delete claude/events-signin-and-questions claude/events-slice-2 claude/fable5-handoff-continuation-e0fc90 claude/frog-empire-invoice-bug-qq3q0i claude/front-desk-app
git push origin --delete claude/funny-meninsky-4488d3 claude/funny-yonath-aa2f7b claude/guard-scan-lib claude/guest-saved-card claude/merge-fix-duplicates
git push origin --delete claude/nav-and-pay-reminders claude/one-billing-panel claude/phase-10-class-session-uniqueness claude/phase-4-5-members-audit-1e73ba claude/phase-5-event-registration-9675fb
git push origin --delete claude/phase-6-safety-integrity-634dea claude/phase-9-family-discounts claude/plan-md-housekeeping-8pw61h claude/private-share-link claude/products-slice-1
git push origin --delete claude/products-slice-2 claude/roster-positions-b13-4 claude/schedule-visibility-booking-ff2090 claude/sharp-cohen-59d046 claude/staff-discount-picker
git push origin --delete claude/staff-scheduling-1 claude/staff-scheduling-2 claude/staff-scheduling-3 claude/staff-security claude/status-truth-fixes
git push origin --delete claude/stoic-edison-8828cd claude/tadpoles-class-time-bug-c54990 claude/void-exclusion-sweep feat/p1-ui-fixes feat/p4-minor-parental-controls
git push origin --delete native-app-shell next-feature-round
git fetch --prune origin
```

## 3. Worktrees

| Worktree folder | Branch | Uncommitted files | Verdict |
|---|---|---|---|
| `web/.claude/worktrees/modest-lederberg-114859` | `claude/attendance-non-member-confirm-187fa0` (merged) | 0 | remove |
| `web/.claude/worktrees/phase-4-6-spec-revision-ee1d5c` | `claude/athletixos-phase-12-1` (merged) | 0 | remove |
| `web/.claude/worktrees/elegant-saha-339455` | `claude/friendly-tharp-5d3dda` (merged) | **1** | look first |
| `web/.claude/worktrees/sharp-cohen-59d046` | `claude/rhode-island-super32-registrations-5edcac` (merged) | **7** | look first |
| `web/.claude/worktrees/elastic-wilson-411ecb` | `claude/fix-class-staff-day-test-133550` (NOT merged, Nov 10) | 0 | keep until section 4 is decided |
| `web/.claude/worktrees/followups-2026-11-b8cd8d` | `followups-2026-11` (this work) | — | keep until this branch is merged |

Clean ones:

```bash
cd /Users/cubano/Desktop/clubos
git worktree remove web/.claude/worktrees/modest-lederberg-114859
git worktree remove web/.claude/worktrees/phase-4-6-spec-revision-ee1d5c
```

The two with uncommitted files — look at what is there first. `git worktree remove` refuses while files are
uncommitted, so nothing is lost by trying it:

```bash
git -C web/.claude/worktrees/elegant-saha-339455 status --short
git -C web/.claude/worktrees/sharp-cohen-59d046 status --short
# only once you are sure those files are not needed:
git worktree remove web/.claude/worktrees/elegant-saha-339455
git worktree remove web/.claude/worktrees/sharp-cohen-59d046
git worktree prune
```

**These worktrees carry a `.env` that points at production (see CLAUDE.md).** Removing them also removes that risk.

## 4. NOT merged — review before deleting (do not run blindly)

These have commits that are not in `main`. Deleting them loses that work.

| Branch | Last commit | What is on it that main lacks | Suggestion |
|---|---|---|---|
| `claude/nifty-pasteur-1ecb47` (local + GitHub) | 2026-07-02 | "Security audit fixes: enforce CSP, scope attendance query, drop vuln deps" + an orphan-route removal | **Review the CSP/security commit `5e68b19` first** — it may hold fixes main never got. |
| `claude/fix-class-staff-day-test-133550` (local + GitHub) | 2026-11-10 | "Class day sync: take the clock as an argument" | Recent. main got a different fix for the same test (`e957422`); decide whether the injectable clock is still wanted. |
| `rls/step5-pilot` (local + GitHub) | 2026-07-04 | RLS pilot on one route (+ a temp diagnostic route added then removed) | Keep until the RLS project resumes, or delete if the pilot is abandoned. |
| `recovered-branded-app` (local + GitHub) | 2026-08-25 | Branded-app editor work recovered from a May stash | Keep if the branded app (B22) may reuse it. |
| `claude/ui-design-spree` (local + GitHub) | 2026-09-25 | "Add staff dashboard IA and design audit" (a document) | Probably safe — check the audit doc is in `docs/` on main first. |
| `claude/athletixos-billing-reactivation-ecc23d` (local + GitHub) | 2026-07-14 | One CLAUDE.md note for PR #6 | Safe to delete — docs only, PR #6 merged. |
| `backup/main-pre-merge` (local only) | 2026-05-15 | One "checkpoint" commit from May | A manual backup; 6 months old. Delete when you are comfortable. |

To see exactly what a branch has that main does not:

```bash
git log --oneline main..claude/nifty-pasteur-1ecb47
git diff main...claude/nifty-pasteur-1ecb47 --stat
```

To delete one of these after reviewing (capital `-D` because git knows it is unmerged):

```bash
git branch -D <branch>
git push origin --delete <branch>
```

## 5. Stray file

`/Users/cubano/Desktop/clubos/web/backfill-platform-fee-frogempire607-2026-10-19T19-24-39-258Z.json` is an untracked
output file from the Oct 19 platform-fee backfill. It is not in git and must never be committed. Move it out of the
repo rather than deleting it — it is the record of that run:

```bash
mkdir -p ~/clubos-backups && mv /Users/cubano/Desktop/clubos/web/backfill-platform-fee-frogempire607-*.json ~/clubos-backups/
```
