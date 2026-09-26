# Staff dashboard — IA and design audit

**Scope:** the owner/staff dashboard (`app/dashboard/*`), with emphasis on the Staff section, the Edit Staff modal, Classes, Memberships, and Settings — plus, per the updated brief, its readiness to ship inside the Capacitor shell to the App Store under Guideline 4.2 (§6).
**Deliverable:** critique + IA proposal. No redesign, no mockups, no code changes.
**Next step:** hand to Claude Design for mockups, in the format of `docs/improvement/design_handoff_*`.
**Date:** 2026-09-25 · **Branch:** `claude/ui-design-spree` · **Repo:** `clubos`, `web/`

---

## 0. Provenance and limits

**The ten screenshots did not arrive with the brief.** Nothing was attached to the message. Everything below is read from the source tree, which is what you asked for anyway ("read the actual routes behind these screens before you critique them"). Where a finding would normally need pixels — rendered line lengths, real overflow at a given width, whether a specific label truncates — I say so and give the measurement I'd need instead of guessing.

What I did read, in full or in the relevant part:

| Area | Files |
| --- | --- |
| Shell + nav | `app/dashboard/layout.tsx`, `components/DashboardSidebar.tsx`, `components/DashboardBottomNav.tsx`, `components/DashboardMobileDrawer.tsx`, `lib/dashboardNav.ts` |
| Staff | `app/dashboard/staff/{page,schedule,availability,payroll,payouts,contractors}/page.tsx`, `app/dashboard/schedule/page.tsx` |
| Member precedent | `app/dashboard/members/[id]/page.tsx`, `components/members/MemberProfileHeader.tsx`, `components/members/EditMemberDrawer.tsx`, `lib/memberEditableFields.ts` |
| Commerce | `app/dashboard/{memberships,privates,products,classes}/page.tsx`, `app/dashboard/purchase-options/*`, `prisma/schema.prisma` (`Discount`) |
| Check-in | `app/dashboard/{attendance,front-desk}/page.tsx` |
| Settings | `app/dashboard/settings/page.tsx` + all six sub-routes |
| Contracts | `lib/permissions.ts`, `lib/payouts.ts`, `scripts/sport-terms-guard.ts`, `app/globals.css` |
| Native shell | `capacitor.config.ts`, `ios/App/App/Info.plist`, `components/NativeDeepLinks.tsx`, `components/BackButton.tsx`, `lib/auth.ts`, `app/login/page.tsx`, `package.json` |

Route inventory and the full orphan list are in Appendix A. Contrast math is in Appendix B.

---

## 1. Three premises in the brief that the code contradicts

I'd rather correct these up front, because two of them change what the mockups should target.

### 1.1 The mobile app shell exists and ships today

> "A mobile app shell is planned but doesn't exist yet, so flag anything that won't survive a narrow viewport."

It exists. `capacitor.config.ts` is configured with three environments; `ios/` and `android/` are both present and committed; `scripts/native-shell-config.mjs` and `scripts/native-dev-switch.mjs` drive `cap:dev:sim` / `cap:dev:iphone` / `cap:dev:prod`. `DashboardMobileDrawer` and `DashboardBottomNav` are wired into `app/dashboard/layout.tsx` behind `md:hidden`. The config comments debug WKWebView-specific failures by name — the IPv6 `::1` race, WebKit's restricted-port block on 3001, the `native-shell-error.html` fallback that reads "Can't reach AthletixOS."

`lib/dashboardNav.ts` even carries a dated product decision for the phone form factor:

> `// Front desk replaced Classes here (2026-09-25): checking people in happens`
> `// every practice; editing classes lives one tap away under More.`

**Why this matters for the mockups:** narrow-viewport defects are not future risks to flag, they are live defects in a shipped surface. The Staff section in particular is being served into a WebView at 375pt today with none of the adaptations the Members section got. §5 treats them at that severity.

It also means the App Store question in the updated brief is about a build that already exists. §6 audits it against Guideline 4.2 and finds seven blockers that no mockup can fix — including that the shipped binary contains no web assets and loads the live website over HTTPS. Read §6 before §3, because if B1 stands, the navigation work improves the product without moving the review.

### 1.2 Payroll and Payouts are not duplicated — they're mislabeled, which is a different fix

They do genuinely different work:

- **`/dashboard/staff/payroll`** *computes* what each staff member earned in a period: a base (`SALARY | PER_CLASS | HOURLY`) plus bonus lines (`ATTENDANCE | SIGNUP | REVENUE_SHARE`), derived from classes coached, hours, attendance and signups. It is a calculator. It writes nothing.
- **`/dashboard/staff/payouts`** is a *ledger* of recorded obligations, `PENDING` / `PAID`, across four payee types (staff, guest clinicians, contractors, event workers), with a method and a paid-at date. Its own header comment: *"Recording money owed/paid; the platform never moves money here."*

So: don't merge them. But the naming is broken in a way the screenshots would only hint at:

```
sidebar child label:  "Payroll"   →  page <h1>: "Payroll & Payouts"   ← claims both names
sidebar child label:  "Payouts"   →  page <h1>: "Payouts"
```

`app/dashboard/staff/payroll/page.tsx:153` renders `<h1>Payroll &amp; Payouts</h1>`. Its internal type is named `Payout`, and its summary tile reads "Total payout" (`:214`). So the page you reach by clicking **Payroll** titles itself with its sibling's name and uses its sibling's noun for its own totals. That is the ambiguity you felt, and it is a copy-and-model problem, not a structural one.

Compounding it: the two pages barely acknowledge each other. Payroll links out only to the Staff directory (`:270`, `:321`). Payouts mentions payroll once, in an 11px aside at `:354` — *"it's tracked separately from payroll."* A staff member who has just seen a computed figure on Payroll has no path to record it on Payouts, and nothing tells them that recording it is a separate act.

### 1.3 The working directory and the read-only instruction

Two small things:

- This session opened in a worktree of a *different* repo (`Frog Empire LLC/frog-empire`, the static marketing site). AthletixOS is at `/Users/cubano/Desktop/clubos`. I worked there. `claude/ui-design-spree` was already checked out, as you said.
- The brief says "Read-only — write one document, no code, no branch" and then gives branch instructions and mentions a push and a merge. I've taken the first as governing: **one document, no code touched, no branch created, nothing committed or pushed.** The file is uncommitted on `claude/ui-design-spree` and ready for your commit whenever you want it.

---

## 2. What actually shares components (you asked, and the answer is the headline)

This is the most consequential thing in the audit, so it goes before the IA.

**The Staff section shares almost nothing.** Component imports per page:

| Route | Shared components imported |
| --- | --- |
| `/dashboard/staff` (Directory) | `PageHeader`, `EmptyState`, `LoadingSkeleton`, `ImageUpload` |
| `/dashboard/staff/schedule` | *none* |
| `/dashboard/staff/availability` | *none* |
| `/dashboard/staff/payroll` | *none* |
| `/dashboard/staff/payouts` | *none* |
| `/dashboard/staff/contractors` | *none* |
| `/dashboard/schedule` (orphan) | *none* |
| `/dashboard/memberships` | `BulkPriceChangeModal` only |
| `/dashboard/front-desk` | *none* |

Five of six Staff pages import zero shared chrome. Every header, empty state, loading state, table shell, and modal in that section is hand-rolled per file.

Three measurable consequences:

**(a) `PageHeader` adoption is 15 of 51.** Of the 51 dashboard pages with a heading, 15 use `components/PageHeader.tsx` and 36 hand-roll an `<h1>`. `PageHeader` is the only responsive title block in the app:

```tsx
<h1 className="text-xl sm:text-2xl font-semibold …">        // steps down below sm
<div className="flex flex-wrap items-center gap-2 … lg:flex-nowrap">  // actions wrap through tablet
```

Its own comment records why the wrap exists: *"pages like Members have five header actions, and `sm:flex-nowrap` forced them to overflow the viewport on tablets."* Every hand-rolled page re-introduces that exact bug. Hand-rolled titles are fixed at `text-3xl` (14 pages) or `text-2xl` (21 pages) with no step-down. In the Staff section, Directory and Payouts use `PageHeader`; Payroll, Schedule, Availability and Contractors don't.

**(b) There are three h1 sizes across the dashboard** — `text-3xl` ×14, `text-2xl` ×21, `text-xl` ×1 — for the same semantic level. Ten of the pages in question are the ten you screenshotted.

**(c) There is no shared modal primitive at all.** Thirty files hand-roll `fixed inset-0 bg-black/…`. Across all thirty:

| Attribute | Files that have it |
| --- | --- |
| `role="dialog"` | 1 / 30 |
| `aria-modal` | 0 / 30 |
| `aria-labelledby` | 0 / 30 |
| Escape-key dismissal | 1 / 30 |

The Edit Staff modal has none of the four. There is no focus trap, no scroll lock, and no consistent dismiss affordance anywhere in the product. `components/` contains `BulkPriceChangeModal`, `QRModal` and `DashboardMobileDrawer` — three specific modals, no generic one.

**Implication for the handoff:** the Staff section is not a set of screens that need restyling. It is a set of screens that never joined the design system the Members section built. Mockups that don't come with "use `PageHeader`, use the new `Sheet`, use `EmptyState`" will be re-hand-rolled.

---

## 3. Information architecture

### 3.1 Your four suspicions, adjudicated from the code

#### Payroll vs Payouts — **confirmed as a naming failure, not a duplication**

See §1.2. Two real, distinct concepts; one of them wears both names in its `<h1>`; neither hands off to the other. Fix by renaming and by joining them into one flow, not by merging the data.

#### Attendance vs Front desk — **confirmed, and it's a form-factor split masquerading as two features**

Both take attendance. `front-desk/page.tsx`'s own header comment says so:

> *"The actions are the existing attendance routes, so money lands in Financials exactly as it does from the Attendance page."*

They differ in fidelity, not in domain:

| | `/dashboard/attendance` | `/dashboard/front-desk` |
| --- | --- | --- |
| Size | 2,346 lines | 414 lines |
| Shape | Multi-session roster grid, bulk edit, export, offline payments, coverage lookup, drop-in billing | One class → one person → one door decision |
| Buttons | Dense rows | `min-h-[52px]` full-width primaries |
| Written for | Desk with a keyboard | Phone at the door |

Both are top-level siblings in the sidebar with unrelated icons (`CheckSquare` vs `ScanLine`), and both are reachable on both form factors. On a phone, a staff member sees two entries that do the same job and no way to know which one is built for the device in their hand. On desktop, Front desk is a 414-line subset of the page directly above it.

This is the one pair where my recommendation is a genuine merge — of *destination*, not of code. One nav entry, one URL, two modes.

#### Plan & Billing vs Stripe — **confirmed, and worse than you thought: three names for two opposite money flows**

There are two entirely different financial relationships here:

1. **The club pays AthletixOS** — subscription tier, `$50/mo` Growth, `subscriptionStatus`, `stripeSubscriptionId`, promo/partner code.
2. **Members pay the club** — Stripe Connect onboarding, `stripeChargesEnabled`, payment methods, cash/check acceptance rules.

Here is how the product names them:

| Surface | Label | Which money flow |
| --- | --- | --- |
| Settings sidebar, in-page button | **Plan & Billing** | (1) club → AthletixOS |
| Settings sidebar, route link | **Stripe** | (2) members → club |
| `/dashboard/settings/billing` `<h1>` | **Payments** | (2) |
| Settings body link text (`:328`) | **Payments & billing** | (2) |
| Route path | `/dashboard/settings/billing` | (2) |
| `/dashboard/settings/diagnostics` cards | **Connect status (member payments)** / **Platform subscription (ClubOS billing)** | (2) / (1) |

So "billing" names flow (1) in the sidebar and flow (2) in the URL. The only place in the product that states the distinction cleanly is the diagnostics page — which is reachable only from a link buried at line 435 of a 1,921-line page, and which uses the **previous product name, "ClubOS"**, while the shell says "AthletixOS". That's the only `ClubOS` string left in any rendered surface (`app/dashboard`, `app/member`, `components`), and it's on the one screen that explains the money model.

Separately: **"Stripe" as a nav label is a vendor name doing a feature name's job.** Your own codebase has a guard built for exactly this class of error — `scripts/sport-terms-guard.ts` cites *"the vendor-literal guard from Phase 4.5.10"* as its model. A label naming the processor rather than the job also means the IA breaks the day a second processor, or a bank-transfer option, lands.

#### App Design vs Branded App — **confirmed: one route, four names**

All four point at `/dashboard/settings/branded-app`:

| Where | What it's called |
| --- | --- |
| Settings sidebar route link | **App Design** |
| Settings in-page section (`NAV`) | **Branded App** |
| Settings body link text (`:1149`) | **App Design editor** |
| The page's own `<h1>` (two of them) | **Branded mobile app** *and* **Branded app editor** |

And the concern is scattered across four more places: the Settings page itself holds sections for **App Icon** (`:1018`), **Personalization** (`:1048`), **Progressive Web App** (`:960`), and a native-app CTA (`:1127`) — all of which are "how the member-facing app looks," all of which live outside the editor they link to.

### 3.2 Six more, ranked by cost

#### (1) Critical — the same page is mounted at two URLs, and the app disagrees with itself about which one to use

Three screens are served twice:

```
app/dashboard/purchase-options/memberships/page.tsx  →  export { default } from "../../memberships/page";
app/dashboard/purchase-options/privates/page.tsx     →  export { default } from "../../privates/page";
app/dashboard/purchase-options/products/page.tsx     →  export { default } from "../../products/page";
```

Not two implementations — one component, two addresses. And internal links are split roughly down the middle:

| Links to `/dashboard/purchase-options/*` (the nav path) | Links to the bare `/dashboard/*` path |
| --- | --- |
| `app/dashboard/page.tsx:39–41` (home tiles) | `app/api/search/route.ts:154,163` (global search) |
| `products/bookings/page.tsx:65` (back-link) | `lib/reportsRevenue.ts:214,218,247,249` (revenue drill-down) |
| `products/inventory/page.tsx:45` (back-link) | `classes/page.tsx:542` |
| | `calendar/page.tsx:47,521` |
| | `lib/actionCenter.ts:91,117,127` |

Consequences, each verifiable:

- **The sidebar goes blank.** `isGroupActive()` matches children by `pathname.startsWith(c.href)`, and the only registered child is `/dashboard/purchase-options/memberships`. Arrive via global search or a revenue drill-down and you land on the Memberships screen with **no active nav item anywhere** — the shell says you're nowhere.
- **The URL hierarchy is broken.** `/dashboard/purchase-options/products` is the nav parent, but its children live at `/dashboard/products/inventory` and `/dashboard/products/bookings`. Deep-link into inventory and the nav is dead again.
- **`BackButton` resolves differently** depending on which door you came through.
- Analytics, bookmarks and support ("go to the memberships page") all split.

`lib/permissions.ts:238–241` gates all four prefixes identically, so this is not a permissions artifact — it's an unfinished rename.

#### (2) Critical — three pages occupy the staff-time space, two of them edit the same data, and the titles are crossed

| Route | `<h1>` | In sidebar? | What it actually does | APIs |
| --- | --- | --- | --- | --- |
| `/dashboard/staff/schedule` | **Schedule** | yes | Week × staff assignment matrix; classes, events, substitutes | `/api/staff/schedule`, `/api/classes/:id/staff`, `/api/events/:id/staff` |
| `/dashboard/staff/availability` | **Availability** | yes | Recurring weekly hours + date exceptions | `/api/staff/:id/availability`, `…/exceptions` |
| `/dashboard/schedule` | **Staff Schedule** | **no** | Recurring weekly hours + date exceptions | `/api/staff/:id/availability`, `…/exceptions` |

The orphan at `/dashboard/schedule` is an older, unreachable-by-nav duplicate of Availability — same endpoints, same concepts, different UI — **titled "Staff Schedule," which is the name a user would give to the *other* page.** It is still routable, still permission-gated, and still linked from nothing. Anyone who bookmarked it, or who finds it via search, edits real availability through an unmaintained screen.

Meanwhile the two live pages know they're one workflow. `staff/schedule/page.tsx:167`:

> *"Recurring weekly hours and date exceptions are edited on the [Availability] page."*

That sentence is the argument for one destination with two views.

#### (3) High — Discount codes are filed under Memberships, but the data model says they're cross-cutting

`prisma/schema.prisma`, `model Discount`:

```prisma
// Item types the code covers: MEMBERSHIP | EVENT | CLASS | PRODUCT |
// PRIVATE_PACK. [] = every purchase type (the default).
appliesTo Json @default("[]")
…
// … it lives on the SAME Discount row so there is never a second place
// to manage codes.
eventIds  Json @default("[]")
```

The schema is explicit: one code can cover five purchase types, and the author deliberately kept one management surface. The IA then buries that surface at the bottom of `/dashboard/memberships` (`:353`) under the subtitle **"Promo codes applied at membership checkout"** — which is false on its own page, since the create modal renders an "only these events" checklist fed by `/api/events`.

Consumers confirm the breadth: `attendance/page.tsx:183` calls `/api/discounts/eligible?itemType=CLASS`; `components/StaffDiscountPicker.tsx` is generic; `members/MemberModals.tsx:1438` requests `itemType=MEMBERSHIP`. So a code that discounts a class is created on the memberships page and consumed on the attendance page, and nothing connects them.

Also: "Promo code" already means something else. Settings `:362` has a **"Promo / Partner Code"** field — a discount on the *club's own AthletixOS subscription*. Two unrelated concepts, one word.

#### (4) High — Settings is a second, competing navigation system

`/dashboard/settings` is one 1,921-line client page with a local `NAV` const and its own sidebar that mixes two interaction models under identical styling:

**In-page section switches (`<button>`, 9):** Club Identity · Plan & Billing · Branded App · Member Portal · Locations · Notifications · Security · Business & Legal · Danger Zone
**Route links (`<Link>`, 6):** Club Profile → · Stripe · App Design · Email · Custom Fields · Staff

Only the first carries an affordance (`→`). The other five look like the section buttons but navigate away, losing your place in a page this long.

Name collisions inside that one list:

- **Club Identity** (section) vs **Club Profile** (route, `<h1>` "Club profile"). The route's comment says it holds *"identity, branding, public/admin contact, mailing address, hours, social links."* The section is a subset of the route, presented as its peer.
- **Member Portal** (section) vs **Member Portal Sections** (an `<h2>` *inside* Club Identity, `:1353`) vs `/dashboard/settings/member-form` ("Member intake form") — which this sidebar doesn't link at all.
- **Staff** re-exposes the top-level Staff group from four items above it in the main sidebar.
- **Custom Fields** → `/dashboard/custom-fields`, which appears **nowhere** in `lib/dashboardNav.ts`. This is its only entry point in the entire product.

And three of the six route labels don't match their destination's `<h1>`: Stripe→"Payments", App Design→"Branded mobile app", Club Profile→"Club profile" (the only match).

There is no `app/dashboard/settings/layout.tsx`, so none of the six sub-routes render this sidebar. Click **Stripe** and the settings nav vanishes; your only way back is the global `BackButton`.

#### (5) Medium — 29 routes are unreachable from the sidebar; 2 of those are the only home of a real feature

Full list in Appendix A. Most are legitimate detail routes (`members/[id]`, `events/[id]/roster`) or deliberate redirects (`/dashboard/approvals` → `members/approvals` — good hygiene, keep the pattern). But three categories need decisions:

- **Genuinely orphaned features:** `/dashboard/custom-fields` (only via the Settings sidebar), `/dashboard/members/duplicates`, `/dashboard/members/roster`, `/dashboard/events/bundles`.
- **The stale duplicate:** `/dashboard/schedule` — see (2). Should become a redirect or be deleted.
- **Settings sub-routes:** all six are invisible to the main sidebar, so `Settings` in the sidebar is a leaf that is really a hub.

#### (6) Medium — the top level has 13 items, and three of them are the same verb

`lib/dashboardNav.ts` exposes 13 top-level entries; six are collapsible groups totalling 20 children, so roughly 29 destinations hang off one flat column. Three top-level items are all "money":

- **Financials** (`DollarSign`) — revenue and transactions
- **Reports** (`BarChart3`) — including `CashFlowTab`, which renders `MetricTile label="Upcoming payroll"` and a "Matched Stripe payouts" line
- **Staff → Payroll / Payouts** — the cost side

So payroll appears as a figure in Reports, as a calculator under Staff, and as a ledger under Staff, and the sidebar groups two of the three under *people* rather than under *money*.

Naming conventions are also mixed within the one list: **Purchase Options** and **Classes & Events** and **Guest & Contractors** are Title Case; **Front desk** is sentence case. Both conventions in one nav is a finding on its own (`writing.md › Style`: capitalization *"is applied consistently. Mixed conventions on one screen are a finding."*).

### 3.3 Proposed structure

Four principles, then the tree.

1. **Group by the noun the user is thinking about, not by the table it lives in.** Payroll under *Staff* is organising by foreign key. A staff member thinking about payroll is thinking about money.
2. **One destination per job; modes inside it.** Attendance/Front desk and Schedule/Availability are each one job at two fidelities. Two nav entries make the user choose a form factor.
3. **One URL per screen.** Delete the alias; redirect the loser.
4. **Settings owns configuration only** — things set once and rarely revisited. Anything operated weekly leaves Settings.

```
Home                          /dashboard

People                        /dashboard/people
├─ Members                    /dashboard/members
├─ Approvals                  /dashboard/members/approvals        (badge)
├─ Migration                  /dashboard/members/migration
└─ Duplicates                 /dashboard/members/duplicates       ← was orphaned

Team                          /dashboard/team
├─ Directory                  /dashboard/team                     (staff + contractors, one list, Type column)
├─ Schedule                   /dashboard/team/schedule
│     view: Assignments  (the week × staff matrix)
│     view: Availability (recurring hours + exceptions)
└─ Time off                   /dashboard/team/schedule?view=exceptions

Check-in                      /dashboard/check-in                 ← Attendance + Front desk, one destination
      mode: Door    (default < md, the current front-desk flow)
      mode: Roster  (default ≥ md, the current attendance grid)

Schedule                      /dashboard/calendar
├─ Calendar                   /dashboard/calendar
├─ Classes                    /dashboard/classes
└─ Events                     /dashboard/events

Catalog                       /dashboard/catalog                  ← replaces "Purchase Options"
├─ Plans                      /dashboard/catalog/plans            ← was memberships
├─ Lessons                    /dashboard/catalog/lessons          ← was privates
├─ Products                   /dashboard/catalog/products
└─ Discount codes             /dashboard/catalog/discounts        ← promoted out of Plans

Money                         /dashboard/money
├─ Overview                   /dashboard/money                    ← was financials
├─ Pay runs                   /dashboard/money/pay-runs           ← was staff/payroll
├─ Recorded payouts           /dashboard/money/payouts            ← was staff/payouts
└─ Reports                    /dashboard/reports

Communication                 (unchanged; already coherent)

Documents                     /dashboard/documents

Settings                      /dashboard/settings                 ← becomes a hub with a real layout.tsx
├─ Club profile               /dashboard/settings/club            (absorbs "Club Identity")
├─ Terminology                /dashboard/settings/terminology     (split out of Club Identity)
├─ Locations                  /dashboard/settings/locations
├─ Member portal              /dashboard/settings/portal          (absorbs "Member Portal Sections")
├─ Member intake form         /dashboard/settings/member-form     ← was linkless
├─ Custom fields              /dashboard/settings/custom-fields   ← was orphaned
├─ Mobile app                 /dashboard/settings/mobile-app      (absorbs App Icon, Personalization, PWA)
├─ Email                      /dashboard/settings/email
├─ Notifications              /dashboard/settings/notifications
├─ Taking payments            /dashboard/settings/payments        ← was "Stripe"; members → club
├─ Your subscription          /dashboard/settings/subscription    ← was "Plan & Billing"; club → AthletixOS
├─ Business & legal           /dashboard/settings/legal
├─ Security                   /dashboard/settings/security
├─ Diagnostics                /dashboard/settings/diagnostics
└─ Delete club                /dashboard/settings/danger          (visually separated, last)
```

Top level drops from 13 to 9. Every group is a noun; every leaf is a thing.

**Naming decisions worth arguing about:**

| Old | New | Why |
| --- | --- | --- |
| Purchase Options | **Catalog** | "Options" is the word the codebase uses for the *tiers inside* a membership (`MembershipOption`, `parseOptions`). Reusing it for the section containing them is a collision. |
| Payroll | **Pay runs** | Names the period, which is what the page computes, and stops competing with "Payouts". |
| Payouts | **Recorded payouts** | The page's own comment says *"the platform never moves money here."* The adjective carries that. |
| Stripe | **Taking payments** | Names the job, not the vendor. Survives a second processor. |
| Plan & Billing | **Your subscription** | Second person disambiguates direction better than any noun pair will. |
| App Design / Branded App | **Mobile app** | One name. Consolidates four scattered sections. |
| Staff | **Team** | Lets contractors, guests and event workers live in one directory without the word lying. |
| Attendance / Front desk | **Check-in** | The verb both pages perform. |

**Migration mechanics:** every renamed path gets a `redirect()` stub at its old address, matching the existing `/dashboard/approvals` pattern. Three call sites must move in the same commit or the sidebar-blanking bug in (1) persists: `app/api/search/route.ts`, `lib/reportsRevenue.ts`, `lib/actionCenter.ts`.

**Bottom nav under the new tree** (5 slots, Material's ceiling, and `bottom-nav-limit` is already respected):

```
Home · People · Check-in · Money · More
```

Unchanged in spirit from today's `Home · Members · Desk · Money · More`, but "Check-in" now points at a destination that adapts instead of a phone-only sibling.

---

## 4. The Edit Staff modal

### 4.1 What it is

`EditStaffModal` lives at `app/dashboard/staff/page.tsx:484–760`, inside a 1,375-line page, in a `max-w-lg` (512px) container with `max-h-[90vh] overflow-y-auto`. One continuous scroll, in this order:

1. First name / Last name / Login email / Title
2. **Private lesson types** (`CoachLessonTypes`, `:1084`)
3. **Compensation plan** (`CompensationBuilder`, `:854`)
4. **Member portal profile** — photo, bio, public email, public phone, visibility toggle
5. **Permissions** — 11 scopes from `PERMISSION_CATALOG`
6. **Messaging — advanced** — 6 sub-scopes, conditional
7. **Billing — advanced** — 1 sub-scope, conditional
8. Cancel / Save changes
9. **Staff documents** (`StaffDocsPanel`, `:1195`) — *outside* the form

That is identity, capability, compensation, public-facing marketing copy, authorization policy, and tax paperwork in one 512-pixel column.

### 4.2 Critical — "Cancel" does not cancel

Four independent write boundaries share one scroll, and nothing tells the user where they are.

| Section | When it writes | Endpoint |
| --- | --- | --- |
| Identity, portal profile, permissions | on **Save changes** | `PATCH /api/staff/:id` |
| Compensation plan | on its own **Save compensation plan** button (`:1064`), with its own "Saved" flash (`:1066`) | separate |
| **Private lesson types** | **immediately, on every toggle** (`:1112`) | `PATCH /api/private-lessons/types/:id` |
| Staff documents | immediately, on upload / visibility change | separate |

So:

- Toggle three lesson types, then press **Cancel** → the three toggles are already persisted. The button lied.
- Fill in a compensation plan, then press **Save changes** at the bottom → identity and permissions save; **compensation is discarded silently**. Two buttons whose labels both begin with "Save", ~200px apart, with different scopes and no indication of either.

`feedback.md` and `entering-data.md` both assume a modal's commit is atomic; HIG's `escape-routes` and `sheet-dismiss-confirm` assume dismissal is safe. Neither holds here. This is the single highest-severity finding in the audit, and it is invisible in a screenshot — which is why the code read mattered.

### 4.3 Critical — the modal is inaccessible

- No `role="dialog"`, no `aria-modal`, no `aria-labelledby`, no focus trap, no Escape handler, no scroll lock. (Consistent with 30/30 files; see §2c.)
- The close control is a bare `×` character: `<button onClick={onClose} className="… text-xl leading-none">×</button>`. No `aria-label`, so screen readers announce "×" or nothing. At `text-xl leading-none` the hit area is roughly **20×20px** — under the 44×44pt mobile minimum *and* under the 28×28pt desktop minimum (`accessibility.md › Buttons and controls`).
- `#6D5DF6` (`text-brand`) is used for links and active states throughout and **is not redefined for dark mode** in `app/globals.css`. Measured: **3.76:1** on `--color-surface` dark (`#1A1A1F`) and **4.16:1** on `--color-bg` dark (`#0F0F12`). Both fail the 4.5:1 floor for text under 18pt. Appendix B.

### 4.4 High — form mechanics

- **The form changes length under the user.** Messaging-advanced (6 checkboxes) and Billing-advanced (1) mount conditionally on `permissions.messages !== "none"` / `permissions.billing !== "none"`. The triggering `<select>` sits ~400px above in the same scroll container, so setting a permission level makes content appear below the fold with no animation and no indication. Progressive disclosure is right; unsignalled layout injection isn't (`progressive-disclosure` + `layout-shift-avoid`).
- **Five unguarded `grid-cols-2` / `grid-cols-3`** in this file (`:380`, `:427`, `:937`, `:1005`, `:1286`) — no `sm:` prefix, so two and three columns are forced at 375pt inside an already 512px-capped container.
- **Dead state that still round-trips.** `appointmentPrice` is read from the profile, never rendered, and PATCHed back on every save (`:500`, `:543`). Comment: *"Preserved (no longer edited here — pricing now lives on lesson types)."* It's a field the UI can't show but can overwrite.
- **Nested scroll.** A sticky header inside a `overflow-y-auto` modal inside a `overflow-y: auto` main column (`layout.tsx`). Three scroll contexts (`scroll-behavior`).
- **No dirty-state guard.** `onClose` closes unconditionally.

### 4.5 What staff should get instead — the member profile is the precedent, and it's a good one

`/dashboard/members/[id]` is 1,943 lines that got this right. Ten mechanisms worth copying, all present in the code today:

| # | Mechanism | Where |
| --- | --- | --- |
| 1 | **A route, not a modal.** Deep-linkable, shareable, back-button-correct. | `app/dashboard/members/[id]/page.tsx` |
| 2 | **Tab state in the URL.** `?tab=memberships`; comment: *"Tab and drawer state live in the URL so a tab is…"* shareable and refresh-safe. | `:220–231` |
| 3 | **11 real tabs** with `role="tablist"`, `aria-selected`, `min-h-[44px]` targets, and `overflow-x-auto` at narrow widths. | `MemberProfileHeader.tsx:149–205` |
| 4 | **Counts and problem dots on tabs.** Comment: *"A red dot means someone has to do something, not merely that a tab is"* non-empty. | `[id]/page.tsx:619–636` |
| 5 | **A curated Overview tab**, not a dump. Comment: *"Overview is its own curated layout (§1c) — … so it no longer dumps every tab's cards."* | `:637–639` |
| 6 | **Read is a page; write is a drawer.** `EditMemberDrawer` opens over the profile. | `EditMemberDrawer.tsx` |
| 7 | **The field list is extracted and shared.** `MEMBER_EDITABLE_FIELDS` + `MEMBER_FIELD_GROUPS` in `lib/memberEditableFields.ts`, *"shared with `MemberModal`, so the drawer can edit everything the modal can … and cannot silently fall behind when a field is added."* | `lib/memberEditableFields.ts` |
| 8 | **An explicit locked block** — dashed, headed **NOT EDITABLE BY ANYONE AT THE CLUB**, naming who *can* change it and where. Comment: *"Greying the fields out was not enough on its own — staff read a grey field as 'I lack permission' and filed a ticket."* | `EditMemberDrawer.tsx` header, `LockedBirthdayRow` |
| 9 | **Write attribution before save.** *"Footer says whose name it lands under before you press save, not after."* | `EditMemberDrawer.tsx:11–12` |
| 10 | **Consequence disclosure before save.** Changing an email *"MOVES THAT LOGIN … and the drawer says which one is about to happen, before save, naming the current sign-in address."* | `EditMemberDrawer.tsx:26–29` |

**A staff record is more dangerous than a member record and gets less ceremony than a birthday field.** Editing `permissions.billing` from `none` to `full` grants access to every member's payment methods. Editing `email` moves a login. Editing a compensation plan changes what the club owes. None of these get attribution, disclosure, a lock block, or even an atomic save.

#### The proposal: `/dashboard/team/[id]`, mirroring the member profile exactly

```
/dashboard/team/[id]                      ← a route, replacing the modal
  ProfileTabs (reuse the component)
  ├─ Overview        curated: who, what they can do, what they're paid, what's outstanding
  ├─ Personal info   name, login email, title, phone       → drawer to edit
  ├─ Access          11 permission scopes + sub-scopes     → its own save, its own confirm
  ├─ Pay             compensation plan + last N pay runs   → links to Money › Pay runs
  ├─ Schedule        this person's assignments + availability
  ├─ Lessons         which lesson types they coach          (badge: count)
  ├─ Portal profile  photo, bio, public contact, visibility (badge: dot if shown but incomplete)
  └─ Documents       W-9, contracts, agreements             (badge: dot if missing required)
```

Eight specific asks for the mockups:

1. **Reuse `ProfileTabs` verbatim.** It already has the 44pt targets, the `aria-selected`, the counts, the problem dots and the narrow-width scroll. Do not build a second tab bar.
2. **URL-persist the tab** (`?tab=access`) with the same `useCallback` + `searchParams` pattern as `[id]/page.tsx:220`.
3. **Create `lib/staffEditableFields.ts`**, modelled on `lib/memberEditableFields.ts`, with `STAFF_FIELD_GROUPS`. This is the mechanism that stops the record and the editor drifting — and it's what would have caught the dead `appointmentPrice`.
4. **One save boundary per tab, stated in the tab.** Access saves permissions. Pay saves compensation. Lessons may stay optimistic *if* the tab says "changes save as you toggle" — that sentence is the whole fix for §4.2.
5. **Access needs a confirm step, not a Save button.** Show the delta in plain words before writing: "Jordan will be able to see and edit every member's payment methods." Model it on the email-moves-the-login disclosure (mechanism 10). Then attribute the write (mechanism 9).
6. **Add the locked block.** Staff can't set their own password here; the modal currently explains this in 11px helper text mid-form. It belongs in a `LockedBirthdayRow`-style block that names who can and where.
7. **Overview must be curated, not a dump** — the mistake `[id]/page.tsx:637` records having already made and fixed. Suggest: identity + role, a one-line permission summary ("Coach · can edit attendance, can't see money"), current pay basis, and any problem dots.
8. **Keep a lightweight Add-staff modal.** Invitation is genuinely a short single task and `sheets.md › Best practices` supports a sheet for it. It's the *edit* path that needs a page. The existing `AddStaffModal` (`:258`) is already close.

---

## 5. Narrow-viewport survival

Reframed per §1.1: these are live defects in a shipped WebView, not future risks.

### 5.1 Critical — every sub-nav label in the sidebar fails contrast, in both themes

`DashboardSidebar.tsx` renders inactive **child** items at `color: "rgba(255,255,255,0.4)"`, `fontSize: 12`:

| Theme | Composite | On | Ratio | 4.5:1? |
| --- | --- | --- | --- | --- |
| Light | `#797A7B` (0.4 white over `#1F1F23`) | `#1F1F23` | **3.79:1** | ✗ |
| Dark | `#737376` (0.4 white over `#16161A`) | `#16161A` | **3.82:1** | ✗ |

**20 of the ~29 staff-facing destinations live in those child lists.** Parent items are fine (`rgba(229,231,235,0.72)` → 7.96:1). Fix: raise child inactive to at least `rgba(255,255,255,0.62)` and the size to 13px, matching parents. Full math in Appendix B.

### 5.2 Critical — Staff Schedule needs 1,070px minimum and gets 375

`staff/schedule/page.tsx:128–163` is a `<table>` in an `overflow-x-auto`:

- Staff column: `w-40` = **160px**, `sticky left-0`
- 7 day columns: `min-w-[130px]` × 7 = **910px**

**Minimum content width 1,070px.** At 375pt that's ~2.9 screens of horizontal scrolling inside a sticky-first-column table nested in a vertically scrolling main column — while `DashboardBottomNav` hides itself on scroll-down, so the primary nav disappears during the gesture. The sticky column is a genuine mitigation and should be kept in whatever replaces this, but a 7-day matrix has no honest narrow-viewport form. It needs a different view below `md` — one day at a time, or per-person.

### 5.3 High — type below the platform floor

`accessibility.md › Type sizes`: 11pt minimum on mobile, and avoid light weights at small sizes.

| File | `text-[10px]` | `text-[11px]` | `text-xs` (12px) |
| --- | --- | --- | --- |
| `staff/page.tsx` | **3** | **18** | 38 |
| `memberships/page.tsx` | 0 | 4 | 51 |
| `front-desk/page.tsx` | 0 | 4 | 2 |

The 10px instances are in `staff/schedule`'s row meta (`s.role === "OWNER" ? "Owner" : "Staff"`) and in the sidebar's uppercase "Staff view" badge. Ten-pixel uppercase text with `0.04em` tracking is below the floor at any contrast. The email under the sidebar wordmark is `fontSize: 11` — its contrast is fine (7.96:1) but its size isn't.

Note `text-xs` at 12px is *at* the web floor, not below it — but `readable-font-size` wants 16px body on mobile to avoid iOS auto-zoom on focus, and 51 instances on the Memberships page is a density decision worth revisiting rather than a violation to fix line by line.

### 5.4 High — the pages that skipped `PageHeader` are the pages that break

Direct consequence of §2a. The hand-rolled `<h1>` pages are fixed at `text-3xl` (30px) or `text-2xl` (24px) with no responsive step-down, and their action rows don't wrap — the exact tablet overflow `PageHeader`'s comment documents having fixed. Four of six Staff pages, plus Memberships, Front desk and all six Settings sub-routes, are in that set.

### 5.5 Medium — unguarded multi-column grids

Ten `grid-cols-2` / `grid-cols-3` with no responsive prefix, forcing 2–3 columns at 375pt:

```
staff/page.tsx         :380  :427  :937  :1005  :1286
memberships/page.tsx   :671
classes/page.tsx       :425  :611  :666  :1207
```

Five of them are inside the Edit Staff modal, which is already capped at 512px.

### 5.6 Medium — `100vh` on a WebView

`layout.tsx` uses `height: "100vh"` on the dashboard root. `viewport-units` prefers `min-h-dvh` on mobile — `100vh` doesn't account for iOS dynamic browser chrome. Safe-area handling elsewhere in this file is genuinely careful (`env(safe-area-inset-top)` on the topbar, `env(safe-area-inset-bottom)` on the bottom nav, `paddingBottom: pb-24` reserving room for the bar), which makes the `100vh` stand out as an oversight rather than a pattern.

### 5.7 Low — `overflowX: "hidden"` is load-bearing

`layout.tsx` carries this comment:

> *"safety net. CSS grid items inside `/dashboard` can briefly overflow at mount on iOS Safari … Clipping here prevents the body-level horizontal scroll bar users were seeing on the iOS native shell."*

Clipping the main column hides overflow rather than preventing it — including any future overflow that *should* have been caught in review. Worth a note in the handoff so the mockups don't assume it's a stylistic choice.

---

## 6. App Store Guideline 4.2 — what reads as a repackaged website

Added after the brief was updated: this ships inside a Capacitor shell to the App Store, and native-feeling navigation is a requirement.

**Bottom line: as configured today, this is the textbook shape App Review rejects under 4.2.** Not because the CSS looks web-ish — because the binary contains no web assets, loads a live website over HTTPS, and uses exactly one device capability (deep links). Guideline 4.2 asks for "features, content, and UI that elevate it beyond a repackaged website." Right now a reviewer can reach that conclusion from the build configuration alone, before opening a single screen.

I've split this into (6.1) the configuration signals, which are what actually decide a 4.2 review, and (6.2–6.4) the interaction tells, which are what you asked about. §6.5 is the affirmative case — what would earn the app its place, drawn from features this product already half-has.

Severity note: the configuration items are **Blocker** — they can fail review regardless of design quality, so no mockup fixes them. The interaction items are Critical/High and are design work.

### 6.1 Configuration — the four things a reviewer can see without opening the app

#### (a) Blocker — the app loads a remote URL; it ships no web assets

`capacitor.config.ts`:

```ts
const nativeServerUrl =
  process.env.CAPACITOR_SERVER_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "http://127.0.0.1:3000";
```

The comment confirms the production intent: `// Production: https://app.yourdomain.com via CAPACITOR_SERVER_URL`. So `server.url` is set in the shipped build and the WebView loads the live site. There is no `out/` or `dist/` bundled into `ios/App/App/public`.

This is the single strongest 4.2 signal there is. It also means the app's entire behaviour can change after approval without review, which reviewers watch for, and it means the app is unusable with no network — a 4.2 sub-point reviewers test directly by enabling Airplane Mode on first launch. Today that lands on `native-shell-error.html` ("Can't reach AthletixOS"), which is an honest error page and exactly the wrong first impression.

**Structural fix:** bundle the shell locally and point only the API at the remote origin. Next.js can emit a static shell for the native target while the dashboard's data continues to come from `/api/*` on the server. That is a build-pipeline change, not a design change, and it should be scoped before the mockups — because if the app keeps loading a remote URL, everything below is cosmetic.

#### (b) Blocker — one plugin, zero device capabilities

Installed Capacitor packages:

```
@capacitor/core  @capacitor/cli  @capacitor/ios  @capacitor/android  @capacitor/app
```

That's it. `@capacitor/app` is the only plugin, and `components/NativeDeepLinks.tsx` uses it for one thing — `appUrlOpen`. There is no haptics, status bar, splash screen, keyboard, preferences, push notifications, camera, share, filesystem or network plugin. `capacitor.config.ts` has **no `plugins` block at all**.

An app that uses no capability the browser doesn't already have is, by 4.2's own wording, a repackaged website. This is the finding to fix first. §6.5 lists candidates.

#### (c) High — `limitsNavigationsToAppBoundDomains: false`

`capacitor.config.ts:112`. Combined with a remote `server.url`, this is the configuration signature of a wrapper: the WebView is permitted to navigate off the app's declared domains. The allow-list logic above it is careful and well-commented, and the dev-mode permissiveness is justified in the comments — but the production posture is looser than an app that ships its own assets ever needs to be.

#### (d) Medium — permission strings declared for capabilities nothing uses

`ios/App/App/Info.plist` declares both:

```
NSCameraUsageDescription
NSPhotoLibraryUsageDescription
```

Nothing in the app uses either natively. `components/ImageUpload.tsx` and the staff/member photo flows go through a web `<input type="file">`, which needs no usage string. So the app asks for two capabilities it doesn't implement.

Two costs: App Review routinely asks why a declared permission is needed and rejects when the answer is "it isn't"; and it's the inverse of the 4.2 problem — the manifest claims native integration the code doesn't have. Either wire the camera (see §6.5, the QR scanner is the obvious one) or remove the strings.

### 6.2 Navigation — a hamburger where a tab bar belongs

You named this one, and it's correct, but the specific shape is worse than "there's a hamburger."

**There are two primary navigation systems on the phone at once.** `app/dashboard/layout.tsx` renders, simultaneously:

- a `Menu` button in the sticky topbar that opens `DashboardMobileDrawer` (the full 13-item, 29-destination tree), and
- `DashboardBottomNav`, a 5-slot bar: `Home · Members · Desk · Money · More`, where `More` opens the same drawer.

So the hamburger and the tab bar's last slot do the same thing, and `ui-ux-pro-max §9 avoid-mixed-patterns` is violated literally: Tab + Drawer at the same hierarchy level.

**The distribution is the real problem.** 4 of ~29 destinations are in the tab bar. The remaining ~25 — including every Staff screen, Classes, Events, Calendar, Attendance, Reports, Documents, all of Communication and all of Settings — are reachable *only* through a drawer. `tab-bars.md › Best practices` is direct about the shape to avoid: overflow into a More tab. Here More isn't overflow, it's the app.

Related findings:

- **Critical — `BackButton` is browser chrome in a native app.** `layout.tsx` renders `<BackButton fallbackHref="/dashboard" />` in both the mobile and desktop topbars on every path except `/dashboard`. A persistent "← Back" text button in a toolbar is the most recognisable web-wrapper tell after the hostname dialog. Native apps get back from the navigation stack and a leading-edge swipe.

  It's also functionally unreliable here. `BackButton.tsx` gates on:

  ```tsx
  setCanPop(window.history.length > 1 && document.referrer !== "");
  ```

  `document.referrer` is empty for the first navigation in a WKWebView loading a remote origin, and for any deep link handled by `NativeDeepLinks`. When it's empty, `canPop` is false and Back silently becomes `router.push("/dashboard")` — a jump to home from a screen with real history behind it. `navigation-patterns › back-stack-integrity`: *"Never silently reset the navigation stack or unexpectedly jump to home."*

- **Critical — no swipe-back, anywhere.** The only touch handlers in the entire product are `onTouchStart/Move/End` in `components/events/EventImageFocalPicker.tsx`. There is no leading-edge swipe to pop, no swipe-to-dismiss on `DashboardMobileDrawer`, no swipe-to-dismiss on any of the 30 hand-rolled modals, no swipe actions on any list row, and no pull-to-refresh on any of the data-heavy pages. `gesture-nav-support` and `standard-gestures` both fail. A reviewer's first instinct on any screen is to swipe from the left edge; nothing happens.

- **High — Android hardware back is unhandled.** `NativeDeepLinks` registers a listener for `appUrlOpen` only. `@capacitor/app` also emits `backButton`, and nothing subscribes. Without it, the hardware/gesture back on Android can exit the app from a deep screen rather than popping. (Android's predictive back also needs the manifest opt-in.)

- **High — the tab bar hides itself on scroll.** `DashboardBottomNav` translates off-screen on scroll-down:

  ```tsx
  if (y < 40) setHidden(false); else setHidden(dy > 0);
  ```

  iOS tab bars are persistent; this is a web pattern (content-maximising sticky header behaviour). It also means the primary nav is gone during exactly the gesture §5.2's 1,070px-wide schedule table forces. `persistent-nav`.

- **Medium — deep links hard-reload the document.** `NativeDeepLinks.tsx` routes with `window.location.href = path`. That's a full document load: white flash, no transition, state lost. In a native app it reads as a page refresh. Should be `router.push()`.

- **Low, and to its credit — `DashboardMobileDrawer` is the one modal built correctly.** It has `role="dialog"`, `aria-modal="true"`, Escape handling, backdrop dismissal and body-scroll lock. It is the `1 of 30` from §2c. **The primitive you need already exists in this codebase** — extract it as `components/Sheet.tsx`, add swipe-to-dismiss and a grabber (`sheets.md › Best practices`), and retire the other 29 hand-rolled shells against it. That single extraction closes §2c, §4.3 and most of this subsection at once.

### 6.3 Critical — 71 `confirm()` / `alert()` calls put your domain name in a system dialog

This is the most legible "this is a website" tell in the product, and it's the one I'd fix first among the design items.

71 calls to `confirm()` / `alert()` across 20+ dashboard files:

| File | Calls | File | Calls |
| --- | --- | --- | --- |
| `financials/page.tsx` | 6 | `memberships/page.tsx` | 5 |
| `members/approvals/page.tsx` | 6 | `members/[id]/billing/page.tsx` | 5 |
| `privates/page.tsx` | 5 | `announcements/page.tsx` | 5 |
| `settings/page.tsx` | 3 | `staff/page.tsx` | 3 |
| `staff/contractors/page.tsx` | 3 | `staff/payouts/page.tsx` | 2 |
| `attendance/page.tsx` | 2 | `members/[id]/page.tsx` | 2 |
| …plus 8 more files at 1–2 each | | | |

Example, `memberships/page.tsx:186`:

```tsx
if (!confirm("Delete this discount code?")) return;
```

In WKWebView, `confirm()` renders the **system JavaScript dialog, titled with the page's host**. A reviewer tapping Delete sees a UIAlertController reading approximately *"app.athletix-os.com wants to…"* — the domain name, rendered by iOS, in a native dialog, on a screen that is supposed to be an app. There is no styling fix; it's the platform telling the truth about what it's running.

Three separate rules fail here at once:

- `alerts.md › Best practices`: alerts are rare and *"never used for common undoable actions."* Deleting a discount code is a routine, undoable action.
- `undo-and-redo.md` / `undo-support`: the right pattern is optimistic delete plus an "Undo" toast, which removes the dialog entirely and is faster for staff.
- `destructive-emphasis`: a system dialog can't carry the danger colour or separate the destructive action from Cancel.

**Fix:** one `ConfirmDialog` built on the extracted `Sheet` for the genuinely destructive-and-irreversible cases (delete club, delete a member), and an Undo toast for everything else. `confirm()` should reach zero. That's a guard-able number, in the style of `sport-terms-guard.ts` — a `no-native-dialogs` guard over `app/` and `components/` would hold the line the way the vendor-literal guard does.

### 6.4 Loading and session

#### High — 43 files render bare "Loading…" text

63 occurrences of a plain `>Loading` text node across 43 files, against 25 files using `components/LoadingSkeleton.tsx`. The entire Staff section is in the first group — all six pages, since five import no shared components at all (§2).

`app/dashboard/layout.tsx` sets the tone at the top level:

```tsx
<div style={{ fontSize: 14, color: MUTED }}>Loading…</div>
```

A centred grey "Loading…" on a blank screen is a web idiom. Native expectation (`loading.md`, `progressive-loading`) is that *something* structural appears immediately — a skeleton in the shape of the content. The skeleton component exists; it's adopted on half the app.

Two specific spots matter more than the rest, because they're what a reviewer sees first:

- **App launch.** No `SplashScreen` plugin and no `plugins` config, so the gap between launch and first paint is whatever the network gives you — on a remote `server.url`, that's a full page load. A reviewer on a cold start sees a blank or white WebView. `launching.md`: launch instantly.
- **Post-login.** `layout.tsx` gates `/api/me` on `status === "authenticated"` and renders the "Loading…" div until the session resolves, then fetches permissions, then renders nav. Three sequential states before the app is usable.

#### High — login doesn't persist the way a native app's does

`lib/auth.ts:22`:

```ts
session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 14 },
```

Fourteen days, then a cold re-login. No refresh-on-use (`updateAge` isn't set), no biometric re-auth, no Keychain-held token — the session is a cookie in a WebView, so it's also subject to WebKit's storage eviction under pressure and to a data-and-history clear. Native apps are expected to stay signed in indefinitely and to re-authorise with Face ID, not a typed password.

Credit where due: `app/login/page.tsx` sets `autoComplete="email"` and `autoComplete="current-password"`, so iOS password autofill and Keychain work properly (`autofill-support`). The `autoComplete="off"` on the club-slug field is deliberate and explained in a comment. The login form itself is fine — it's the session lifetime and the absence of biometric re-entry that read as web.

#### Medium — the known WKWebView cookie race leaks the permission boundary

`app/dashboard/layout.tsx` documents it:

> *"the fetch can race the NextAuth cookie commit (especially in WKWebView and Safari) — the API returns 401, we silently swallow, and STAFF users see the full nav instead of their filtered nav until the next page navigation."*

The `status !== "authenticated"` gate is the mitigation and it's the right one. But the failure mode it describes — a `.catch(() => {})` that swallows a 401 and leaves `me` null, and `DashboardSidebar` treating `role !== "STAFF"` as "show everything" — means any *other* failure of `/api/me` (offline, timeout, 500) fails open. A staff member sees Financials, Payroll and Settings in the nav; tapping them 403-redirects. That's a flicker of someone else's permissions on a flaky network, which on a phone is most of the time.

Fix: default the nav to the *narrowest* view until `/api/me` resolves, and render a skeleton nav rather than a full one. Fail closed.

### 6.5 What would actually satisfy 4.2 — the affirmative case

4.2 isn't satisfied by removing web tells; it's satisfied by doing something a website can't. Five candidates, ranked by how much this product already leans toward them:

1. **Native QR scanning at the door.** The Front desk nav icon is literally `ScanLine` and the page doesn't scan anything — it's a text search (§3.1). Meanwhile `/c/[id]` and `/kiosk/[id]` routes already exist for door codes, and `NativeDeepLinks` already handles the `/c/...` Universal Link. A camera-based scanner is the single most natural native feature here, it justifies the two `Info.plist` strings you already declare (§6.1d), and it makes the phone app strictly better than the website at the job it's built for.
2. **Push notifications.** Approvals waiting, a failed payment, a class cancellation, a substitute request. `lib/actionCenter.ts` already computes exactly this queue, and `NotificationBell` already renders it in-app. Push is the difference between an app you keep and a bookmark. Strongest 4.2 argument after the scanner.
3. **Offline check-in.** `components/OfflinePaymentsCard.tsx` and `lib/eventOfflinePayments.ts` mean the domain already has an offline-money concept. A queued check-in that syncs on reconnect is a real capability, and it directly answers the Airplane-Mode test from §6.1a.
4. **Haptics on confirmation.** One line per action with `@capacitor/haptics`. Cheap, and `haptic-feedback` is the thing that makes a check-in *feel* native. Pairs with replacing `confirm()` (§6.3).
5. **Biometric unlock** over a Keychain-stored token, replacing the 14-day cold re-login (§6.4).

Plus the table stakes: `@capacitor/splash-screen` and `@capacitor/status-bar` configured in a `plugins` block, and `@capacitor/keyboard` so the 52px Front-desk buttons aren't covered when the search field focuses.

### 6.6 Navigation structure for the native shell

§3.3's tree collapses to 9 top-level sections, which is what makes a real tab bar possible. Proposed native structure:

```
Tab bar (persistent, never auto-hides, 5 slots — the platform ceiling)

  Home        /dashboard          today's sessions, action centre
  People      /dashboard/people   members + team, segmented
  Check-in    /dashboard/check-in Door mode by default on phone; native scanner
  Money       /dashboard/money    overview, pay runs, recorded payouts
  More        /dashboard/more     a LIST SCREEN, not a drawer
```

Four deliberate changes from today:

- **No hamburger.** The topbar `Menu` button goes. Two primary navigation systems become one.
- **"More" is a pushed list screen, not a drawer.** A drawer is a web pattern; a More tab that pushes a grouped table view is the iOS convention (`tab-bars.md`, `lists-and-tables.md`). Same destinations, native shape, and it gets a title and a back stack for free.
- **`BackButton` is deleted on mobile** and replaced by the nav stack plus leading-edge swipe. Keep it on desktop where a toolbar back control is conventional.
- **The tab bar never hides.** Remove the scroll handler.

Settings gets a real `app/dashboard/settings/layout.tsx` (§3.2(4)) so its six sub-routes push and pop within a section instead of navigating away from their own nav — which on a phone is the difference between a settings section and a set of unrelated web pages.

### 6.7 Pre-submission checklist

Things a reviewer will do in the first two minutes, and what currently happens:

| Reviewer action | Today | Needs |
| --- | --- | --- |
| Launch with Airplane Mode on | `native-shell-error.html` — "Can't reach AthletixOS" | Bundled shell + offline state (§6.1a, §6.5.3) |
| Cold launch, watch the splash | No `SplashScreen` config; blank WebView until the network returns | `@capacitor/splash-screen` (§6.4) |
| Swipe from the left edge | Nothing | Swipe-back (§6.2) |
| Tap a destructive action | System dialog titled with your hostname | `ConfirmDialog` + Undo toast (§6.3) |
| Look for a tab bar | Tab bar *and* a hamburger; 25 of 29 destinations behind the hamburger | One tab bar, More as a list screen (§6.6) |
| Pull down to refresh | Nothing | Pull-to-refresh on the data pages |
| Rotate to landscape | Untested; `100vh` root (§5.6) | `min-h-dvh`, verified landscape |
| Background and return after a week | Works (14-day JWT) | Fine; after 14 days, a cold password re-login (§6.4) |
| Ask "what does this do that the website doesn't?" | **Nothing** | §6.5 |

The last row is the one that decides the review.

---

## 7. Templated or unconsidered

You asked to hear it now.

### 7.1 The sidebar is styled inline, in JavaScript, with hand-rolled hover handlers

`DashboardSidebar.tsx` is 413 lines, and its entire visual language is inline `style={{}}` objects plus four `onMouseEnter`/`onMouseLeave` pairs that mutate `e.currentTarget.style` directly. This is the app's most-seen component and it is the least systematised. Three consequences:

- **No `:focus-visible`.** Hover is simulated in JS; focus has no styling at all. Keyboard navigation through the primary nav is invisible (`focus-states`, Critical).
- **No `:hover` media query**, so touch devices get sticky hover states after a tap.
- **Token drift.** `TEXT_DIM = "rgba(229,231,235,0.72)"` and the `rgba(255,255,255,0.4)` child colour are literals defined in this file, outside `globals.css`. The Members handoff explicitly instructs: *"do not hand-write hex values where a token exists."* The nav doesn't follow its own design system.

### 7.2 Georgia is the brand, and it's used once

`fontFamily: "Georgia, serif"` appears exactly twice — the sidebar wordmark and the mobile topbar wordmark. Everything else is Inter. The Members handoff makes this explicit: *"`Georgia, serif` only for the 'AthletixOS' wordmark. No other families."*

That's a defensible call — system type for controls, brand in display text (`branding.md`). But it means the product's entire typographic identity is a 15px word in the corner. `apple-design`'s craft lens asks what this design would be remembered by; on the Staff screens the answer is currently nothing. There's a real opportunity here that isn't a redesign: Georgia at a display size on the few screens that deserve a moment — an empty Directory, a completed pay run, the Overview of a staff profile. One signature, spent in one place.

### 7.3 `text-brand` on `#F7F7F9` is a 1.5% margin from failing

`#6B7280` (`--color-muted`) on `--color-bg` `#F7F7F9` measures **4.52:1** against a 4.5:1 requirement. Any darkening of the background or lightening of the muted token breaks the most-used text pair in the product. Worth pinning with a test rather than leaving to chance.

### 7.4 The lime accent is defined as "success" and used as "active"

`--color-success: #A3E635` is lime. `DashboardBottomNav` uses it as the **active tab indicator**:

```tsx
style={{ color: active ? "var(--color-lime-accent, #A3E635)" : undefined }}
```

So the same colour means "this succeeded" and "you are here" (`color.md`: one colour means one thing). Note also the fallback-inside-a-var pattern — `var(--color-lime-accent, #A3E635)` — which means `--color-lime-accent` may not exist and the literal is doing the work. The active *sidebar* item uses `--color-primary` instead, so the two navs disagree about what "active" looks like.

### 7.5 Icon semantics are approximate

`lib/dashboardNav.ts` assigns `Shield` to Staff and `CheckSquare` to Attendance. Shield reads as security or permissions, not people — and given that Staff is where permissions are actually edited, the icon is accidentally accurate for the wrong reason. `ScanLine` for Front desk implies barcode scanning; the page does name search and a door decision, no scanning. Under the §3.3 tree these want: Team → `Users` or `UserCog`, Check-in → `UserCheck`, Money → `DollarSign`.

The file's own comment shows the icon system was considered carefully where it counted:

> *"Icons are lucide-react component references (NOT unicode glyphs). iOS WebKit doesn't have most geometric unicode glyphs in its fallback font chain — they render as '?' tofu boxes inside the native shell."*

Which makes the bare `×` close button in the Edit Staff modal (§4.3) a direct violation of a rule this codebase learned the hard way.

### 7.6 The Staff badge says "Staff view" and the Settings link says "Staff"

The sidebar shows staff members a `Staff view · {title}` chip. Under §3.3's rename to "Team," that chip and the six-plus "Add staff in Settings → Staff & Permissions" strings scattered through the code need a sweep. Note `/dashboard/schedule:283` already points at a destination that doesn't exist by that name: *"Add staff in Settings → Staff & Permissions."* There is no such screen — Settings' Staff link goes to `/dashboard/staff`. Stale instructional copy on an orphaned page.

### 7.7 Two permission scopes describe the shape you're being asked to fix

`lib/permissions.ts:59–73`:

```ts
{ key: "schedule", label: "Staff schedule",  description: "View / edit the staff schedule & availability" }
{ key: "finances", label: "Financials & payroll", description: "Revenue, transactions, payouts" }
```

Both scopes already treat the pairs as single concerns — schedule *and* availability under one key, financials *and* payroll *and* payouts under one key. **The authorization model has already merged what the navigation keeps apart.** That's the strongest internal argument for §3.3: the permission layer is the IA you want, and the sidebar is the outlier.

One knock-on: the `events` scope covers *"Manage events, memberships, products"* and gates `/dashboard/purchase-options`, `/dashboard/memberships`, `/dashboard/privates` and `/dashboard/products` identically. Under a Catalog section that's coherent; today the label says "events" and gates four non-event screens.

---

## 8. The sport-terms constraint, and one gap in the guard

`npm run test:sport-terms` gates the build. I read `scripts/sport-terms-guard.ts` in full. Two notes for whoever implements the mockups.

**None of the proposed labels in §3.3 trip it.** The nine patterns target feature vocabulary — wrestle-as-a-verb, weight class, duals, takedown, singlet, grappling, belt level, weigh-in, bout/mat assignment. Team, Check-in, Catalog, Plans, Lessons, Pay runs, Recorded payouts, Taking payments, Your subscription, Mobile app, Terminology are all clean. "Privates" → "Lessons" is a readability change, not a compliance one.

**But the guard cannot see the file the renames land in.**

```ts
const SCAN_DIRS = ["app/dashboard", "app/member", "app/e", "components"];
```

`lib/` is not scanned. And `lib/` is where the user-facing nav copy lives:

| File | User-facing strings it holds |
| --- | --- |
| `lib/dashboardNav.ts` | **every sidebar and bottom-nav label** — the exact strings an IA rename changes |
| `lib/payouts.ts` | `PAYEE_TYPE_LABELS`, `PAYOUT_KIND_LABELS`, `PAYOUT_METHODS` |
| `lib/permissions.ts` | `PERMISSION_CATALOG` labels and descriptions, rendered in the staff editor |
| `lib/reportsRevenue.ts` | revenue row labels, e.g. `"Membership dues"` |

So the guard protects the screens but not the navigation to them. The guard's own header explains why a hole like this matters — it documents the wrestling-shaped form that *shipped once already* because sport terms in placeholders read as helpful copy. Nav labels are exactly that kind of surface.

**Recommendation, as a prerequisite to the rename commit rather than part of the redesign:** add `lib` to `SCAN_DIRS`. The guard strips comments before matching, so the long explanatory headers in these files are already safe. If a full `lib/` scan is too broad, an explicit allowlist of copy-bearing files (`dashboardNav.ts`, `payouts.ts`, `permissions.ts`, `reportsRevenue.ts`, `membershipOptions.ts`, `eventCategories.ts` excepted per its existing rationale) gets the coverage without the noise. I have not made this change — it's code, and this is a read-only pass.

---

## 9. Priority order for the handoff

Sequenced **ship-blockers → accessibility → conventions → craft**, per `apple-design`'s improvement mode. Two labels matter:

- **Blocker** — can fail App Review under Guideline 4.2 regardless of design quality. No mockup fixes these; they're build-pipeline and native-integration work, and they should be scoped in parallel with the design pass rather than after it.
- ***not a design task*** — a code or config fix that the mockups depend on but don't contain.

### Tier 0 — App Review blockers (§6)

| # | Item | § |
| --- | --- | --- |
| B1 | App loads a remote `server.url`; binary ships no web assets; unusable offline — *not a design task* | 6.1a |
| B2 | One Capacitor plugin, zero device capabilities. Needs a real native feature: QR scanner, push, offline check-in | 6.1b, 6.5 |
| B3 | Hamburger **and** tab bar at the same level; 25 of ~29 destinations reachable only via the drawer | 6.2, 6.6 |
| B4 | 71 `confirm()`/`alert()` calls render a system dialog titled with your hostname | 6.3 |
| B5 | No swipe-back, no swipe-to-dismiss, no pull-to-refresh anywhere in the product | 6.2 |
| B6 | `limitsNavigationsToAppBoundDomains: false` with a remote server URL — *not a design task* | 6.1c |
| B7 | `Info.plist` declares camera + photo-library permissions nothing uses — wire them or remove them | 6.1d |

### Tier 1 — Critical

| # | Item | § |
| --- | --- | --- |
| 1 | "Cancel" in Edit Staff doesn't cancel — lesson-type toggles persist immediately | 4.2 |
| 2 | Sidebar child labels at 3.79:1 / 3.82:1, 12px — 20 of 29 destinations | 5.1 |
| 3 | `text-brand` `#6D5DF6` not redefined for dark mode — 3.76:1 / 4.16:1 | 4.3, B |
| 4 | Modals: 0/30 `aria-modal`, 1/30 `role="dialog"`, 1/30 Escape, no focus trap. **Extract `DashboardMobileDrawer` as `Sheet`** — the correct primitive already exists | 2c, 4.3, 6.2 |
| 5 | No `:focus-visible` anywhere in the primary nav | 7.1 |
| 6 | `BackButton` is browser chrome, and `document.referrer` gating makes Back silently jump to home in the WebView | 6.2 |
| 7 | Same page at two URLs; sidebar blanks on arrival via global search or a revenue drill-down | 3.2(1) |
| 8 | `/dashboard/schedule` — live orphan editing real availability, titled with its sibling's name | 3.2(2) |
| 9 | Staff Schedule needs 1,070px minimum; shipped to a 375pt WebView | 5.2 |

### Tier 2 — High

| # | Item | § |
| --- | --- | --- |
| 10 | Edit Staff modal → `/dashboard/team/[id]` with tabs, on the member-profile precedent | 4.5 |
| 11 | Android hardware back unhandled (`@capacitor/app` `backButton` unsubscribed) — *not a design task* | 6.2 |
| 12 | Tab bar hides on scroll-down; iOS tab bars are persistent | 6.2 |
| 13 | 43 files render bare "Loading…"; no splash-screen config; blank WebView on cold launch | 6.4 |
| 14 | Session is a 14-day cookie in a WebView; no refresh-on-use, no biometric re-auth | 6.4 |
| 15 | Payroll `<h1>` claims both names; no handoff between the two money surfaces | 1.2 |
| 16 | Settings is a competing nav; 3 of 6 labels ≠ destination `<h1>`; needs a `layout.tsx` | 3.2(4), 6.6 |
| 17 | Plan & Billing vs Stripe vs Payments vs "ClubOS billing" — two money directions, four names | 3.1 |
| 18 | App Design / Branded App / Branded mobile app / Branded app editor — one route, four names | 3.1 |
| 19 | Discount codes buried under Plans, contradicting `Discount.appliesTo` | 3.2(3) |
| 20 | Attendance + Front desk → one adaptive Check-in | 3.1, 6.6 |
| 21 | `PageHeader` adoption 15/51; three h1 sizes for one semantic level | 2a, 5.4 |
| 22 | Add `lib` to the sport-terms guard **before** the rename commit — *not a design task* | 8 |
| 23 | 10px/11px type in `staff/page.tsx` (3 + 18 instances) | 5.3 |
| 24 | Conditional permission sections inject layout mid-scroll with no signal | 4.4 |
| 25 | `/api/me` failure fails **open** — staff briefly see nav they can't access | 6.4 |

### Tier 3 — Medium and Low

| # | Item | Severity | § |
| --- | --- | --- | --- |
| 26 | Deep links hard-reload via `window.location.href` instead of `router.push` | Medium | 6.2 |
| 27 | 10 unguarded `grid-cols-2/3` at 375pt (5 inside the Edit Staff modal) | Medium | 5.5 |
| 28 | 29 nav-unreachable routes; Custom Fields reachable only via Settings | Medium | 3.2(5) |
| 29 | 13 top-level items; three of them are "money"; mixed capitalization in one nav | Medium | 3.2(6) |
| 30 | Lime is both "success" and "active"; the two navs disagree on what active looks like | Medium | 7.4 |
| 31 | Sidebar styled with inline JS objects; tokens defined outside `globals.css` | Medium | 7.1 |
| 32 | `100vh` → `min-h-dvh` on the WebView root — *not a design task* | Medium | 5.6 |
| 33 | Dead `appointmentPrice` round-trips through every staff save — *not a design task* | Low | 4.4 |
| 34 | Icon semantics: Shield→Team, ScanLine→Check-in (and make ScanLine true) | Low | 7.5, 6.5 |
| 35 | Georgia used once; no signature element on any Staff screen | Low | 7.2 |
| 36 | `#6B7280` on `#F7F7F9` at 4.52:1 — 1.5% margin, pin it with a test | Low | 7.3 |
| 37 | Stale copy: "Settings → Staff & Permissions" names no existing screen | Low | 7.6 |
| 38 | `overflowX: hidden` on the main column hides overflow rather than preventing it | Low | 5.7 |

### What to hand Claude Design, and what to route elsewhere

**To the design pass:** Tier 1 items 1–6 and 8–9, all of Tier 2 except 11/22/25, the §3.3 tree, the §4.5 staff profile, and §6.6's native navigation structure. The two extractions that do the most work per unit of effort are `Sheet` (from `DashboardMobileDrawer`) and `lib/staffEditableFields.ts` (from `lib/memberEditableFields.ts`) — both are patterns this codebase already got right once.

**To engineering, before or alongside:** B1, B2, B6, B7, and items 7, 11, 22, 25, 32, 33. None of these are design decisions, and B1 in particular determines whether the rest is worth doing — if the shipped app keeps loading a remote URL, the navigation work improves the product but doesn't move the review.

---

## Appendix A — Route inventory

### A.1 Nav-reachable (`lib/dashboardNav.ts`)

13 top-level entries; 6 are groups containing 20 children.

| Top level | Children |
| --- | --- |
| Dashboard | — |
| Members | All members · Migration · Approvals |
| Staff | Directory · Guest & Contractors · Schedule · Availability · Payroll · Payouts |
| Purchase Options | Memberships · Privates · Products |
| Classes & Events | Classes · Events · Calendar |
| Communication | Messaging · Announcements · Campaigns · Drafts · Email sends · Templates · Audiences · Unsubscribes |
| Front desk | — |
| Attendance | — |
| Financials | — |
| Reports | — |
| Documents | — |
| Settings | — |

Plus four fixed items rendered outside `NAV`: theme toggle, My account, Client view, Need help?. Every `NAV` href resolves to a page — no dead nav entries.

### A.2 Not reachable from the sidebar (29)

**Deliberate redirects (keep — good hygiene):**
`/dashboard/approvals` → `members/approvals` · `/dashboard/purchase-options` → `purchase-options/memberships`

**URL aliases of nav pages (§3.2(1) — resolve to one):**
`/dashboard/memberships` · `/dashboard/privates` · `/dashboard/products`

**Stale duplicate (§3.2(2) — redirect or delete):**
`/dashboard/schedule`

**Genuinely orphaned features (adopt into the tree):**
`/dashboard/custom-fields` (only via Settings sidebar) · `/dashboard/members/duplicates` · `/dashboard/members/roster` · `/dashboard/events/bundles`

**Settings sub-routes (need a `layout.tsx`):**
`settings/club` · `settings/billing` · `settings/branded-app` · `settings/email` · `settings/diagnostics` · `settings/member-form`

**Detail / child routes (correct as-is):**
`members/[id]` · `members/[id]/billing` · `events/[id]/roster` · `products/[id]/tags` · `products/bookings` · `products/inventory` · `communication/campaigns/[id]` · `communication/results/[batchId]` · `reports/imports` · `reports/imports/[batchId]`

**Shell utilities (correct as-is):**
`my-account` · `preview` · `help`

### A.3 The ten screens in the brief, mapped

| Screenshot | Route | Lines | `PageHeader`? | Shared components |
| --- | --- | --- | --- | --- |
| Sidebar | `components/DashboardSidebar.tsx` | 413 | n/a | none (inline styles) |
| Staff Schedule | `staff/schedule` | 491 | ✗ | none |
| Staff Availability | `staff/availability` | 414 | ✗ | none |
| Payroll & Payouts | `staff/payroll` | 345 | ✗ | none |
| — | `staff/payouts` | 393 | ✓ | `PageHeader` |
| Staff Directory | `staff` | 1,375 | ✓ | `PageHeader`, `EmptyState`, `LoadingSkeleton`, `ImageUpload` |
| Edit Staff modal | `staff/page.tsx:484–760` | 277 | n/a | `ImageUpload` |
| Classes | `classes` | 1,259 | ✓ | `PageHeader`, `LoadingSkeleton` |
| Memberships + discounts | `memberships` | 1,371 | ✗ | `BulkPriceChangeModal` |
| Settings sidebar | `settings/page.tsx:175–232` | — | ✓ (page) | local `NAV` const |

## Appendix B — Contrast measurements

WCAG 2.1 relative luminance, computed from the hex values in `app/globals.css` and the inline literals in `DashboardSidebar.tsx`. Thresholds: 4.5:1 for text under 18pt (or under 14pt bold), 3:1 for larger text and for non-text UI components.

### B.1 Failures

| Foreground | Background | Ratio | Needs | Where |
| --- | --- | --- | --- | --- |
| `#6D5DF6` (`text-brand`) | `#1A1A1F` (dark `--color-surface`) | **3.76:1** | 4.5:1 | active profile tab (13.5px), every `text-brand` link |
| `#6D5DF6` | `#0F0F12` (dark `--color-bg`) | **4.16:1** | 4.5:1 | same, on page background |
| `rgba(255,255,255,0.4)` → `#797A7B` | `#1F1F23` (light sidebar) | **3.79:1** | 4.5:1 | inactive sidebar child labels, 12px |
| `rgba(255,255,255,0.4)` → `#737376` | `#16161A` (dark sidebar) | **3.82:1** | 4.5:1 | same |

`--color-primary` is defined once in `:root` and **not** redefined in the `[data-theme="dark"]` block, which redefines bg, surface, border, text, muted, both sidebar colours and the full warn/danger semantic pairs. It is the only brand-critical token left out.

### B.2 Passes, two of them narrowly

| Foreground | Background | Ratio | Needs | Note |
| --- | --- | --- | --- | --- |
| `#6B7280` (`--color-muted`) | `#FFFFFF` | 4.83:1 | 4.5:1 | ok |
| `#6B7280` | `#F7F7F9` (`--color-bg`) | **4.52:1** | 4.5:1 | 1.5% margin — pin with a test (§7.3) |
| `#6D5DF6` | `#FFFFFF` | **4.62:1** | 4.5:1 | 2.7% margin |
| `#9CA3AF` (dark `--color-muted`) | `#1A1A1F` | 6.83:1 | 4.5:1 | ok |
| `rgba(229,231,235,0.72)` → `#ABACB0` | `#16161A` | 7.96:1 | 4.5:1 | parent nav items — the child colour should match this |
| `#6D5DF6` (active border) | `#16161A` | 3.91:1 | 3:1 | non-text UI component — ok |

Size failures are independent of contrast: `text-[10px]` (3 instances in `staff/page.tsx`) and the sidebar's `fontSize: 10` uppercase badge fall below the 11pt floor regardless of what colour they are.

### B.3 Not measurable from source

Rendered line length, real truncation behaviour at a given width, and actual overflow points need a running instance at 375 / 768 / 1024 / 1440 with the largest Dynamic Type setting. The widths in §5.2 and §5.5 are computed from the declared CSS, which is a floor, not the rendered result.
