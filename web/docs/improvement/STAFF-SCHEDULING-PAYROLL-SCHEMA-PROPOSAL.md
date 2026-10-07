# Staff scheduling & payroll — proposed schema, migrations and history freeze

_Proposal only (2026-10-07). Nothing here is applied or built. Follows STAFF-SCHEDULING-PAYROLL-AUDIT.md and
Julian's six decisions of 2026-10-07._

## Decisions this is built on
1. Cancelled class = no pay by default; an authorized admin can mark one cancelled occurrence "cancelled but paid".
2. A substitute is paid from **their own** matching plan for that class/role. No match → flagged for admin review,
   never another coach's rate.
3. No manual "completed" marking. After an occurrence's end time the assigned coach is presumed to have worked
   unless: cancelled, marked no-show, replaced by a substitute, or changed by an admin. Future occurrences never pay.
4. Salary = fixed amount per pay period. No automatic proration.
5. Role names and plan names are free text. "Copy pay" copies a named plan from one coach to another (pick which
   one when the source has several). The copy belongs to the receiving coach — that is how Adrian earns Furman's
   rate when he covers, without ever reading Furman's plan at pay time. **(To confirm — see end.)**
6. Only schedule managers assign. A coach may only remove themself, which notifies the other coaches.
   (Already enforced by the security branch.)

## Migration A — assignments (additive, no existing column changes)

```prisma
/// The recurring assignment. Replaces RecurringClass.assignedStaffIds.
model ClassStaffRule {
  id              String    @id @default(cuid())
  clubId          String
  classId         String
  userId          String
  roleName        String?               // free text: "Lead", "Assistant", anything
  dayOfWeek       Int?                  // null = every day the class meets; 0–6 = that weekday only
  effectiveFrom   DateTime  @db.Date
  effectiveTo     DateTime? @db.Date    // null = ongoing
  createdByUserId String?
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  @@index([classId, effectiveFrom])
  @@index([clubId, userId])
  @@map("class_staff_rules")
}

/// Who is on ONE class day. Replaces ClassSession.staffOverride. This row is the historical record.
model ClassSessionStaff {
  id              String   @id @default(cuid())
  clubId          String
  sessionId       String                // → ClassSession, cascade
  userId          String
  roleName        String?
  kind            String   @default("REGULAR")    // REGULAR | SUBSTITUTE
  replacesUserId  String?                          // set on a SUBSTITUTE row
  status          String   @default("SCHEDULED")   // SCHEDULED | NO_SHOW | REPLACED
  source          String   @default("RULE")        // RULE | MANUAL | BACKFILL
  ruleId          String?                          // the rule that generated it, if any
  note            String?
  changedByUserId String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  @@unique([sessionId, userId])
  @@index([clubId, userId])
  @@map("class_session_staff")
}

model ClassSession {            // new columns only
  canceledAt        DateTime?
  canceledByUserId  String?
  cancelReason      String?
  cancelPaid        Boolean  @default(false)   // decision 1
  cancelPaidByUserId String?
  staffFrozenAt     DateTime?                  // set when the day's staff rows were written as history
}
```

- "Worked" is **derived**, not stored (decision 3): `endsAt < now` AND (`not canceled` OR `cancelPaid`) AND row
  `status = SCHEDULED`. Only the exceptions (NO_SHOW, REPLACED, cancel) are ever recorded by a person.
- Edit scopes: *this occurrence* → edit that day's `ClassSessionStaff` rows (source MANUAL); *this weekday going
  forward* → close the old rule (`effectiveTo`), open a new one with `dayOfWeek` + `effectiveFrom`; *all future* →
  same without `dayOfWeek`. After a rule change, only days **from today forward** that nobody edited by hand are
  regenerated — the same "never touch the past" rule `syncFutureSessions` already follows.
- A nightly job keeps every ongoing class materialized N days ahead (sessions + their staff rows), fixing the
  365-day cliff.
- `effectiveClassStaff` stays the single resolver; it reads `ClassSessionStaff` once readers are switched.
- `RecurringClass.assignedStaffIds` and `ClassSession.staffOverride` stay, and keep being written in parallel,
  until a later release proves both sources agree. They are dropped last, in their own migration.

## Migration B — pay plans (additive + one constraint change)

```prisma
model StaffCompensation {       // becomes: many named, dated plans per coach
  // userId  String @unique     →  drop the unique, add @@index([clubId, userId])
  name          String    @default("Pay plan")   // free text (decision 5)
  effectiveFrom DateTime  @db.Date @default(now())
  effectiveTo   DateTime? @db.Date
  copiedFromId  String?                          // provenance of a "copy pay"
  archivedAt    DateTime?
  // baseType SALARY now means "baseAmount per pay period" (decision 4)
}

model CompensationAssignment {  // scopeType gains three values; no column change
  // CLASS | EVENT | MEMBERSHIP | PRIVATE_LESSON_TYPE | ROLE (scopeId = role name) | EVENT_TYPE | CLASS_RULE
}
```

- Saving a plan edits it in place or ends it and starts a new version; it is never deleted and recreated.
- Matching, most specific first: CLASS_RULE → CLASS + ROLE → CLASS → ROLE → EVENT_TYPE → the coach's unscoped
  plan. Two plans matching at the same level, or none → the pay line is flagged for review (decision 2).
- `PrivateLessonPayRate` and the four `StaffProfile` rate columns are unused by payroll today; they are folded
  into plans and dropped in the final cleanup migration.

## Migration C — the pay ledger (additive)

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
  amountCents   Int?                         // null while NEEDS_REVIEW
  planId        String?
  planName      String?                      // snapshot — survives later plan edits
  status        String    @default("ESTIMATED")  // ESTIMATED | NEEDS_REVIEW | APPROVED | PAID | VOID
  reviewReason  String?                      // "No pay plan matches Adrian for Jr Frogs / Lead"
  payoutId      String?
  periodStart   DateTime? @db.Date
  periodEnd     DateTime? @db.Date
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  @@unique([userId, sourceType, sourceId, component])
  @@index([clubId, userId, workDate])
  @@index([payoutId])
  @@map("pay_lines")
}

model Payout {                  // new columns only
  periodStart DateTime? @db.Date
  lockedAt    DateTime?         // set when PAID; after that: void + reissue only, with an audit entry
}
```

- Lines are written only for occurrences whose end time has passed (decision 3). A line's amount is integer cents
  with the rate and plan name saved at that moment, so later raises or schedule edits cannot change a closed period.
- Reports read lines for closed periods and the live estimate for the open one. `lib/payroll.ts` (the duplicate
  calculator) is removed.

## Migration D — per-coach calendar link (additive)

```prisma
model StaffCalendarFeed {
  id             String    @id @default(cuid())
  clubId         String
  userId         String    @unique
  token          String    @unique      // random, same generator as EventShareLink
  createdAt      DateTime  @default(now())
  rotatedAt      DateTime?
  lastAccessedAt DateTime?
  @@map("staff_calendar_feeds")
}
```
Deleted automatically when the coach is removed. The shared club-wide STAFF link is retired afterwards.

## Migration E — cleanup (destructive, last, separate release)
Drop `assignedStaffIds`, `staffOverride`, `PrivateLessonPayRate`, the `StaffProfile` rate columns — only after a
full release where old and new sources were compared and matched.

All of A–D follow house rules: RLS policy per new table, `IF NOT EXISTS`, backup before each, applied by Julian.

## Freezing historical class-day coaches

### Why this cannot be automatic
Today 144 past class days exist, none with a per-day coach list — each one reads the class's **current** list.
Production shows that list is not a reliable record of who was actually there:

| Class | Past days | Coaches on the class today | Who took attendance (days) |
|---|---|---|---|
| Girls Class | 16 | nobody | Kate 4, Julian 1, Sal 1 |
| Jr Frogs | 34 | Sal J, Josh A | Sal 21, Julian 5 |
| Ms/HS Olympic Season | 22 | Sal J, Julian R | Sal 10, Julian 4 |
| MS/HS Preseason | 29 | Sal J, Julian R | Sal 18, Julian 8 |
| Sunday Funday | 17 | Sal J, Julian R | Sal 6, Julian 5 |
| Tadpoles | 26 | Matt F | Julian 6, Sal 2, Matt 1, Isaiah 1 |

Freezing the current lists blindly would record "nobody coached Girls Class" and "Matt coached every Tadpoles
day". So the freeze is a reviewed step, not a silent backfill.

### The procedure
1. **Dry-run script** (`scripts/freeze-class-history.ts`, read-only by default) writes a review sheet: one row
   per past class day — class, date, time, proposed coaches (today's list), who took attendance that day, and a
   flag when there is no coach or the attendance-taker isn't on the list.
2. **Julian corrects it** in the sheet. Two ways: a range rule per class ("Tadpoles, Jul 8 – Sep 30: Julian") or
   single days. Rows he leaves alone keep the proposed coaches. Role names optional.
3. **Second dry run** reads the corrected sheet and prints exactly what will be written, with totals per coach per
   month, so the result can be checked against what people were actually paid.
4. **Backup, then apply** (`--apply --sheet=<file>`): one transaction; writes `ClassSessionStaff` rows with
   `source = BACKFILL` and sets `staffFrozenAt` on each past day. It refuses to run if any class day changed since
   the dry run (it compares a fingerprint), and it touches only the two new tables' rows.
5. **Read-back check**: counts per class and per coach must equal the approved sheet; mismatches roll back.
6. **Rules for the future**: `ClassStaffRule` rows are created from today's coach lists with
   `effectiveFrom = the cut-over date`, and future days get their staff rows from those rules.

### Why it is safe
- Only new tables are written; the old columns are untouched, and the app keeps reading them until a later
  release. Undo = delete rows where `source = 'BACKFILL'`.
- Past **pay** is not recalculated: the new ledger starts at a chosen cut-over payday. The frozen history matters
  for schedules, reports and audit, and before any reader is switched a parity report compares old vs. new
  payroll for every past month.

## To confirm before building
1. "Copy pay" as read above: a copy creates the receiving coach's own named plan (so decision 2 still holds).
   Or should a substitute be able to be paid "as Furman" for one day without having a plan of their own?
2. Cut-over payday for the new ledger.
3. Should cancelling a class notify booked families? (Today nothing is sent.)
