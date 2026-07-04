# AthletixOS — Feature Batch — 2026-07-03 (evening)

Six tasks on branch `claude/nifty-bohr-975a5e` (commits `9b3f629` → `0c90f8f`,
one commit per task). **Two DB migrations were added and ALREADY APPLIED**
(`20260704000000_event_group_chat` — nullable `message_groups.eventId`;
`20260704010000_discount_applies_to` — `discounts.appliesTo` JSONB default
`[]` + backfill of plan-narrowed codes to `["MEMBERSHIP"]`). Deploy the code
whenever; the columns are live.

Verification per task: `npx tsc --noEmit` + `npm run build` (all clean).
Runtime-verified against a live dev server: the public iCal feed for Frog
Empire returns valid RFC 5545 with correct scope separation (PUBLIC 146
items < MEMBER 197 < STAFF 199 incl. private lessons), the embeddable HTML
calendar renders, and a wrong token 404s. Full owner/staff/client
click-through still needs a human pass — checklist below.

---

## 1. Event group chats (`9b3f629`)

One `MessageGroup` per event (`MessageGroup.eventId @unique`). Access follows
the **live registration**, not a fixed member list: `lib/eventChat.ts`
resolves eligible users from non-canceled `Booking`s + `EventRegistration`s,
including guardian logins of registered minors, and re-syncs junction rows on
every open. The member group-thread route re-checks registration on
event-linked groups — a newly-registered member auto-joins, a canceled one is
denied even with a stale junction row.

- Member entry points: **Event chat** button on registered event cards
  (`/member/events`) and on My Bookings event rows.
- Owner/staff: **Group chat** action on the events list (desktop row +
  mobile sheet) → deep-links to `/dashboard/messages?group=<id>` (new deep
  link support). Gated `messages:send`.
- Parental controls (`memberCanMessage`) and the 60/min rate limit apply.
- Also fixed in passing: the dashboard group thread GET/POST had **no role
  check** — a MEMBER session could read/post any club group by id. Now
  OWNER/STAFF only (members use their own membership-enforced route).

## 2. Auto-updating calendar links (`2e79328`)

Stateless HMAC-token feed URLs per scope (keyed on `NEXTAUTH_SECRET`, no
schema change, not revocable without a future seed column):

- `GET /api/public/calendar/[clubId]/[token]` — hand-rolled iCal
  (rate-limited, 30d back / 180d forward, hourly refresh hints).
- `/cal/[clubId]/[token]` — embeddable HTML list calendar (iframe-safe).
- Scopes: **PUBLIC** (public items only), **MEMBER** (public + members-only —
  exactly what the portal shows), **STAFF** (adds staff-only events, PRIVATE
  classes, confirmed private lessons *with athlete names* — labeled
  private in the UI).
- Owner: **Share / subscribe** modal on `/dashboard/calendar` (copy iCal /
  Add to Google / copy embed link / copy iframe snippet, per scope).
- Member: **Add to calendar** modal on `/member/schedule` (Google / Apple
  webcal / copy link).

## 3. Booking UX — Book Now / My Schedule / My Bookings (`0388c22`)

- **My Schedule** now pins **"Your upcoming schedule"** (booked classes +
  registered events for the selected athlete) on top, with **Find & book**
  below. The schedule feed includes events again
  (`INCLUDE_EVENTS_IN_SCHEDULE=true`) — the page's Events filter chip had
  been dead since 2026-06-04.
- **Book Now** (`/member/shop`, retitled from "Purchase Options") gains a
  **Classes** card → one discovery hub: classes, events, privates,
  memberships, shop.
- **My Bookings** repositioned as the manage surface (upcoming / history /
  requests / cancellations) with a link back to Book Now.

## 4. Client check-in from My Bookings + My Schedule (`90c081d`)

Reuses the QR flow's idempotent `POST /api/member/checkin/[id]` with two
semantic fixes:

- **Window**: check-in now opens 1 hour before start (server-enforced; QR
  scans were implicitly timely, a visible button isn't). Still closes 12h
  after end.
- **Booked ≠ arrived**: class self-booking no longer stamps `checkedInAt` at
  booking time; check-in stamps the existing roster row. Owner rosters now
  show a real arrival time. The QR landing page's "already checked in" state
  keys on `checkedInAt` too.
- UI: **Check in** button (→ green "Checked in" chip) on My Bookings
  class/event rows and My Schedule's pinned cards, only within the window.
  Guardians check in the selected athlete (validated server-side).

## 5. One athlete selector (`3d73865`)

The portal had two competing selector systems: the layout's shared
**Managing** bar (`lib/activeProfile`, localStorage-synced) and independent
per-page pill rows on Memberships ("Membership for"), Events ("Registering
for"), Products ("Buying for"), Privates — which did **not** sync.
`components/ProfileSwitcher.tsx` no longer renders buttons: it adopts the
shared selection, follows changes (so existing per-page refetch effects still
fire), and shows a one-line "for {athlete}" note. The Schedule page's
duplicate in-page "Athlete" row is replaced with the same note. The Managing
bar is now the single control everywhere.

## 6. Discounts everywhere (`0c90f8f`)

`Discount.appliesTo` lists covered purchase types — MEMBERSHIP / EVENT /
CLASS / PRODUCT / PRIVATE_PACK; `[]` = everything (default). Existing
plan-narrowed codes backfilled to MEMBERSHIP-only. New validator
`findValidDiscountFor(club, code, {type, membershipId?})`.

Wired: member class booking (input in the schedule modal; 100%-off books
directly), member event registration (page input; 100%-off registers
directly), member product buy (discounted unit price recorded on the
`ProductSale`), private pack buy (card **and** cash/check — the approval
queues the discounted total and the owner card shows the code, like
memberships already did). Stripe metadata carries `discountCode` everywhere;
`recordDiscountUse` fires at checkout/queue creation (same convention as the
membership flow). Owner modal gains an item-type "Applies to" chip row.

**Not wired (follow-ups):** public `/e/[slug]` checkout, owner at-door
charge forms, event bundles. Facility rentals / birthday parties inherit
PRODUCT scope automatically once their booking flow exists.

---

## Manual smoke checklist (needs a human)

- [ ] Event chat: register an athlete for an event → Event chat button on
      /member/events + My Bookings → thread opens; guardian of a registered
      child gets access; a NON-registered member gets "registered attendees
      only"; cancel the registration → thread 404s for them.
- [ ] Owner: Events → Group chat → lands in the thread on
      /dashboard/messages; staff without messages permission blocked.
- [ ] Calendar: /dashboard/calendar → Share/subscribe → paste the iCal link
      into Google/Apple → items appear; staff link shows privates, public
      link hides members-only items; embed iframe renders.
- [ ] Member: /member/schedule → Add to calendar → Google link opens
      subscribe flow.
- [ ] My Schedule: booked class shows under "Your upcoming schedule" with the
      rest under Find & book; Events filter chip now shows events.
- [ ] Check-in: within 1h of a booked class → Check in on My Bookings →
      green chip; owner attendance roster shows arrival time; retry says
      already checked in; a class next week shows NO check-in button.
- [ ] Guardian: Managing bar switch updates memberships/events/products/
      privates pages (labels show "for <child>"); no second toggle anywhere.
- [ ] Discounts: create a code scoped to Events only → applies on event
      registration, rejected on a class booking with a clear message;
      unscoped code applies everywhere; pack cash/check request with a code →
      approval card shows the code and the discounted amount.
- [ ] Regression: existing membership discount flow, QR check-in flow,
      cancel-booking flow, More sheet, badges.

## Known limitations / follow-ups

- Calendar feed tokens are not revocable (needs a per-club seed column to
  rotate).
- Event chats don't appear in a member's Messages list until first opened
  from an event surface (junction row is created lazily).
- Discount inputs are not on: public event checkout, owner at-door charge
  forms, event bundles.
- The bug-hunter review agent hit a session limit mid-run; the review pass
  was done manually (approval amount flow, ProfileSwitcher effect loops,
  schedule events branch, check-in semantics verified by hand).
