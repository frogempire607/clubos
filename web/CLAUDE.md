# AthletixOS Project Context

Last updated: 2026-06-03 (merged native-app-shell → main with 43 commits spanning: Native Capacitor shell + URL/redirect hardening + dashboard mobile-aware redesign + lucide SVG icon migration + parent-child message context + events page scoreboard layout + iOS overflow / calendar / member tile fixes + security pass with lib/ratelimit.ts + lib/sanitizeHtml.ts + zod gaps closed. Earlier surface this branch carried forward but didn't change: Staff invite setup-link + my-account, Client/Preview mode, multi-bank Plaid, back button, event image focal picker, privates confirmation UX, member portal nav + classes in bookings, owner-controlled billing visibility, parent sees child messages, member class self-book. iOS simulator end-to-end smoke is the only blocker for real-device sign-off — full checklist in Session log — 2026-06-02 below.)

This file is the working context for the AthletixOS web app. Treat it as current-state documentation, not a product promise. Do not claim an area is complete unless it is visible in the app and verified.

## App Summary

AthletixOS is a multi-tenant SaaS app for sports clubs and gyms. It has:

- Club owner/staff dashboard for members, classes, events, purchase options, staff, documents, messages, attendance, financials, reports, and settings.
- Member portal for members/guardians to view bookings, documents, profile, and portal content. Guardian/minor flows with child-switching and audited document signatures.
- PostgreSQL database scoped by `clubId`.
- Two-sided Stripe integration: Stripe Connect for member → club payments, plus a separate platform-account subscription for clubs paying AthletixOS.

## Working Rules — read first on every task

These rules apply to every software-development task in this repo. They override looser defaults from training data. Follow them in order.

1. **Inspect before coding.** Before touching anything, read the project architecture, routes, layouts, auth, permissions, database relationships, and shared components that touch the task. Trace at least one end-to-end path through the area you're about to change.

2. **Auto-discover and use installed Claude Code capabilities.** On every task, scan for and use the relevant:
   - Skills
   - Agents
   - MCP servers
   - Plugins
   - Hooks
   - LSP integrations
   Don't rebuild functionality a skill or MCP already provides.

3. **Prefer these capabilities when they apply:**
   - `frontend-design` (or `impeccable` / `ui-ux-pro-max`) for UI work
   - `feature-dev` for new feature scaffolding
   - `systematic-debugging` for any bug, test failure, or unexpected behavior
   - `verification-before-completion` before claiming work is done
   - `review-local-changes` (or `review-pr`) before commit/merge
   - `subagent-driven-development` for plans with independent tasks
   - `dispatching-parallel-agents` for 2+ tasks without shared state

4. **UI/UX work specifically:**
   - Use **Magic (21st.dev) MCP** for inspiration and component generation.
   - Perform a UX audit before any redesign.
   - Propose a file plan (which files will be created/modified) **before** editing.

5. **iOS, Capacitor, React Native, mobile, navigation, auth, or WebView changes:**
   - Use `ios-simulator-skill`.
   - Validate behavior in simulator (or device) **before** claiming completion.

6. **Never perform broad rewrites** without understanding dependencies and impact.

7. **Before editing, present:**
   - The exact list of files affected
   - Known risks
   - A short implementation plan

8. **Work in small checkpoints**, not one giant commit.

9. **After each checkpoint, run:**
   - Lint
   - Build
   - Regression check on adjacent functionality

10. **Before claiming completion, verify:**
    - Auth still works
    - Permissions still gate the right surfaces
    - Navigation still routes correctly
    - Mobile/Capacitor behavior is intact
    - Existing functionality hasn't regressed

11. **Explicitly state** which skills, MCPs, plugins, and agents were used during the task in the final summary.

12. **Do not claim testing was performed** unless you actually ran it. If you only ran type-checks and build, say that; don't conflate it with end-to-end testing.

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
- Local dev port: `npm run dev` runs Next on `127.0.0.1:3000` (bound to `0.0.0.0` so the iOS simulator can reach it). Port 3001 was abandoned because it's on WebKit's restricted-network-ports blocklist.
- Local auth URL: `.env` should use `NEXTAUTH_URL=http://127.0.0.1:3000`. Using the literal IP (not `localhost`) avoids the macOS IPv6-first resolution that breaks the WKWebView connect.

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
  - Campaigns
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
- `/dashboard/communication/campaigns` — campaign analytics shell with KPIs, lead source breakdown, funnel/stage tracking, revenue attribution, and campaign activity foundation
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
- `/dashboard/settings/email` — SMTP status, sender identity, **Send test email** button
- `/dashboard/my-account` — self-service password change + name update for owner & staff
- `/dashboard/preview` — Client View launcher: Preview Member Portal + public link list
- `/dashboard/schedule` (legacy; kept for back-compat)

Public / setup pages (unauthenticated):
- `/setup?token=...&club=<slug>` — first-time staff account activation (sets password via existing `/api/auth/reset-password`)
- `/e/[slug]` — public event registration with optional Member sign-in CTA

Member portal pages:

- `/member`
- `/member/schedule` — full member-facing schedule for classes, events, and private lesson offerings; respects active parent/child profile selection and shows eligibility/status messaging
- `/member/bookings` — child-switcher for parents; shows bookings per accessible member
- `/member/documents` — child-switcher + sign / re-sign with audit trail and frequency-based expiry
- `/member/profile` — account profile plus Family & athlete access area for parent/guardian switching and child linking
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
- `/api/me` (GET — live role + permissions), `/api/me/profile` (PATCH — change own first/last name), `/api/preview` (GET/POST/DELETE — Client view cookie)

Club/settings:

- `/api/club/update` — also writes `aboutUs`, `memberBillingVisibility`, branded-app fields; `sport/tagline/primaryColor` are now `nullable` so blank-input saves don't 400
- `/api/club/info` — returns logo, tier, subscriptionStatus, stripeSubscriptionId, `memberBillingVisibility`, etc.
- `/api/club/email-test` — owner sends a one-off test email through the configured SMTP transport; returns ok or transport error
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
- `/api/announcements/[id]/engagement` — owner/staff engagement detail for a specific announcement (seen/opened/clicked member list)
- `/api/campaigns/overview?range=…` — communication/campaign dashboard analytics from member lead fields, transactions, and campaign attribution rows
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
- `/api/plaid/link-token`, `/api/plaid/exchange`, `/api/plaid/transactions` — gated on `plaid` tier flag (Pro+)
- `/api/plaid/connections` (GET/POST), `/api/plaid/connections/[id]` (PATCH/DELETE) — multi-bank: list/add/rename/disconnect connections
- `/api/transactions?bank=<connectionId>` and `/api/expenses?bank=<connectionId>` — filter financials by Plaid connection

Private lessons/staff/export:

- `/api/private-lessons/types`, `.../types/[id]`
- `/api/private-lessons/packages`, `.../packages/[id]`
- `/api/private-lessons/bookings`, `.../bookings/[id]`
- `/api/staff`, `/api/staff/[id]` — POST supports `sendSetupLink:true` (emails an activation link via `/setup`) OR `password` (legacy temp-password); resurrects a soft-deleted match instead of 409
- `/api/staff/[id]/setup-link` — POST: regenerates the 14-day setup token and returns the absolute `setupUrl`; surfaced via "Setup link" button on the staff list
- `/api/staff/[id]/availability`, `/api/staff/[id]/availability/exceptions`
- `/api/staff/[id]/pay-rates`
- `/api/staff/schedule?from=&to=` — weekly schedule aggregator (availability + classes + events)
- `/api/staff/payroll?from=&to=` — computes scheduled hours, class teaching hours (from `RecurringClass.assignedStaffIds`), hourly pay, salary, private lesson pay
- `/api/export/members`, `/api/export/attendance`, `/api/export/transactions`

Member-side:

- `/api/member/signup`
- `/api/member/portal` — also returns per-accessible-member `summaries` (attendance30d, upcoming bookings, active membership) + each member's upcoming class `attendanceRecords` for the unified My Bookings view + `club.memberBillingVisibility` for the portal billing card; honors preview cookie for owner/staff with a sanitized stub
- `/api/member/portal/link-child` — parent/guardian can link an existing same-club member by email into `MemberGuardianUser`
- `/api/member/me` — GET/PATCH/DELETE own profile
- `/api/member/club` — public club info for portal (logo, tagline, aboutUs)
- `/api/member/staff` — visible staff (only `showOnPortal=true`)
- `/api/member/announcements`
- `/api/member/messages` — also returns `childConversations[]` and `childGroups[]` for guardian sessions, each tagged with `forMember`
- `/api/member/classes/book` — POST: member-self class booking with auto-detected price tier (MEMBERSHIP / MEMBER / NON_MEMBER / DROP_IN); free path for covered subs, Stripe Checkout otherwise
- `/api/member/announcements/[id]/engagement` — records member portal announcement opens and URL link clicks
- `/api/member/schedule?memberId=…` — active-profile-aware schedule feed for member portal; combines visible events, class sessions, membership/price status, bookings, and private lesson offerings
- `/api/member/documents?memberId=…` — context-aware; returns docs + signature status for a given accessible member (self or linked child); signature includes `expiresAt`/`expired` based on `signatureValidForDays`
- `/api/member/documents/[id]/sign` — POST persists a `DocumentSignature` with relationship (SELF | GUARDIAN), IP, user agent; enforces that minors can't self-sign guardian-required docs
- `/api/member/messages`, `.../dm/[userId]`, `.../groups/[id]`
- `/api/member/memberships`
- `/api/member/memberships/subscribe` — honors trial rules
- `/api/member/billing-portal`
- `/api/member/events`
- `/api/member/events/[id]/register` — emits booking confirmation email on free paths; accepts a verified `memberId` so parents can register the selected child profile safely
- `/api/member/products`, `.../products/[id]/buy`
- `/api/member/privates` — member private lesson request flow; validates coach/tier combinations server-side and rejects invalid pairings

## Current Prisma Schema Status

`prisma/schema.prisma` validates as of 2026-06-07.

Core models currently present:

- Tenant/auth: `Club`, `Location`, `User`, `StaffProfile`
- Members/family: `Member`, `Guardian`, `MemberGuardianUser`
- Purchase options: `Membership`, `MemberSubscription`, `Discount`, `Product`, `ProductSale`
- Classes/events: `RecurringClass`, `ClassSession`, `Event`, `EventSession`, `Booking`, `ClubEventType`, `AttendanceRecord`, `EventStaffAssignment`
- Messaging/announcements: `Message`, `MessageGroup`, `MessageGroupMember`, `GroupMessage`, `GroupMessageReceipt`, `Announcement`, `AnnouncementEngagement`
- Campaigns/lead attribution: `Campaign`, `CampaignAttribution`; `Member` carries lightweight `leadSource`, `leadStage`, `leadSourceUpdatedAt`
- Documents/settings: `Document`, `DocumentSignature`, `CustomField`, `ClubProfile`, `LegalEntity`, `DonationLink`
- Financials: `Transaction`, `Expense`, `PlaidConnection`
- Private lessons/staff: `PrivateLessonType`, `PrivatePackage`, `PrivateCreditLedger`, `PrivateBooking`, `PrivateLessonPayRate`, `StaffAvailability`, `StaffAvailabilityException`
- Infra: `UploadedFile`, `StripeWebhookEvent`

Notable model fields added since 2026-05-03:

- `Document.signatureValidForDays Int?` — null = sign-once, otherwise days until re-signature required
- `Membership.trialEnabled Boolean`, `trialDays Int?`, `trialAppliesToReturning Boolean`
- `RecurringClass.dayOverrides Json` — `[{ dayOfWeek, startTime, endTime }, …]` — overrides default start/end times on specific days
- `Club.subscriptionStatus String?`, `stripeSubscriptionId String? @unique` (used for platform-side billing)
- `Product.productType`, `visibility`, `showLocation`, `taxable`, `internalNotes`, `settings` — product type system foundation for gear, rentals, birthday packages, digital items, and custom products
- `AnnouncementEngagement` + `GroupMessageReceipt` — shared communication engagement layer for announcement seen/open/click data and group-message read receipts
- `Campaign` + `CampaignAttribution`, plus member lead fields — campaign analytics/revenue attribution foundation
- `RecurringClass.visibility String @default("MEMBERS_ONLY")` — PUBLIC | MEMBERS_ONLY | PRIVATE; PRIVATE classes are roster-only on member surfaces
- `Club.memberBillingVisibility Json?` — owner-controlled toggles for plan / next-billing / price / invoices on the member portal
- `PlaidConnection` (clubId, label, institutionName, accessToken, itemId, accountsCache, soft-delete) — multi-bank Plaid support; `Transaction.plaidConnectionId` and `Expense.plaidConnectionId` FKs for filtering

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
- `20260603000000_campaigns_lead_attribution` — `Campaign`, `CampaignAttribution`, and member lead source/stage fields
- `20260603010000_communication_engagement` — `AnnouncementEngagement` and `GroupMessageReceipt`
- `20260603020000_product_type_system` — product type/visibility/show-location/taxable/internal-notes/settings fields on `Product`
- `20260604000000_class_visibility_message_read_dates` — `RecurringClass.visibility` (PUBLIC/MEMBERS_ONLY/PRIVATE), `AnnouncementEngagement` / `GroupMessageReceipt` index work
- `20260605000000_member_billing_visibility` — `Club.memberBillingVisibility` JSONB
- `20260607000000_plaid_multiple_banks` — `plaid_connections` table + nullable `plaidConnectionId` on `transactions` and `expenses`; backfills legacy single-bank rows

Current migration status:

- `npx prisma migrate status` currently fails locally with a bare `Schema engine error:` even though direct `psql` checks work and the additive 20260603 migrations were applied locally.
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
- **Calendar day detail (Phase 2)**: clicking a day NUMBER opens a Day Detail panel listing every item on that day with full info (time, type, location, coach, capacity, pricing, description). Per-item **Edit** deep-link is now per-occurrence by default: class items → `/dashboard/classes?session=<classSessionId>` opens a `SessionEditModal` (start/end time, cancel toggle, substitute staff via `staffOverride`, one-off `note`) and sets `overridden=true` so the series regenerator preserves the customization. The modal has an explicit "Edit entire series →" button that jumps to `?edit=<classId>`. Multi-day event session items (id `<eventId>:<sessionId>`) deep-link to `/dashboard/events?session=<id>`; single-day events fall back to `?edit=<id>`. PATCH endpoint `app/api/classes/[id]/sessions/[sessionId]/route.ts`.
- **Dashboard mini-calendar refetch**: the mini calendar on `/dashboard` now refetches `/api/calendar` with an explicit `from`/`to` window when the visible month changes — fixes the regression where only the initial month (±1) had data while navigating prev/next showed empty.

### Staff documents (Phase 3)
- New `StaffDocument` model (table `staff_documents`) — owner uploads tax docs (W-9, 1099), contracts, agreements, certifications, or anything else to a staff member's profile. Each row stores `title`, `kind` (W9 | 1099 | CONTRACT | AGREEMENT | CERTIFICATION | OTHER), the file URL/metadata, and a `sharedWithStaff` boolean that controls staff-side visibility.
- Files use the existing private `/api/upload` → `/api/files/[id]` flow (club-scoped). Schema also stores fileName/mimeType/sizeBytes for display.
- API:
  - `GET /api/staff/[id]/documents` — owner list (everything, regardless of share flag)
  - `POST /api/staff/[id]/documents` — owner upload (after `/api/upload`)
  - `PATCH /api/staff/[id]/documents/[docId]` — toggle `sharedWithStaff`, rename, change kind, notes
  - `DELETE /api/staff/[id]/documents/[docId]` — soft delete (`deletedAt`)
  - `GET /api/me/staff-documents` — staff-facing list: returns ONLY this staff user's docs where `sharedWithStaff=true`. Owner-only docs are invisible.
- Owner UI: EditStaffModal now has a "Documents" panel below the main form with title + kind + visibility toggle, a **multi-select file picker** (one staff doc row per file picked; the title gets a `(n/total)` suffix when multiple are selected at once), and a list of existing docs (each with a per-row Visible-to-staff checkbox and a Delete button).
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
- `/member/schedule` is the main member-facing schedule surface. It shows visible classes, events, and private lesson offerings even when the member cannot book them. Cards and the detail modal show time, type, coach, location, description, capacity/spots, price/status, and eligibility text such as "Included in your membership", "Purchase required", "Members only", or "Registration closed".
- The member layout bottom nav now points the schedule tab to `/member/schedule`; `/member/bookings` remains available for already-registered sessions/history.
- Parents see a shared active-profile switcher across the portal (via `lib/activeProfile.ts`) and child-aware views on `/member/schedule`, `/member/bookings`, and `/member/documents`.
- `/member/profile` now includes a Family & athlete access area. Parents can see linked athletes, switch the selected athlete, and link/request an existing same-club child/member by email through `/api/member/portal/link-child`.
- Child/minor accounts stay scoped to their own profile and do not get the child-linking form.
- `MemberGuardianUser` junction records portal access; guardians are still the family profile and not duplicated.
- Login separation: `/login` routes by the authenticated account's real role. Members who submit through the Club/Staff tab get a clear member-account redirect and land in `/member`; owners/staff land in `/dashboard`. Middleware redirects MEMBER away from `/dashboard` and redirects OWNER/STAFF away from `/member` because member APIs are role-scoped.

### Reports
- `/dashboard/reports` with KPI cards (revenue / net / new members / attendance), 12-month revenue bar chart, breakdowns (revenue by source, members by status, subscriptions, attendance, top events, expenses by category), and CSV export links for members / attendance / transactions.
- `/api/reports/overview` is tier-gated by feature flag; reports page shows an upgrade CTA when 403'd.

### Campaigns & communication engagement
- `/dashboard/communication/campaigns` is a first-pass Campaigns dashboard under the existing Communication group. It includes KPI cards (New Leads, Intro Offers Sold, First Time Bookings, Clients Won Back, Marketing Revenue), Leads by Source donut/table, Leads by Stage funnel, Revenue Attribution, and Campaign Activity empty state.
- Data architecture is real, not UI-only: `Campaign` stores campaign metadata (type/status/dates/audience/channel plan/revenue + lead attribution mode), and `CampaignAttribution` can link campaigns to members and transactions. `Member.leadSource/leadStage` provide a lightweight attribution foundation until owner-editable CRM flows exist.
- `/api/campaigns/overview` computes fallback analytics from existing members and transactions. SMS/push are marked as future-ready hooks only; there is no fake SMS/push delivery.
- Announcements now have per-user engagement via `AnnouncementEngagement`: member announcement list marks `seen`, opening the announcement detail marks `opened`, and clicking an `http(s)` URL inside the announcement body marks a **Link click**. Owner Announcements UI labels this clearly as Seen / Opened / Link clicks and the Engagement modal explains the distinction.
- Group messages now have per-user `GroupMessageReceipt` rows when users open a group thread. Group-message bubbles show "Read X" for messages the current user sent.
- Direct messages already had `Message.readAt`; UI now surfaces Sent/Read for sent DMs.

### Staff scheduling, availability, payroll
- `/dashboard/staff/availability` — pick a staff member, edit per-day recurring slots, add/remove date exceptions (`UNAVAILABLE` or `PARTIAL` with modified hours).
- `/dashboard/staff/schedule` — weekly grid (Sun-Sat columns × staff rows) showing availability windows, class assignments (expanded from `RecurringClass.assignedStaffIds`), event assignments (`EventStaffAssignment`), and date exceptions. Prev / This week / Next nav.
- `/dashboard/staff/payroll` — date range presets + custom; per-staff table of scheduled hours, **class teaching hours** (with per-class breakdown in expandable details), hourly pay, salary, private lesson pay. CSV export.
- Backed by `/api/staff/schedule` and `/api/staff/payroll`.

### Owner Dashboard follow-up phases 4-6
- **Private lesson duration/packages (Phase 4)**: private lesson type duration is now limited to owner presets in 15-minute increments from 15 minutes through 4 hours (`lib/privateLessonRules.ts`). API validation enforces the same rule. Private packages now support one or more lesson types via `PrivatePackage.lessonTypeIds` JSONB while preserving legacy `lessonTypeId`. Member private requests derive end time from the lesson duration; athletes no longer choose custom duration. When a member has usable package credits, they can submit multiple requested lesson dates/times up to their remaining package balance, creating one request per requested lesson.
- **Member private lesson tier/coach filtering**: member private requests now treat coach and pricing tier as linked choices. Selecting a coach filters to only that coach's assigned price options; selecting a price option filters to eligible coaches. Server-side `/api/member/privates` revalidates the pairing using `PrivateLessonType.priceOptions[].coachIds`, `eligibleCoachIds`, and all active owner/staff fallback, so invalid coach-tier combinations cannot be booked even if the UI is bypassed.
- **Staff bonus clarity (Phase 5)**: compensation UI now presents signup bonus as “pay on next paycheck” and class growth/retention as a per-kid/per-class incentive. Existing payroll computation uses `SIGNUP` for once-per-period signup/purchase bonuses and `ATTENDANCE` for scoped class/event attendance incentives.
- **Bonus thresholds**: every bonus row now supports optional `minThreshold` / `maxThreshold` (Int?). The engine in `lib/compensation.ts` only pays for the slice of items *above* min and *up to* max — e.g. "bonus starts after 10 athletes, caps at 25". REVENUE_SHARE applies the same slice to qualifying items in collection order so dollar revenue reflects the same window. Editor fields are surfaced under each bonus card on `/dashboard/staff`.
- **Tier-aware private packages**: `PrivatePackage.pricingMode` + `discountValue` let a package describe a per-lesson discount instead of a flat total — PERCENT (% off each tier price) or FIXED ($ off each tier price). The package modal shows a live tier-by-tier pricing preview, and the Assign Package modal picks lesson type + coach tier and shows the computed total. `lib/privateLessonRules.ts` exposes `packageTotalForBasePrice()` and `pricePerLessonAfterDiscount()` so the booking + member-side purchase flows can compute the correct prepaid total for the chosen tier. Legacy `FLAT` mode continues to honor the stored `price` field.
- **Payroll in Financials/Reports (Phase 6)**: `lib/payroll.ts` computes staff payout totals from the same compensation engine used by Payroll/Payouts. Reports and Financials fold computed staff payroll plus contractor payments into the `PAYROLL` expense category so owners do not have to manually enter payroll for accurate net/expense reporting.

### Product type system
- Sidebar remains **Purchase Options → Products**. Do not rename Products.
- `Product` now supports `productType` values: `GEAR`, `FACILITY_RENTAL`, `BIRTHDAY_PARTY`, `DIGITAL`, `OTHER`.
- Product metadata fields: `visibility` (`MEMBERS_ONLY`, `PUBLIC_ONLY`, `MEMBERS_AND_PUBLIC`, `INTERNAL_ONLY`), `showLocation` (`MEMBER_PORTAL`, `PUBLIC_CHECKOUT`, `INTERNAL_ONLY`), `taxable`, `internalNotes`, and flexible JSON `settings`.
- Owner Products form starts with product type selection and conditionally shows relevant sections:
  - Gear / Merchandise: inventory tracking, total stock, low-stock alert, variant/options notes, per-variant stock notes, fulfillment setting.
  - Facility Rental: available days, time windows, duration pricing, buffer, capacity, approval requirement, deposit/full/request mode, blackout dates, member price.
  - Birthday Party / Rental Package: package tiers, duration/price notes, max guests, add-ons, deposit/approval, custom form questions.
  - Digital Item: delivery instructions and access/file notes using the existing private-file strategy when files are needed.
  - Other: flexible custom questions and optional approval requirement.
- Existing gear/product sales remain backed by `ProductSale` and Stripe/manual sale routes. Member store filters out internal/public-only products and blocks rental/party types from old instant checkout until the product booking/request model is built.
- Full rental/party booking records, variant-aware checkout/inventory decrement, public checkout links, and automated digital file delivery are not complete yet. The owner form captures the needed configuration in `Product.settings` for the next booking/checkout phase.

### Stripe / billing / file storage
- Stripe Connect (member → club) onboarding, status sync, dashboard redirect, Checkout, webhook flows.
- Member subscription activation / renewal / cancellation through webhook handlers.
- **ClubOS platform subscription billing** (club → AthletixOS):
  - `/api/club/subscription/checkout` opens platform-account Stripe Checkout for the chosen tier (uses `STRIPE_PRICE_GROWTH / STRIPE_PRICE_PRO / STRIPE_PRICE_ENTERPRISE` env vars).
  - `/api/club/subscription/portal` opens Stripe Billing Portal for plan-swap / card / invoice / cancel.
  - Webhook handles platform `checkout.session.completed` (sets tier + `stripeCustomerId` + `stripeSubscriptionId` + `subscriptionStatus="active"`), `customer.subscription.updated` (status sync + tier swap via Price-ID mapping), and `customer.subscription.deleted` (keeps tier, sets `subscriptionStatus="canceled"`; no Starter fallback).
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

### Staff invite & self-service (2026-06-06)
- **Setup-link invite flow**: Add Staff modal defaults to "Email setup link". `/api/staff` (POST) with `sendSetupLink:true` creates the user with a random throwaway hash + a 14-day `resetToken` and emails a link to `/setup?token=...&club=<slug>`. The user picks their own password via the existing `/api/auth/reset-password` endpoint (single-use by construction). Legacy temp-password mode is still available as a toggle.
- Owner-resilient invite: `POST /api/staff` returns the absolute `setupUrl` + `emailed`/`emailError` flags. The modal swaps to a confirmation panel with a "Copy link" button so the owner can hand-deliver the link if SMTP isn't configured or email lands in spam.
- **Resend setup link**: `POST /api/staff/[id]/setup-link` regenerates a fresh 14-day token and returns the URL. Staff list has a per-row **Setup link** button (next to Edit/Remove) that surfaces the URL via prompt.
- **Soft-delete + re-add**: `POST /api/staff` now resurrects a soft-deleted match (clears `deletedAt`, refreshes name/password/permissions) instead of returning 409. Active duplicates still 409 as before.
- **`/dashboard/my-account`**: Every signed-in dashboard user (owner OR staff, regardless of permissions) gets a self-service account page. Lets them change their password (existing `/api/auth/change-password`) and update first/last name (new `PATCH /api/me/profile`). Linked from the sidebar above "Client view" so staff have somewhere to go even with no other section access.
- Privates API mutations were hardcoded `role !== "OWNER"`; swapped to `requirePermission(session, "events", "edit"|"full")` so a head coach with `events:full` can now create / edit / duplicate / delete privates types & packages.

### Client / Preview mode (2026-06-06)
- `lib/preview.ts` defines a `PREVIEW_COOKIE = "aox_preview"` ("member" | "public"), an 8h HttpOnly SameSite=Lax cookie. Owner/staff only.
- `POST /api/preview { mode }` sets the cookie; `DELETE /api/preview` clears it; `GET /api/preview` reads it (member layout polls this to render the banner).
- Middleware: when an owner/staff session has `aox_preview=member`, the `/member/*` redirect-to-dashboard guard is skipped so the member layout renders for them.
- `/api/member/portal` and `/api/member/schedule` honor the cookie: when role is not MEMBER but cookie+role pass `canStartPreview()`, they return a sanitized PREVIEW payload (club brand only, no real bookings/subscriptions, empty schedule). Real member data never leaks.
- Member layout shows an amber **"Preview mode — Exit preview"** banner whenever the cookie is present. Exit calls `DELETE /api/preview` and bounces back to `/dashboard`.
- `/dashboard/preview` launcher: "Preview Member Portal" button + curated public-link list (landing, pricing, signup, sign-in with club prefilled, every `/e/<publicSlug>` the club has live). Tier-agnostic — every tier can use it. Linked from the sidebar as **"Client view"**.

### Member portal: nav + classes + family (2026-06-04 → 2026-06-05)
- **Class visibility**: `RecurringClass.visibility` enum (`PUBLIC | MEMBERS_ONLY | PRIVATE`, default `MEMBERS_ONLY`). 3-tile picker on `/dashboard/classes`. `/api/member/schedule` filters to `PUBLIC + MEMBERS_ONLY`; `PRIVATE` classes are roster-only.
- **Member schedule** hides events by default (gated by `INCLUDE_EVENTS_IN_SCHEDULE = false`); events live on `/member/events`.
- **Read receipts with timestamps**: DM bubbles show `Read Aug 24, 7:42 PM`. Group messages show `Read N` → expandable reader list with per-user timestamps (`AnnouncementEngagement` + `GroupMessageReceipt` rows; group messages route returns `readers[]`). Owner-side timestamps are now legible on the violet bubble — fixed `text-text-muted` → `text-white/75` for own messages.
- **Family switcher** on `/member/profile` shows DOB / computed age / `Minor` flag per linked athlete.
- **Parent quick-dashboard per child**: `/api/member/portal` returns per-member `summaries` (`attendanceLast30d`, `upcomingBookings`, `activeMembershipName`). `/member/profile` renders a 3-tile mini dashboard per linked athlete under DOB row.
- **Parent sees child messages**: `/api/member/messages` adds `childConversations[]` and `childGroups[]` for DMs/groups belonging to linked child User accounts, tagged with `forMember:{id,firstName,lastName}`. `/member/messages` renders a "Messages for your athletes" section with a "For \<child\>" chip per row.
- **Owner-controlled billing visibility**: `Club.memberBillingVisibility JSON?` ({showPlan, showNextBilling, showPrice, showInvoices}). Settings → **Member Portal** sidebar tab exposes the 4 toggles. `/member/profile` Payment & billing conditionally renders plan/next-billing/price + "View invoices" link based on these flags.
- **Member portal nav**: Layout nav has Home / Schedule / Messages / News (Announcements) / Docs / Profile so every section is discoverable. Home tiles include Bookings, Messages, Announcements, Documents, Our team.
- **My Bookings includes classes**: `/api/member/portal` returns each accessible member's upcoming class `AttendanceRecord`s (PRESENT/LATE/DROP_IN/TRIAL with future `classSession.startsAt`) + the recurring class's color + assignedStaffIds. `/member/bookings` merges them into the unified list with coach (resolved via `/api/member/staff`), sorted chronologically.

### Member class self-booking with auto-detected price (2026-06-05)
- `/api/member/schedule` computes a `bookingTier` per class (`MEMBERSHIP | MEMBER | NON_MEMBER | DROP_IN`) from the member's subscription state, plus `bookingLabel` and `price`.
- `POST /api/member/classes/book` validates the resolved tier server-side, creates an `AttendanceRecord` for the free path or opens Stripe Checkout on the club's connected account otherwise.
- `/member/schedule` modal shows resolved price + a **Book** button per class.

### Public event link improvements (2026-06-05)
- `/e/[slug]` header now has a **"Member sign in"** link (callbackUrl back to the same `/e/<slug>`) for signed-out visitors and a **"Member portal"** link for signed-in ones.
- Below the cost row, a banner tells members to register from the portal (so they get member pricing / membership coverage), and tells signed-out viewers they can sign in to use member pricing.

### Back button — universal (2026-06-07)
- `components/BackButton.tsx`: uses `router.back()` when history is poppable; falls back to `/dashboard` (owner/staff) or `/member` (members) — caller can override with `fallbackHref`.
- Dashboard layout puts a back button in the sticky topbar on every page except `/dashboard` home.
- Member layout puts a back button above page content on every `/member/*` page except `/member` home.

### Plaid multiple bank accounts (2026-06-07)
- **New model `PlaidConnection`** (clubId, label, institutionName, accessToken, itemId, accountsCache JSON, soft-delete). Legacy `Club.plaidAccessToken/plaidItemId` stay populated for back-compat; the new code lazy-migrates them into a `PlaidConnection` row on first read.
- Migration `20260607000000_plaid_multiple_banks` adds `plaid_connections` + nullable `plaidConnectionId` FK on `Transaction` and `Expense` (ON DELETE SET NULL), and backfills existing single-bank into a row.
- API: `GET/POST /api/plaid/connections` (list + add via Plaid Link); `PATCH/DELETE /api/plaid/connections/[id]` (rename + soft-disconnect). `/api/plaid/transactions` aggregates across every connection and accepts `?connectionId=` to filter. `/api/plaid/exchange` still works and now also creates a connection row.
- Tier-gating: `plaid` feature flag in `lib/tier.ts` stays Pro+. Multi-account is naturally Pro+ as a result. Plaid response 403s with `upgradeRequired: "pro"` on Growth.
- Filtering: `/api/transactions` and `/api/expenses` accept `?bank=<connectionId>`. `POST /api/expenses` accepts `plaidConnectionId`.
- UI: **Financials → Bank** tab lists every connection (label / rename / disconnect), shows a **+ Add bank** CTA, and a per-bank filter dropdown when 2+ banks are connected. Transactions table includes a Bank column.

### Event image cropping (2026-06-07)
- Schema columns `Event.imagePositionX/Y` (Int, default 50, 0–100%) were already present. Public `/e/[slug]` already uses them via CSS `object-position`. The missing piece was the editor UI.
- **`EventImageFocalPicker`** inside the event modal: click/drag inside a 16:9 preview (matches the public page) to set the focal point. Stored as percentages, applied via `object-position` — no re-encoding, no new files. Includes "Reset to center".

### Privates confirmation UX (2026-06-07)
- Requested-slot rows in the booking modal render as **"Thu, Jun 15 · 2:30 PM – 3:30 PM"** (locale weekday + AM/PM) instead of `YYYY-MM-DD · HH:mm` (which read like military time).
- Each requested-slot row has an **"Accept this time"** button that pre-fills `confirmedStart`/`confirmedEnd` from the slot and opens the confirm form in one click.
- The main **"Confirm or change time"** button also pre-fills with the first requested slot so the default action is a single click — owner can still tweak.
- `fmt()` forces `hour12: true` so the OS locale never falls back to 24h on the owner-facing UI.

### Email / SMTP (2026-06-07)
- `lib/email.ts` reads SMTP from env at runtime: `SMTP_HOST`, `SMTP_PORT` (default 587), `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`, `EMAIL_FROM`. Nothing hardcoded.
- New `POST /api/club/email-test` (owner only) sends a real email via the configured transport and returns `ok:true/false` + error message. Settings → Email shows a **"Send test email"** form with an optional recipient override (defaults to the owner's login email).
- Per-club `emailFromName` and `emailReplyTo` (existing) flow through `sendEmail()` so members see the club's friendly name in their inbox.

### Club profile persistence fix (2026-06-07)
- `/api/club/update` Zod schema now allows `null` on `sport`, `tagline`, and `primaryColor`. Previously the schema was `.optional()` only (not `.nullable()`); clients sent `null` for empty fields, Zod rejected the whole request, and only the required `name`/`slug` appeared to persist.
- Inline `ProfileSection` re-hydrates state with `useEffect` when the `club` prop changes after save, so the form never shows stale values.
- Inline Profile tab now links to `/dashboard/settings/club` for the extended fields (About Us, cover image, hours, contact, social links) so the full editor is discoverable.

### Native AthletixOS app shell setup (2026-06-07)

Checkpoint commit: `c5021307bf6718776acbf7e2cadc52fb602f9d56` on branch `native-app-shell`; pushed to origin. Not merged to `main`.

What was added:
- Capacitor config at `capacitor.config.ts`.
- Native iOS project under `ios/`.
- Native Android project under `android/`.
- Native fallback assets under `public/native-shell/`.
- Native source/icon placeholder under `assets/native/`.
- Internal launch checklist at `docs/native-launch-checklist.md`.
- NPM scripts: `cap:sync`, `cap:ios`, `cap:android`.

Current native shell decisions:
- This is one AthletixOS native shell, not React Native and not separate per-club apps.
- App name is `AthletixOS`.
- iOS bundle ID and Android package ID are both `com.athletixos.app`.
- The Capacitor shell points to the existing web/member portal and starts at `/member`.
- Default local native URL is `http://127.0.0.1:3000`.
- Release/native test URL should be set with `CAPACITOR_SERVER_URL=https://<production-domain>` before `npx cap sync`.
- Fallback server URL order in `capacitor.config.ts`: `CAPACITOR_SERVER_URL`, then `NEXT_PUBLIC_APP_URL`, then `http://127.0.0.1:3000`. `NEXTAUTH_URL` is intentionally NOT in this chain — a misconfigured `.env` would otherwise poison the WebView's start URL.
- Native shell appends `AthletixOSNativeShell` to the user agent.
- Native shell is portrait-oriented to match the member portal mobile flow.
- Placeholder native icons/splash assets are generated from the existing AthletixOS brand icon. Replace with final 1024x1024 app art before store submission.

Web/mobile changes made for the native shell:
- `app/layout.tsx` now sets `viewportFit: "cover"`.
- `app/globals.css` includes safe-area helpers and disables vertical overscroll bounce.
- `app/member/layout.tsx` applies iOS safe-area padding to the mobile header, content, and bottom nav.
- Existing PWA manifest and service worker path were preserved.
- Existing NextAuth credentials/JWT session flow was preserved; no native-only auth was added.
- Existing localStorage-based parent/athlete switching was preserved.
- Stripe checkout links still use the existing web redirect/window flows; verify on device because platform browser behavior can differ.

Branded App page reframe:
- `/dashboard/settings/branded-app` now labels itself as member portal branding.
- It explains what is available now: member portal branding, PWA branding, native AthletixOS shell.
- It explains future roadmap: separate per-club App Store apps, automated app submissions, native push.
- It hides the misleading unused per-club native sections from the editor UI for now, but does not delete saved `brandedAppConfig` data.
- The inline Settings > Branded App roadmap now says the native app is one AthletixOS shell and club branding happens inside the app after login.

Verification already run:
- `npx prisma validate` passed.
- `npx prisma generate` passed.
- `npx tsc --noEmit` passed.
- `npm run build` passed.
- `npx cap sync` passed.
- Browser smoke: mobile `/member` redirects to login when unauthenticated, and `public/native-shell/index.html` plus `native-shell-error.html` render.

Important follow-up tests:
- Run `CAPACITOR_SERVER_URL=https://<production-domain> npx cap sync` before release-device testing.
- Open iOS with `npm run cap:ios`, set signing team in Xcode, run simulator/device.
- Open Android with `npm run cap:android`, let Gradle sync, run emulator/device.
- In the native shell, test member login, member home, schedule, bookings, products, memberships, announcements, messages, documents, and profile switching.
- Test guardian/parent switching specifically.
- Test Stripe checkout/billing portal handoff and return behavior from inside iOS and Android webviews.
- Re-test PWA install from Safari and Chrome to confirm PWA behavior remains intact.

Manual launch checklist lives in `docs/native-launch-checklist.md` and covers Apple Developer, Google Play Console, icons, splash, privacy/support URLs, screenshots, demo login, and review prep.

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
- Tier-gating helper `requireGrowth` in `/api/messages/*` is effectively a no-op since `directMessaging=true` on all current paid tiers. Leave in place if policy might flip.
- Member-side messaging, memberships, events, products endpoints check session but don't apply tier gating beyond what the owner's plan allows.
- Member portal stays light-themed intentionally; raw `bg-stone-*` / `bg-white` / `text-stone-*` classes there will not respond to the dashboard dark-mode toggle.

## Not Built Yet

- Multi-location full UX (schema + `maxLocations` gating in place, but the locations page is thin).
- Separate per-club native mobile apps.
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

## Session log — 2026-06-02 (visual sweep + iOS layout hardening + security pass)

Branch: `native-app-shell` (pushed: NO, merged: NO). Commits in order, oldest first:

| SHA       | Topic                                                     |
|-----------|-----------------------------------------------------------|
| `0e47830` | replace unicode glyph icons with lucide SVG               |
| `a80eb25` | surface child name on every parent-facing message thread  |
| `2c783ff` | redesign events page card — athletic scoreboard layout    |
| `ad5eab4` | polish dashboard schedule widgets — bigger pills/spacing  |
| `0f9a0ca` | fix iOS dashboard/calendar/member icon layout regressions |
| `1dc5cb4` | fix parent/child message context on native shell          |
| `cd1adcf` | API validation, sanitization, rate limiting               |

### Visual sweep (commits `0e47830`, `a80eb25`, `2c783ff`, `ad5eab4`)

- **`0e47830`** — replaced every unicode glyph icon (⌂ ◉ ◎ ◇ ◈ ✉ ✓ $ ▦ □ ⚙ ≡ ▤ ◐ ?) on the owner side with lucide-react SVG components. Touched `lib/dashboardNav.ts` (icon field type changed to `LucideIcon`), `components/DashboardSidebar.tsx`, `components/DashboardBottomNav.tsx`, `app/dashboard/page.tsx` (`sections` + `PRIMARY_QUICK_ACTIONS`), and all 6 `EmptyState` callers. `components/EmptyState.tsx` icon wrapper grew from 48px / app-bg / muted text to 56px / lime-tint background / dark-lime stroke. **New dep**: `lucide-react ^0.469.0`.
- **`a80eb25`** — child threads on `/member/messages` got a lime left border + lime `For <kid>` pill via shared `ChildBadge`. Child-thread links carry `?for=<id>&forName=<first>` to the DM and group thread pages. DM thread + group thread pages render the same pill in the header.
- **`2c783ff`** — `/dashboard/events` card rebuilt as a 4-row scoreboard: type-colored left stripe (jersey stripe), big tabular-nums date pill, name w/ `line-clamp-2`, lucide-icon meta row (Clock / MapPin / Users), lime/orange capacity progress bar, status pill row, multi-session sub-row. Desktop keeps the action button row; mobile uses a single kebab → bottom-sheet action menu. State `actionMenuFor`.
- **`ad5eab4`** — dashboard `upcomingEventsList` and `upcomingClassesList`: date pill widened to 48px with bold tabular-nums, names switched to `line-clamp-2`, type badge stacks under name on mobile / floats right on desktop, weekday + time gain `tabular-nums`.

### iOS hardening (commit `0f9a0ca`)

- **Dashboard horizontal overflow** (Upcoming events overlapping Recent members on iOS). Root cause: CSS Grid items default to `min-width: auto` which is the intrinsic min-content width of their children. Long unbroken content blew out the column track, causing adjacent widgets to visually overlap and the page to gain horizontal scroll. Fix: `min-w-0` on every grid wrapper around section widgets in `app/dashboard/page.tsx`; `overflow-x-hidden` added to `<main>` in `app/dashboard/layout.tsx` as a safety net.
- **Calendar widget squeezed / day numbers overlapping**. Same root cause + quickNav widget used `grid-cols-4` unconditionally for 11 tiles, blowing out the row width on phone widths and crushing the calendar column. Fix: calendar card gets `min-w-0`, cells get `aspect-square` and `gap-1` for guaranteed clickable space, `tabular-nums` on dates, lime event-day dots. quickNav widget responsive: `grid-cols-2 sm:grid-cols-3 lg:grid-cols-4`, tiles get `truncate` / `line-clamp-2` / `min-w-0`.
- **Member dashboard tiles still showing tofu/? boxes on iOS** — Phase 2C migration covered owner dashboard but NOT the member portal home page. `app/member/page.tsx` still used unicode glyphs `◷ ✓ ✉ 📣 ▤ ◎ ◉` for tiles and `✉ ☎ ↗` for ClubBanner contact lines. Fixed via new `TileLink` component (lime-tinted circle holding a lucide icon: CalendarDays / CheckSquare / MessageSquare / Megaphone / FileText / UserCircle2 / Users), used in both AdultAthleteView and ParentView tile grids. ClubBanner placeholder + contact rows + "View the full schedule" CTA chevron + LinkChild success state + "No children linked yet" empty state all migrated. Member portal bottom nav already used local SVG icon components (HomeIcon / BookingIcon / MessageIcon / etc. in `app/member/layout.tsx`) — untouched.

### Parent/child message context on native shell (commit `1dc5cb4`)

The previous implementation in `a80eb25` used Tailwind arbitrary values (`border-l-[5px] border-l-lime-500`, `bg-lime-100 text-lime-800 border-lime-300`). On Tailwind v4, lime-palette JIT + arbitrary-value compilation depend on content scanning + theme inclusion — not guaranteed to be in the iOS bundle's first-paint CSS after install. The lime classes silently no-op'd and the indicators rendered as bare 1px stone-200 default.

Fix:
- `app/member/messages/page.tsx` — top-of-file LIME / LIME_BG / LIME_BORDER / LIME_TEXT constants. ChildBadge and child-thread card backgrounds + 5px left border now use inline `style={{}}` instead of Tailwind classes. Bulletproof against any compile race.
- "Messages for your athletes" section always renders for any parent with linked children (pulled from `/api/member/portal` `guardianOf`), not only when child threads exist. Empty-state lime-tinted info card explains where child messages will appear + flags any linked kid without their own member login (a precondition for receiving coach DMs).
- DM thread page and group thread page lime "For <kid>" pill switched to the same inline-style approach.
- `app/api/member/portal/route.ts` — `guardianOf.member` include now also pulls `user: { id }` so the client can derive `hasOwnLogin` per linked child without an extra request.

### Security pass (commit `cd1adcf`)

**New helpers:**

- **`lib/ratelimit.ts`** — in-memory token-bucket rate limiter. Exports `rateLimit({ key, limit, windowMs })` → `RateLimitResult`, `rateLimitedResponse(rl, message?)` → `NextResponse` with `retry-after` + `x-ratelimit-reset` headers, `ipFromRequest(req)` → first IP in `x-forwarded-for` / `x-real-ip` / "unknown". Periodic janitor sweeps stale buckets every 5 min (interval is `.unref()`'d so it doesn't keep `next dev` alive). Test-only `_resetRateLimitForTests()` export.
- **CAVEAT**: in-memory state is per-process. On long-running Node servers (npm run dev, self-hosted prod) limits are global. On horizontally-scaled serverless deployments (Vercel) each warm instance has its own bucket → effective limit is `limit × warm_instances`. Acceptable best-effort throttling for AthletixOS scale; swap for `@upstash/ratelimit` + Redis if we ever need per-cluster limits.
- **`lib/sanitizeHtml.ts`** — wraps `isomorphic-dompurify` with an allowlist of safe rich-text tags (no `<script>`, no `<iframe>`, no `on*` event handlers, no `javascript:` URLs). Used at WRITE time so stored values are trustworthy on render. **New dep**: `isomorphic-dompurify ^2.36.0`.

**Validation gaps closed** (only 2 of 14 audited routes lacked zod):

- `app/api/messages/dm/route.ts` POST (owner → member DM): replaced manual `typeof` checks with `dmBodySchema` (memberId required, body trimmed, body ≤5000 chars).
- `app/api/upload/route.ts` POST (file upload): added `uploadFieldsSchema` for the `type` enum + explicit `File` instanceof check + empty-file rejection. Pre-existing size + MIME checks kept.

**XSS sanitization wired:**

- `app/api/documents/route.ts` POST and `app/api/documents/[id]/route.ts` PATCH now run `sanitizeRichHtml()` on `body` before storage. `Document.body` is the only field rendered via `dangerouslySetInnerHTML` (in both `/dashboard/documents` and `/member/documents`) — caps the blast radius even if a staff member with `documents:edit` permission tries to ship JS.

**Rate limits applied:**

| Endpoint | Limit | Window |
|---|---|---|
| `auth/forgot-password` (per IP) | 5 | 10 min |
| `auth/reset-password` (per IP) | 10 | 10 min |
| `auth/change-password` (per session) | 5 | 10 min |
| `auth/signup` (per IP) | 5 | 10 min |
| `member/signup` (per IP) | 10 | 10 min |
| `messages/dm` owner→member (per session) | 30 | 1 min |
| `member/messages/dm/[userId]` (per session) | 60 | 1 min |
| `member/messages/groups/[id]` (per session) | 60 | 1 min |
| `member/classes/book` (per session) | 20 | 1 min |
| `member/events/[id]/register` (per session) | 20 | 1 min |
| `public/events/[slug]/register` (per IP) | 10 | 10 min |
| `upload` (per session) | 30 | 1 min |

Each 429 returns a clean message + `retry-after` header + `x-ratelimit-reset` timestamp.

### Files touched this session

- New: `lib/ratelimit.ts`, `lib/sanitizeHtml.ts`, `components/EmptyState.tsx` (already existed; restyled in `0e47830`), `app/member/page.tsx::TileLink` (inline component).
- Modified visual: `lib/dashboardNav.ts`, `components/DashboardSidebar.tsx`, `components/DashboardBottomNav.tsx`, `components/EmptyState.tsx`, `app/dashboard/page.tsx`, `app/dashboard/layout.tsx`, `app/dashboard/events/page.tsx`, `app/dashboard/reports/page.tsx`, `app/dashboard/staff/page.tsx`, `app/dashboard/documents/page.tsx`, `app/member/page.tsx`, `app/member/messages/page.tsx`, `app/member/messages/dm/[userId]/page.tsx`, `app/member/messages/group/[id]/page.tsx`, `app/api/member/portal/route.ts`.
- Modified security: `app/api/messages/dm/route.ts`, `app/api/upload/route.ts`, `app/api/auth/{forgot-password,reset-password,change-password,signup}/route.ts`, `app/api/member/signup/route.ts`, `app/api/member/messages/dm/[userId]/route.ts`, `app/api/member/messages/groups/[id]/route.ts`, `app/api/member/classes/book/route.ts`, `app/api/member/events/[id]/register/route.ts`, `app/api/public/events/[slug]/register/route.ts`, `app/api/documents/route.ts`, `app/api/documents/[id]/route.ts`.
- New deps in `package.json`: `lucide-react ^0.469.0`, `isomorphic-dompurify ^2.36.0`.

### What's left when you return

1. **iOS simulator smoke** — the only blocker between this branch and merge. From the user's last check session:
   - Login works on Chrome + Safari + native shell ✓
   - Native simulator wouldn't open a window for the full manual sweep — re-run `npm run cap:ios`, ensure the App scheme + an iOS simulator device are selected in Xcode, hit ▶. Walk:
     - Dashboard home shows NO horizontal scroll, "Upcoming events" and "Recent members" do NOT overlap, calendar widget renders 7 columns × 5-6 rows with readable day numbers.
     - Member portal home — every tile (Schedule / My Bookings / Messages / Announcements / Documents / Our team or My Profile) shows a lucide icon in a lime circle. **No ? boxes anywhere.**
     - As a parent: `/member/messages` shows "Messages for your athletes" section always (even with zero child messages) + an explanatory lime info card. With actual child threads: each row shows a lime left stripe + "For <kid>" pill. Tap into a child thread — header shows the same pill + "This thread is about <kid>" subtitle.

2. **Untested 429 paths** — code-level clean but no E2E smoke. Quick browser check: 6× rapid "Forgot password" submissions → 6th gets a friendly 429 with a `Retry-After` header.

3. **Document sanitization smoke** — paste `<script>alert(1)</script>hello` into a document body in `/dashboard/documents`. Save. View on `/member/documents` — `<script>` should be gone; "hello" still renders.

4. **Routes NOT audited for zod** (carried over): the parallel audit covered 14 of 26 routes. The 12 not yet read:
   - `app/api/club/update`, `app/api/club/locations`
   - `app/api/transactions`, `app/api/expenses`, `app/api/financials/manual-payment`
   - All STAFF/OWNER-only — limited abuse surface, but should still get a zod-coverage check next pass.

5. **Phase 1 + 2 simulator end-to-end smoke** (carried over from earlier sessions): same checklist in the 2026-05-30 session log below — most items still apply, but the iOS-specific fixes from `0f9a0ca` and `1dc5cb4` need fresh verification.

6. **Pre-existing cleanup still open** (carried over): `lib/auth.ts` pre-existing `as any` casts on session/JWT, unused `allEvents` in `app/dashboard/page.tsx`, unescaped quotes in `app/dashboard/settings/page.tsx`, orphan `/dashboard/schedule/page.tsx`. Low priority.

### Architectural notes for future-me

- **Tailwind v4 arbitrary values are not bulletproof** on iOS WebKit's first paint after install. When a visual indicator MUST render correctly (e.g. a lime border distinguishing parent vs child threads), use inline `style={{}}` with CSS variables or hardcoded hex. This is what the `LIME` / `LIME_BG` / `LIME_BORDER` / `LIME_TEXT` constants in `app/member/messages/page.tsx` exist for.
- **CSS Grid items default to `min-width: auto`** which is the intrinsic min-content width. ALWAYS add `min-w-0` to grid item wrappers if their content includes long unbroken strings (event names, table rows, member names). The default is a footgun that surfaces as iOS-specific layout regressions.
- **lucide-react is now the standard for icons** across owner + member surfaces. No unicode glyphs in user-facing labels. Emojis (👋, ×, ✓ on small buttons) are still OK because the iOS system font carries those; but if in doubt, prefer the SVG.
- **Rate limit conventions**: keys are `${category}:${ip-or-userid}` (e.g. `messages:dm:${userId}`, `auth:signup:${ip}`). 1-minute windows for messaging/booking (operational), 10-minute windows for auth (anti-brute-force). Public routes use IP; authenticated routes use session.user.id.
- **HTML sanitization on WRITE not READ**: the `dangerouslySetInnerHTML` call sites trust their source (they HAVE to — the renderer doesn't get to revalidate). `sanitizeRichHtml()` is invoked once at WRITE time so every read is implicitly trusted.

## Session log — 2026-05-30 (Phase 1 native URL hardening + Phase 2A/B/C dashboard redesign foundation)

Branch: `native-app-shell` (pushed: NO, merged: NO). Commits in order:

| SHA       | Phase   | Title                                                 |
|-----------|---------|-------------------------------------------------------|
| `dfcc270` | 1       | harden native shell URL/redirect chain                |
| `0aeabae` | 2A      | mobile-aware dashboard shell                          |
| `4ae5923` | 2B      | mobile-responsive dashboard overview + primary CTA bar|
| `fc96f22` | 2C      | add EmptyState and LoadingSkeleton primitives         |
| `d5b4b67` | 2C      | apply primitives to reports page                      |
| `e122674` | 2C      | apply primitives to documents page                    |
| `7e606a6` | 2C      | apply primitives to calendar page                     |
| `6761ab7` | 2C      | apply primitives to attendance page                   |
| `f32cbb7` | 2C      | apply primitives to financials page                   |
| `7fc3fa7` | 2C      | apply primitives to classes page                      |
| `304b45b` | 2C      | apply primitives to staff page                        |
| `77efa9b` | 2C      | apply primitives to members page                      |
| `a99879c` | 2C      | apply primitives to events page                       |
| `80335df` | 2C      | apply primitives to settings page                     |
| `5c1fc5d` | log     | mark 2C section sweep complete in session log         |
| `53c4070` | 2D      | bottom-sheet modals + scroll tables + stack form grids|
| `b04cfcb` | log     | mark 2D + 2E complete + test checklist                |
| `b2b72d6` | 2E      | address HIGH/MEDIUM findings from code review         |

### Phase 1 — native shell URL/redirect hardening (DONE)

Root cause of yesterday's 5 native iOS symptoms was a chain: `.env` had a malformed `NEXTAUTH_URL="NEXTAUTH_URL=http://localhost:3001"` (literal key prefix inside the value, WebKit-restricted port, IPv6-first `localhost`). 26 inline `process.env.NEXTAUTH_URL || "http://localhost:300x"` fallbacks across the codebase shipped that malformed string into Stripe / email / redirect URLs. WKWebView blocked the `:3001` nav, fell back to `errorPath`, and the error page retried to `/` (the marketing landing) — silently sending the owner to the wrong surface.

Fixes (commit `dfcc270`):

- **`.env`** (uncommitted because gitignored): set `NEXTAUTH_URL=http://127.0.0.1:3000` (literal IPv4, allowed WebKit port).
- **`lib/baseUrl.ts` NEW** — `getAppBaseUrl()` parses `NEXTAUTH_URL` with `new URL()`, falls back to `http://127.0.0.1:3000` when missing OR malformed (the old `||` pattern only caught missing). Dev-only `console.warn` when fallback fires.
- **23 routes + libs** migrated from the inline fallback to `getAppBaseUrl()`. Full list: `app/api/auth/forgot-password`, `app/api/classes/[id]/charge`, `app/api/club/branded-app`, `app/api/club/subscription/checkout`, `app/api/club/subscription/portal`, `app/api/contractors/[id]/invite`, `app/api/events/[id]/bill-registrants`, `app/api/events/[id]/charge`, `app/api/member/classes/book`, `app/api/member/events/[id]/register`, `app/api/member/memberships/subscribe`, `app/api/member/products/[id]/buy`, `app/api/members/migration/[id]`, `app/api/members/migration/activate/[token]`, `app/api/members/route.ts`, `app/api/members/subscribe`, `app/api/public/events/[slug]/register`, `app/api/staff/[id]/setup-link`, `app/api/staff/route.ts`, `app/api/stripe/connect`, `app/api/stripe/webhook`, `lib/migrationServer.ts`.
- **`scripts/native-shell-config.mjs` NEW** + **`public/native-shell/server-config.js` NEW** — build-time injection of `window.NATIVE_SERVER_URL` from `CAPACITOR_SERVER_URL` / `NEXT_PUBLIC_APP_URL` so production builds retry against the real domain. Runs as part of `npm run cap:sync`.
- **`public/native-shell/native-shell-error.html`** — loads `server-config.js`, retries to `SERVER_URL + "/member"` instead of `/`. Middleware routes from `/member` based on session: valid → `/dashboard` or `/member`; invalid → `/login`. Marketing landing no longer hijacks failed reconnect attempts.
- **`package.json`** — `cap:sync` now runs `node scripts/native-shell-config.mjs && cap sync`.
- **`lib/auth.ts`** — removed temporary `[auth/authorize]` dev logging from yesterday. Kept explicit cookie config + `.trim().toLowerCase()` defensive normalization.
- **`.gitignore` + `git rm --cached -r android/.idea`** — 5 IDE files untracked.
- **Cosmetic 3001→3000** — `app/dashboard/settings/page.tsx:1012`, `app/dashboard/settings/diagnostics/page.tsx:140`, and four lines in this CLAUDE.md.

Verified at code level: `npx tsc --noEmit`, `npm run lint`, `npm run build`, `npm run cap:sync` all clean. **Simulator end-to-end NOT verified** — needs user to run the 5-minute smoke (cold launch, owner login, logout, re-login, force a connect failure to confirm the error-page retries to `/member`).

### Phase 2A — mobile-aware dashboard shell (DONE)

Dashboard had a fixed 248px sidebar on every screen and no mobile sign-out path (sign-out was buried in the sidebar footer; mobile = no sidebar = no logout).

Fixes (commit `0aeabae`):

- **`lib/dashboardNav.ts` NEW** — single source for `NAV[]` + `BOTTOM_NAV[]` + `isGroupActive()` / `isItemActive()`. Both desktop sidebar and mobile bottom nav consume it.
- **`components/DashboardSidebar.tsx` NEW** — extracts the 280-line inline sidebar from `app/dashboard/layout.tsx` verbatim. Desktop look pixel-identical (refactor only). Accepts `onNavigate` so the mobile drawer closes on link click. Preserves Phase 1 `signOutEverywhere` wiring on the sign-out button.
- **`components/DashboardMobileDrawer.tsx` NEW** — slide-in overlay at `< md`. Locks body scroll while open; closes on Escape, backdrop tap, or route change.
- **`components/DashboardBottomNav.tsx` NEW** — fixed bottom nav for mobile, 5 slots: Home / Members / Classes / Money / More. "More" opens the drawer. Charcoal background matches sidebar. `env(safe-area-inset-bottom)` for iOS home indicator.
- **`components/UserMenu.tsx` NEW** — avatar dropdown for the topbar. Click outside / Escape closes. Contents: My account / Client view / Need help? / Sign out (still through `signOutEverywhere`). Solves the no-sign-out-on-mobile gap.
- **`components/PageHeader.tsx` NEW** — shared `<PageHeader title description actions eyebrow />` primitive for section pages. Foundation for Phase 2C polish.
- **`app/dashboard/layout.tsx`** — rebuilt around new components. Desktop (`≥ md`): persistent sidebar + existing BackButton/GlobalSearch topbar + new UserMenu on the right. Mobile (`< md`): charcoal topbar (hamburger + AthletixOS wordmark + UserMenu), second sticky row with Back + Search, fixed bottom nav.

What did NOT change: member portal layout/theme/bottom nav, NextAuth, signOutEverywhere, preview cookie, `/api/me`, permission gating, sidebar content/order. All extracted verbatim.

### Phase 2B — mobile-responsive dashboard overview + primary CTA bar (DONE)

Three problems on the dashboard home: `grid-cols-4` overflowed on mobile; Quick Actions lived inside an optional widget so hiding it killed the fastest paths; `p-8` wasted mobile screen.

Fixes (commit `4ae5923`, single file: `app/dashboard/page.tsx`):

- Outer container: `p-4 sm:p-6 lg:p-8`.
- Stat grid: `grid-cols-2 sm:grid-cols-3 lg:grid-cols-4` — 2 cols on phone, 4 on desktop.
- Section grid: `grid-cols-1 lg:grid-cols-2`.
- StatCard padding + type sizing responsive; long values truncate cleanly.
- Greeting block stacks on mobile, returns to row on `sm+`. Customize button moves to `self-start`.
- **NEW `PRIMARY_QUICK_ACTIONS` bar** above the stats grid — always rendered regardless of widget config. First action ("Add member") is the violet brand-color CTA; the rest are neutral surface buttons. Horizontally scrollable on mobile so it never wraps. Action set: Add member, New class, New event, Send message, Client view.

Widget customize/order/hide system untouched. `/api/dashboard/summary` + `/api/dashboard/widgets` untouched.

### Phase 2C — primitives + full section sweep (DONE)

Primitives (commit `fc96f22`):

- **`components/EmptyState.tsx` NEW** — icon + title + description + action slot (link or onClick).
- **`components/LoadingSkeleton.tsx` NEW** — `SkeletonLine`, `SkeletonCard`, `SkeletonRow`, `SkeletonList`. Pulse-animated placeholders matching `bg-app-bg` / `bg-surface` tokens.

Section sweep (10 commits, one per page): applied `PageHeader` + `SkeletonList`/`SkeletonCard` + `EmptyState` (where structural) across `app/dashboard/{reports,documents,calendar,attendance,financials,classes,staff,members,events,settings}/page.tsx`. Every section page now:

- Uses `PageHeader` with `title` / `description` / `actions` slots — consistent typography and mobile-stacking layout across the dashboard.
- Replaces `"Loading…"` text fallbacks with `SkeletonCard`×N or `SkeletonList rows={N}` — the user sees the shape of what's loading rather than a blank line.
- Where appropriate, the page-level empty state uses `EmptyState` (`documents`, `staff`, `events`, `reports`-tier-blocked). In-card "No X in this range" text fragments left as small text — they're contextual fillers, not page-level zero states.
- Outer padding migrated from `p-8` → `p-4 sm:p-6 lg:p-8` — mobile-friendly density without sacrificing desktop airiness.
- Primary CTAs gain `w-full sm:w-auto` so they're full-width on mobile.
- Settings sub-nav stacks `flex-col md:flex-row` so the sub-section list is reachable without horizontal scroll on phone.

What did NOT change in this sweep: data fetching, API endpoints, business logic, widget customize/order system, sub-section page structure (settings sub-tabs, member-form builder, branded-app config, etc. retain their own structure and can adopt `PageHeader` incrementally).

Verified: full `npm run build`, `npx tsc --noEmit`, `npm run cap:sync` all clean. Pre-existing lint warnings in files (mostly `as any` casts and unescaped quotes) are unrelated — verified each is well outside the lines this sweep touched.

### Files touched this session
- New: `lib/baseUrl.ts`, `lib/dashboardNav.ts`, `scripts/native-shell-config.mjs`, `public/native-shell/server-config.js`, `components/DashboardSidebar.tsx`, `components/DashboardMobileDrawer.tsx`, `components/DashboardBottomNav.tsx`, `components/UserMenu.tsx`, `components/PageHeader.tsx`, `components/EmptyState.tsx`, `components/LoadingSkeleton.tsx`
- Modified (Phase 1): 23 API routes + libs (see Phase 1 list), `lib/auth.ts`, `lib/migrationServer.ts`, `package.json`, `public/native-shell/native-shell-error.html`, `app/dashboard/settings/diagnostics/page.tsx`, `.gitignore`, `CLAUDE.md`
- Modified (Phase 2A/B): `app/dashboard/layout.tsx`, `app/dashboard/page.tsx`
- Modified (Phase 2C sweep): `app/dashboard/{reports,documents,calendar,attendance,financials,classes,staff,members,events,settings}/page.tsx`
- Out of repo (`.env`): `NEXTAUTH_URL=http://127.0.0.1:3000`
- Untracked / removed: 5 `android/.idea/*` files (still on disk, just untracked)

### What's left when you return

Tasks below are ordered for resumption. Pick up at the top.

1. **Simulator verification of Phase 1** — REQUIRED before continuing. 5 minutes:
   - `npm run dev` (port 3000)
   - `npm run cap:ios` → run on simulator
   - Cold launch the app → confirm it lands on `/member` (not `/`). Xcode console should show **zero** "restricted network port" lines.
   - Owner login → confirm lands on `/dashboard`.
   - Sign out → confirm lands on `/login`.
   - Sign back in → confirm it works (this was the symptom-3 blocker).
   - Stop the dev server briefly, watch the "Reconnecting…" screen → confirm it auto-retries to `/member` not `/` once the server comes back.
   - Browser desktop smoke: same login/logout/Client View loop on Chrome / Safari to confirm browser flow is unchanged.

2. **Phase 2C section sweep** — DONE this session. All 10 section pages now use the primitives. Sub-tabs inside settings (Profile / Billing / Email / Branded App / Diagnostics / Club / Member Portal / Member Form) can adopt `PageHeader` incrementally in the next sweep if needed.

### Phase 2D — mobile polish sweep (DONE)

Bulk sed across 22 dashboard files via commit `53c4070`:

- **Modal pattern** applied across all 47 inline modal wrappers in 18 files:
  - Outer `flex items-center justify-center ... p-4` → `flex items-end sm:items-center justify-center ... p-0 sm:p-4` (bottom-sheet on mobile).
  - Inner `rounded-xl w-full` → `rounded-t-2xl sm:rounded-xl w-full` (top-corner-only rounding on mobile).
- **Tables**: 4 wrapper divs `bg-white rounded-xl border border-app-border overflow-hidden` containing `<table className="w-full">` swapped to `overflow-x-auto` so wide financial / product / privates tables scroll horizontally on mobile instead of being clipped.
- **Form grids**: `grid-cols-2 gap-3`, `grid-cols-2 gap-4`, and `grid-cols-3 gap-3` patterns globally rewritten to `grid-cols-1 sm:grid-cols-N gap-N` — two-up form rows stack on mobile.

What was deliberately left alone: calendar week grid (`grid-cols-7`), KPI grids that already had responsive classes from 2B, and `overflow-hidden` usages NOT direct-parent of a table.

### Phase 2E — final regression pass (CODE LEVEL DONE; E2E SMOKE BLOCKED ON USER)

What I verified at code level:

- `npx tsc --noEmit` — clean (no new errors).
- `npm run lint` — only pre-existing warnings/errors in files NOT touched by this branch.
- `npm run build` — full Next.js production build clean.
- `npm run cap:sync` — clean; native bundle re-synced.
- Outside review: dispatched the `review:code-reviewer` agent in background to read the diff and surface anything I missed. Findings (if any) need to be addressed by the user or in a follow-up commit before merging.

What needs a human at a browser / simulator to verify (test checklist below). This is the ONLY blocker between "branch complete" and "merge to main".

4. **End-to-end test checklist before merging to main** (covers BOTH Phase 1 and Phase 2):

   **A. Native iOS shell (Phase 1)** — ~10 min:
   1. `npm run dev` (binds 0.0.0.0:3000)
   2. `npm run cap:ios` → open in Xcode → run on simulator (cold launch from clean state).
   3. App loads to `/member` (NOT marketing `/` and NOT a "Can't reach AthletixOS" screen).
   4. Xcode console shows ZERO `restricted network port` errors during the full session.
   5. Sign in as OWNER via the "Club / Staff" tab → lands at `/dashboard`.
   6. Tap the avatar dropdown in the top-right → tap **Sign out** → lands at `/login`.
   7. Sign back in with the same credentials → re-lands at `/dashboard`. (This was symptom #3 — re-login after logout. The malformed `NEXTAUTH_URL` previously broke this.)
   8. With dev server running, stop it briefly (Ctrl-C in the terminal). Watch the WebView: should show "Reconnecting…" with the auto-retry spinner.
   9. Restart `npm run dev`. The WebView should automatically navigate back to `/member` (NOT `/`). Middleware then sends a signed-in OWNER to `/dashboard`.
   10. Sign out again, force-quit the app, relaunch cold: should land at `/login` (not the marketing landing).

   **B. Browser desktop login matrix (Phase 1)** — ~5 min:
   1. Chrome incognito + Safari private window, both fresh:
   2. `/login` → sign in as OWNER → `/dashboard` loads cleanly.
   3. Sign out (avatar menu, top right) → lands at `/login`.
   4. Sign in as STAFF (a club user with limited permissions). Verify `Staff view · <title>` badge appears in sidebar and bottom-of-page nav. Verify restricted sections are hidden from sidebar AND bottom nav.
   5. Sign in as MEMBER via the "Member / Parent" tab → lands at `/member`. Verify the member portal still renders LIGHT (no dark-mode flip).
   6. As MEMBER, try to manually navigate to `/dashboard/members` → middleware redirects to `/member`.
   7. As OWNER, try `/dashboard/preview` → "Client view" page loads → tap "Preview Member Portal" → amber "Preview mode — Exit preview" banner shows. Tap Exit → bounces back to `/dashboard`. Cookie cleared.

   **C. Desktop dashboard surface (Phase 2A/B/C)** — ~10 min at full desktop width (≥1280px):
   1. `/dashboard` home: hero greeting renders, primary CTA bar shows 5 actions, 4 stat cards in a row, section grid in 2 columns. Customize modal still opens/saves widget prefs.
   2. Sidebar: every section visible; clicking a section sets active state; group sections (Staff, Purchase Options, Classes & Events, Communication) expand/collapse correctly.
   3. Topbar: BackButton hidden on `/dashboard`, shows on every sub-page. GlobalSearch (⌘K) opens. UserMenu avatar at the right opens with My account / Client view / Need help? / Sign out.
   4. Each of these section pages renders the new PageHeader and shows a skeleton on initial load:
      - `/dashboard/members` (table list)
      - `/dashboard/classes` (Classes tab + Events tab)
      - `/dashboard/events`
      - `/dashboard/financials` (Summary / Money In / Money Out / Donations / Tax tabs all skeleton on load)
      - `/dashboard/reports` (KPI skeleton, then chart loads)
      - `/dashboard/staff`
      - `/dashboard/settings` (sub-nav still works)
      - `/dashboard/attendance` (skeleton on Suspense fallback)
      - `/dashboard/documents`
      - `/dashboard/calendar` (42-cell skeleton grid on month change)
   5. Empty states: with a fresh test club, `/dashboard/documents`, `/dashboard/staff`, `/dashboard/events` should each show the new EmptyState UI (icon + title + description + CTA), not raw "No X yet" text.

   **D. Mobile dashboard at 375px width (Phase 2A/D)** — ~10 min using Chrome DevTools device mode (iPhone SE) OR the native shell:
   1. Top app-bar shows: hamburger (left) + AthletixOS wordmark + UserMenu avatar (right). Charcoal background.
   2. Tap hamburger → drawer slides in from the left with full sidebar. Backdrop is dimmed. Body doesn't scroll behind drawer. Tap backdrop or press Esc → drawer closes.
   3. Bottom nav (fixed, charcoal): Home / Members / Classes / Money / More. Tap each — active state updates. "More" opens the drawer.
   4. Drawer "Sign out" works the same as desktop (lands at `/login`).
   5. Avatar menu in mobile topbar: My account / Client view / Need help? / Sign out all reachable. Closes on outside tap.
   6. Navigate to `/dashboard/members`, `/dashboard/financials`, `/dashboard/events`, `/dashboard/classes`. Verify:
      - No horizontal page scroll (the page itself never overflows; content stays within 375px).
      - Page header stacks: title and description on top, action buttons below in a wrapping row.
      - Stat-card grids render 2-up on mobile, not 4-up.
      - Tables (financials transactions, products list, privates packages) scroll horizontally inside their rounded card — the outer page does not.
   7. Open ANY modal on mobile (Add member, Edit class, etc.):
      - Modal slides up from the bottom edge (bottom-sheet style).
      - Modal has rounded TOP corners only (touches bottom edge).
      - Tap outside / backdrop closes it (where the original modal supported that).
      - Modal content scrolls inside the sheet; the underlying page does not.
   8. Open a form-heavy modal (Edit Class is good): two-up form fields stack to single-column on mobile.

   **E. Phase 1 + 2 do not regress what was working:**
   - Stripe checkout / payment flows: complete a member subscription (test mode) → ensure success/cancel URLs land back on the right page (not at `:3001`).
   - Email flows: trigger a staff invite, password reset, or booking confirmation → the link in the email uses `127.0.0.1:3000` (or the configured prod URL), NOT `localhost:3001`.
   - Webhook listening: `stripe listen --forward-to localhost:3000/api/stripe/webhook` works.
   - Client View preview: enter from `/dashboard/preview`, exit from the amber banner on the member portal — cookie cleared, lands at `/dashboard`.

   **F. Outside review** (done this session, follow-up items captured below):
   - The `review:code-reviewer` agent reviewed the Phase 1 + 2A + 2D diffs and surfaced 10 items. The 2 HIGH-severity and 3 of 4 MEDIUM-severity were fixed in commit `b2b72d6`. The remaining LOW items and one MEDIUM (#4 subpath deployments — documented inline) are captured in "Known follow-ups from review" below.

### Known follow-ups from review (LOW priority, not blocking merge)

These are review findings that did NOT block merging but should be addressed when next touching the affected file:

1. **Bulk-sed visual downgrades** — Phase 2D's form-grid sed rewrote *every* `grid-cols-3 gap-3` to stack on mobile. Most are form fields where stacking is correct, but a few short-label numeric KPI tiles (notably the Seen / Opened / Link clicks tiles on `app/dashboard/announcements/page.tsx` around line 263, and the City / State / Zip address row on `app/dashboard/members/page.tsx` around line 744) read better as 3-up even on small mobile. Audit and selectively revert these specific grids to `grid-cols-3 sm:gap-3` (without the `grid-cols-1 sm:` prefix) when convenient.

2. **NAV duplication** — `lib/dashboardNav.ts` `NAV` and `app/dashboard/page.tsx` `sections` array are two independent lists of the same routes with the same labels and same icons. They'll drift silently. Next time `app/dashboard/page.tsx` is touched, hoist `sections` out and derive it from `NAV`.

3. **/api/me redundant for OWNER** — `app/dashboard/layout.tsx` always fetches `/api/me`, but the session token already carries the OWNER role + null permissions. Skip the fetch when `session.user.role === "OWNER"` — saves one round-trip per dashboard page load for the most common user.

4. **Subpath deployment caveat** — `lib/baseUrl.ts:getAppBaseUrl()` uses `new URL(raw).origin` which strips path components. A `NEXTAUTH_URL=https://example.com/app` becomes `https://example.com`, dropping the `/app` prefix. Currently NO deploys use subpath URLs; if that ever changes, return `new URL(raw).href.replace(/\/$/, "")` instead. Caveat documented inline at the top of `lib/baseUrl.ts`.

5. **Pre-existing cleanup still open** (carried from yesterday + still relevant):
   - `lib/auth.ts` lines 94, 102-113 have pre-existing `as any` casts on session/JWT — type properly with `next-auth.d.ts` augmentation when convenient.
   - `app/dashboard/page.tsx:76` — unused `allEvents` state slot.
   - `app/dashboard/settings/page.tsx:997-1007` — pre-existing unescaped quotes in iOS/Android install instructions.
   - `app/dashboard/schedule/page.tsx` — orphan kept on purpose (back-compat), but nothing in source links to it anymore. Consider removing after the section sweep settles.

6. **Out of scope but still worth doing** (from prior sessions, unchanged):
   - Live Stripe end-to-end (`stripe listen --forward-to localhost:3000/api/stripe/webhook`) + live Price IDs.
   - Multi-location full UX.
   - SMS provider wiring for the announcement broadcast.
   - Add-Staff invite bio/photo (currently Edit-only).
   - Smoke scripts for: member-add → status flip, trial, document re-sign, calendar feed, class regenerate.

### Architectural notes for future-me

- `lib/baseUrl.ts` is the ONLY place that should derive an absolute URL from env. Never reintroduce `process.env.NEXTAUTH_URL || "http://..."` — the `||` pattern silently passes a malformed truthy value. A pre-commit grep for that pattern would catch regressions.
- The native shell error page reads `window.NATIVE_SERVER_URL` from `server-config.js`. For a TestFlight or production build, run `CAPACITOR_SERVER_URL=https://app.athletixos.com npm run cap:sync` so the generator writes the right URL into the bundle.
- `lib/dashboardNav.ts` is the single source for the nav tree. To add a section: add it to `NAV` (desktop sidebar uses it automatically) and decide whether it earns a `BOTTOM_NAV` slot (5 slots, max — fight for them).
- `components/DashboardSidebar.tsx` is used in TWO places: directly inside the desktop `<aside>` and inside `DashboardMobileDrawer`. Any styling changes affect both surfaces.
- The avatar in `UserMenu` uses `initialsOf(displayName, email)` — first letters of the first two words of the display name. Fallback is first letter of email. NextAuth's `session.user.name` is the source of truth; `/api/me` does NOT return name fields.

## Session log — 2026-05-29 (native auth + WebView reliability)

Branch: `native-app-shell` (pushed; not merged to `main`). Tip: `11c6493`.

### What changed (in commit order)
- `5d7db99` Login page now hard-navs (`window.location.href`) after `signIn` instead of `router.replace`, fixing the stuck-on-/login bug in iOS WKWebView and Safari.
- `b0a9506` Added `app/post-login/route.ts` — server-side reads JWT via `getServerSession` and 307s to `/dashboard` or `/member`. Eliminates all client-side session hydration races.
- `2c2980b` Safari Set-Cookie commit race: added a macrotask yield in the login page plus an HTML auto-retry page inside `/post-login` (`?retry=N`, max 2). If the cookie isn't visible to the server on first GET, the page reloads itself with a counter and the cookie is there by then.
- `e4857a4` Reverted `.trim()` on email/clubSlug — was an unnecessary change and surfaced a non-`CredentialsSignin` error string in the UI when present.
- `bdc0365` Two bug fixes in one:
  - Explicit cookie config in `lib/auth.ts` (`useSecureCookies` + `cookies.sessionToken/callbackUrl/csrfToken`), pinned to `NODE_ENV` instead of `NEXTAUTH_URL`. Reason: `.env` had `NEXTAUTH_URL="NEXTAUTH_URL=http://..."` (literal key prefix inside the value), which made NextAuth's auto-detection pick `__Secure-` cookies on http://localhost — Safari refuses to store those.
  - `cache-control: no-store, no-cache, must-revalidate` on every `/post-login` response so a previous OWNER login's cached 307 can't route a later MEMBER to `/dashboard`.
- `5b47b13` Real root cause of the simulator 401: iOS WKWebView's default soft keyboard auto-capitalized the club slug. `apex-wrestling` arrived as `Apex-wrestling`. Fix: `autoCapitalize="none"`/`autoCorrect="off"`/`spellCheck={false}` + appropriate `autoComplete`/`inputMode` on all three login inputs. Also added dev-only `[auth/authorize] …` logging (no passwords, no hashes) and defensive `.trim().toLowerCase()` on email + clubSlug server-side.
- `6ee0693` `capacitor.config.ts` default URL → `http://127.0.0.1:3000`. macOS resolves `localhost` to IPv6 `::1` first; Next dev was on IPv4 only, so the WebView's connect was refused. Removed `NEXTAUTH_URL` from the WebView fallback chain (malformed env was poisoning `server.url`).
- `5d447ca` Dev port moved from 3001 → 3000 because WebKit added 3001 to its restricted-network-ports blocklist (the "Not allowed to use restricted network port" Xcode error). Updated `package.json`'s `dev` script to `next dev -H 0.0.0.0 -p 3000` so the simulator + any LAN device can reach Next regardless of IPv4/IPv6 preference.
- `df12a40` Phase 1 reliability + logout pass:
  - `public/native-shell/native-shell-error.html` rewritten: dark themed, spinner, auto-retries the server URL every 2s for up to 4 attempts (tracked in `sessionStorage`), then surfaces a "Try again" button. Replaces the static "Can't reach AthletixOS / reopen the app" dead-end.
  - `lib/signOutEverywhere.ts` (new): calls `signOut({ redirect:false })`, `DELETE /api/preview` (clears the HttpOnly Client-View cookie), removes `athletixos-active-profile` from localStorage, then hard-navs to `/login`. Wired into `app/dashboard/layout.tsx` + `app/member/layout.tsx` (desktop + mobile sign-out buttons).
- `11c6493` End-of-day misc: `package-lock.json` from before the session, plus the `android/.idea/` IDE files (probably should be gitignored next session).

### Native shell state right now
- Dev port: **3000** (was 3001; WebKit-blocked).
- Default `server.url`: `http://127.0.0.1:3000/member` (was `http://localhost:3001/member`).
- `npm run dev` binds `0.0.0.0:3000` automatically.
- iOS simulator usually loads cleanly. If Next isn't up yet, the new dark "Reconnecting…" screen auto-retries instead of showing a dead "Can't reach" page.
- Sign out works identically in Chrome, Safari, and WKWebView (always lands on `/login`, clears local state + preview cookie).

### Tomorrow's queue

**Must-do (cleanup from today):**
1. **Fix `.env`** — the value is malformed and the port is wrong:
   ```diff
   - NEXTAUTH_URL="NEXTAUTH_URL=http://localhost:3001"
   + NEXTAUTH_URL=http://localhost:3000
   ```
2. **Remove the temporary `[auth/authorize] …` dev logging** from `lib/auth.ts` once you've confirmed login is stable across web + native. Search for `[auth/authorize]` to find the lines — gated on `NODE_ENV !== "production"` already, so it never runs in prod, just noisy in dev.
3. **Decide on `android/.idea/`** — committed today (5 files). If those are personal IDE config, add `android/.idea/` to `.gitignore` and revert that commit.

**Doc/UI sweep (no behavior impact, do when convenient):**
- CLAUDE.md still says port 3001 in a few places (this file's intro, native-shell section, Stripe CLI hint).
- `app/dashboard/settings/page.tsx:1012` — "Member portal URL: localhost:3001/member" hint.
- `app/dashboard/settings/diagnostics/page.tsx:140` — "stripe listen --forward-to localhost:3001/..." hint.
- The `|| "http://localhost:3001"` fallbacks in API routes (~10 places) — only fire when `NEXTAUTH_URL` is unset, so safe to leave, but worth a sweep.

**Phase 2 — Owner/staff dashboard redesign (not started):**
- Plan was: nav first, then overview cards, then per-section visual passes — incrementally, not a swing-for-the-fences rewrite.
- Sections in scope: sidebar/top nav, dashboard overview, members, classes/events, attendance, privates, financials, reports, staff tools, settings/personalization.
- Constraint: do not change APIs, auth, Stripe/Plaid, or role permissions. UI-only.
- Reuse design tokens from `app/globals.css` (no new color families).

**Phase 3 — Member dashboard polish (not started):**
- Keep direction/style; polish spacing, nav, empty states, buttons, mobile layout. Should feel like a real native app inside the WebView.

**Out-of-scope items still open from prior sessions** (unchanged by today):
- Live Stripe end-to-end + live Price IDs.
- Multi-location UX.
- SMS provider wiring.
- Add-Staff invite bio/photo (currently Edit-only).
- Smoke scripts for member-add → status flip, trial, doc re-sign, calendar feed, class regenerate.

### Files touched this session
- `web/app/login/page.tsx`
- `web/app/post-login/route.ts` (new)
- `web/lib/auth.ts`
- `web/lib/signOutEverywhere.ts` (new)
- `web/capacitor.config.ts`
- `web/package.json`
- `web/app/dashboard/layout.tsx`
- `web/app/member/layout.tsx`
- `web/public/native-shell/native-shell-error.html`

## Next Priorities

- Run live Stripe end-to-end with the CLI (`stripe listen --forward-to localhost:3000/api/stripe/webhook`) and verify the diagnostics page surfaces each event correctly.
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
