# AthletixOS — Deploy & Full Test Guide (2026-06-20)

Covers everything completed in this task: the family-aware portal, onboarding +
migration fixes, the three extras, and the importer consolidation. **All
code-only — no database migration.** Scoped `tsc` passes on every changed file.

---

## Deploy

```bash
cd ~/Desktop/clubos
git add -A
git commit -m "Family portal + onboarding/migration fixes, extras, and single consolidated importer"
git push origin main
```

- Netlify auto-builds on push (`prisma generate && next build`).
- **No `prisma migrate deploy`** (no schema change). **No `cap:sync`** (web URL wrapper).
- ESLint is ignored at build time, so the build won't fail on the few intentionally
  dead helper components left in place.
- The frogempire607 wipe is already applied — the club is empty and ready.

After the deploy is "Published" in Netlify, hard-refresh the app (Cmd/Ctrl-Shift-R).

---

## Test in this order

You're testing as the owner (`jramirez@frogempire607.com`) plus a guardian email
you control (use a real inbox you can open, e.g. your own + a `+alias`).

### A. Consolidated importer (new)
1. **Members tab** → confirm there's **no "Import CSV"** button anymore; only
   **Import / Migrate** (which opens the migration tool).
2. **Migration tool** → confirm there's a **single** "Import / Migrate Members"
   button (no separate "Match Memberships CSV") and a one-paragraph explainer.
3. Click **Import / Migrate Members** → upload a CSV. In **Map columns** confirm
   the dropdown now includes: address (Street/City/State-Region/Zip), **Minor
   (yes/no)**, **Guardian relationship**, the membership/billing/legacy fields,
   **and your Custom fields** (e.g. Graduating Class, USAW Membership). Set the
   **Date format** to match your file.
4. Map a CSV that has, in one file: athlete name, guardian name/email, address,
   a membership + price + billing date, and a custom field. Import.
5. Confirm members import as **PROSPECT**, addresses/custom values are saved
   (open a member on the Members tab), and membership/price shows on the
   migration row.

> Use a small file first (5–10 rows) to confirm mapping, then the full roster.

### B. Family detection + one invite
6. In the migration tool, click **Family onboarding groups** → guardians with 2+
   kids appear once, children listed under them.
7. Click **Send one invite** for a family → confirm the guardian inbox gets
   **one** email (not one per child).

### C. Guardian onboarding (one account, all kids)
8. Open the activation link → family strip shows "athlete 1 of N" and the
   imported membership/price.
9. Set **one password**, confirm details, choose a plan + payment method, sign
   any docs. *(Optional: enter the child's own email in "Give [child] their own
   login" — see G.)* Activate child 1.
10. Click **Set up next athlete** → child 2 should **not** ask for a password
    again; finish each child.

### D. Membership step + final-period-paid
11. Confirm the onboarding screen **shows the membership/price** (and a plan
    picker when there's more than one option).
12. For a member you marked **"final period already paid"** in the migration
    drawer: after activation, the owner profile shows the membership **attached**
    (not blank) with a non-renewing subscription.

### E. Approvals
13. Owner → **Members → Approvals**: pending kids appear → **Approve** → status
    flips to **ACTIVE** with the **membership showing**. Cash/check members wait
    for you to confirm before going active.
14. Confirm **no member is ACTIVE with a blank membership**.

### F. Guardian portal purchasing (the screenshot bug)
15. Sign in as the guardian → **no "account isn't linked to a member profile"
    banner** anywhere.
16. On **Memberships / Shop / Events / Privates**, confirm a **"Who is this
    for?"** switcher lists the kids. Pick a child → **buy a membership**, **a
    product**, **register for an event**, **request a private** → each is
    attributed to the chosen child (verify on the owner side).

### G. Independent child logins (extra 1)
17. Add a child email during onboarding (step 9) **or** later at **Profile →
    [child] → Controls → Send login invite**. The child gets a set-password
    email, signs in, and sees **only their own** profile.
18. With **"require my approval"** on, a paid booking by the child pauses for the
    guardian; the guardian buying for the child still goes straight through.

### H. Reassign a purchase (extra 2)
19. Buy a membership under the **wrong** child. Go to that child's **Controls →
    Purchases → Move to [right child]**. Confirm it now shows under the right
    child on the owner side.

### I. Private cash/check → assigned coach (extra 3)
20. As the guardian/member, request a private lesson and choose **Cash** (or
    Check); pick a coach.
21. Sign in as that **coach** → **Privates** dashboard shows the booking with a
    **payment pending** badge and a **Confirm cash payment** button. Confirm →
    badge flips to **payment confirmed** and the member gets a message.

---

## If something looks off
- Check the Netlify deploy actually published the latest commit, then hard-refresh.
- Member portal data is per-selected-profile — use the "Who is this for?" switcher.
- Imported members stay PROSPECT until they activate **and** you approve; that's
  intended (no one is auto-charged).
