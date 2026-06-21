-- Drawn signature support: store the signer's signature image (PNG data URL)
-- on each signature row. Additive + safe on a live DB — existing rows stay
-- NULL (legacy typed-only acknowledgements), new portal/onboarding signatures
-- populate it. No backfill needed.
ALTER TABLE "document_signatures" ADD COLUMN "signatureDataUrl" TEXT;
