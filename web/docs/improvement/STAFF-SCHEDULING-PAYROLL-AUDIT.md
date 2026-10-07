# Staff scheduling & payroll — audit and target architecture

_Audit of `main` @ `efa72f0` (B32), 2026-10-07. Read-only: no code, schema or data was changed.
Production facts were checked read-only against Supabase the same day._

## 1. Current data architecture

### Classes and recurring schedules — `RecurringClass` (schema ~L3603)
- One row per class: `daysOfWeek` (JSON `[0..6]`), default `startTime`/`endTime` ("HH:mm"), `dayOverrides`
  (per-weekday times), `recurrenceStartDate`, `recurrenceEndDate?`, `capacity`, `active`, `deletedAt`.
- Coaches: `assignedStaffIds` — a flat JSON list of user ids for the whole series. No role, no dates,
  no per-weekday list, no foreign key.
- Weekly only. No exclusion dates, no closures/holiday model, no timezone on the class (wall-clock times).

### Individual occurrences — `ClassSession` (schema ~L3646)
- **Real rows**, unique on `(classId, date)` (index confirmed applied in production).
- Created 365 days ahead when the class is created (`lib/classSessions.ts` `buildSessions`) and reconciled
  from today forward when the schedule is edited (`lib/classSessionSync.ts`). **No job extends the horizon.**
- Fields: `date`, `startsAt`, `endsAt` (wall clock stamped as UTC), `canceled` (boolean), `staffOverride`
  (JSON: null = inherit series, `[]` = nobody, list = substitutes), `note`, `overridden`.
- No cancel reason / who / when, no status, no snapshot of who coached.
- Coach for an occurrence is resolved **live**: `effectiveClassStaff(series.assignedStaffIds, session.staffOverride)`
  (`lib/staffAssignments.ts:75`). One resolver, used by schedule, calendar, member pages and payroll.
- Two read models coexist: `/api/staff/schedule` expands virtually with a row overlay
  (`classOccurrencesInRange`); calendar, booking, attendance, ICS feed and **payroll read rows only**.

### Events and private lessons
- `Event` + `EventSession` (true instants). Staff: `EventStaffAssignment` rows `{eventId, userId, role}`,
  unique per event+user, whole-event only. `role` is a free string and is never used for pay.
- Private lessons: `PrivateBooking.coachId` (one coach), statuses REQUESTED → … → COMPLETED/CANCELED.
  They appear on the calendar and staff ICS feed but **not** on the staff schedule.

### Staff, roles, permissions
- Staff = `User` with role OWNER or STAFF, not deleted. `StaffProfile` is optional (permissions JSON, bio,
  legacy pay fields `hourlyRate/salary/perSessionRate/appointmentPrice` that payroll never reads).
- Contractors (`Contractor`) have no login and cannot be assigned to classes, events or lessons.
- Permissions: 11 areas × levels (none/view/edit|send/full) in `StaffProfile.permissions`; snapshot in a
  14-day JWT (`requirePermission`), or read live with a 20s cache (`requirePermissionLive`).
- Self rules: `lib/staffSelf.ts` — a non-owner can never edit their own pay, access, record, or remove themself.

### Pay plans
- `StaffCompensation`: **one plan per coach** (`userId @unique`): `baseType` SALARY | PER_CLASS | HOURLY +
  `baseAmount`. Saving a plan deletes and recreates it — **no history**.
- `CompensationBonus`: ATTENDANCE / SIGNUP ($ per head), REVENUE_SHARE (%), with thresholds.
- `CompensationAssignment`: a scope filter (CLASS | EVENT | MEMBERSHIP | PRIVATE_LESSON_TYPE) on the base or a
  bonus. It includes/excludes; it does not carry a different rate.
- `EventCompAssignment`: per event, per payee: FLAT or PERCENT of collected revenue → one `Payout`.
- `PrivateLessonPayRate`: has an API, no UI caller, and no calculator reads it.
- `Payout`: the ledger. `amount`, `status` PENDING/PAID/VOID, `kind`, `payPeriodEnd?`, `eventId?`. No lines,
  no period start, no link to the sessions it pays for, no unique constraint.
- `StaffPaySchedule`: payday frequency per coach (drives reminders).

### Attendance and cancellations
- `AttendanceRecord`: member + `classSessionId` (or `eventId`). A booking is stored as PRESENT with
  `checkedInAt = null`; no unique constraint. **Staff attendance is not recorded anywhere.**
- Cancelling an occurrence sets `ClassSession.canceled = true`. Nothing else happens: no notification, bookings
  untouched, no reason stored. Events have no cancel state (soft delete only).

## 2. Trace: a scheduled class → a payroll amount
1. `POST /api/classes` creates the class and its `ClassSession` rows (365 days).
2. The Payroll page (or a payday reminder) asks `computePayroll(clubId, from, to)` (`lib/payrollCalc.ts:31`).
3. It loads `ClassSession` where `canceled = false` and `startsAt` is in range. No check that the class ran,
   that it is in the past, or that the class isn't deleted.
4. For each session the coach list is `effectiveClassStaff(...)` — the **current** series list unless that
   day has an override.
5. Minutes = `endsAt − startsAt`. The coach's single plan is loaded; CLASS scopes filter which sessions count.
6. `computeStaffPayout` (`lib/compensation.ts:97`): SALARY = flat amount for any range; PER_CLASS = amount ×
   sessions; HOURLY = amount × hours (rounded to 2 dp first); bonuses added.
7. The result is returned as JSON and shown. **Nothing is stored.**
8. Money reaches the ledger only when someone presses "Mark paid" (amount prefilled, editable) or adds a
   payout by hand → a `Payout` row with a typed amount.
9. Reports read the **recomputed** figure (`lib/payroll.ts`, a near-copy of the calculator), never `Payout`.

Consequences: changing a coach on a series, a rate, or a past session changes already-paid periods in every
report; an ongoing class silently pays $0 once its rows run out; future sessions in the range count as taught.

## 3. Requirements vs. what exists

| # | Requirement | Today | Verdict |
|---|---|---|---|
| 1 | Recurring staff assignments | `assignedStaffIds` list on the series | Partly — no role, no dates, no per-weekday |
| 2 | One-occurrence assignments | `ClassSession.staffOverride` | Works, but replaces the whole list; no role |
| 3 | This occurrence / this weekday forward / all future | occurrence ✔; "following" = bulk write to existing rows (not a rule, all weekdays); series rewrites the past | Only "this occurrence" is sound |
| 4 | Multiple comp plans per coach | `userId @unique` | No |
| 5 | Rules tied to class / role / event type / assignment | scopes include/exclude only; one base rate | No |
| 6 | Substitutes | override list; sub paid at own plan; bonuses still go to the regular coach | Partly, with a double-pay bug |
| 7 | Cancelled / missed classes affect pay | cancelled rows excluded for per-class/hourly; no "cancelled but paid", no coach no-show | Partly |
| 8 | Secure per-coach calendar export | one club-wide STAFF feed, cannot be revoked, no "my classes" | No |
| 9 | Staff cannot edit other staff unless authorized | self rules solid on pay; several real holes (§4) | Partly |

## 4. Problems to fix regardless of the overhaul (found during the audit)
- `PATCH /api/classes/[id]` is role-only: any staff login can change a class and its coaches.
- The build's permission guard checks files, not handlers — so the hole above passes it. Same pattern in
  members, memberships, products, expenses, message groups PATCH/POST (to verify one by one).
- `staff:full` can create an OWNER and can generate a setup link for an owner account.
- Removing a staff member doesn't end their session (14-day token).
- `GET /api/staff/schedule` and `GET /api/staff` over-share (everyone's availability; legacy pay fields).
- Event pay (`/api/events/[id]/comp`, generate-payouts) has no self rule and uses the stale token guard.
- Paid payouts can be edited or hard-deleted through the API with no audit entry.
- Sub-scope permissions never reach the session token, so those grants don't take effect.

## 5. Target architecture (extend, don't duplicate)

**Principle: the occurrence row is the record of what happened. Rules only generate the future.**

### Scheduling
- Keep `RecurringClass` and `ClassSession` as they are. Add a nightly top-up so every ongoing class always has
  rows N days ahead (same Netlify cron pattern as pay reminders).
- **`ClassStaffRule`** (new, replaces `assignedStaffIds`): `classId, userId, role, dayOfWeek? (null = every
  class day), effectiveFrom, effectiveTo?`. This is the recurring assignment, and it is what makes "this
  weekday going forward" and "all future from a date" real rules.
- **`ClassSessionStaff`** (new, replaces `staffOverride`): `sessionId, userId, role, kind REGULAR|SUBSTITUTE,
  replacesUserId?, workStatus ASSIGNED|WORKED|NO_SHOW|EXCUSED`. Mirrors the shape `EventStaffAssignment`
  already has. Rows are written when sessions are materialized, so the past never changes when a rule does.
- Edit scopes become: this occurrence → edit that session's staff rows; this weekday forward → end the old
  rule, start a new one with `dayOfWeek` + `effectiveFrom`, regenerate future untouched sessions; all future →
  same without `dayOfWeek`.
- `ClassSession` gains `canceledAt, canceledByUserId, cancelReason, cancelPayPolicy (PAY | NO_PAY | PARTIAL)`.
- `effectiveClassStaff` stays the single resolver; its inside changes. Every reader already goes through it.
- `EventStaffAssignment`: normalize `role` to the same role list; optional `eventSessionId` later.

### Pay
- `StaffCompensation` becomes a **versioned plan, many per coach**: drop the unique, add `name`,
  `effectiveFrom`, `effectiveTo`, stop delete-and-recreate. Each plan keeps base + bonuses.
- `CompensationAssignment` gains scope types `ROLE`, `EVENT_TYPE`, `ASSIGNMENT` (a `ClassStaffRule` or event
  assignment). Resolution, most specific first: assignment → class → role → event type → default plan.
- Fold `PrivateLessonPayRate` and the legacy `StaffProfile` rate fields into plans; retire them.
- **`PayLine`** (new, the missing ledger detail): one row per coach per unit of work — `source`
  (CLASS_SESSION | EVENT | PRIVATE | BONUS | ADJUSTMENT), `sourceId`, `workDate`, `units`, `rateSnapshot`,
  `amountCents`, `planId`, `status` ESTIMATED → APPROVED → PAID, `payoutId?`. Unique on (staff, source, sourceId, kind).
- `Payout` gains `periodStart` and owns its lines; a PAID payout is locked (void + reissue, audit entry).
- `computeStaffPayout` remains the engine but writes lines when a period is closed; reports read lines for
  closed periods and the live estimate for open ones. Delete the duplicate `lib/payroll.ts`.
- Event pay (`EventCompAssignment` → generate-payouts) writes `PayLine`s too, so there is one pipeline.

### Calendar export
- **`StaffCalendarFeed`** (new, modeled on `EventShareLink`): random token per coach, rotate / turn off,
  auto-revoked when the coach is removed. Reuses `lib/calendarFeed.ts`, filtered to that coach's
  `ClassSessionStaff`, `EventStaffAssignment` and private lessons. Retire the shared STAFF feed.

### Permissions
- Make the guard handler-level; close every role-only handler; live guards on all money and assignment writes.
- Extend `selfRule` with `edit_assignment` (a coach paid per class may not assign themself unless allowed).
- "Own schedule only" read scope for coaches; pay fields never ride along on staff list responses.

## 6. Schema changes and migration risk
Production is small, which makes this the right time: 6 classes, 465 sessions, **0 overrides, 0 cancelled
sessions**, 6 pay plans (1 salary, 5 per-class), 8 scope rows, 4 bonuses, 1 payout, 0 event comp rows,
0 private-lesson rates, 1 staff member with `staff:full`.

| Change | Risk | Mitigation |
|---|---|---|
| Backfill `ClassStaffRule` from `assignedStaffIds` | Low | 1:1; keep the JSON column written in parallel until readers are switched |
| Backfill `ClassSessionStaff` for all 465 sessions | **Medium — this freezes history** | Past sessions get today's series list; show Julian the list per class before applying, since that's what past pay will read |
| Drop `StaffCompensation.userId` unique, add dates | Low | existing plans become "current plan, effective from createdAt" |
| `PayLine` + payout lock | Low (1 payout) | no backfill of past periods; start from a chosen cut-over payday |
| Cancel fields, feed table, role enum | Low | additive |
| Session top-up job | Low | idempotent on `(classId, date)` |
| Removing `assignedStaffIds` / `staffOverride` | Medium | last step, after a release where both are written and compared |

All migrations additive first; destructive drops only after a verified release. Backup before each, as usual.

## 7. Suggested order
0. Security fixes from §4 (independent, small).
1. Session top-up job + cancel fields.
2. `ClassStaffRule` + `ClassSessionStaff` behind `effectiveClassStaff`; three edit scopes; substitutes.
3. Versioned multi-plan pay + new scope types.
4. `PayLine`, period close, payout lock, reports read lines.
5. Per-coach calendar feed.
6. Remove the old JSON columns and dead rate fields.

## 8. Decisions needed before building
1. Cancelled class: is the coach paid? (never / always / chosen per cancellation / only if cancelled inside X hours)
2. Substitute: paid at their own rate, or at the rate set for that class?
3. Must a class be marked as "ran" (attendance taken or coach confirmed) before it pays, or is scheduled enough?
4. Salary: a fixed amount per pay period, or per month prorated to the period?
5. Role list for assignments (e.g. Lead, Assistant, Substitute) — and does role change pay?
6. May a coach assign themself to a class, or only someone with scheduling permission?
7. Cut-over date for the new pay ledger (which payday is the first one calculated from stored lines).
