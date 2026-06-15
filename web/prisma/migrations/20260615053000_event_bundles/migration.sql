-- Event bundling (#3): discounted packages of events.
-- A bundle has its own single price; registering for it books the member into
-- every included event in one payment. New tables only — safe on a live DB.

CREATE TABLE "event_bundles" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" DECIMAL(10,2) NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "event_bundles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "event_bundle_items" (
    "bundleId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    CONSTRAINT "event_bundle_items_pkey" PRIMARY KEY ("bundleId", "eventId")
);

CREATE INDEX "event_bundles_clubId_idx" ON "event_bundles"("clubId");
CREATE INDEX "event_bundle_items_eventId_idx" ON "event_bundle_items"("eventId");

ALTER TABLE "event_bundles" ADD CONSTRAINT "event_bundles_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "event_bundle_items" ADD CONSTRAINT "event_bundle_items_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "event_bundles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "event_bundle_items" ADD CONSTRAINT "event_bundle_items_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
