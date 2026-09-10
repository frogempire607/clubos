-- One ClassSession per class per calendar day, enforced by the database.
--
-- WRITTEN BUT NOT APPLIED. Julian applies it:
--     cd web && npx prisma migrate deploy
--
-- READ THE PRECONDITION FIRST — this migration is designed to FAIL LOUDLY
-- rather than half-apply. It aborts unless `class_sessions` already satisfies
-- the constraint. Clear the six past duplicate days first:
--     npx tsx scripts/fix-past-duplicate-class-sessions.ts
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT WENT WRONG
-- ─────────────────────────────────────────────────────────────────────────────
-- `PATCH /api/classes/[id]` used to delete future sessions and regenerate them.
-- The delete deliberately spared any session carrying attendance — and a member
-- BOOKING a class is an AttendanceRecord. So moving Tadpoles from 5:30 to 6:15
-- left the already-booked rows at 5:30 and added a second row at 6:15 beside
-- each of them. `skipDuplicates` caught nothing, because `class_sessions` has no
-- unique constraint for it to match on. That is the hole this closes.
--
-- e1f3812 fixed the writer: lib/classSessionSync.ts now reconciles by date and
-- MOVES the booked row instead of forking it. A correct writer is not a
-- constraint, though — it is one call-site being careful. Nine other paths touch
-- this table (series regeneration, day overrides, the cancel flow, imports), and
-- the next one written will not know. This makes the invariant structural.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY A FULL UNIQUE INDEX AND NOT A PARTIAL ONE ON FUTURE ROWS
-- ─────────────────────────────────────────────────────────────────────────────
-- The partial option was considered and is NOT AVAILABLE as stated. Postgres
-- requires an index predicate to be IMMUTABLE, and CURRENT_DATE is STABLE:
--
--     CREATE UNIQUE INDEX ... ON "class_sessions"("classId","date")
--       WHERE "date" >= CURRENT_DATE;
--     ERROR:  functions in index predicate must be marked IMMUTABLE
--
-- The only partial index Postgres would accept freezes a literal — WHERE "date"
-- >= '2026-09-10' — which does not mean "future". It means "after the morning
-- someone wrote this migration". Every day that passes moves more rows from the
-- uncovered side to the covered side, so it converges on the full index anyway,
-- but with an arbitrary constant baked into the schema that no future reader can
-- interpret. A constraint whose coverage depends on when you look at it cannot
-- express "one session per class per day".
--
-- Three more reasons, in order of weight:
--
--   1. The past duplicates are not untidy, they are WRONG, and they are wrong
--      right now. Every duplicated past day double-counts attendance: the class
--      attendance rate, the "how full is this class" number, and any per-member
--      history spanning those days all read high today. A partial index freezes
--      that error into the record permanently and guarantees the numbers never
--      reconcile. Six days of bad data is worth six days of cleanup.
--
--   2. The set is finite, enumerated and closed — 08-18, 08-20, 08-23, 09-01,
--      09-02, 09-06. This is bounded work, not an open-ended migration project.
--
--   3. `@@unique([classId, date])` is a statement about the gym: a recurring
--      class has at most one occurrence on a given calendar day. That was true
--      in August. A partial index instead encodes "true since a bug was fixed",
--      which is a fact about our git history, not about the domain.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY NOT CONCURRENTLY
-- ─────────────────────────────────────────────────────────────────────────────
-- `CREATE UNIQUE INDEX CONCURRENTLY` cannot run inside a transaction block, and
-- `prisma migrate deploy` wraps each migration in one. It would abort. Plain
-- CREATE takes a lock that blocks writes to `class_sessions` for the duration —
-- acceptable here because the table holds one row per class per day per club,
-- so it is small by construction and the build is milliseconds.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ORDER OF OPERATIONS — this matters, do not shortcut it
-- ─────────────────────────────────────────────────────────────────────────────
--   1. Run the cleanup script until it reports zero past duplicate days.
--   2. Apply this migration.
--   3. ONLY THEN add `@@unique([classId, date])` to ClassSession in
--      prisma/schema.prisma.
--
-- `schema.prisma` is deliberately UNCHANGED in this commit. A `@@unique` naming
-- an index the database does not have is less immediately destructive than a
-- missing column — it will not fail every read the way 20260817000000's header
-- describes — but it silently changes write semantics: `createMany({
-- skipDuplicates: true })` starts claiming to deduplicate on a key Postgres is
-- not enforcing, which is the exact false assurance that produced these
-- duplicates in the first place. Land it after, not before.
--
-- The index name below is Prisma's own convention for `@@unique([classId,
-- date])` — `<table>_<col>_<col>_key`. It has to match exactly, or step 3 sees
-- drift and tries to create a second identical index.

-- ── Guard 1: `date` must be a true day boundary ──────────────────────────────
-- `date` is TIMESTAMP(3), and the uniqueness of (classId, date) is only the
-- uniqueness of a CALENDAR DAY if every value sits at midnight. lib/
-- classSessions.ts does `cur.setUTCHours(0,0,0,0)`, so this holds by
-- construction — but if any row carried a time component, two rows for the same
-- day would differ, the index below would be created happily, and it would
-- silently fail to enforce the thing it is named after. Check, do not assume.
DO $$
DECLARE
  offending BIGINT;
BEGIN
  SELECT count(*) INTO offending
  FROM "class_sessions"
  WHERE "date" <> date_trunc('day', "date");

  IF offending > 0 THEN
    RAISE EXCEPTION
      'class_sessions: % row(s) have a non-midnight "date". A unique index on (classId, date) would NOT enforce one-session-per-day for these. Normalise them first: UPDATE "class_sessions" SET "date" = date_trunc(''day'', "date") WHERE "date" <> date_trunc(''day'', "date"); -- then re-check for duplicates, because normalising can CREATE them.',
      offending;
  END IF;
END $$;

-- ── Guard 2: no duplicates may remain, and name them if they do ──────────────
-- CREATE UNIQUE INDEX would fail on its own here, but its error names a single
-- arbitrary key and gives no sense of scale. This lists every offending day, so
-- one failed run tells you exactly what the cleanup script still has to do.
DO $$
DECLARE
  dup_days BIGINT;
  detail   TEXT;
BEGIN
  SELECT count(*), string_agg(d, ', ' ORDER BY d)
    INTO dup_days, detail
  FROM (
    SELECT to_char("date", 'YYYY-MM-DD') || ' (class ' || "classId" || ' ×' || count(*) || ')' AS d
    FROM "class_sessions"
    GROUP BY "classId", "date"
    HAVING count(*) > 1
  ) s;

  IF dup_days > 0 THEN
    RAISE EXCEPTION
      'class_sessions: % (classId, date) group(s) still hold more than one row, so the unique index cannot be created. Run `npx tsx scripts/fix-past-duplicate-class-sessions.ts` and re-apply. Offending groups: %',
      dup_days, detail;
  END IF;
END $$;

-- ── The constraint ───────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "class_sessions_classId_date_key"
  ON "class_sessions" ("classId", "date");

-- NOTE, deliberately not done here: the existing `class_sessions_classId_idx`
-- (from @@index([classId])) is now redundant — the unique index above has
-- classId as its leftmost column and serves every query that one did. Dropping
-- it is a separate, reversible optimisation that also needs a schema.prisma
-- edit, and bundling an index drop into a constraint migration makes rollback
-- two decisions instead of one. Left alone on purpose.
