# 01 — Data model

Prisma schema additions. Field names below are proposals; match the repo's existing casing conventions. Every new model is club-scoped and needs an RLS policy in `web/rls/` alongside the existing ones.

## Existing models this work depends on

`Transaction`, `Expense`, `Member`, `MemberSubscription`, `Donation`, `ContractorPayment`, `Club`, `LegalEntity`, `Event`, `Booking`, `AttendanceRecord`, and whatever model backs Plaid bank connections in `/dashboard/financials`.

Verify actual field names before writing migrations — the notes below are derived from reading `web/app/api/reports/overview/route.ts` and `web/lib/financialReports.ts`, not from the schema file.

## New: `ImportBatch`

One row per upload. Drives the audit log and rollback.

```
id              String   @id @default(cuid())
clubId          String
kind            ImportKind        // MEMBERS | TRANSACTIONS
status          ImportStatus      // DRAFT | VALIDATING | AWAITING_REVIEW | COMMITTING | COMPLETED | FAILED | ROLLED_BACK
sourceSystem    String            // "WELLNESSLIVING" | "JACKRABBIT" | "ICLASSPRO" | "SPREADSHEET" | "OTHER"
fileName        String
fileHash        String            // sha256 of raw bytes — warn on exact re-upload
rowCount        Int
columnMap       Json              // { csvHeader: fieldKey | null }
createdCount    Int      @default(0)
matchedCount    Int      @default(0)
mergedCount     Int      @default(0)
skippedCount    Int      @default(0)
errorCount      Int      @default(0)
reviewCount     Int      @default(0)
startedAt       DateTime?
completedAt     DateTime?
rolledBackAt    DateTime?
rollbackExpiresAt DateTime?       // completedAt + 30 days
createdById     String
```

Index `(clubId, kind, createdAt)`. Unique on `(clubId, fileHash)` is **not** wanted — re-uploading the same file must be allowed and safely deduped at the row level.

## New: `ImportRow`

One row per CSV line. This is the audit log.

```
id            String  @id @default(cuid())
batchId       String
rowNumber     Int
rawData       Json                 // the original line, verbatim
normalizedData Json?               // post-parse values actually written
outcome       ImportOutcome        // CREATED | MATCHED | MERGED | LINKED | SKIPPED | EXCLUDED | PENDING_REVIEW
reason        String?              // "Exact email match", "No name and no email", …
matchSignal   MatchSignal?         // see specs/04
confidence    Confidence?          // HIGH | MEDIUM | LOW
targetType    String?              // "Member" | "Transaction"
targetId      String?              // the record created or touched
decidedBy     String?              // userId, or null for system decisions
decidedAt     DateTime?
errors        Json?                // [{ field, message }]
```

Index `(batchId, outcome)` and `(clubId, targetId)`.

## New: `MemberHistoricalRecord`

Historical membership spans that predate AthletixOS. Kept separate from `MemberSubscription` so native subscription logic (billing, Stripe, dunning) never touches imported rows.

```
id                  String @id @default(cuid())
clubId              String
memberId            String            // always resolves to a Member
membershipTypeLabel String?           // free text from the old system
startDate           DateTime?
endDate             DateTime?
status              String?           // normalized: ACTIVE | INACTIVE | PAUSED | UNKNOWN
externalMemberId    String?
sourceSystem        String
importBatchId       String?
notes               String?
dataCompleteness    Json              // { joinDate: false, membershipType: true, … }
```

`dataCompleteness` is what powers "Historical data incomplete" in the UI. Compute it once at import time; do not recompute on read.

## Field additions

**`Member`**
- `externalMemberId String?` — the old system's ID. Index `(clubId, externalMemberId)`, not unique (collisions happen and go to review).
- `sourceSystem String?` — `"ATHLETIXOS"` for native records.
- `importBatchId String?`
- `isHistoricalOnly Boolean @default(false)` — never appears in active rosters, billing, or messaging; counts only in all-time reporting.
- `normalizedEmail String?` and `normalizedPhone String?` — lowercased / E.164, indexed. Matching reads these, never the raw fields.

**`Transaction`**
- `externalTransactionId String?` — **unique on `(clubId, sourceSystem, externalTransactionId)`.** This is the whole duplicate-prevention story for re-uploads.
- `externalCustomerId String?`
- `sourceSystem String?` — `ATHLETIXOS | PREVIOUS_SOFTWARE | MANUAL_IMPORT | STRIPE | CASH | BANK | OTHER`. Note `paymentSource` already exists for `STRIPE` / `EXTERNAL_READER` / `CHECK`; `sourceSystem` is about *where the record came from*, not how it was paid. Keep both.
- `importBatchId String?`
- `isHistorical Boolean @default(false)`

**`Expense`** (or the category model behind it)
- Confirm whether `FIXED` / `VARIABLE` is stored per-expense or per-category. `/dashboard/financials` already renders `{ v: "FIXED", label: "Fixed — same every period" }`, so the field exists — Reports reads it and must not write it.

## New: `ExpenseClassificationOverride`

Owner-level override of fixed/variable per category, since the brief requires it and the Financials page's per-expense field isn't the same thing.

```
id         String @id @default(cuid())
clubId     String
category   String
treatAs    CostBehavior   // FIXED | VARIABLE
updatedById String
updatedAt  DateTime @updatedAt
@@unique([clubId, category])
```

## New: `ReportAlertSetting`

```
id        String @id @default(cuid())
clubId    String
kind      AlertKind  // RUNWAY_BELOW | EXPENSES_EXCEED_REVENUE | CHURN_SPIKE | UNCATEGORIZED_COUNT |
                     // BANK_SYNC_STALE | REFUND_RATE | RECURRING_REVENUE_DECLINE | PAYROLL_ABOVE_AVERAGE
threshold Decimal?
enabled   Boolean @default(true)
@@unique([clubId, kind])
```

Seed sensible defaults on club creation: runway floor 3 months, uncategorized 20, refund rate 5%, payroll 15% above trailing average.

## Reconciliation

There is already a `reconciliationStatus` on `Transaction` (`overview/route.ts` filters `<> 'VOID'`). Confirm whether a Stripe-payout-to-bank-deposit link exists. If not, add:

```
model PayoutMatch {
  id                String @id @default(cuid())
  clubId            String
  stripePayoutId    String
  bankTransactionId String?
  amount            Decimal
  matchedAt         DateTime?
  @@unique([clubId, stripePayoutId])
}
```

Without this, every Stripe sale is counted twice the moment the payout lands in a connected bank account. See `specs/03`.
