-- Staff scheduling overhaul — Migration A: assignments, coverage, cancellation.
-- (docs/improvement/STAFF-SCHEDULING-PAYROLL-SCHEMA-PROPOSAL.md v3)
--
-- ADDITIVE ONLY. Three new tables and ten new nullable/defaulted columns on
-- class_sessions. Nothing existing is altered, renamed or dropped:
-- recurring_classes."assignedStaffIds" and class_sessions."staffOverride" stay
-- and keep being written (the app dual-writes them as the legacy mirror).
--
-- No data is written here. Until a club's
-- club_schedule_settings."assignmentsStartOn" is set (by
-- scripts/switch-on-class-assignments.ts, run by the owner), every reader
-- behaves exactly as before and the new tables stay empty.
--
-- Safe to re-run: IF NOT EXISTS everywhere; policies are dropped and recreated.
-- Apply BEFORE deploying code built against the new schema (Prisma selects the
-- new class_sessions columns on every read of that model).

-- ── class_sessions: cancellation audit + "edited by hand" flag ──────────────
ALTER TABLE "class_sessions" ADD COLUMN IF NOT EXISTS "canceledAt"           TIMESTAMP(3);
ALTER TABLE "class_sessions" ADD COLUMN IF NOT EXISTS "canceledByUserId"     TEXT;
ALTER TABLE "class_sessions" ADD COLUMN IF NOT EXISTS "cancelReason"         TEXT;
ALTER TABLE "class_sessions" ADD COLUMN IF NOT EXISTS "cancelNotifyAudience" TEXT;
ALTER TABLE "class_sessions" ADD COLUMN IF NOT EXISTS "cancelNotifiedCount"  INTEGER;
ALTER TABLE "class_sessions" ADD COLUMN IF NOT EXISTS "cancelPaid"           BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "class_sessions" ADD COLUMN IF NOT EXISTS "cancelPaidByUserId"   TEXT;
ALTER TABLE "class_sessions" ADD COLUMN IF NOT EXISTS "cancelPaidAt"         TIMESTAMP(3);
ALTER TABLE "class_sessions" ADD COLUMN IF NOT EXISTS "staffFrozenAt"        TIMESTAMP(3);
ALTER TABLE "class_sessions" ADD COLUMN IF NOT EXISTS "staffManual"          BOOLEAN NOT NULL DEFAULT false;

-- ── class_staff_rules: the recurring assignment ─────────────────────────────
CREATE TABLE IF NOT EXISTS "class_staff_rules" (
  "id"              TEXT NOT NULL,
  "clubId"          TEXT NOT NULL,
  "classId"         TEXT NOT NULL,
  "userId"          TEXT NOT NULL,
  "roleName"        TEXT,
  "dayOfWeek"       INTEGER,
  "effectiveFrom"   DATE NOT NULL,
  "effectiveTo"     DATE,
  "createdByUserId" TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "class_staff_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "class_staff_rules_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "class_staff_rules_classId_fkey" FOREIGN KEY ("classId") REFERENCES "recurring_classes"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- A coach with assignments cannot be hard-deleted out from under them (staff
  -- are soft-deleted). NO ACTION, not RESTRICT, so deleting a whole club —
  -- which cascades to both users and these rows — still goes through.
  CONSTRAINT "class_staff_rules_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "class_staff_rules_classId_effectiveFrom_idx"
  ON "class_staff_rules" ("classId", "effectiveFrom");
CREATE INDEX IF NOT EXISTS "class_staff_rules_clubId_userId_idx"
  ON "class_staff_rules" ("clubId", "userId");

-- ── class_session_staff: one coach on one class day ─────────────────────────
CREATE TABLE IF NOT EXISTS "class_session_staff" (
  "id"                     TEXT NOT NULL,
  "clubId"                 TEXT NOT NULL,
  "sessionId"              TEXT NOT NULL,
  "userId"                 TEXT NOT NULL,
  "roleName"               TEXT,
  "kind"                   TEXT NOT NULL DEFAULT 'REGULAR',
  "replacesStaffId"        TEXT,
  "status"                 TEXT NOT NULL DEFAULT 'SCHEDULED',
  "source"                 TEXT NOT NULL DEFAULT 'RULE',
  "ruleId"                 TEXT,
  "calledOutAt"            TIMESTAMP(3),
  "calledOutByUserId"      TEXT,
  "calloutReason"          TEXT,
  "lateCallout"            BOOLEAN NOT NULL DEFAULT false,
  "coverageFilledAt"       TIMESTAMP(3),
  "coverageFilledByUserId" TEXT,
  "payOverrideCents"       INTEGER,
  "payOverrideReason"      TEXT,
  "payOverrideByUserId"    TEXT,
  "payOverrideAt"          TIMESTAMP(3),
  "note"                   TEXT,
  "changedByUserId"        TEXT,
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3) NOT NULL,
  CONSTRAINT "class_session_staff_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "class_session_staff_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "class_session_staff_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "class_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "class_session_staff_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "class_session_staff_sessionId_userId_key"
  ON "class_session_staff" ("sessionId", "userId");
CREATE INDEX IF NOT EXISTS "class_session_staff_clubId_userId_idx"
  ON "class_session_staff" ("clubId", "userId");
CREATE INDEX IF NOT EXISTS "class_session_staff_clubId_status_idx"
  ON "class_session_staff" ("clubId", "status");

-- ── club_schedule_settings: one row per club ────────────────────────────────
CREATE TABLE IF NOT EXISTS "club_schedule_settings" (
  "clubId"                   TEXT NOT NULL,
  "coverageNotifyOwners"     BOOLEAN NOT NULL DEFAULT true,
  "coverageNotifyManagers"   BOOLEAN NOT NULL DEFAULT true,
  "coverageNotifyClassStaff" BOOLEAN NOT NULL DEFAULT true,
  "coverageNotifyRoleNames"  JSONB NOT NULL DEFAULT '[]',
  "coverageNotifyUserIds"    JSONB NOT NULL DEFAULT '[]',
  "coverageChannels"         JSONB NOT NULL DEFAULT '["IN_APP","EMAIL"]',
  "classCancelNotifyDefault" TEXT NOT NULL DEFAULT 'BOOKED',
  "payLedgerStartsOn"        DATE,
  "assignmentsStartOn"       DATE,
  "updatedByUserId"          TEXT,
  "updatedAt"                TIMESTAMP(3) NOT NULL,
  CONSTRAINT "club_schedule_settings_pkey" PRIMARY KEY ("clubId"),
  CONSTRAINT "club_schedule_settings_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- ── Row level security: same tenant policy as every other club table ────────
-- (20260702000000_enable_rls)
ALTER TABLE "class_staff_rules" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "class_staff_rules";
CREATE POLICY tenant_isolation ON "class_staff_rules" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK ("clubId" = app.current_club_id());

ALTER TABLE "class_session_staff" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "class_session_staff";
CREATE POLICY tenant_isolation ON "class_session_staff" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK ("clubId" = app.current_club_id());

ALTER TABLE "club_schedule_settings" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "club_schedule_settings";
CREATE POLICY tenant_isolation ON "club_schedule_settings" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK ("clubId" = app.current_club_id());
