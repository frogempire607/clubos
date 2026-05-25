# AthletixOS Project Context

Last updated: 2026-06-01 (Owner Dashboard phases 4-6)

This file is the working context for the AthletixOS web app. Treat it as current-state documentation, not a product promise. Do not claim an area is complete unless it is visible in the app and verified.

## App Summary

AthletixOS is a multi-tenant SaaS app for sports clubs and gyms. It has:

- Club owner/staff dashboard for members, classes, events, purchase options, staff, documents, messages, attendance, financials, reports, and settings.
- Member portal for members/guardians to view bookings, documents, profile, and portal content. Guardian/minor flows with child-switching and audited document signatures.
- PostgreSQL database scoped by `clubId`.
- Two-sided Stripe integration: Stripe Connect for member → club payments, plus a separate platform-account subscription for clubs paying AthletixOS.

## Current Tech Stack

- Framework: Next.js 14.2.35, App Router.
- Language: TypeScript.
- Styling: Tailwind CSS v4 plus global CSS design tokens in `app/globals.css`.
- Auth: NextAuth v4 credentials provider with JWT sessions.
- Database: PostgreSQL via Prisma ORM.
- Prisma versions: `prisma` and `@prisma/client` pinned to 5.7.0.
- Payments: Stripe Connect (member → club) and Stripe platform subscription (club → AthletixOS).
- Bank integration: Plaid routes and settings present.
- Email: Nodemailer helper with transactional templates wired into key flows.
- File storage: private on-disk store under `process.env.UPLOADS_DIR` (default `./storage/uploads`), served only through `/api/files/[id]` with club scoping.
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

## Tier Model

**Three paid tiers** stored on `Club.tier` — there is NO free/Starter tier. Definitions live in `lib/tier.ts` (single source of truth; `normalizeTier()` maps any legacy/unknown value incl. `"starter"` → `growth`). `Club.tier` defaults to `growth`.

| Tier       | Monthly | Tx fee | Members   | Locations  | Notable extras                                                       |
|------------|---------|--------|-----------|------------|----------------------------------------------------------------------|
| Growth     | $50     | 0%     | 200       | 1          | Classes/events/attendance, memberships, private lessons, messaging, reports, CSV import |
| Pro        | $99     | 0%     | Unlimited | 3          | + Plaid, email/SMS, branded app, advanced analytics, priority support |
| Enterprise | $199+   | 0%     | Unlimited | Unlimited  | + API, SSO, advanced permissions, custom onboarding, enterprise reporting |

AthletixOS takes **0% per-transaction platform fee on every tier** (`lib/stripe.ts` `calculatePlatformFee` always 0). Clubs may optionally pass Stripe's processing fee to the customer at checkout — centralized in `lib/fees.ts` (`Club.passProcessingFees`), toggled on the billing settings page, never hardcoded elsewhere.

Tier enforcement: `/api/members` (maxMembers 200 on Growth → upgrade to Pro), `/api/club/locations` (maxLocations), `/api/reports/overview` (reports), `/api/plaid/*` (plaid), `/api/announcements` (emailSms). On platform-sub cancel the webhook keeps the tier and only sets `subscriptionStatus:"canceled"` (no Starter fallback).

## Staff Permissions

`lib/permissions.ts` is the single source of truth (10 keys: members, attendance, classes, events, schedule, messages, documents, finances, reports, staff). Permissions live in the JWT (set at login) + are surfaced live via `/api/me`. Middleware enforces per-section access for STAFF (owners bypass everything). `lib/apiGuard.ts` `requirePermission`/`requireOwner` guard API routes. **Permission-gating ≠ tier-gating** — never tier-gate cash/financial tracking.

## Financial OS

Lightweight accounting/tax-prep helper (NOT QuickBooks), permission-gated on `finances`, **never tier-gated**. `lib/financials.ts` (categories, payment methods incl. CASH/COMP/INVOICE, `isCashMethod`/`isCompMethod`, disclaimers) + `lib/financialReports.ts` (`buildReport`/`reportToCsv`). Transaction/Expense/Donation carry `legalEntityId` + `category` + `paymentMethod`; `Transaction.manual=true` for cash/comp/invoice (only manual records are deletable — never delete Stripe records). Reports separate Card / Cash / Comp / Invoiced. Cash option exists everywhere via `/api/financials/manual-payment` (Money In tab) and `/api/attendance/charge` (at-the-door non-member drop-in/trial/guest). Disclaimer shown; never claims tax filing.

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
- `/dashboard/staff/schedule` — weekly grid of availability + class/event assignments per staff
- `/dashboard/staff/availability` — per-staff weekly slots + date exceptions
- `/dashboard/staff/payroll` — date-ranged payroll table with CSV export
- `/dashboard/purchase-options`, `.../memberships`, `.../privates`, `.../products`
- `/dashboard/memberships`, `/dashboard/privates`, `/dashboard/products`
- `/dashboard/classes`
- `/dashboard/events`
- `/dashboard/calendar` — unified Events + Classes + Private Lessons monthly grid with kind + subtype filters
- `/dashboard/messages`
- `/dashboard/announcements`
- `/dashboard/attendance`
- `/dashboard/financials`
- `/dashboard/reports` — KPI cards, revenue chart, breakdowns, top events, CSV exports (gated by tier)
- `/dashboard/documents`
- `/dashboard/custom-fields`
- `/dashboard/help` — searchable help/FAQ center (knowledge base `lib/helpContent.ts`; retrieval = `/api/help/search`, AI-assistant-ready, no AI built)
- `/dashboard/settings`
- `/dashboard/settings/billing` — Stripe Connect + ClubOS subscription upgrade/portal + Diagnostics link
- `/dashboard/settings/club`
- `/dashboard/settings/member-form`
- `/dashboard/settings/diagnostics` — Stripe diagnostics: setup checklist, env vars, webhook event log
- `/dashboard/schedule` (legacy; kept for back-compat)

Member portal pages:

- `/member`
- `/member/bookings` — child-switcher for parents; shows bookings per accessible member
- `/member/documents` — child-switcher + sign / re-sign with audit trail and frequency-based expiry
- `/member/profile`
- `/member/signup`
- `/member/announcements`
- `/member/messages`, `.../dm/[userId]`, `.../group/[id]`
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
- `/api/club/info` — returns logo, tier, subscriptionStatus, stripeSubscriptionId, etc.
- `/api/club/profile`
- `/api/club/tier` — promo-code path only; paid tier upgrades go through `/api/club/subscription/checkout` (returns 400 if a paid tier is set without promo)
- `/api/club/notifications`
- `/api/club/locations`, `/api/club/locations/[id]` — `maxLocations` enforced from tier
- `/api/club/legal-entities`, `/api/club/legal-entities/[id]`
- `/api/club/donation-links`, `/api/club/donation-links/[id]`
- `/api/club/member-form` — GET/PUT for member intake form config
- `/api/club/subscription/checkout` — start Stripe Checkout for the ClubOS-own subscription (platform Stripe account, not Connect)
- `/api/club/subscription/portal` — open Stripe Billing Portal for the club owner

Core dashboard:

- `/api/members`
- `/api/members/[id]`
- `/api/members/[id]/credits`
- `/api/members/import`
- `/api/members/subscribe` — manual MANUAL path now calls `recomputeMemberStatus` so members flip ACTIVE immediately on assignment; honors `Membership.trialEnabled/trialDays/trialAppliesToReturning`
- `/api/members/subscriptions/[subId]` (DELETE) — owner cancel: cancels on Stripe (if attached) + locally + recomputes member status
- `/api/memberships`, `/api/memberships/[id]` — schema accepts trial fields
- `/api/custom-fields`, `/api/custom-fields/[id]`
- `/api/classes`, `/api/classes/[id]` — supports `dayOverrides`; PATCH regenerates future non-canceled sessions when scheduling changes, preserving sessions with attendance
- `/api/classes/[id]/sessions`
- `/api/classes/[id]/charge` — emits booking confirmation email on free membership-covered path
- `/api/events`, `/api/events/[id]`
- `/api/events/[id]/bookings`
- `/api/events/[id]/charge` — emits booking confirmation email on free membership-covered path
- `/api/events/[id]/staff`
- `/api/events/types`, `/api/events/types/[id]`
- `/api/attendance`
- `/api/attendance/[sessionId]` — also returns the parent class's `pricingOptions` and resolved `acceptedMemberships`
- `/api/calendar` — unified feed of events + class sessions + confirmed private lessons (used by `/dashboard/calendar`)
- `/api/search?q=` — universal club-scoped, permission-filtered search (members/staff/classes/events/products/memberships/documents/messages) with deep links; powers the dashboard top-bar `GlobalSearch` (⌘K, recent searches)
- `/api/help/search?q=` — keyword retrieval over `lib/helpContent.ts` (the layer a future AI assistant will call)

Reports:

- `/api/reports/overview?range=…` — tier-gated; returns revenue / member counts / subscription counts / attendance / top events / 12-month revenue series

Messaging/documents:

- `/api/messages`, `/api/messages/[id]`
- `/api/messages/dm`, `/api/messages/dm/[userId]`
- `/api/messages/groups`, `/api/messages/groups/[id]`
- `/api/announcements`, `/api/announcements/[id]` — broadcast emails gated on `emailSms` tier flag
- `/api/documents`, `/api/documents/[id]` — schema accepts `signatureValidForDays`
- `/api/documents/[id]/signatures` — owner audit trail listing every signature on a document

Files:

- `/api/upload` — writes to `process.env.UPLOADS_DIR` (default `./storage/uploads`, gitignored, outside `public/`) with random storage key; returns `/api/files/[id]` URL
- `/api/files/[id]` — authenticated file serving; verifies `session.user.clubId === file.clubId`

Financial/payment/product:

- `/api/transactions`
- `/api/expenses`, `/api/expenses/[id]`
- `/api/discounts`, `/api/discounts/[id]`
- `/api/products`, `/api/products/[id]`
- `/api/products/[id]/sell`
- `/api/stripe/connect`
- `/api/stripe/status`
- `/api/stripe/dashboard`
- `/api/stripe/webhook` — idempotent (skips known event IDs), logs every event to `StripeWebhookEvent`, handles Connect events (member sub activate / renewal / payment_failed) AND platform events (ClubOS-own subscription activate / update / cancel)
- `/api/stripe/diagnostics` — owner-only; returns Connect + platform status, env checklist, event counts, last 50 events
- `/api/plaid/link-token`, `/api/plaid/exchange`, `/api/plaid/transactions` — gated on `plaid` tier flag

Private lessons/staff/export:

- `/api/private-lessons/types`, `.../types/[id]`
- `/api/private-lessons/packages`, `.../packages/[id]`
- `/api/private-lessons/bookings`, `.../bookings/[id]`
- `/api/staff`, `/api/staff/[id]`
- `/api/staff/[id]/availability`, `/api/staff/[id]/availability/exceptions`
- `/api/staff/[id]/pay-rates`
- `/api/staff/schedule?from=&to=` — weekly schedule aggregator (availability + classes + events)
- `/api/staff/payroll?from=&to=` — computes scheduled hours, class teaching hours (from `RecurringClass.assignedStaffIds`), hourly pay, salary, private lesson pay
- `/api/export/members`, `/api/export/attendance`, `/api/export/transactions`

Member-side:

- `/api/member/signup`
- `/api/member/portal`
- `/api/member/portal/link-child`
- `/api/member/me` — GET/PATCH/DELETE own profile
- `/api/member/club` — public club info for portal (logo, tagline, aboutUs)
- `/api/member/staff` — visible staff (only `showOnPortal=true`)
- `/api/member/announcements`
- `/api/member/documents?memberId=…` — context-aware; returns docs + signature status for a given accessible member (self or linked child); signature includes `expiresAt`/`expired` based on `signatureValidForDays`
- `/api/member/documents/[id]/sign` — POST persists a `DocumentSignature` with relationship (SELF | GUARDIAN), IP, user agent; enforces that minors can't self-sign guardian-required docs
- `/api/member/messages`, `.../dm/[userId]`, `.../groups/[id]`
- `/api/member/memberships`
- `/api/member/memberships/subscribe` — honors trial rules
- `/api/member/billing-portal`
- `/api/member/events`
- `/api/member/events/[id]/register` — emits booking confirmation email on free paths
- `/api/member/products`, `.../products/[id]/buy`

## Current Prisma Schema Status

`prisma/schema.prisma` validates as of 2026-05-15.

Core models currently present:

- Tenant/auth: `Club`, `Location`, `User`, `StaffProfile`
- Members/family: `Member`, `Guardian`, `MemberGuardianUser`
- Purchase options: `Membership`, `MemberSubscription`, `Discount`, `Product`, `ProductSale`
- Classes/events: `RecurringClass`, `ClassSession`, `Event`, `EventSession`, `Booking`, `ClubEventType`, `AttendanceRecord`, `EventStaffAssignment`
- Messaging/announcements: `Message`, `MessageGroup`, `MessageGroupMember`, `GroupMessage`, `Announcement`
- Documents/settings: `Document`, `DocumentSignature`, `CustomField`, `ClubProfile`, `LegalEntity`, `DonationLink`
- Financials: `Transaction`, `Expense`
- Private lessons/staff: `PrivateLessonType`, `PrivatePackage`, `PrivateCreditLedger`, `PrivateBooking`, `PrivateLessonPayRate`, `StaffAvailability`, `StaffAvailabilityException`
- Infra: `UploadedFile`, `StripeWebhookEvent`

Notable model fields added since 2026-05-03:

- `Document.signatureValidForDays Int?` — null = sign-once, otherwise days until re-signature required
- `Membership.trialEnabled Boolean`, `trialDays Int?`, `trialAppliesToReturning Boolean`
- `RecurringClass.dayOverrides Json` — `[{ dayOfWeek, startTime, endTime }, …]` — overrides default start/end times on specific days
- `Club.subscriptionStatus String?`, `stripeSubscriptionId String? @unique` (used for platform-side billing)

Migration folders currently present:

- `20260425040936_init`
- `20260426212544_stripe_fields`
- `20260429174803_guardian_profile`
- `20260429192044_add_missing_core_tables` — broad migration; drops `events.price`
- `20260429203000_add_class_assigned_staff` — adds `recurring_classes.assignedStaffIds` (JSONB, default `[]`)
- `20260503031252_add_member_form_about_staff_bios` — adds `clubs.memberFormConfig` (JSONB, nullable), `clubs.aboutUs` (text, nullable), and `staff_profiles.bio`/`publicEmail`/`publicPhone`/`photoUrl`/`showOnPortal`
- `20260503103157_add_club_public_profile` — adds `clubs.contactEmail`, `contactPhone`, `coverImageUrl`, `hoursOfOperation`, `socialLinks`, `websiteUrl`
- `20260514000000_add_document_signatures` — `document_signatures` table
- `20260514100000_uploaded_files_and_sig_frequency` — `uploaded_files` table + `documents.signatureValidForDays`
- `20260514110000_stripe_webhook_events` — `stripe_webhook_events` table
- `20260515000000_class_overrides_membership_trial` — `recurring_classes.dayOverrides`, `memberships.trialEnabled/trialDays/trialAppliesToReturning`
- `20260515200000_event_registrations_tournaments` — `EventRegistration`, tournament/variable-cost fields
- `20260516000000_member_relationships_staff_location` — `MemberRelationship`, GPS, perSessionRate
- `20260516120000_modular_compensation` — `StaffCompensation`/`CompensationBonus`/`CompensationAssignment`
- `20260517000000_event_invoicing_dashboard_widgets` — `event_registrations.invoicedAt/invoiceCount`, `users.dashboardWidgets`
- `20260518000000_contractors_permissions_session_overrides` — `Contractor`/`ContractorPayment`, `class_sessions.staffOverride/note/overridden`
- `20260519000000_member_migration_wizard` — Member migration fields + `MemberMigrationEvent`
- `20260520000000_new_tier_system_processing_fees` — `clubs.tier` default `growth` (+ Starter→growth backfill), `clubs.passProcessingFees/processingFeeNote`
- `20260521000000_financial_os` — Transaction/Expense entity+category+method+receipt, `clubs.defaultLegalEntityId`, `Donation` model (idempotent SQL)
- `20260522000000_attendance_payment_method` — `attendance_records.paymentMethod/amountCharged`
- `20260523000000_migration_approval_flow` — Member migration approval (PENDING_APPROVAL, Stripe setup, editableFields, requestedBillingDate)
- `20260524000000_branded_app_config` — `Club.brandedAppConfig` (JSONB)
- `20260526000000_club_email_identity` — `Club.emailFromName/emailReplyTo`
- `20260527000000_migration_price_override` — `Member.migrationPriceOverride/migrationDiscountNote`
- `20260528000000_class_color_event_public_pricing` — `RecurringClass.color/textColor`, `Event.publicPricingOption`
- `20260529000000_branded_app_expense_kind` — `Club.appFontFamily/appTextAlign/appHomeContent/appCopy`, `Expense.kind`
- `20260518000001_private_lesson_partners` — `PrivateBookingPartner` table + `PrivateLessonType.maxAthletes`
- `20260530000000_builtin_event_colors` — `Club.builtInEventColors` (JSONB) — owner overrides for built-in EventType badge colors
- `20260531000000_staff_documents` — `StaffDocument` table (owner-uploaded tax docs / contracts / agreements per staff user, with sharedWithStaff visibility flag)
- `20260601000000_private_packages_multi_types` — `PrivatePackage.lessonTypeIds` (JSONB) for multi-type packages
- `20260602000000_package_discounts_bonus_thresholds` — `PrivatePackage.pricingMode` (FLAT | PERCENT | FIXED) + `discountValue` (Decimal?); `CompensationBonus.minThreshold` + `maxThreshold` (Int?)

Current migration status:

- `npx prisma migrate status` reports the database schema is up to date.
- `npx prisma validate` passes.
- New libs: `lib/permissions.ts`, `lib/apiGuard.ts`, `lib/fees.ts`, `lib/financials.ts`, `lib/financialReports.ts`, `lib/migration.ts`, `lib/migrationServer.ts`, `lib/memberLink.ts`, `lib/dashboardWidgets.ts`, `lib/datetime.ts`, `lib/activeProfile.ts`, `lib/categoryMatcher.ts`, `lib/privatePartners.ts`, `lib/memberMessaging.ts`, `lib/eventTypeColors.ts`.
- Major additions this cycle: member-portal club branding + auto-link, event mass-invoicing + tournament pricing fix, customizable dashboard, Guest/Contractor management, staff roles/permissions + restricted staff view, per-occurrence class schedule edits, Member Migration wizard, new 3-tier pricing + pass-through fees, Financial OS, attendance cash/comp/invoice for non-members.

## Migration Warning Notes

- Do not use `prisma db push` for normal schema evolution.
- Do not run `prisma migrate reset` unless data loss is explicitly intended.
- Use `npx prisma migrate dev` only when intentionally changing `schema.prisma`. If you can't (shadow DB perms issue), hand-write the migration folder + SQL and run `npx prisma migrate deploy` — that's the pattern the recent migrations use.
- The earlier guardian-profile migration was rewritten defensively (creates/renames tables safely, only backfills if legacy inline columns existed).
- `20260429192044_add_missing_core_tables` is a broad migration that adds many feature tables and alters core tables. Review it carefully before editing, especially because it drops `events.price`.
- If `next build` fails with missing page modules after a dev server was running, stop the dev server and clear ignored `.next` artifacts before rebuilding.
- `next/font` fetches Google Fonts during a clean build. In restricted network environments, build may need network permission.

## Built And Working

### Core platform
- Auth pages and dashboard protection.
- Dashboard shell/sidebar with current dark-neutral design system.
- Dashboard overview: stats, calendar preview, quick links, recent members, upcoming events.
- Light/dark dashboard theme toggle. Member portal stays light by design.
- Brand assets in `public/brand/` wired into nav, member layout, dashboard sidebar, login/signup, onboarding, manifest icons. Tagline drives the landing headline.

### Members & memberships
- Members page with listing, filtering, add/edit, custom fields, CSV import (mapping mirrors enabled form fields), guardian/minor fields, membership purchase modal, export menu.
- Member intake form builder (`/dashboard/settings/member-form`, stored on `Club.memberFormConfig` JSON). First-run gate on `/dashboard/members` until the owner saves a config.
- **Member status auto-flip**: assigning a manual membership flips status to ACTIVE; canceling the last active sub flips to INACTIVE (via `recomputeMemberStatus` in `lib/memberStatus.ts`).
- **Membership trial rules**: owner toggles "Offer a free trial" + days (1-365) + "Allow returning members to use the trial again". Both owner-side and member-self subscribe routes pass `trial_period_days` to Stripe when eligible.
- Memberships page supports plans, options, billing controls, discounts, and now trial rules.

### Classes & events & calendar
- Classes page supports recurring class management and session viewing.
- **Per-day class time overrides**: classes have a default start/end time; the editor shows each selected day with a Custom/Defaults toggle for per-day times. Sessions are regenerated on schedule changes, preserving sessions that already have attendance recorded.
- Events page with listing, filters, event types, pricing fields, bookings modal, sessions, visibility/access, Stripe charge wiring.
- Class & Event create/edit forms have a top-level "Accepted Memberships / Purchase Options" multi-select. Selection persists on edit. Memberships are stored as `pricingOptions: [{ type: "membership", membershipId }, ...]` on the existing JSON column.
- Membership-based free booking is wired (both Events and Classes); emits a booking confirmation email on the free path.
- Attendance panel "Add Member" has a pricing chooser (Use accepted membership / Member / Non-member / Drop-in). Header surfaces "Accepted memberships: …".
- Stripe webhook handles `classId + classSessionId` branch: records `Transaction` (`type="CLASS"`) and upserts `AttendanceRecord` to `DROP_IN`.
- **Calendar page** rebuilt as a unified feed: events + class sessions + confirmed private lessons in one grid, with kind chips (Events / Classes / Private lessons) and a secondary subtype chip strip auto-built from items in the visible range. Items color-coded per kind/type with start times. Detail panel with deep-link to source section. Backed by `/api/calendar`. **Classes are NOT an event type** — `CLASS` was removed from the events editor dropdown; recurring classes live only on `/dashboard/classes` (`RecurringClass`).
- **Calendar day detail (Phase 2)**: clicking a day NUMBER opens a Day Detail panel listing every item on that day with full info (time, type, location, coach, capacity, pricing, description) and a per-item **Edit** deep-link: events → `/dashboard/events?edit=<id>`, classes → `/dashboard/classes?edit=<id>`, privates → `/dashboard/privates?booking=<id>`. Multi-day events emit one item per `EventSession` so each day is its own row — editing a session row applies to that occurrence; the helper text in the panel says so explicitly.

### Staff documents (Phase 3)
- New `StaffDocument` model (table `staff_documents`) — owner uploads tax docs (W-9, 1099), contracts, agreements, certifications, or anything else to a staff member's profile. Each row stores `title`, `kind` (W9 | 1099 | CONTRACT | AGREEMENT | CERTIFICATION | OTHER), the file URL/metadata, and a `sharedWithStaff` boolean that controls staff-side visibility.
- Files use the existing private `/api/upload` → `/api/files/[id]` flow (club-scoped). Schema also stores fileName/mimeType/sizeBytes for display.
- API:
  - `GET /api/staff/[id]/documents` — owner list (everything, regardless of share flag)
  - `POST /api/staff/[id]/documents` — owner upload (after `/api/upload`)
  - `PATCH /api/staff/[id]/documents/[docId]` — toggle `sharedWithStaff`, rename, change kind, notes
  - `DELETE /api/staff/[id]/documents/[docId]` — soft delete (`deletedAt`)
  - `GET /api/me/staff-documents` — staff-facing list: returns ONLY this staff user's docs where `sharedWithStaff=true`. Owner-only docs are invisible.
- Owner UI: EditStaffModal now has a "Documents" panel below the main form with title + kind + visibility toggle, a file picker, and a list of existing docs (each with a per-row Visible-to-staff checkbox and a Delete button).
- Staff UI surface (the page that consumes `/api/me/staff-documents`) is NOT built yet — endpoint is wired and ready for a small "My documents" card to be added under `/dashboard/settings` for STAFF role next batch.
- **Built-in EventType colors (Phase 1)**: owners can override the colors for `CLASS`/`PRIVATE`/`CLINIC`/`CAMP`/`TOURNAMENT`/`OTHER` via **Manage Event Types** modal (a swatch picker per built-in type, Reset to revert to defaults). Persisted in `Club.builtInEventColors` (JSONB), returned by `/api/club/info`, accepted by `/api/club/update`, and resolved server-side in `/api/calendar` so the unified calendar grid honors the overrides everywhere. Custom `ClubEventType` colors still take precedence over built-in overrides. Source of truth helper: `lib/eventTypeColors.ts`.
- **Calendar feed enrichment**: `/api/calendar` items now include `description`, `location`, `coach`, and `price` so the day-detail panel can render full context without follow-up fetches.
- **Per-class color**: `RecurringClass.color/textColor` set in the class editor (palette of 11 named swatches + Default). Surfaced on the unified calendar.
- **Per-event public-pricing selector**: `Event.publicPricingOption` (MEMBER | NON_MEMBER | DROP_IN, null = auto/non-member) chooses which price the `/e/<slug>` public registration charges. Honored by `/api/public/events/[slug]` and `…/register`.
- **Public / non-member event registration**: any event can enable a public link at `/e/[publicSlug]` (auto-generated slug, never changes once set). The page shows the event image, info, price, and an owner-defined custom form. `EventRegistration` model captures signups (matches an existing member by email when possible). Free signups confirm immediately; priced signups go through Stripe Checkout on the club's connected account → webhook marks `PAID`, writes a `Transaction` (type `EVENT`), and creates a `Booking` if a member matched.
- **Tournament modes**: when event type = Tournament the editor offers **Host** (we run it — attach a registration form, public link auto-enabled) vs **Attend** (taking a team — gather signups + optional shared-cost split).
  - **Variable cost** (Attend only): split a shared total across attendees. **Estimated (prior)** charges each signup `total ÷ expectedSignups` at registration. **Official (post)** collects free signups, then the owner clicks **Bill registrants** (`POST /api/events/[id]/bill-registrants`) which splits the official total across active registrants, creates a Stripe Checkout link per person, emails it, and stamps `variableCostBilledAt` (idempotent; supports re-bill-unpaid). This is the "on unpublish" billing action.
  - Owner-defined registration **form builder** in the event editor (text / long text / email / phone / dropdown / checkbox fields, each optionally required). Stored as `Event.registrationForm` JSON. Registrations modal on the events list shows every signup with their form answers + payment status.

### Documents & signatures
- Documents page with list, editor, type/required flags, **signature renewal frequency** (Once / 30 / 90 / 180 / 365 / 730 days), Signatures button per doc that opens an audit modal showing every signature with member, signer, relationship, timestamp, IP, and Valid-until / Expired status.
- Member documents page handles signing (with two-step confirm), shows "✓ Signed" / "Signature expired" / re-sign UX, and includes a child-switcher for parents so they can sign on behalf of linked minors.
- `DocumentSignature` model captures the full audit trail (signer name, relationship SELF | GUARDIAN, signed-at, IP, user agent). API enforces that minors can't self-sign guardian-required docs.

### Member portal (guardian/minor)
- `/member` portal home with separate Adult / Minor / Parent views and Link Child modal.
- Parents see a child-switcher on `/member/bookings` and `/member/documents` so they can act on behalf of linked minors.
- `MemberGuardianUser` junction records portal access; guardians are still the family profile and not duplicated.

### Reports
- `/dashboard/reports` with KPI cards (revenue / net / new members / attendance), 12-month revenue bar chart, breakdowns (revenue by source, members by status, subscriptions, attendance, top events, expenses by category), and CSV export links for members / attendance / transactions.
- `/api/reports/overview` is tier-gated (Starter blocked); reports page shows an upgrade CTA when 403'd.

### Staff scheduling, availability, payroll
- `/dashboard/staff/availability` — pick a staff member, edit per-day recurring slots, add/remove date exceptions (`UNAVAILABLE` or `PARTIAL` with modified hours).
- `/dashboard/staff/schedule` — weekly grid (Sun-Sat columns × staff rows) showing availability windows, class assignments (expanded from `RecurringClass.assignedStaffIds`), event assignments (`EventStaffAssignment`), and date exceptions. Prev / This week / Next nav.
- `/dashboard/staff/payroll` — date range presets + custom; per-staff table of scheduled hours, **class teaching hours** (with per-class breakdown in expandable details), hourly pay, salary, private lesson pay. CSV export.
- Backed by `/api/staff/schedule` and `/api/staff/payroll`.

### Owner Dashboard follow-up phases 4-6
- **Private lesson duration/packages (Phase 4)**: private lesson type duration is now limited to owner presets in 15-minute increments from 15 minutes through 4 hours (`lib/privateLessonRules.ts`). API validation enforces the same rule. Private packages now support one or more lesson types via `PrivatePackage.lessonTypeIds` JSONB while preserving legacy `lessonTypeId`. Member private requests derive end time from the lesson duration; athletes no longer choose custom duration. When a member has usable package credits, they can submit multiple requested lesson dates/times up to their remaining package balance, creating one request per requested lesson.
- **Staff bonus clarity (Phase 5)**: compensation UI now presents signup bonus as “pay on next paycheck” and class growth/retention as a per-kid/per-class incentive. Existing payroll computation uses `SIGNUP` for once-per-period signup/purchase bonuses and `ATTENDANCE` for scoped class/event attendance incentives.
- **Bonus thresholds**: every bonus row now supports optional `minThreshold` / `maxThreshold` (Int?). The engine in `lib/compensation.ts` only pays for the slice of items *above* min and *up to* max — e.g. "bonus starts after 10 athletes, caps at 25". REVENUE_SHARE applies the same slice to qualifying items in collection order so dollar revenue reflects the same window. Editor fields are surfaced under each bonus card on `/dashboard/staff`.
- **Tier-aware private packages**: `PrivatePackage.pricingMode` + `discountValue` let a package describe a per-lesson discount instead of a flat total — PERCENT (% off each tier price) or FIXED ($ off each tier price). The package modal shows a live tier-by-tier pricing preview, and the Assign Package modal picks lesson type + coach tier and shows the computed total. `lib/privateLessonRules.ts` exposes `packageTotalForBasePrice()` and `pricePerLessonAfterDiscount()` so the booking + member-side purchase flows can compute the correct prepaid total for the chosen tier. Legacy `FLAT` mode continues to honor the stored `price` field.
- **Payroll in Financials/Reports (Phase 6)**: `lib/payroll.ts` computes staff payout totals from the same compensation engine used by Payroll/Payouts. Reports and Financials fold computed staff payroll plus contractor payments into the `PAYROLL` expense category so owners do not have to manually enter payroll for accurate net/expense reporting.

### Stripe / billing / file storage
- Stripe Connect (member → club) onboarding, status sync, dashboard redirect, Checkout, webhook flows.
- Member subscription activation / renewal / cancellation through webhook handlers.
- **ClubOS platform subscription billing** (club → AthletixOS):
  - `/api/club/subscription/checkout` opens platform-account Stripe Checkout for the chosen tier (uses `STRIPE_PRICE_GROWTH / STRIPE_PRICE_PRO / STRIPE_PRICE_ENTERPRISE` env vars).
  - `/api/club/subscription/portal` opens Stripe Billing Portal for plan-swap / card / invoice / cancel.
  - Webhook handles platform `checkout.session.completed` (sets tier + `stripeCustomerId` + `stripeSubscriptionId` + `subscriptionStatus="active"`), `customer.subscription.updated` (status sync + tier swap via Price-ID mapping), `customer.subscription.deleted` (downgrades to Starter).
  - `/api/club/tier` PATCH blocks direct paid-tier set without a promo code; paid plans must go through Checkout.
- **Webhook hardening + observability**: `StripeWebhookEvent` table logs every event with idempotency (skips duplicates by `stripeEventId`). Failures are caught and the error stored on the row instead of 500'ing — Stripe doesn't retry-storm on persistent bugs.
- **Diagnostics page** at `/dashboard/settings/diagnostics`: setup checklist (env vars, Connect status, Price IDs), 24h / total / error counts, last 50 webhook events with status badges and live-mode indicators, copy-paste webhook URL.
- **Private file storage**: `/api/upload` writes to `./storage/uploads` (gitignored, outside `public/`) with random 32-hex storage keys + an `UploadedFile` row. Files served only via `/api/files/[id]` which enforces `session.user.clubId === file.clubId`. Old `/public/uploads/*` URLs from earlier uploads still resolve via Next static serving for back-compat.

### Email notifications (transactional)
Templates in `lib/email.ts`: `sendWelcomeEmail`, `sendStaffInviteEmail`, `sendPasswordResetEmail`, `sendBookingConfirmationEmail`, `sendMembershipActivatedEmail`, `sendPaymentFailedEmail`. Wired into:

| Trigger                                                        | Recipient                          |
|----------------------------------------------------------------|------------------------------------|
| Owner adds staff (`POST /api/staff`)                           | New staff member with temp password |
| Owner adds member (`POST /api/members`)                        | Member email (or guardian for minors); points to `/member/signup` |
| Free membership-covered event booking (owner-side charge)      | Member (or guardian)               |
| Free membership-covered class drop-in (owner-side charge)      | Member (or guardian)               |
| Member-side free / membership-covered event registration       | Self / guardian                    |
| Stripe checkout.session.completed (membership activated)       | Member                             |
| Stripe checkout.session.completed (paid event / class booking) | Member                             |
| Stripe invoice.payment_failed                                  | Member                             |
| Announcement broadcast with email channel selected             | All filtered recipients            |

All sends are `try/catch` + `console.error` — a failed email never breaks the underlying flow. Recipient resolution prefers guardian email for minors, then member email, then linked User email.

### Club personalization
- `Club.aboutUs`, `coverImageUrl`, `contactEmail`, `contactPhone`, `websiteUrl`, `socialLinks`, `hoursOfOperation` all editable on `/dashboard/settings/club`.
- `StaffProfile` has `bio`, `publicEmail`, `publicPhone`, `photoUrl`, `showOnPortal`. Edited on `/dashboard/staff` Edit modal in a "Member portal profile" section.
- `/member/staff` page shows photo, title, bio, mailto/tel links for staff with `showOnPortal=true`.
- Member portal home (Adult, Minor, Parent views) renders a `ClubBanner` with logo + name + tagline + About Us + contact info + hours.

### Misc
- Members CSV import mapping mirrors the Add Member form (name, email, phone, DOB, gender, full address, status, tags, notes, isMinor, guardian fields, active custom fields). Membership assignment via CSV was removed.
- Public marketing landing at `/` with embedded tiers; `/pricing` page with 4-tier card grid, comparison table, FAQ.
- Export endpoints (members, attendance, transactions) gated on `reports` tier flag.

## Built But Needs End-to-End Testing

These flows exist in code but haven't been verified against a live Stripe environment with webhook forwarding:

- Stripe Connect onboarding, status sync, dashboard redirect, Checkout, webhook (Connect events).
- ClubOS platform subscription Checkout end-to-end (need live Price IDs in env).
- Member subscription activation / renewal / cancellation through real Stripe webhooks.
- Trial period flow (Stripe should hold the first charge until trial ends).
- Product sales and Stripe payment path.
- Paid event/class drop-in via charge → Stripe Checkout → webhook creating `Transaction` and `Booking` / `AttendanceRecord`.
- Plaid link token / exchange / transactions flow.
- Email send-out under real SMTP credentials (currently `console.log` fallback if `SMTP_HOST` unset).
- Document signature re-sign flow once a signature actually expires by `signatureValidForDays`.

## Partially Built / Wired Inconsistently

- Some old top-level routes remain alongside newer grouped routes, especially purchase options.
- `/dashboard/schedule` and `/dashboard/staff/schedule` both exist; current sidebar points under Staff.
- Add Staff (invite) modal does not collect bio/photo/public-contact fields yet — only the Edit Staff modal does. Owner adds the staff member, then opens Edit to fill the public profile.
- Tier-gating helper `requireGrowth` in `/api/messages/*` is effectively a no-op since `directMessaging=true` on Starter. Leave in place if policy might flip.
- Member-side messaging, memberships, events, products endpoints check session but don't apply tier gating beyond what the owner's plan allows.
- Member portal stays light-themed intentionally; raw `bg-stone-*` / `bg-white` / `text-stone-*` classes there will not respond to the dashboard dark-mode toggle.

## Not Built Yet

- Multi-location full UX (schema + `maxLocations` gating in place, but the locations page is thin).
- Native mobile apps.
- SMS broadcast delivery (template + UI flag exists; provider not wired).
- Push notifications.
- Full report builder (current `/dashboard/reports` is fixed-shape).
- Complete recurring class roster/enrollment product (sessions exist; UX for enrollment vs. attendance not finalized).
- Theme preference persisted to a User column (currently localStorage only).
- Bio/photo/public-contact fields in the Add Staff (invite) modal — currently Edit-only.
- Optimized/compressed brand assets (`logo.PNG` and `circle.PNG` are ~1 MB each; should be compressed before production rollout).

## Known Issues

- Build can fail if a dev server is writing `.next` while production build reads it. Stop dev server and clear `.next` if page manifest errors appear.
- Clean builds may require network access for Google Fonts.
- `pg_dump` from PostgreSQL 16 cannot dump the local PostgreSQL 18 database. Use `/Library/PostgreSQL/18/bin/pg_dump`.
- Dashboard design is mostly tokenized, but new pages must continue using the current tokens.
- Existing routes and APIs are broad; inspect before adding duplicates.
- Pending Prisma migrations silently break write paths long after schema/code look correct. Always check `npx prisma migrate status` first when a single model's writes start failing.
- The paid Events/Classes booking flow opens Stripe Checkout in a new tab and does not auto-create the booking client-side; the membership-covered branch creates it inline, the paid branch relies on the webhook.
- `prisma migrate dev` may fail on shadow-database permissions. The fix is to hand-write the migration folder + SQL and run `npx prisma migrate deploy` (the four most recent migrations were created this way).

## What To Avoid Next Time

- Do not rebuild existing features from scratch without reading current pages, APIs, schema, and migrations.
- Do not use `prisma db push`.
- Do not run `prisma migrate reset` unless explicitly intending to wipe local data.
- Do not create broad migrations that drop columns without a preservation/backfill plan.
- Do not reintroduce old color classes or random color families.
- Do not stage `.env`, `.next`, `node_modules`, local SQL backups, or debug archives.
- Do not store new uploads under `/public/uploads` — use the private storage flow via `/api/upload` so files are club-scoped.
- Do not leave dev server running while doing production build verification.
- Do not assume a feature is done because an API route exists.

## Required Env Vars

Documented in `.env.example`. Critical for production:

- `DATABASE_URL` — Postgres
- `NEXTAUTH_URL` — drives email links and Stripe success/cancel redirects
- `NEXTAUTH_SECRET`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_GROWTH` / `STRIPE_PRICE_PRO` / `STRIPE_PRICE_ENTERPRISE` — recurring Price IDs for the ClubOS-own tiers (different in test vs live mode)
- `UPLOADS_DIR` (optional; defaults to `./storage/uploads`)
- `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE` / `EMAIL_FROM` (optional; falls back to `console.log` if `SMTP_HOST` missing)
- `PLAID_CLIENT_ID` / `PLAID_SECRET` / `PLAID_ENV` (optional)

## Next Priorities

- Run live Stripe end-to-end with the CLI (`stripe listen --forward-to localhost:3001/api/stripe/webhook`) and verify the diagnostics page surfaces each event correctly.
- Configure live Stripe Price IDs in production env and verify ClubOS subscription upgrade flow round-trips.
- Build out a real multi-location UX (locations page is thin, even though schema/gating is in place).
- Wire SMS provider for the announcement broadcast flow (template + tier flag exist).
- Add Add-Staff (invite) bio/photo fields to remove the two-step "invite then edit" workflow.
- Add focused smoke scripts for: member-add → status flip, trial flow, document-sign + re-sign cycle, calendar feed, class schedule changes regenerating sessions.

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
6. For schema changes:
   - First try `npx prisma migrate dev --name <name>`.
   - If shadow-DB permissions block it: hand-write a migration folder + `migration.sql`, then `npx prisma migrate deploy` + `npx prisma generate`.
7. Avoid `prisma migrate reset` unless explicitly intended.
8. Run before each commit:
   - `npx prisma validate`
   - `npx prisma migrate status`
   - `npx tsc --noEmit` (filter out the pre-existing `headers().get` and outer-repo `legalEntityId` errors)
9. Commit working checkpoints often.
10. Push after a clean checkpoint.

## Feature Ideas / To Review Later

- UI polish
- Color scheme refinements
- Full multi-location UX
- Complete document form builder (current renderer is HTML + acknowledgement; no field-by-field signature UI)
- Push / SMS delivery providers
- Full report builder / saved views
- Mobile / PWA / native app path
