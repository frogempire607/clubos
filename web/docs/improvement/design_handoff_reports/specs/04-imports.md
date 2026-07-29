# 04 — All-time imports

Design: `Reports Import Wizard.dc.html`. Seven steps: upload → match columns → check for problems → preview → review matches → confirm → done.

The single most important property: **nothing is written until step 6 is confirmed**, and everything written can be undone for 30 days.

## Member CSV fields

| Field key | Header aliases auto-detected | Notes |
| --- | --- | --- |
| `firstName` | first name, firstname, given name, fname | Required unless email or phone present |
| `lastName` | last name, lastname, surname, lname | |
| `email` | email, email address, e-mail, primary email | Normalized lowercase, trimmed |
| `phone` | phone, mobile, cell, phone number | Normalized to E.164 |
| `dateOfBirth` | dob, birthdate, date of birth, birthday | Format inferred per column, confirmed by the user |
| `joinDate` | join date, client since, member since, start | |
| `membershipStartDate` | pass start, membership start | |
| `membershipEndDate` | pass end, membership end, expiry | |
| `membershipType` | pass name, membership, plan, program | Free text; not mapped to a native plan |
| `memberStatus` | status, active, state | Normalized (below) |
| `role` | type, rel type, relationship, athlete/parent | ATHLETE / PARENT / BOTH |
| `externalMemberId` | client id, member id, customer id | Primary match signal |
| `sourceSystem` | — | Set once for the whole batch on step 1 |
| `notes` | notes, comments, memo | |

Status normalization: `active|current|enrolled` → ACTIVE; `inactive|cancelled|canceled|expired|former|archived` → INACTIVE; `hold|paused|frozen|suspended` → PAUSED; anything else → INACTIVE with a warning row.

## Transaction CSV fields

`transactionDate`, `clientName`, `athleteName`, `email`, `externalCustomerId`, `externalTransactionId`, `itemPurchased`, `paymentMethod`, `grossAmount`, `refundAmount`, `processingFee`, `netAmount`, `status`, `sourceSystem`, `notes`.

Validation: when gross, fee and net are all present, assert `net ≈ gross − refund − fee` within $0.02. Mismatches are warnings, not errors — trust the source system's `net` and note the discrepancy in `ImportRow.errors`.

## Step 1 — Upload

- Accept CSV up to 20 MB / 50,000 rows. Above that, ask the user to split.
- Parse client-side for headers and a 20-row sample so mapping is instant; the server re-parses authoritatively on validate.
- Compute a sha256 of the raw bytes. If an earlier `ImportBatch` for this club has the same hash, warn — "You imported this exact file on Jun 12. Re-importing is safe; already-imported rows will be skipped." Warn, never block.
- Source system is chosen here and stamped on every record in the batch.
- Offer a downloadable template per import kind.

## Step 2 — Match columns

Auto-map by normalized header (lowercase, strip non-alphanumerics) against the alias table. Show what was guessed, the first non-empty example value, and an explicit status per column: **Auto**, **Check format**, **Unmapped**, **Ignored**.

Date columns get a detected format shown inline ("read as DD/MM/YYYY") with a switcher. Infer by scanning the column: if any value has a first component > 12, the format is unambiguous; otherwise default to the source system's known convention and make the user confirm.

Unmapped columns are dropped silently at import time but listed in the batch's `columnMap` so a later re-run can pick them up.

## Step 3 — Check for problems

Two buckets, and the distinction matters:

**Errors — the row cannot be imported.**
- Unparseable date in a required date field
- No name *and* no email *and* no external ID (nothing to identify the person by)
- Membership end date before start date
- Duplicate external ID within the same file
- Non-numeric amount in a money column
- Amount with an unrecognised currency symbol

**Warnings — the row imports, flagged.**
- Missing join date, missing membership type
- Phone reformatted
- Unrecognised status word
- Net amount doesn't reconcile
- Date of birth in the future or implying age > 100

Group errors by kind with affected row numbers and a representative value — the design shows "14, 88, +12". Offer `errors.csv`: the original rows verbatim plus an appended `error` column, so the user can fix and re-upload just those.

The user may proceed with the valid rows. Excluded rows are recorded as `ImportRow` with outcome `EXCLUDED`.

## Step 4 — Preview

Show the first 50 rows exactly as they will be stored — normalized values, resolved membership type, and the predicted outcome badge per row. Footer totals: created / matched / needs review / excluded.

## Step 5 — Review matches

### Matching signals, in priority order

| Signal | Confidence | Behavior |
| --- | --- | --- |
| `EXTERNAL_ID` — `externalMemberId` matches exactly one member | HIGH | Auto-match |
| `MIGRATION_ID` — an existing migration ID from a prior import | HIGH | Auto-match |
| `EXACT_EMAIL` — `normalizedEmail` matches exactly one member | HIGH | Auto-match |
| `EXACT_PHONE` — `normalizedPhone` matches exactly one member | HIGH | Auto-match |
| `NAME_DOB` — exact normalized name + identical date of birth | MEDIUM | Review |
| `NAME_GUARDIAN` — exact name + a linked guardian with a matching email or phone | MEDIUM | Review |
| `EMAIL_IS_GUARDIAN` — email matches a guardian, not the athlete | MEDIUM | Review |
| `ID_COLLISION` — external ID matches more than one member | MEDIUM | Review |
| `PHONE_IS_STAFF` — phone matches a staff record | LOW | Review |
| Similar name only | — | **Never a match.** Create as a new record. |

Hard rules:
- Fuzzy name similarity, nickname expansion and soundex are never sufficient on their own. Families share surnames, siblings share phone numbers, twins share dates of birth.
- Any signal that resolves to more than one candidate downgrades to review regardless of its base confidence.
- A HIGH signal that contradicts another HIGH signal (external ID says A, exact email says B) goes to review.

### Review outcomes

Persisted on `ImportRow.outcome`:

| UI label | Outcome | Effect |
| --- | --- | --- |
| Same person — add history | `MATCHED` | Attach `MemberHistoricalRecord` to the existing member. No profile fields overwritten. |
| Merge the two records | `MERGED` | Full merge: transactions, bookings, attendance, documents move to the surviving record. Reversible for 30 days. |
| Create as separate person | `CREATED` | New member with `isHistoricalOnly: true` |
| Keep both, don't link | `SKIPPED` | Both records stay, an explicit non-match is recorded so the pair never resurfaces |
| Skip this row | `EXCLUDED` | Nothing written; the row stays in the log |

Bulk actions: "Keep all separate" and "Ignore all". No bulk merge — merging is destructive and must be per-row.

Undecided rows stay `PENDING_REVIEW` after commit. The rest of the import still goes through, and the Reports → History & imports tab shows the outstanding count.

### Merge semantics

The surviving record is the native AthletixOS member, always. Field-level rule: keep the native value when both are present; fill from the import when the native field is empty; never overwrite a non-empty native field. Append the imported external ID to the survivor. Log every field change in `ImportRow.normalizedData` so rollback can restore.

## Step 6 — Confirm and commit

Summary of exactly what will happen, then commit. Over ~2,000 rows, run asynchronously: 202 + job id, chunked writes of 500 in a transaction per chunk, progress polled by the client.

On commit:
- Members get `sourceSystem`, `importBatchId`, `isHistoricalOnly` where applicable.
- Transactions get `externalTransactionId`, `sourceSystem`, `isHistorical: true`.
- **No emails.** Imported members are not invited, not notified, not billed, not added to campaigns. Assert this in a test.
- Report caches for the club are invalidated.

### Duplicate prevention for transactions

The unique constraint on `(clubId, sourceSystem, externalTransactionId)` does the work. Insert with an on-conflict-do-nothing path and count the conflicts as `SKIPPED`. Re-uploading a file is then idempotent by construction, not by application logic.

Rows with no external transaction ID fall back to a composite fingerprint: `sha256(clubId + date + amount + normalizedPayerEmail + itemLabel)`. Store it in a `dedupeHash` column, unique per club. Collisions across genuinely distinct transactions are possible but rare; treat a fingerprint hit as `SKIPPED` with a reason the user can see and override from the log.

## Step 7 — Done and audit log

Show what happened, then the log. The log is permanent — it does not expire with the rollback window.

Log columns: row number, record, action, reason, decided by (user name or "System"). Filterable by outcome. Downloadable as CSV.

## Rollback

Owner-only, available for 30 days from `completedAt`.

- `CREATED` rows: hard-delete the created records, but only if nothing has since attached to them (a payment, booking or note). Anything with dependents is converted to `isHistoricalOnly` and reported as "kept — has activity since import".
- `MATCHED` rows: delete the attached `MemberHistoricalRecord`.
- `MERGED` rows: restore the archived record and move its relations back using the field-change log.
- `SKIPPED` / `EXCLUDED`: nothing to undo.

Rollback writes its own audit entries and sets `ImportBatch.status = ROLLED_BACK`. Show a preview of what will be removed before executing — never a bare confirm dialog.

## Reporting integration

- `before_athletix` and `since_athletix` ranges become available once a historical import exists.
- All-time figures include historical records; native-only figures exclude them. Every card states which it is showing.
- Where a period contains historical records with incomplete fields, the section carries `HISTORICAL_DATA_INCOMPLETE` and names the gap ("412 members are missing join dates").
- Historical transactions appear in reports with their source label (`Previous software`, `Manual import`) — the design's source chips on the Revenue tab.
