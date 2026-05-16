-- Mass-invoice tracking on event registrations
ALTER TABLE "event_registrations" ADD COLUMN "invoicedAt" TIMESTAMP(3);
ALTER TABLE "event_registrations" ADD COLUMN "invoiceCount" INTEGER NOT NULL DEFAULT 0;

-- Per-user dashboard widget preferences
ALTER TABLE "users" ADD COLUMN "dashboardWidgets" JSONB;
