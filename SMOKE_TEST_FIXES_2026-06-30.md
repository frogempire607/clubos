# AthletixOS — Fix Batch (2026-06-30)

All changes on disk under `web/`. **Code-only, no Prisma migration.** Push from
your machine. Run `cd web && npx tsc --noEmit && npm run build` before committing.

## Phase 1 + 2 — already pushed & deployed ✅
(See git history. Permissions/delete fixes, staff forgot-password, private
Reopen, dark-dropdown CSS, "no membership" chip, member↔coach "For {child}"
threads, member manage-booking, attendance Cash/Check/Credit + receipt, all-event
Estimated/Official invoicing, multiple owners, manual-2nd-child auto-link,
co-guardian email activation, member invites, mobile nav hide-on-scroll, plus the
8 session-null build fixes.)

## Phase 3 — new since the deploy (push these)
- **Member unread-message badge** — Messages tab in the portal shows a red unread
  count that clears after opening.
  - NEW `web/app/api/member/messages/unread/route.ts`
  - `web/app/member/layout.tsx`
- **Privates one front-door** — the member **Bookings** page now has a "Request a
  private" button (Bookings already handles manage/cancel). Kept the separate
  Privates page reachable since you said it's efficient.
  - `web/app/member/bookings/page.tsx`

Push: `cd web && npx tsc --noEmit && npm run build`, then commit + push. No migration.

## NEXT focused batch (not started — recommend after you validate the above)
**Cash/check is NOT blocking your merge.** Members onboarded via an activation
link who choose Cash/Check already flow to Members → Approvals ("Membership
billing — Paying by cash/check" → "Approve & start membership").

What's left is the *in-portal* side — billing-critical, deserves its own pass +
test cycle. All **code-only** (reuses PendingApproval, no migration):
- Existing member buys a NEW membership by Cash/Check in-portal → approval → activate.
- Private packs by Cash/Check (single lessons already allow it).
- "Add a card for future use only" (Stripe SetupIntent) — the one new Stripe piece.
- Reassign a purchase from a booking's edit.

## Smoke test
Run `AthletixOS_Smoke_Test_2026-06-30.pdf` (this folder) top-to-bottom after deploy.

## Already working (no action)
- PWA "Add to Home Screen" card shows to clients.
- Member "Our team" page exists (`/member/staff`).
