-- ─────────────────────────────────────────────────────────────────────────
-- 2026-07-31 · Reports Phase 2.5.8 — M12 · ReportAlertSetting
-- ─────────────────────────────────────────────────────────────────────────
-- Owner-configurable thresholds that drive the Alerts surface + the Action
-- Items thresholds (UPCOMING_RENEWAL_LARGE, UNCATEGORIZED_LARGE_BANK).
-- Seeded lazily — the API returns defaults when a row is missing rather
-- than backfilling every club up-front.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "report_alert_settings" (
    "id"        TEXT NOT NULL PRIMARY KEY,
    "clubId"    TEXT NOT NULL,
    "kind"      TEXT NOT NULL,             -- AlertKind — string in code
    "threshold" DECIMAL(12, 2),
    "enabled"   BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_alert_settings_clubId_fkey"
        FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "report_alert_settings_clubId_kind_key"
    ON "report_alert_settings" ("clubId", "kind");
CREATE INDEX IF NOT EXISTS "report_alert_settings_clubId_idx"
    ON "report_alert_settings" ("clubId");

-- ─────────────────────────────────────────────────────────────────────────
-- ROLLBACK:
--   DROP INDEX IF EXISTS "report_alert_settings_clubId_idx";
--   DROP INDEX IF EXISTS "report_alert_settings_clubId_kind_key";
--   DROP TABLE IF EXISTS "report_alert_settings";
-- ─────────────────────────────────────────────────────────────────────────
