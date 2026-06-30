# AthletixOS — Onboarding + Migration Fixes (2026-06-20)

End-to-end fix of the import → family onboarding → guardian portal → approvals flow.
**Verified against live code + the production Supabase DB — not assumed.** Scoped
`tsc` passes clean (exit 0) on all changed files. **No database migration is
required** — every change is code-only.

---

## What was actually broken (root causes)

1. **The screenshot bug — "Your account isn't linked to a member profile yet."**
   Your test login `julianramirez1181@gmail.com` is a pure **guardian** (0 own
   profiles, 2 children). Every purchase surface (`memberships`, `products`,
   `events`, `privates`, `packages`) resolved **only the user's own member
   profile** (`Member.userId`). A guardian who manages children but has no
   membership of their own therefore got the "not linked" banner and **could not
   buy anything — not even become a member.** Because **all 158 members in the
   club are minors**, this blocked the entire club, not just your test account.

2. **"ACTIVE with no membership on the owner side."** The two active kids went
   through the **`finalPeriodPaid`** activation path, which set
   `status = ACTIVE` + `approvalStatus = APPROVED` but **never attached a
   membership or created a subscription** (`membershipId = null`, 0 subs). That
   same flag also **hid the onboarding membership step** (the plan picker is
   suppressed when `finalPaid` is true).

3. **One invite per child, not per family.** The activation page already
   surfaced siblings, but the send routine emailed **every child separately** —
   a guardian with 3 kids got 3 emails.

4. **Import logic (item 1) was already correct** — minor→guardian contact
   defaulting, adult→member, dedup, one-guardian-many-children, and the
   PROSPECT default are all implemented properly. Verified, left intact.

5. **Approvals (item 6) were already correct** — both the card and the
   cash/manual branches attach the membership + subscription. The breakage was
   upstream (the `finalPaid` path skipping approval entirely).

---

## What I changed

### A. Family-aware member portal (the core fix — items 2, 3, 7)
- **New `lib/memberContext.ts`** — single source of truth `resolveFamilyContext()`:
  a portal user can act on their **own** profile **and every child they
  guardian**. `hasMemberProfile` is now true if the user can act on **any**
  profile, so a guardian is never blocked.
- **New `GET /api/member/context`** — powers the profile switcher.
- **New `components/ProfileSwitcher.tsx`** — "Who is this for?" selector shown on
  every purchase page when more than one profile is available (hidden for normal
  single-profile members).
- **Buy/booking routes now accept `memberId` and authorize via the family set**,
  so a guardian can buy for the right child and the purchase is attributed to
  that child: `memberships/subscribe`, `products/[id]/buy`,
  `private-packages/[id]/buy`, `privates` (GET+POST), `events/[id]/register`
  (already family-aware — aligned), `classes/book` (aligned),
  `event-bundles/[id]/register` (already family-aware).
- **GET data routes report `accessible[]` + `hasMemberProfile`**: `memberships`,
  `products`, `privates`, `events`.
- **Portal UIs wired with the switcher + pass the selected `memberId`**:
  `memberships`, `products`, `events`, `privates`.

### B. Parental-control deadlock fix
- `lib/parentalControls.ts` gained a `bookerIsGuardian` short-circuit. A
  guardian-managed minor has `Member.userId = null`, so the old
  "booker ≠ the minor's own login" check couldn't tell a guardian from a
  stranger and could **queue a guardian's own purchase for their own approval**.
  All family-aware routes now pass `bookerIsGuardian` so a guardian's action is
  allowed immediately.

### C. Onboarding membership attach (items 5, 7)
- `migration/activate/[token]` — the **`finalPeriodPaid` path now attaches the
  membership** (`membershipId`) and creates a **non-renewing** `MemberSubscription`
  (manual, `autoRenew: false`, ends on the commitment date). The owner profile
  now shows the plan instead of "ACTIVE, no membership." Non-final members
  continue to attach their plan at owner approval (unchanged, already correct).

### D. One invite per guardian family (items 2, 8)
- `migration/send` now **groups targets by guardian email** and emails the
  guardian **once**, while ensuring **every sibling has a valid token** (new
  `ensureActivationToken()` in `lib/migrationServer.ts`) so the single email
  walks the parent through "set up the next athlete" for the whole family.
- **New `GET /api/members/migration/families`** — detects same-email family
  groups (guardian + children).
- **Migration tool UI** — new **"Family onboarding groups"** panel: shows each
  guardian once with their children, with **"Send one invite"** per family and
  "Send one invite to every family."

### E. Clean sweep (item 9) — DONE on production
Wiped club `frogempire607`: **158 members, 143 guardians, 1 member login**
deleted (cascaded their subscriptions, tokens, guardian links, migration
events, approvals). **Preserved:** owner `jramirez@frogempire607.com`, staff
`sjones@frogempire607.com`, and all config (5 memberships, 2 documents, 2
events, 4 classes, 3 private-lesson types). Verified 0 member-side rows remain.

---

## Deploy steps (run from your machine)

1. `git add -A && git commit` the changed files (listed below).
2. `git push origin main` — Netlify runs `prisma generate && next build` (the
   real type gate; the sandbox can't `prisma generate`).
3. **No `prisma migrate deploy` needed** — there is no schema change.
4. No `cap:sync` needed — the Capacitor wrappers load the live web URL.

**Files:** 18 modified + 4 new (all under `web/`). New: `lib/memberContext.ts`,
`components/ProfileSwitcher.tsx`, `app/api/member/context/route.ts`,
`app/api/members/migration/families/route.ts`.

---

## End-to-end testing checklist

Test on a fresh import into `frogempire607` (now empty of members).

### 1 — Import & family detection
- [ ] Import a roster CSV with siblings sharing a guardian email (e.g. 2 kids,
      one guardian email). One contact column is fine — for minors it's treated
      as the guardian's.
- [ ] All imported members show **PROSPECT** (never ACTIVE) in Members.
- [ ] Migration tool → **"Family onboarding groups"** shows the guardian once
      with both children listed.

### 2 — One invite per family
- [ ] Click **"Send one invite"** on the family (or select the kids → Send
      Activation Links). Confirm the guardian receives **one** email.
- [ ] Open the activation link → the page shows the **family strip** ("athlete 1
      of 2") and the imported **membership + price** for child 1.

### 3 — Guardian onboarding (one account, both kids)
- [ ] Guardian sets **one password**, confirms their info, picks a plan / payment
      method (card, or cash/check/later), signs any required docs → activates
      child 1.
- [ ] "Set up next athlete → [child 2]" appears. Continue → child 2's page does
      **not** ask for a password again ("you already have an account"). If a card
      was saved, the "use the card on file for your family" option appears.
- [ ] Finish child 2.

### 4 — Approvals (owner side)
- [ ] Members → **Approvals** shows both kids as **pending** (unless they were
      marked "final period paid," which auto-completes).
- [ ] Approve each → status flips to **ACTIVE**, the **membership shows** on the
      profile, and a subscription exists. Cash/check members show under approvals
      for you to confirm before going active.
- [ ] Confirm **no member is ACTIVE with a blank membership**.

### 5 — Guardian portal (the screenshot bug)
- [ ] Sign in as the guardian. **No "account isn't linked" banner.**
- [ ] On **Memberships / Shop / Events / Privates**, a **"Who is this for?"**
      switcher lists both children. Pick a child and **purchase a membership** →
      it goes to that child (verify on the owner side).
- [ ] Buy a **product**, **register for an event**, and **request a private** for
      a chosen child — each is attributed to that child, not blocked.
- [ ] Confirm a purchase made under the wrong child can be corrected by simply
      re-selecting the right child before buying. *(Reassigning an already-
      completed purchase is a fast-follow — see below.)*

### 6 — Single-child / adult sanity
- [ ] An adult (non-minor) import with their own email onboards as their own
      login and sees **no** profile switcher (only one profile).

---

## Deferred to fast-follow (agreed: core now, extras next)

These were intentionally **not** in this pass:
1. **Independent child logins** — optional child-email invite so a teen can get
   their own password while the parent stays guardian/billing manager.
2. **Reassigning an already-completed purchase** to a different child from the
   owner/member side (today: pick the right child *before* buying).
3. **Routing private-lesson cash/check approvals to a specific staff member**
   (today: cash/check at onboarding routes to the general owner/staff approvals
   queue).

Tell me when you want these and I'll build them on top of the family context
that's now in place.
