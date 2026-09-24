# AthletixOS — Session handoff (written 2026-09-24, end of the week's Fable budget)

Read this first, then `docs/BACKLOG.md` (tracker of record) and the dated entries at the bottom of
`docs/improvement/PROGRESS.md`. Everything below is on `main` unless marked **on disk**.

## How this project runs

- Repo `frogempire607/clubos`, app in `web/`, Next.js 14 + Prisma 5.7 + Stripe Connect + Supabase Postgres, Netlify.
  Julian is the only one who runs git/build/migrations, from `~/Desktop/clubos`. Claude edits files on disk and
  hands him one command chain per item.
- **The loop** (always one `&&` chain so a failure stops before a commit — learned the hard way on 09-24):
  `git checkout -b claude/<item> && git add -A && cd web && [npx prisma migrate deploy && npx prisma generate &&]
  npm run build && cd .. && git commit -m "…" && git push -u origin claude/<item> && git checkout main &&
  git merge --no-ff claude/<item> && git push`
- **Migrations**: additive only; `migrate deploy` BEFORE any code that reads a new column is pushed. **Before writing
  one, query the live columns** (Supabase MCP, SELECT-only on project `vhiqdtwxthmdqqizukab`) AND grep the whole Prisma
  model — on 09-24 `pausedAt/pausedUntil` already existed in both, from an April migration, and the migration failed
  twice. Prefer `ADD COLUMN IF NOT EXISTS`.
- Claude never runs index-touching git from the sandbox (`git log/show/diff/ls-files` only — a stray `git status`
  left an `index.lock` once). Supabase is read-only. Production is verified by SQL after every action ("verify
  rather than trust").
- Tests are pure scripts under `web/scripts/*-tests.ts`, run by `npm run test:<name>`; the build runs three guards
  (subscription-truth baseline **48**, permission-boundary, attendance-billing). Sandbox runs them with
  `node $HOME/tsx-run/run.js "$PWD" scripts/x.ts`; `tsc --noEmit --incremental` takes ~90 s cold, ~20 s warm.
- Money rules that are law: EventRegistration is the money spine and slice 2 never mutates a live registration's
  money; Member.status is a label (PAUSED is the one owner-set sticky exception); member-level "migration draft"
  fields are never read as the current answer outside the migration/import paths (the guard enforces it); any
  action that charges a card today sits behind a checkbox naming the amount.

## Shipped this week (all on main, all verified in production)

| Item | What | Commit |
| --- | --- | --- |
| B9 | "Activate this setup now" / "Record payment & renew" in the billing centre; card path (`activate_card`, `lib/cardActivation.ts`); readiness fix; revive-path endDate bug | 09-23 |
| B15 | "Invite {parent} to create a parent account" on Family & access + hotfix (JOIN links to COMPLETED members created nothing) | d09e7e4, 8d6adbe |
| B11 2a/2b | Events pricing model migration (`event_pricing_model`, backfilled, 7 events 0 mismatches), `lib/eventPricingModel.ts` (55 tests), per-session purchase, `EventEditor.tsx` replacing EventModal, member "Pick sessions" | 09-23 |
| B14 | Roster strip: "Renewing this week" + "Paused" queues; Financials renewal card deep-links | a417f90 |
| B12 | Stripe sync now mirrors price/option (fee inversion in `lib/stripePlanChange.ts`, 29 tests); per-row **Sync from Stripe** + **Change plan** (same interval, `proration_behavior: none`) in the billing centre | 5f43b4e |
| B10 slice 2 | Sell by variant (2g) + member store detail (2e); `product_sales.variantId`; `lib/productStock.releaseStock` is the one stock write path (cash now, Stripe on webhook); 69 tests | ed63f9c |
| B13 handoff | `docs/improvement/design_handoff_membership_panel/` — approved by Julian 09-24 | 8bbb835 |
| B13 slice 1 | **Membership panel** replaces the profile's Current membership card (`lib/membershipPanel.ts`, `GET …/membership-panel`); Assign (card/cash/offer/$0-comp in one dialog); Cancel at period end (`cancel_at_period_end`), now (DELETE), Keep membership; Make it free (`comp_membership`); roster Assign → `?assign=1` | 80f9b28 |
| B13 slice 2 | Real Pause/Resume (`lib/membershipPause.ts`: Stripe `pause_collection` void + resumes_at; offline rows get paused days back; lapsed pauses self-resume); Change dates (`set_dates`, Stripe rows only End→cancel_at + Commitment); `cancelReason`. 46 tests | e621b26 + eb106d4 + schema fix |

**On disk, uncommitted (small, no migration):** `components/events/PublicLinkBox.tsx` — the event's public page as
the FULL url with Copy + Open, used in the editor's "Who can sign up" card and the event row's ⋯ menu — plus this
file and the BACKLOG update. tsc clean. Ship with:
`git checkout -b claude/events-public-link && git add -A && cd web && npm run build && cd .. && git commit -m "Events: full public link with one-tap copy; session handoff" && git push -u origin claude/events-public-link && git checkout main && git merge --no-ff claude/events-public-link && git push`

## What Julian still needs to do (his side — none of this is code)

1. **Production look at the new panel** — open Colton (expect "$463.05 quarterly on the saved card · ends Dec 10 —
   no renewal"), Orson (LOOK ONLY until his Sep 25 charge lands), one cash member, one member with nothing. Any
   sentence that reads wrong → tell the next session; the derivation is one function with tests.
2. **Product checks (B10 slice 2)** — a gear product with sizes: Sell tiles show per-size counts; the same product in
   the member portal → tap the card → the pickers agree with the desk.
3. **Orson** (after the charge): billing centre → his row → **Sync from Stripe** (row → $150, "12 months"), then
   **Change plan → 12 months** to record the commitment/end date. Or now from the panel: Change plan deep-links to
   the same dialog.
4. **A3 — the four minors → guardians** (unblocks B2 = flip `FEATURE_PARENTAL_CONSENT=true` on Netlify):
   Luis Serra (second B15 link sent; when he says done, the next session verifies User + CONFIRMED link on André
   `cmrjqogh800021kqob8idjylc`); Clint Dwyer + Aylen Grubusic (roster row → Resend invitation → parent completes →
   approve PROFILE ONLY); Jacob Vann (do NOT use B15 — dad already has login `vannjudson@gmail.com`: Family & access
   → Give someone access → that email; change Jacob's guardian email to it; ARCHIVE the empty "Judson Vann" record).
5. **AJ Dorn** — self-guardian shape: `scripts/fix-family-shapes.ts --only SELF_GUARDIAN --members
   cmsno0z4a00035cv4tyxf6z2y --parent-email adamjdorn@gmail.com --parent-name "Adam J Dorn Sr" --apply`, then
   CHILD_EMAIL for the same id. Possible duplicate "Adam Dorn" `cmr7b603d00wu9il71co7l1t8` — confirm birth year with
   the dad first; if one child, archive the empty record. **Don't touch either until confirmed.**
6. **A7** — Riley Bergen: end date July 2027 (now: panel → Change dates); Skylor Day: Triage → Leave alone; Titus: leave.
7. **A8** — the unbilled worksheet (59 people; comp / plan / gone). Comps are now one step: panel → ⋯ → Make it free.
8. **A4** — call the Lawell family (parent's real name + email), then the account fix in BACKLOG.
9. Housekeeping: delete branch `claude/laughing-golick-2b9c76`; move the 8am check-in cron to `0 13 * * *` after Nov 1.
10. **Decision recorded 09-24:** MS/HS "Monthly Full Membership" stays auto-renew OFF (1-month commitment) — so
    Assign on that option says "ends after one month unless renewed". If that ever changes, flip it in Memberships.

## What the next Claude session does (priority order)

1. **B13 slice 3** — Change plan for offline rows (local: option/price/period from the next payment, commitment
   recomputed) and the **two-step Stripe switch across billing cycles** (`cancel_at` = period end on the old sub +
   new sub with `trial_end` = period end on the same card, one action, one audit). Spec in the handoff README §3c.
   Then the bulk price tool loses its per-row option move.
2. **B13 slice 4** — billing centre becomes "Advanced billing": its *Activate this setup now* / *Record payment &
   renew* buttons point at the panel; the pricing card's Edit stays for migration drafts. Also the B14 Paused card
   showing "resumes {date}" (deferred from slice 2), and a Sync-from-Stripe check for `pause_collection` set by hand.
3. **B10 slice 3** — inventory across all products (2c), then bookings 2d/2f (new model), then `/p/[slug]` + QR (2h),
   the 11-type expansion, structured time windows. Spec: `docs/improvement/design_handoff_products/README.md`.
4. **B11 slice 3** — events: whatever the README lists after 2b (Attendees write actions, bundle sanity in the list).
5. **B2** flip (after A3), then **B3** (Phase 9 family discounts — big, needs a clear run), **B7** (collapse the two
   MS/HS plans; blocked on option-aware class acceptance), **B5**, **B6**.

## Facts the next session will need

- Production Stripe subs of note: Orson `sub_1TsknzEIplcCMoSozcu32ldG` (local row `cmrjbewg20001ef454ppb145x`,
  MS/HS, option `opt_vavjt5xoqc` Monthly $175 locally, $150 in Stripe by hand, trialing, endDate Nov 23 local);
  Colton `sub_1UIrbnEIplcCMoSoCit2bU6q` ($450 quarterly, ends Dec 10). Club passes processing fees (2.9%, no fixed).
- MS/HS options: Monthly Full $175 (1 mo, no renew) · Monthly 2 days $110 · 12 months $150/mo (12 mo) · 3 Months
  $160/mo (3 mo) · 3 months Upfront $450 q · 1 year Upfront $1500.
- Actions live in `app/api/members/[id]/billing-admin/actions/route.ts` (one POST, `action` enum): activate_card,
  sync_stripe, change_stripe_plan, cancel_at_period_end, keep_membership, comp_membership, pause_membership,
  resume_membership, set_dates, set_deliberate_free, set_autopay, set_auto_renew, cancel_pending_activation,
  reassign_subscription. Previews: `GET …/billing-admin/plan-change`, `GET …/membership-panel`.
- The 8am check-in scheduled task reads `docs/BACKLOG.md`; keep its "Next up" block current.
