-- Private lesson packages can apply to one or more lesson types.
-- Empty array means any lesson type. Legacy lessonTypeId remains supported.
ALTER TABLE "private_packages"
  ADD COLUMN IF NOT EXISTS "lessonTypeIds" JSONB NOT NULL DEFAULT '[]';
