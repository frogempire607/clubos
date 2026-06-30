-- P1 Tournament invoicing: scheduled invoice date + itemized expense breakdown.

-- 1) Scheduled send date on the event (null = invoice immediately).
ALTER TABLE "events" ADD COLUMN "invoiceScheduledAt" TIMESTAMP(3);

-- 2) Expense line items (entry fee, coaching, hotel, transport, uniform, misc).
CREATE TABLE "event_expense_items" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'MISC',
    "amount" DECIMAL(10,2) NOT NULL,
    "description" TEXT,
    "perAthlete" BOOLEAN NOT NULL DEFAULT false,
    "receiptFileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_expense_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "event_expense_items_eventId_idx" ON "event_expense_items"("eventId");
CREATE INDEX "event_expense_items_clubId_idx" ON "event_expense_items"("clubId");

ALTER TABLE "event_expense_items"
    ADD CONSTRAINT "event_expense_items_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
