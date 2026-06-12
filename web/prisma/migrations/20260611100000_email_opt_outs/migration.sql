-- Per-club email suppression list for announcement/broadcast emails (CAN-SPAM).
CREATE TABLE "email_opt_outs" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_opt_outs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "email_opt_outs_clubId_email_key" ON "email_opt_outs"("clubId", "email");

ALTER TABLE "email_opt_outs" ADD CONSTRAINT "email_opt_outs_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Defense-in-depth: RLS on, matching the rest of the schema (Prisma connects
-- as postgres and bypasses RLS; Supabase API roles are denied).
ALTER TABLE "email_opt_outs" ENABLE ROW LEVEL SECURITY;
