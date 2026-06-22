-- Two-way family messaging: a DM thread can now be "about" a specific athlete
-- (including a child with no portal login), so a guardian ↔ coach conversation
-- can be tagged per child. Additive + safe; existing messages stay NULL (= the
-- participant's own thread). Scalar column only (no FK) so historical messages
-- survive a member delete.
ALTER TABLE "messages" ADD COLUMN "subjectMemberId" TEXT;
CREATE INDEX "messages_subjectMemberId_idx" ON "messages" ("subjectMemberId");
