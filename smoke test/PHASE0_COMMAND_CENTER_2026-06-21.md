# Phase 0 — Command Center: shipped (code on disk)

Date: 2026-06-21. Scope: the no-migration backbone from `COMMAND_CENTER_PLAN_2026-06-21.md`. **Code is on disk — Julian commits/pushes. No DB migration in this phase.**

## What shipped

1. **Action Center** — a permission-filtered, self-clearing list of everything needing attention (unassigned/pending privates, unread messages, guardian links, cancellation requests, members awaiting billing approval, event payments owed, onboarding in progress). Reuses the Approvals synth pattern; each item is a live COUNT, so it disappears when resolved. Owners see all; staff see only what their permissions allow.
2. **Dashboard widget** — "Needs your attention" card, default-visible at the top of the dashboard (removable via Customize).
3. **Notification bell** — top-bar bell + badge (desktop + mobile topbars) opening the same list.
4. **Bulk onboarding** — Members page now has **Select all prospects** / **Select all non-active** quick-select + a **Send onboarding link** bulk action (the free, no-payment JOIN link) + an **Onboarding** status column and filter (Not invited / Invited / Activated / Completed). Reuses the existing `/api/members/bulk` `send_registration_link` path (no duplicate endpoint).
5. **Unassigned private visibility** — when a member requests a private with **no coach**, every eligible coach **and** the owner now get an in-app DM + email ("needs a coach"); the request shows as the top Action Center item. Assigned-coach behavior is unchanged.
6. **Public membership links** — Memberships page has **Copy link** per active, public plan → `/join/<slug>?m=<id>`: a branded public page showing the plan + pricing that funnels into the existing signup/onboarding (plan preselected, deep-links to purchase after account creation). No new billing surface.

## Files

**New**
- `web/lib/actionCenter.ts` — synth + permission filter + 20s per-(club,user) cache.
- `web/app/api/dashboard/action-center/route.ts` — GET endpoint.
- `web/components/ActionCenterWidget.tsx` — dashboard widget.
- `web/components/NotificationBell.tsx` — top-bar bell + dropdown.
- `web/app/api/public/membership/route.ts` — public read (ANYONE/active plans only).
- `web/app/join/[slug]/page.tsx` — public branded registration page.

**Modified**
- `web/lib/dashboardWidgets.ts` — `actionCenter` widget in catalog + default order.
- `web/app/dashboard/page.tsx` — render the Action Center widget.
- `web/app/dashboard/layout.tsx` — mount the bell (mobile + desktop topbars).
- `web/app/dashboard/members/page.tsx` — quick-select, onboarding column/filter, "Send onboarding link" label.
- `web/app/api/member/privates/route.ts` — unassigned-request fan-out to eligible coaches + owner.
- `web/lib/email.ts` — optional `unassigned` flag on `sendPrivateLessonRequestedEmail` (backward-compatible).
- `web/app/dashboard/memberships/page.tsx` — "Copy link" + slug fetch.
- `web/app/member/signup/page.tsx` — read `?membership=`, deep-link to that plan after signup.

**Cleanup note:** `web/app/api/members/onboarding-invites/bulk/route.ts` is an inert stub (a duplicate I started, then superseded by reusing `/api/members/bulk`). The sandbox couldn't delete it. Safe to remove from your machine: `rm -rf web/app/api/members/onboarding-invites`.

## Verify (run on your machine)

```bash
cd web
npx tsc --noEmit            # type-check (sandbox can't run your Mac toolchain)
npm run build               # Next build
```

Then smoke-test:
- Dashboard shows "Needs your attention"; bell badge matches; staff see only permitted items; resolving an item clears it.
- Members → Select all prospects → Send onboarding link → JOIN links sent, no payment, Onboarding column flips to "Invited".
- Member requests a private with no coach → eligible coaches + owner emailed/DM'd; item appears; assigning a coach clears it.
- Memberships → Copy link → open `/join/<slug>?m=<id>` → branded plan → Create account → lands on that plan after signup.
- Regression: existing dashboard widgets, members bulk message/delete, assigned-coach private email, iOS topbar layout.

## Deferred (next phases, each 1 migration)
- **P1 — Tournament invoicing:** send-invoice date, expense line-items + receipts, parent-facing breakdown, official-price-not-finalized reminder. Builds on existing `variableCost*` + `bill-registrants`.
- **P2 — Payout expansion:** stored `Payout` record (staff/guest/contractor/event-worker, PENDING/PAID + history) + assign-event-compensation; adds payout items to the Action Center.
