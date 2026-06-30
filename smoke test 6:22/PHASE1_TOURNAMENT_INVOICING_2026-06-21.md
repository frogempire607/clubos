# Phase 1 — Tournament invoicing: shipped (code on disk + 1 migration)

Date: 2026-06-21. Scope: command-center plan area 4. **Code is on disk — Julian deploys/pushes. This phase has ONE migration that must run first.**

## ⚠️ Deploy order (important)

This Supabase blocks `prisma migrate dev` (shadow DB). Run, from `web/`:

```bash
npx prisma migrate deploy     # applies 20260622000000_tournament_invoicing
npx prisma generate           # regenerate client (adds EventExpenseItem + Event.invoiceScheduledAt)
npx tsc --noEmit              # will FAIL until generate runs — expected
npm run build
```

Then commit + push. Local `tsc`/`build` will error on the new fields until `prisma generate` runs — that's the known stale-client behavior, not a bug.

## What shipped

1. **Send-invoice date** — on an ATTEND/variable-cost tournament, owners can set "Send invoices on" (`Event.invoiceScheduledAt`). There's no cron in the app, so this drives a **reminder** in the Action Center on/after that date (`TOURNAMENT_INVOICE_DUE`) — it never auto-charges. "Invoice immediately" = the existing send button.
2. **Expense breakdown** — itemized line items per event (`EventExpenseItem`): label, kind (Entry / Coaching / Hotel / Transportation / Uniform / Misc), amount, optional description, optional **receipt** (uploaded via `/api/upload`), and a **per-athlete vs shared** flag. Per-athlete items (entry, uniform) are charged in full to each registrant; shared items (hotel, transport, coaching) are split across attendees. Items sum into the amount billed.
3. **Parent-facing transparency** — when invoices go out, the email now shows the **line-item breakdown** with each item's per-head amount and the registrant's total, so parents see exactly why it costs what it does.
4. **Official-price reminder** — when an OFFICIAL-priced tournament's registration deadline has passed but no total/items were set, `TOURNAMENT_PRICE_MISSING` surfaces in the Action Center ("price needs finalizing") so it doesn't fall through the cracks.

`bill-registrants` is backward-compatible: with **no** expense items, the split is exactly as before (single `variableCostTotal`).

## Files

**New**
- `web/prisma/migrations/20260622000000_tournament_invoicing/migration.sql` — `Event.invoiceScheduledAt` + `event_expense_items` table.
- `web/app/api/events/[id]/expenses/route.ts` — list (events:view) / create (events:edit).
- `web/app/api/events/[id]/expenses/[itemId]/route.ts` — patch / delete (events:edit).
- `web/components/EventExpenseEditor.tsx` — breakdown editor (list, add, delete, receipt upload).

**Modified**
- `web/prisma/schema.prisma` — `Event.invoiceScheduledAt`, `Event.expenseItems`, new `EventExpenseItem` model.
- `web/app/api/events/route.ts` + `web/app/api/events/[id]/route.ts` — accept/store `invoiceScheduledAt`.
- `web/app/dashboard/events/page.tsx` — invoice-date input + mount the expense editor (ATTEND section, edit mode).
- `web/app/api/events/[id]/bill-registrants/route.ts` — itemized split (per-athlete + shared) + line-item breakdown in the invoice email.
- `web/lib/actionCenter.ts` — `TOURNAMENT_INVOICE_DUE` + `TOURNAMENT_PRICE_MISSING` kinds.

## Test (after deploy)
- Create an ATTEND tournament, enable variable cost, add expense items (mix per-athlete + shared, with a receipt). Save.
- "Invoice all unpaid" → per-head = sum(per-athlete) + sum(shared)/attendees; email shows the breakdown + total; receipt items recorded.
- Event with no items → billing splits the single total exactly as before (regression).
- Set "Send invoices on" to today/past, don't bill → `TOURNAMENT_INVOICE_DUE` appears in the Action Center; billing clears it.
- OFFICIAL tournament, registration deadline in the past, no total/items → `TOURNAMENT_PRICE_MISSING` appears; setting a total or adding items clears it.
- Permissions: staff with events:view see the tournament reminders; non-events staff don't.

## Deferred (intentional, not blocking)
- **Auto-email reminder** to the responsible coach on the due date — needs a cron/worker the app doesn't have; the in-app Action Center reminder covers it for now.
- **Member-portal** display of the breakdown (the invoice email already shows it).
- **Inline edit** of an expense item (currently add + delete; the API supports PATCH for a later UI).

Next up if you want it: **P2 — payout expansion** (stored payouts for staff/guests/contractors/event workers with PENDING/PAID + history, and assign-event-compensation; adds payout items to the Action Center). One migration.
