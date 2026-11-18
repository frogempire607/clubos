# Crash audit — sheets that close by themselves, screens that crash

2026-11-18 · branch `claude/dashboard-modal-crash-audit-6a2aed` · not pushed, not deployed

**The report:** across the dashboard, pop-ups and sheets sometimes close on
their own, or a screen crashes or resets. Known example: open a member profile,
edit a guardian's name, and the sheet closes — sometimes several times.

**What it turned out to be:** not background refreshes. The app has no polling
and no auto-refresh that replaces data under a form. It was four mistakes
written separately in a few dozen components, one connection-recovery feature,
and — found by opening every page — three screens that crashed outright.

## How this was checked

| Method | Coverage | Limits |
|---|---|---|
| **Source guard** (`scripts/sheet-stability-guard.ts`, `scripts/hooks-order-guard.ts`) — parses every component | Every `.tsx` under `app/` and `components/` | Sees shapes, not behaviour |
| **Browser crawl** (`scripts/browser-crash-audit.ts`) — a real Chrome against a local build with fake data | 69 pages at desktop size and 69 at phone size; 48 / 52 sheets opened and probed | Up to 12 distinct buttons per page. Buttons that delete, send, charge, refund, approve or export are never pressed. A sheet opened from inside another sheet is not reached. 4 pages had no local record to open (a campaign, a product's tags, a member-side event and product). 6 addresses only redirect. |
| **Production logs**, read-only | Netlify request logs | The plan keeps **24 hours**, not 14 days |

Each sheet the crawl opened was put through: typing in its first field; a tap
on its own heading; the window losing and regaining focus; the network dropping
and returning; the window shrinking as a phone keyboard would; and (desktop) a
text selection dragged out past the edge of the panel.

Crawl findings, before → after the fixes: **desktop 29 → 2, phone 23 → 2.** The
2 that remain are the same thing at both sizes and are expected: "Connect
Stripe" answers 500 locally because the local server has no Stripe key, on
purpose.

## Part 1 — sheets that close by themselves

### 1. A text selection dragged past the panel edge closes the sheet — **the reported bug**

**Cause.** 22 modals and drawers put `onClick={onClose}` on the full-screen
element that also *contains* the panel. Press inside a field, drag to select
the text, let go a few pixels outside the panel: the browser reports a click on
the nearest element containing both points, which is that container. The sheet
closes. In the member edit drawer the panel is 560px of a 1280px window, so a
leftward drag over a name ends on the backdrop easily. With nothing typed yet
it closed silently; with something typed it asked "Discard your unsaved
changes?". Reproduced in a browser before any change. On a phone the same
thing happens when the keyboard closes between finger-down and finger-up and
the page shifts under the tap.

**Fix, once.** `backdropDismiss(onClose)` in `lib/overlay.ts`: a sheet closes
only when the press both started and ended on the backdrop itself. Applied to
all 22, and to the shared `Sheet`.

| Where | |
|---|---|
| Member profile | Edit member drawer · membership panel sheet · password reset dialog |
| Members list | Filters sheet · migration drawer · migration history drawer · migration detail drawer · duplicate merge preview |
| Events | Event editor · attendees · the ⋯ action sheet |
| Products | Product editor · sell (both screens) · add booking |
| Financials / reports | Asset sheet · report drill-down · date-range sheet |
| Member portal | More sheet · subscribe · manage booking |
| Shared | QR code |

### 2. Escape closed two things at once

**Cause.** 11 components each listened for Escape on the whole document. With
a question open over a sheet — "Discard your unsaved changes?" over the edit
drawer — one key press answered the question *and* reached the drawer under
it. In the edit drawer that asked the same question again, which is the
"closes on me several times" half of the report. The shared `Sheet` did the
same, so any confirm or prompt dialog opened over a sheet had it.

**Fix, once.** A layer stack in `lib/overlay.ts` (`useOverlayLayer`,
`useEscapeToClose`): only the top layer hears Escape. `Sheet`, the dialog host
(through `Sheet`), the mobile drawer, the member edit drawer, migration detail
drawer, password reset, filters sheet, alerts drawer, P&L drill-down, the row
⋯ menu, the date-range picker and the portal's More sheet all use it.

### 3. The page stayed frozen after two sheets closed

**Cause.** 4 separate scroll locks each saved and restored the page's scroll
setting. Two of them closing in the "wrong" order (the lower sheet first) left
the page unable to scroll until a reload — which reads as a frozen screen.

**Fix, once.** One counted lock in `lib/overlay.ts` (`useScrollLock`, and
built into `useOverlayLayer`). Used by `Sheet`, the mobile drawer, the row ⋯
menu and the reports' `useBodyScrollLock`.

### 4. A reload blanked the page under an open sheet

**Cause.** A page that shows a skeleton while `loading` is true, and sets
`loading` back to true on every reload, takes everything off the screen —
including an open sheet and whatever was typed in it — each time it reloads
after a save. The member profile had already been fixed for this by hand;
these had not:

| Screen | What reloaded it |
|---|---|
| Events list | any save or action from a row's sheet |
| Financials → Bank | changing range, page or bank; sync |
| Staff schedule | every assignment saved from the day sheet |
| Reports → Costs, Reports → P&L | changing range, period or basis with an editor / drill-down open |
| Member portal home | a failed reload replaced the page with "Could not load your profile." |

**Fix, once.** `useFirstLoad()` in `lib/firstLoad.ts`: the flag can blank the
screen for the first load only. Later reloads swap the data underneath and
raise a separate `refreshing` flag. A reload that *fails* keeps the data
already on screen.

### 5. The connection bar rebuilt the screen with a sheet open

**Cause.** When the connection drops, a bar offers "Try again", and when the
phone comes back online the screen is rebuilt automatically — unless something
is typed. A sheet holding only choices (a plan picked, boxes ticked, a date
set) has nothing typed, so it was closed under the person the moment the
signal returned. On a phone moving between Wi-Fi and cellular this is the most
likely "closed on its own with nothing touched".

**Fix.** `components/ConnectionGuard.tsx`: never rebuilds by itself while any
sheet is open. The "Try again" button still works, and now says what it will
clear before it clears an open sheet or unsaved typing.

### What was looked for and not found

- **Polling or auto-refresh replacing data under a form** — there is none. The
  only timers are a countdown, a "minutes ago" label, two search debounces and
  the member check-in screen waiting (at most 12 seconds) for its own result.
- **Sheets keyed on changing data** — four sheets have a `key`; all four are
  stable identities.
- **`useEffect` loops** — none surfaced in the crawl (no "maximum update depth"
  errors on any of 69 pages at either size).
- **The session refreshing on window focus** — it does, and nothing unmounts
  because of it. The crawl fired focus/visibility events at every sheet.

## Part 2 — screens that crash

| # | Screen | What happened | Cause | Fix |
|---|---|---|---|---|
| 6 | **Staff profile** (`/dashboard/staff/[id]`) and **My profile** | The error screen, on every open | A hook (`useSingleFlight`) was added *below* the loading returns on 2026-11-16, so it ran on the render after the data arrived and not before. React throws. | Moved above the returns. `scripts/hooks-order-guard.ts` parses every component and custom hook for the same mistake — this was the only one. |
| 7 | **Import wizard** (`/dashboard/reports/imports/[batchId]`) | The error screen, on every open ("a.then is not a function") | Written for the next version of Next, where a page's `params` is a Promise; here it is a plain object. | Reads either shape. |
| 8 | **Audience preview** (production, 2026-11-17 23:53 UTC) | `POST /api/marketing-audiences/preview` → 500 | A status rule previewed before a status was picked sent `[""]`; the database client rejects it. | Blanks are dropped (no constraint, as an empty list always was). A value that is not a status matches nobody, never everybody. |
| 9 | Settings → Club, club address field | A console error on every save; the field's format check never ran | `pattern="[a-z0-9-]+"` is invalid in current browsers. | Escaped. A test compiles every `pattern` in the app the way a browser does. |

**Items 6 and 7 are on `main`.** If `main` is what is deployed, the staff
profile, My profile and the import wizard are broken in production now.

## Part 3 — production error data (read-only)

- **Netlify.** Asked for 14 days; the plan returned **24 hours** (2026-11-17
  16:53 UTC → 2026-11-18 16:53 UTC): 5,261 requests, **one 500** — item 8
  above. No other 5xx.
- **Sentry.** Not reporting. The public site's scripts contain no Sentry
  address, so `NEXT_PUBLIC_SENTRY_DSN` is not set. Separately, even with it
  set, the browser side would not start: `next.config.mjs` is not wrapped with
  Sentry's config, so `sentry.client.config.ts` is never loaded; and
  `instrumentation.ts` (the server side) needs a Next 14 config flag that is
  not present. `RouteError` calls `captureException`, which does nothing
  without that.
- **So there is no client-side error reporting.** A screen that crashes in a
  browser — like items 6 and 7 — leaves no trace anywhere.

**Recommendation** (nothing was added):

1. **Finish the Sentry wiring on its free plan.** The package is already a
   dependency and half configured. Needs: an account and the two DSN variables
   in Netlify; `withSentryConfig` in `next.config.mjs`; the instrumentation
   flag; an `app/global-error.tsx`. About an hour, and the only step that is
   yours is creating the account.
2. **Or, no outside service:** a small first-party endpoint the error screen
   posts to, writing a row per crash (screen, message, app version, signed-in
   role — no member data). Needs one new table.
3. Either way, Netlify's 24-hour window means a "last 14 days" question cannot
   be answered from logs on this plan.

## Part 4 — a safety problem the audit itself found

The local test server is started with `scripts/dev-local.sh`, which blanks
production credentials. It did so from a hand-kept list, and the list had a
hole: **a second production database address** (`APP_DATABASE_URL`, used by
the document signatures list and the ledger) and the **Plaid keys**. They were
not in this worktree — the database client library loads the main checkout's
`.env` by itself and fills in anything not already set.

The crawl pressed "Signatures" on a document, once at each screen size. **Two
connection attempts reached the production database pooler. Both were refused
at sign-in** (the local copy of that address is malformed), so no query ran
and nothing was read or written. The crawl was stopped as soon as the error
was read. Whether the crawl's 12 buttons on Financials included "Connect bank"
(which would ask Plaid for a link token and nothing else) cannot be told from
the logs of that run.

**Fix.** `dev-local.sh` is now default-deny: after its own settings it blanks
every variable any env file defines that it has not given a local value, and
`APP_DATABASE_URL`, Plaid, Supabase Storage, Sentry and the cron secret are
set explicitly. `scripts/dev-local-env-tests.ts` asks the script what a server
would see for all 53 variables the app reads and fails the build if any holds
a real value. The after-fix crawl ran under it with no outside connection.
The repo `CLAUDE.md` table is updated.

## The guard (so a new sheet cannot bring this back)

`scripts/sheet-stability-guard.ts` runs on every build and fails on:

- **A** — a component that draws a sheet, blanks itself on a loading flag, and
  raises that flag again on reload (or empties its data before a refetch);
- **B** — `onClick` on the full-screen element that contains the panel;
- **C** — a private Escape listener in a component that draws a sheet;
- **D** — a private scroll lock.

It follows sheets into child components, and its first section proves each
rule catches the broken shape and passes the fixed one.

## Tests added (all in the build gate: 143 → 149 checks)

| File | Covers |
|---|---|
| `scripts/sheet-stability-guard.ts` | the four shapes, every screen |
| `scripts/sheet-stability-tests.ts` | rendered: backdrop, Escape and scroll-lock stacking, reload under a sheet, `Sheet` through re-renders, the guardian-name case in the edit drawer, the connection bar |
| `scripts/hooks-order-guard.ts` | a hook below an early return, every component and hook |
| `scripts/crash-audit-tests.ts` | import wizard `params`, field patterns, failed reloads keep the screen |
| `scripts/audience-status-filter-tests.ts` | the production 500 |
| `scripts/dev-local-env-tests.ts` | a local server sees nothing real |

`scripts/browser-crash-audit.ts` is the crawl. It is not in the build gate (it
needs a running local server and database) and refuses any address that is
not this machine.

## Not done

- **The ~70 hand-built modals were not moved onto `Sheet`.** They now share
  its rules through `lib/overlay.ts`; converting them is a separate, larger
  change with visual risk.
- **Sheets with no backdrop close at all** (most of them) were left as they
  are — they were never part of this bug.
- **A blank status rule in a saved audience** still means "no constraint", as
  an empty list always has. Whether saving such a rule should be refused is a
  product decision.
- **Client-side error reporting** — recommended above, not built.
- **Second-level sheets and the 4 pages with no local record** were not opened
  by the crawl. The source guard covers their code.
