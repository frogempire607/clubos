-- Adds member-shop opt-in flag to private_packages.
--
-- Rationale: P2.C12 introduces a member-facing package shop. Until now
-- every PrivatePackage was owner-only — assigned via /dashboard/privates.
-- We need a per-package owner toggle that gates which packages a member
-- can self-purchase. Defaulting to FALSE keeps existing rows
-- owner-only on deploy; the owner explicitly opts each package in.
--
-- Rollback: column is additive + defaulted, safe to drop with
--   ALTER TABLE "private_packages" DROP COLUMN "publishedToMembers";

ALTER TABLE "private_packages"
  ADD COLUMN "publishedToMembers" BOOLEAN NOT NULL DEFAULT false;
