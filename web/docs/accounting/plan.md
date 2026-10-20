# AthletixOS Accounting — replacing QuickBooks

**Phase number: 10.** Phases 1–9 are all allocated in `docs/improvement/plan.md`
(7 = the family model in the experience, 8 = membership structure, 9 = family &
group discounts). This is a new workstream, not a decimal of an existing phase.

**Branch:** `claude/athletixos-accounting-phase-1-94d11d` — one branch for the
whole phase, per CLAUDE.md's branch policy.

**Goal.** Every dollar posts automatically to a balanced double-entry ledger,
reconciles to bank statements, and exports a clean trial balance + GL for the
CPA. Three phases; only Phase 1 is built in this session.

---

## Decisions taken as given

1. **Access: Pro and Enterprise only.** Verified, not guessed — see
   "Tier gating" below.
2. **Basis: accrual.** Entries are stored on an accrual basis. The cash/accrual
   toggle is a *reporting* concern and lands in Phase 3; nothing in Phase 1
   stores a basis flag, because the entry itself does not change — only how a
   report filters and dates it.
3. **Chart of accounts:** seed the sports-club template (below) into every
   eligible club. Clubs can rename, add and deactivate accounts. Accounts with
   postings can never be deleted.

### Settled 2026-10-20 (Julian), after the Phase 1 review

4. **Mapping:** `classes` → **4000**. `cash_payment` / `manual_invoice` → **map
   by what was sold when that is known, else 4950**. `FEES` → **6400**.
   Implemented as `revenueAccountForTransaction()` — see "Category mapping"
   below.
5. **1020 Undeposited Funds** joins the template as a **system** account. Cash
   and cheques land there and move to the bank when the deposit is made. Shipped
   in Phase 1, including an additive top-up for clubs already seeded.
6. **Books start date:** a **per-club owner setting**. Nothing posts
   automatically before it. Phase 2 builds it.
7. **`payout_matches` RLS is Phase 2's first task** — before anything writes to
   that table.
8. **No `eventId` backfill.** Automatic posting starts clean; pre-2026-07-17
   rows keep their null attribution.

### Tier gating — verified

`Club.tier` is a `String` defaulting to `"starter"`; `lib/tier.ts` is the single
source of truth and defines exactly:

```ts
export type Tier = "starter" | "pro" | "enterprise";
```

`TIER_FEATURES` already carries a `fullFinancials` boolean — `false` on starter,
`true` on pro and enterprise. That is precisely the Pro+Enterprise gate this
feature needs, so **no new tier flag was invented**; the ledger reuses
`fullFinancials`.

Enforcement is server-side on every route, in this order (copied from
`app/api/financials/receipts/route.ts`, the house pattern):

```ts
const session = await getServerSession(authOptions);
if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
const denied = await requirePermissionLive(session, "finances", "view" | "edit");
if (denied) return denied;
const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
if (tierGate) return tierGate;
```

The explicit `if (!session)` before the guard is required — CLAUDE.md gotcha #1:
`requirePermissionLive` loses TypeScript's null-narrowing on `session` and the
build fails with "'session' is possibly null" without it.

> **Stale doc warning.** `web/CLAUDE.md`'s "Tier Model" section still describes
> the pre-2026-10-18 world (three paid tiers, `growth`, $50/mo, 0% platform
> fee). `lib/tier.ts` replaced that in the pricing overhaul. Trust `lib/tier.ts`.
> Fixing that section is a docs-only follow-up, deliberately not bundled here.

### Permission levels used

`StaffProfile.permissions` is a JSON blob; `finances` is the relevant key, with
levels `none | view | send | edit | full`. **OWNER bypasses everything.**

| Action | Gate |
|---|---|
| Read accounts, journal, audit log | `finances:view` |
| Create / rename / deactivate an account | `finances:edit` |
| Create or void a journal entry | `finances:edit` |
| Attach or remove a file on an entry | `finances:edit` |
| **Change a lock date** | **owner only** (`requireOwnerLive`) |

`finances:edit` (not `full`) for entry creation matches the existing finance
mutations — `/api/stripe/reconcile` POST and
`/api/events/[id]/comp/generate-payouts` both use `finances:edit`, as do ~20
routes in total. Lock dates are owner-only because the spec says so, and because
a lock date is the control that stops everyone else from editing history.

**One thing to know about `finances:edit`:** the `finances` key only exposes
`none | view | full` (see `PERMISSION_CATALOG`), and `RANK` scores `send` and
`edit` identically at 2. So requiring `finances:edit` is in practice requiring
`finances:full` — `view` (1) is refused, `full` (3) passes. It is the house
idiom and it behaves correctly; it just isn't a middle tier that exists. Don't
"fix" it to `full`, and don't add an `edit` level to the key to make it literal.

---

## Naming: why every table is `gl_*`

`ledger` is already a taken namespace in this schema, three times over:

| Existing | What it is |
|---|---|
| `LedgerImport` / `ledger_imports` | the QuickBooks / previous-software CSV import staging table |
| `PrivateCreditLedger` / `private_credit_ledger` | prepaid private-lesson credits |
| "pay ledger" (`PayLine`, `ClubScheduleSettings.payLedgerStartsOn`) | staff pay accrual |

So a model called `LedgerEntry` would read as one of those. Every new table is
prefixed `gl_` (general ledger) and every model `Gl…`. This is unambiguous,
sorts together in the schema, and is standard accounting vocabulary.

---

## Phase 1 — Ledger core (THIS SESSION)

### Schema — 6 new tables, additive only

Nothing is renamed, dropped or altered. Existing models gain only *virtual*
Prisma relation fields (no columns, no SQL), so every existing read keeps
working whether or not the migration has been applied.

Migration folder: **`20261020000000_gl_ledger_core`**. It sorts after the
current newest (`20261018000000_platform_fee_and_tiers`), which CLAUDE.md
requires — `migrate deploy` warns loudly on out-of-order folders.

#### `gl_accounts` — the chart of accounts

| Column | Type | Notes |
|---|---|---|
| `id` | cuid | |
| `clubId` | String | FK → clubs, cascade |
| `number` | String | "1000". String, not Int — real charts use "1100.10" and leading zeros |
| `name` | String | renameable, always |
| `type` | String | `ASSET \| LIABILITY \| EQUITY \| INCOME \| EXPENSE` |
| `subtype` | String? | `COST_OF_SALES` only, today — see note |
| `normalBalance` | String | `DEBIT \| CREDIT` |
| `isContra` | Boolean | 1590 Accumulated Depreciation, 4900 Refunds & Discounts |
| `parentId` | String? | self-FK, for sub-accounts (2100 Credit Cards → one per card) |
| `active` | Boolean | `@default(true)` |
| `isSystem` | Boolean | renameable, never deactivatable |
| `systemKey` | String? | stable machine key — `STRIPE_CLEARING`, `DUE_TO`, `DUE_FROM`, `OPENING_BALANCE_EQUITY`, `RETAINED_EARNINGS` |
| `description` | String? | |
| `sortOrder` | Int | display order within type |
| `createdByUserId` | String? | |
| `createdAt` / `updatedAt` | | |

Unique: `([clubId, number])` and `([clubId, systemKey])`. The second is safe
with many nulls — Postgres treats NULLs as distinct in a unique index, so every
non-system account coexists.

> **`subtype` is my call, documented.** The spec fixes `type` to the five
> accounting classes, but the template has a **Cost of sales** section (5000
> Merchandise Cost, 5100 Event Costs). Those are `type: EXPENSE` so the
> accounting is right, plus `subtype: "COST_OF_SALES"` so Phase 3's P&L can show
> a gross-profit line instead of burying COGS in operating expenses. Adding a
> sixth `type` would have broken the spec's stated enum and every
> balance-sheet/P&L classifier that keys on it.

#### `gl_journal_entries`

| Column | Type | Notes |
|---|---|---|
| `id` | cuid | |
| `clubId` | String | |
| `entryDate` | DateTime `@db.Date` | the accounting date — what the lock date and every report compare against |
| `memo` | String? | |
| `legalEntityId` | String? | the entry's primary entity; lines carry their own |
| `sourceType` | String | `MANUAL` in Phase 1; Phase 2 adds `STRIPE_CHARGE`, `PAYOUT`, `BANK`, `EXPENSE`, `OPENING_BALANCE` |
| `sourceId` | String? | the originating record's id |
| `status` | String | `POSTED \| VOID` |
| `reference` | String? | free-text human reference |
| `isIntercompany` | Boolean | true when the service added Due To/From lines |
| `reversesEntryId` | String? | set on the reversing entry → points at what it reverses |
| `voidedByEntryId` | String? | set on the voided entry → points at its reversal |
| `voidedAt` / `voidReason` / `voidedByUserId` | | |
| `createdByUserId` | String? | |
| `postedAt` | DateTime | |

Unique: `([clubId, sourceType, sourceId])` — **the whole idempotency story for
Phase 2.** Automatic posting can then be a plain upsert-or-skip, and "each
source record posts at most once" is enforced by the database rather than by
remembering to check. Nullable `sourceId` means manual entries don't collide.

> **No auto-incrementing entry number in Phase 1** — my call. A per-club
> sequential counter needs either a serializable transaction or a counter row,
> and getting it wrong under concurrency produces either duplicate numbers or
> gaps that look like deleted entries to an auditor. `reference` covers the
> human need now; Phase 3's month-close is the right place to assign stable
> numbers if the CPA asks.

#### `gl_journal_lines`

| Column | Type | Notes |
|---|---|---|
| `id` | cuid | |
| `clubId` | String | denormalized — direct RLS policy and a cheap index |
| `entryId` | String | FK → gl_journal_entries, **cascade** |
| `accountId` | String | FK → gl_accounts, **restrict** |
| `debitCents` | Int | `@default(0)` |
| `creditCents` | Int | `@default(0)` |
| `legalEntityId` | String? | **line-level** entity — what makes intercompany work |
| `program` | String? | free-text dimension, see note |
| `memo` | String? | |
| `memberId` | String? | loose reference, no FK — money outlives members |
| `lineNumber` | Int | stable display order |

`onDelete: Restrict` on `accountId` is the database half of "accounts that have
postings can't be deleted". The service refuses first with a clear message; the
FK is the backstop if anything ever bypasses it.

> **Amounts are `Int` cents, per the spec.** A 32-bit signed int caps a single
> line at $21,474,836.47 — far beyond any club's single journal line. Aggregates
> are summed in JavaScript as doubles, exact to 2^53 cents (~$90 trillion), so
> totals never overflow either. Deliberately **not** `Decimal`: the rest of the
> app uses `Decimal(10,2)` for money, but a ledger must never see a rounding
> artifact, and integer cents make "debits == credits" an exact comparison.

> **`program` is a free-text tag — my call.** There is no `Program` model in
> this schema. `lib/reportsMembership.ts` has a `GroupBy` of `"program"` that
> resolves to membership/class names, and `Donation` already stores
> "fund / program / purpose" as text. A nullable String matches both and does
> not invent an entity the club never asked to manage. Phase 2 extends the same
> tag to expenses; if it ever needs to be a real table, every value is already
> in one column and converts cleanly.

#### `gl_entry_attachments`

`id`, `clubId`, `entryId` (cascade), `fileId`, `fileName`, `mimeType`,
`sizeBytes`, `uploadedByUserId`, `createdAt`.

Reuses the existing storage exactly as `Receipt` does: bytes go through
`lib/storage.ts#putObject`, an `UploadedFile` row is created with
`kind: "LEDGER"`, and `fileId` points at it. Reads go through the existing
club-scoped gate, `/api/files/[id]`. **No new storage path, no new bucket.**

#### `gl_lock_dates`

`id`, `clubId`, `legalEntityId`, `lockedThrough` (`@db.Date`),
`updatedByUserId`, `note`, `createdAt`, `updatedAt`.

Unique `([clubId, legalEntityId])` — **one lock date per entity**, as specified.
A club-wide lock is represented by a row per entity, so a single entity can be
closed while another is still open.

#### `gl_audit_logs`

`id`, `clubId`, `objectType` (`ACCOUNT | ENTRY | LINE | LOCK_DATE`), `objectId`,
`action` (`CREATE | UPDATE | VOID`), `actorUserId`, `actorName`, `before` Json?,
`after` Json?, `note`, `createdAt`.

Append-only by convention and by API surface: nothing in the codebase updates or
deletes a row in this table. Modelled on the existing `BillingAuditLog`.

### RLS — every table, matching the existing tenant pattern

All six tables carry a direct `NOT NULL clubId`, so each gets the simple policy
form from `20260702000000_enable_rls`:

```sql
ALTER TABLE "gl_accounts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "gl_accounts";
CREATE POLICY tenant_isolation ON "gl_accounts" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK ("clubId" = app.current_club_id());
```

`FOR ALL` with both `USING` and `WITH CHECK` constrains select, insert, update
(old *and* new row) and delete — so a club cannot re-home its own ledger row
into another club either. Carrying `clubId` on `gl_journal_lines` rather than
scoping it through `gl_journal_entries` is deliberate: a direct policy is one
index lookup instead of a correlated `EXISTS`, and the journal is the table that
will grow fastest.

Grants: `ALTER DEFAULT PRIVILEGES` in `rls/setup-app-role.sql` already grants
CRUD on future tables to `athletix_app`, but the migration issues the grants
explicitly anyway — default privileges only apply to tables created by the role
they were set for, and an explicit grant costs nothing and removes the
assumption.

**Cross-club proof:** a new `T9.x` section in `rls/harness/run-tests.ts`
(the two-club harness that spins up a throwaway Postgres and applies the repo's
real migrations). 49 assertions: club A cannot read, insert, update or delete
club B's accounts, entries, lines, attachments, lock dates or audit rows, cannot
re-home its own, and sees nothing at all with no tenant set. **Run: 95 passed,
1 failed** — the one failure is `T0.1`, below, and is pre-existing.

#### The harness found a real hole, and then a second one

Worth recording, because the first version of these policies looked correct and
was not.

**1. `clubId` alone is not enough on a table with a foreign key.** The first cut
gave every table the standard `clubId = app.current_club_id()` policy. `T9.20`
failed: club A could insert a `gl_journal_lines` row carrying **its own**
`clubId` while pointing `entryId` at **club B's** journal entry. The clubId
check passes, and **Postgres FK checks deliberately bypass RLS**, so nothing
stopped it. Because the entry detail view includes its lines by `entryId`, club
B would then render club A's line inside B's own entry — one club silently
unbalancing another's books, which is precisely what this feature exists to
prevent.

The fix: every FK to a tenant-owned table is verified **in the policy** to point
at a row in the same club — `gl_journal_lines` → entry, account and entity;
`gl_entry_attachments` → entry; `gl_journal_entries` → entity; `gl_lock_dates` →
entity; `gl_accounts` → parent. Nullable FKs allow `NULL` explicitly. The
condition sits in `WITH CHECK` (INSERT, and the new row of an UPDATE) and
deliberately **not** in `USING`: if a bad row ever does exist it must stay
visible, and therefore fixable, to the club that has to clean it up.

Six more assertions (`T9.20b`–`T9.20g`) cover the sibling cases the same bug
class implies, and three positive controls (`T9.20h`–`T9.20j`) prove the
hardened policy still permits legitimate same-club posting.

**2. A self-referencing FK cannot use a plain `EXISTS`.** Applying the fix to
`gl_accounts.parentId` produced `infinite recursion detected in policy for
relation "gl_accounts"` — the subquery re-enters the policy being evaluated.
The remedy is one narrowly-scoped `SECURITY DEFINER` function,
`app.gl_account_club_id(text)`, which runs as its owner and so does not
re-trigger RLS. It is deliberately minimal: given an account id it returns that
account's `clubId` and nothing else, `search_path` is pinned to
`pg_catalog, public` so its body cannot be redirected at an attacker-controlled
table, `EXECUTE` is revoked from `PUBLIC` and granted only to `athletix_app`.
An attacker would need to already know a cuid and would learn only a club id
they must already possess to hold a session.

Both fixes are asserted in `scripts/ledger-tests.ts` §9.17b–9.17m, so they
cannot be simplified away in a later session without the build failing.

**`T0.1` — pre-existing, not from this phase.** The harness also reports 27
tables with no RLS policy: `action_item_snoozes`, `billing_audit_logs`,
`email_sends`, `event_bundle_purchases`, `invoice_splits`, `payout_matches`,
`stripe_reconciliations` and 20 others. **None of the six `gl_*` tables is among
them** — this phase's RLS is complete. These are tables added since the
2026-07-02 RLS migration, and `web/CLAUDE.md` already records the follow-up
("fold them into the RLS rollout when that project resumes"). Fixing 27 tables
is its own piece of work and is deliberately not bundled here. Note that
`payout_matches` is the table Phase 2 fills, so it should be covered before
Phase 2 ships — it is listed as a Phase 2 blocker below.

### Two decisions worth stating plainly

**The routes use the ordinary `prisma` client, not `tenantPrisma`.** The RLS
tenant client is still a pilot: exactly one route uses it
(`/api/documents/[id]/signatures`), `web/rls/README.md` says "not yet applied to
production", and `getAppPrisma()` **throws** when `APP_DATABASE_URL` is unset.
Building the ledger on it would have made the whole feature 500 in any
environment without that variable. So the ledger follows the approach that pilot
route documents: the app-level `clubId` filter is the live constraint, "kept so
behavior is identical with RLS on or off". Every table still has its policy and
its grants, so the day the app connects as `athletix_app`, Postgres enforces the
same boundary underneath — a one-line import swap, nothing else.

To keep the app-level half from being a matter of memory, **every exported
function in `lib/ledgerServer.ts` takes `clubId` as its first argument and every
query in the file includes it**, and `scripts/ledger-tests.ts` §9.5–9.6 parses
the file to prove it. That assertion was itself verified with negative controls
— injecting an unscoped query must make the build fail, and the first version of
the check didn't catch it (it was matching a neighbouring query's `clubId` from
a character window; it now parses the actual call arguments).

**There is no `gateLedger()` wrapper.** The first cut wrapped session →
permission → tier in one helper each route called. It worked, and it defeated
`scripts/permission-boundary-guard.ts`, which reads the source tree and requires
a **visible** permission check in every mutating handler. That guard is a
deliberate ratchet — "a NEW ungated mutating route fails the build" — because
`middleware.ts` does not match `/api`, so the guard written in a route is that
route's entire boundary. Adding eight ledger routes to its `APPROVED_INLINE`
exception list would have made the build pass while making the guard blind to
the next route added here. The checks are written out in each route instead, in
the same order and shape as `app/api/financials/receipts/route.ts`.

### The ledger service — one write path

Split in two so the rules are testable without a database:

**`lib/ledger.ts` — pure.** No prisma, no next. Holds the chart template, the
category→account mapping, and every validation rule:

- `validateEntryDraft(draft)` → `string[]` of errors. Rejects:
  - debits ≠ credits
  - any line with **both** a debit and a credit
  - a total of zero
  - negative amounts, non-integers
  - fewer than two lines; no lines
  - a line on an inactive or unknown account
- `entryTotals(lines)` → `{ debitCents, creditCents, balanced }` — also what the
  UI's live balance indicator calls.
- `deriveIntercompanyLines(lines, accounts)` → the balancing Due To/From lines.
- `isDateLocked(entryDate, lockedThrough)`.

**`lib/ledgerServer.ts` — the only module that writes.** Every route goes
through it; no route touches a `gl_*` table directly. It:

1. loads the club's accounts and the relevant lock date,
2. runs `validateEntryDraft` and **refuses** on any error,
3. refuses if `entryDate <= lockedThrough` for any entity the entry touches,
4. adds intercompany lines when needed,
5. re-checks balance *after* step 4,
6. writes entry + lines + audit row in one `tenantTransaction`.

Void is a **reversing entry**, never a delete: a new entry dated the later of
the original date and "today, if the original period is locked", with every
debit and credit swapped, cross-linked via `reversesEntryId` /
`voidedByEntryId`, and the original flipped to `status: VOID`. This is why
posted entries are never hard-deleted — the audit trail and every prior report
stay true.

### Intercompany — the rule

Lines carry their own `legalEntityId`. When an entry's lines touch more than one
entity, **each entity's own lines must balance** or the entity's books don't
stand alone. For each entity with a non-zero net:

- net **debit** (`debits > credits`) → that entity received value, so it **owes**
  → add a **credit** to `2500 Due To Related Entity`
- net **credit** → that entity gave value, so it **is owed**
  → add a **debit** to `1400 Due From Related Entity`

The sum of all Due To/From lines is zero by construction, so the entry stays
balanced. `isIntercompany` is set, and the derived lines are memo'd with the
counterpart entity's name.

**Nothing ever crosses clubs.** Entity ids are validated to belong to the
session's club before anything is written, and RLS would refuse anyway.

### Category mapping — FOR JULIAN'S REVIEW

A mapping *layer*, not a rename. `lib/financials.ts` keeps its keys and labels
exactly as they are; this table is read when Phase 2 posts a transaction.

**Revenue categories** (`REVENUE_CATEGORIES`, all 11) → income accounts:

| Category key | Label today | Account |
|---|---|---|
| `memberships` | Memberships | 4000 Membership Revenue |
| `classes` | Classes | 4000 Membership Revenue |
| `events` | Events | 4200 Events & Tournaments |
| `camps_clinics` | Camps / Clinics | 4100 Camps & Clinics |
| `private_lessons` | Private lessons | 4300 Private Lessons |
| `products` | Products / Merch | 4400 Merchandise Sales |
| `donations` | Donations | 4700 Donations |
| `sponsorships` | Sponsorships | 4600 Sponsorships |
| `manual_invoice` | Manual invoices | 4950 Other Income |
| `cash_payment` | Cash payments | 4950 Other Income |
| `other_income` | Other income | 4950 Other Income |
| *(null / uncategorized)* | Uncategorized | 4950 Other Income |

All three open questions are now **settled** (Julian, 2026-10-20):

- **`classes` → 4000 Membership Revenue.** Confirmed. The key covers
  membership-covered class bookings as well as genuine drop-ins, and sending
  those to 4500 Drop-ins & Trials would inflate drop-in revenue.
- **`cash_payment` and `manual_invoice` → map by what was sold when known, else
  4950.** Both describe *how* money arrived, not what was sold, so neither can
  be mapped honestly on its own. The rule is implemented as
  **`revenueAccountForTransaction({ category, type })`** in `lib/ledger.ts`, and
  **that is the function Phase 2 must call** whenever it has a `Transaction` in
  hand — not the bare `REVENUE_CATEGORY_TO_ACCOUNT` map.

  | Transaction | Account |
  |---|---|
  | `cash_payment` + type `MEMBERSHIP` | 4000 Membership Revenue |
  | `cash_payment` + type `EVENT` | 4200 Events & Tournaments |
  | `cash_payment` + type `PRODUCT` | 4400 Merchandise Sales |
  | `cash_payment` + type `PRIVATE` | 4300 Private Lessons |
  | `cash_payment` + type `DONATION` | 4700 Donations |
  | `manual_invoice` + type `MEMBERSHIP` | 4000 Membership Revenue |
  | either + type `CHARGE` / null / unknown | 4950 Other Income |

  **The precedence is deliberately the opposite of
  `lib/financials.resolveRevenueCategory`**, which prefers an owner-set category
  over the type and is right to — an owner's pick is authoritative about
  *classification*. These two particular categories carry no classification at
  all, so the type wins. **Every other category is used as-is**, and the type
  must never override it: `sponsorships` + type `MEMBERSHIP` is 4600, not 4000.
  Getting that backwards would silently reclassify an owner's choice, so it is
  pinned by tests 7.37–7.40.

  The type→category half reuses the exported
  `TRANSACTION_TYPE_TO_CATEGORY` from `lib/financials.ts` rather than a second
  copy, so the two cannot drift.

**Expense categories** (`EXPENSE_CATEGORIES`, all 15) → expense accounts:

| Category key | Label today | Account |
|---|---|---|
| `RENT` | Rent | 6000 Rent |
| `PAYROLL` | Payroll / Coaches | 6100 Staff Payroll |
| `CONTRACTOR` | Contractor / Guest coach | 6110 Contract Coaches (1099) |
| `EQUIPMENT` | Gear / Equipment | 6250 Equipment & Supplies |
| `SOFTWARE` | Software | 6350 Software & Subscriptions |
| `MARKETING` | Marketing | 6500 Marketing & Advertising |
| `TRAVEL` | Travel | 6550 Travel & Competition Fees |
| `MEALS` | Meals | 6750 Meals |
| `INSURANCE` | Insurance | 6200 Insurance |
| `MAINTENANCE` | Repairs / Maintenance | 6300 Repairs & Maintenance |
| `UTILITIES` | Utilities | 6050 Utilities |
| `PROFESSIONAL` | Professional services | 6600 Professional Fees |
| `FEES` | Bank / Processing fees | 6400 Payment Processing Fees |
| `EVENTS` | Event costs | 5100 Event Costs |
| `OTHER` | Other expense | 6900 Miscellaneous |

**Settled:** `FEES` → **6400 Payment Processing Fees**, not 6450 Bank Fees. The
label is "Bank / Processing fees" and conflates both; Phase 2 posts Stripe fees
to 6400 specifically, so sending the manual category there keeps one account
authoritative. A club wanting true bank fees separated recategorizes to 6450.

**Payment methods** (`PAYMENT_METHODS`) → the balance-sheet side, used by Phase 2
to pick the debit account on a money-in entry:

| Method | Account |
|---|---|
| `STRIPE` | 1050 Stripe Clearing *(system)* |
| `CARD` | 1050 Stripe Clearing |
| `CASH` | **1020 Undeposited Funds** *(system)* |
| `CHECK` | **1020 Undeposited Funds** *(system)* |
| `BANK` | 1000 Operating Checking |
| `INVOICE` | 1100 Accounts Receivable |
| `COMP` | *no entry* — comped attendance is not revenue and never has been |
| `OTHER` | 1000 Operating Checking |

**Settled (2026-10-20): cash and cheques land in 1020 Undeposited Funds**, not
straight in Operating Checking. Cash physically sits in a drawer before it is
deposited, and a bank reconciliation that claims otherwise can never tie out.
A deposit moves the money 1020 → 1000.

`1020 Undeposited Funds` is a **system** account (`systemKey:
UNDEPOSITED_FUNDS`): renameable, never deactivatable, resolved by key rather
than by number. It was added to the template *after* the first clubs were
seeded, which is why Phase 1 also ships the additive top-up described next.

**Phase 2 owes the second half of this** — a "record a deposit" action that
moves a batch of cash from 1020 to a bank account. Until that exists 1020 simply
carries a balance, which is the honest answer rather than a wrong one.

### Seeding

`scripts/seed-chart-of-accounts.ts`, following the house script discipline
(`scripts/fix-commitment-end-dates.ts`, `scripts/fix-status-truth.ts`):

- **dry-run by default** — prints what it would create, writes nothing
- `--apply` **requires** `--clubs <id|slug>,…`; there is no all-clubs mode
- skips any club that is not Pro/Enterprise, and says so
- **idempotent** — matches on `([clubId, number])`, never duplicates, never
  overwrites a renamed account
- writes a `gl_audit_logs` row per created account
- **Julian runs it from his own terminal.** The sandbox cannot reach the DB.

**New eligible clubs get the template automatically** by lazy ensure: the
accounts endpoint calls `ensureChartOfAccounts(clubId)`, which seeds only when
the club is eligible *and* has zero accounts. No cron, no migration backfill, no
write on any subsequent read. A club that deliberately deletes every account
does not get them silently restored, because an account with postings cannot be
deleted and the club would have had to empty its ledger first.

#### The additive seed update, for clubs already seeded

`ensureChartOfAccounts` returns the moment a club has *any* account —
deliberately, so it can never overwrite a renamed account or resurrect a
deactivated one. That also means a club seeded before a template change never
sees the new account. For an ordinary account that is fine (the club can add
their own). For a **system** account it is not: Phase 2 resolves those by
`systemKey`, so a club missing one would fail to post rather than post somewhere
wrong.

So Phase 1 also ships **`ensureSystemAccounts(clubId)`**, which adds any system
account the template has gained since a club was set up. First needed the day
1020 Undeposited Funds was added. It is narrow on purpose:

- it only ever **adds** rows whose `systemKey` the club does not already have —
  no update, no upsert, no delete, no reactivation (pinned by test 9.33d);
- it matches on **`systemKey`**, never on number or name, so a club that renamed
  or renumbered an account still counts as having it;
- if the template's number is already taken by an account of the club's own, it
  steps to the next free number in the same block rather than colliding or
  skipping — the account has to exist, and its number is cosmetic next to its
  `systemKey`. The audit note records the substitution;
- it leaves an unseeded club alone, for `ensureChartOfAccounts`;
- every account it adds gets a `gl_audit_logs` row.

It runs in two places: on the accounts endpoint read (so no operator action is
needed at all), and in `scripts/seed-chart-of-accounts.ts`, whose dry run now
also reports which already-seeded clubs would be topped up and with what.

### UI

Two tabs join the existing `TABS` array in `app/dashboard/financials/page.tsx`
and the `PRO_TABS` set that renders the upgrade state:

- **Chart of Accounts** (`?tab=accounts`) — grouped by type, sub-accounts
  indented, inline rename, add, deactivate. System accounts show a badge and no
  deactivate control. Accounts with postings show their posting count and no
  delete control.
- **Journal** (`?tab=journal`) — entry list; a create form with a **live balance
  indicator** (debits, credits, difference; save disabled until it reads zero);
  file attach; void with a confirm that explains a reversing entry will be
  created. The lock-date setting is a card in this tab, owner-only.

Mobile-friendly and 12-hour times throughout, per the house conventions.

### Task 10 — already fixed; verifying, not rebuilding

The spec asks to make the financials tabs URL-addressable so four Action Item
links work. **That shipped on 2026-09-14.** `app/dashboard/financials/page.tsx`
parses `?tab=` and `?show=`, mirrors the tab back into the URL on click, and the
four links were repointed in `lib/reportsActionItems.ts`:

| Action Item | Links to | Line |
|---|---|---|
| `UNRECONCILED_DEPOSIT` | `/dashboard/financials?tab=stripe&show=unreconciled` | 256 |
| `OFFLINE_PAYMENT_PENDING` | `/dashboard/financials?tab=offline&show=awaiting` | 286 |
| `UNCATEGORIZED_LARGE_BANK` | `/dashboard/financials?tab=bank&show=review` | 318 |
| `UPCOMING_RENEWAL_LARGE` | `/dashboard/members?queue=renewingSoon` | 359 |

`scripts/renewal-surfacing-tests.ts:333` already guards the fourth.
`UPCOMING_RENEWAL_LARGE` deliberately does **not** point at financials — a large
upcoming renewal is a members-queue concern, and that was the fix.

So Phase 1 adds a regression check that all four targets resolve to a real tab
or queue, and registers the two new tabs in the same machinery. Nothing is
rebuilt.

### Done when

- a balanced manual entry saves
- an unbalanced one is rejected
- an entry inside a locked period is refused
- an intercompany entry creates Due To/From automatically
- the audit log shows every change
- a Starter-tier club gets no access
- cross-club access fails

---

## Phase 2 — Automatic posting + reconciliation (DO NOT BUILD YET)

- Billing posts automatically: memberships, camps, events, privates, products,
  donations, refunds.
  - A charge posts the **sticker price** to revenue and the
    `passProcessingFees` gross-up to **4800 Processing Fees Recovered**.
  - The Stripe fee posts to **6400**, and the net goes to **1050 Stripe
    Clearing**.
- Payouts move Stripe Clearing → bank. This fills the existing, empty
  `payout_matches` table — whose RLS policy is Phase 2's first task (above).
- Categorized Plaid rows and expenses post to the ledger.
- **Each source record posts at most once**, and only on or after the club's
  "books start date" — this prevents double-counting history that was already
  imported. The `([clubId, sourceType, sourceId])` unique index added in Phase 1
  is what makes this structural rather than a remembered check.
- **Books start date (settled 2026-10-20): a per-club OWNER setting. Nothing
  posts automatically before it.** So it is one new nullable `Club` column, an
  owner-only setting screen, and a guard in the posting path that refuses — not
  silently skips — a source record dated earlier. Until an owner sets it,
  automatic posting for that club does not run at all: a null start date means
  "not configured", never "post everything". Manual journal entries are
  unaffected; this gates *automatic* posting only.
- **`payout_matches` RLS is the FIRST task of Phase 2**, before anything writes
  to that table. It is one of the 27 tables with no policy today (harness
  `T0.1`), and Phase 2 is what starts filling it.
- **No `eventId` backfill (settled).** `Transaction.eventId` attribution starts
  2026-07-17 and older rows stay null. Automatic posting starts clean rather
  than inferring attribution for historical rows; per-event revenue before that
  date is simply not available, which is the truthful answer.
- **Cash deposits:** the "record a deposit" action that moves money from 1020
  Undeposited Funds to a bank account. Phase 1 posts cash *into* 1020; this is
  the other half.
- Receipts attach to entries.
- Program tags extend to expenses.
- Monthly statement reconciliation (statement balance, cleared items, saved
  report).
- **Never reconcile through a mutable attribution like `memberId`** — key on
  Stripe/charge ids. This is the CLAUDE.md bug class: a subscription transferred
  between siblings puts the money and the subscription on different members, and
  reconciling through `memberId` reported a $545.37 hole that did not exist.

## Phase 3 — Reports, close, onboarding (DO NOT BUILD YET)

- Reports: trial balance, GL, balance sheet, P&L, cash flow — by month, entity
  and program, with a **cash/accrual toggle**.
- CPA export of TB and GL to Excel/CSV, using **exceljs, not xlsx**.
- Month-close workflow that sets the lock date.
- Fixed-asset register with straight-line depreciation.
- 1099: contractor tax ID, a configurable threshold report, and an export.
- Opening-balance import from a QuickBooks trial balance, with account mapping,
  as **one entry per entity**.
- A read-only, searchable archive of QuickBooks GL history that **never feeds
  live reports**.

---

## Sports-club chart of accounts template

`[system]` = `isSystem: true` — renameable, never deactivatable.
`(contra)` = `isContra: true`.

### Assets
| # | Name | |
|---|---|---|
| 1000 | Operating Checking | |
| 1010 | Savings | |
| 1020 | Undeposited Funds | `[system]` `UNDEPOSITED_FUNDS` — added 2026-10-20 |
| 1050 | Stripe Clearing | `[system]` `STRIPE_CLEARING` |
| 1100 | Accounts Receivable | |
| 1300 | Prepaid Expenses | |
| 1400 | Due From Related Entity | `[system]` `DUE_FROM` |
| 1500 | Training Equipment | |
| 1520 | Furniture & Fixtures | |
| 1530 | Leasehold Improvements | |
| 1590 | Accumulated Depreciation | (contra) |

### Liabilities
| # | Name | |
|---|---|---|
| 2000 | Accounts Payable | |
| 2100 | Credit Cards | sub-accounts per card |
| 2200 | Deferred Revenue | prepaid memberships, camps |
| 2300 | Sales Tax Payable | |
| 2400 | Payroll Liabilities | |
| 2500 | Due To Related Entity | `[system]` `DUE_TO` |
| 2700 | Loans Payable | |

### Equity
| # | Name | |
|---|---|---|
| 3000 | Owner / Partner Capital | |
| 3100 | Owner Contributions | |
| 3200 | Owner Distributions | |
| 3900 | Retained Earnings | `[system]` `RETAINED_EARNINGS` |
| 3950 | Opening Balance Equity | `[system]` `OPENING_BALANCE_EQUITY` |

### Income
| # | Name | |
|---|---|---|
| 4000 | Membership Revenue | |
| 4100 | Camps & Clinics | |
| 4200 | Events & Tournaments | |
| 4300 | Private Lessons | |
| 4400 | Merchandise Sales | |
| 4500 | Drop-ins & Trials | |
| 4600 | Sponsorships | |
| 4700 | Donations | |
| 4800 | Processing Fees Recovered | `passProcessingFees` gross-up |
| 4900 | Refunds & Discounts | (contra) |
| 4950 | Other Income | |

### Cost of sales
`type: EXPENSE`, `subtype: COST_OF_SALES`

| # | Name |
|---|---|
| 5000 | Merchandise Cost |
| 5100 | Event Costs (awards, officials, venue) |

### Expenses
| # | Name | | # | Name |
|---|---|---|---|---|
| 6000 | Rent | | 6450 | Bank Fees |
| 6050 | Utilities | | 6500 | Marketing & Advertising |
| 6100 | Staff Payroll | | 6550 | Travel & Competition Fees |
| 6110 | Contract Coaches (1099) | | 6600 | Professional Fees |
| 6150 | Payroll Taxes | | 6650 | Licenses, Dues & Sanctioning |
| 6200 | Insurance | | 6700 | Office Expenses |
| 6250 | Equipment & Supplies | | 6750 | Meals |
| 6300 | Repairs & Maintenance | | 6800 | Depreciation Expense |
| 6350 | Software & Subscriptions | | 6900 | Miscellaneous |
| 6400 | Payment Processing Fees | | 7000 | Interest Expense |

---

## Found along the way: `payrollRange` is timezone-dependent

Not accounting, but it was found while making `npm run build` pass end to end,
and it is a real latent bug.

`payrollRange()` in `lib/payrollCalc.ts` does:

```ts
const to = new Date(toStr);     // "2026-10-12" parses as UTC midnight
to.setHours(23, 59, 59, 999);   // ...but setHours is LOCAL time
```

Mixing a UTC-parsed date with local-time setters shifts the whole range by the
machine's offset. In `America/New_York` the payroll route reported
`from 2026-10-06T04:00Z to 2026-10-12T03:59:59.999Z` for `?from=2026-10-07&to=2026-10-12`
— an extra day at the start and **the final day lost**. A coach with a class on
the last day of the range is not paid for it.

**Production is not affected today:** Netlify functions run in UTC, where the
same code produces the correct `2026-10-07T00:00:00Z → 2026-10-12T23:59:59.999Z`.
It is latent, and it fires on any non-UTC server and on every developer machine
in the Americas.

This was also why four assertions in `scripts/pay-ledger-server-tests.ts`
failed: the suite pinned its *clock* but not its *zone*. It now pins
`TZ=UTC` (self-pinning, plus the build runner passes it, plus an assertion that
fails loudly with the reason if neither took effect), and passes in all of UTC,
New York, Chicago, Los Angeles, Berlin, Tokyo and Kiritimati.

**The fix is deliberately NOT applied here.** It is pay-ledger behaviour, which
this session was scoped away from, and it is a one-line change — use
`Date.UTC(...)` / the `setUTC*` setters, or compose the ISO string directly:

```ts
const from = new Date(`${fromStr.slice(0, 10)}T00:00:00.000Z`);
const to = new Date(`${toStr.slice(0, 10)}T23:59:59.999Z`);
```

With the test now pinned to UTC it would be a no-op for the suite and for
production, and would make the payroll route correct on any server. Filed as its
own BACKLOG item.

## Safety rules honored in this phase

- **No migration applied.** The folder is written; Julian runs
  `npx prisma migrate deploy` himself, **before** the code that reads these
  tables deploys.
- **Nothing merged, pushed to main, or deployed.**
- **Additive only** — new tables, no rename, no drop, no column altered.
- **No `--shadow-database-url`, ever.** No test points at production.
- **RLS on every new table**, with the existing tenant policy shape and explicit
  `athletix_app` grants.
- **No user-facing copy names a sport** — `npm run test:sport-terms` passes.
- **The build is the only check** (no CI): `npm run build` runs
  `scripts/run-build-tests.mjs` first, and the new pure test suite is registered
  there, so it gates every build.
