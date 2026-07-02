# AthletixOS — Repo Root Context

The full, current project context lives in **`web/CLAUDE.md`** — read it before touching members, activation, billing, guardian/minor flows, uploads, or DB migrations. This file captures only the repo-level basics.

## Layout

- Next.js 14 (App Router) app lives in `web/`.
- API routes: `web/app/api/**`. Pages: `web/app/**`. Prisma schema: `web/prisma/schema.prisma`. Shared code: `web/lib/**`. Components: `web/components/**`.
- Git lives at this repo root; build/verify from `web/`.

## Verify loop (every batch)

```
cd web && npx tsc --noEmit && npm run build
```

`web/tsconfig.json` has `"incremental": true`. If tsc looks suspiciously clean right after edits, delete `web/*.tsbuildinfo` and re-run — a stale incremental cache has produced false "clean" results before. `npm run build` is the real gate.

## Deploy pipeline

Push to GitHub `main` → Netlify auto-builds & deploys. You don't deploy directly, you push. The iOS app is a Capacitor wrapper that loads the live URL, so no `cap:sync` is needed for web changes.

## Database

Postgres on Supabase. Apply migrations with `npx prisma migrate deploy` (**not** `migrate dev` — the shadow DB is blocked by the pooler) and run it **before** pushing code that references new columns. Hand-write migration SQL folders. Add migrations only if truly needed, and explain them.

## Guardrails

Do **not**: rename core models, break onboarding links, break Stripe checkout, break active-membership detection, break role permissions, or remove existing data. Safe migrations only, explained before/after.

Two gotchas that already bit us:

1. When you replace an inline auth check with `requirePermission(session, …)`, TypeScript loses `session` null-narrowing → the build fails with "'session' is possibly null." Add an explicit `if (!session) return 401;` before the guard.
2. Permission model: `StaffProfile.permissions` is a JSON blob. Keys: `members, attendance, classes, events, schedule, messages, documents, finances, reports, staff`. Levels: `none, view, send, edit, full`. **OWNER bypasses everything.** Guard server-side with `requirePermission` (`web/lib/apiGuard.ts`) or `hasPermission` (`web/lib/permissions.ts`). **Privates are gated under the `events` key**, not a "privates" key.
