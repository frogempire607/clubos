# Handoff: Event editor + Attendees redesign (AthletixOS / clubos)

## Overview

Replaces the club-owner **Edit event** modal and the split **Bookings** / **Registrations** modals in `web/app/dashboard/events/page.tsx` with:

1. **One-scroll collapsible event editor** where every collapsed card states its own answer, every option set is universal across event types, and mutually exclusive settings disable each other with a visible reason.
2. **Per-session pricing** — an event has a whole-event price and, optionally, a price per session; families buy the bundle or individual days. This replaces the `dropInFee` field.
3. **One Attendees list** that merges `Booking` (the roster) and `EventRegistration` (the money) into a single table, keeping the pattern the owner already liked from the Registrations modal (Collect payment block, status pills, inline cash/check recording).
4. **Event row treatments** that surface outstanding money in the list instead of hiding it behind a Bookings tab.

### Problems it fixes (all observed in the current code)

| Problem in `page.tsx` today | Resolution |
| --- | --- |
| Payment method asked 3×: `payMethods` checkboxes, `approvalIntent` select ("How registrants pay if approved"), and `BookingsModal`'s own `payMethod` select | Asked once, in **How people pay**. Approval no longer has its own payment question; Bookings inherits the event's methods |
| Price asked 2×: the Pricing grid + `publicPricingOption` ("Which price does the public link charge?") | `publicPricingOption` deleted. The public link states which price it uses; there is no second setting to keep in sync |
| `variableCostEnabled` (split cost) can be on while `memberPrice`/`nonMemberPrice` are set | One **pricing model** radio: Free / Fixed price / Split a shared cost. Picking one retires the others' fields |
| `approvalIntent = APPROVAL_CHARGE` can coexist with `payMethods` containing `CARD` | Turning on "charge their saved card when I approve" disables "Card at signup" with the reason inline |
| `visibility`, `purchaseAccess` and `publicRegistration` are three controls describing one decision | One **Who can sign up**: Members only / Members + public link / Staff adds people |
| Participant category + coach approval render only for `TOURNAMENT` (or custom types with a policy) | Universal. Participant category is simply the first signup question; approval is a toggle on every type |
| Sessions carry no price — a 6-session camp is one $200 line | Per-session prices, with a bundle-vs-à-la-carte comparison line |
| `Booking` and `EventRegistration` are separate tables with separate modals; cancelling a booking leaves the invoice alive (see the `registrationKept` warning in `handleRemove`) | One Attendees list. Adding books the spot **and** the bill; removing does both |
| "Bookings" is never defined anywhere in the UI | The word is gone. "Attendees" with a money column per person |

## About the Design Files

The files in this bundle are **design references created in HTML** — prototypes showing intended look and behavior, **not production code to copy**. `Event redesign.dc.html` is a self-contained streaming-template prototype (its own tiny runtime, `support.js`); the markup is inline-styled and the logic is one class with a `renderVals()` method. Do not port that structure.

The task is to **recreate these designs inside the existing clubos environment** — Next.js App Router, React client components, Tailwind v4 with the `@theme` tokens in `web/app/globals.css`, `lucide-react` icons — following the patterns already in `web/app/dashboard/events/page.tsx` and `web/components/`. Every colour in the prototype is a literal copy of a token defined in `globals.css`; when you implement, go back to the token (`bg-app-bg`, `text-text-muted`, `border-app-border`, `bg-brand`, `var(--color-warn-surface)`, etc.) rather than pasting the hex.

Open the prototypes by opening the `.dc.html` files in a browser (they need `support.js` beside them). The canvas pans and zooms; the five options are labelled `1a`–`1e`.

## Fidelity

**High-fidelity.** Final colours, type sizes, spacing, copy and interaction rules. Recreate pixel-perfectly using the codebase's existing Tailwind tokens and component conventions. The prototype is interactive: the exclusion rules, validation, filtering and derived copy all really run, and are the specification.

`Current screens (recreated).dc.html` is a faithful recreation of **today's** UI (option `0a`–`0c`), included as the before/after baseline. Do not implement it.

---

## Screens / Views

### 1. Event editor — phone (`1a`)

**Purpose:** create or edit any event type. Replaces `EventModal`.

**Layout:** full-height sheet, 393px reference width. Fixed header (nav row + subtitle), scrolling body `padding: 14px; display: flex; flex-direction: column; gap: 10px`, fixed footer. Body cards must be `flex: none` — as flex children with `overflow: hidden` they otherwise collapse below their content.

**Header:** `Cancel` (14px, brand) / `Edit event` (16px, 600) / `Save` (14px, 600, brand), then a centred 11.5px muted subtitle: `{event name} · {date range} · {n} signed up`.

**Cards.** Each is `background #FFFFFF; border 1px solid #E5E7EB; border-radius 14px`. Header row `padding: 14px 16px`, tappable: title 15px/20px 600 `#111111`, summary 12px/16px `#6B7280`, right-aligned action `Edit` / `Hide` 11px brand. Body `padding: 0 16px 16px; gap: 14px`.

| Card | Collapsed summary (derived) | Contents |
| --- | --- | --- |
| Basics | `{Type} · {name} · cover photo set` | Name input; type chips (Clinic / Camp / Tournament / Other / Open mat); a tournament-only inset asking "Who is running it?" (We're hosting / We're attending — **attending sets the pricing model to Split**); cover photo (72px preview + Choose photo); description |
| Schedule & sessions | `{date range} · {n} sessions · priced individually`, or `Needs a fix — check the dates` | Starts + Ends `datetime-local`, **stacked** (a native datetime input's min-content width is ~229px, so two per row overflow a 314px column); validation; session list |
| Money | `Member $200 · Non-member $225 · sessions from $20`, or `Split $500 ≈ $41.67 each · invoiced after the event`, or `Free — nobody is charged` | Pricing model cards; per-model fields; "Sell individual sessions" switch; memberships that cover it |
| How people pay | `card now · saved card Aug 19 · check-in blocked until paid` | 4 method rows; saved-card date; block-check-in switch; plain-language preview line |
| Who signs up, and how | `Members + public link · coach approves · 2 questions` | Who-can-sign-up cards; public link box; signup questions; approval block |
| Capacity, dates & policy | `50 spots · waitlist on · payment due Aug 20` | Capacity, payment due date, waitlist switch, cancellation policy |
| Staff on this event | `Julian Ramirez, Sal Jones · payroll follows the roster` | Staff chips |

**Session row (collapsed):** name 13.5px/18px 500; below it a 11.5px muted computed range (`Fri 5:00 – 7:00 PM`) followed by an `Edit time` link; on the right, when per-session pricing is on, `$` + a 58px right-aligned number input. Rows divided by `1px solid #F1F1F3`.

**Session row (expanded, one at a time):** background `#FAFAFB`; name text input + `Done`; `Session starts` and `Session ends` datetime-locals; inline error when end ≤ start; `Price for this session` row.

**Pricing model cards** (`Free` / `Fixed price` / `Split a shared cost`), stacked, `text-align: left; padding: 12px 14px; border-radius: 12px`. Selected: `border #6D5DF6; background rgba(109,93,246,.07); color #5948E8`. Unselected: `border #E5E7EB; background #FFFFFF; color #111111`. Label 14px/18px 600, sub 11.5px `#6B7280`.

- **Fixed:** Member price + Non-member (2-col grid); "Sell individual sessions" switch row.
- **Split:** Total cost + Expected signups; derived per-head line in an info panel; **"When does everyone get invoiced?"** → `After the event` (default, "the day after it ends") or `On a date I pick` (reveals a date input); note explaining what happens; a dashed lock panel: "Member & non-member prices are off while the cost is split…".
- **Free:** dashed lock panel only.

**Payment method row:** `padding: 12px; border-radius: 12px; border 1px solid #E5E7EB` with a 24px checkbox (`border-radius: 7px`; checked `#6D5DF6` with a white ✓). Blocked state: `background #FAFAFB; border #EFEFF2`, box `#F4F4F6`/`#B6B8BE`, `cursor: not-allowed`, and the hint text replaced by the reason.

Methods: **Card at signup** ("Charged immediately; the spot is reserved once it clears."), **Saved card, charged later** ("Members with a card on file authorize it at signup."), **Cash at the event**, **Check at the event** (both "Registered now; staff records it at check-in.").

**Switch:** 44×26px pill, `#6D5DF6` on / `#D7D7DC` off / `#EFEFF2` blocked; 22px white knob with `0 1px 3px rgba(0,0,0,.25)`, `margin-left` 2px → 20px, `transition: margin .16s ease`.

**Approval block:** "A coach approves each signup" switch, then Responsible coach select and three checkbox rows — *Charge their saved card the moment I approve* (this is what disables Card at signup), *Let coaches propose a change*, *Hold a spot while reviewing*.

### 2. Event editor — desktop (`1b`)

900px card, header (title 20px/600 + 12.5px meta + Cancel/Save), then `grid-template-columns: 1fr 316px`.

- **Left:** seven "sentence cards" — an 11px 600 uppercase `#9CA3AF` kicker over a 14.5px/1.5 sentence stating the current answer, with an `Edit` link. Below them a conflict panel on `--color-warn-surface` that names any live conflict, or says "Nothing conflicts right now".
- **Right (`#FAFAFB`):** a live **What a family sees** card — cover, event name, computed date/session line, price rows (label left, value 600 right), an info note, and a CTA whose label follows state (`Request a spot` / `Sign up & pay` / `Sign up`). This is the only place a price appears twice, deliberately.

### 3. Attendees — desktop (`1c`)

**Purpose:** the merged roster + money screen. Replaces both `BookingsModal` and `RegistrationsModal`.

1120px card. Header: `Attendees · {n}` + `{event} · {dates} · {n} spots left · /e/{slug}`; actions Export / Check-in mode / **+ Add attendee**.

**Explainer + tiles** on `#FAFAFB`: one line stating the merge, then 4 tiles in a `repeat(4,1fr)` grid — Collected, Outstanding (warn-tinted), Scheduled, Waiting on you (brand-tinted). Label 11px 600 uppercase, value 20px 700 tabular, sub 11.5px.

**Add attendee** (expands under the header, brand-tinted): `Who` (member search or new name), `Taking` (whole event / a session subset / pick sessions), `Paying by` — options **inherited from the event**, with a note saying so — and an Add button.

**Filter chips:** All / Owes money / Waiting on you / Card scheduled / Settled, each with a live count; they really filter the list.

**Collect payment panel** (shown only when someone owes): title 15px 600, 12.5px explanation, right-aligned unpaid count + total, then `Email payment link to all unpaid (n)` (brand), `Email selected (n)` (disabled until a selection), `Record cash for selected`.

**Table:** `grid-template-columns: 26px 1.5fr 1.6fr .7fr 1.2fr .8fr 1.5fr; gap: 12px` — the header row must use the same track list. Columns: checkbox, Name (+ source chip `Member`/`Public` and a note), Contact (recipient email + phone), Weight (the participant-category value; the header label follows the event's own category label), Attending (`Whole camp` / `Saturday only` + `2 of 6 sessions`), Owes (14px 600 tabular, right), Status (pill + inline actions).

Status pills use the `globals.css` semantic pairs: `Awaiting cash` warn, `Paid $205.80` success, `Card charge Aug 19` pending, `Waiting on you` info/brand, `Covered by {plan}` chip. Inline actions: `Record: cash · check`, `Resend receipt`, `Charge now`, `Approve · Propose · Decline`.

Footer: `Showing all {n} · Show n removed attendee` and `Outstanding {x} of {total}`.

### 4. Attendees — phone (`1d`)

393px. Sticky money bar (Collected + Outstanding tiles), the primary email-links button, a horizontally scrolling filter strip, then one card per attendee: 36px initials avatar, name 14.5px 600, source chip + `{category} · {attending}`, right-aligned amount 15px 700 with a small note, then status pill + action link.

### 5. Event row — three treatments (`1e`)

All 820px, all reading from the same event data.

1. **Money-first row** — 58px date pill (`AUG / 21 / FRI`), title + type chip + `${x} to collect` warn chip, meta line (`{time range} · {n} sessions, from ${x} · {staff}`), a 7px segmented capacity bar (settled lime / owe orange / scheduled pending / review brand, each `count / capacity`), the counts on their own line below the bar, and a right column: `Attendees · {n}` (brand) over `Edit` + `⋯`.
2. **Compact row** — 64px date cell (month + start day, one line) + time, a 3px type rule, name + type/session note, money summary, right-aligned `{n}/{capacity}` and `${x} to collect`, then `Attendees` + `⋯`.
3. **Cover-photo card** — 190px cover, uppercase kicker (`{long date range} · {type}`), 19px title, money line, right-aligned `{n}/{capacity}` + amount, a pill row (`{n} settled`, `{n} owe at the door`, `{n} waiting on you`, `Public link on`), then `Attendees · {n}` / `Edit` / `⋯`.

---

## Interactions & Behavior

**Exclusion rules — the losing control is disabled with its reason, never silently ignored.**

1. Pricing model is a single choice; Split replaces the member/non-member inputs with a lock panel.
2. Tournament "We're attending" sets the model to Split (entry fees, hotel, travel divide across signups); "We're hosting" sets Fixed.
3. `Charge their saved card the moment I approve` → `Card at signup` becomes disabled ("Off — a coach approval can't charge a card up front too. Uncheck 'charge on approve' to re-enable."), and the desktop conflict panel says "One rule is doing the work of two".
4. Split or Free → the whole payment-method list is replaced by a lock panel ("Payment methods are off because the cost is split — everyone is invoiced after the event, from the Attendees list." / "This event is free, so there is nothing to collect.").
5. A covered membership means those members pay $0 and skip payment entirely — stated in the Money card and in the family preview.
6. `Staff adds people` → no public link, no self-booking, stated in a lock panel. `Members + public link` is the only state that shows the link box.

**Validation**

- Event: end ≤ start → the Ends field gets `border #B91C1C` + `box-shadow 0 0 0 3px rgba(185,28,28,.12)`, an error panel appears (`#FEF2F2` / `rgba(185,28,28,.22)` / `#B91C1C`, 11.5px 500) reading `Ends before it starts. Pick an end after {formatted start}.`, and the collapsed card header changes to `Needs a fix — check the dates`.
- Session: end ≤ start → red border on that session's end field, inline "This session ends before it starts.", and a rollup under the list ("1 session ends before it starts.").
- Bundle sanity: if the session prices total **less** than the whole-event price, say so ("à la carte totals $220, which is $55 cheaper than the $275 whole-event price — nobody has a reason to buy the bundle") rather than printing a $0 saving.

**Everything stated twice is derived, not typed.** One date range feeds the phone subtitle, Schedule summary, desktop subtitle, sentence card, family preview, Attendees header, both event rows' date cells and the split invoice default (`day after end`). One attendee ledger feeds the tiles, filter counts, capacity bar segments, row pills and every `Attendees · n` button. One price set feeds the Money summary, family preview, pay preview and all three event rows. Implement these as computed values from a single source; the three rounds of drift found in review were all hard-coded copies.

**Other behaviour:** one session expands at a time; filter chips filter; row checkboxes drive `Email selected (n)`; `+ Add attendee` toggles the inline form.

## State Management

Maps onto the existing `Event` model plus the changes below.

```
type, tournamentHostMode          // HOST | ATTEND, sets pricingModel
name, description, imageUrl
startsAt, endsAt                  // validated: endsAt > startsAt
sessions[]                        // { id, name, startsAt, endsAt, price }  ← price is new
pricingModel                      // 'FREE' | 'FIXED' | 'SPLIT'   ← replaces the implicit combination
memberPrice, nonMemberPrice       // FIXED only
sellIndividualSessions            // FIXED only; replaces dropInFee
splitTotal, splitExpectedSignups  // SPLIT only
splitInvoiceWhen                  // 'AFTER_EVENT' | 'ON_DATE'    ← new
splitInvoiceDate                  // when ON_DATE; maps to invoiceScheduledAt
coveredMembershipIds[]            // → pricingOptions
paymentMethods[]                  // CARD | AUTO_CARD | CASH | CHECK, one place only
autoChargeDate, requirePaymentBeforeCheckin
signupAccess                      // 'MEMBERS' | 'PUBLIC_LINK' | 'STAFF_ONLY'  ← replaces visibility + purchaseAccess + publicRegistration
publicFormIntro
signupQuestions[]                 // participant category is the first entry, any event type
requiresCoachApproval, responsibleCoachUserId,
  chargeOnApproval, allowProposedChanges, holdSpotDuringReview
capacity, waitlistEnabled, paymentDueBy, cancellationPolicyText
staffUserIds[]
```

**Deletions:** `publicPricingOption`, `approvalPaymentIntent`, `dropInFee`, `variableCostMode` (the invoice-date choice covers estimated-vs-official), and `BookingsModal`'s local `pricingType`/`payMethod`.

**Attendees screen:** one row type unifying `Booking` and `EventRegistration` — `{ id, source: MEMBER|PUBLIC, memberId?, name, recipientEmail, phone, categoryValue, sessionIds[], owes, status, actions }`. `status` reuses the existing `REG_STATUS_UI` vocabulary plus `COVERED`. Adding creates both roster and billing records; removing removes both — the current `registrationKept` warning should become impossible.

**Migration notes:** existing `dropInFee` → a single-session price (or `sellIndividualSessions = false` if sessions are unpriced); `variableCostEnabled` → `pricingModel = SPLIT`; `visibility`/`purchaseAccess`/`publicRegistration` → `signupAccess` (public link wins over members-only, staff-only wins over both); `approvalPaymentIntent = APPROVAL_CHARGE` → `chargeOnApproval = true` with `CARD` dropped from `paymentMethods`.

## Design Tokens

All from `web/app/globals.css` — use the token, not the hex.

**Brand & status:** `--color-primary` `#6D5DF6`, `--color-primary-dk` `#5948E8`, success/lime `#A3E635`, warning/orange `#FF6A00`, danger `#B91C1C`.
**Neutrals:** bg `#F7F7F9`, surface `#FFFFFF`, border `#E5E7EB`, text `#111111`, muted `#6B7280`, plus `#374151` (field labels), `#4B5563` (body), `#9CA3AF` (kickers).
**Semantic pairs:** warn `#FFF7ED` / `#B45309` / `rgba(180,83,9,.22)`; danger `#FEF2F2` / `#B91C1C` / `rgba(185,28,28,.22)`; success `rgba(163,230,53,.25)` / `#3F6212` / `rgba(63,98,18,.25)`; info `rgba(109,93,246,.06)` / `rgba(109,93,246,.25)`; pending `#EDEBFF` / `#4F46E5`; chip `#F1F1F3` / `#4B5563`; hairline `#F1F1F3`; table chrome `#FAFAFB`; inset `#F4F4F6` with dashed `#D7D7DC`.
**Selected surface:** `rgba(109,93,246,.07)`–`.1` on a `#6D5DF6` border with `#5948E8` text.

**Type:** Inter (as `web/app/layout.tsx` already loads). 20px/600 modal titles · 16px/600 phone title · 15px/600 card titles · 14.5px/600 names · 14px/20px inputs and primary rows · 13.5px session rows and desktop controls · 12.5px meta · 12px/16px 600 field labels and summaries · 11.5px hints · 11px 600 uppercase `.05–.07em` kickers · 10–10.5px 600 pills. Tabular numerals on every money and count value.

**Spacing:** 4 / 6 / 8 / 10 / 12 / 14 / 16 / 20 / 24px. Cards 14px gaps inside, 10px between. Inputs `padding: 11px 12px` on phone, `9px 11px` in dense desktop rows.

**Radii:** 14px cards · 12px inner panels and rows · 10px inputs and phone buttons · 9px desktop buttons · 7px checkboxes · 9999px pills, chips, switches, capacity bars.
**Shadows:** `0 12px 32px rgba(17,17,17,.14)` (`--shadow-overlay`) for sheets; `0 12px 32px rgba(17,17,17,.10)` for desktop cards.
**Bars:** capacity 7px tall on `#F1F1F3`; phone switch 44×26 with a 22px knob.

## Assets

None. Cover photos are striped placeholders (`repeating-linear-gradient(135deg,#F4F4F6,#F4F4F6 6px,#EDEDF1 6px,#EDEDF1 12px)` with a monospace label) — use the real `ImageUpload` component (`web/components/ImageUpload.tsx`). Icons in the prototype are text glyphs standing in for `lucide-react` icons already used in `page.tsx` (`Clock`, `Users`, `MapPin`, `CalendarRange`, `MoreVertical`, `X`); the phone status bar is scaffolding, not design.

## Files

| File | What it is |
| --- | --- |
| `Event redesign.dc.html` | The redesign. Options `1a` phone editor · `1b` desktop editor · `1c` Attendees desktop · `1d` Attendees phone · `1e` three event rows. Interactive — exercise the exclusion rules and validation here |
| `Current screens (recreated).dc.html` | Today's UI recreated from source (`0a` Edit event with every section open, `0b` event row, `0c` Bookings sheet) plus a list of what's wrong with it. Reference only |
| `support.js` | The prototype runtime. Must sit beside the two HTML files for them to open |

**Source files these were built from:** `web/app/dashboard/events/page.tsx` (`EventModal` ~677–1805, `BookingsModal` ~2187–2380, `RegistrationsModal` ~2963+, `REG_STATUS_UI`, the list card ~300–520), `web/app/globals.css`, `web/app/layout.tsx`, `web/components/ImageUpload.tsx`.
