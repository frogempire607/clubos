# AthletixOS — Onboarding / Import Fixes & Deliverables Report

**Date:** 2026-06-18 · **Club under test:** `frogempire607` (`cmq9xyrjx00008tc4xck1k9qo`)

Four fixes plus a clean-slate DB wipe. **All code changes are on disk under `web/` and still need to be pushed/deployed from your machine** (this environment can't run git). The DB cleanup is already applied to production.

---

## 1. Login fails after onboarding ("invalid password") — FIXED

**Root cause:** a **soft-deleted `users` row** for the same `(clubId, email)` blocks re-onboarding of that email.

- Deleting a member soft-deletes their member login (`deleteOrphanedMemberLogins` sets `users.deletedAt`).
- On re-onboarding, activation's `findUnique({ clubId_email })` finds the dead row (it ignores `deletedAt`), treats the account as "already exists," and **skips creating the user — so the new password is never stored.**
- `authorize()` rejects any user with `deletedAt`, so login returns "invalid password."
- Password resets couldn't help: reset updated the hash, but login still rejected the `deletedAt` user.

Confirmed in the live DB: `julianramirez1181@gmail.com` had a valid `$2a$12$…` hash but `deletedAt = 2026-06-18 03:05`. Same for `movincuban@gmail.com`.

**Fix**

| File | Change |
|------|--------|
| `web/app/api/members/migration/activate/[token]/route.ts` | **POST** resurrects a soft-deleted login (require password → set new `passwordHash`, clear `deletedAt`). Safe: a soft-deleted login has no active credentials and the owner issued the token; the takeover guard still protects **live** accounts. **GET** `hasAccount` now treats a soft-deleted login as "no account" so the password field is shown. |
| `web/app/api/member/signup/route.ts` | Resurrects a soft-deleted login instead of `create` (a `create` 500s on the global `(clubId,email)` unique). |
| `web/app/api/auth/forgot-password/route.ts` | Skips soft-deleted (revoked) logins — no reset link for an account that can't sign in. |
| `web/app/api/auth/reset-password/route.ts` | Rejects the reset token if the user is soft-deleted. |

---

## 2. Imported members default to Active instead of Prospect — FIXED

**Root cause:** the migration tool's member CSV already forced `PROSPECT`, but two paths leaked ACTIVE:
- The regular importer defaulted unknown/blank status to **ACTIVE** (and honored a CSV "Active" column).
- The membership second-pass pulled members into migration (`migrationStatus → IMPORTED`) **without downgrading `status`**, leaving them ACTIVE. (Confirmed: 39 members were ACTIVE + IMPORTED with no subscription.)

**Fix**

| File | Change |
|------|--------|
| `web/app/api/members/import/route.ts` | `normalizeStatus` **never returns ACTIVE** — ACTIVE/blank/unknown → `PROSPECT`; explicit inactive/cancelled → `INACTIVE`; paused/hold → `PAUSED`. |
| `web/app/api/members/import/memberships/route.ts` | Pulling a member into migration **downgrades a stale ACTIVE → PROSPECT**, guarded so it never demotes a member with a live subscription or one already `ACTIVATED`/`COMPLETED`. |

Members now only become ACTIVE after completing activation/approval (which assigns a membership + subscription).

---

## 3. Guardian requirement on member import — FIXED

Minors now require only guardian **name + email** for member import (phone is optional).

| File | Change |
|------|--------|
| `web/app/api/members/import/route.ts` | Dropped the `guardianPhone` requirement in the minor validation; message now "minors require a guardian name and email." |
| `web/app/dashboard/members/page.tsx` | Import modal's "CSV format tips" updated: "For minors: Guardian Name and Guardian Email (required); Guardian Phone optional." |

---

## 4. Migration import "Import failed" — FIXED (serverless timeout)

**Root cause:** every in-code error in the import route is caught per-row and still returns a 2xx, so a non-2xx after a ~10s spin can only be **Netlify's hard function timeout** killing the request mid-run. The migration path does up to **4 sequential DB round-trips per row** (duplicate check → guardian upsert → member insert → migration-event insert); through a cold cross-region pooler that stacks past ~10s even for a small file. The regular import is lighter (no event write), which is why it slipped under. (`resolveBillingAnchor` is loop-guarded — not an infinite loop.)

**Fix** (`web/app/api/members/import/route.ts`)
- Prefetch existing emails in **one** query (was a per-row DB call).
- Resolve each **unique** guardian once (was re-upserted per sibling).
- Create members in **concurrent batches of 5** (`IMPORT_CONCURRENCY`) — wall-clock drops from N round-trips to ~N/5.
- Added `export const maxDuration = 60` as headroom (host clamps to your plan's max).

---

## Database cleanup (production — applied earlier this session)

All member/guardian child tables are FK `CASCADE`/`SET NULL`, so one transaction cleaned everything.

| Deleted | Count |
|---|---|
| Members (all) | 1,190 |
| Guardian profiles | 209 |
| Member logins (`julianramirez1181@`, `movincuban@`) | 2 |
| Migration events / subscriptions / guardian links / signatures / relationships (cascaded) | 238 / 2 / 2 / 2 / 1 |

**Preserved:** OWNER `jramirez@frogempire607.com`, STAFF `sjones@frogempire607.com`, and all club config (5 memberships, 1 document, 2 events, 4 classes, staff profile). **Verified at the time:** 0 members / 0 guardians / 0 member logins; only the 2 owner/staff logins remained.

---

## Verification performed

| Check | Result |
|---|---|
| Type-check (`tsc --noEmit`) on all 8 changed files + next-auth types | **PASS (exit 0)** |
| `normalizeStatus` (verbatim) over 24 inputs — never returns ACTIVE | **PASS** (Active/blank/lead/trial → PROSPECT; cancelled/expired → INACTIVE; paused/hold → PAUSED) |
| Guardian rule — minor with name+email (no phone) accepted; name-only / email-only rejected | **PASS** |
| bcrypt round-trip (cost 12, app's `bcryptjs`) | **PASS** |
| Live-DB auth simulation* (sentinel: new → soft-delete → resurrect) | new = **login allowed**; deleted = **blocked** (bug repro); resurrect = **login allowed** with new password |
| Live-DB clean-state* (members/guardians/member-logins = 0; owner+staff intact) | **Confirmed** |
| Import batching wall-clock micro-sim (illustrative) | ~6.5s sequential → ~1.3s batched (~5×) |

\* The live-DB checks were run **earlier this session** and were green. The Supabase connector was invalidated near the end of this run, so they could not be re-run at report time — **reconnect Supabase** and I can re-confirm in seconds.

**Not done here:** a click-through of the hosted app (this environment can't boot the Next server) and a real-timing measurement of the import against Netlify+Supabase. Do one live smoke test after deploy (below).

---

## Deploy steps

```bash
cd ~/Desktop/clubos
git add -u web/            # stages tracked changes; excludes the untracked web/.mcp.json
git status                 # confirm web/.mcp.json is NOT staged
git commit -m "fix(onboarding+import): resurrect soft-deleted logins; imports default to PROSPECT; guardian name+email only; batch importer to avoid function timeout"
git push origin main
```

Netlify auto-builds on push (base `web`, `prisma generate && next build`). No DB migration is required (no schema changes). Watch the deploy to "Published" / green.

## Post-deploy smoke test

1. Migration-import a small CSV → members appear as **Prospect** (even rows marked "Active"); minors import with just guardian **name + email**.
2. The import completes quickly (no "Import failed").
3. Activate one member, set a password, log in immediately → works.
4. Delete that member, re-import + re-onboard the **same email**, set a new password → log in → works.

---

## Remaining risks / edge cases

- **Member self-signup** still creates the profile as `status: "ACTIVE"` with no subscription (self-signup path, not import — left unchanged; flag if you want it to start as Prospect too).
- **Existing JWT sessions persist up to the 14-day `maxAge`** — a member already signed in keeps a stale session after deletion until it expires; they just can't re-login.
- **Very large imports:** if a roster still approaches the function limit after batching, the next lever is a single bulk `createMany` (removes per-row round-trips entirely) — staged on request.
- **Supabase RLS advisory:** Row Level Security is disabled on `event_bundles` and `event_bundle_items`. The app uses the service-role key server-side, but the anon key would expose those two tables — worth enabling RLS + policies.
- **Other working-tree files** (`members/[id]`, `members/bulk`, `lib/memberLink.ts`, `CLAUDE.md`, `package*`) are from earlier sessions and will ride along on the next commit.
