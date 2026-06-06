# Proposed migration — `LegalAcceptance`

**Status:** AWAITING APPROVAL — NOT YET APPLIED.
**Purpose:** Persist a defensible record of which version of the Terms of Service and Privacy Policy each user accepted, when, and from what client.

This proposal is the deliverable for **Task 8** of `CLAUDE_TASKS.md`. The signup flow (`/signup` page + `/api/auth/signup` route) is already wired to send the consent payload — once this migration is applied, real rows will be written. Until then, `/api/auth/signup` logs a structured `[legal-acceptance:pending-migration]` warning to server logs for every signup so consent data is recoverable from logs.

---

## Schema addition (Prisma)

Add the following model to `prisma/schema.prisma`. Append, do not modify any existing model.

```prisma
// Audit-grade record of Terms of Service + Privacy Policy acceptance.
// One row per (user, documentType) acceptance event. New acceptance of a
// new version creates a new row — we never overwrite history.
model LegalAcceptance {
  id           String   @id @default(cuid())
  userId       String
  // clubId is denormalized for fast per-club legal-export queries. Nullable
  // only for the theoretical case of an account that exists before being
  // attached to a club; in the current flow it's always set at signup time.
  clubId       String?
  // "TOS" or "PRIVACY". Kept as a String (not enum) so adding future
  // documents (DPA, COPPA-specific consent, etc.) doesn't need a migration.
  documentType String
  // Version string from app/terms/page.tsx TERMS_VERSION or app/privacy/page.tsx
  // PRIVACY_VERSION at the moment of acceptance, e.g. "2026-06-05-draft".
  version      String
  acceptedAt   DateTime @default(now())
  ipAddress    String?
  userAgent    String?

  user User  @relation(fields: [userId], references: [id], onDelete: Cascade)
  club Club? @relation(fields: [clubId], references: [id], onDelete: SetNull)

  @@index([userId, documentType])
  @@index([clubId, documentType])
  @@map("legal_acceptances")
}
```

Also add the reverse relations to existing models (one line each):

```prisma
// inside model User { ... }
  legalAcceptances  LegalAcceptance[]

// inside model Club { ... }
  legalAcceptances  LegalAcceptance[]
```

---

## SQL migration file

Because the local `prisma migrate dev` is blocked by a shadow-DB permission issue (documented in CLAUDE.md), follow the project's established hand-written migration pattern: create the folder + `migration.sql`, then run `npx prisma migrate deploy` against the real DB.

**Folder:** `prisma/migrations/20260605000000_legal_acceptances/`
**File:** `migration.sql`

```sql
-- Task 8 — record of ToS + Privacy acceptance at signup time.
-- Pure additive; safe to re-run (every statement guarded with IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS "legal_acceptances" (
  "id"           TEXT PRIMARY KEY,
  "userId"       TEXT         NOT NULL,
  "clubId"       TEXT,
  "documentType" TEXT         NOT NULL,
  "version"      TEXT         NOT NULL,
  "acceptedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ipAddress"    TEXT,
  "userAgent"    TEXT
);

CREATE INDEX IF NOT EXISTS "legal_acceptances_userId_documentType_idx"
  ON "legal_acceptances"("userId", "documentType");

CREATE INDEX IF NOT EXISTS "legal_acceptances_clubId_documentType_idx"
  ON "legal_acceptances"("clubId", "documentType");

ALTER TABLE "legal_acceptances"
  DROP CONSTRAINT IF EXISTS "legal_acceptances_userId_fkey";
ALTER TABLE "legal_acceptances"
  ADD CONSTRAINT "legal_acceptances_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "legal_acceptances"
  DROP CONSTRAINT IF EXISTS "legal_acceptances_clubId_fkey";
ALTER TABLE "legal_acceptances"
  ADD CONSTRAINT "legal_acceptances_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "clubs"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
```

---

## Apply procedure

1. Append the three Prisma schema blocks above to `prisma/schema.prisma`.
2. Create `prisma/migrations/20260605000000_legal_acceptances/migration.sql` with the SQL above.
3. Run:
   ```bash
   npx prisma validate
   npx prisma migrate deploy
   npx prisma generate
   ```
4. Verify in `psql`:
   ```sql
   \d legal_acceptances
   ```
5. Restart the Next dev server so the regenerated Prisma client is loaded.
6. After a single test signup, confirm exactly 2 rows (TOS + PRIVACY) for the new user:
   ```sql
   SELECT "userId", "documentType", "version", "acceptedAt"
   FROM legal_acceptances
   ORDER BY "acceptedAt" DESC LIMIT 5;
   ```

No backfill is needed for users created before the migration — the signup route logs the consent metadata to server logs for that window, which is recoverable on demand.

---

## Rollback

```sql
DROP INDEX IF EXISTS "legal_acceptances_clubId_documentType_idx";
DROP INDEX IF EXISTS "legal_acceptances_userId_documentType_idx";
DROP TABLE IF EXISTS "legal_acceptances";
```

Reverting the `prisma/schema.prisma` additions afterward returns the project to its pre-task-8 state. The signup route's `if (typeof p.legalAcceptance?.createMany === "function")` feature-detection means the route continues working after rollback — it just goes back to log-only.

---

## What the audit trail will look like

After apply, each defensible consent record contains:
- `userId` — who accepted
- `clubId` — under which club's signup context
- `documentType` — TOS or PRIVACY
- `version` — e.g. `2026-06-05-draft` — exactly which document text
- `acceptedAt` — timestamp
- `ipAddress` — source IP from `x-forwarded-for` chain
- `userAgent` — browser / native shell user-agent

Two rows per signup (TOS + PRIVACY), insert-only, never updated. For a later attorney review or dispute, the record establishes both *what* was accepted (via version → recoverable from `legal/TERMS_OF_SERVICE.md` / `legal/PRIVACY_POLICY.md` git history) and *under what circumstances* (timestamp + client metadata).
