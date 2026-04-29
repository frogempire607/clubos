# ClubOS Project Context

Last updated: 2026-04-29

This file is the working context for the ClubOS web app. Treat it as current-state documentation, not a product promise. Do not claim an area is complete unless it is visible in the app and verified.

## App Summary

ClubOS is a multi-tenant SaaS app for sports clubs and gyms. It has:

- Club owner/staff dashboard for members, classes, events, purchase options, staff, documents, messages, attendance, financials, and settings.
- Member portal for members/guardians to view bookings, documents, profile, and portal content.
- PostgreSQL database scoped by `clubId`.

## Current Tech Stack

- Framework: Next.js 14.2.35, App Router.
- Language: TypeScript.
- Styling: Tailwind CSS v4 plus global CSS design tokens in `app/globals.css`.
- Auth: NextAuth v4 credentials provider with JWT sessions.
- Database: PostgreSQL via Prisma ORM.
- Prisma versions: `prisma` and `@prisma/client` pinned to 5.7.0.
- Payments: Stripe Connect and Checkout routes are present.
- Bank integration: Plaid routes and settings are present, but needs end-to-end validation.
- Email: Nodemailer helper exists.
- Local dev port: `npm run dev` runs Next on `localhost:3001`.
- Local auth URL: `.env` should use `NEXTAUTH_URL=http://localhost:3001`.

Do not upgrade Next, NextAuth, Prisma, or Stripe casually. This project depends on pinned versions.

## Design System / Colors

The dashboard uses a modern dark-neutral palette with strong accents.

- Charcoal structure: `#1F1F23`
- Charcoal hover: `#2A2A2E`
- Background: `#F7F7F9`
- Surface/cards: `#FFFFFF`
- Border: `#E5E7EB`
- Text primary: `#111111`
- Text muted: `#6B7280`
- Primary accent violet: `#6D5DF6`
- Primary hover: `#5948E8`
- Success lime: `#A3E635`
- Warning/action orange: `#FF6A00`
- Error/destructive red is still allowed.

Use the Tailwind v4 theme tokens from `app/globals.css`:

- `bg-brand`, `hover:bg-brand-hover`
- `bg-lime-accent`
- `bg-orange-accent`
- `bg-charcoal`, `bg-charcoal-hover`
- `bg-app-bg`, `bg-surface`
- `border-app-border`
- `text-text-primary`, `text-text-muted`

Avoid reintroducing random Tailwind color families such as `blue-*`, `green-*`, `amber-*`, `purple-*`, `stone-*`, or hardcoded old ClubOS colors.

## Dashboard Navigation

Current dashboard sidebar structure:

- Dashboard
- Members
- Staff
  - Directory
  - Schedule
  - Availability
  - Payroll / Payouts
- Purchase Options
  - Memberships
  - Privates
  - Products
- Classes & Events
  - Classes
  - Events
  - Calendar
- Messaging
- Announcements
- Attendance
- Financials
- Reports
- Documents
- Settings

Important navigation notes:

- Memberships is not a top-level sidebar item.
- Purchase option grouped routes exist under `/dashboard/purchase-options/*` and re-export the existing top-level pages.
- Do not delete existing top-level routes yet; they may still be linked internally or bookmarked.

## Current Pages / Routes

Public/auth pages:

- `/`
- `/login`
- `/signup`
- `/forgot-password`
- `/reset-password`
- `/onboarding`

Dashboard pages:

- `/dashboard`
- `/dashboard/members`
- `/dashboard/staff`
- `/dashboard/staff/schedule`
- `/dashboard/staff/availability`
- `/dashboard/staff/payroll`
- `/dashboard/purchase-options`
- `/dashboard/purchase-options/memberships`
- `/dashboard/purchase-options/privates`
- `/dashboard/purchase-options/products`
- `/dashboard/memberships`
- `/dashboard/privates`
- `/dashboard/products`
- `/dashboard/classes`
- `/dashboard/events`
- `/dashboard/calendar`
- `/dashboard/messages`
- `/dashboard/announcements`
- `/dashboard/attendance`
- `/dashboard/financials`
- `/dashboard/reports`
- `/dashboard/documents`
- `/dashboard/custom-fields`
- `/dashboard/settings`
- `/dashboard/settings/billing`
- `/dashboard/settings/club`
- `/dashboard/schedule`

Member portal pages:

- `/member`
- `/member/bookings`
- `/member/documents`
- `/member/profile`
- `/member/signup`

## Current API Routes

Auth:

- `/api/auth/[...nextauth]`
- `/api/auth/signup`
- `/api/auth/forgot-password`
- `/api/auth/reset-password`
- `/api/auth/change-password`

Club/settings:

- `/api/club/update`
- `/api/club/info`
- `/api/club/profile`
- `/api/club/tier`
- `/api/club/notifications`
- `/api/club/locations`
- `/api/club/locations/[id]`
- `/api/club/legal-entities`
- `/api/club/legal-entities/[id]`
- `/api/club/donation-links`
- `/api/club/donation-links/[id]`

Core dashboard:

- `/api/members`
- `/api/members/[id]`
- `/api/members/[id]/credits`
- `/api/members/import`
- `/api/members/subscribe`
- `/api/memberships`
- `/api/memberships/[id]`
- `/api/custom-fields`
- `/api/custom-fields/[id]`
- `/api/classes`
- `/api/classes/[id]`
- `/api/classes/[id]/sessions`
- `/api/events`
- `/api/events/[id]`
- `/api/events/[id]/bookings`
- `/api/events/[id]/charge`
- `/api/events/[id]/staff`
- `/api/events/types`
- `/api/events/types/[id]`
- `/api/attendance`
- `/api/attendance/[sessionId]`

Messaging/documents:

- `/api/messages`
- `/api/messages/[id]`
- `/api/messages/dm`
- `/api/messages/dm/[userId]`
- `/api/messages/groups`
- `/api/messages/groups/[id]`
- `/api/announcements`
- `/api/announcements/[id]`
- `/api/documents`
- `/api/documents/[id]`

Financial/payment/product:

- `/api/transactions`
- `/api/expenses`
- `/api/expenses/[id]`
- `/api/discounts`
- `/api/discounts/[id]`
- `/api/products`
- `/api/products/[id]`
- `/api/products/[id]/sell`
- `/api/stripe/connect`
- `/api/stripe/status`
- `/api/stripe/dashboard`
- `/api/stripe/webhook`
- `/api/plaid/link-token`
- `/api/plaid/exchange`
- `/api/plaid/transactions`

Private lessons/staff/export/upload:

- `/api/private-lessons/types`
- `/api/private-lessons/types/[id]`
- `/api/private-lessons/packages`
- `/api/private-lessons/packages/[id]`
- `/api/private-lessons/bookings`
- `/api/private-lessons/bookings/[id]`
- `/api/staff`
- `/api/staff/[id]`
- `/api/staff/[id]/availability`
- `/api/staff/[id]/availability/exceptions`
- `/api/staff/[id]/pay-rates`
- `/api/export/members`
- `/api/export/attendance`
- `/api/export/transactions`
- `/api/upload`
- `/api/member/signup`
- `/api/member/portal`
- `/api/member/portal/link-child`

## Current Prisma Schema Status

`prisma/schema.prisma` validates as of 2026-04-29.

Core models currently present:

- Tenant/auth: `Club`, `Location`, `User`, `StaffProfile`
- Members/family: `Member`, `Guardian`, `MemberGuardianUser`
- Purchase options: `Membership`, `MemberSubscription`, `Discount`, `Product`, `ProductSale`
- Classes/events: `RecurringClass`, `ClassSession`, `Event`, `EventSession`, `Booking`, `ClubEventType`, `AttendanceRecord`, `EventStaffAssignment`
- Messaging/announcements: `Message`, `MessageGroup`, `MessageGroupMember`, `GroupMessage`, `Announcement`
- Documents/settings: `Document`, `CustomField`, `ClubProfile`, `LegalEntity`, `DonationLink`
- Financials: `Transaction`, `Expense`
- Private lessons/staff: `PrivateLessonType`, `PrivatePackage`, `PrivateCreditLedger`, `PrivateBooking`, `PrivateLessonPayRate`, `StaffAvailability`, `StaffAvailabilityException`

Migration folders currently present:

- `20260425040936_init`
- `20260426212544_stripe_fields`
- `20260429174803_guardian_profile`
- `20260429192044_add_missing_core_tables`

Current migration status:

- `npx prisma migrate status` reports the database schema is up to date with 4 migrations.
- `npx prisma validate` passes.

## Migration Warning Notes

- Do not use `prisma db push` for normal schema evolution.
- Do not run `prisma migrate reset` unless data loss is explicitly intended.
- Use `npx prisma migrate dev` only when intentionally changing `schema.prisma`.
- There was a previous migration failure around guardian profile data because a migration referenced `guardianEmail` before that column existed. The guardian migration has been rewritten defensively:
  - creates/renames guardian tables safely,
  - adds `guardianId` to members,
  - only backfills if legacy inline guardian columns existed before the migration,
  - avoids failing when those columns are absent.
- `20260429192044_add_missing_core_tables` is a broad migration that adds many feature tables and alters core tables. Review it carefully before editing, especially because it drops `events.price`.
- If `next build` fails with missing page modules after a dev server was running, stop the dev server and clear ignored `.next` artifacts before rebuilding.
- `next/font` fetches Google Fonts during a clean build. In restricted network environments, build may need network permission.

## Built And Working

- Auth pages and dashboard protection are present.
- Dashboard shell/sidebar navigation is present and updated to the current dark-neutral design system.
- Dashboard overview page renders stats, calendar preview, quick links, recent members, and upcoming events.
- Members page supports listing, filtering, adding/editing members, custom fields, import flow, guardian/minor fields, membership purchase modal, and export menu.
- Memberships page supports plans, options, billing controls, and discounts.
- Events page supports event listing, filters, event types, pricing fields, bookings modal, sessions, visibility/access fields, and Stripe charge route wiring.
- Classes page supports recurring class management and session viewing.
- Products page supports product listing, edit/add flow, image upload, inventory fields, and sale flow.
- Financials page has transaction, expenses, Stripe/bank/Plaid-related UI.
- Documents page has document list/editor/signature-related UI.
- Announcements page has announcement list, filters, modal, channels, and publish/unpublish dates.
- Staff directory page has staff listing and add/edit modal.
- Settings page has club/profile/settings-style sections, portal settings, legal/donation/settings controls, and password update UI.
- Export endpoints and export menu exist for members, attendance, and transactions.
- Database backup was created locally at `backups/clubos-backup-2026-04-29.sql`.

## Built But Needs Testing

- Stripe Connect onboarding, status sync, dashboard redirect, Checkout, and webhook flows.
- Member subscription activation/renewal/cancellation paths.
- Product sales and Stripe payment path.
- Event booking charge path.
- Member import edge cases, especially minors/guardians/custom fields.
- Guardian/family linking across member creation, import, and member portal.
- Attendance flows across class sessions and events.
- Documents requiring guardian signature and document expiration behavior.
- Plaid link token/exchange/transactions flow.
- Private lesson booking approval/payment/credit ledger paths.
- Staff availability, pay-rate APIs, and private lesson pay logic.
- Messaging direct/group/broadcast behavior and read states.

## Partially Built / Wired Inconsistently

- Some old top-level routes remain alongside newer grouped routes, especially purchase options.
- `/dashboard/schedule` and `/dashboard/staff/schedule` both exist; current sidebar points under Staff.
- Staff schedule, availability, and payroll pages are placeholders or thin shells compared with APIs/schema.
- Reports page is a placeholder.
- Tier gating data/UI exists in places but enforcement is not complete.
- Club branding color remains user-configurable in settings and may intentionally override accent colors in member-facing contexts.
- Member portal is present but not fully verified against all guardian/minor rules.
- Messaging and announcements both exist, but product distinction and member/guardian delivery rules need testing.
- Financials/Plaid/expenses are partially wired and need real-data validation.

## Not Built Yet

- Full tier gating and billing enforcement.
- Native mobile apps.
- Production-grade notification delivery for email/SMS/push.
- Full report builder/analytics suite.
- Complete staff payroll and payout workflow.
- Complete recurring class roster/enrollment product.
- Complete guardian account management UX across all surfaces.
- Complete document form builder with signature audit trail.
- Production file storage hardening for uploads.

## Known Issues

- Build can fail if a dev server is writing `.next` while production build reads it. Stop dev server and clear `.next` if page manifest errors appear.
- Clean builds may require network access for Google Fonts.
- `pg_dump` from PostgreSQL 16 cannot dump the local PostgreSQL 18 database. Use `/Library/PostgreSQL/18/bin/pg_dump`.
- Dashboard design is mostly tokenized, but new pages must continue using the current tokens.
- Existing routes and APIs are broad; inspect before adding duplicates.
- Some workflows have schema/API/UI present but need end-to-end validation before calling them complete.

## What To Avoid Next Time

- Do not rebuild existing features from scratch without reading current pages, APIs, schema, and migrations.
- Do not use `prisma db push`.
- Do not run `prisma migrate reset` unless explicitly intending to wipe local data.
- Do not create broad migrations that drop columns without a preservation/backfill plan.
- Do not reintroduce old color classes or random color families.
- Do not stage `.env`, `.next`, `node_modules`, local SQL backups, or debug archives.
- Do not leave dev server running while doing production build verification.
- Do not assume a feature is done because an API route exists.

## Next Priorities

- Verify all dashboard flows against real local data.
- Normalize remaining duplicate/legacy routes without deleting working pages prematurely.
- Review and harden the broad `add_missing_core_tables` migration.
- Test Stripe flows end to end with webhook forwarding.
- Test member/guardian creation, import, linking, and member portal visibility.
- Finish staff schedule/availability/payroll UX.
- Finish reports page with useful read-only analytics first.
- Add focused tests or smoke scripts for critical flows.

## Next Build Script

Use this checklist for the next development session:

1. Inspect current state first:
   - `git status --short`
   - read relevant page/API/schema files before editing
   - check whether a feature already exists partially
2. Do not rebuild existing features from scratch.
3. Make one feature branch or one commit per feature.
4. Keep changes scoped to the feature.
5. For UI changes, use the current design tokens.
6. For schema changes, use `npx prisma migrate dev`.
7. Avoid `prisma migrate reset` unless explicitly intended.
8. Run before each commit:
   - `npm run build`
   - `npx prisma validate`
   - `npx prisma migrate status`
9. Commit working checkpoints often.
10. Push after a clean checkpoint.

## Feature Ideas / To Review Later

- UI polish
- Color scheme refinements
- Member/guardian flow
- Purchase options
- Staff scheduling
- Private lessons
- Attendance
- Announcements/messaging
- Exports/reports
- Tier gating
- Stripe/ClubOS billing
- Mobile/PWA/native app path

