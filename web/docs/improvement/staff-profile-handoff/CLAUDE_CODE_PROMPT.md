# Paste this into Claude Code (from ~/Desktop/clubos/web)

Read `docs/improvement/staff-profile/README.md` in full, then open the six files in `docs/improvement/staff-profile/design/` in a browser to see the screens.

Build the Staff profile page it describes at `/dashboard/team/[id]` with `?tab=` in the URL. It must be a sibling of the redesigned Member profile — reuse the same components, tokens and layout.

Hard rules:
1. This is a re-layout. Reuse the existing staff data, API routes and permission checks (Staff directory, Edit Staff modal, Availability, Schedule, Payroll & Payouts). Don't change the permission enum, the pay math, or the availability/schedule models.
2. The only behaviour change: a staff member can edit their OWN weekly hours and time off. Add that as a server-side check on the existing availability routes.
3. If something in the design doesn't exist in the code today (the Messaging/Billing advanced options, the Revenue share bonus), stop and list it for me instead of inventing it.
4. All times display as 12-hour AM/PM.
5. One save per tab, a leave-with-unsaved-changes guard (no window.confirm), and mobile at 375px with 44px taps, nothing under 12px, and bottom sheets.

Before writing code, give me a plan: which existing files you'll reuse or replace, and anything in the README that doesn't match the code. Wait for my OK.

Work on one branch. Run `npm run build` and `npm run test:sport-terms` locally. Don't push until I say so.
