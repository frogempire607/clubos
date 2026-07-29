# Handoff: Reports & Financial Dashboard — AthletixOS (ClubOS)

## Overview

A redesign of `/dashboard/reports` in the ClubOS web app, turning a single overview page into an eight-tab financial and membership analytics hub for club owners, plus a seven-step wizard for importing a club's entire pre-AthletixOS history.

The driving idea: **a club owner with no accounting background should be able to open Reports and understand whether the business is healthy** — without opening QuickBooks, and without ever being shown a total the system can't stand behind.

Two things are equally in scope. The visual design is here in the HTML. The *feature* spec — schema, endpoints, formulas, matching rules, permissions, tests — is in `specs/`. Building only the first gives you an empty shell.

**Out of scope: `/dashboard/financials`.** It already owns bank connections (Plaid), Stripe, expense entry, donations, tax summary, and the fixed/variable classification field. Reports reads that data. It must not modify that page, and there is a regression test for it in `specs/06`.

---

## About the design files

The files in `designs/` are **design references written in HTML**. They are prototypes of intended look and behavior — not production code to lift.

The target codebase is `frogempire607/clubos`, `web/` — Next.js App Router, React client components, Prisma, NextAuth, Tailwind v4 with CSS-variable tokens, lucide-react icons. Recreate these designs there using those patterns: Tailwind utility classes against the existing token names (`bg-surface`, `border-app-border`, `text-text-primary`, `text-text-muted`, `bg-brand`), the shared `PageHeader` / `EmptyState` / `LoadingSkeleton` primitives, and lucide-react icon components.

The prototypes use literal hex values inline because they run standalone. **Do not copy the hex values into the app** — every one of them maps to an existing token. The mapping is in the Design tokens section below.

## Fidelity

**High-fidelity.** Colors, typography, spacing, radii, and interaction states are final and are taken from `web/app/globals.css` and the existing dashboard components. Recreate pixel-for-pixel using the codebase's tokens and component primitives.

The sample data is realistic invented data for a mid-size club (214 athletes, 186 memberships, ~$63k/mo revenue). Numbers are internally consistent so you can sanity-check calculations against them, but they are not real.

Two deliberate deviations to be aware of:

1. **Charts are CSS bars in the prototypes.** The real build should use **Recharts** — trend lines and stacked bars. The prototypes show intended shape, proportion and labelling; Recharts should match that visual, not its own defaults.
2. **The default range is "This month"** with today at Jul 28, so the partial-period warnings are visible. That is intentional — those warnings are a required feature, not a mock-up artifact.

---

## Screens

### 1. Reports hub — `designs/Reports.dc.html`

The main screen. Open the Tweaks panel and set `initialTab` to jump straight to any tab.

**Route:** `/dashboard/reports`
**Shell:** the existing dashboard layout — 248px charcoal sidebar (`DashboardSidebar`), sticky white topbar with `BackButton`, `GlobalSearch`, `NotificationBell`, `UserMenu`. Reports is the active nav item.

**Content column:** `max-width: 1152px` (`max-w-6xl`), centered, `padding: 32px` (`p-4 sm:p-6 lg:p-8`). This matches the current Reports page exactly.

**Page header** — `PageHeader` component. Title "Reports" at 24px/600/-0.02em. Description at 14px `text-text-muted`, max 620px, `text-wrap: pretty`. Actions slot holds two controls:

- **Range dropdown** — 36px tall, 1px `border-app-border`, 8px radius, white, 13px/500 label, calendar icon left + chevron right, both `text-text-muted` at 15px/13px. Opens a 248px panel, 12px radius, `box-shadow: 0 10px 30px rgba(17,17,17,0.12)`, 6px padding, 7px-radius rows at 8px/10px padding. Selected row: `bg-app-bg`, `text-text-primary`, 600. Ten options: This week, Last week, This month, Last month, Quarter to date, Year to date, All time, Before AthletixOS, Since joining AthletixOS, Custom range…
- **Export button** — same 36px outline treatment, download icon.

**Reliability strip** — full-width white card, 1px border, 10px radius, 10px/14px padding, 20px below the header. A row of status chips separated by 1px × 14px dividers: a 7px dot (lime `#A3E635` healthy / orange `#FF6A00` attention) plus 12px/500 label. Right-aligned timestamp at 11px muted. This strip appears on **every** tab.

**Tab bar** — white card, 1px border, 10px radius, 4px padding, 2px gaps, `overflow-x: auto`, `position: relative`, `scroll-behavior: smooth`. Eight equal-flex buttons, 13px, 8px/10px padding, 7px radius, `white-space: nowrap`. Active: `background: #1F1F23` (charcoal), white text, 600. Inactive: transparent, `text-text-muted`, 400. Selecting a tab that is scrolled out of view scrolls it into view — measured with `getBoundingClientRect`, 12px of slack.

Tabs: Snapshot · Revenue · Costs · Profit & Loss · Membership · Unit economics · Cash flow · History & imports.

Section content is a `flex column` with `gap: 20px`.

---

#### Tab 1 — Snapshot

- **Alert stack** — one white card, rows divided by 1px borders. Each row: 17px icon, bold 13px headline, 12px muted body, right-aligned action link at 12px/500. The first row has an `rgba(255,106,0,0.05)` tint for the warning severity. Two alerts shown: uncategorized transactions, incomplete historical data.
- **Four KPI cards** — `grid-template-columns: repeat(4, minmax(0,1fr))`, 12px gap. Each 16px padding, 12px radius. Label 11px/600 uppercase `letter-spacing: 0.05em` muted; value 26px/600 `-0.02em` tabular-nums; delta 12px/500 in green `#15803D` or muted. Net profit · Money in · Money out · Available cash.
- **Financial snapshot card** (left of a 1fr/1fr pair) — 20px padding. Header row with 14px/600 title and 11px muted date range. A partial-period notice: `bg-app-bg`, 8px radius, 8px/10px padding, clock icon + 11.5px muted text. Then eight label/value rows: 8px vertical padding, 1px `#F1F2F4` divider, 13px muted label, 13px/500 tabular value. Net position is green.
- **Cash on hand card** (right) — same rows for each account. The total is a highlighted row: `rgba(163,230,53,0.14)`, 8px radius, negative 12px side margins to bleed to the card edge, 13px/600 label, 16px/600 value. Below it: runway value at 16px/600 with a "Healthy" pill (`rgba(163,230,53,0.2)` bg, `#3F6212` text, 10px/700 uppercase), a 6px lime progress bar, and an 11px muted basis note naming the months and the average used.
- **Money in vs. money out chart** — 12 grouped bar pairs, 190px tall, 10px gaps, 3px inner gap. Money in `#6D5DF6`, money out `#D8D5F7`, 3px top radius. The partial month renders at `opacity: 0.55` with an asterisk and a footnote. Legend chips top-right.
- **"Where these numbers come from"** — 3-column grid of six 10px-radius cards: 12.5px/600 source name, status pill, 11.5px muted detail.

#### Tab 2 — Revenue

Revenue mix bar (34px, 8px radius, 2px gap, purple recurring / lime variable with inline percentages) → two cards, Recurring metrics list and Variable category bars → **Revenue by item** table → Revenue by coach and Revenue by location → source chips (999px radius, `bg-app-bg`, 1px border, 8px dot, bold amount).

Table styling used everywhere in this design: header row `background: #FAFAFB`, 10.5px/600 uppercase `letter-spacing: 0.06em` muted; body rows 1px `#F1F2F4` top border, 10px/20px padding, 13px text; numeric columns right-aligned and tabular; first and last cells get 20px horizontal padding instead of 12px.

#### Tab 3 — Costs

Fixed/variable split bar (charcoal / orange) → two metric cards each with a chip list of included categories → an override prompt (purple-tinted, 10px radius, sliders icon, link) → **Top expense categories** table with rank / category / type / amount / % of revenue / vs. prior → Top vendors and Largest single expenses → a **"Needs a look"** 3-column grid of six link cards, each a 22px/600 count, a 12.5px/500 label and an 11.5px muted detail.

#### Tab 4 — Profit & Loss

Controls row: two segmented controls (white card, 1px border, 9px radius, 3px padding; active segment white with charcoal text at 600) — Monthly/Weekly and Cash basis/Accrual view — plus CSV and PDF buttons on the right.

Accrual view reveals a purple-tinted notice naming how many purchases lack a service span.

**Monthly table** — six columns: Line, Jun 2026, May 2026, Change, Jun 2025, YTD 2026. Section headers are full-width rows: 11px/700 uppercase `0.07em`, `#FCFCFD` background. Subtotal rows: `#FCFCFD`, 600. The net profit row is the emphasis: `border-top: 2px solid #1F1F23`, `background: rgba(163,230,53,0.1)`, 14px/700 label, 15px/700 value. Deltas colored green `#15803D` / red `#A32D2D`. Negatives parenthesised. Container is `overflow-x: auto` with `min-width: 840px`.

**Weekly table** — a partial-week warning strip, then seven columns: Line, four complete weeks, the in-progress week (orange header), and 4-week average. Condensed lines only.

#### Tab 5 — Membership

Four KPI cards → **Membership movement** card (starting active through ending active, with plan changes shown but marked "not counted as churn") and a **How churn is calculated** card containing a formula block on `bg-app-bg` with a rule-line fraction and the worked numbers → churn trend chart (December highlighted orange as the seasonal spike, July purple as current) → **Churn breakdown** with four pill filters (active pill is charcoal/white) driving the table below.

#### Tab 6 — Unit economics

Explanatory notice → four per-athlete KPI cards → **Break-even** card: 34px number, a progress bar with a 2px charcoal marker at the break-even point, current/cushion rows, and a formula block showing the arithmetic → **Margins + Acquisition** card with an "Estimated" badge and a caveat paragraph.

#### Tab 7 — Cash flow

Waterfall: five columns of labelled blocks with bar heights proportional to value (beginning `#E9E7FB`, received `#A3E635`, spent and investing/financing `#F3C6C6`, ending charcoal with white text) → **Where the cash went** table grouped Operating / Investing / Financing / Excluded from profit & loss → **What's coming** forecast card (with a "Forecast" badge) and an **Alerts** card with dot-prefixed rows.

#### Tab 8 — History & imports

Club history summary (four bordered stat blocks) → two import cards, members and transactions, each with an icon tile, description, three status rows and two CTAs → **Waiting on you** review-queue preview table with confidence pills → **Import history** table with rollback-window note.

---

### 2. Import wizard — `designs/Reports Import Wizard.dc.html`

**Route:** `/dashboard/reports/imports/[batchId]` (or a modal route off the Reports hub).
Set `initialStep` 1–7 in Tweaks, or click the step rail.

**Step rail** — white card, 6px padding, one button per step, `min-width: 132px`, `overflow-x: auto`. Each: a 22px circular badge (current = brand purple/white, complete = lime/charcoal with a ✓, upcoming = `#F1F2F4`/`#9CA3AF`) plus a 12.5px label. Current step's row gets `bg-app-bg` and 600 weight.

1. **Upload** — dashed dropzone (2px `#D8D5F7`, 12px radius, `rgba(109,93,246,0.03)`, 40px padding, centered upload-cloud icon tile), an uploaded-file row, a source-system radio group (selected: 1px brand border, tinted background, 5px-ring radio), and a template download card with a "safe to re-upload" note.
2. **Match columns** — table of your column / example value / imports as / status. Statuses: Auto (lime), Check format (orange), Unmapped (orange, row tinted `rgba(255,106,0,0.04)`, cell shows a select), Ignored (grey). CSV headers in monospace. Footer note about unmapped columns.
3. **Check for problems** — four count cards, an error table grouped by problem kind with a "download the problem rows" button, and a separate warnings card for non-blocking issues.
4. **Preview** — first six rows exactly as they'll be stored, with an outcome badge per row and a summary footer.
5. **Review matches** — per-row comparison: two bordered panels side by side (from your file / already in AthletixOS) with a confidence pill and the match reason above, and five outcome buttons below (primary = the recommended action). Bulk "Keep all separate" and "Ignore all" in the header. No bulk merge.
6. **Confirm** — a summary of exactly what will be written, a primary commit button, and a "what happens next" card covering reports updating, no emails being sent, rollback, and logging.
7. **Done** — success card with import ID, timing and four actions, then the audit log table.

**Footer nav** on every step: Back / "Step N of 7 · Label" / primary Next, separated by a 1px top border with 24px margin.

---

### 3. Baseline — `designs/Reports Current (baseline).dc.html`

The Reports page exactly as it exists today, recreated from `web/app/dashboard/reports/page.tsx`. Reference only — use it to diff against the redesign. Do not build it.

---

## Interactions & behavior

| Interaction | Behavior |
| --- | --- |
| Tab select | Switches the section. If the tab is scrolled out of view, the bar scrolls it in (`getBoundingClientRect`, 12px slack, `scroll-behavior: smooth`). |
| Range dropdown | Toggles a panel; selecting closes it and refetches. Custom opens two native date inputs. Closes on outside click and Escape. |
| P&L Monthly / Weekly | Swaps the table; different column sets, not a filter on one table. |
| Cash basis / Accrual | Reveals the accrual-coverage notice and re-fetches with `basis=accrual`. |
| Churn breakdown pills | Re-renders the table body only. |
| Any figure in a table | Opens the drill-through transaction list (`GET /api/reports/pnl/drill`). Full-screen sheet on mobile. This is the most-requested behavior in the brief — build it in Phase 2. |
| Reliability chip / alert link | Deep-links to the exact screen that fixes it, not to a section index. |
| Wizard step rail | Steps are clickable backwards freely; forwards only up to the furthest validated step. |
| Wizard commit | Async above ~2,000 rows: 202 + job id, poll, progress state on step 6. |
| Loading | `SkeletonCard` grid for KPI rows, `SkeletonList` for tables — the existing primitives. |
| Empty club | `EmptyState` per section, never a zeroed dashboard. |
| Tier-gated | The existing `UPGRADE_REQUIRED` `EmptyState` in `reports/page.tsx` — keep it as-is. |

Transitions in the prototypes are the app's existing `transition: background 0.15s, color 0.15s`. No new motion vocabulary.

## State

Client state on the hub: `tab`, `range` (+ `customFrom`/`customTo`), `rangeOpen`, `pnlMode`, `basis`, `churnBy`. Persist `tab` and `range` in the URL query so a link to a specific view works and back/forward behave.

Wizard state: `batchId`, `step`, `columnMap`, `reviewDecisions`, `commitJobId`. The batch is server-side from step 1, so a refresh resumes rather than restarts.

Data fetching: one endpoint per tab, fetched on tab activation and cached per `(tab, range)`. The reliability strip is its own lightweight call, cached ~60s, shared across tabs.

## Design tokens

All from `web/app/globals.css`. **Use the token, not the hex.**

| Prototype hex | Token | Tailwind |
| --- | --- | --- |
| `#6D5DF6` | `--color-primary` / `--color-brand` | `bg-brand`, `text-brand` |
| `#5948E8` | `--color-primary-dk` | `bg-brand-hover` |
| `#A3E635` | `--color-success` / `--color-lime-accent` | `bg-lime-accent` |
| `#FF6A00` | `--color-warning` / `--color-orange-accent` | `bg-orange-accent` |
| `#A32D2D` | `--color-danger` | — |
| `#F7F7F9` | `--color-bg` | `bg-app-bg` |
| `#FFFFFF` | `--color-surface` | `bg-surface` |
| `#E5E7EB` | `--color-border` | `border-app-border` |
| `#111111` | `--color-text` | `text-text-primary` |
| `#6B7280` | `--color-muted` | `text-text-muted` |
| `#1F1F23` | `--color-sidebar-bg` | `bg-charcoal` |
| `#2A2A2E` | `--color-sidebar-hover` | `bg-charcoal-hover` |

Values with no token, introduced by this design — add them or inline them consistently:

- `#F1F2F4` — inner row divider inside cards (lighter than `--color-border`)
- `#FAFAFB` — table header background
- `#FCFCFD` — table section-header and subtotal background
- `#D8D5F7` — the "money out" bar and the dropzone border (brand at ~20%)
- `#E9E7FB` — beginning-cash block in the waterfall
- `#F3C6C6` — outflow blocks in the waterfall
- `#15803D` — positive delta text (`text-green-700`, already used in `reports/page.tsx`)
- `#3F6212` — text on lime pills
- `#B24700` — text on orange pills
- Status pill fills: `rgba(163,230,53,0.2)`, `rgba(255,106,0,0.14)`, `rgba(163,58,58,0.1)`, `rgba(109,93,246,0.12)`

**Dark mode:** `globals.css` overrides hardcoded utility classes under `[data-theme="dark"] .dashboard-root`. Anything built with tokens inherits it. The five new colors above do **not** have dark variants yet — add them to that block or they will look wrong in dark mode. Test both themes.

**Typography.** Inter throughout (body font already set on `body`). Scale in use: 26px/600 hero metrics · 24px/600 page title · 16px/600 wizard step title · 15px/600 emphasised totals · 14px/600 card titles · 13px body and table cells · 12.5px secondary body · 12px labels · 11.5px captions · 11px/600 uppercase eyebrows (`0.05em`) · 10.5px/600 uppercase table headers (`0.06em`). Every number gets `font-variant-numeric: tabular-nums`.

**Radii.** 12px cards · 10px inner cards and strips · 9px segmented controls · 8px buttons, inputs and inner blocks · 7px tab pills and menu rows · 999px status pills and dots.

**Spacing.** 32px page padding · 24px below the tab bar · 20px between sections and inside cards · 16px between grid columns · 12px between KPI cards · 8px/10px inside rows.

**Shadows.** Effectively one: `0 10px 30px rgba(17,17,17,0.12)` on the range dropdown. Cards use borders, not shadows — matching the existing dashboard.

## Assets

- `designs/web/public/brand/icon.png` — the real AthletixOS mark, copied from `web/public/brand/icon.png` in the repo. Rendered 28×28 with `border-radius: 8px` in the sidebar, exactly as `DashboardSidebar.tsx` does. Also available in the repo: `brand/logo.PNG`, `brand/logo-light.PNG`, `brand/circle.PNG`, `brand/tagline.png`.
- Icons: **lucide** throughout. The prototypes load the UMD build and use `data-lucide` placeholders; in the app use `lucide-react` components as the codebase already does. Icons used: `layout-grid`, `users`, `shield`, `shopping-cart`, `calendar`, `message-square`, `check-square`, `dollar-sign`, `bar-chart-3`, `file-text`, `settings`, `user-circle-2`, `eye`, `help-circle`, `log-out`, `chevron-right`, `chevron-down`, `arrow-left`, `arrow-right`, `search`, `bell`, `moon`, `download`, `clock`, `info`, `alert-triangle`, `sliders-horizontal`, `file-spreadsheet`, `receipt`, `upload-cloud`, `shield-check`, `check`, `x`.
- No other imagery. No hand-drawn SVG.

## Files

```
designs/
  Reports.dc.html                      the eight-tab hub
  Reports Import Wizard.dc.html        the seven-step import flow
  Reports Current (baseline).dc.html   today's page, for diffing
  support.js                           runtime for the prototypes (not for the app)
  web/public/brand/icon.png            the real brand mark
specs/
  00-build-plan.md                     phases, what exists today, non-negotiables
  01-data-model.md                     Prisma models and fields to add
  02-api-contracts.md                  every route, params and response shape
  03-calculations.md                   formulas, double-counting rules, reliability states
  04-imports.md                        CSV import, matching, review, audit, rollback
  05-permissions-and-mobile.md         permission matrix and responsive rules
  06-test-plan.md                      tests mapped to the brief's Verification list
github.md                              repo association and screen map
```

Open the `.dc.html` files directly in a browser. The Tweaks props (`initialTab`, `initialStep`) let you land on any state without clicking through.

## Read the specs before writing code

The design shows *what it looks like*. `specs/` defines *what it has to be right about*, and several of those rules are not visible in a screenshot:

- A Stripe charge and the bank deposit of its payout are **one** dollar (`specs/03`).
- Transfers between the club's own accounts are neither income nor expense (`specs/03`).
- A member is never merged on a similar name (`specs/04`).
- Runway with no bank connection is `null`, never `0` (`specs/03`).
- Every estimate is labelled and states its inputs (`specs/03`).
- A hidden tab is not access control — every endpoint checks its own permission (`specs/05`).
