# Handoff: Members · Profiles · Migration redesign (AthletixOS / ClubOS)

## Overview
A redesign of the owner/staff experience for three areas of the dashboard:

1. **Members list** (`/dashboard/members`) — scan status, understand what's outstanding, act in bulk.
2. **Member profile** (`/dashboard/members/[id]`) — one place that answers who this person is, what they pay, whether they can log in, who manages them, and what's blocking them.
3. **Migration** (`/dashboard/members/migration`) — a seven-step pipeline replacing the current "status + readiness + triage group" model.

The core problem being fixed: one vocabulary was doing three jobs, so a paying member mid-migration read as **"Prospect · Un-invited"**, and staff had to open every profile to discover work. The redesign splits status into three independent tracks and puts the next action next to the person.

## About the design files
The files in this bundle are **design references written as HTML** (they render standalone in a browser). They are prototypes of look, copy and behaviour — **not production code to copy**.

The task is to **recreate these designs inside the existing codebase**: `frogempire607/clubos`, `web/` — Next.js 14 App Router, React 18, TypeScript, Tailwind CSS v4, Prisma, NextAuth, lucide-react icons, Capacitor for the native shells. Use the app's existing primitives (`web/components/PageHeader.tsx`, `EmptyState.tsx`, `MembersTabs.tsx`, `DashboardSidebar.tsx`, `LoadingSkeleton.tsx`) and the Tailwind theme tokens in `web/app/globals.css` (`bg-surface`, `border-app-border`, `text-text-muted`, `bg-brand`, `text-brand`, `bg-lime-accent`, `bg-orange-accent`, `bg-charcoal`). Do not introduce a new CSS framework, and do not hand-write hex values where a token exists.

## Fidelity
**High fidelity.** Colors, type sizes, spacing, radii, copy and states are all final and intentional. Recreate pixel-for-pixel using existing Tailwind tokens/classes. Where the prototype uses an inline hex that maps to a token, use the token (mapping table below).

The prototypes are inline-styled by necessity of the authoring environment. In the app, express everything as Tailwind utilities exactly as the surrounding pages already do.

---

## Design tokens

### Existing (already in `web/app/globals.css` — use these, don't redefine)
| Prototype value | Token / class |
| --- | --- |
| `#6D5DF6` | `--color-primary` / `bg-brand` `text-brand` `border-brand` |
| `#5948E8` | `--color-primary-dk` / `hover:bg-brand-hover` |
| `#A3E635` | `--color-success` / `bg-lime-accent` |
| `#FF6A00` | `--color-warning` / `bg-orange-accent` |
| `#F7F7F9` | `--color-bg` / `bg-app-bg` |
| `#FFFFFF` | `--color-surface` / `bg-surface` |
| `#E5E7EB` | `--color-border` / `border-app-border` |
| `#111111` | `--color-text` / `text-text-primary` |
| `#6B7280` | `--color-muted` / `text-text-muted` |
| `#1F1F23` | `--color-sidebar-bg` / `bg-charcoal` |
| `#2A2A2E` | `--color-sidebar-hover` |

Type: `Inter, system-ui, -apple-system, sans-serif` (body). `Georgia, serif` only for the "AthletixOS" wordmark. No other families.

### New semantic pairs introduced by this design
Add these as Tailwind theme entries (or reuse the Tailwind palette values that match) rather than sprinkling hex:

| Purpose | Background | Foreground | Suggested name |
| --- | --- | --- | --- |
| Warning surface (waiting on someone) | `#FFF7ED` | `#B45309` | `warn-surface` / `warn-text` |
| Danger surface (blocked, bounced) | `#FEF2F2` | `#B91C1C` | `danger-surface` / `danger-text` |
| Success text on lime tint | `rgba(163,230,53,.25)` | `#3F6212` (icons `#4D7C0F`) | `success-surface` / `success-text` |
| Neutral chip (role labels) | `#F1F1F3` | `#4B5563` | `chip-surface` / `chip-text` |
| Pending / not charged | `#EDEBFF` | `#4F46E5` | existing PENDING pair |
| Prospect (softened) | `rgba(109,93,246,.10)` | `#5948E8` | `prospect-surface` / `prospect-text` |
| Hairline inside cards | `#F1F1F3` / `#F5F5F7` | — | row dividers, lighter than `--color-border` |
| Table header / footer fill | `#FAFAFB` | — | replaces `bg-app-bg` in table chrome |

### Scale
- Radii: pills `999px`; inputs, buttons, chips `8px` (small `7px`, `6px` for segmented items); cards `12px`; modals/drawers `14px`; phone frames `30px`.
- Spacing: 4 / 6 / 8 / 12 / 14 / 16 / 18 / 20 / 26 / 32px. Page padding `28–32px`; card padding `18–20px`; table cell `13px 14px` (first cell `13px 0 13px 16px`).
- Type: 24px/600 page title · 19px/600 section title · 15px/600 card or modal title · 14px/500 row name · 13.5px body · 12.5px secondary · 12px meta · 11.5px pill · 11px/600 uppercase `.06em` column head · 10.5px/600 uppercase role chip.
- Shadows: cards `0 1px 3px rgba(0,0,0,.06)`; popover menu `0 12px 32px rgba(17,17,17,.14)`; modal/drawer `0 18px 44px rgba(17,17,17,.13)`; segmented active `0 1px 2px rgba(0,0,0,.06)`.
- Focus: keep the app's `focus:ring-2 focus:ring-brand`.

---

## The status model (implement this first — everything else depends on it)

Three independent tracks. **They never share vocabulary.**

### Track 1 — Role (who they are)
Neutral chip, `10.5px/600` uppercase, `#F1F1F3` on `#4B5563`, radius 5px, placed after the name or in the meta line. Values: `ATHLETE`, `PARENT / GUARDIAN`, `ACCOUNT HOLDER`, `MINOR · <age>`, `STAFF`. **A person can hold several** (a parent who also trains is `ATHLETE · PARENT`, one record). Derive from: has subscriptions/attendance → Athlete; is `other` side of a PARENT/GUARDIAN relationship → Parent; owns the payment method / is billed → Account holder; `isMinor` → Minor.

### Track 2 — Membership (the money question)
**The only saturated pill in a row.** `11.5px/500`, `padding 2px 8px`, radius `999px`.

| Label | BG | FG | Condition |
| --- | --- | --- | --- |
| Active | `#A3E635` | `#1F1F23` | active paid subscription, or live staff trial |
| Pending · not charged | `#EDEBFF` | `#4F46E5` | subscription `pending`, or imported plan not yet confirmed |
| Prospect | `rgba(109,93,246,.1)` | `#5948E8` | **never held a membership** — nothing else |
| Paused | `#FFF1E6` | `#B45309` | `status = PAUSED` |
| Inactive | `#F1F1F3` | `#6B7280` | had a membership, lapsed/cancelled |

**Hard rule:** a member who came from an import is **never** Prospect. Today `displayStatusOf()` in `web/app/dashboard/members/page.tsx` maps mid-migration members to `MIGRATING`; that bucket disappears from Track 2 and moves to Track 3.

### Track 3 — Account setup (login + migration)
Rendered as a **6px dot + label**, `12.5px`, never a pill, optionally with a 7-segment meter beneath.

| Label | Dot | Condition |
| --- | --- | --- |
| Not invited | `#9CA3AF` | no invitation sent |
| Invited · N days ago | `#FF6A00` | invitation sent, not started |
| Setting up | `#6D5DF6` | started, not finished |
| Profile created | `#6D5DF6` | profile complete, membership not confirmed |
| Complete (with `check` icon, `#4D7C0F`) | — | own login, or minor whose guardian holds the account |
| Blocked · <reason> | `#DC2626` | bounced email, failed setup, conflicting data — label text `#B91C1C`, weight 500 |

Existing derivation logic is already close: `onboardingStatusOf()` in the members page. Keep the derivation server-side (in `/api/members`) so two staff never see different counts, and **retire the label "Un-invited"** for manually-added members (they're "Profile incomplete", already handled) and the label "Profile completed (reviewed)" everywhere.

### Migration steps (Track 3's meter, 7 segments, 11–12px × 3–4px, 2px gap, radius 2px)
1. Imported · 2. Information reviewed · 3. Invitation sent · 4. Member started setup · 5. Profile completed · 6. Membership confirmed · 7. Migration complete.

Filled `#1F1F23`; current step `#FF6A00` if waiting on the member, `#DC2626` if blocked, `#B45309` if waiting on staff; remaining `#E5E7EB`; all-complete rows render every segment `#A3E635`. Always accompany with `Step N of 7` and **whose turn it is** (`waiting on member` / `waiting on you` / `Nobody`).

Maps onto the existing `migrationStatus` enum (`IMPORTED`, `INVITED`, `ACTIVATED`, `COMPLETED`, `NEEDS_REVIEW`, `FAILED`) plus `activationEmailSentAt`, `activatedAt`, `migrationCompletedAt`, `paymentSetupStatus`, `approvalStatus`. Fields likely needed:
- `reviewedAt` / `reviewedById` (step 2 — currently implied by `setupComplete`/`setupBy`/`setupAt`).
- Invitation delivery outcome per send (`delivered` / `opened` / `bounced`) to drive **Blocked** and the "3 sends, never opened" copy.
- `blockedReason` enum + `snoozedUntil` (the banner's "Snooze 7 days").
- `importSourceLabel` on the import batch — see below.

### Deprecations
Remove from UI, keep columns until data is migrated: `migrationGroup` (`LEAVE_ALONE`/`FUTURE_FOLLOW_UP`/`NEEDS_PAYMENT_METHOD`, letter groups A/B/C), `migrationFinalAction`, `readiness`/`readinessLabel`/`readinessReasons` chips, and the `GROUP_FILTERS` + `READINESS_FILTERS` rows in the migration page. Their information is expressed by step + whose-turn.

### No hard-coded vendor names
Nowhere in the UI should a specific previous-software name appear as a literal. The source label comes from a single owner-entered field at import — *"Where are you importing from?"* — stored per import batch (e.g. `Import.sourceLabel`) and echoed in: the "As imported" column header, the migration subtitle, and per-member meta. When blank, the copy degrades to **"As imported" / "imported <date>" / "your previous system"**. Never print a vendor name that the owner didn't type.

---

## Screens

### 1. Members list — `/dashboard/members` (design ref: section `1a`)
Shell unchanged (248px charcoal sidebar, sticky topbar). Content: `padding 28px 32px 40px`, full width (no `max-w-7xl` cap — this must work for a 5,000-person club), `gap 18px` column flex.

**a. Header** — `PageHeader` with title "Members", description `1,284 people · 218 mid-migration · 41 prospects`. Actions right, 10px gap: `Export` (outline + `download` icon), `Import / Migrate` (outline + `upload`), `Add member` (`bg-brand`, white, `plus` icon, 500). The current "Form settings" and "Custom fields" buttons move into Settings.

**b. Work-queue strip** — 4-col grid, `gap 12px`. Each card: `bg-surface`, `border-app-border`, `border-left: 3px solid <accent>`, radius 10px, `padding 13px 15px`; 22px/600 count + 12.5px label, 11.5px muted explanation, 12px `#5948E8` 500 action link. Cards: `43 never invited` (orange), `11 blocked` (red `#DC2626`), `6 missing contact` (`#B45309`), `9 possible duplicates` (brand). **Each is a saved filter that also arms the matching bulk action** — not a statistic.

**c. Toolbar** (inside the table card, `padding 12px 16px`, bottom border): segmented person-type control (`bg-app-bg` container, `padding 3px`, radius 8px; active `bg-surface` + shadow + 500) — `Everyone 1,284 · Athletes 812 · Parents 402 · Account holders 388 · Prospects 41 · Inactive 63`; a 34px search field (`Name, email, phone, guardian, legacy ID`, max 300px); right side `Filters` button with a count badge (brand outline when active), a sort control (`Last seen`), and a density toggle. **All six existing `<select>` dropdowns collapse into the Filters panel** (tags, membership, gender, age, custom field, setup state).

**d. Active-filter bar** — `#FCFCFD`, 10px 16px: `Filtered by` + removable chips (`#F1F1F3`, radius 6px, `x` icon) + `Clear all` + right-aligned `Save as view` (`bookmark` icon). Saved views persist per user.

**e. Bulk bar** (only when a selection exists) — `rgba(109,93,246,.06)` fill, brand hairline: `24 selected`, then the critical **`Select all 218 matching this filter`** (underlined link — selection must be query-based, not page-based), then actions right: `Send invitations` (primary), `Resend`, `Assign membership`, `Message`, `Add tag`, `⋯`. Destructive actions live only under `⋯` and only for permitted roles.

**f. Table** — header row `#FAFAFB`, 11px/600 uppercase `.06em` muted. Columns: checkbox (42px) · **Person** · **Membership** (190px) · **Account setup** (210px) · **Balance** (110px, right-aligned) · **Last seen** (120px) · actions (150px). Row divider `#F1F1F3`, hover `bg-app-bg`.
- *Person*: 34px avatar (`#E5E7EB`, initials 12px/500, or `profileImageUrl`), name 14px/500, meta 12px muted `Role · Minor · <who manages> · imported <date>`. Family groups collapse: the account holder row gets a `chevron-down` and children render indented 25px with a 2px `#E5E7EB` spine and a 30px avatar. A 3-child family costs 1 row collapsed.
- *Membership*: Track 2 pill + 11px muted second line (plan, price, next charge / "Never held a membership" / "Lapsed Jun 22").
- *Account setup*: Track 3 dot + label, 7-segment meter for anyone mid-migration, 11px muted `Step 3 of 7 · waiting on member`.
- *Balance*: `—` when nothing owed; owed amounts 13px/600 `#B45309` + 11px `2 mo overdue`.
- *Actions*: **one** recommended next action as a 12px outline button (brand outline when it's the primary move — `Resend invite`, `Fix email` on charcoal, `Assign membership`, `Win back`, muted `Leave alone`) + a 28px `⋯` button.

**g. `⋯` menu** — 238px popover, radius 10px, `padding 5px`, items 13px with a 14px lucide icon and 9px gap, hover `#F7F7F9`, dividers `#F1F1F3`. Fixed order, identical everywhere: View profile · Edit member · Resend invitation · Send password reset · Continue migration — Assign membership · Add relationship · Check in to class — Archive member. **Permission-gated items stay visible, greyed (`#9CA3AF`), with a `lock` icon and a role badge** (`Owner`) rather than being hidden.

**h. Footer** — `#FAFAFB`: `Rows 1–50 of 1,284 · sorted by last seen`, Previous/Next, and an `A–Z` jump. Server-side search/sort/pagination is mandatory; counts come from the query, not the loaded page.

### 2. Member profile — tabs (design ref: `1c`) — **recommended**
Content max 1192px. Order: back link → identity header → family switcher → next-action banner → tabs → 2-column body (`1.55fr / 1fr`, `gap 16px`).

- **Identity header**: 64px avatar; name 25px/600 `-0.02em`; Track 2 pill; role chips; Track 3 dot+label inline. Meta line 13px muted with `gap 2px 18px`: plan & price · joined · **DOB with a 11px `lock` icon** · legacy ID. Right: `Message`, `Password reset` (both outline, 14px icon), `Edit member` (primary), `⋯`.
- **Family switcher** (`1g`'s data, one instance only): white card, `padding 9px 12px`; 11.5px/600 uppercase family name; a segmented control of members with 20px avatars, the current person marked `viewing`, others annotated (`parent · pays`, `athlete`); right-aligned `Manage family & access →`. **This replaces every other "managed member" selector on the page** — there must be exactly one.
- **Next-action banner**: `#FFF7ED` on `rgba(180,83,9,.22)`, radius 10px, `clock` icon `#B45309`. Title 13.5px/600 names the blocker *and whose turn it is*; body 12.5px muted gives the evidence (how many sends, to which address, when) and the reassurance ("keeps training, keeps billing on his existing date"); 1–3 actions right (`Resend invitation` on charcoal, `Try a different email`, `Snooze 7 days`). **Renders only when something is outstanding.**
- **Tabs** (13.5px, active `text-brand` + 2px brand underline): Overview · Personal info · Memberships · Family & access · Attendance · Payments · Bookings · Messages · Documents · Migration activity · Notes. Counts in 11px; a 6px `#DC2626` dot advertises a problem (missing waiver).
- **Left column**: *Migration progress* card (7 equal columns, 4px bars, label + date/actor under each, footer line "Nothing has been charged in AthletixOS…" + `Full migration activity →`); *Contact & identity* card with a **3-icon ownership legend** (`pencil` = you can edit, `refresh-cw` = member keeps it current, `lock` = locked) and a 2-col field grid; *Recent activity* list with 24px tinted icon tiles.
- **Locked birthday row** (span 2, `#FAFAFB` on `#EFEFF2`, radius 8px): `lock` icon, `Birthday`, value 13px/500, a `LOCKED` chip, then 11.5px explanation: *"Birthdays set age brackets, waivers and minor rules, so staff can't change them. **<Guardian> updates it in the member portal** under Profile → Personal details. Wrong date blocking a signup? Ask them to fix it there, then refresh."*
- **Right column**: *Account & security* (portal login state, who they log in as, last login, `Password — never visible to staff`, then a tinted block: "Send password reset link", the address, 60-minute expiry, attribution, and the button); *Money*; *Attendance* (3 figures); *Waivers & documents* with `1 missing` in `#B91C1C` and a `Request` action; *Staff notes* (staff-only, attributed).

### 3. Member profile — scroll + rail (design ref: `1d`) — alternative
212px left rail: 44px avatar + name; section list with 14px icons, active item `bg-surface` + border; completion markers on the right (`3/7` in `#B45309`, red dot, counts); the family switcher as a vertical list; two pinned buttons (`Edit member`, `Send password reset`). Body: one scroll with 11px/700 uppercase `.09em` section rules, a 4-up stat grid, then each section's card. Ship one of `1c`/`1d`; a valid split is tabs on desktop, rail on tablet.

### 4. Edit member (design ref: `1e`)
560px drawer/modal, radius 14px. Header (title + subtitle) → **brand-tinted info strip**: *"<Name> is **mid-migration**. Fix anything that came over wrong in the import — it saves straight away and won't restart their setup. Every change is attributed to you in migration activity."* → grouped fields (`Identity`, `Contact`, then the locked block, then `Relationship`) → footer (`#FAFAFB`) with `Saved as <staff> · logged to migration activity`, `Cancel`, `Save changes`.

Field spec: label 12px/500 with 5px gap; input `padding 8px 12px`, `border-app-border`, radius 8px, 14px text; helper 11px muted. **Corrected-field affordance**: `history` icon + `Imported as "607329885" · corrected by Dana R. Jul 8` + a `Revert` link. **Locked block**: `#FAFAFB` on `#EFEFF2`, radius 10px, header `lock` + `NOT EDITABLE BY ANYONE AT THE CLUB`, containing Birthday (dashed `#D7D7DC` field, `#F4F4F6` fill, lock icon, age on the right, the portal explanation, then `Ask <guardian> to fix it` and `Copy portal link`) and Password (dashed field of dots, "Never visible or settable by staff", `Send password reset link`).

Rules: editing an email **re-points the pending invitation, never silently re-sends**; edits never reset migration progress; every write is attributed.

### 5. Password reset (design ref: `1f`) — three states, 412px dialogs
Copy is final; use verbatim.
- **Confirm**: 38px brand-tinted icon tile (`key-round`); "Send password reset link?"; *"We'll email a secure link to **<email>** — <Name>'s guardian. It works once and expires in 60 minutes."*; grey note: *"You won't see the new password, and this doesn't change <Name>'s membership, bookings or migration status. Sent as **<staff>** and recorded in their activity log."*; `Cancel` / `Send link`.
- **Success**: lime-tinted `check`; **"Password reset email sent successfully"**; *"Sent to **<email>** at 2:14 PM. The link expires at 3:14 PM."*; note with spam advice + `send to a different email`; `Resend in 0:58` (disabled, live countdown) / `Done`.
- **No email**: `#FEF2F2` tile with `mail-x`; **"This member does not have an email address on file"**; *"<Name> has no email, and no guardian is linked to his account — so there's nowhere to send a reset link."*; red-tinted note with bounce history; `Add an email address` (primary), `Link a guardian`, `Close`.

### 6. Family & access (design ref: `1g`)
Header (`Koh family`, `1 account holder · 2 athletes · 1 pending guardian`) + `Transfer account management` + `Add relationship`.
- **Account-holder card**: 46px avatar, name 15px/600, a charcoal `ACCOUNT HOLDER` chip + role chip, meta line with email, phone, card on file, who they pay for; `View profile`, `Message`.
- **Permissions table**: Person · Relationship · Manages · **Book · Pay · Waivers · Messages** (centred 15px `check` `#4D7C0F` or `—` `#D1D5DB`, editable in place) · Status (`Confirmed` lime-tint `#3F6212` / `Pending` orange-tint `#B45309` + `Invited <date>`) · actions (`Edit`/`Remove`, or `Resend`/`Cancel` while pending). Pending rows tint `#FFFBF5`.
- **Transfer account management** card: what moves, what the old holder keeps, and the safeguards — owner-only by default, both adults emailed, the incoming holder must add a payment method before completion, in-flight invoices stay with the old holder, permanently logged.
- **Staff-created relationship** card: a link a coach created at the desk appears immediately as `Pending`, attributed (`Added by Coach Ben at the desk · Jul 27`), with `Confirm`. It grants no booking/payment rights until the adult confirms.

### 7. Migration dashboard (design ref: `1h`)
Breadcrumb → title `Migration` + subtitle (`267 imported from your previous system · 37 fully moved over · nobody is charged in AthletixOS until they activate`) → actions (`Export plan`, `Match memberships CSV`, `Import more members`) → tabs (`Overview` · `All imported 267` · `Duplicates` **with an orange count badge, non-blocking** · `History`).
- **Funnel card** — 7 joined segments (single border, only the first/last rounded; step 7 tinted lime): `1 · Imported 267` … `7 · Complete 37`, each with a 22px/600 count and an 11px sub-line that flags the drop (`36 unreviewed`, `43 never invited`, `1 needs your yes`, `safe to stop old billing`). Below: a 6px stacked progress bar (complete / in setup / invited-no-response / not invited) with a legend. Every segment is a filter. **This replaces the eight unrelated KPI tiles.**
- **"Needs you" cards** — same 4-up pattern as the members list.
- **Queue** — segmented by whose turn: `Needs you 60 · Waiting on member 172 · In setup 9 · Done 37`. Columns: checkbox · Person · **Step** (meter + step name + why it's stuck) · Imported plan (plan, price, next billing) · **Waiting on** (pill: `You` brand-tint, `Member` orange-tint, red-tint when blocked, `Nobody`) · Last invite (`Jul 12 · 3×`) · one next action + `⋯`. Bulk row above: selection count, `Send invitations`, `Assign membership`, `Mark reviewed`.
- **Cut-over advisory** — `shield-check`, plain-language answer to "when can I cancel my old software?" tied to real numbers, plus `Cut-over checklist`.

### 8. Migration detail (design ref: `1i`)
664px drawer over the queue (staff must not lose their filter). Header: 38px avatar, name + Track 2 pill, `Step 3 of 7 · imported <date> · legacy <id>`, `Open full profile`, close.
- **Duplicate notice** (when applicable): brand-tinted, `copy` icon, the *evidence* ("same guardian email, birthday one day apart") and `Compare`. Non-blocking.
- **Progress timeline**: 7 vertical steps, 11px dots (done `#1F1F23`, current ringed `box-shadow 0 0 0 3px rgba(255,106,0,.18)`, future `#fff` + 2px `#E5E7EB` border), 2px connectors. Each done step carries timestamp + actor; the invitation step embeds `Resend now` / `Send to a different email` / `Copy invite link`; future steps explain what will happen.
- **Imported data table**: 4-col grid `118px 1fr 1fr 58px` — Field · **As imported** (header text comes from the owner's import source label) · In AthletixOS · edit. Corrected rows tint `#FFFBF5` with the old value struck through and `· fixed by <staff>`; birthday shows a `lock` in both the value and the action cell; a linked guardian shows a `linked <date>` chip.
- **Footer**: reassurance line + `Assign a different plan` + `Resend invitation`.

### 9. Mobile (design ref: `1j`) — 390 × 844, Capacitor shells
Charcoal topbar (menu, 26px logo, Georgia wordmark, bell, 28px avatar) and the existing 5-slot bottom nav (`Home · Members · Classes · Money · More`, active icon `#A3E635`, 10px/500 labels, `env(safe-area-inset-bottom)`).
- **List**: search + `Filters` with a badge; person-type chips (horizontal scroll); a 2-card "needs you" scroller; one card per person (`radius 12px`, 44px avatar, name 14.5px/600, meta, then Track 2 pill + Track 3 dot line) with a 44px `⋯` target; a pill FAB (`user-plus` + `Add`) 78px above the nav. **Every target ≥44px.**
- **Profile**: 56px avatar header, compact next-action banner (with `Resend` / `Call <guardian>`), the family switcher as a 3-up segment, a 2×2 fact grid (Balance / Waiver / Last seen / Migration), a section list with chevrons and debt markers, and a sticky bottom bar leading with **`Check in`** (the current class named in the label), then `Message`, `⋯`.
- **Quick-action sheet**: bottom sheet, 22px top radius, 38px handle, member header, then 48px rows — `Check in to Jr Frogs, 6:00pm` first, then View profile, Resend invitation (`3 sent`), Send password reset, Call <guardian>, Edit member, Add relationship, and a locked `Archive member` with an `Owner only` badge.
- **Desk walk-in**: type segment (Athlete / Parent / Both) → name → minor yes/no → **link a parent** (search result card, selected state brand-outlined, explanation: *"<Parent> gets asked to confirm. Until they do, <Name> can train and check in but can't be billed."*) → two toggles (`Check in to <class> now` on, `Email the portal invitation` off) → `Add & check in`. Duplicate detection runs on save and offers the existing record first.

### 10. States (design ref: `1k`)
- **Empty roster**: 56px `rgba(163,230,53,.12)` circle with a `#5C8C1F` icon (matches `EmptyState.tsx`), "No members yet", the never-charged reassurance, `Import a roster` / `Add one member`.
- **Empty search**: names the active filters, offers a spelling suggestion, `Search all 1,284 people` / `Clear filters`.
- **Loading**: skeleton rows stream 50 at a time; toolbar and counts stay usable.
- **Success**: never a flat "Sent 24" — `21 invitations sent` + *"3 people were skipped: 2 have no email on file, 1 was invited 4 hours ago."* + `See the 3 skipped` (filters the list to exactly those).
- **Warning**: non-blocking Stripe banner that says what still works and how many people it holds up.
- **Error**: `8 invitations couldn't be delivered` → those people become **Blocked** so they stop consuming sends → `Fix these 8` / `Export list`.

---

## Interactions & behaviour
- Row `⋯` and the mobile card `⋯` open the **same** action set in the same order.
- Selection is query-scoped: `Select all N matching this filter` must send an intent (filter + count), not 50 ids.
- Bulk sends honour a per-person cooldown, report skips with reasons, and can never trigger a charge.
- The next-action banner and the row's single action are derived from the same resolver — one function, `nextAction(member)`, returning `{ label, kind, permission }`.
- `Snooze 7 days` hides the banner and drops the person out of "Needs you" until the date.
- Filters, sort, segment and page belong in the URL so a view is shareable; `Save as view` persists per user.
- Drawers (`1e`, `1i`) overlay without navigating; Esc and backdrop click close; the queue keeps scroll position and selection.
- Transitions: keep the app's `transition-colors` / `.15s` idiom. Popovers/sheets 150–200ms ease-out. Respect `prefers-reduced-motion`.
- Responsive: ≥1280px as drawn; 1024–1280 drop Balance and Last seen; <1024 (tablet) switch the table to the mobile card list; the sidebar becomes the existing drawer at `<md`.

## State (per screen)
`filters{personType, tags, membership, gender, age, setupState, customField}`, `search`, `sort`, `page`, `selection{mode: 'ids'|'allMatching', ids, count}`, `openMenuFor`, `editing`, `drawerFor`, `expandedFamilies`, `bulkResult{sent, skipped[]}`, `resetState{idle|confirming|sent|error, cooldownEndsAt}`, `savedViews[]`.

## Permissions & safeguards
Everything is permission-driven — the owner grants each capability, and `canAccessPath` / the `permissions` object already exist (`web/lib/permissions.ts`, `/api/me`). Gate at minimum: send/resend invitation · send password reset · edit migration data · assign or change membership · confirm membership · archive/deactivate · transfer account management · view balances. Rules: locked items render visibly locked with the required role named; password is never displayed or settable by staff; reset links are single-use, 60-minute expiry, attributed; birthday is writable only by the member/guardian in the portal; staff-created relationships start `Pending`; destructive bulk actions never appear for unpermitted staff; every mutation on a migrating member is logged to migration activity with the actor.

## API surface that already exists
`/api/members` (list — extend with derived tracks + server-side search/sort/paging) · `/api/members/[id]` · `/api/members/[id]/relationships` · `/api/members/bulk` · `/api/members/duplicates` · `/api/members/merge` · `/api/members/migration` · `/api/members/migration/[id]` · `/api/members/migration/[id]/resend` · `/api/members/migration/[id]/approve` · `/api/members/migration/send` · `/api/members/migration/families` · `/api/export/members` · `/api/member/family/[memberId]/controls` (the Book/Pay/Waivers/Messages grid).

## Assets
- `brand/icon.png` — the real AthletixOS mark, copied from `web/public/brand/icon.png`. In the app just reference `/brand/icon.png` as the layout already does.
- Icons: **lucide-react 0.469.0**, already a dependency. Names used: `layout-grid, users, shield, shopping-cart, calendar, message-square, check-square, dollar-sign, bar-chart-3, file-text, settings, chevron-right, chevron-down, arrow-left, arrow-up-down, search, search-x, bell, moon, user-circle-2, eye, help-circle, log-out, menu, plus, user-plus, pencil, send, key-round, git-merge, badge-check, calendar-check, lock, more-horizontal, more-vertical, x, check, check-circle-2, alert-circle, alert-triangle, info, clock, history, copy, mail-x, refresh-cw, rows-3, sliders-horizontal, bookmark, download, upload, shield-check, sticky-note, phone, user`. The prototypes load lucide from a CDN purely because they're standalone HTML — use the React package.
- Fonts: Inter (already the body family), Georgia for the wordmark. No new fonts.
- No illustrations. Avatars are initials on `#E5E7EB` unless `profileImageUrl` exists.

## Files in this bundle
| File | What it is |
| --- | --- |
| `Members Experience Redesign.dc.html` | The redesign. Sections `1a`–`1k` (ids on the wrappers) map 1:1 to the screens above; each screen is followed by numbered callout cards stating problem / what changed / how it's used / safeguards. |
| `Current Experience — Members.dc.html` | The **baseline** — today's members list, profile and migration page recreated from the repo (`T1`, `T2`, `T3`). Use it to diff intent. Note: it prints the real source label from the sample data because it documents what exists today; the redesign never hard-codes a vendor name. |
| `brand/icon.png` | Real brand mark. |
| `github.md` | Source association: repo, branch, last read, and a screen → source-file map. |

Open either HTML file directly in a browser. Both are pan/zoom design canvases — screens sit side by side rather than stacked in one viewport.

## Suggested build order
1. Derive the three tracks server-side in `/api/members` + `/api/members/migration`; add the fields listed under the status model.
2. Ship the members list (`1a`) — toolbar, filters panel, query-scoped selection, `⋯` menu, family collapse.
3. Ship the profile (`1c`), including the locked-birthday and Account & security cards and the single family switcher.
4. Password reset (`1f`) and Edit (`1e`) — small, high-relief wins.
5. Migration funnel + queue (`1h`) and the detail drawer (`1i`); retire the group/readiness UI in the same PR.
6. Family & access (`1g`) incl. the permissions grid and transfer flow.
7. Mobile (`1j`), then the state polish in `1k`.

## Open decisions (confirm with the owner before building)
- Which status treatment: `1b` A (two-track — recommended), B (one resolved state) or C (state + next action).
- Profile structure: `1c` tabs or `1d` scroll + rail (or tabs desktop / rail tablet).
- The four person-type labels (Athletes / Parents / Account holders / Subscribers?).
- Whether "Prospect" should be renamed now that it strictly means never-a-member.
- Default staff permissions vs owner-only.
