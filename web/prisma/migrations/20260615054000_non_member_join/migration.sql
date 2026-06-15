-- Non-member registration links (#7): a "JOIN" activation link lets a
-- non-member create a free portal account and browse the club's options.
-- Additive nullable column — safe on a live DB.
ALTER TABLE "members" ADD COLUMN "activationKind" TEXT;
