# AthletixOS — Client UX/UI Phase 1 (2026-06-20)

**Status:** Code complete, on disk. **No database migration.** Run from your machine:

```bash
cd web
npx tsc --noEmit        # full type-check (sandbox could only run a scoped check)
npm run build           # confirm production build
git add -A && git commit -m "Client UX Phase 1: branded portal, billing/onboarding/private-package/child-edit/owner-profile fixes" && git push
# remove two sandbox-created scratch files first:
rm -f __deltest tsconfig.member.json
```

Mobile is a Capacitor remote-URL wrapper, so the web deploy updates the app automatically — no Xcode/Android rebuild needed for these changes.

---

## What changed

**Premium branded portal (visual only — no logic/schema/workflow changes)**
- New `.member-portal` CSS layer + `--club-accent` tokens injected from `Club.primaryColor` (`app/globals.css`, `app/member/layout.tsx`). The owner dashboard is untouched.
- New reusable kit `components/member/ui.tsx` (Card, Pill, Avatar, EmptyState, Skeleton, StatTile, AccentButton) + `lib/friendlyDate.ts`.
- Redesigned profile switcher (always-on, avatar pills, club-colored). Restyled home, profile, family, and schedule cards. The lime-green tiles that clashed with your red/black brand now use your club color.

**Fixes from your list**
1. Onboarding phone field no longer pre-fills the parent email; guardian contact is sourced correctly; email/phone inputs are typed.
2. Confirm-password field added to onboarding.
6. Manage-Billing no longer errors for cash/check athletes — the button is hidden with a clear note; errors show inline, not as a scary red banner.
7. Private packages: percentage/fixed-discount packs now price off the tier you pick (no more $0 / "Package not available"), and packs appear **after** the pricing option.
8. Parents can add **their own athlete profile** ("Add yourself as an athlete") and it joins the switcher.
10. Donation/support links now show on the member home; owners can publish their own portal profile from **My Account → Member portal profile**.
12. Parents can edit a child's **name, DOB, and contact** on the child's Manage page.
13/14. Friendlier, relative dates ("Today/Tomorrow") and a schedule with an in-page athlete switcher + day-window filter (All / Next 7 / Next 30 days).
- Bonus from screenshots: a 25-year-old linked athlete no longer shows "Minor" (label now derives from DOB).

**Deferred to Phase 2 (you chose phasing):**
- Document **signature pad** (needs a DB migration).
- Two-way **parent⇄coach messaging** with per-child tags.
- **Co-guardian / co-parent invite** (divorced-parent access).

---

## Testing checklist

### 1. Single adult onboarding
- [ ] Open an activation link for an adult member. Email shows their email; **phone is blank or a real phone — never the email**.
- [ ] A "Create a password" **and** "Confirm password" field appear; mismatch shows "Passwords don't match"; submit blocked until they match and ≥8 chars.
- [ ] After activating, sign in with the new password (no "invalid password").

### 2. One parent + one child
- [ ] Parent logs in → header shows the club logo/name in club colors; tiles use the club accent (not lime).
- [ ] Profile switcher shows the child (and the parent once they add themselves — see #9).
- [ ] Profile → Family & athlete access lists the child with correct age and **only shows "Minor" when the child is actually under 18**.

### 3. One parent + multiple children
- [ ] Switcher lists all children; selecting one updates Home, Schedule, Bookings, Documents.
- [ ] Schedule shows an "Athlete" row to switch children **without leaving the page**.

### 4. Same payment method across siblings
- [ ] Onboard child 1 with a card. Onboard child 2 → "Use the card already on file for your family" appears and, when checked, completes without re-entering a card.

### 5. Cash/check membership approval
- [ ] Onboard a child choosing **Cash** (or Check) → completes without a card; owner sees it in Approvals and can approve.
- [ ] On Profile and on the child's Manage page, **"Manage billing" is hidden** for that cash athlete and shows "No card on file… billed at the club" — clicking nothing errors.
- [ ] For an athlete **with** a card, "Manage billing" still opens the Stripe portal.

### 6. Private package purchase
- [ ] Go to Private lessons → pick a lesson type → pick a coach/pricing option.
- [ ] Packs appear **below the pricing option** with a **real price** (not $0). For a % or $ discount pack, the price reflects the chosen tier and updates when you change the option.
- [ ] "Buy pack" opens Stripe checkout (no "Package not available"); after paying, credits appear on the privates page.
- [ ] As a parent, buying a pack for a selected child charges/credits the **child**.

### 7. Documents with signature pad — **Phase 2 (not yet implemented)**
- [ ] (Current behavior) Signing still records a typed acknowledgement with name/date/IP. The drawn signature pad is scheduled for Phase 2 (needs a migration).

### 8. Parent/child messaging — **partially: Phase 2 for two-way**
- [ ] (Current) A parent sees per-child conversations tagged "For {child}". 
- [ ] (Phase 2) Parent-initiated threads and coach→parent direct messaging are not yet built.

### 9. Parent profile purchase (parent buys for themselves)
- [ ] As a guardian with no own profile, Profile → "Add yourself as an athlete" → "Add me". The switcher now shows **You**.
- [ ] Switch to **You** and confirm you can browse/buy an adult membership or product for yourself.

### 10. Schedule navigation
- [ ] Date headers read "Today / Tomorrow / Sat, Jun 21"; times read like "5:30 – 6:30 PM".
- [ ] Kind filter (All/Classes/Events) **and** day-window filter (All/Next 7/Next 30) both work.
- [ ] In-page athlete switcher changes whose schedule is shown.

### 11. Billing / settings error checks
- [ ] Profile no longer shows a red "No billing account on file yet" banner at the top.
- [ ] Owner: My Account → **Member portal profile** → add a photo/bio, toggle "Show me on the member portal", save → the owner now appears on the member portal's **Our team** page (this previously only worked for staff).
- [ ] Member home shows a **"Support {club}"** card when the club has active donation links with a URL.
- [ ] Child Manage page: edit name/DOB/contact → Save → values persist and reflect in Family list.

### Regression spot-checks
- [ ] Owner dashboard visual is unchanged (branding is scoped to the member portal).
- [ ] Existing card-paying members can still open the billing portal and request cancellation.
- [ ] Booking a class/event and requesting a private lesson still work for self and child.
