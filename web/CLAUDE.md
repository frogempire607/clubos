# ClubOS — Project Context for Claude Code

## What is ClubOS?

ClubOS is a multi-tenant SaaS platform that lets gym and sports club owners manage their club, members, events, and payments. Built for any sport (wrestling, BJJ, gymnastics, MMA, etc.).

**Two sides:**
1. **Club owner dashboard** — manage members, events, memberships, payments, staff, documents, messaging
2. **Member-facing app** — book classes, track progress, pay, communicate with coaches

**Key architecture principle:** Every club is a tenant. All data is scoped by `clubId`. One database, many clubs.

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Framework | Next.js 14.2.35 (App Router) |
| Auth | NextAuth v4 (credentials provider, JWT sessions) |
| Database | PostgreSQL via Prisma ORM |
| Payments | Stripe (Connect for club payouts, subscriptions for member billing) |
| Styling | Tailwind CSS |
| Language | TypeScript |
| Hosting (future) | Vercel (web) + managed Postgres |

**Important version pins** (do NOT upgrade):
- `next`: `14.2.35` (not 15 or 16)
- `next-auth`: `^4.24.7` (not v3)
- `prisma` + `@prisma/client`: `5.7.0` (must match exactly)
- `stripe`: `^14.21.0`

---

## Project Structure

```
clubos/
└── web/                          ← Next.js app (everything lives here)
    ├── app/
    │   ├── api/
    │   │   ├── auth/
    │   │   │   ├── [...nextauth]/route.ts
    │   │   │   ├── signup/route.ts
    │   │   │   ├── forgot-password/route.ts
    │   │   │   └── reset-password/route.ts
    │   │   ├── club/
    │   │   │   └── update/route.ts
    │   │   ├── members/
    │   │   │   ├── route.ts
    │   │   │   ├── [id]/route.ts
    │   │   │   └── subscribe/route.ts
    │   │   ├── memberships/
    │   │   │   ├── route.ts
    │   │   │   └── [id]/route.ts
    │   │   ├── classes/              ← NOT BUILT YET
    │   │   │   ├── route.ts
    │   │   │   └── [id]/
    │   │   │       ├── route.ts
    │   │   │       └── sessions/route.ts
    │   │   ├── events/
    │   │   │   ├── route.ts
    │   │   │   └── [id]/
    │   │   │       ├── route.ts
    │   │   │       ├── bookings/route.ts
    │   │   │       └── charge/route.ts
    │   │   ├── attendance/           ← NOT BUILT YET
    │   │   │   └── route.ts
    │   │   ├── custom-fields/
    │   │   │   ├── route.ts
    │   │   │   └── [id]/route.ts
    │   │   ├── transactions/
    │   │   │   └── route.ts
    │   │   ├── messages/             ← NOT BUILT YET
    │   │   ├── announcements/        ← NOT BUILT YET
    │   │   ├── documents/            ← NOT BUILT YET
    │   │   ├── staff/                ← NOT BUILT YET
    │   │   └── stripe/
    │   │       ├── connect/route.ts
    │   │       ├── status/route.ts
    │   │       ├── dashboard/route.ts
    │   │       └── webhook/route.ts
    │   ├── dashboard/
    │   │   ├── layout.tsx
    │   │   ├── page.tsx
    │   │   ├── members/page.tsx
    │   │   ├── classes/              ← NOT BUILT YET
    │   │   ├── events/page.tsx
    │   │   ├── attendance/           ← NOT BUILT YET
    │   │   ├── purchase-options/     ← replaces /memberships
    │   │   │   ├── memberships/page.tsx
    │   │   │   ├── privates/page.tsx
    │   │   │   └── products/page.tsx
    │   │   ├── staff/
    │   │   │   ├── page.tsx          ← NOT BUILT YET (placeholder)
    │   │   │   ├── schedule/page.tsx ← NOT BUILT YET
    │   │   │   └── availability/page.tsx ← NOT BUILT YET
    │   │   ├── financials/page.tsx
    │   │   ├── messages/             ← NOT BUILT YET (placeholder)
    │   │   ├── documents/            ← NOT BUILT YET (placeholder)
    │   │   └── settings/
    │   │       ├── billing/page.tsx
    │   │       └── custom-fields/page.tsx
    │   ├── login/page.tsx
    │   ├── signup/page.tsx
    │   ├── onboarding/page.tsx
    │   ├── forgot-password/page.tsx
    │   ├── providers.tsx
    │   └── layout.tsx
    ├── components/
    │   └── StripeRequiredBanner.tsx
    ├── lib/
    │   ├── auth.ts
    │   ├── prisma.ts
    │   └── stripe.ts
    ├── prisma/
    │   └── schema.prisma
    ├── types/
    │   └── next-auth.d.ts
    ├── middleware.ts
    ├── .env
    └── package.json
```

---

## Environment Variables (.env)

```
DATABASE_URL="postgresql://user@localhost:5432/clubos"
NEXTAUTH_SECRET="your-secret-here"
NEXTAUTH_URL="http://localhost:3000"
STRIPE_SECRET_KEY=sk_test_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
# Future:
SENDGRID_API_KEY=...        ← for email sending
PLAID_CLIENT_ID=...         ← for bank integration
PLAID_SECRET=...
TWILIO_ACCOUNT_SID=...      ← for SMS (Pro+)
TWILIO_AUTH_TOKEN=...
```

---

## Database Schema (Key Models)

```prisma
Club {
  id, name, slug (unique), tier, tagline, sport, primaryColor, logoUrl
  stripeAccountId, stripeOnboardingComplete, stripeChargesEnabled, stripePayoutsEnabled
  stripeCustomerId, stripeSubscriptionId, subscriptionStatus
  plaidAccessToken?     ← for bank integration (future)
  plaidItemId?
}

User {
  id, clubId, email, passwordHash, firstName, lastName
  role: "OWNER" | "STAFF" | "MEMBER"
  resetToken, resetExpires, lastLoginAt
  @@unique([clubId, email])
}

# Guardian/Family profile — one per family, identified by parent email
Guardian {
  id, clubId
  firstName, lastName
  email (primary account email for the family)
  phone (required)
  userId?   ← linked User account if they log in
  createdAt, updatedAt
}

Member {
  id, clubId, userId?
  firstName, lastName, dateOfBirth?
  isMinor (Boolean — computed or set based on dateOfBirth)
  guardianId?   ← links to Guardian if athlete is a minor
  # If minor: guardian email is the contact email; athlete email is optional
  email?        ← only used for adult members; omit for minors
  phone?        ← athlete phone, optional for minors
  status: "ACTIVE" | "PROSPECT" | "INACTIVE" | "PAUSED"
  membershipId?, tags (String, comma-separated), notes?
  customFieldValues (JSON string: { fieldId: value })
  stripeCustomerId?
  profileImageUrl?
}

# A Guardian can have multiple Member records (siblings under one family)
# Guardian.id → Member.guardianId (one-to-many)

Membership {
  id, clubId, name, description?, active
  options (JSON string: [{ label, price, billingPeriod }])
  billingPeriod values: WEEKLY | MONTHLY | QUARTERLY | SEMI_ANNUAL | ANNUAL | ONE_TIME
}

MemberSubscription {
  id, memberId, membershipId, optionLabel
  stripeSubscriptionId?, stripePriceId?
  status: "pending" | "active" | "past_due" | "canceled"
  startedAt?, canceledAt?
}

# Classes are recurring weekly schedules (separate from one-off Events)
Class {
  id, clubId, locationId?
  name, description?
  dayOfWeek (0–6, Sunday=0)
  startTime (HH:MM), endTime (HH:MM)
  capacity?
  recurrenceStartDate, recurrenceEndDate
  active
  # Pricing uses selectable purchase options (not plain price fields):
  pricingOptions (JSON: [{ type: "member"|"nonmember"|"dropin", price }])
  createdAt, updatedAt
}

# Each occurrence of a Class on a specific date
ClassSession {
  id, classId, clubId
  date (the specific calendar date of this session)
  startsAt, endsAt
  canceled (Boolean)
  createdAt
}

# Attendance for a ClassSession (or an Event)
AttendanceRecord {
  id, clubId
  sessionId?   ← ClassSession id (for class attendance)
  eventId?     ← Event id (for event attendance)
  memberId
  status: "PRESENT" | "ABSENT" | "LATE" | "TRIAL" | "DROP_IN"
  checkedInAt?
  addedBy (userId of staff who recorded)
  createdAt
}

Event {
  id, clubId, locationId?
  type: "CLINIC" | "CAMP" | "TOURNAMENT" | "SEMINAR" | "PROGRAM" | "OTHER"
  name, description?
  startsAt, endsAt
  capacity?
  # Repeating sessions support (for multi-day camps etc.)
  hasRepeatSessions (Boolean)
  repeatSessionDates? (JSON: array of date strings)
  # Pricing uses selectable purchase options (not plain price fields):
  pricingOptions (JSON: [{ type: "member"|"nonmember"|"dropin", price }])
  travelFee?
  imageUrl?
  publishAt?, unpublishAt?
  # Tournament-specific fields:
  isTournament (Boolean)
  registrationLink?
  registrationDeadline?
  registrationOpen?   ← Boolean: show open or closed badge
  divisions?          ← JSON or text: age/weight/skill division notes
}

Booking {
  id, eventId, memberId
  status: "CONFIRMED" | "WAITLISTED" | "CANCELED" | "ATTENDED" | "NO_SHOW"
  @@unique([eventId, memberId])
}

CustomField {
  id, clubId, label
  fieldType: "text" | "email" | "phone" | "address" | "date" | "textarea" | "number" | "select"
  required, options (JSON string), sortOrder, active
}

Transaction {
  id, clubId, memberId?, amount, platformFee?
  status: "PENDING" | "SUCCEEDED" | "FAILED" | "REFUNDED"
  stripePaymentIntentId?
}

# NOT YET IN SCHEMA — add when building:

Message {
  id, clubId, senderId (User), recipientId (User)?
  groupId (MessageGroup)?
  body, readAt?, hasAttachment?
  attachmentUrl?    ← file or document attachment
  videoUrl?         ← coach video uploads
  createdAt
}

MessageGroup {
  id, clubId, name, type: "DIRECT" | "GROUP" | "BROADCAST" | "COACH_NOTES"
  memberIds (comma-separated or join table)
  createdAt
}

Announcement {
  id, clubId, title, body
  channels (comma-separated: "app" | "email" | "push")
  publishAt?, unpublishAt?
  status: "DRAFT" | "PUBLISHED" | "SCHEDULED"
  createdAt, updatedAt
}

Document {
  id, clubId, title, type
  body (rich text / HTML)
  required, publishAt?, unpublishAt?
  expiresAt?       ← document expires and member must re-sign
  requiresGuardianSignature (Boolean)
  createdAt, updatedAt
}

DocumentSignature {
  id, documentId, memberId
  signedAt, signedByGuardianId? (User)
  ipAddress?
}

StaffProfile {
  id, userId, title?
  hourlyRate?, salary?
  permissions (JSON: { members: bool, classes: bool, messages: bool, finances: bool, ... })
  appointmentPrice?
  profileImageUrl?
  createdAt, updatedAt
}

PlaidTransaction {
  id, clubId
  plaidTransactionId (unique)
  amount, date, description, category?
  isIncome (Boolean)
  createdAt
}
```

---

## Pricing Tiers

| Tier | Price | Transaction Fee | Key Features |
|------|-------|----------------|--------------|
| Starter | $0/mo | 2.5% | 150 member cap, 1 location, basic messaging |
| Growth | $49/mo | 1.25% | Unlimited members, reports, direct messaging |
| Pro | $99/mo + $50 setup | 0% | Branded iOS + Android app, full analytics |
| Enterprise | $199/mo + $50 setup | 0% | Multi-location, API, custom onboarding |

**Note:** Tier gating is NOT yet implemented in the codebase. It will be one of the last features built so we know exactly what each tier includes. For now, all features are accessible.

Platform fee is taken via Stripe Connect `application_fee_amount` or `application_fee_percent`.

---

## Auth Flow

1. User visits `/signup` → toggle: "Create a club" or "Join a club"
2. **Create a club:** API creates temp club → creates user as OWNER → redirects to `/onboarding`
3. **Join a club:** User provides club slug → creates user as MEMBER → redirects to `/dashboard`
4. Onboarding wizard (4 steps): club name → URL/slug → branding → review/launch
5. Login: `POST /api/auth/callback/credentials` with `{ email, password, clubSlug }`
6. Session JWT contains: `{ id, email, name, role, clubId }`
7. `middleware.ts` protects `/dashboard/**`, `/admin/**`, `/member/**`

---

## Stripe Architecture

**Two separate Stripe integrations:**

1. **Stripe Connect (club → members):**
   - Each club connects their own Stripe Express account
   - Members pay via Stripe Checkout → money goes to club's Stripe account
   - ClubOS takes platform fee via `application_fee_amount`

2. **ClubOS subscription (club pays us):** Not yet implemented.

**Webhook events handled:**
- `account.updated` → sync Connect status
- `checkout.session.completed` → record transaction, activate subscription
- `invoice.paid` → record renewal
- `invoice.payment_failed` → mark past_due
- `customer.subscription.deleted` → mark canceled

**Local dev webhooks:**
```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook \
  --forward-connect-to localhost:3000/api/stripe/webhook
```

---

## Sidebar / Navigation

```
Dashboard
Members
Staff
  └── Schedule
  └── Availability
  └── Payroll / Payouts
Purchase Options
  └── Memberships
  └── Privates
  └── Products
Classes & Events
Messaging
Attendance
Financials
Reports
Settings
```

**Notes:**
- "Memberships" in the top-level nav is renamed to **"Purchase Options"** with Memberships, Privates, and Products as sub-items.
- **Schedule** and **Availability** live under **Staff** because staff manage their own schedule/availability.
- **Classes & Events** is a single section covering recurring classes and one-off events (clinics, camps, tournaments, etc.).
- **Attendance** is its own top-level section for daily check-in management.

---

## FULL SPECS FOR UNBUILT FEATURES

---

### 1. MEMBERS & FAMILY ACCOUNTS

#### Minor Logic
- When adding or importing a member, the system checks `dateOfBirth` (or asks "Is this athlete a minor?").
- If the athlete is a minor:
  - **Do NOT ask for the athlete's email** — the parent/guardian email is the primary contact.
  - **Parent/guardian phone is required.**
  - **Athlete phone is optional.**
- If the athlete is an adult: email and phone are both collected as normal.

#### Sibling / Family Accounts
- Multiple athletes (siblings) can be linked to **one Guardian profile**.
- The Guardian profile holds: `firstName`, `lastName`, `email` (primary), `phone` (required).
- Each athlete is a separate `Member` record with `guardianId` pointing to the same `Guardian`.
- When viewing a Guardian profile, all linked athletes (siblings) are listed together.
- When adding a new minor: offer to search for an existing Guardian by email before creating a new one. If a Guardian with that email already exists, link the new athlete to them automatically.

#### Member Profile Fields
- All member/athlete records support a **profile image upload** (direct file upload from device, see Image Imports section).

---

### 2. MESSAGING SYSTEM

**Tiers:** Direct messaging = Growth+, Email/SMS = Pro+, all announcements = all tiers

**Four message types:**

#### A. Direct Messages (1-on-1)
- Staff/owners can message any client (athlete or guardian) directly.
- Members CAN message coaches back (two-way).
- **Minor rule:** When a staff member starts a direct message thread with a minor athlete:
  - The parent/guardian is automatically included in the thread.
  - If the athlete has their own account, they are also included.
  - Parent/guardian is always the default recipient — the system never messages a minor without their guardian.
- Read receipts — show "Seen" when recipient opens it.
- Attach files, images, or videos (see Image Imports section).
- Send via: in-app only (Growth), in-app + email (Pro+).

#### B. Group Messages
- Owner/staff can create groups by tag, class, team, or custom selection.
- Any member in the group can reply (all see replies).
- Groups can be named (e.g. "Varsity Team", "Morning Class").
- **Minor rule:** If any athlete in a group is a minor, their guardian is automatically added to the group.

#### C. Broadcast (one-way announcements)
- Owner sends to ALL members or filtered group.
- Members cannot reply.
- Delivered via: in-app banner, push notification, email (Pro+), SMS (Pro+).
- Can be scheduled (publish at a future date/time).
- Draft → Scheduled → Published states.

#### D. Coach Notes (private, per-member)
- Coach writes notes visible only to that member + their guardians.
- Can attach video (coach uploads training video for that member).
- Member/guardian can see but NOT reply to coach notes.
- This is different from direct messages — it's a performance log.

**UI Layout (3-pane like Slack/email):**
- Left: conversation list (search, filter by type)
- Middle: message thread
- Right: member info sidebar (name, membership, upcoming events)

**Parent/Guardian visibility:**
- Guardian receives all communications their child receives.
- Guardian can message coaches on behalf of their child.
- Coaches can see which account sent a message (guardian vs. athlete).

**Data model:** See Message, MessageGroup in schema above.

---

### 3. CLASSES & SCHEDULE

**Classes are separate from Events.** Classes are recurring, weekly, and ongoing. Events are one-time (or multi-session) special programs.

#### Creating a Class
- Owner/staff creates a class with:
  - Name, description, location
  - Day(s) of week + start/end time (e.g. Monday 5:30–7:00 PM, Wednesday 5:30–7:00 PM)
  - Recurrence range: start date → end date (or "ongoing until canceled")
  - Capacity (optional)
  - Pricing options (see Pricing below)
- The system **automatically generates `ClassSession` records** for each occurrence on the schedule.
- Sessions appear on the class calendar/schedule view automatically.

#### Managing a Class Session
- Staff can view any session from the schedule.
- Each session has a roster of enrolled members.
- Staff can:
  - View the full roster for that session
  - Check in existing clients (mark present, absent, late, trial, drop-in)
  - Add an existing member to the session
  - Add a brand-new member on the spot (quick add: name, phone, guardian info if minor)
- Attendance status options: **Present**, **Absent**, **Late**, **Trial / Drop-in**

#### Class Pricing
- Do NOT use plain input boxes labeled "member price," "nonmember price," "drop-in fee."
- Instead, use **selectable purchase options**:
  - Owner enables/disables each option individually
  - Options: **Member Pricing**, **Non-Member Pricing**, **Drop-In / Per-Session Fee**
  - If an option is enabled, the owner enters a price for it

---

### 4. EVENTS

Events are for **clinics, camps, tournaments, seminars, and special one-time programs**. They are distinct from recurring Classes.

#### Event Types
- `CLINIC` — skill-focused short workshop
- `CAMP` — multi-day intensive
- `TOURNAMENT` — competition event (see Tournament fields below)
- `SEMINAR` — guest instructor / guest coach
- `PROGRAM` — custom special program
- `OTHER`

#### Repeated Sessions
- Events can have repeat sessions (e.g. a 3-day camp with separate check-in each day).
- If `hasRepeatSessions` is true, owner enters the individual session dates.
- Each session date can have its own attendance tracked.

#### Event Pricing
- Same pattern as Class pricing — selectable purchase options:
  - **Member Pricing**, **Non-Member Pricing**, **Drop-In / Per-Session Fee**
  - Each is optional; owner enables and sets a price per option
- Travel fee remains a separate optional field.

#### Tournament-Specific Fields
When `isTournament` is true, show additional fields:
- **Registration link** — URL to external registration
- **Registration deadline** — date/time
- **Registration status** — toggle: Open / Closed (displays a badge on the event)
- **Divisions** — text field for age/weight/skill division notes (e.g. "Youth 8–12, Adult Beginner, Adult Advanced")

#### Event Image
- Each event supports an image upload (direct file upload from device).

---

### 5. ATTENDANCE TRACKING

Attendance is managed per class session or per event. Staff access it from the Classes & Events section or the dedicated Attendance section.

#### Staff Attendance View (per session)
From any class session or event, staff open the attendance panel and can:
1. **View roster** — list of all enrolled/registered members for that session
2. **Check in existing clients** — tap/click to mark status
3. **Add an existing member** — search and add someone not on the roster
4. **Add a brand-new member** — quick-add form (name, contact, guardian if minor) without leaving the attendance screen
5. **Mark status** for each attendee:
   - **Present**
   - **Absent**
   - **Late**
   - **Trial / Drop-In** (for first-timers or drop-ins not on a membership)

#### Attendance History
- Each member profile shows their attendance history (sessions attended, absent, late).
- Owners/staff can see a 14-day (or custom range) attendance heatmap per member.
- Exportable (see Exports section).

---

### 6. ANNOUNCEMENTS (separate from messages)

- Owner creates announcements with title + body (rich text)
- Choose delivery channels: in-app banner, push notification, email, SMS
- Schedule publish/unpublish dates
- States: Draft, Scheduled, Published, Archived
- Members see announcements on their dashboard home screen
- Owners see all announcements with status + read count

---

### 7. DOCUMENTS & FORMS

**Owner capabilities:**
- Upload or create documents (waivers, code of conduct, photo release, custom forms)
- Drag-and-drop form builder with field types:
  - Text, long text, date, phone, email, signature, checkbox, dropdown
- Set document as required (member can't book until signed)
- Set expiration date (member must re-sign after expiry)
- Toggle: requires guardian signature for minors
- Publish/unpublish dates
- See who has signed and who hasn't (with status per member)

**Member capabilities:**
- See documents assigned to them
- Sign electronically (digital signature capture)
- View signed documents
- Guardian sees documents assigned to their child and can sign on their behalf

**Document types:**
- Waiver (liability)
- Code of conduct
- Photo/video release
- Custom form (intake, medical, registration)
- Any custom type the owner names

**Templates:** Pre-built templates for waiver, code of conduct, photo release — pre-filled with club name. Owner edits the template text.

**Data model:** See Document, DocumentSignature in schema above.

---

### 8. SETTINGS PAGE

Full settings page at `/dashboard/settings`. Sections:

#### Club Profile
- Club name, tagline, sport(s)
- Logo upload — **direct file upload from device** (stored to file storage, e.g. AWS S3 or Cloudinary)
- Primary + accent color
- Custom app name (Elite tier)
- Club URL/slug (with availability check)

#### Locations
- Add/edit/remove locations
- Each location: name, address, phone
- Mark one as default

#### Staff & Permissions
- List all staff members (role = OWNER or STAFF)
- Invite new staff by email
- Set role title (Coach, Manager, Front Desk, Volunteer, custom)
- Staff profile image upload (direct file upload)
- Granular permissions per staff member:
  - Members: view only / edit / full
  - Calendar & events: view only / edit / full
  - Messages: send only / full
  - Finances: hidden / view only / full
  - Documents: view only / edit / full
- Set pay rate (hourly or salary) per staff
- Set appointment price (for privates) per coach

#### Notifications
- Toggle: email me when a member joins
- Toggle: email me when a payment fails
- Toggle: daily summary email
- Toggle: push notifications (when mobile app is built)

#### Billing (existing page)
- Stripe Connect status (already built)
- ClubOS subscription plan (shows current tier, upgrade options)

#### Custom Fields
- Link to `/dashboard/settings/custom-fields` (already built)

#### Danger Zone
- Transfer ownership
- Delete club (requires typing club name to confirm)

---

### 9. IMAGE & FILE UPLOADS

**Rule: All image and file imports in ClubOS use direct file upload from the user's device. Never use URL-only inputs for images.**

This applies everywhere:
- **Club logo** — Settings → Club Profile
- **Member profile picture** — Member profile page
- **Staff profile picture** — Staff profile / Settings → Staff
- **Event image** — Event create/edit form
- **Product image** — Products page
- **Message attachments** — Files, images, or documents attached to messages

**Implementation guidance:**
- Use `<input type="file" accept="image/*">` for image-only fields
- Use `<input type="file">` (no restriction) for document/file attachments in messages
- Files are uploaded to file storage (AWS S3 or Cloudinary) and the URL is saved to the database
- Show a preview of the uploaded image before saving
- Show upload progress for larger files

---

### 10. BANK INTEGRATION (Plaid)

**Purpose:** Pull in real bank transactions to give owners a complete financial picture — not just Stripe payments, but all cash flow (bank transfers, cash payments, expenses).

**What it does:**
- Owner connects their business bank account via Plaid Link
- ClubOS pulls in transactions (income + expenses)
- Transactions are categorized automatically
- Appears in Financials dashboard alongside Stripe transactions
- Owner can manually categorize any transaction

**Plaid integration flow:**
1. Owner clicks "Connect bank" in Settings → Billing
2. Plaid Link opens (OAuth-style browser popup)
3. Owner selects their bank, logs in
4. Plaid returns `access_token` → stored encrypted on Club record
5. ClubOS syncs transactions daily (or on demand)

**Data model:** See PlaidTransaction in schema above.

**Tier availability:** Growth+ (basic), Pro+ (full categorization + reports)

---

### 11. EXPORTS

Every major data section supports export. Export is available from a button in the relevant dashboard page.

**Export formats:**
- **CSV** — universal spreadsheet import
- **Excel / XLSX** — formatted spreadsheet
- **PDF** — printable report

**Exportable sections:**

| Section | What's exported |
|---------|----------------|
| Members | All member records (name, email, status, membership, tags, custom fields) |
| Athletes | Athlete-specific view (includes guardian info for minors) |
| Families / Guardians | Guardian profiles with linked athletes |
| Attendance | Attendance records (member, session/event, date, status) |
| Payments | All completed transactions |
| Subscriptions | Active/canceled subscription records |
| Payouts | Stripe payout history to club bank |
| Failed Payments | Failed/past-due payment records |
| Products | Product list with inventory and pricing |
| Events | Event list with dates, capacity, registration count |
| Privates | Private lesson bookings and revenue |
| Financial Reports | Summary P&L, revenue by category, platform fees |

---

### 12. UI DESIGN UPGRADE (when to do it)

**Answer to "when does it look good?":**

Right now the dashboard uses raw Tailwind utility classes — functional but plain.

**The UI upgrade happens in two phases:**

**Phase 1 (next major milestone):** Polish the dashboard after core features are all functional. This means:
- Proper typography scale (larger headings, better spacing)
- Sidebar gets the ClubOS brand treatment (dark sidebar with logo)
- Cards get depth (subtle shadows, better borders)
- Color-coded status badges done properly
- Charts and data visualizations on the financials page (use Recharts)
- Empty states with illustrations (not just text)
- Loading skeletons instead of "Loading…" text
- Proper mobile responsiveness

**Phase 2 (before launch):** Marketing site (landing page, pricing page) gets full design treatment using Fraunces + Inter typography system, hero section, feature showcases, testimonials, pricing cards.

**Design tokens to use throughout:**
```
Primary: #534AB7 (purple)
Success: #1D9E75 (green)
Warning: #BA7517 (amber)
Danger: #A32D2D (red)
Background: #F5F3EE (warm off-white)
Surface: #FFFFFF
Border: #E7E5E4
Text: #1C1917
Muted: #78716C
Font display: 'Fraunces', serif (headings, numbers)
Font body: 'Inter', sans-serif
```

---

## What's Built

- [x] Authentication (signup, login, forgot/reset password, change password)
- [x] Multi-tenant club creation and onboarding wizard
- [x] Dashboard layout with sidebar navigation — **dark sidebar with purple active states**
- [x] Marketing landing page (`/`) — hero, features, pricing, footer
- [x] Members management (list, add, edit, soft-delete, tags, custom fields, status)
- [x] Minor/Guardian logic — email optional for minors, guardian section, sibling detection by email
- [x] Member export CSV (`/api/export/members`)
- [x] Member import (CSV bulk import at `/api/members/import`)
- [x] Member credits (`/api/members/[id]/credits`)
- [x] Custom field builder (text, email, phone, address, date, textarea, number, dropdown)
- [x] Memberships management (name, description, purchase options with billingPeriod)
- [x] Events management (types, member/non-member/drop-in pricing, capacity, publish dates)
- [x] Event types API (`/api/events/types`)
- [x] Event staff assignment (`/api/events/[id]/staff`)
- [x] Bookings (add/remove, auto-waitlist, auto-promote)
- [x] Classes & Schedule — API routes + dashboard page
- [x] Attendance tracking — API routes + dashboard page + export CSV (`/api/export/attendance`)
- [x] Messaging — DMs, groups, API routes + dashboard page
- [x] Announcements — API + dashboard page (`/dashboard/announcements`) with email blast support
- [x] Documents & Forms — API routes + dashboard page
- [x] Products — API routes + dashboard page
- [x] Private lessons — types, packages, bookings API + dashboard page
- [x] Staff management — API routes (pay-rates, availability, exceptions) + dashboard pages
- [x] Discounts API, Expenses API
- [x] Club profile API — locations, notifications, donation-links, legal-entities, tier, info, profile
- [x] Plaid integration — link-token, exchange, transactions API routes
- [x] Member portal — signup, home, profile, bookings, documents (`/member/*`)
- [x] Settings pages — base, billing, club profile (`/dashboard/settings/*`)
- [x] ClubOS plan section on billing page — shows current tier + upgrade CTAs
- [x] Tier utility (`lib/tier.ts`) — features, limits, fee percents per tier
- [x] File upload API (`/api/upload`) — saves to `public/uploads/`, 10 MB max
- [x] Export CSV — members, attendance, transactions (`/api/export/*`)
- [x] Email system (`lib/email.ts`) — welcome, password reset, payment failed templates via nodemailer/SMTP
- [x] Reports + Calendar dashboard pages
- [x] Stripe Connect onboarding + status page
- [x] Stripe webhook listener
- [x] Member subscription + event charge via Stripe Checkout
- [x] Transactions/financials page
- [x] Role-based middleware + StripeRequiredBanner
- [x] Reset password page, PWA manifest + service worker

## What's NOT Built Yet

1. [ ] **Family / Guardian profile table** — Full separate Guardian entity (currently using inline fields on Member); sibling detection is in the UI but not a normalized DB model
2. [ ] **Image uploads wired to UI** — Upload API exists at `/api/upload`; needs to be connected to member profile photo, event image, product image, and club logo fields in each page's form
3. [ ] **Export XLSX / PDF** — CSV export done; Excel and PDF require additional packages (`xlsx`, `jspdf`)
4. [ ] **Announcements email blast** — API sends emails when `sendNow: true`; requires SMTP env vars to actually deliver
5. [ ] **Branded iOS/Android app** — Requires App Store/Play Store accounts, native development (Elite tier, not buildable here)
6. [ ] **Tier gating enforcement** — `lib/tier.ts` exists; limit checks not yet enforced in API routes
7. [ ] **ClubOS subscription billing (self-serve)** — Upgrade CTAs show; actual Stripe Checkout for ClubOS plans requires Stripe Price IDs in `.env`
8. [ ] **UI polish Phase 2** — Marketing site done; dashboard pages still use plain Tailwind (charts, skeletons, empty-state illustrations pending)

---

## Common Issues & Fixes

### "Module not found: Can't resolve 'stripe'"
Run `npm install` in `clubos/web/`, then restart dev server.

### Prisma WASM error / version mismatch
```bash
rm -rf node_modules
npm install
npx prisma generate
```
Make sure `prisma` and `@prisma/client` are both `5.7.0` in `package.json`.

### "Cannot find DATABASE_URL"
Prisma reads `.env`, NOT `.env.local`. Rename if needed.

### Next.js running v16 instead of v14
`next` must be pinned to `"14.2.35"` (no `^`) in `package.json`.
Delete any `package.json` or `package-lock.json` in the parent `clubos/` folder.

### Session lost after dev server restart
Normal in development. Just log back in. Sessions persist in production.

### Data wiped after `prisma db push`
`db push` and `migrate reset` wipe all data. Only run when schema changed.
Use `npx prisma generate` when only regenerating the client.

### 401 on API routes after data wipe
Sign up again — old JWT references a deleted club.

---

## Running Locally

```bash
cd /Users/cubano/Desktop/clubos/web
npm install
npx prisma generate
npm run dev

# Separate terminals:
npx prisma studio                          # DB browser at localhost:5555
stripe listen --forward-to localhost:3000/api/stripe/webhook \
  --forward-connect-to localhost:3000/api/stripe/webhook
```

**App:** http://localhost:3000
**Prisma Studio:** http://localhost:5555

---

## Owner Info

- **Mac username:** cubano
- **Project path:** `/Users/cubano/Desktop/clubos/web`
- **GitHub repo:** ClubOS
- **Stripe:** Test mode, Connect enabled
- **Database:** PostgreSQL local, database name `clubos`
- **Skill level:** Beginner coder — always give exact file paths, say CREATE vs REPLACE, explain what to run in Terminal step by step
