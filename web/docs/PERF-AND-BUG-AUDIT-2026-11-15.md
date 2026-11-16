# AthletixOS speed and bug audit (2026-11-15)

Branch `claude/athletixos-perf-app-audit-d31643`, cut from `main` at `9b0e72b`.
Everything marked **Fixed** is committed on that branch with a test that runs in
`npm run build`. Nothing is pushed, merged or deployed.

## 1. In plain English

**Why screens pause.** It is not the database. Production's own statistics show
every read finishing in under 13 thousandths of a second on average. The time
goes in three places:

1. **Doing things one after another.** The member portal's main data request
   made about 27 small database calls in a row, and each one is a separate
   network round trip. The staff member profile made a dozen in a row.
2. **Asking twice.** One page load asked for the same data two or three times
   from different parts of the screen.
3. **Waiting on Stripe.** The staff billing view called Stripe 7 times in a row
   for a one-child family and 20+ for a coach paying for a team.

On top of that, **every page fired many requests at once**, and on a quiet day
each extra simultaneous request has to wake up its own copy of the server
(a "cold start", about 3 seconds). That is why even trivial requests show a
3 to 5 second slow end in the numbers below.

**What was wrong beyond speed.** Two security problems (one fixed, one waiting
on your decision), several ways a double tap could count money twice, an email
race that sent duplicates and dropped recipients, and receipts that could fail
to send.

## 2. Measurements

### Before (production, Netlify, last 24 h on 2026-11-15)

"Typical" is the median. "Slow end" is the 90th percentile: one request in ten
is slower than this.

| Request | Used by | Calls | Typical | Slow end |
|---|---|---|---|---|
| `/api/member/portal` | every member portal page | 84 | 1.63 s | 5.46 s |
| `/api/members/[id]` | staff member profile | 16 | 2.0 s | 5.6 s |
| `/api/members/[id]/billing-admin` | staff billing view, approvals | 9 | 1.2 s | 4.0 s |
| `/api/member/schedule` | member schedule | 14 | 1.0 s | 5.1 s |
| `/api/member/events` | member events | 5 | 1.0 s | 4.8 s |
| `/api/members/[id]/membership-panel` | staff membership panel | 10 | 0.83 s | 2.6 s |
| `/api/dashboard/action-center` | bell + home card (3x per load) | 50 | 0.85 s | 2.6 s |
| `/api/member/messages/unread` | member layout, every navigation | 70 | 0.32 s | 3.7 s |
| `/api/member/consent` | member layout | 41 | 0.44 s | 3.5 s |
| `/api/member/club` | member layout + pages (2x) | 66 | 0.26 s | 3.5 s |
| `/api/auth/session` | every page | 138 | 0.19 s | 3.4 s |
| `/api/preview` | member layout, every navigation | 62 | 0.10 s | 3.0 s |
| `/api/me` | dashboard layout | 59 | 0.14 s | 0.84 s |

Database (Supabase `pg_stat_statements`): 379 members, 363 transactions, 1,629
attendance rows. Every `SELECT` averages under 13 ms. The one slow statement
was `DELETE FROM email_sends` at 1.6 s average, which turned out to be a bug
(finding R2), not a missing index.

Build: `/dashboard/members` 302 kB first load, `/dashboard/communication/templates`
263 kB, `/dashboard/reports/imports/[batchId]` 236 kB; most routes 110 to 125 kB.

### After

**I cannot give you production "after" timings until this branch is deployed**,
because I do not deploy. What I can state exactly is what each request now
does, which is what the timing follows from:

| Screen / request | Before | After |
|---|---|---|
| Member portal page load | portal x2, club x2, preview + unread on every navigation | portal x1, club x1, preview once per visit |
| `/api/member/portal` | ~27 database round trips in one chain | two parallel chains; 2 duplicate queries removed |
| Staff member profile | 12 stages one after another | 3 stages (7 blocks run together) |
| Staff billing view (Stripe) | 7 sequential Stripe calls (one child), 20+ (team payer), opened twice per profile | each customer read once, all in parallel, one request per profile, 8 s cap |
| Approvals list | full Stripe read per waiting card | database-only read per card |
| Parent billing card | up to 4 Stripe calls per athlete, in sequence | 2 in parallel per athlete, shared customers read once, 4 s cap |
| Dashboard home | whole roster + every event ever + 3x action-center | 5 members, 5 events, 1x action-center; cards load independently |
| Member home announcements | every announcement, one write each | 3 announcements, 2 writes total |
| Staff roster | 7 queries in sequence | 3 stages |

**How to read the real numbers after you deploy:** Netlify → the `athletix-os`
project → Observability → sort URLs by duration, and compare against the
"Before" table. I can also re-pull the same table for you on request.

### Two infrastructure settings worth checking (they could matter more than any code)

Each database call costs roughly 50 to 70 ms in production, which is slow for a
server and a database that should be in the same building.

1. **Netlify Functions region.** Supabase is in `us-east-2` (Ohio). In Netlify:
   Project configuration → Build & deploy → Functions region. If it is not
   `us-east-2`, changing it could cut every request by more than half.
2. **`connection_limit` in the Netlify `DATABASE_URL`.** If it says
   `connection_limit=1`, every "run these together" in the code still runs one
   at a time. The local `.env` has no such setting; I could not see Netlify's.
   Tell me what both say and I will advise.

## 3. Findings

Severity: **Critical** = data exposure or money counted wrong. **High** = a
family or staff member sees something broken. **Medium** = slow or confusing.
**Low** = polish.

### Security

| # | Where | What a person could see or do | Severity | Status |
|---|---|---|---|---|
| S1 | 39 handlers under `app/api/` (list in `scripts/staff-route-role-guard.ts` history; includes `export/members`, `members`, `members/[id]`, `attendance/*`, `export/transactions`, `export/attendance`, `discounts`, `messages/groups`, `events/[id]`) | Any signed-in parent or athlete could call staff data routes directly and download the whole roster: every family's emails, phones, birthdates, addresses and guardian contacts, minors included. The pages were hidden; the data routes were not. Self-signup needs only a club link, so this was open to anyone. | **Critical** | **Fixed** (`98afd7a`). New `requireStaff()` on all 39. Build fails if a staff route lacks a role check. |
| S2 | `app/api/member/signup/route.ts`, `lib/memberLink.ts`, `lib/guardianLink.ts` | Signing up with someone else's email (no email check) claims that person's member profile and gets confirmed guardian access to every child listing that email. Works for any family that has not created a login yet (193 "Invited" members today). | **Critical** | **Not fixed. Needs your decision** (section 4). |
| S3 | `app/api/upload`, `app/api/files/[id]`, `app/api/public/club-logo/[clubId]` | A member could upload an SVG image containing a script and send its link to an owner; opened directly it ran with the owner's login. The public logo route served such files with no login at all. | **Critical** | **Fixed** (`98afd7a`). Non-photo files are forced to download inside a sandbox. |
| S4 | `app/api/files/[id]` | A member who obtained a file link could open a contractor's W-9 or a books attachment. | High | **Fixed**. Tax forms, receipts and books attachments never go to a member login. |
| S5 | `app/api/member/privates/search-partners` | Any member could search the roster by email fragment and see other families' emails. | Medium | **Fixed**. Names only. |
| S6 | `app/api/messages/dm/[userId]` POST | A member could post through the staff messaging route, bypassing the parental messaging controls. | High | **Fixed**. Staff only; the portal already uses its own route. |
| S7 | `lib/baseUrl.ts` | Links in emails trust any `*.netlify.app` host header. Only exploitable if Netlify forwards a forged header, which I could not verify. | Medium | **Left**. Needs a test against a deploy preview before changing; a wrong fix breaks every emailed link. |
| S8 | `app/api/member/consent/route.ts` | Parental consent accepts a guardian link that is still pending. | Medium | **Left on purpose** (already in OPEN-TASKS; tied to the COPPA switch decision). |
| S9 | `/api/cron/*` accept the secret as `?key=`; password reset tokens stored unhashed; a password reset does not sign out other devices | Low | **Left**. Each is a small hardening change that deserves its own review. |
| S10 | Staff routes that admit any staff member regardless of their permission set (the 39 above now require staff, not a specific permission) | A coach with "members: none" can still read member lists through the API. | Medium | **Left**. Choosing a permission per route can lock real staff out mid-season; it needs your mapping, as the existing guard file says. |

### Speed

| # | Where | Symptom | Severity | Status |
|---|---|---|---|---|
| P1 | `app/api/members/[id]/billing-admin/route.ts`, `lib/payerWallet.ts`, `lib/paymentMethodsAdmin.ts` | Member profile and billing view hang 2 to 10 s on Stripe | High | **Fixed** (`330e26f`) |
| P2 | `components/members/MembershipPanel.tsx`, `PaymentMethodsCard.tsx`, `app/dashboard/members/approvals/page.tsx` | The same Stripe-heavy read fired twice per profile and once per approval card | High | **Fixed** |
| P3 | `app/dashboard/page.tsx`, `app/api/members/route.ts`, `app/api/events/route.ts` | Dashboard home waits on the whole roster and every event | High | **Fixed** |
| P4 | `app/api/member/billing/route.ts`, `app/api/member/auto-renew/route.ts`, `lib/memberCard.ts` | Parent profile waits on Stripe per child, with no time limit | High | **Fixed** |
| P5 | `app/api/member/portal/route.ts` | Every member page waits 1.6 s | High | **Fixed** (partly: see P12) |
| P6 | `app/api/members/[id]/route.ts`, `lib/membersQuery.ts` | Staff profile 2 s; roster slow on every keystroke | High | **Fixed** |
| P7 | `app/member/layout.tsx` and member pages | Duplicate requests on every page; one wasted request per navigation | Medium | **Fixed** |
| P8 | `components/NotificationBell.tsx`, `ActionCenterWidget.tsx` | Action center fetched 3 times | Medium | **Fixed** |
| P9 | `app/api/member/announcements/route.ts` | Home page downloads every announcement and writes once per announcement | Medium | **Fixed** |
| P10 | no `loading.tsx` / `error.tsx` anywhere | A tap shows nothing until the next screen is ready; a crash white-screens the whole app | High | **Fixed** for dashboard and member portal |
| P11 | `app/dashboard/layout.tsx` | Blank "Loading…" page on every hard load; staff briefly (or permanently, on error) see the owner menu | High | **Fixed** |
| P12 | `app/api/member/portal/route.ts`, `app/api/member/schedule/route.ts` (644 lines), `app/api/member/events/route.ts` | Still several round trips each | Medium | **Left**. A real fix is one bootstrap request for the whole portal shell; that is a bigger change I would do with the app work (the native shell needs the same thing). |
| P13 | Six pickers load the full roster through the old `/api/members` (`attendance/page.tsx:938`, `privates/page.tsx:1656`, `messages/page.tsx:899`, `members/[id]/page.tsx:1926`, `SellModal.tsx:43`, `AddAttendeeForm.tsx:67`) | Slow open on each | Medium | **Left**. Each picker reads different fields; needs a slim endpoint per shape. |
| P14 | `app/api/events/[id]/registrations/route.ts:86` charges due cards and sends reminders inside a page load | The Attendees screen can take seconds when a charge is due | Medium | **Left: your call.** The hourly job now exists, so this could be removed, but it changes *when* a card is charged (up to an hour later). |
| P15 | `app/api/messages/dm/route.ts`, `app/api/member/messages/route.ts` load every message ever to build the list | Fine today (50 messages), will slow as history grows | Low | **Left**. Needs pagination design. |
| P16 | `lib/actionCenter.ts` runs ~30 queries at once | 0.85 s typical | Medium | **Left**. Now fetched once instead of three times; collapsing the queries is a larger rewrite. |
| P17 | `app/dashboard/financials/page.tsx` (2,436 lines, 12 tabs loaded up front), `communication/templates` (editor loaded up front) | Slowest dashboard routes to open | Low | **Left**. Split per tab with dynamic imports; safe but wide. |
| P18 | Missing indexes (`messages` by sender/recipient + date, `transactions` club + date, `attendance_records` member + date, and 8 more) | None today: tables are a few hundred rows and every read is under 13 ms | Low | **Left on purpose.** A migration now would buy nothing measurable. Revisit at roughly 10x the data. |
| P19 | `lib/stripe.ts` sets no timeout (Stripe's default is 80 s) | A stuck Stripe call can outlive the request | Low | **Left**. Read paths now have their own caps; a global timeout also affects charges and needs care. |

### Reliability and money

| # | Where | Symptom | Severity | Status |
|---|---|---|---|---|
| R1 | `app/api/stripe/webhook/route.ts` | If the first delivery of a payment was cut off mid-way, the retry stopped at "already recorded": money in, registration still "awaiting payment", no spot, no receipt | **Critical** | **Fixed** (`ba46894`): `createTransactionOnce` + 60 s limit |
| R2 | `app/api/cron/email-queue/route.ts`, `lib/sendClubEmail.ts` | A family gets an announcement twice; the rest of the list gets nothing; the announcement sticks on "Sending" | **Critical** | **Fixed** |
| R3 | webhook `safeAsync` | Receipts, booking confirmations and "card declined" notices sent late or never | High | **Fixed** (awaited) |
| R4 | `app/api/members/[id]/offline-payment/route.ts` | Double tap on "Record payment" extends paid-through by two periods for one payment | High | **Fixed** |
| R5 | `app/api/approvals/private-package-purchase`, `membership-purchase` | Double tap on Approve grants double lesson credits or two memberships | High | **Fixed** |
| R6 | `financials/page.tsx` Mark paid, `staff/payouts/page.tsx`, announcements Send now, events Duplicate, staff Setup link | Double tap does it twice | High/Medium | **Fixed** (`useSingleFlight`) |
| R7 | webhook returns 200 on every error | A temporary database blip during a payment event is never retried | High | **Left: needs a decision.** Returning an error makes Stripe retry for 3 days; safe only now that R1 is fixed, but I want you to see it before I change how Stripe retries. |
| R8 | `app/api/attendance/charge/route.ts` | A second submit of "Cash $20" writes a second $20 row | High | **Left: your call.** Is charging the same attendee twice in one class ever real? If no, I add a claim. |
| R9 | `app/api/events/[id]/charge/route.ts:296` (cash at the door), `events/[id]/comp/generate-payouts` | Double tap books cash twice / creates two payout records | High | **Left**. Same claim-first fix; each touches a money path I did not have time to trace end to end. Next on the list. |
| R10 | An announcement cut off mid-send stays "Sending" forever with no retry | High | **Partly fixed** (R2 removes the main cause). A recovery sweep is still needed. |
| R11 | `announcements/route.ts` legacy send, `members/migration/send` (150 at a time), `events/[id]/bill-registrants` loop with no time limit | Large sends can be cut off part-way | Medium | **Left**. Needs batching with a "remaining" count. |
| R12 | Last event spot can be sold twice (`public/events/[slug]/register`); class capacity is not enforced on member booking | Medium | **Left: your call** (enforcing capacity changes who can book). |
| R13 | Private-lesson credit can be used twice on a double accept; product stock can oversell | Medium | **Left**. |

### Dates and timezones

Frog Empire's timezone is set (`America/New_York`); the three other clubs have none.

| # | Where | Symptom | Severity | Status |
|---|---|---|---|---|
| D1 | `lib/discounts.ts:63` | A code that "expires Nov 15" stops working at 7 pm on Nov 14 | High | **Left: your call.** Does "expires the 15th" include the 15th? Changing it changes what families pay. |
| D2 | `lib/reportsRange.ts` vs date-only money | An expense dated the 1st lands in the previous month's report | High | **Left**. Report-boundary change; no amounts move, but every monthly figure shifts, so you should see it first. |
| D3 | `lib/email.ts:421`, `:911`, check-in page | Event emails print UTC times: a 6:00 pm event emails as "11:00 PM" | High | **Left**. Fixable with the club timezone; touches every event email template, next on the list. |
| D4 | `app/api/dashboard/summary/route.ts`, `app/api/attendance/route.ts` | Today's evening class drops off the dashboard at lunchtime; a 7:30 pm event shows under tomorrow | Medium | **Left**. Next on the list. |
| D5 | `lib/parentalControls.ts:184` | A minor's daily spending limit resets at 7 pm | Medium | **Left: your call** (changes what a minor can spend). |
| D6 | `lib/memberStatus.ts:170`, `lib/chargeDate.ts` | Manual memberships end, and scheduled charges fire, at 7 pm the evening before the date shown | Low | **Left: your call** (charge timing). |

### Screens that can get stuck or misbehave

| # | Where | Symptom | Severity | Status |
|---|---|---|---|---|
| U1 | 25 internal `<a href>` links; `components/NativeDeepLinks.tsx`; attendance "open event" | Full app reload where a tap should be instant | High | **Fixed** (`1dae831`) |
| U2 | `100vh` / `min-h-screen` in 67 files | Bottom of the page and the message box hidden under phone browser bars | High | **Fixed** |
| U3 | 10 pages where a failed request leaves "Loading…" forever or crashes (`settings/email`, `products/[id]/tags`, `reports/imports/*`, `ReceiptsTab`, `ReconcileTab`, `settings/page.tsx:1272`, `settings/member-form`, `MemberModals.tsx:1427`) | Stuck spinner, or a white screen | High | **Partly fixed**: a crash is now contained by the new error screens. The per-page fixes are left for the app's "feels native" slice. |
| U4 | ~60 places where a dropped connection leaves a spinner forever | Common on a phone | Medium | **Left** for the same slice: one shared fetch helper plus a Retry state. |
| U5 | 78 browser `alert()` / `confirm()` / `prompt()` dialogs, including ones that guard a card charge | Blocks the screen; titled with the web address; Apple reviewers look for these | Medium | **Left** for the app work (planned slice). |
| U6 | 246 places with text under 12 px (115 in the member portal) | Hard to read on a phone | Low | **Left** for the app work. |

## 4. The decision I need from you (S2)

Today, creating a portal account does not check that you own the email you
typed. If the email matches a member record or a child's guardian email, the
new account is connected to it immediately. That is what makes onboarding easy,
and it is also what lets a stranger claim a family.

Options:

1. **Verify the email first (recommended).** After signup, we email a link.
   The account works straight away for anything that does not depend on the
   match, and the member profile and children connect when the link is
   clicked. One extra step for families, on first signup only.
2. **Send matches to your Approvals queue instead of connecting them.**
   No change for the family, but you approve each one by hand.
3. **Leave it** and accept the risk for now.

Activation links you send from the migration tool are not affected either way:
those already prove the email.

## 5. What was not audited

Read in full: the hot request paths, about 80 API handlers, the layouts, the
webhook's payment branches, the crons. Triaged by script only: the remaining
~380 handlers. Not covered: `lib/stripeSync.ts` internals, payroll math,
accounting (GL) routes, the import pipeline, PDF/CSV export memory use, and
bulk price-change apply. Timezone findings D2, D4, D5 and race findings R9,
R12, R13 came from a second reader and I did not re-verify each line.
