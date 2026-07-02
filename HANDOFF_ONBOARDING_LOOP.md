# AthletixOS — Onboarding/Migration Production-Readiness Loop
### Handoff brief for Claude Code

Drop this whole file into Claude Code (or say "read HANDOFF_ONBOARDING_LOOP.md")
before starting. Sections 0–2 are context so you don't have to re-derive the
codebase; Section 3 is the actual task; Section 4 is deferred work.

---

## 0. How to run this (read first)

**Where you are.** Next.js 14 (App Router) app lives in `web/`. API routes:
`web/app/api/**`. Pages: `web/app/**`. Prisma schema:
`web/prisma/schema.prisma`. Shared code: `web/lib/**`. Components:
`web/components/**`. Launch Claude Code at the **repo root** (git lives here);
build/verify from `web/`.

**Verify loop (do this every batch).**
```
cd web && npx tsc --noEmit && npm run build
```
`web/tsconfig.json` has `"incremental": true`. If tsc looks suspiciously clean
right after edits, delete `web/*.tsbuildinfo` and re-run — a stale incremental
cache has produced **false "clean"** results here before. `npm run build` is the
real gate.

**Deploy.** Push to GitHub `main` → Netlify auto-builds & deploys (that's the
whole pipeline; you don't deploy directly, you push). The iOS app is a Capacitor
wrapper that loads the live URL, so **no `cap:sync`** is needed.

**Database.** Postgres on Supabase. Apply migrations with
`npx prisma migrate deploy` (**not** `migrate dev`) and run it **before** pushing
code that references new columns. Add migrations only if truly needed, and
explain them.

**Recent context.** `SMOKE_TEST_FIXES_2026-06-30.md` (repo root) lists what
shipped in the last few rounds.

---

## 1. Guardrails

Do **not**: rename core models, break onboarding links, break Stripe checkout,
break active-membership detection, break role permissions, or remove existing
data. Safe migrations only, explained before/after.

**Two gotchas that already bit us:**
1. When you replace an inline auth check with `requirePermission(session, …)`,
   TypeScript loses `session` null-narrowing → the build fails with
   "'session' is possibly null." Add an explicit `if (!session) return 401;`
   before the guard.
2. Permission model: `StaffProfile.permissions` is a JSON blob. Keys:
   `members, attendance, classes, events, schedule, messages, documents,
   finances, reports, staff`. Levels: `none, view, send, edit, full`. **OWNER
   bypasses everything.** Guard server-side with `requirePermission`
   (`web/lib/apiGuard.ts`) or `hasPermission` (`web/lib/permissions.ts`).
   **Privates are gated under the `events` key**, not a "privates" key.

---

## 2. Code map (start your graph here — don't re-derive)

**Migration / member status logic** (his top priority)
- Status values `PROSPECT | ACTIVE | INACTIVE | PAUSED` on `Member` in
  `web/prisma/schema.prisma`.
- Migration state machine: `web/lib/migration.ts` (`MIGRATION_STATUS`); member
  fields `migrationStatus`, `approvalStatus`, `activatedAt`.
- Import: `web/app/api/members/import/route.ts` — normalizes status and
  currently lands migrated athletes as **PROSPECT** (this is what he wants
  changed).
- List + badges + onboarding column + filters: `web/app/dashboard/members/page.tsx`
  (`onboardingStatusOf`, `statusColors`, `onboardingColors`, the status/
  onboarding chips — note the recently added "no plan" chip).
- Status coercion (ACTIVE requires an active `MemberSubscription`):
  `web/app/api/members/route.ts` and `web/app/api/members/[id]/route.ts`.
- **Target model:** membership status (Prospect = never had a membership /
  Active = has an active sub / Inactive = ended) must be *separate* from an
  onboarding/profile status (Un-invited / Invited / Profile completed). Migrated
  members should carry an onboarding status, not be dumped into Prospect.
  Reconcile the badges, filters, list view, and onboarding actions together.

**Attendance — remove from roster**
- `web/app/dashboard/attendance/page.tsx`, `web/app/api/attendance/**`
  (incl. `charge/route.ts`), `AttendanceRecord` model.
- Add a hard **remove** (delete the `AttendanceRecord`) that leaves no record and
  is not late/absent. Keep present/late/absent/trial/drop-in intact.

**Messages — unread not marking on mobile**
- Mark-read happens on thread GET: `web/app/api/messages/dm/[userId]/route.ts`
  and `web/app/api/member/messages/dm/[userId]/route.ts`. Badge count:
  `web/app/api/member/messages/unread/route.ts` + badge in
  `web/app/member/layout.tsx`. Member inbox: `web/app/member/messages/**`.
- Verify the read-state write actually fires when a thread opens on mobile;
  confirm desktop still works.

**Staff controls audit**
- `web/lib/permissions.ts` (`PATH_PERMISSIONS`, `PERMISSION_CATALOG`),
  `web/lib/apiGuard.ts`. Grep API routes for `role !== "OWNER"` that should be
  permission-gated instead. Already fixed: 6 DELETE routes + **all** private-
  lesson routes (`web/app/api/private-lessons/**`). Audit the rest (class
  sessions, event sub-routes, financials, staff sub-pages) — allowed actions
  must actually work, blocked ones must stay blocked.

**Client Club Profile page**
- Reuse: staff directory `web/app/member/staff/page.tsx` +
  `web/app/api/member/staff/route.ts`; club bio field **already exists** as
  `Club.aboutUs` in the schema (no migration); donation links (member home card,
  already good). Build a member-facing Club Profile combining these. Owner edits
  bio via club settings / `web/app/api/me/portal-profile/route.ts` area.

**Client notifications (announcements + messages) everywhere**
- Staff side already has `web/lib/actionCenter.ts` +
  `web/components/NotificationBell.tsx`. Member unread-**messages** badge already
  exists (`web/app/member/layout.tsx` + unread endpoint). Add **announcements**
  unread + a bell/badges across client pages (mobile + desktop). Announcement
  read-state may need a field/model — check `Announcement` in the schema first.

**Private lesson member vs non-member pricing**
- `web/lib/privateLessonRules.ts` (pricing modes, `packageTotalForBasePrice`,
  `normalizePricingMode`); lesson-type tiers/price options; member views
  `web/app/member/privates/page.tsx`; request API
  `web/app/api/member/privates/route.ts`; pack buy
  `web/app/api/member/private-packages/[id]/buy/route.ts`. Resolve member vs
  non-member price by active-membership check (use `resolveFamilyContext` in
  `web/lib/memberContext.ts` + active `MemberSubscription`). Handle both single
  bookings and packages.

**Private booking payment flow (card/cash/check; no auto-Stripe)**
- Request POST `web/app/api/member/privates/route.ts` (creates `PrivateBooking`;
  `paymentType` CASH/CHECK already exists — coach confirms via `CONFIRM_PAYMENT`
  in `web/app/api/private-lessons/bookings/[id]/route.ts`). Pack buy currently
  goes straight to Stripe: `web/app/api/member/private-packages/[id]/buy/route.ts`.
  UI: `web/app/member/privates/page.tsx`. Let the client pick card/cash/check
  **before** any Stripe redirect for a single private request; packs may still
  use Stripe.

**Client booking cancel/delete**
- Already built: member cancel/request-change API
  `web/app/api/member/privates/[id]/route.ts` (PATCH `CANCEL` / `REQUEST_CHANGE`)
  + Manage sheet in `web/app/member/bookings/page.tsx`. Extend: if **paid** →
  no auto-refund, show/request-refund; if unpaid/cash/check/requested → cancel
  cleanly per current rules.

**Mobile / tablet UI (owner/staff)**
- Wide tables that won't scroll horizontally on mobile/tablet:
  `web/app/dashboard/members/page.tsx`, `web/app/dashboard/classes/page.tsx`,
  `web/app/dashboard/staff/payroll/**`, `web/app/dashboard/financials/page.tsx`
  (Stripe transactions). Wrap tables in `overflow-x-auto`, fix `md`-breakpoint
  layout + tablet button rows, and fix Staff page label alignment
  (`web/app/dashboard/staff/page.tsx`). Preserve desktop layouts.

---

## 3. THE LOOP TASK (run this)

> /graphify Read Claude.md Do not begin making code changes until you have finished graphing the relevant code paths and understand how onboarding, migration, memberships, attendance, messaging, and permissions interact. We need a careful loop pass to finally make onboarding/member migration production-ready. Do not do a huge risky rewrite. Work in small batches, verify each fix, and keep existing working behavior intact.
>
> Goal: Owner/staff and client-side onboarding/migration flow must be clean enough for real members.
>
> LOOP PROCESS:
>
> 1. Inspect current implementation first.
> 2. Identify the exact files/routes/components involved.
> 3. Fix one issue group at a time.
> 4. Run typecheck/lint/build/tests if available.
> 5. Manually verify the affected routes.
> 6. Report what changed, what was verified, and any remaining risks.
> 7. Do not break Stripe, memberships, migration, login, or existing role permissions.
>
> OWNER / STAFF SIDE FIXES
>
> Mobile + Tablet UI:
>
> * Fix mobile/tablet UI issues across owner/staff pages.
> * Many pages require horizontal scrolling to edit/read full content, but currently cannot scroll properly.
> * Specifically check: Members, Classes, Payroll, Stripe Transactions.
> * Preserve desktop layouts, but make mobile/tablet usable.
> * Fix labels that look misaligned or broken, especially Staff page labels.
> * Buttons work fine on phone but have tablet issues. Fix tablet button layout/responsiveness.
>
> Migration/member status logic:
>
> * Do NOT mark migrated athletes as Prospect by default.
> * Migrated members should have onboarding/profile status like:
>   * Un-invited
>   * Invited
>   * Profile completed
> * Prospect should mean kids/families who have never had a membership.
> * Active should mean currently active membership.
> * Inactive should mean membership ended.
> * Make sure filters, badges, member list views, and onboarding actions reflect this correctly.
>
> Attendance:
>
> * Owner and staff need a way to fully remove/cancel a client from a class attendance roster when added by accident.
> * This should not mark them late or absent.
> * This should not keep an attendance record.
> * Keep late/absent/present behavior intact.
>
> Messages:
>
> * Mobile issue: messages are not being marked unread correctly.
> * Fix unread/read state on mobile.
> * Verify desktop behavior still works.
>
> Staff controls:
>
> * Staff member controls need to work across the board.
> * Audit staff permissions/actions and fix anything blocked or broken unintentionally.
> * Staff should only access what they are allowed to access, but allowed actions must actually work.
>
> CLIENT SIDE FIXES
>
> Club Profile:
>
> * Client side needs a Club Profile area/page.
> * Include:
>   * Staff directory
>   * Club bio
>   * Existing donation links, which already look good
> * Keep the design clean and member-friendly.
>
> Notifications:
>
> * Announcements and Messages need notifications visible on every client page.
> * Add a bell if appropriate.
> * Add badges/counts on dashboard cards or nav items for unread announcements/messages.
> * Make this work on mobile and desktop.
>
> Private lesson pricing:
>
> * There must be clear member vs non-member pricing for privates.
> * If a client has an account but no active membership, they should see non-member pricing when owner/staff configured it.
> * Active members should see member pricing.
> * Make sure this works for private packages and individual private booking if both exist.
>
> Private booking payment flow:
>
> * For private booking, card/cash/check should be the second option.
> * Clients should be able to request a private without being forced into Stripe if they choose cash/check.
> * Buying a pack can still go to Stripe when appropriate.
> * Do not auto-send clients to Stripe before they choose the payment path.
>
> Client booking cancel/delete:
>
> * Clients should be able to delete/cancel bookings.
> * If already paid, they should not auto-refund. They should see/request refund instead.
> * If unpaid/cash/check/requested, cancellation should remove/cancel the booking cleanly according to current booking rules.
>
> DEFERRED BUT TRACK:
> Do not complete unless it fits safely after the main fixes, but leave notes/todos if not done:
>
> * Cash/check members adding a card + all guardians getting access with first guardian setting controls. This is the billing/multi-guardian batch.
> * Club not pre-filled on standalone login. It currently pre-fills when arriving via a club link. This is a small follow-up.
>
> IMPORTANT:
>
> * Do not rename core models casually.
> * Do not break onboarding links.
> * Do not break Stripe checkout.
> * Do not break active membership detection.
> * Do not remove existing data.
> * Add safe migrations only if needed.
> * If database changes are required, explain them clearly before/after.
> * Prioritize getting migrated members invited/onboarded correctly.
>
> Final report should include:
>
> * Files changed
> * Fixes completed
> * Tests/checks run
> * Manual routes verified
> * Anything deferred

---

## 4. Deferred (leave TODOs if not done)
- Cash/check members adding a card + all guardians getting access with the first
  guardian setting controls — the billing/multi-guardian batch. (Note: onboarding
  a member by cash/check already works via the activation link → Members →
  Approvals → "Approve & start membership". The gap is the *in-portal* new
  purchase + save-card + multi-guardian permissions.)
- Club not pre-filled on the standalone login (it prefills when arriving via a
  club link). Small follow-up — could remember last club in localStorage.

---

### Note on `Claude.md`
The task says "Read Claude.md." If a `CLAUDE.md` / `Claude.md` doesn't exist at
the repo root yet, create one first capturing Sections 0–1 above (stack, verify
loop, deploy pipeline, guardrails, permission model) so future runs start with
that context.
