# Phase 2 — Payout expansion: shipped (code on disk + 1 migration)

Date: 2026-06-21. Scope: command-center plan area 5 (+ area 6 payout visibility). **Code on disk — Julian deploys/pushes. One migration.**

## ⚠️ Deploy order

```bash
cd web
npx prisma migrate deploy     # applies 20260623000000_payouts
npx prisma generate           # regenerate client (adds the Payout model)
npx tsc --noEmit              # errors on `prisma.payout` until generate runs — expected
npm run build
```

> Safety: this is a **tracking ledger only** — recording money owed/paid. The platform never moves money or initiates transfers; the owner pays out-of-band and marks the record PAID.

## What shipped

1. **Unified payout ledger** — one `Payout` model for **staff, guest clinicians, contractors, and event workers**, each with **PENDING → PAID** status (or VOID), amount, method, date, notes, and full history.
2. **Payouts page** (`/dashboard/staff/payouts`, under Staff) — pending/paid totals, status + payee-type filters, a "Record payout" modal, and per-row **Mark paid / Void / Delete**. The existing nav item was split into **Payroll** and **Payouts**.
3. **Event compensation, separate from payroll** — a payout can be linked to an event with a clinic/camp/tournament/event kind, so paying a coach for running an event is tracked independently of the payroll computation, with visible history.
4. **Action Center** — `PENDING_PAYOUTS` ("Pending payouts to send", finances-gated) so owners/finance staff see money waiting to go out, clearing when marked paid.

The payee picker (staff + contractors + events) is served by the payouts API itself, so a finance-permissioned **staff** member can use the page (the older `/api/staff` is owner-only).

## Design notes
- **`Payout` uses scalar-only foreign keys** (`payeeUserId` / `contractorId` / `eventId`) plus a denormalized `payeeName` — so I didn't have to modify the large Club/User/Event/Contractor models, and deleting a payee or event never erases payout history.
- The legacy `ContractorPayment` table is **untouched** (existing data/flow still works); new payout tracking flows through `Payout`. Unifying the contractors page onto `Payout` is an optional later cleanup.
- Permissions: viewing = `finances:view`; recording/editing/deleting = `finances:full`. Owners bypass.

## Files
**New:** `prisma/migrations/20260623000000_payouts/migration.sql`, `lib/payouts.ts`, `app/api/payouts/route.ts`, `app/api/payouts/[id]/route.ts`, `app/dashboard/staff/payouts/page.tsx`.
**Modified:** `prisma/schema.prisma` (Payout model), `lib/dashboardNav.ts` (Payroll + Payouts), `lib/permissions.ts` (payouts → finances:view), `lib/actionCenter.ts` (`PENDING_PAYOUTS`).

## Test (after deploy)
- Record a payout for each payee type (staff, guest, contractor, event worker); pending total + count update; Action Center shows "Pending payouts."
- Link a payout to an event (kind = tournament/clinic) → shows under "For" with the event name; it's separate from the payroll page.
- Mark paid → moves to PAID with method + paid date; pending total drops; Action Center clears. Void / Delete behave.
- A finance-permissioned staff member can open the page and use the pickers (not just owners); a staff member without finances can't reach it.
- Regression: payroll page, contractors page, and existing ContractorPayment flow unchanged.

## Deferred (optional follow-ups)
- "Assign payout" shortcut **on the event editor** itself (currently you link the event from the Payouts modal).
- Splitting the Action Center item into event vs contractor sub-counts (consolidated into one for now; the page filters by type).
- Migrating contractor payments onto the unified `Payout` ledger.

---

## Command-center program status
- **Phase 0** (Action Center + bell + bulk onboarding + private fan-out + public membership links) — shipped, no migration.
- **Phase 1** (tournament invoicing) — shipped, migration `20260622000000`.
- **Phase 2** (payouts) — shipped, migration `20260623000000`.

Deploy migrations in order (0 has none → 1 → 2), each: `migrate deploy && prisma generate` before `tsc`/`build`.
