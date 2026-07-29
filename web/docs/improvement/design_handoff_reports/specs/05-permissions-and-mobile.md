# 05 — Permissions and responsive behavior

## Permissions

The app already has `requirePermission(session, resource, action)` in `web/lib/apiGuard.ts` and `canAccessPath(role, permissions, href)` in `web/lib/permissions.ts`, which both the sidebar and bottom nav use. Extend that system — do not invent a second one.

### New granular permissions

Under a `financials` (or `reports`) permission group:

| Key | Gates |
| --- | --- |
| `reports.view` | The Reports section at all (exists today) |
| `reports.financials` | Snapshot, P&L, Costs, Cash flow, Unit economics |
| `reports.bank_balances` | Cash on hand, runway, cash-flow balances |
| `reports.payroll` | Payroll lines in P&L and Costs |
| `reports.owner_equity` | Owner contributions and distributions, loan lines |
| `reports.vendors` | Vendor names and vendor detail |
| `reports.membership` | Membership and churn metrics |
| `reports.by_coach` | Per-coach revenue and churn |
| `reports.imports` | Run and review imports |
| `reports.rollback` | Roll an import back |

### Matrix

| | Owner | Staff with financial permissions | Coach / regular staff |
| --- | --- | --- | --- |
| Snapshot | Full | Per permission | No |
| Club-wide profit | Yes | `reports.financials` | No |
| Bank balances, runway | Yes | `reports.bank_balances` | No |
| Payroll totals | Yes | `reports.payroll` | No |
| Tax summary | Yes | `reports.financials` | No |
| Owner contributions / distributions | Yes | `reports.owner_equity` | Never |
| Vendor names | Yes | `reports.vendors` | No |
| Membership and churn | Yes | `reports.membership` | Read-only if granted |
| Revenue by coach | Yes | `reports.by_coach` | Own figures only |
| Run imports | Yes | `reports.imports` | No |
| Roll back an import | Yes | No | No |

Coaches may see their own revenue and their own athletes' attendance. Never club-wide profit, never balances, never anyone else's pay.

### Enforcement

- **Server-side, per endpoint.** Every route in `specs/02` checks its own permission. A hidden tab is not access control.
- Partial responses over 403s where sensible: a staff member with `reports.financials` but not `reports.payroll` gets the P&L with the payroll line returned as `null` and a `restricted: ["payroll"]` array, rather than a blank page. Total lines that would leak the hidden value are also nulled — do not return a total the user could subtract from.
- The client hides tabs the user can't load, using the same `canAccessPath` pattern the sidebar uses.
- Existing tier gate (`getTierFeatures(tier).reports`) stays and runs first. Its `EmptyState` upgrade screen is already implemented in `reports/page.tsx` — keep it.

## Mobile and tablet

The dashboard shell already handles mobile: a charcoal topbar, a slide-in drawer, and a fixed bottom nav that hides on scroll-down. Reports only has to behave inside it.

### Breakpoints

Tailwind defaults, as used across the app: `sm` 640, `md` 768 (the sidebar boundary), `lg` 1024.

### Rules

**Tab bar.** Horizontally scrollable at < `lg`, momentum scroll, no wrapping, the active tab scrolled into view on mount. Do not collapse into a `<select>` — the tabs are the primary navigation.

**KPI cards.** 4 across at `lg`, 2 at `sm`, 1 below. Never squeeze four numbers into a phone width; `$260,554.40` at 26px needs the room.

**Two-column card pairs.** Stack below `lg`, in the order they read on desktop.

**Tables.** The P&L, revenue-by-item, churn breakdown, review queue and audit log all scroll horizontally in their own container with the first column sticky (`position: sticky; left: 0`) so the line label stays visible. Give the container `-webkit-overflow-scrolling: touch` and a right-edge shadow that fades as the user scrolls, so it's discoverable.

Consider a stacked card layout for the P&L below `sm`: one card per line, label above, values as label/value pairs. Horizontal scroll works, but 6 columns on a phone is a lot of dragging.

**Numbers.** `font-variant-numeric: tabular-nums` everywhere, already in the designs. Large values never truncate — if the container is too narrow, wrap or reduce to the next step in the type scale, and always keep the full value available on tap.

**Drill-through.** Tapping any figure opens the transaction list. On mobile this is a full-screen sheet, not a popover.

**Charts.** Below `sm`, the 12-month bar chart shows the last 6 months with a "show all" toggle. Twelve bars on a 375px screen are unreadable.

**Filters.** The range dropdown becomes a bottom sheet on mobile with 44px minimum row height. The custom-range option uses native date inputs.

**Warnings.** Reliability and alert strips are never collapsed away on small screens. They wrap to multiple lines. A misleading total is more dangerous on mobile, not less.

**Hit targets.** 44×44 minimum for every interactive element, including the review-queue outcome buttons — they currently sit at 13px text with 9px padding on desktop and need to grow on touch.

**Safe areas.** Content respects `env(safe-area-inset-bottom)`; the existing `pb-24 md:pb-0` on the layout's content wrapper handles the bottom nav. Sticky table headers must not collide with the two sticky topbars on mobile (56px + the search row).
