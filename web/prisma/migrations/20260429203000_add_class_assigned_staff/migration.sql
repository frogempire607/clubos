ALTER TABLE "recurring_classes"
ADD COLUMN "assignedStaffIds" JSONB NOT NULL DEFAULT '[]';
