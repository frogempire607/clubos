-- Non-member / at-the-door payment snapshot on attendance records.
ALTER TABLE "attendance_records" ADD COLUMN IF NOT EXISTS "paymentMethod" TEXT;
ALTER TABLE "attendance_records" ADD COLUMN IF NOT EXISTS "amountCharged" DECIMAL(10,2);
