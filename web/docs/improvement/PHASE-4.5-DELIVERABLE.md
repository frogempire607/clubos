# Phase 4.5 — Members Full Design Handoff · Deliverable

**Merged to `main` 2026-08-11 as `28261c0`** (was
`claude/phase-4-5-members-audit-1e73ba`). Run everything below from
`/Users/cubano/Desktop/clubos/web`.
**Date:** 2026-08-07, merge notes 2026-08-11.

**No migration was created or modified.** Phase 4.5's schema closed on
2026-08-04 with `20260804000000_members_experience` and stayed closed.

---

## 1. What you asked for, and where it landed

| # | Ask | Outcome |
|---|---|---|
| 1 | Confirm all eleven profile tabs render something | **Three were dead** — Documents, Migration activity, Notes. Fixed. Bookings and Messages were fine; verified in the browser rather than assumed. |
| 2 | BF-A backfill command, dry-run first | §6 below. The script already existed; I exercised it end to end against a local database. |
| 3 | Person-type labels — current four + alternatives | §7 below. Awaiting your pick; nothing was changed. |
| — | The open routes | Saved views, snooze, mark-reviewed, invitation deliveries, balance, bulk query-scoped selection — all built. |
| — | 4.5.9 mobile at 390×844 | Measured, not eyeballed. §4. |
| — | 4.5.10 | Subscription history + Reports' `ESTIMATED` → `COMPLETE`, conditionally. |
| — | 4.5.11 | 163 fixtures + 81 UI assertions + 2 grep guards. Guard 2 reached **0**. |
| — | Handoff audit | §3. It is not flattering. |

---

## 2. The eleven tabs

`PROFILE_TABS` has declared eleven since session 2. The body's `on()` helper
handled eight. Selecting Documents, Migration activity or Notes highlighted the
tab correctly and then rendered an empty grid — the failure mode that reads as
"the page is broken" rather than "this is empty".

The markup was not the only thing missing; there was no data behind any of them.

| Tab | Before | Now |
|---|---|---|
| Overview | ✅ | unchanged |
| Personal info | ✅ | unchanged |
| Memberships | ✅ | unchanged |
| Family & access | ✅ | unchanged |
| Attendance | ✅ | unchanged |
| Payments | ✅ | unchanged |
| **Bookings** | ✅ (you hadn't opened it) | verified in browser — renders bookings + event registrations |
| **Messages** | ✅ (you hadn't opened it) | verified in browser — loads the communications card |
| **Documents** | ❌ blank | club documents × this member's signatures, `N missing`, `Request` action, red dot on the tab |
| **Migration activity** | ❌ blank | the attributed `MemberMigrationEvent` rows the 4.5.8 drawer already read |
| **Notes** | ❌ blank | `Member.notes`, which PATCH has always accepted and no post-cutover surface displayed |

Two details worth knowing:

- **"N missing" counts expired signatures as missing.** A waiver signed 400 days
  ago against a 365-day window blocks a check-in exactly as hard as one never
  signed, and the profile previously said "signed" for both.
- Each new API block is individually wrapped. A tab that cannot load its data
  degrades to an explanatory empty state, never back to a blank page.

Verified by loading all eleven tabs for two different members and asserting each
produces at least one card.

---

## 3. The handoff audit

Read against the code and the screen, not against `PROGRESS.md`.

Legend: **Built** = present and reachable · **Partial** = something ships but
not what the handoff describes · **Missing** = not built.

### §1a Members list — `/dashboard/members`

| Element | Status | Where / note |
|---|---|---|
| Full width, no `max-w-7xl` cap | Built | `MembersRoster.tsx` |
| Header: title + 3-count description | Built | also names archived + history-only rows, which the handoff doesn't — added because 293 rows against "281 people" was a real support question |
| Header actions Export / Import / Add member | Built | Form settings + Custom fields did **not** move to Settings — see Missing below |
| Header actions collapse to `⋯` at `<sm` | Built | this session |
| Work-queue strip, 4 cards | Built | |
| — its four counts | Built | this session. Previously three read `—` and the fourth borrowed `midMigration` |
| — each card arms the matching bulk action | **Partial** | each card *is* a saved filter; it does not pre-arm the bulk action |
| Segmented person-type control + server counts | Built | |
| 34px search, `Name, email, phone, guardian, legacy ID` | Built | |
| Filters button with count badge | Built | |
| Sort control, density toggle | Built | |
| **All six `<select>`s collapse into Filters** | **Partial** | only Membership and Account setup are in the panel. **Tags, gender, age and custom field are not** |
| Active-filter chip bar + Clear all | Built | |
| `Save as view`, persists per user | Built | this session — `GET/POST/DELETE /api/members/views` |
| Bulk bar | Built | |
| — `Select all N matching this filter`, query-scoped | Built | `/api/members/selection` |
| — actions Send invitations / Resend / Assign / Message | Built | |
| — `Add tag` | **Missing** | removed in session 3 rather than left as a dead button |
| Table columns incl. Balance, Last seen | Built | Balance was `—` for everyone until this session |
| **Family groups collapse (chevron, 25px indent, 2px spine)** | **Missing** | a 3-child family still costs 4 rows |
| Row: one recommended action + `⋯` | Built | |
| `⋯` menu, fixed order, locked items visible with role named | Built | `MemberActionsMenu.tsx` |
| Footer: rows-of-total, Previous/Next | Built | |
| **A–Z jump** | **Missing** | |
| Server-side search / sort / pagination | Built | `lib/membersQuery.ts` |

### §1c Member profile (tabs)

| Element | Status | Where / note |
|---|---|---|
| Back link → header → switcher → banner → tabs → body | Built | |
| Identity header (avatar, name, Track 2 pill, role chips, Track 3) | Built | |
| Meta line: plan · joined · DOB with lock · legacy ID | Built | |
| Single family switcher | Built | |
| Next-action banner, renders only when outstanding | Built | |
| — 1–3 actions incl. `Snooze 7 days` | Built | this session; the button previously did nothing |
| — **the primary button used to fire the wrong action** | Fixed | it picked its handler from the *permission*, so "Review info" **sent an invitation** and "Fix email" sent one to the bouncing address. Maps by action kind now |
| 11 tabs with counts + red problem dot | Built | this session |
| **Migration progress card (7 columns, label + date + actor)** | **Missing** | the meter exists in the roster cell, the queue and the 4.5.8 drawer, but not as this card |
| Contact & identity card + 3-icon ownership legend | Built | |
| **Recent activity list (24px tinted icon tiles)** | **Missing** | |
| Locked birthday row + verbatim copy | Built | |
| Account & security card | Built | |
| **Money card** | **Partial** | "Recent transactions" list, not the summary card drawn |
| **Attendance (3 figures)** | **Partial** | a record list, not 3 figures |
| Waivers & documents, `N missing`, `Request` | Built | this session |
| Staff notes (staff-only, attributed) | **Partial** | built this session; shows and edits, but is not attributed to a named staffer |
| **2-column body at `1.55fr / 1fr`** | **Partial** | equal `lg:grid-cols-2` |
| Payments tab wires the 2.5.4 P&L drill-through | **Missing** | |

### §1e Edit member

| Element | Status |
|---|---|
| 560px drawer, full-screen at `<md` | Built |
| Brand-tinted mid-migration info strip | Built |
| Grouped fields, locked block, attributed footer | Built |
| Corrected-field affordance + Revert | Built |
| **Everything except birthday and password** | Built this session — was 7 fields, now adds photo, gender, address ×4, guardian relationship, tags, notes and the club's custom fields |
| Editing an email re-points, never re-sends | Built |

### §1f Password reset

| Element | Status |
|---|---|
| Confirm / Success / No-email dialogs, copy verbatim | Built |
| Live `Resend in m:ss` countdown | Built |
| Bounce history in the no-email state | Built — and **now actually populated**, since invitation deliveries are written |

### §1g Family & access

| Element | Status | Note |
|---|---|---|
| Header with counts | Built | |
| Permissions table, editable in place | Built | shipped column names `canBook / canPay / canSignWaivers / canReceiveEmails` |
| Pending rows tinted, Confirm / Resend / Cancel | Built | |
| Staff-created relationship grants nothing until confirmed | Built | |
| **Account-holder card (46px avatar, chips, meta, View profile / Message)** | **Partial** | guardians render as rows, not as the distinct card drawn |
| **Transfer account management card** | **Partial** | transfer exists (Phase 4A) and is reachable from the subscription row; the explanatory card with its safeguards list is not on this surface |

### §1h Migration dashboard

| Element | Status | Note |
|---|---|---|
| Funnel card, 7 joined segments with sub-lines | Built | |
| Every segment is a filter | Built | `?step=N` |
| Stacked progress bar + legend | Built | |
| Cut-over advisory | Built | |
| **Queue segmented by whose turn** (`Needs you · Waiting on member · In setup · Done`) | **Missing** | the counts are already in the funnel payload; nothing renders the control |
| **"Needs you" 4-up cards** | **Missing** | |
| Queue **Step** column (meter + step + why stuck) | Built | this session — replaced the group/readiness chips |
| Queue `Waiting on` pill | **Partial** | rendered as text under the meter, not as the coloured pill |
| Bulk row: Send invitations / Assign / Mark reviewed | **Partial** | send + reminders exist; `Mark reviewed` is not a bulk action (the single-member route exists) |
| **Tabs: Overview · All imported · Duplicates (orange badge) · History** | **Missing** | duplicates is a separate page, reachable from the work-queue card |
| Deprecated group / readiness UI retired | Built | this session — guard 2 reached 0 |

### §1i Migration detail drawer

| Element | Status |
|---|---|
| 664px drawer over the queue, keeps the filter | Built |
| Header, duplicate notice, progress timeline with actors | Built |
| Invitation step embeds Resend / different email / copy link | Built |
| Imported-data table, "As imported" header from the owner's label | Built |
| Corrected rows tinted, birthday locked in both cells | Built |

### §1j Mobile (390 × 844)

| Element | Status | Note |
|---|---|---|
| Existing charcoal topbar + 5-slot bottom nav | Built | pre-existing shell |
| List: search, Filters with badge, person-type chips scroll | Built | |
| Table → card list below `md` | Built | verified: table hidden, 17 card rows |
| Work-queue 4 → 2×2 → 1 column | Built | |
| **Every target ≥44px** | Built | this session; measured per surface per width |
| **2-card "needs you" scroller** | **Missing** | |
| **Pill FAB (`user-plus` + Add) 78px above nav** | **Missing** | |
| **Family collapse "3 more in family" chip** | **Missing** | follows the desktop family-collapse gap |
| Profile: 56px avatar, compact banner, 3-up switcher | Built | |
| **Profile 2×2 fact grid (Balance / Waiver / Last seen / Migration)** | **Missing** | |
| **Sticky bottom bar leading with `Check in`** | **Missing** | |
| **Quick-action bottom sheet (48px rows)** | **Missing** | the `⋯` menu is a popover at every width |
| **Desk walk-in flow** | **Missing** | not started |
| No horizontal scroll at 375 / 414 / 768 | Built | measured 0 overflow on all five surfaces |
| Dark mode across every members surface | Built | landed `f59567b`; re-verified at 390 this session |

### §1k States

| Element | Status |
|---|---|
| Empty roster with never-charged reassurance | Built |
| Empty search | **Partial** — names no active filters and offers no spelling suggestion |
| Loading skeletons | Built |
| **Success: `21 sent` + "3 skipped: …" + `See the 3 skipped`** | **Missing** — the toast reports a count, and the send API collects reasons that never reach the screen |
| **Warning: non-blocking Stripe banner** | **Missing** |
| **Error: 8 undelivered → those people become Blocked → `Fix these 8`** | **Partial** — a bounced delivery now *does* make someone Blocked, but there is no post-send error surface |

### Cross-cutting

| Element | Status |
|---|---|
| No hard-coded vendor names (grep guard) | Built — hard fail, green over 595 files |
| Deprecated vocabulary removed from UI | Built — guard 2 at **0**, now a hard fail |
| `nextAction()` — one resolver, three renderings | Built |
| Query-scoped selection | Built |
| Filters / sort / segment / page in the URL | Built |
| Every mutation on a migrating member attributed | Built |
| Birthday writable only by member/guardian | Built |
| Reset links single-use, 60-minute, attributed | Built |

**Summary: 68 Built · 13 Partial · 16 Missing.** The missing set clusters in
three places — the migration dashboard's queue chrome (§1h), the mobile-native
interactions (§1j: FAB, sticky bar, bottom sheet, walk-in flow), and the §1k
result states. None of them is blocked; all are additive.

---

## 4. The mobile audit, as measured

Method: a DOM pass per surface per width recording horizontal overflow and every
interactive target under 44px. Surfaces: roster, profile, migration, duplicates,
approvals. Widths: 375×812, 390×844, 414×896, 768×1024, 1280×800.

What it found, and what changed:

- Header actions did not collapse below `sm`. Four buttons wrapped onto two rows
  and pushed the work-queue strip off the first screen at 390 — which is where
  the work is.
- Targets failing 44px across the board: person-type chips at 31, Filters/sort/
  density at 34, pagination at 32, profile header actions and family switcher at
  36–38, the Family & access permission toggles at 30, and row actions
  (Edit / Remove / Confirm / Withdraw) at 16–20. Merge and Remove sitting a thumb
  width apart is how the wrong record gets archived.
- My first pass lifted the overrides at `md`, which put 768×1024 — an iPad, still
  a finger — back under target. Toolbar controls now hold 44px through `lg`.
- Zero horizontal overflow at every width on every surface.
- Desktop density is unchanged; every fix is a min-height that reverts at the
  breakpoint. Verified by screenshot at 1280.

**Known and deliberately not changed:** the shared dashboard chrome — the
topbar's menu / bell / avatar at 40px and the Back link at 20px — is under 44 on
every page in the product, not just Members. Changing it is a global change and
outside this phase. Flagging rather than doing it silently.

---

## 5. Session D

| # | Finding | Outcome |
|---|---|---|
| D-1 | Duplicate detection flags siblings | The detector's own header claimed this was impossible because minors carry guardian contact on `guardianEmail`. The data disagrees: 27 of the 34 live minors with an own email hold their guardian's, and 42 hold their guardian's phone — so siblings collided on `email:` and on `phone:`+lastName. Keys moved to `lib/memberDuplicates.ts` and now skip a contact value equal to the same row's guardian contact. Structural, so it survives the next import. `namedob:` deliberately untouched — it is what still catches a genuinely duplicated minor. |
| D-1b | Data correction | `scripts/fix-guardian-contact-on-minors.ts` — dry-run default, minors only, never touches a member with their own login, guardian columns untouched, every write logged with the old value. **Yours to run.** |
| D-2 | Merge button does nothing | Reproduced — and it was never dead. On a refusal the message went to `msg`, which renders near the top of the page, **underneath the modal's own overlay**. The modal stayed open, the button reset, nothing visibly happened. Failures raised in the modal now show in the modal, and the both-logins 409 names the next step. A mergeable pair merges and carries the chosen field. |
| D-3 | Work-queue cards show `—` | All four now come from `workQueueCounts()`, built from the **same** `memberWhere()` clauses the click applies, so a card cannot advertise a number the list disagrees with. Verified 3/1/3/2 against lists of 3/1/3/2. |
| D-4 | Edit drawer scope | Now covers everything `PATCH /api/members/[id]` accepts except birthday and password. §3 §1e. |

**Password reset (#1)** was already closed as correct behaviour with confusing
copy. Nothing further needed; the bounce history it shows is now real.

---

## 6. BF-A — the command to run

`scripts/members-experience-backfill.ts` already existed and is unchanged. I ran
it end to end against a throwaway local database (dry run, then `--apply`, then
verified the effect) so the shape of what you'll see is known.

**Dry run first — this writes nothing:**

```bash
cd /Users/cubano/Desktop/clubos/web && npx tsx scripts/members-experience-backfill.ts
```

It prints a per-club report. Expect two lines per club:

```
  BF-A reviewedAt           N of M mid-migration members · K left null (no attributable NOTE)
  BF-B subscription events  N row(s) across M subscription(s)
```

**Then, per club:**

```bash
cd /Users/cubano/Desktop/clubos/web && npx tsx scripts/members-experience-backfill.ts --apply --clubs=<clubId>
```

`--apply` refuses to run without `--clubs`. Both passes are idempotent — BF-B
skips any subscription that already has events, so a re-run after a partial
failure cannot double-count.

What it changes:

- **BF-A** promotes the existing inference (an attributable `NOTE` migration
  event) into `members.reviewedAt` once, explicitly, with the actor it recorded.
  Until it runs, the funnel's step 2 reads unreviewed for everyone. Members whose
  `NOTE` has no actor are deliberately left null — a review with no reviewer is
  not a fact worth asserting.
- **BF-B** synthesizes subscription history, every row stamped `source='SYSTEM'`
  with `detail.backfill=true` so Reports can exclude reconstructed history from
  "what changed this month".

**Reports' Membership tab flips `ESTIMATED` → `COMPLETE` only after BF-B has run
for the club being reported on.** The test is coverage, not existence: every
subscription must have at least one event. Creating the table changed nothing —
an empty log reads as "nothing ever happened", which is a confident wrong answer
where the caveat was an honest one.

The separate D-1 correction, also yours:

```bash
cd /Users/cubano/Desktop/clubos/web && npx tsx scripts/fix-guardian-contact-on-minors.ts
```

---

## 7. Person-type labels — your pick

The handoff lists this as an open decision and nothing has been changed. The
segmented control currently reads:

> **Everyone · Athletes · Parents · Account holders · Prospects · Inactive**

Four of those are the person-type question. Here they are with alternatives.

### 1. `Athletes`

| Option | Reads as | Against |
|---|---|---|
| **Athletes** (current) | The people who train | Wrong word for a club that says "students", "members" or "kids" |
| Members | Familiar, sport-neutral | Collides with the product's own "member" record, which includes parents. Two meanings, one word — the exact failure this phase exists to fix |
| Training | Describes the activity, not a label on a person | Reads oddly as a segment name |

**Recommendation: keep `Athletes`.** It is the only one that cannot be confused
with the record type, and it is the word the rest of the product already uses.

### 2. `Parents`

| Option | Reads as | Against |
|---|---|---|
| **Parents** (current) | Warm, obvious | Not every guardian is a parent — grandparents, carers, older siblings |
| Guardians | Legally accurate; matches `guardianEmail`, `MemberGuardianUser` | Colder, and "guardian" is a word most parents never use about themselves |
| Parents & guardians | Correct and warm | Long in a segmented control at 390px |

**Recommendation: `Parents & guardians`.** It is the honest one, and the mobile
control already scrolls horizontally so the length costs nothing. If you want it
short, keep `Parents`.

### 3. `Account holders`

| Option | Reads as | Against |
|---|---|---|
| **Account holders** (current) | Whoever the money sits with | Slightly bank-ish |
| Payers | Blunt and unambiguous | Feels transactional on a screen full of children's names |
| Billing contacts | Matches the `BILLING_CONTACT` recipient mode already shipped | Longest of the three |

**Recommendation: keep `Account holders`.** It is what the Family & access card
already calls the same person, and one vocabulary across two surfaces beats a
marginally better word on one.

### 4. `Prospects`

This is the one worth changing, and the handoff flags it separately.

Since J-10, Prospect strictly means **"showed up but never bought"** — attended,
trialled, or made a login. The people who never touched the club are now `Lead`.
So the label is describing a warmer person than it used to.

| Option | Reads as | Against |
|---|---|---|
| **Prospects** (current) | Sales language | A parent whose child trialled last Tuesday is not a "prospect", they're a near-miss |
| **Trialled** | Exactly what the rule tests | Slightly narrow — a portal signup with no attendance also lands here |
| Not yet joined | Plain, non-salesy, true of every case | Three words |
| Interested | Warm | Asserts a feeling you have no evidence for |

**Recommendation: `Not yet joined`.** It is true of every case the rule matches,
it carries no sales connotation on a screen the front desk reads, and it pairs
naturally with `Lead` above it — a lead is someone you haven't reached, someone
"not yet joined" is someone you have.

**Nothing is changed until you say.** All four are one edit to `PERSON_TYPES` in
`components/members/MembersRoster.tsx`; the filter keys are separate from the
labels, so no URL, saved view or API contract moves.

---

## 8. Everything else built this session

**Routes that back controls which already rendered:**

- `GET/POST/DELETE /api/members/views` — saved views, per user. Stored filters
  are allowlisted to the keys the list parser reads, so a saved view cannot
  smuggle an arbitrary parameter into a later request. `page` is excluded —
  reopening a view on page 4 looks like data loss.
- `PATCH /api/members/[id]/triage` — review / unreview / snooze / unsnooze. Both
  columns were read by the meter and the resolver and written by nothing.
  `review` is idempotent: two staff pressing it a minute apart must not produce
  two different reviewers.
- Invitation deliveries are written on every send, address frozen at send time —
  editing a member's email later must not rewrite where invitations actually went.
- The Balance column. "Owed" is narrow on purpose: a `PENDING` Transaction,
  which is what the offline-payment rules define as "the amount due, never
  revenue". `VOID` excluded (counting it resurrects money written off) and so is
  a future renewal, which would put a balance against every active member.

**Bounce ≠ ignore.** Both used to resolve to "Fix email". For an ignore the
address is *fine*, so that told staff to break the one working address they had.
With delivery data able to prove nothing bounced, three-sends-never-opened now
resolves to `Call <guardian>` — which §1j already specifies — and says out loud
that changing the address will not help.

**4.5.10 subscription history.** Append-only, `memberId` denormalized so a
Phase 4A transfer cannot retroactively rename whose history it was, `at` = when
the transition happened rather than when we found out. Wired to real transitions
only: `CREATED` on every creation path, `ACTIVATED` only where the membership is
genuinely live, `CANCELED` on the owner route and the approvals queue (but not
on `PERIOD_END`, which has ended nothing yet), `EXPIRED` from the sweep with
`source=SYSTEM` — a fixed-term plan reaching its end date is not somebody
leaving, and conflating the two overstates losses.

---

## 9. Verification

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run build` | clean |
| `npm run test:phase45` | 163 fixtures + 81 UI assertions, green |
| Guard 1 — vendor names | green over 595 files, hard fail |
| Guard 2 — deprecated vocabulary | **0**, lowered from 8 and converted from a ratchet to a hard fail |

Browser testing was real, against a throwaway local Postgres 16 on `:55432` with
all 90 migrations applied and `scripts/seed-local-browser-test.ts` fixtures
(now 29 members, including a bleeding sibling pair, a mergeable duplicate, a
both-logins pair, three document states, three balance states and two invitation
delivery shapes). Every claim above marked "verified" was clicked.

**Not verified:** anything requiring Stripe, real email delivery, or the
Capacitor shell. The 4.5.9 acceptance criteria include a Capacitor regression
pass — I tested responsive behaviour in a browser at the specified widths, which
is not the same thing as running the native shell.

---

## 10. Phase 4.5 exit criteria — honest status

| Criterion | Status |
|---|---|
| Every acceptance criterion green | **No.** 16 missing, 13 partial — §3 |
| Every migration applied and confirmed | Yes — `20260804000000_members_experience`, applied 2026-08-04 |
| Reports reliability flips to `COMPLETE` | Mechanism built and verified; **flips per club once BF-B runs** |
| No hard-coded vendor name anywhere | Yes |
| Owner sign-off: `1c` tabs vs `1d` rail | Defaulted to tabs and built; `1d` not built |
| Owner sign-off: person-type labels | **Awaiting your pick** — §7 |
| Owner sign-off: whether Prospect is renamed | **Awaiting your pick** — §7 |
| Owner sign-off: default staff permissions | **Not raised.** Still open |
| `PROGRESS.md` Phase 4.5 closed with a dated entry | On merge |

Phase 4.5 is not finished. What is finished is every item that was queued for
this session, plus the two subsystems the exit criteria named (deprecations at
zero, subscription history), plus a walk of the whole handoff that says exactly
what is left. §3 is the backlog.
