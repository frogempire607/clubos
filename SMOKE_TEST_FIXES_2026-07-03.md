# AthletixOS — Owner/Client Bug-Fix Batch — 2026-07-03

14 tasks from the 2026-07-02 smoke-test follow-up, fixed on branch
`claude/funny-yonath-aa2f7b` (commits `b852ef0` → `1c02007`, one commit per
task). **One DB migration was added and ALREADY APPLIED to the database**
(`20260703000000_member_trial_window`, additive nullable `members.trialEndsAt`)
— deploy the code whenever; the column is live.

Verification run per task: `npx tsc --noEmit` + `npm run build` (all clean),
plus a local runtime smoke of the public logo endpoint, the QR check-in API,
and the `/c/[id]` landing page. Full owner/staff/client click-through still
needs a human pass — checklist below.

---

## Owner side

### 1. Membership discounts actually apply (`b852ef0`)
The Discount model was CRUD-only — no code path ever validated or applied a
code. Now:
- `lib/discounts.ts`: shared validator (active / expiry / max-uses /
  membership scope; empty scope = ALL plans, the default) + price math +
  usage counting.
- Discount modal has an **"Applies to"** membership multi-select (default:
  all purchase options); the list shows each code's scope.
- Owner *Assign membership* modal: discount code field under advanced
  options; applied to the selected option's price on both the Manual and
  Stripe paths.
- Member subscribe: optional code field in the payment chooser. Card path
  prices Stripe checkout with the discount; **cash/check path carries the
  code into the approval queue — staff see "code X applied" on the card and
  approving accepts the discounted price** (re-validated at approve time;
  a dead code errors instead of silently activating).

**Test:** create a code scoped to one plan → apply on that plan (price drops),
apply on another plan (clear error). Cash/check subscribe with code →
approval card shows code → approve → sub + unpaid invoice at discounted price.

### 2. Onboarding tags standardized + chip styling (`b852ef0` + `0cdf710`)
Labels and filter already matched (Un-invited / Invited / Profile completed /
Completed). The ugly wrap ("Profile / completed" as two highlighted lines) was
chips rendered as bare inline spans — all status/onboarding chips on the
members list, member profile, and migration table are now
`inline-flex whitespace-nowrap`.

### 3. Free trial decoupled from a single membership (`fb9cac1`)
New membership-agnostic trial window `Member.trialEndsAt` (migration applied):
- Staff **Trial** check-in (attendance) auto-grants a 7-day window when the
  member has no active plan and no window running.
- Member portal: while the window is active, classes show **"Free trial"**
  and book free as TRIAL attendance — across multiple classes.
- The member can still subscribe to ANY membership at any time (trial is not
  tied to a plan). Member profile shows a "Free trial until <date>" chip.

**Test:** quick-add someone as Trial → log in as them → book 2+ different
classes free → subscribe to any membership normally.

### 4. Delete permissions (`c7f1293`)
Owners already bypass all gates and can delete members / privates / classes /
memberships / attendance. Audit of every DELETE route found three that let
staff with only `edit` delete — attendance hard-remove, discount codes, custom
event types — all now require **`full`**. Nothing was opened to lower roles.

### 5. Attendance quick-add asks for email (`64596bd`)
Phone field replaced with **Email** (required for adults). Minors now require
**guardian name + guardian email** — previously the form didn't collect
guardian email at all, so minor quick-adds always failed server-side with a
generic error. Server errors now surface verbatim.

### 6. Gating / permissions audit (`78aa23d`)
- Middleware `PATH_PERMISSIONS` covers every dashboard section (settings
  owner-only); OWNER bypasses; STAFF per-section.
- Sweep of all owner/staff mutation routes: no unguarded routes (flagged ones
  are self-service, token-gated public flows, or rate-limited uploads).
- Removed the inert `/api/members/onboarding-invites/bulk` stub.
- Member vs non-member gating verified for classes (accepted-membership
  eligibility), memberships (purchaseAccess), privates (see #9).

### 7. Attendance drop-in charge always reachable (`b443ea2`)
The charge flow only existed on quick-add *search* rows — once someone was on
the roster (after clicking Present/Trial/anything first), **Drop-In just
flipped status silently with no price/charge**. Clicking Drop-In on a roster
row now opens an inline charge form (amount prefilled from the class's drop-in
price; Cash/Check/Card/Comp/Invoice; "Mark only" keeps the old status-only
behavior). Quick-add pay panel now prefills the drop-in price first.

**Test:** roster → click Present on someone → click Drop-In → charge form
appears → record cash → Financials shows the transaction.

## Client side

### 8. Logo never renders as "?" (`cb7f842`)
- `/api/public/club-logo/[clubId]` falls back to the **AthletixOS default
  mark** (`/brand/circle.PNG`) whenever the club has no logo / file missing.
- `publicClubLogoUrl()` never returns null now.
- Fixed surfaces that leaked the session-gated `/api/files/...` path to
  logged-out contexts: **QR check-in landing** (`/c/[id]`, the screenshot
  bug), **public event page** (`/e/[slug]`), and the **guardian-invite,
  member-invite, and partner-invite emails**.
- Runtime-verified: unknown club → 307 → default mark (200 image/png);
  check-in API returns the public URL.

### 9. Privates member vs non-member visibility (`d5e275e`)
Option-level gating worked, but whole lesson types built for the other
audience (e.g. "One-on-One Non-Member", all options NON_MEMBER) still showed
to everyone as dead-end cards at base price. The type picker now hides types
with zero tiers the selected athlete can pick; switching athletes clears a
now-ineligible selection. Server enforcement unchanged.

### 10. Pack cash/check requests = complete + schedulable (`64379c6`)
- Request now **requires**: lesson type (validated against the pack's covered
  types), pricing option when the type has tiers, and ≥1 requested date+time;
  coach optional but validated. UI blocks incomplete requests with
  step-specific errors.
- **Approving** adds the credits + unpaid invoice (as before) AND creates
  credit-paid `PrivateBooking` requests from the requested slots (one per
  slot, capped at granted credits; PENDING_COACH when a coach was picked) —
  so the request shows on the owner's privates queue and the member's
  bookings immediately, and credits work through the normal confirm flow.

**Test:** member picks type/tier/slots → pack "Request with cash/check" →
approvals card → approve → credits + unpaid invoice + booking(s) visible on
both sides.

### 11. Client cancellations with refund review (`027d16e`)
New `POST /api/member/bookings/cancel`: members/guardians cancel upcoming
**class bookings** (roster record deleted; collected money stays in
Financials) and **event registrations** (Booking → CANCELED). Money never
auto-refunds — paid class spots and priced events DM the owner a
refund-review request and the member is told the refund is requested, not
automatic (same rules privates already had). My Bookings shows a **Cancel
booking** button on upcoming class/event rows.

### 12. Club profile reachable (`e1f4131`)
Two dead ends fixed: branded-nav clubs (like Frog Empire) had "More" mapped to
a plain profile link so the More sheet (News / Documents / Privates / **Club
profile** / Our team / Profile) never opened; and the desktop header rendered
More as a no-op `#more` link. More now opens the sheet everywhere (bottom
sheet on mobile, centered panel on desktop). Also fixed literal `&amp;` text
in sheet descriptions.

### 13 + 14. Badges: stable + independent (`c410afe`)
- The "Messages badge pops up and disappears": branded navs have no Messages
  tab, so the badge appeared on the default nav during first paint and
  vanished when the branded config loaded. **Messages now also lives in the
  More sheet with its own unread count**, and the More tab badge adds unread
  DMs only when the nav lacks a Messages link.
- Announcements badge: red count on the mobile More tab, the desktop More
  button, and the News row; opening News marks announcements seen and fires
  the refresh event that clears it everywhere. The two counts never mix at
  the row level.

---

## Manual smoke checklist (needs a human)

- [ ] Discounts: scoped code applies/rejects per plan; cash/check + code →
      approval shows code → discounted sub + invoice.
- [ ] Members page: no wrapped chips at narrow widths; onboarding filter works.
- [ ] Trial: attendance Trial check-in → member books 2 classes free → buys a
      membership.
- [ ] Attendance roster: Present → Drop-In → charge form; Remove needs
      attendance:full for staff.
- [ ] Quick-add minor: guardian name+email required; adult: email required.
- [ ] QR poster page `/c/<sessionId>` logged out: club logo (or AthletixOS
      mark) renders — no “?”.
- [ ] Emails (guardian invite / member invite / partner invite): logo renders.
- [ ] Privates: member sees only member-audience types/tiers; non-member the
      inverse; profile switch flips the list.
- [ ] Pack cash/check without type/tier/slots → blocked; complete request →
      approve → credits + invoice + booking on both sides.
- [ ] Member cancels class/event booking; paid → owner gets refund-review DM.
- [ ] More sheet on mobile + desktop opens with Club profile; badges show and
      clear independently (Messages vs News).
- [ ] Staff (Sal): everything they could do yesterday still works; deletes
      need `full`.
