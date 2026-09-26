# Handoff: Staff Profile (AthletixOS / ClubOS)

## Overview
Replace the cramped **Edit Staff** pop-up with a full **staff profile page** at `/dashboard/team/[id]`, built as a **sibling of the Member profile** (Members redesign `1c` desktop, `1j` mobile). Same shell, back link, identity header, next-action banner, tab bar, 2-column cards, locked block, tokens and type scale. Not a new style.

**The single most important rule: this is a re-layout, not new functionality.** Every control on these screens already exists somewhere in the staff area today (Staff directory cards, Edit Staff modal, Availability page, Schedule page, Payroll & Payouts). Move them onto one profile and wire them to the **same data, same API routes and same permission checks**. Do not change the permission model, pay math, availability model or schedule model.

The one behavioural addition: **a staff member can open their own profile and manage their own weekly hours and time off** (the same Schedule & availability tab the owner sees). See "Self-service" below.

## About the design files
`design/*.dc.html` are **design references written as HTML** — prototypes of look, copy and behaviour, **not production code to copy**. Open any of them in a browser (keep `support.js` next to them). Each file shows the screen four times: desktop 1440 light, desktop dark, mobile 375 light, mobile dark. They're interactive — click things.

Recreate them inside `frogempire607/clubos`, `web/` — Next.js 14 App Router, React 18, TypeScript, Tailwind v4, Prisma, NextAuth, lucide-react, Capacitor. Reuse the primitives the Members redesign uses (`PageHeader`, `EmptyState`, `DashboardSidebar`, the members profile tab component) and the tokens in `web/app/globals.css`. **No new CSS framework, no hand-written hex where a token exists.**

| File | Screen |
| --- | --- |
| `design/Main.dc.html` | Overview tab (owner viewing a staff member) |
| `design/Schedule.dc.html` | Schedule & availability — top row: owner managing Sal · bottom row: Kate on her **own** profile |
| `design/Access.dc.html` | Access — top row: editing · bottom row: the confirm step |
| `design/Pay.dc.html` | Pay (compensation plan) |
| `design/Lessons.dc.html` | Lessons (saves as you toggle) |
| `design/AddStaff.dc.html` | Staff directory with the **Add staff** dialog / bottom sheet |
| `design/canvas.json` | Canvas layout (only needed to reopen the design canvas) |

## Fidelity
**High fidelity** for layout, copy, states and behaviour. Sample people and numbers are Frog Empire's real staff from the current screens, except these, which are invented for the mock: Sal's and Kate's weekly hours, Sal's Oct 10 time off, phone numbers, the missing W-9, the $420 lesson revenue, "Jordan Reyes" in Add staff. Pull real data.

---

## Route, tabs and URL
- Page: `/dashboard/team/[id]` (use whatever the existing staff route is if it differs — keep one route).
- Tab in the URL: `?tab=overview|personal|schedule|access|pay|lessons|portal|documents`. Default `overview`. Back/forward must work.
- Tabs (13.5px, active = brand text + 2px brand underline, horizontal scroll on mobile): **Overview · Personal info · Schedule & availability · Access · Pay · Lessons (count) · Portal profile · Documents**.
- Red 6px dot on a tab = something needs action (e.g. Documents when a required doc is missing; Schedule when an assignment is outside availability). Brand-colour 6px dot = that tab has unsaved changes.
- The **Staff directory** (`/dashboard/team` or current path) stays the list; each row opens the profile. The old Edit Staff modal is retired; **Add staff stays a quick dialog**.

## Page-wide rules (apply to every tab)
1. **One save per tab**, stated in a one-line "tab rule" under the tab bar. Never two Save buttons in one scroll.
   - Overview: read-only.
   - Schedule & availability: assignments save on add/remove; time off saves on Add; weekly hours use the tab's one sticky **Save weekly hours** bar.
   - Access: one **Review and save** → confirm step.
   - Pay: one **Save pay plan**.
   - Lessons: **"Changes save as you toggle."** No Save button.
2. **Leaving a tab with unsaved changes asks first** — in-app dialog on desktop, bottom sheet on mobile. **Never `window.confirm()`**. Copy: "Leave without saving …?" / "Stay on this tab" / "Discard and leave". Also guard route changes and `beforeunload`.
3. **Every write is attributed** to the signed-in user and shows in the profile's *Recent activity*.
4. **Password is a locked block** (Contact & identity card): *"Password — only the staff member can change this, from their own account."* Staff/owners never see or set it. The existing **Setup link** action stays (header button + Account & security card).
5. **All times are 12-hour with AM/PM** everywhere on these screens (e.g. `6:30 – 8:30 PM`, `11:00 AM – 1:00 PM`). Collapse the shared meridiem when both ends match. Store times however they're stored today — this is display only. `<input type="time">` stays native.
6. **Mobile (375px, Capacitor shells)**: charcoal top bar (back arrow · name · more), the existing 5-slot bottom nav, tabs scroll sideways, **44px minimum tap targets**, **no text under 12px** (this includes bumping the bottom-nav labels from 10px to 12px), dialogs become **bottom sheets** (22px top radius, grab handle), sticky save bar spans full width above the bottom nav.
7. **Light and dark mode.** The prototype's dark values are placeholders — map them to the app's existing dark theme tokens (`ThemeToggle.tsx` / `globals.css`). If the app has no dark token for a value, add a semantic token rather than a hex.
8. **No sport-specific words** in any copy. Run `npm run test:sport-terms` before you push.
9. Respect `prefers-reduced-motion` (the reveal animations and switches).

## Tokens used (all from the Members handoff)
Existing: brand `#6D5DF6` / hover `#5948E8`, lime `#A3E635`, orange `#FF6A00`, bg `#F7F7F9`, surface `#FFFFFF`, border `#E5E7EB`, text `#111111`, muted `#6B7280`, charcoal `#1F1F23`.
Semantic pairs from the Members handoff: warn `#FFF7ED`/`#B45309`, success tint `rgba(163,230,53,.25)`/`#3F6212`, chip `#F1F1F3`/`#4B5563`, pending `#EDEBFF`/`#4F46E5`, hairline `#F5F5F7`/`#F1F1F3`, fill `#FAFAFB` on `#EFEFF2`.
One addition for permission levels (matches today's orange "edit" chips): **edit surface `#FFF1E6` / text `#C2410C`**.
Scale: cards radius 12 / padding 18–20; modals 14; inputs & buttons 8; page padding 28px 32px; content max 1192px; 1.55fr / 1fr columns.

---

## Tabs

### Overview (`Main.dc.html`) — read-only summary
Order: back link "All staff" → identity header → next-action banner (only when something is outstanding) → tabs → two columns.
- **Header**: 64px initials avatar, name 25px/600, `Active` lime pill, title chip + `STAFF` role chip (10.5px uppercase), `Login set up` check (or `Invited` dot), meta line (pay basis · login email · on staff since). Actions: `Message`, `Setup link`, `Edit staff` (primary → Personal info), `⋯` (Remove from staff).
- **Banner** (warn tint): names the blocker and whose turn it is. Example: "Waiting on you — 1 assignment is outside Sal's availability". Actions: `Review schedule`, `Ask Sal to update hours`. Derive from the same resolver the Schedule tab uses.
- **Left**: *This week* (each day: assignment chips + that day's availability; orange chip when outside hours) · *Contact & identity* with the ownership legend (pencil = you can edit, refresh = the staff member can edit too, lock = locked) and the locked Password block · *Recent activity* (attributed).
- **Right**: *Account & security* (login state, sign-in email, last login, password never visible, Setup link) · *Pay* (this period's amount + basis, links to Payroll and Payouts) · *Access* (the existing permission chips, same colours as the directory: full = lime, edit/send = orange, view = purple) · *Private lessons* · *Documents* (missing count in red + Request).

### Schedule & availability (`Schedule.dc.html`) — the priority tab
This is the existing **Schedule** page and **Availability** page, scoped to one person.
- **Week card**: `Prev · This week · Next`, "Week of September 20, 2026". Desktop = 7 day columns; mobile = 7 stacked rows. Each day shows the availability band (green = available, grey = not available, orange = date exception/time off) and assignment chips with **edit** and **remove** (existing actions), plus `+ Assign`.
  - `+ Assign` opens a picker (dialog / bottom sheet) of the classes and events running that day, each tagged **Fits hours** or **Outside hours**. Picking saves immediately (as the current Schedule page does).
  - An assignment outside availability renders orange with "· outside hours" and raises the banner + red tab dot. Availability used for this check = **saved** weekly hours plus date exceptions.
- **Weekly hours card**: per weekday, slots of start–end time + `Active` checkbox + `Remove`, and `+ Add slot` — exactly the current Availability editor. Changed days tint brand. Saved by the sticky bar: "N unsaved changes to weekly hours — saved under <name>" · `Discard` · `Save weekly hours`.
- **Time off & date exceptions card**: Date · Type (`Unavailable` / `Modified hours` — the From/To fields reveal smoothly when Modified hours is chosen) · Note · `Add`; list of upcoming exceptions with `Remove`. Saves on Add.

#### Self-service (staff on their own profile)
- A staff member reaches their own profile from the user menu / sidebar ("My profile"). Same page, same tab.
- **They can always edit their own weekly hours and time off**, regardless of their Staff schedule permission. Server-side: allow the write when `session.user` is the staff member being edited **or** has Staff schedule ≥ edit (today presumably only the latter — add the self case to the existing availability routes; don't create new routes).
- Assignments: editable only with Staff schedule ≥ edit (unchanged). Without it, chips are read-only and a visible lock row explains it: "Assigning classes needs Staff schedule: edit · OWNER · Your access is view, so you see your assignments here. Your hours and time off below are yours to change." Gated items stay **visible and locked**, not hidden (Members handoff rule).
- Self view hides owner-only header actions; shows a `You` pill and an `Edit my info` button. Pay and Access are read-only for self unless their permissions already allow editing.
- Owners see every self-made change attributed ("Sal added time off Oct 10 — from his own profile").

### Access (`Access.dc.html`)
- The **existing 11 areas and existing levels**: Members, Attendance, Classes, Events & purchase options, Staff schedule, Messaging, Documents, Financials & payroll, Billing management, Reports, Staff & contractors. Levels are the app's current values: **None · View · Edit · Full** (Messaging: **None · View · Send · Full**). Keep the existing enum; this is only a new control.
- Each row: area name, a `Money` tag on Financials & Billing, a `Was <level>` tag when changed, a one-line plain-English description of the selected level, and a segmented control coloured like the directory chips.
- **Advanced sub-options** for Messaging and Billing management appear **in place with a smooth height/opacity reveal** (grid-rows 0fr→1fr, ~220ms) when the level isn't None — never jumping in below the list. Messaging: *Send announcements to every member*, *Read other staff's conversations*. Billing: *See and edit payment methods*, *Issue refunds*, *Charge a saved card*. **If any of these don't exist as flags today, leave them out and tell Julian — don't invent new permissions.**
- **Confirm step** (required): lists each change as a sentence Sal will experience, money ones in warn tint with "Involves money", e.g. "Sal will be able to see and edit every member's payment methods." Then: "Recorded under your name, Julian Ramirez, on Sep 26, 2026, in Sal's Recent activity. Takes effect within a minute — Sal doesn't need to sign out." Buttons: `Go back and edit` / `Confirm and save N changes`. On save, invalidate the `requirePermissionLive` cache for that user (the existing staff-profile-edit invalidation).
- Owners always have full access; the tab says so and the owner's own profile shows Access as read-only "Full access (owner)".

### Pay (`Pay.dc.html`)
- The existing compensation plan: base **Salary (monthly) · Per class · Hourly** (radio cards) + amount; bonuses **Attendance bonus** ($ per attendee), **Signup bonus** ($ per signup), **Revenue share** (% of private lesson revenue) — each a switch whose amount field reveals smoothly. **Only include bonus types that exist in the current plan model**; flag any that don't.
- Right column: "September so far" live estimate from the plan as shown (base + each bonus line + total) — label it an estimate; Payroll calculates the final amount. Links: **Payroll** (calculates) and **Payouts** (records what was paid).
- One sticky **Save pay plan**; leave guard.

### Lessons (`Lessons.dc.html`)
- The existing private lesson types as switches (name + "60 min · $70.00 · 3 options"). Tab rule: **"Changes save as you toggle. There's no Save button on this tab."** Each toggle saves immediately and shows a brief "Saved" tick on that row plus a status pill ("Added Duo · saved just now").
- Note: "Prices live on the lesson type (and its purchase options) under Purchase Options → Privates."

### Add staff (`AddStaff.dc.html`)
- Stays a **quick dialog** (bottom sheet on mobile) from the Staff directory's `Add staff` button (mobile: pill FAB above the bottom nav).
- Fields: First name, Last name, Login email, Title, Role (**Staff** / **Owner** radio cards; choosing Owner shows a warn line: owners see and change everything and can't be limited). `Send invite` disabled until first name + valid email. Footer: "Recorded under <name>".
- Success state: "Invite sent to Jordan" + where it went + `Add another` / `Open Jordan's profile`. New row appears in the directory as **Invited** with "No access yet — set it on their profile".
- Uses the existing invite / setup-link flow.

### Personal info, Portal profile, Documents (not drawn — build in the same pattern)
- **Personal info**: read view of first/last name, login email, title, phone; `Edit` opens a side drawer (bottom sheet on mobile). Changing the **login email** must say before saving that it moves their sign-in: "Sal will sign in with the new address from now on. The old one stops working." One Save in the drawer.
- **Portal profile**: photo, bio, public email/phone, show-in-member-portal toggle. One Save.
- **Documents**: W-9, contracts, agreements; required-and-missing drives the red tab dot and the Overview card.

---

## Suggested build order (batch into one branch, one push — Netlify builds are limited)
1. Route + tab shell (`?tab=`), header, banner, tab bar, leave-guard hook, 12-hour time formatter helper.
2. **Schedule & availability** tab incl. self-service server check.
3. Overview.
4. Access (+ confirm, + cache invalidation) → Pay → Lessons.
5. Add staff dialog + directory rows linking to profiles; retire the Edit Staff modal.
6. Mobile pass (375px) and dark-mode pass. Run `npm run build` and `npm run test:sport-terms` locally, then push once.

## Open decisions for Julian
- Do the Messaging/Billing advanced sub-options and the Revenue share bonus exist today? If not: drop them, or add them as a separate, explicit change.
- Should staff self-service also cover assignments (e.g. swap requests), or stay hours + time off only? Design assumes hours + time off only.
- Where "My profile" lives for staff: sidebar item, user menu, or both.
