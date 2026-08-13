# Phase 5 — Event Registration Confirmation + Tournament Approval & Payment · Deliverable

**Branch:** `claude/phase-5-event-registration-9675fb` (13 commits, `b6d052e` → `6e7d08a`).
**Date:** 2026-08-12, three sessions.
Run everything below from `/Users/cubano/Desktop/clubos/web`.

**One migration, already applied.** `20260812000000_event_tournament_workflow`
was written in session 1, applied and verified by Julian before session 2, and
has not been touched since. Sessions 2 and 3 added no schema of any kind — the
configurable entry categories that landed in the middle of the phase went into
JSON columns that already existed, deliberately.

---

## 1. What changed

**Every event, always.** A registration now has one address for its whole
lifetime — `/e/<slug>/registered/<id>`, or `/r/<id>` for an event with no public
slug — and that page reads the row every time it is opened. The parent who
bookmarks it after registering sees the coach's decision when they come back.
Every lifecycle email renders from the same resolver as that page, so the two
cannot disagree. All three §5.2.1 bugs are closed: the free public path sends a
confirmation, the paid public path sends one from the webhook, and no surface
renders success from a query parameter any more.

**Tournaments, opt-in, default off.** An owner turns on coach approval per event
type or per event. A parent registers; nothing is charged and no spot is held. A
coach approves, declines with a reason, or proposes a different entry — and the
parent accepts or declines that. Approving charges the saved card, sends the
first invoice, or leaves cash alone depending on how they chose to pay.
Reminders escalate as the deadline approaches, and the responsible coach gets a
daily digest of what has been sitting.

**A weekly clinic sees none of it.** Every policy column is null-means-inherit
and every default resolves to off. The event editor hides the approval card
entirely for event types that have not opted in.

| Area | Landed |
|---|---|
| §5.2 confirmation surface | `/e/[slug]/registered/[id]` + `/r/[id]`, `calendar.ics` on both, `RegistrationCard` |
| §5.2.2 render resolver | `lib/registrationRenderState.ts` — 18 keys, exhaustive, pure |
| §5.2.5 lifecycle emails | confirmation · approved · declined · proposal · accepted · parent-declined · reminder · coach digest |
| §5.3 owner settings | per-type defaults in Manage event types; "Coach approval + payment" card + escalation subcard in the event editor |
| §5.4 write path | `PENDING_REVIEW`, capacity at approve time, approve/decline/propose, parent accept/decline, `Booking.bookedByUserId` |
| §5.5 parent ↔ coach | DMs both directions in the existing `Message` thread |
| §5.6 escalation | `lib/tournamentReminders.ts`, `/api/cron/tournament-reminders`, `netlify/functions/tournament-reminders-cron.mts` |
| §5.7 visibility | 5 Action Center probes, roster queue, member-portal cards, `EVENT_PROPOSAL_RESPONSE` approval rows |
| — | Entry categories: sport-neutral, owner-defined, any number (see §9) |

---

## 2. Schema and migration changes

`20260812000000_event_tournament_workflow` — **applied 2026-08-12**. Additive
only; every column is nullable or carries a default that reproduces the previous
behavior.

- `events`: `requiresCoachApproval`, `approvalPaymentIntent`, `allowProposedChanges`,
  `responsibleCoachUserId`, `escalationEnabled`, `escalationAnchor`,
  `escalationSchedule`, `escalationCustomDays`, `cancellationPolicyText`,
  `paymentDueBy`, `holdSpotDuringReview NOT NULL DEFAULT false`
- `club_event_types`: `defaultPolicy JSONB`
- `event_registrations`: `approvalStatus`, `approvedByUserId`, `approvedAt`,
  `declinedReason`, `approvalRequestedAt`, `proposedChange`,
  `proposedChangeRespondedAt`, `proposedChangeAccepted`, `reminderStage`,
  `lastReminderAt`, `nextReminderAt`, `reminderSendFailures`, `confirmationCode`
- `bookings`: `bookedByUserId`
- Indexes: partial unique on `confirmationCode`; partial on `nextReminderAt`;
  `(clubId, approvalStatus)`; partial on `approvalStatus = 'PENDING'`

**The guarded statement.** The `(eventId, LOWER(email))` uniqueness from
ARCHITECTURE-NOTES M18 is created only if the table is already clean; otherwise
the migration reports the duplicate count and continues. Check whether it landed:

```bash
psql "<session pooler URI>" -c "SELECT indexname FROM pg_indexes WHERE tablename='event_registrations' AND indexname='event_registrations_eventId_email_key';"
```

Empty result means duplicates exist. Nothing in the code depends on the
constraint; it is a public-path double-submit guard.

**No new columns in sessions 2 or 3.** Configurable entry categories store in
`ClubEventType.defaultPolicy` (added by this migration) and in
`Event.registrationForm` (years old). Proposal labels store inside
`EventRegistration.proposedChange`.

---

## 3. Backfill requirements

**None required.** Two things fill themselves in:

- `confirmationCode` is computed and persisted on first read, so any row that
  reaches a human has one by the time they read it. Deriving it in SQL would
  have meant two implementations of the same derivation.
- `approvalStatus` stays NULL on every existing row, and that is the point: NULL
  means "coach approval was never part of this event's contract". Backfilling it
  to anything would retroactively rewrite what those families agreed to.

---

## 4. New environment variables

**None.** The reminder cron reuses `CRON_SECRET`, the same value
`event-charges-cron` already verifies. If it is unset, `/api/cron/tournament-reminders`
answers 503 rather than running unauthenticated — an endpoint that emails a
club's entire unpaid list is not an acceptable open default.

The scheduled function registers itself on the next production deploy. No
Netlify configuration beyond the secret already being present.

---

## 5. Tests added

| Suite | Assertions | Covers |
|---|---|---|
| `scripts/event-confirmation-state-tests.ts` | **277** | every render key, waitingOn precedence, policy inheritance, refund copy, reminder cadences, confirmation codes, entry categories across three sports, the card-vs-"nothing owed" invariant, URL construction, the $1.03 fee math |
| `scripts/sport-terms-guard.ts` | guard | no sport vocabulary in rendered UI; **baselined at 0, hard fail** |
| `scripts/seed-phase5-browser-test.ts` | fixture | approval-gated tournament, responsible coach with `events:view` only, guardian, the member-priced bug shape, a judo event |
| `scripts/dev-phase5-browser-test.sh` | harness | local Postgres + **dummy `STRIPE_SECRET_KEY`**, so a local click cannot charge a real card |
| `scripts/delete-test-event.ts` | script | dry-run by default; refuses any event with money attached |

## 6. Tests run, and results

```
npx tsx scripts/event-confirmation-state-tests.ts   277 passed, 0 failed
npx tsx scripts/event-payment-tests.ts               57 passed, 0 failed
npx tsx scripts/event-repricing-tests.ts             87 passed, 0 failed
npx tsx scripts/sport-terms-guard.ts                 ✓ 0 hits in 139 files
npx tsx scripts/members-grep-guards.ts               ✓ passed (Phase 4.5, still green)
npx tsc --noEmit                                     clean
npm run build                                        ✓ compiled successfully
```

Browser-tested throughout against a throwaway local Postgres, with three real
logins (owner, a STAFF coach holding `events:view` only, a guardian): settings
round-tripping to their columns, propose → accept and propose → decline with
consent enforcement, approve and decline from the coach queue, authorization
allowed and refused, the reminder cron advancing a stage and refusing to
double-send, the confirmation surface following the row, and a walk-in landing
on it straight from the public page.

---

## 7. Known limitations

1. **The member CARD checkout does not land on the confirmation surface.** It
   creates no `EventRegistration` row — the webhook's `memberId + eventId` branch
   books it — so there is nothing to point at. Giving it one would reroute a
   live, high-traffic money path through a different webhook branch. It returns
   to `/member/events` as before, now with `baseUrlFromRequest` so previews stay
   on themselves.
2. **APPROVAL_CHARGE has been verified live once, by you, at $1.03.** The local
   harness cannot exercise it — the dummy Stripe key is deliberate.
3. **Reminders are hourly, and the digest fires on whichever hourly pass lands
   inside 09:00 club-local.** A club whose timezone is unset gets 09:00 UTC
   (`Club.timezone` is still null for every club — see §11).
4. **`EmailOptOut` scope `ALL` suppresses these.** Transactional sends bypass
   `MARKETING`, but a recipient who asked for zero email gets zero, including a
   decline notice. That is the existing Phase 3I contract, restated here because
   it is easy to be surprised by.
5. **No auto-approve or auto-decline, ever.** A stalled registration escalates to
   a human and stays there.
6. **`Transaction.refundedAmount` (M3) still isn't a column**, so refund figures
   on the confirmation card come from the caller and the VOID heuristic.
7. **Bundles bypass coach approval** (§5.12 item 6), unchanged.

---

## 8. Manual testing checklist

Owner settings
- [ ] Manage event types → a custom type → set entry categories and coach-approval defaults → reopen, values persist
- [ ] Event editor on a Tournament → "Coach approval + payment" card is visible; on a non-opted-in custom type it is absent
- [ ] Turn escalation on → "See the cadence" lists the real dates → save → reopen

Registration
- [ ] Public link on an approval-gated event: the notice appears above the pay picker; registering lands on the confirmation surface with a confirmation number
- [ ] Member portal, same event: the picker offers charge-on-approval only with a card on file, and the button names the exact amount
- [ ] A member-priced event with no non-member price quotes the member price to a walk-in, not $0

Coach review
- [ ] Roster → "Waiting on you" lists the pending registrations with what each owes
- [ ] Approve an APPROVAL_CHARGE row → card charged, receipt, Booking appears
- [ ] Decline with a reason → the family's email quotes it verbatim; a paid registrant is refunded
- [ ] Propose a change → the parent's email and page show your labels and the fee
- [ ] Sign in as the responsible coach (no `events:edit`) → can decide; remove them as responsible coach → 403

Parent
- [ ] Bookings shows the request before any Booking exists
- [ ] Accept with a fee → consent required, amount matches, registration updates
- [ ] Decline → withdrawn, coach notified in-thread

Escalation
- [ ] `curl -X POST -H "authorization: Bearer $CRON_SECRET" https://athletix-os.com/api/cron/tournament-reminders` → `dueReminders`, `tally`
- [ ] Run it twice → the second produces no new `EmailSend` rows
- [ ] Without the header → 401. With `CRON_SECRET` unset → 503

Confirmation surface
- [ ] Open a registration's URL, change its state, reload → the page changed
- [ ] `calendar.ics` on a pending registration → `STATUS:TENTATIVE`
- [ ] A bogus id → 404

---

## 9. Two changes of direction worth recording

**The propose form was wrestling-shaped.** "Weight class", "Division", "Wrestle
an additional dual", and a placeholder reading "126 is stacked — he'd get more
matches at 132". AthletixOS sells to any youth sports organisation. Entry
categories are now owner-defined — a label plus an optional value list, any
number of them, offered with presets — and the proposal allowlist is per event
rather than a fixed union. `scripts/sport-terms-guard.ts` keeps it that way.

**A priced event could register people free.** `publicFixedPrice` answered "what
does a walk-in owe" and returned 0 when the price the owner hadn't set happened
to be the one it read; Phase 5 made it the general fallback. An event with a $1
member price and no non-member price registered a walk-in for $0, approved with
nothing to charge, and emailed the family "this event is free" with their Amex
listed underneath. Fixed in four places, audited across production (1 event, 1
registration — both the test records, now deleted), and the state union was
tightened so "resolved to zero" can never render as "this event is free".

---

## 10. Deployment order

1. **Migration is already applied.** Nothing to run.
2. Merge the branch and let Netlify build. `prisma generate` runs in the build.
3. **Confirm `CRON_SECRET` is set** in the Netlify environment with Functions
   scope. It already is, for `event-charges-cron`.
4. After the deploy, confirm both scheduled functions are registered
   (Netlify → Functions → Scheduled): `event-charges-cron`,
   `tournament-reminders-cron`.
5. Smoke the cron once by hand with the curl above; expect `{"ok":true,…}`.
6. Nothing else. The workflow stays invisible until an owner turns it on.

## 11. Rollback plan

**Revert the code; leave the schema.** Every column is additive and nullable, so
a revert leaves unread columns behind and nothing breaks.

- Full: `git revert 6e7d08a de6840e ed78cdd f1d98b9 1aee685 c4561b0 a3edd19 5464d86 ba9fa04 fca96fb` (schema commit `b6d052e` can stay).
- Partial, most likely: **switch the workflow off in the app** — clear the event
  type's `defaultPolicy` and set `requiresCoachApproval = false` on the affected
  events. Everything reverts to today's behavior with no deploy.
- Stop reminders only: unset `CRON_SECRET` (503s the route) or disable the
  scheduled function. In-flight registrations keep their `nextReminderAt` and
  resume when it returns.
- The confirmation surface is additive; reverting it restores the old
  `?registered=true` page, which is worse but not broken.

**Rolling back does not un-send email or un-charge cards.** A refund is a
refund, through the roster or Stripe.

---

## 12. Commit hashes

```
b6d052e  Phase 5 schema: one migration for the whole phase, applied by nobody yet
fca96fb  Phase 5 spine, part 1: one resolver the page and every email read from
ba9fa04  Phase 5 spine, part 2: the write path a coach decision actually runs
6c5acc7  PROGRESS: the Phase 5 apply commands, and what is waiting on them
5464d86  Phase 5, part 3: the settings that make any of this reachable
a3edd19  Phase 5, part 4: the coach's queue, on the roster they already open
c4561b0  Phase 5, part 5: the parent's answer, and the surface to give it on
54df67c  PROGRESS: session 2, and the two things still missing
1aee685  Fix: a priced event could register people free, then tell them so
f1d98b9  Browser-tested the fix, and closed two more places the wrong price showed
ed78cdd  Entry categories are the club's words, not wrestling's
de6840e  Phase 5 §5.6: something finally sends
6e7d08a  Phase 5 §5.2: one live address per registration, and the last two lies
```

---

## 13. Still needs your decision

1. **`Club.timezone` is unset for every club.** The digest falls back to 09:00
   UTC — 4am Chicago. One value in Settings → Club fixes it, and it also
   sharpens every "3 days before" in the cadence.
2. **Built-in event types can't carry entry-category defaults.** They have no
   `ClubEventType` row. If you want Tournament/Camp/Clinic to carry club-wide
   defaults, that is one additive column mirroring `Club.builtInEventColors`:
   `ALTER TABLE "clubs" ADD COLUMN "builtInEventCategories" JSONB;`. Not written.
3. **The member CARD path** (§7.1) — worth its own change, or leave it.
4. **Reports Action Item `TOURNAMENT_PAYMENT_STALLED` at stage 6** (§5.12 item 8)
   is specced and not built; it belongs with the Reports action-items work
   rather than here.
5. **`Transaction.refundedAmount` (M3)** would make refund copy exact instead of
   heuristic.
