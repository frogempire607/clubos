# AthletixOS Project Context

Last updated: 2026-05-03

This file is the working context for the AthletixOS web app. Treat it as current-state documentation, not a product promise. Do not claim an area is complete unless it is visible in the app and verified.

## App Summary

AthletixOS is a multi-tenant SaaS app for sports clubs and gyms. It has:

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

### Theming

The dashboard supports a per-browser light/dark toggle (`components/ThemeToggle.tsx`).
- Persisted in `localStorage["athletixos-theme"]` (no DB column).
- Applied via `<html data-theme="dark">`. A small no-flash inline script in `app/layout.tsx` runs before first paint.
- Dark mode overrides `--color-bg`, `--color-surface`, `--color-border`, `--color-text`, `--color-muted`, and the sidebar tokens in `:root`.
- Tailwind v4 `@theme` tokens (`--color-app-bg`, `--color-surface`, `--color-app-border`, `--color-text-primary`, `--color-text-muted`) reference the `:root` vars via `var()`, so utility classes (`bg-app-bg`, `bg-surface`, `text-text-primary`, etc.) flip with the theme automatically.
- Member portal pages intentionally use raw `bg-stone-*` / `bg-white` Tailwind classes and do **not** flip with the toggle — the portal stays light/club-branded regardless of the owner's preference.

Use the Tailwind v4 theme tokens from `app/globals.css`:

- `bg-brand`, `hover:bg-brand-hover`
- `bg-lime-accent`
- `bg-orange-accent`
- `bg-charcoal`, `bg-charcoal-hover`
- `bg-app-bg`, `bg-surface`
- `border-app-border`
- `text-text-primary`, `text-text-muted`

Avoid reintroducing random Tailwind color families such as `blue-*`, `green-*`, `amber-*`, `purple-*`, `stone-*`, or hardcoded old AthletixOS colors.

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
- Communication
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

- `/` — marketing landing page (hero, features, embedded tiers, CTA, footer)
- `/pricing` — dedicated tier comparison page with table + FAQ; linked from landing nav and footer
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
- `/dashboard/settings/member-form`
- `/dashboard/schedule`

Member portal pages:

- `/member`
- `/member/bookings`
- `/member/documents`
- `/member/profile`
- `/member/signup`
- `/member/announcements`
- `/member/messages`
- `/member/messages/dm/[userId]`
- `/member/messages/group/[id]`
- `/member/memberships`
- `/member/events`
- `/member/products`
- `/member/shop` — purchase-options hub
- `/member/staff` — visible coach/owner bios + contact

## Current API Routes

Auth:

- `/api/auth/[...nextauth]`
- `/api/auth/signup`
- `/api/auth/forgot-password`
- `/api/auth/reset-password`
- `/api/auth/change-password`

Club/settings:

- `/api/club/update` — also writes `aboutUs`
- `/api/club/info` — returns `aboutUs` for the dashboard settings page
- `/api/club/profile`
- `/api/club/tier`
- `/api/club/notifications`
- `/api/club/locations`
- `/api/club/locations/[id]`
- `/api/club/legal-entities`
- `/api/club/legal-entities/[id]`
- `/api/club/donation-links`
- `/api/club/donation-links/[id]`
- `/api/club/member-form` — GET/PUT for the member intake form config (drives Add Member modal + CSV import requirements)

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
- `/api/classes/[id]/charge` — paid drop-in / membership-covered class registration
- `/api/events`
- `/api/events/[id]`
- `/api/events/[id]/bookings`
- `/api/events/[id]/charge`
- `/api/events/[id]/staff`
- `/api/events/types`
- `/api/events/types/[id]`
- `/api/attendance`
- `/api/attendance/[sessionId]` — also returns the parent class's `pricingOptions` and resolved `acceptedMemberships`

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
- `/api/member/club` — public-facing club info for the member portal (logo, tagline, aboutUs)
- `/api/member/staff` — visible staff (only `showOnPortal=true`) with bios + public contact
- `/api/member/announcements`
- `/api/member/documents`
- `/api/member/messages`
- `/api/member/messages/dm/[userId]`
- `/api/member/messages/groups/[id]`
- `/api/member/memberships`
- `/api/member/memberships/subscribe`
- `/api/member/events`
- `/api/member/events/[id]/register`
- `/api/member/products`
- `/api/member/products/[id]/buy`

## Current Prisma Schema Status

`prisma/schema.prisma` validates as of 2026-05-03.

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
- `20260429203000_add_class_assigned_staff` — adds `recurring_classes.assignedStaffIds` (JSONB, default `[]`)
- `20260503031252_add_member_form_about_staff_bios` — adds `clubs.memberFormConfig` (JSONB, nullable), `clubs.aboutUs` (text, nullable), and `staff_profiles.bio` / `publicEmail` / `publicPhone` / `photoUrl` / `showOnPortal` (default false).

Current migration status:

- `npx prisma migrate status` reports the database schema is up to date with 6 migrations.
- `npx prisma validate` passes.
- The `add_class_assigned_staff` migration was sitting unapplied and silently broke `POST/PATCH /api/classes` (Postgres rejected writes referencing the missing column). Applied via `npx prisma migrate deploy` on 2026-04-30. If a model's writes start failing without code changes, run `npx prisma migrate status` first.

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
- Public marketing landing page at `/` with embedded tiers, plus dedicated `/pricing` page (4-tier card grid, comparison table across all tiers, FAQ section, final CTA).
- Members CSV import mapping mirrors the Add Member form: name, email, phone, DOB, gender, full address, status, tags, notes, isMinor, guardian (name/email/phone/relationship), and any active custom fields. The "Membership / purchase option" mapping is removed — memberships are no longer assigned via CSV.
- Class & Event create/edit forms have a top-level "Accepted Memberships / Purchase Options" multi-select. Always rendered; empty-state shows a link to `/dashboard/memberships` when no active plans exist. Selection persists on edit. Memberships are stored as `pricingOptions: [{ type: "membership", membershipId }, ...]` on the existing JSON column on `RecurringClass` / `Event` — no new schema field added.
- Membership-based free booking is wired:
  - `POST /api/events/[id]/charge` — if the member has an active `MemberSubscription` matching one of the event's accepted memberships, creates a confirmed (or waitlisted) `Booking` for free and returns `{ coveredByMembership: true }` instead of a Stripe URL.
  - `POST /api/classes/[id]/charge` — same logic for class sessions; on covered match, upserts an `AttendanceRecord` with status `PRESENT`. Otherwise opens a Stripe Checkout for `MEMBER` / `NON_MEMBER` / `DROP_IN` price.
- Attendance panel "Add Member" search now has a "Register" button that expands an inline pricing chooser (Use accepted membership / Member / Non-member / Drop-in). Header surfaces "Accepted memberships: …" pulled from the new fields on `/api/attendance/[sessionId]`. The Event Bookings modal does the same.
- Stripe webhook (`checkout.session.completed`) handles a new `classId + classSessionId` branch: records a `Transaction` with `type="CLASS"` and upserts the `AttendanceRecord` to status `DROP_IN`.
- Legacy `Event.allowMembershipPayment` checkbox is hidden; the boolean is now derived from the multi-select on save (`allowMembershipPayment = allowedMembershipIds.length > 0`) so the schema field stays consistent without a separate UI toggle.
- `PATCH /api/classes/[id]` schema now accepts `daysOfWeek`, `startTime`, `endTime`, `recurrenceStartDate`, `recurrenceEndDate` (these were previously stripped silently, so edits to days/times/dates didn't persist). Date strings are converted to `Date` in the handler.
- Brand assets live in `public/brand/` (`logo.PNG`, `logo-light.PNG`, `icon.png`, `circle.PNG`, `tagline.png`). Wired into landing/pricing nav (full wordmark at 56 px height inside a 72 px header), member layout (icon badge + wordmark on the light bar), dashboard sidebar (icon + wordmark), login/signup (`circle.PNG` as a 96 px hero mark), onboarding, manifest icons, and Next.js auto-favicon at `app/icon.png`. The slogan **"Run your club. All in one system."** drives the landing hero headline.
- Tier model: `directMessaging` and private lessons are available on **every** tier (Starter through Enterprise). Pricing page card highlights and the comparison table reflect this. The owner-side messaging routes (`/api/messages/dm`, `/api/messages/groups`) still call `requireGrowth` — the gate is currently a no-op since `directMessaging=true` on Starter, but the helper is still in place if the policy ever flips back.
- Light/dark dashboard theme toggle in the sidebar (`components/ThemeToggle.tsx`). Persisted in localStorage; applied via `[data-theme="dark"]` on `<html>` with a no-flash inline script in `app/layout.tsx`. Member portal stays light by design.
- Sidebar Communication group: Messaging + Announcements are nested under a single "Communication" parent. Sidebar icons rendered at fontSize 17 (was 12) in a wider 22 px gutter for legibility.
- **Member intake form builder** (`/dashboard/settings/member-form`, helper lib `lib/memberForm.ts`):
  - Stored on `Club.memberFormConfig` JSON: `{ enabledFields: string[], requiredFields: string[] }`.
  - Defaults to enabled `[athleteName, email]` and required `[athleteName, email]`.
  - Athlete name is always shown and always required (athleteName is a synthetic key that maps to `firstName + lastName` in the underlying schema).
  - Email is always shown; required state configurable.
  - Owner toggles which built-in fields show on the Add Member modal AND which are required. Custom fields continue to live in `CustomField`; their required state is still driven by `CustomField.required`.
  - **First-run gate**: `/dashboard/members` shows a setup screen when `members.length === 0` AND no config has been saved. "Keep the defaults" PUTs the default config so the gate clears.
  - The Add Member modal honors `enabledFields` (only shows them) and `requiredFields` (sets `required` on each input) per the config.
  - The CSV import mapping dropdown only offers enabled keys; the **Preview import** button is disabled until every required field has a CSV column mapped, with the missing fields listed inline.
  - Guardian name/email/phone are always available on import (they're conditional on `isMinor=true`, not toggleable).
- **Club personalization for the member portal**:
  - `Club.aboutUs` (text, max 5000 chars) editable on `/dashboard/settings/club`. Sent through `/api/club/update`.
  - Logo upload (not URL): the existing `<ImageUpload>` component on `/dashboard/settings/club` writes to `/api/upload` and stores the resulting URL on `Club.logoUrl` — same flow as before, just confirmed working.
  - `StaffProfile` gained `bio`, `publicEmail`, `publicPhone`, `photoUrl`, `showOnPortal`. Edited on `/dashboard/staff` Edit Staff modal in a "Member portal profile" section that hides the bio/contact fields when the toggle is off.
  - New endpoints: `/api/member/club` (logo, name, tagline, aboutUs) and `/api/member/staff` (only profiles with `showOnPortal=true`).
  - New page: `/member/staff` with photo, title, bio, mailto/tel links.
  - Member portal home (Adult, Minor, Parent views) renders a `ClubBanner` showing logo + name + tagline + About Us with a "Read more" expand for long copy. Home grid gains an "Our team" card linking to `/member/staff`.

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
- Membership-covered class/event registration: pick member with active sub on an accepted plan and confirm free booking is created.
- Paid class drop-in via `/api/classes/[id]/charge` → Stripe Checkout → webhook creating `Transaction` (`type="CLASS"`) and `AttendanceRecord` (`DROP_IN`). Currently the paid path requires the staff/member to complete checkout before attendance is recorded; if abandoned, no record is left behind.
- Class edit persistence after the PATCH-schema fix (verify days-of-week / start time / end time / recurrence date changes survive a reload).
- Member self-purchase flows: `/member/memberships` → Stripe subscription Checkout → webhook activates the `MemberSubscription`; `/member/products/[id]/buy` → Checkout → webhook flips sale to `COMPLETED` and decrements inventory; `/member/events/[id]/register` paid path → Checkout → webhook now also creates the `Booking` (closed the previous gap).
- Theme toggle: confirm dashboard pages render correctly when flipped; `bg-app-bg` / `bg-surface` / `text-text-*` / `border-app-border` classes inherit through Tailwind v4 `@theme` `var()` references. Anything still using raw light Tailwind classes will not flip.
- Member form builder + first-run gate: confirm a fresh club lands on the setup screen, can save defaults to clear the gate, and that requiring an extra field then importing a CSV without it correctly blocks Preview.
- Club personalization: confirm logo upload on `/dashboard/settings/club` round-trips through `/api/upload` and renders on `/member` ClubBanner; confirm a staff member toggled `showOnPortal=true` appears on `/member/staff` while toggled-off staff are excluded.

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
- Add Staff (invite) modal does **not** collect bio/photo/public-contact fields yet — only the Edit Staff modal does. Owner adds the staff member, then opens Edit to fill the public profile.
- Tier-gating helper `requireGrowth` in `/api/messages/*` is now effectively a no-op (Starter has `directMessaging=true`). If the policy ever flips, the gate is still in place; otherwise it can be removed safely.
- Member-side messaging endpoints don't apply tier gating — they just check session. Same with member-side memberships/events/products endpoints.
- Member portal explicitly stays light-themed; raw `bg-stone-*` / `bg-white` / `text-stone-*` classes there are intentional and will not respond to the dashboard dark-mode toggle.

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
- Theme preference persisted to a User column (currently localStorage only — toggling on a different device starts in light mode).
- Bio/photo/public-contact fields in the Add Staff (invite) modal — currently Edit-only.
- Optimized/compressed brand assets (`logo.PNG` and `circle.PNG` are ~1 MB each; fine for dev, should be compressed or converted to optimized variants before production rollout).

## Known Issues

- Build can fail if a dev server is writing `.next` while production build reads it. Stop dev server and clear `.next` if page manifest errors appear.
- Clean builds may require network access for Google Fonts.
- `pg_dump` from PostgreSQL 16 cannot dump the local PostgreSQL 18 database. Use `/Library/PostgreSQL/18/bin/pg_dump`.
- Dashboard design is mostly tokenized, but new pages must continue using the current tokens.
- Existing routes and APIs are broad; inspect before adding duplicates.
- Some workflows have schema/API/UI present but need end-to-end validation before calling them complete.
- Pending Prisma migrations silently break write paths long after schema/code look correct. Always check `npx prisma migrate status` first when a single model's writes start failing.
- The Events bookings flow (and now Classes) opens Stripe Checkout in a new tab and does not auto-create the booking client-side; the membership-covered branch creates it inline, the paid branch relies on the webhook.

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
- Stripe/AthletixOS billing
- Mobile/PWA/native app path

