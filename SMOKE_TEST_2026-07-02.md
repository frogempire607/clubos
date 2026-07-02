# AthletixOS Smoke Test — 2026-07-02 batch

Covers everything shipped today (commits `7cf40f3` → `ddd7eac`): migration status model,
attendance remove, mobile unread fix, staff permission audit + Sal's blockers, client Club
Profile + notification badges, member/non-member private pricing, cancel/refund rules,
tablet UI, cash/check in-portal purchases, save-card, primary-guardian controls, login
prefill, ToS tier fix.

**Before you start:** wait for the Netlify deploy of `ddd7eac` to finish. No DB migration
is needed. If you changed anyone's staff permissions recently, have them log out/in once
(permissions are stamped into the login token).

Accounts you'll want: **Owner** (you), **Sal** (staff, full perms except finances:view),
a **guardian** login with 2+ linked kids, a **member with an active membership**, and a
**member with NO membership** (e.g. a JOIN account).

---

## 1. Members list — migration/status model (owner)

- [ ] `/dashboard/members`: status chips now read **All / Active / Migrating / Prospect / Inactive / Paused**. Imported-but-not-yet-activated athletes sit under **Migrating** (dark chip), NOT Prospect.
- [ ] Prospect count now only includes people who never had a membership.
- [ ] A migrating member's row shows their **legacy plan name** ("migrating from previous software") in the Membership column instead of "+ Purchase membership".
- [ ] Onboarding column reads **Un-invited / Invited / Profile completed / Completed**; the onboarding filter dropdown matches.
- [ ] Open a migrating member's profile page: chip says **Migrating** (+ legacy plan pill), not Prospect.
- [ ] **Decay check** (important): a migrated member imported >30 days ago who hasn't activated must still be Migrating — NOT flipped to Inactive after you load the members list.
- [ ] "Select all prospects" no longer selects migrating members (they get activation links from the Migration tool, not join links).

## 2. Attendance — hard remove (owner or staff)

- [ ] `/dashboard/attendance` → open a class roster → add someone by accident → row now has a red **Remove** button.
- [ ] Remove them: confirm dialog → they vanish entirely (not absent/late). Reload — still gone; no record kept.
- [ ] If they had paid at the door before removal, the payment still shows in Financials.
- [ ] Present / Late / Absent / Trial / Drop-in buttons all still work.

## 3. Messages — unread + group chats

- [ ] **On your phone** (the key one): have someone DM your member account → red badge on Messages tab → open the thread → go back → **badge is gone** without needing another navigation. Repeat once to be sure (this was the WebView caching bug).
- [ ] Desktop DM read-state still works; group threads mark read receipts on open.
- [ ] **Create group** (owner AND Sal): Messages → Create group → pick a few athletes → creates successfully — no more "Something went wrong". This was broken for everyone.
- [ ] Athletes without a portal login show greyed out with "no portal login" and can't be selected.
- [ ] Broadcast type also creates; members can't reply to broadcasts.
- [ ] Two siblings sharing one parent login collapse into one participant (the parent).

## 4. Staff permissions — test as Sal

- [ ] `/dashboard/staff` loads the directory (staff:view). Payroll + Payouts load (finances:view).
- [ ] **Privates**: Sal sees "+ New booking", "+ New lesson type", "Assign package", and row Edit/Duplicate/Delete — and creating a booking works end-to-end.
- [ ] **Announcements**: Sal publishes an In-App announcement successfully. If anything fails, the modal now shows the real reason, not a blank error.
- [ ] Negative check: a staff account with `finances:none` gets a clean "no permission" error on Payroll, and one with `events:view` only does NOT see the privates action buttons.
- [ ] Event staff assignment, event types, discounts, custom fields, class-session edits all work for staff with the matching permission and 403 without it.

## 5. Private lessons — pricing + payment + cancel

- [ ] Owner: Privates → edit a lesson type → each price option has **"Who can pick this rate"** (Everyone / Active members only / Non-members only). Set up a member rate + a non-member rate on one type.
- [ ] Member WITH active membership: sees the member rate (tagged "member rate"), does NOT see the non-member rate.
- [ ] Member WITHOUT membership: sees the non-member rate + a "Member pricing is available with an active membership" nudge; can't submit the member rate even via a stale tab (server rejects with a clear message).
- [ ] Request flow: type → coach → pricing option → time slots → **"How will you pay?" Card / Cash / Check appears before submit**; cash/check request goes through with no Stripe redirect.
- [ ] Cancel an **unpaid** private from `/member/bookings` → Manage: cancels cleanly.
- [ ] Cancel a **paid** (or credit-paid) one: cancel succeeds but the toast says the refund/credit restore is **requested, not automatic**, and staff get a DM about it. Nothing auto-refunds.

## 6. Member portal — Club Profile + notifications

- [ ] More sheet → **Club profile** (`/member/club`): bio, contact + hours, "Support {club}" donation links, and the team directory all render. Clean on phone + desktop.
- [ ] Post an announcement as owner → member's **More tab shows a red count** (mobile) and the desktop nav badges; open **News** → badge clears everywhere.
- [ ] Messages badge and announcements badge work independently.

## 7. Cash/check in-portal purchases (NEW)

- [ ] Member → Memberships → Subscribe → chooser appears: **Card / Cash / Check**.
- [ ] Pick **Cash**: green "Request sent" banner, NO Stripe redirect, membership NOT active yet.
- [ ] Owner → Members → **Approvals**: a "Membership purchase — cash" card shows who/plan/price. **Approve & start membership** → member flips ACTIVE with the plan attached; member gets a DM; Financials shows an **unpaid invoice** for the amount (clears your books when you record collection).
- [ ] Decline path: request closes, member gets a DM, nothing was created.
- [ ] Duplicate guard: a second cash request while one is pending returns "already have a request waiting".
- [ ] **Packs**: member privates page → pack card → **"Request with cash/check instead"** → same approval flow → approving adds the lesson credits + unpaid invoice; credits usable immediately after approval.
- [ ] Card paths unchanged: card membership subscribe and card pack buy still go to Stripe Checkout.

## 8. Save a card, no charge (NEW)

- [ ] Member with NO card on file → Profile → Payment & billing → **"Add a card"** → Stripe page saves a card with **no charge** → returns with "Card saved — nothing was charged."
- [ ] After the webhook lands (seconds), "Update card / invoices" (billing portal) works for them.
- [ ] Guardian: per-child rows show **Add a card** instead of "No card on file" — works for a cash/check kid.

## 9. Co-guardian controls (NEW)

- [ ] Primary guardian (the one on the club's file / first linked): can edit controls, athlete details, and invite a co-guardian as before.
- [ ] Invite a co-guardian → owner approves in Approvals → co-guardian sees the child, can book/view/manage day-to-day.
- [ ] Co-guardian opens the child's Manage page: amber **"You're a co-guardian"** banner; saving controls/details or inviting another guardian is rejected with a clear message.

## 10. Login + legal

- [ ] Log in at plain `/login` (no club link) with a club code → log out → revisit `/login`: **club code is prefilled**. A `?club=` link still overrides it.
- [ ] `/terms`: pricing paragraph now says **Growth $50 / Pro $99 / Enterprise from $199** — no free Starter tier, no $49. (Draft-for-attorney banner is intentionally still there.)
- [ ] New signup records terms version `2026-07-02`.

## 11. Tablet / mobile UI (owner side)

- [ ] iPad (or narrow browser ~800px): Members page header buttons **wrap** instead of overflowing off-screen.
- [ ] Members, Classes, Payroll tables scroll horizontally on phone/tablet; row actions reachable.
- [ ] Staff page: on a phone, each staff card's Edit / Setup link / Remove drop to their own row — labels no longer crushed.

## 12. Regression spot-checks (10 min)

- [ ] Owner + staff + member logins all work; middleware still routes roles correctly.
- [ ] Migration flow: import CSV → send activation → activate → approve still works end-to-end (members land as Migrating, not Prospect, along the way).
- [ ] A card membership purchase completes via Stripe and flips the member ACTIVE (webhook).
- [ ] Existing role restrictions hold: a MEMBER login can't reach `/dashboard`; staff can't reach club Settings/Stripe pages.
