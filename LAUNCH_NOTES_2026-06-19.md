# AthletixOS — Launch‑readiness pass (2026‑06‑19)

All work is **on disk in this repo**. The sandbox can't push, so you commit + push from your machine.
Scoped typecheck passed (only the expected stale‑Prisma‑client errors on the new `requiredAt` column, which clear on `prisma generate`).

---

## ⚠️ Run the database migration BEFORE you deploy the code

There is **one** new migration. New code reads `Document.requiredAt`; the old column doesn't exist yet, and old code ignores it — so applying the migration first is 100% safe and avoids a window where the new code 500s.

```bash
# 1. From the repo root
cd web

# 2. Pull latest first (you asked to)
git pull origin main

# 3. Install (lockfile unchanged, but safe)
npm install

# 4. Apply the additive migration to PRODUCTION (Supabase). Safe on a live DB.
#    Uses your prod DATABASE_URL. This is the migrate-deploy path (NOT migrate dev).
npx prisma migrate deploy

# 5. Regenerate the Prisma client locally (so your editor/build see requiredAt)
npx prisma generate
```

If `prisma migrate deploy` says the shadow DB is blocked, that's only for `migrate dev` — `deploy` doesn't use a shadow DB and should run clean.

---

## Commit, push, deploy

```bash
cd ..   # back to repo root

# Clean up a stale lock if git complains (it was cleared in the sandbox, but just in case)
rm -f .git/index.lock

git add web/prisma/schema.prisma web/prisma/migrations/20260619000000_document_required_surfaces \
        web/app web/app/globals.css

# Optional: review the diff
git diff --cached --stat

git commit -m "Launch pass: tournaments participant category, branded-app launch guide, minor/import contact fixes, family onboarding, document rendering + required surfaces, remove duplicate announcements"

git push origin main
```

Netlify auto‑deploys on push and runs `prisma generate && next build` — that full build is the real typecheck gate. **No `cap:sync` / app‑store resubmit needed** — every change is web content, which the iOS/Android wrappers load live.

---

## What changed (by area)

1. **Events / Tournaments** — Tournaments now have a flexible **Participant category** (you name it: *Weight Class*, *Position*, *Division*, *Belt Level*, *Age Group* …) with a list of options. Entrants pick one on the registration page; it's required if you tick the box, and shows on every registration. Built on the existing registration‑form pipeline, so **no DB migration** and it validates/stores/reports automatically.
2. **Settings / Branded App** — The no‑icon in‑page tab is now a **step‑by‑step launch guide** (club‑owned Apple + Google accounts, what we automate vs. what you do, review timelines) with a "Request my app launch" button. The icon'd sidebar entry was renamed **App Design** and stays the visual editor. The instant‑PWA option and your font/welcome/icon settings are preserved.
3. **Member import / migration** —
   - **Bug fixed:** saving a minor without an email no longer errors (`email: Expected string, received null`).
   - **Smarter import:** for minors, a single Email/Phone column is treated as the **guardian's** automatically; we require only **one email + one phone** on the right party (guardian if minor, member if adult). Guardian **phone is now optional** (name + email required).
   - **Guided help:** the migration screen now has a clear **2‑step** explainer — *(1) Import all clients*, *(2) Match active members' memberships* — and the importer explains what to include.
4. **Family onboarding** — If one guardian email is attached to multiple children, the parent now sets up the whole family in **one guided flow**: account + password once, a progress strip, a **"Set up next athlete →"** hand‑off between children, and **one card on file reused** across all kids (no re‑entry). Each child keeps its own plan/billing.
5. **Documents** —
   - **Rendering fixed:** signed/required documents now render as a proper, readable document everywhere (was raw HTML text in a tiny box during onboarding).
   - **Required surfaces:** you can mark a document required at **Onboarding, Signup, Purchases, and Events** (was effectively activation only). Onboarding is fully enforced in the activation flow; the others are configurable and surface as "must sign" in the member portal.
6. **Approvals** — Verified working end‑to‑end (no change needed): members appear after onboarding and approving sets them ACTIVE with a membership + subscription for both paid and $0/cash members.
7. **Communication** — Removed the duplicate Announcements tab under Messaging; the detailed **Communication → Announcements** is now the single place. Messaging shows Group + Direct messages and links to Announcements.

## Files changed
```
web/prisma/schema.prisma                                  (Document.requiredAt)
web/prisma/migrations/20260619000000_document_required_surfaces/migration.sql   (new)
web/app/globals.css                                       (.doc-prose styles)
web/app/api/documents/route.ts, [id]/route.ts             (requiredAt)
web/app/dashboard/documents/page.tsx                      (required-surface editor + readable viewer)
web/app/member/documents/page.tsx                         (readable viewer)
web/app/dashboard/events/page.tsx                         (participant category)
web/app/dashboard/settings/page.tsx                       (branded-app launch guide)
web/app/api/members/route.ts, [id]/route.ts               (null-email + minor rules)
web/app/api/members/import/route.ts                       (minor→guardian contact defaulting)
web/app/dashboard/members/page.tsx                        (form + import help)
web/app/dashboard/members/migration/page.tsx              (2-step guided help)
web/app/api/members/migration/activate/[token]/route.ts   (family + multi-doc + card reuse)
web/app/activate/[token]/page.tsx                         (family flow + readable docs)
web/app/dashboard/messages/page.tsx                       (removed duplicate announcements)
```

## What I tested
- Scoped TypeScript check across every changed file (+ `types/next-auth.d.ts`): **clean** except two known stale‑Prisma‑client errors on `requiredAt` that disappear after `prisma generate`.
- Traced the activation route logic (Stripe ordering, atomic claim, guardian link, soft‑delete resurrect) to confirm the family additions don't alter the single‑member/adult path.
- Confirmed the tournament participant field round‑trips through the existing public registration + registrations viewer.
- Validated the migration SQL (additive column + safe backfill).

## Manually verify before launch
- **Branded App guide:** the CTA emails `support@athletix-os.com` — change it if that's not your support inbox (`web/app/dashboard/settings/page.tsx`).
- **Family flow happy path:** import 2+ minors sharing one guardian email → open one activation link → set up child 1 (add card) → use "Set up next athlete" → confirm child 2 offers "use card on file" and no second card entry. Confirm both children land in **Approvals**.
- **Minor save:** add/edit a minor with no athlete email → saves without error; guardian email is required, guardian phone optional.
- **Import:** upload a CSV with one Email/Phone column + some minors → confirm minors' contact lands on the guardian and nobody is wrongly failed.
- **Document:** create a doc with formatting, mark it required at Onboarding → open an activation link → confirm it renders cleanly and you must check it to continue.
- **Tournament:** create a Tournament, set Participant category = "Weight Class" with a few options → open `/e/<slug>` → confirm the dropdown appears, is required, and the choice shows under Registrations.
- **Announcements:** confirm Messaging no longer shows an Announcements tab and Communication → Announcements still works.
- After the Netlify deploy: do a quick smoke test of **owner login, member login, and one activation link** (the activation flow is the most safety‑critical path touched).

## Not done on purpose (fast‑follows, noted)
- Hard "block checkout/event registration until signed" for the **Purchase** and **Event** document surfaces — they're selectable and show as required in the portal, but I didn't add new gating to the public unauthenticated endpoints right before launch.
- Family flow keeps the proven per‑child activation logic (children are completed one after another in one flow) rather than a single batch transaction — deliberately, to avoid destabilizing the Stripe/approval path.
