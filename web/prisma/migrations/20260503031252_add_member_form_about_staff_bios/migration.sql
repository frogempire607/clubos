-- AlterTable
ALTER TABLE "clubs" ADD COLUMN     "aboutUs" TEXT,
ADD COLUMN     "memberFormConfig" JSONB;

-- AlterTable
ALTER TABLE "staff_profiles" ADD COLUMN     "bio" TEXT,
ADD COLUMN     "photoUrl" TEXT,
ADD COLUMN     "publicEmail" TEXT,
ADD COLUMN     "publicPhone" TEXT,
ADD COLUMN     "showOnPortal" BOOLEAN NOT NULL DEFAULT false;
