-- AlterTable
ALTER TABLE "clubs" ADD COLUMN     "contactEmail" TEXT,
ADD COLUMN     "contactPhone" TEXT,
ADD COLUMN     "coverImageUrl" TEXT,
ADD COLUMN     "hoursOfOperation" JSONB,
ADD COLUMN     "socialLinks" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "websiteUrl" TEXT;
