repo: frogempire607/clubos
branch: main
path: web

## Last sync
date: 2026-07-28T17:51:24Z

### Updated in this project
- Recreated today's Members list, member profile and Migration dashboard from source (tokens, shell, pills, columns).
- Copied the real brand mark from web/public/brand/icon.png into brand/icon.png.
- Redesigned Members / Profiles / Migration: three-track status vocabulary, work queues, 7-step migration.
- Added family & access permissions grid, locked-birthday and password-reset states.
- Mobile screens for lookup, check-in, quick actions and desk walk-in.

## Screen map
| Project screen | Built from |
| --- | --- |
| Current Experience — Members.dc.html · T1 members list | web/app/dashboard/members/page.tsx, web/components/MembersTabs.tsx, web/components/PageHeader.tsx |
| Current Experience — Members.dc.html · T2 profile | web/app/dashboard/members/[id]/page.tsx |
| Current Experience — Members.dc.html · T3 migration | web/app/dashboard/members/migration/page.tsx |
| Shell (sidebar, topbar, bottom nav) in all screens | web/app/dashboard/layout.tsx, web/components/DashboardSidebar.tsx, web/components/DashboardBottomNav.tsx, web/lib/dashboardNav.ts, web/components/GlobalSearch.tsx, web/components/UserMenu.tsx, web/components/BackButton.tsx, web/components/ThemeToggle.tsx |
| Design tokens, type, pill + card geometry | web/app/globals.css |
| brand/icon.png (logo in sidebar + mobile topbar) | web/public/brand/icon.png |
| Members Experience Redesign.dc.html 1a–1k | all of the above (redesign, not a recreation) |

## Sync history
- 2026-07-28T17:30:00Z — initial import: read members/profile/migration pages, dashboard shell, globals.css.
