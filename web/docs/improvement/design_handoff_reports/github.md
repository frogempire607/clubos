repo: frogempire607/clubos
branch: main
path: web

## Last sync
date: 2026-07-28T22:34:31Z

### Updated in this project
- Recreated the current `/dashboard/reports` page pixel-for-pixel from source as a baseline.
- Redesigned Reports as an eight-tab analytics hub (Snapshot, Revenue, Costs, P&L, Membership, Unit economics, Cash flow, History & imports).
- Added a seven-step all-time CSV import wizard with match review, audit log and rollback.
- Copied the real brand mark (`web/public/brand/icon.png`) into every screen's sidebar.
- Wrote an engineering handoff (`HANDOFF.md` + `specs/`) covering schema, API contracts, formulas and tests.

## Sync history
- 2026-07-28T21:52:00Z — initial import: Reports page, dashboard shell, design tokens, financial report library.

## Screen map

| Project screen | Built from |
| --- | --- |
| `Reports Current (baseline).dc.html` | `web/app/dashboard/reports/page.tsx`, `web/app/api/reports/overview/route.ts`, `web/components/PageHeader.tsx`, `web/components/EmptyState.tsx`, `web/components/LoadingSkeleton.tsx` |
| App shell in every screen (sidebar, topbar) | `web/app/dashboard/layout.tsx`, `web/components/DashboardSidebar.tsx`, `web/components/GlobalSearch.tsx`, `web/components/NotificationBell.tsx`, `web/components/UserMenu.tsx`, `web/components/BackButton.tsx`, `web/components/ThemeToggle.tsx`, `web/lib/dashboardNav.ts` |
| Design tokens (colors, radii, type) | `web/app/globals.css` |
| Brand mark in every sidebar | `web/public/brand/icon.png` (copied into the project) |
| `Reports.dc.html` — Snapshot / Revenue / Costs / P&L / Cash flow | `web/lib/financialReports.ts`, `web/app/api/reports/overview/route.ts`, `web/app/dashboard/financials/page.tsx` (read-only reference — Financials itself is unchanged) |
| `Reports.dc.html` — Membership tab | `web/app/api/reports/overview/route.ts` (member + subscription queries) |
| `Reports.dc.html` — History & imports tab | `web/lib/dashboardNav.ts` (`/dashboard/members/migration`) |
| `Reports Import Wizard.dc.html` | New flow; matching rules specified in `specs/04-imports.md` |

## Notes
- Financials (`/dashboard/financials`) is explicitly **out of scope** and must not be modified. Reports reads from the same underlying data.
- No commit sha recorded: the tree hash observed during import was `b38ce9b03193`, which is a tree, not a commit.
