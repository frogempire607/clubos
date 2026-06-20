# AthletixOS — Onboarding + Migration Fixes (2026-06-20)

End-to-end fix of the import → family onboarding → guardian portal → approvals
flow, **plus** the three fast-follow extras. Verified against live code + the
production Supabase DB. Scoped `tsc` passes clean on all changed files.
**No database migration is required** — every change is code-only.

---

## Deploy (run from your machine)

```bash
cd ~/Desktop/clubos
git add -A
git commit -m "Family-aware member portal, onboarding/migration fixes + child logins, purchase reassign, private cash/check"
git push origin main
```

Netlify auto-builds on push (`prisma generate && next build` — the real type
gate). **No `prisma migrate deploy`** — nothing touched the schema. No
`cap:sync` — the Capacitor wrappers load the live web URL. The frogempire607
wipe is already applied, so you can test fresh once the build is green.

> To skip the two prior-session note files at the repo root, use
> `git add web/ ONBOARDING_MIGRATION_FIXES_2026-06-20.md` instead of `git add -A`.

---

## What was actually broken (root causes)

1. **"Your account isn't linked to a member profile yet."** Your test login is a
   pure **guardian** (0 own profiles, 2 children). Every purchase surface
   resolved only the user's **own** profile, so a guardian with no membership of
   their own was blocked from buying anything. **All 158 members are minors**, so
   this blocked the whole club.
2. **"ACTIVE with no membership."** The `finalPeriodPaid` path set ACTIVE/APPROVED
   but never attached a membership or subscription, and hid the onboarding
   membership step.
3. **One invite per child, not per family** — a guardian with 3 kids got 3 emails.
4. **Import logic and approvals were already correct** — verified, left intact.

---

## Core changes

- **Family-aware portal** (`lib/memberContext.ts`, `/api/member/context`,
  `components/ProfileSwitcher.tsx`): a guardian can act on their own profile and
  every child they guardian. `hasMemberProfile` is true if they can act on *any*
  profile, so guardians are never blocked. A "Who is this for?" switcher appears
  on Memberships, Products, Events, and Privates; the chosen `memberId` is passed
  to the buy/booking routes (memberships, products, events, privates, packages,
  classes, bundles) and the purchase is attributed to that child.
- **Parental-control deadlock fix** (`lib/parentalControls.ts`): a guardian's own
  purchase for a child is never queued for their own approval.
- **Onboarding membership attach** (`migration/activate`): `finalPeriodPaid` now
  attaches the membership + a non-renewing subscription, so the owner profile
  shows the plan.
- **One invite per guardian family** (`migration/send`, new
  `/api/members/migration/families`, migration-tool **Family onboarding groups**
  panel): one email per guardian, every sibling gets a token.

---

## Extras (now included — still code-only, no migration)

### Extra 1 — Independent child logins
- `lib/childLogin.ts` + `POST /api/member/family/[memberId]/invite-login`.
- Give a child their own login from **two** places: during onboarding (optional
  "Give [child] their own login" email field on the activation page) **or**
  anytime later on the child's **Controls** page (`/member/family/[childId]`).
  The child gets a set-password email (reuses the reset-password page). The parent
  stays guardian + billing manager; existing parental controls govern what the
  child can do alone. No new column — the child gets their own `User` and
  `Member.userId` points at it while the guardian link stays intact.

### Extra 2 — Reassign a purchase to the right child
- `app/api/member/family/[memberId]/purchases` (GET list + POST reassign).
- On a child's **Controls** page, a **Purchases** section lists their memberships
  and product purchases with **"Move to [other athlete]."** The guardian must
  control both profiles. (Schedule-tied bookings aren't reassignable — rebook.)

### Extra 3 — Private-lesson cash/check routed to the assigned coach
- The member private request has a **Card / Cash / Check** selector. Cash/check
  surfaces a **"Confirm cash/check payment"** button on the **assigned coach's**
  private-lessons dashboard (owner can also confirm), with a pending/confirmed
  badge. Card requests are billed later by the owner as before.

---

## Testing checklist

### Core flow (fresh import into the now-empty frogempire607)
1. Import a roster CSV with siblings sharing a guardian email → all show
   **PROSPECT**; migration tool **Family onboarding groups** shows the guardian
   once with both kids.
2. **Send one invite** → guardian gets **one** email; activation page shows the
   family strip + the imported membership/price.
3. Guardian sets **one password**, picks plan/payment, signs docs → activates
   child 1 → "Set up next athlete" → child 2 (no second password prompt).
4. Owner **Approvals** shows pending kids → approve → status **ACTIVE** with the
   **membership showing** (no ACTIVE-without-membership).
5. Sign in as guardian → **no "not linked" banner**; the **"Who is this for?"**
   switcher lists both kids → buy a membership / product / event / private for a
   chosen child and confirm it's attributed correctly.

### Extras
6. **Child login:** add a child email during onboarding *or* on the child's
   Controls page → child gets a set-password email, signs in, sees only their own
   profile. With "require my approval" on, the child's paid booking pauses for the
   guardian.
7. **Reassign:** buy a membership under the wrong child → child's Controls →
   **Purchases → Move to [right child]** → verify on the owner side.
8. **Private cash/check:** request a private, choose **Cash** → assigned coach's
   Privates dashboard shows **payment pending** + **Confirm cash payment** →
   confirm → badge flips to **payment confirmed**.

**The full 14-step flow plus all three extras are in. Nothing is deferred.**
