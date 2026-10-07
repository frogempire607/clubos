# Staff scheduling & payroll — final schema proposal (v3)

_Proposal only (2026-10-07, v2). Nothing here is applied or built. v2 adds Julian's clarifications of
2026-10-07: occurrence-level pay override, copy pay plan, coverage workflow, class-cancel notifications,
ledger cut-over rule. Supersedes v1. v3 (same day): no history backfill; "associated with a class" defined; late call-outs; push channel later. Background: STAFF-SCHEDULING-PAYROLL-AUDIT.md._

## Rules this implements
1. **Cancelled class** = unpaid by default; an authorized user can mark that one occurrence "cancelled — paid".
   Stored: who, when, reason, notification audience chosen, pay preserved or not.
2. **Substitute pay** = the substitute's own matching plan. An authorized payroll user can **override the pay for
   one occurrence** (match the regular coach, or any amount). The override lives on that assignment / pay line
   with an audit trail and never changes anyone's plan. No plan and no override → pay line flagged for review.
3. **Worked** is presumed once the end time passes, unless cancelled, no-show, replaced, or changed by an admin.
   Future occurrences never pay.
4. **Salary** = fixed amount per pay period, no automatic proration.
5. **Names are free text** (roles, plans). **Copy pay plan** copies one chosen plan to another coach as that
   coach's own independent plan.
6. **Assignments**: only schedule managers assign. A coach calling out does **not** cancel the class: their
   assignment becomes **Needs coverage**, configured recipients are notified, and only a schedule manager
   finalizes the replacement.
7. **Ledger cut-over**: first full unpaid pay period after deployment. Paid periods are never recalculated. If a
   period is in progress at deployment, stop and show dates/amounts for a decision.

## Migration A — assignments, coverage, cancellation (additive)

```prisma
/// Recurring assignment. Replaces RecurringClass.assignedStaffIds.
model ClassStaffRule {
  id              String    @id @default(cuid())
  clubId          String
  classId         String
  userId          String
  roleName        String?               // free text
  dayOfWeek       Int?                  // null = every class day; 0–6 = that weekday only
  effectiveFrom   DateTime  @db.Date
  effectiveTo     DateTime? @db.Date
  createdByUserId String?
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  @@index([classId, effectiveFrom])
  @@index([clubId, userId])
  @@map("class_staff_rules")
}

/// One coach on one class day. Replaces ClassSession.staffOverride. The historical record.
model ClassSessionStaff {
  id                String    @id @default(cuid())
  clubId            String
  sessionId         String                 // → ClassSession (cascade)
  userId            String
  roleName          String?
  kind              String    @default("REGULAR")    // REGULAR | SUBSTITUTE
  replacesStaffId   String?                // SUBSTITUTE → the ClassSessionStaff row it covers
  status            String    @default("SCHEDULED")  // SCHEDULED | NEEDS_COVERAGE | REPLACED | NO_SHOW | REMOVED
  source            String    @default("RULE")       // RULE | MANUAL | BACKFILL
  ruleId            String?
  // coverage (rule 6)
  calledOutAt       DateTime?
  calledOutByUserId String?               // the coach, or a manager on their behalf
  calloutReason     String?
  lateCallout       Boolean   @default(false)   // called out < 2 hours before start; never blocked
  coverageFilledAt       DateTime?
  coverageFilledByUserId String?          // must hold schedule:edit
  // occurrence-level pay override (rule 2)
  payOverrideCents    Int?                // null = use the coach's plan
  payOverrideReason   String?
  payOverrideByUserId String?             // must hold finances:full; never the coach themself
  payOverrideAt       DateTime?
  note              String?
  changedByUserId   String?
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt
  @@unique([sessionId, userId])
  @@index([clubId, userId])
  @@index([clubId, status])
  @@map("class_session_staff")
}

model ClassSession {                      // new columns only
  canceledAt           DateTime?
  canceledByUserId     String?
  cancelReason         String?
  cancelNotifyAudience String?            // BOOKED | CLASS_MEMBERS | BOTH | NONE — what was chosen that time
  cancelNotifiedCount  Int?
  cancelPaid           Boolean  @default(false)
  cancelPaidByUserId   String?
  cancelPaidAt         DateTime?
  staffFrozenAt        DateTime?
}

/// One row per club: owner-configurable defaults for the workflows above.
model ClubScheduleSettings {
  clubId                   String   @id
  // who hears "Needs coverage" (any combination)
  coverageNotifyOwners     Boolean  @default(true)
  coverageNotifyManagers   Boolean  @default(true)    // everyone with schedule:edit
  coverageNotifyClassStaff Boolean  @default(true)    // other coaches on that class
  coverageNotifyRoleNames  Json     @default("[]")    // e.g. ["Head Coach"] — matches assignment role names
  coverageNotifyUserIds    Json     @default("[]")    // specific staff
  coverageChannels         Json     @default("["IN_APP","EMAIL"]")
  // default audience when a class occurrence is cancelled; the canceller can override it each time
  classCancelNotifyDefault String   @default("BOOKED") // BOOKED | CLASS_MEMBERS | BOTH | NONE
  payLedgerStartsOn        DateTime? @db.Date          // rule 7: set once, at cut-over
  updatedByUserId          String?
  updatedAt                DateTime @updatedAt
  @@map("club_schedule_settings")
}
```

**Late call-out (confirmed).** A call-out is always accepted, right up to class time. Inside 2 hours of the
start it is stamped `lateCallout`, shown at the top of Action Items, and the notice to the coverage group says
"Late call-out". Channels: in-app + email now; `coverageChannels` already allows `PUSH` to be added as an
owner-configurable channel once the mobile app supports it.

**Coverage flow.** Coach taps "I can't make it" (one day or a range) → their row becomes `NEEDS_COVERAGE` with
who/when/why → recipients from `ClubScheduleSettings` are notified (existing in-app Message + email path) → the
class stays scheduled and shows a "Needs coverage" badge to staff → a schedule manager picks the replacement:
the original row becomes `REPLACED`, a `SUBSTITUTE` row is created pointing at it → both coaches are told. A
manager can also close it with `REMOVED` (no replacement needed). If nobody acts, the row stays
`NEEDS_COVERAGE` and is surfaced in the Action Center; it does not pay.

**Worked (derived, never typed):** `endsAt < now` AND (`not canceled` OR `cancelPaid`) AND `status = SCHEDULED`.

**Cancel flow.** Cancel sheet asks for reason, audience (default from settings, overridable: booked members /
everyone associated with the class / both / nobody) and pay (unpaid / paid, pay choice needs `finances:full`).
Everything chosen is stored on the session; each notice is logged as an `EmailSend` row like other sends.
"Associated with the class" (confirmed) = members whose **active** membership currently gives access to that
class, plus anyone currently booked into that occurrence. Past attendance alone never qualifies — former or
inactive athletes are not emailed.

**Edit scopes.** This occurrence → that day's staff rows. This weekday forward → close the rule, open one with
`dayOfWeek` + `effectiveFrom`. All future → same without `dayOfWeek`. Rule changes regenerate only days from
today forward that nobody edited by hand.

## Migration B — pay plans (additive + one constraint change)

```prisma
model StaffCompensation {       // many named, dated plans per coach
  // userId String @unique  →  drop the unique; add @@index([clubId, userId])
  name          String    @default("Pay plan")      // "Tadpoles Lead", "Jr Frogs Assistant"
  effectiveFrom DateTime  @db.Date @default(now())
  effectiveTo   DateTime? @db.Date
  copiedFromId  String?         // provenance only — the copy is fully independent
  archivedAt    DateTime?
  // SALARY = baseAmount per pay period (rule 4)
}
// CompensationAssignment.scopeType gains: ROLE (scopeId = role name) | EVENT_TYPE | CLASS_RULE. No column change.
```

- **Copy pay plan**: pick a coach → pick one of their plans → pick the receiving coach(es). Creates a new plan
  (base, bonuses, scopes copied; `copiedFromId` set). Editing either one never affects the other. Needs
  `finances:full`; nobody can copy a plan to themself.
- Plans are edited in place or ended and re-versioned, never deleted and recreated.
- Matching, most specific first: CLASS_RULE → CLASS + ROLE → CLASS → ROLE → EVENT_TYPE → unscoped plan.
  A tie or no match → pay line `NEEDS_REVIEW`.

## Migration C — pay ledger (additive)

```prisma
model PayLine {
  id            String    @id @default(cuid())
  clubId        String
  userId        String
  sourceType    String    // CLASS_SESSION | EVENT | PRIVATE_LESSON | SALARY | BONUS | ADJUSTMENT
  sourceId      String    // ClassSessionStaff.id, EventCompAssignment.id, PrivateBooking.id, period key…
  component     String    @default("BASE")
  workDate      DateTime  @db.Date
  description   String
  units         Decimal   @db.Decimal(10, 4)
  rateCents     Int?
  amountCents   Int?                              // null while NEEDS_REVIEW
  rateSource    String    @default("PLAN")        // PLAN | OVERRIDE | MANUAL
  planId        String?
  planName      String?                           // snapshot
  planAmountCents Int?                            // what the plan would have paid, kept when overridden
  overrideReason  String?
  overrideByUserId String?
  status        String    @default("ESTIMATED")   // ESTIMATED | NEEDS_REVIEW | APPROVED | PAID | VOID
  reviewReason  String?
  payoutId      String?
  periodStart   DateTime? @db.Date
  periodEnd     DateTime? @db.Date
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  @@unique([userId, sourceType, sourceId, component])
  @@index([clubId, userId, workDate])
  @@index([clubId, status])
  @@index([payoutId])
  @@map("pay_lines")
}

model Payout {                  // new columns only
  periodStart DateTime? @db.Date
  lockedAt    DateTime?         // set when PAID; then void + reissue only
}
```

- **Override path**: set on the assignment (`payOverrideCents`) before or after the class; the pay line takes
  `rateSource = OVERRIDE`, keeps `planAmountCents` for comparison, and can also be overridden directly while it
  is still unpaid. Every set/change/clear writes the existing audit log (`BillingAuditLog`: who, when, before,
  after, reason) and a `StaffActivity` PAY line. Requires `finances:full`; the self rule blocks overriding your
  own pay. A PAID line is locked.
- Lines are created only for occurrences that have ended, on or after `payLedgerStartsOn`.

**Cut-over (rule 7).** A pre-deployment script prints, per coach: pay schedule, last paid payday, the current
period's dates, and the old calculator's amount for it. If any period is in progress it stops there. Julian
picks, per the output, whether that period stays on the old calculation or becomes the first ledger period;
only then is `payLedgerStartsOn` set. Nothing before that date ever gets a pay line.

## Migration D — per-coach calendar link (additive)

```prisma
model StaffCalendarFeed {
  id             String    @id @default(cuid())
  clubId         String
  userId         String    @unique
  token          String    @unique
  createdAt      DateTime  @default(now())
  rotatedAt      DateTime?
  lastAccessedAt DateTime?
  @@map("staff_calendar_feeds")
}
```

## Migration E — cleanup (destructive, last, separate release)
Drop `assignedStaffIds`, `staffOverride`, `PrivateLessonPayRate`, the four `StaffProfile` rate columns — only
after a release where old and new sources were compared and matched.

## What is reused, not duplicated
`RecurringClass`, `ClassSession`, `StaffCompensation`, `CompensationBonus`, `CompensationAssignment`,
`EventStaffAssignment`, `EventCompAssignment`, `Payout`, `StaffPaySchedule`, `Message`/email sending,
`BillingAuditLog`, `StaffActivity`, `effectiveClassStaff` (single resolver), `computeStaffPayout` (single
engine), the `EventShareLink` token pattern, the live permission guards and self rule.
New tables: 5 (`ClassStaffRule`, `ClassSessionStaff`, `ClubScheduleSettings`, `PayLine`, `StaffCalendarFeed`).

## History — no backfill (decided 2026-10-07)
Julian tracks past coaching himself, so **past class days are not frozen or backfilled**. The new tables are
populated only from the start date forward: `ClassSessionStaff` rows are written for class days on or after the
scheduling cut-over, and `PayLine`s only on or after `payLedgerStartsOn`. Earlier class days keep reading the
old coach lists exactly as today and are left alone. Consequence to remember at Migration E: dropping the old
columns would leave pre-cut-over days with no coach on record — so that cleanup stays parked until Julian says
the old data is no longer needed. The review sheet (`class-history-review-2026-10-07.xlsx`) is kept for
reference only.

## Open items
None — all questions answered. Awaiting go-ahead to build Migration A.

## Build notes — Branch 1 stage 2 (API, 2026-10-08)
- **Old coach list frozen, not dual-written.** Once a club is switched on, `RecurringClass.assignedStaffIds` is
  never written again: it stays the record of who coached before the start date. The class's coaches "now" come
  from the rules. The per-day `staffOverride` copy is still kept in step for days on/after the start date, so
  older screens and exports show the right people on each day.
- **Old screens keep working.** The existing class editor / calendar routes keep their URLs; for a switched-on
  club they write rules and day rows. A whole-list save from an old screen is applied as a diff (people removed
  come off, people added go on every class day) so a Tuesday-only coach is not turned into an every-day coach.
- **Availability warnings** are only raised for a coach who has saved hours or time off — "no hours saved" is not
  "outside their hours".
- **Un-cancel does not email families again**; the screen is told how many were notified of the cancellation.
- No schema change in stage 2.


## Build notes — Branch 1 QA pass (2026-10-08)
- **A reason is required to cancel a class day** on `POST /api/classes/sessions/[sessionId]/cancel` (400 `BAD_INPUT`
  without one) — it was only enforced on the screen.
- **The assignment preview refuses what the save refuses**: someone who is not current staff of this club →
  400 `INVALID_STAFF` from `POST /api/classes/[id]/staffing/preview` (it used to describe the change as fine).
- **`GET /api/staff/schedule` returns `today`** (the club's calendar day). The "Needs coverage" strip and "I'm out
  for several days" start from it, not from the viewer's device date. "Called out …" / "Canceled …" times in the
  class-day sheet read on the club's clock.
- **Words for a rule change dated before an already-planned one** name what is dropped ("Adrian, who was due to
  start Oct 20, will not be added"). The planner is unchanged: from the chosen date on, that weekday (or every
  class day) is exactly the ticked list.
- **Coach editor**: switching the scope re-reads who is on it for that scope and carries over only what was
  ticked, unticked or re-roled (a one-day substitute is no longer carried into a weekly change). On "Every class
  day" it names the coaches who are on only some weekdays and would come off.
- **Classes → Change coaches** opens the next class day that is neither canceled nor already over.
- Open, not changed (needs a decision): removing a staff member does not end their coach rules or take them off
  future class days (`endUserRules` exists for it and is not called from `DELETE /api/staff/[id]`).
