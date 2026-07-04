-- Event group chats: a MessageGroup can be linked to one Event. Access to an
-- event-linked group follows registration (enforced in lib/eventChat.ts), so
-- the only schema change is the optional link. Additive + nullable — safe.
ALTER TABLE "message_groups" ADD COLUMN "eventId" TEXT;

CREATE UNIQUE INDEX "message_groups_eventId_key" ON "message_groups"("eventId");

ALTER TABLE "message_groups" ADD CONSTRAINT "message_groups_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
