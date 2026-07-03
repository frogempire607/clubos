# Postgres Row Level Security (RLS) — Tenant Isolation Project

Standalone project: database-enforced isolation so **Club A can never read, write, update, or delete Club B data**, even if an API route forgets a `where: { clubId }` filter. This is defense-in-depth *underneath* the existing app-level scoping — nothing about current behavior changes until the rollout steps below are executed.

**Status: built and proven on a local two-club harness (48/48 assertions). Not yet applied to production.**

---

## 1. Architecture

### The three pieces

| Piece | File | What it does |
|---|---|---|
| RLS policies | `web/prisma/migrations/20260702000000_enable_rls/migration.sql` | Enables RLS on **all 65 tables** and adds a `tenant_isolation` policy per table keyed on the transaction-local GUC `app.club_id` |
| App role | `web/rls/setup-app-role.sql` | Creates `athletix_app` (LOGIN, `NOBYPASSRLS`, owns nothing) — the role RLS is actually enforced against. Run once per environment, **not** a Prisma migration |
| Request wrapper | `web/lib/tenantPrisma.ts` | `tenantPrisma(clubId)` / `tenantPrismaFromSession(session)` — a Prisma client extension that wraps **every** operation (model + raw) in a transaction whose first statement is `set_config('app.club_id', $clubId, TRUE)` |

### How a request flows

```
API route → getServerSession → tenantPrismaFromSession(session)
  └─ every query runs as:  BEGIN;
                            SELECT set_config('app.club_id', 'club_xyz', TRUE);
                            <the actual query>;
                           COMMIT;
     connection role: athletix_app (RLS enforced)
     policies: WHERE "clubId" = app.current_club_id()   ← rows outside the club don't exist
```

Because `set_config(..., TRUE)` is **transaction-local** and shares the transaction (and therefore the connection) with the query, this is safe behind PgBouncer/Supavisor **transaction pooling** — the GUC can never leak to another request (proven by harness test T7.6).

### Two clients, two roles

| Client | Role | RLS | Use for |
|---|---|---|---|
| `tenantPrisma(clubId)` (new, `APP_DATABASE_URL`) | `athletix_app` | **enforced** | All session-scoped API routes |
| `prisma` from `lib/prisma.ts` (existing, `DATABASE_URL`) | `postgres` (table owner) | bypassed | Auth/login, signup (club creation), Stripe webhooks, activation-token flows, public `/e/[slug]` + `/join/[slug]` lookups, cron/admin |

We deliberately do **not** use `FORCE ROW LEVEL SECURITY`: the owner role bypassing RLS is what keeps migrations and the system paths working with zero changes. The trade-off — "the app must really connect as `athletix_app`" — is guarded by `assertRlsEnforced()` (call it from `instrumentation.ts` at boot; it throws if the app connection is owner/superuser/BYPASSRLS).

### Policy shapes

- **Tenant root** — `clubs`: `id = app.current_club_id()`.
- **51 direct tables** (have `clubId NOT NULL`): `"clubId" = app.current_club_id()`.
- **11 child tables** (no `clubId` column) scoped through an indexed parent FK with `EXISTS`:
  `staff_profiles→users`, `member_subscriptions→members`, `member_guardian_users→members`, `event_sessions→events`, `event_bundle_items→event_bundles`, `bookings→events+members` (both checked on write), `message_group_members→message_groups`, `group_messages→message_groups`, `document_signatures→documents`, `compensation_bonuses→staff_compensations`, `compensation_assignments→staff_compensations`.
- **`legal_acceptances`** (nullable `clubId`): scoped via owning `users` row.
- **`stripe_webhook_events`**: RLS enabled with **no policy** = deny-all for the app role; system client only.
- **Unset/empty GUC → NULL policy → zero rows, zero writes. Fail closed.**

All policies are `FOR ALL` with both `USING` (read/update-old/delete) and `WITH CHECK` (insert/update-new), so a tenant can't even re-home its own row into another club (harness T5.2).

### `tenantTransaction()`

Interactive (callback) transactions can't go through the per-operation wrapper (nested transactions on pooled connections). Use:

```ts
await tenantTransaction(clubId, async (tx) => {
  const m = await tx.member.create({ ... });
  await tx.transaction.create({ ... });
});
```

The GUC is set as the first statement inside the transaction — proven in harness T8.x.

---

## 2. Two-club proof harness

`web/rls/harness/` — fully self-contained; **never touches Supabase**. It boots a throwaway embedded Postgres, applies the repo's *real* migration chain (all 54, ending with `enable_rls`), creates `athletix_app` exactly as `setup-app-role.sql` does, seeds Club A and Club B across 11 models, then drives the **actual production wrapper** (`../../lib/tenantPrisma.ts`).

```bash
cd web/rls/harness
npm install
npm test        # exit 0 = proven
```

Coverage (48 assertions):

- **T0** completeness — every one of the 65 public tables has RLS enabled (catches any future table added without a policy)
- **T1** `assertRlsEnforced` passes for the app role, throws for the owner role
- **T2** positive controls — a club retains full CRUD on its *own* data (no lockout)
- **T3** read isolation — direct tables, child tables, `findUnique` by foreign id, raw SQL, relation `include`
- **T4** insert isolation — direct, child, and mixed-parent (A's event + B's member) writes all rejected by Postgres
- **T5** update isolation — by-id (P2025), `updateMany` (0 rows), cross-club re-homing rejected, B's data verified untouched
- **T6** delete isolation — by-id, `deleteMany`, child rows; B's data verified intact
- **T7** hardening — no-GUC fail-closed (read *and* write), SQL-injection attempt via clubId is inert, `forClub("")` throws, 40 interleaved A/B queries on one pool never cross tenants
- **T8** `tenantTransaction` — scoped multi-statement transactions, cross-club write inside a tx rejected

Last run: **48 passed, 0 failed** (2026-07-02, embedded Postgres 18.4). Note: the harness pins its own Prisma 6 (`engineType = "client"`, engine-free) independent of the app's Prisma 5.7 — the wrapper only uses the stable `$extends/$transaction/$executeRaw` surface, identical in both.

---

## 3. Rollout plan (staged — nothing breaks on merge)

Merging the branch changes **no runtime behavior**: no existing file is modified, the new migration only takes effect when you run `migrate deploy`, and even then the app still connects as `postgres` (owner → RLS bypassed) until routes adopt the wrapper. That's the safety ladder:

1. **Merge branch** (code only). Zero behavior change.
2. **Run the harness** on your machine (`cd web/rls/harness && npm i && npm test`) → 48/48.
3. **Staging first if possible.** On Supabase: run `web/rls/setup-app-role.sql` (SQL editor, choose a strong password), then `npx prisma migrate deploy`. Because nothing connects as `athletix_app` yet, production behavior is still unchanged — RLS is dormant.
4. **Add `APP_DATABASE_URL` to Netlify** (pooler URL, username `athletix_app.vhiqdtwxthmdqqizukab`).
5. **Adopt route-by-route**: swap `prisma` → `tenantPrismaFromSession(session)` in dashboard/member API routes, starting with low-risk read endpoints (reports, lists), then writes. Each PR is small and independently revertable.
6. **Boot guard**: once a meaningful set of routes is converted, call `assertRlsEnforced()` from `instrumentation.ts` so a mis-pointed `APP_DATABASE_URL` fails loudly at deploy, not silently.
7. **Keep on the system client permanently**: `lib/auth.ts` authorize, signup/club-creation, webhooks (`stripe_webhook_events` is deny-all for the app role by design), activation-token and public-slug routes, anything cron-like.

### Rollback

- Route level: revert the route to `prisma` (system client). Instant.
- DB level (last resort): `ALTER TABLE <t> DISABLE ROW LEVEL SECURITY;` per table, or drop the `tenant_isolation` policies. No data is ever touched by this project.

---

## 4. Review checklist

**SQL (`migration.sql`)**
- [ ] Table inventory complete: 1 root + 51 direct + 11 child + 2 special = **65 = every model in schema.prisma** (harness T0.1 re-verifies mechanically)
- [ ] Every policy is `FOR ALL` **and** has `WITH CHECK` (no insert/update escape)
- [ ] `app.current_club_id()` returns NULL for unset/empty GUC (fail closed — T7.0/T7.1)
- [ ] Child-table `EXISTS` policies point at the right parent + FK column
- [ ] `bookings` WITH CHECK validates **both** `eventId` and `memberId`
- [ ] `stripe_webhook_events` has RLS enabled and **no** policy (deny-all)
- [ ] Migration is idempotent (`DROP POLICY IF EXISTS`) and modifies no data
- [ ] No `FORCE ROW LEVEL SECURITY` anywhere (owner/system paths must keep working)

**Role (`setup-app-role.sql`)**
- [ ] `athletix_app` is `NOBYPASSRLS`, `NOSUPERUSER`, `NOINHERIT`, owns no tables
- [ ] `_prisma_migrations` revoked from the app role
- [ ] `ALTER DEFAULT PRIVILEGES` grants CRUD on future tables — **but grants ≠ policies**: every new tenant table needs its own RLS policy in its migration (add to code-review muscle memory; harness T0.1 catches misses)
- [ ] Password not committed anywhere; lives only in Netlify env

**Wrapper (`lib/tenantPrisma.ts`)**
- [ ] `set_config(..., TRUE)` (transaction-local) — never session-level (pooler safety)
- [ ] GUC and query share one `$transaction` batch (same connection guaranteed)
- [ ] Covers raw ops (`$queryRaw`/`$executeRaw`), not just models (T3.10)
- [ ] `forClub("")` / missing session clubId throw — no silent unscoped client
- [ ] Interactive transactions only via `tenantTransaction()` (documented + tested)
- [ ] `assertRlsEnforced()` wired into startup before declaring rollout done

**Operational**
- [ ] Harness run on reviewer's machine: 48/48
- [ ] `cd web && npx tsc --noEmit && npm run build` clean
- [ ] Supabase: role created + migration deployed on staging before prod
- [ ] `APP_DATABASE_URL` uses the pooler with the `athletix_app.<projectref>` username
- [ ] Post-deploy smoke: log into two different clubs, verify dashboards, member portal, booking, checkout
- [ ] Supabase advisors re-run (`get_advisors`) — RLS warnings for these tables should clear

**Known limits (accepted, documented)**
- Uniqueness collisions can still leak *existence* across tenants on globally-unique columns (e.g. `clubs.slug`, `users.resetToken`) — unchanged from today.
- RLS enforcement begins only when a route uses the tenant client; until adoption is complete, unconverted routes rely on app-level scoping exactly as today.
- The 11 child-table `EXISTS` policies add a PK lookup per row; all anchored on indexed columns. Watch p95 on `member_subscriptions`/`bookings`-heavy endpoints during adoption.

---

## 5. Branch & commit (run on your machine — sandbox can't run git)

Everything is **new files only**; nothing in your working tree was modified, so this stays cleanly out of the current security loop:

```bash
cd ~/Desktop/clubos
git checkout -b rls-tenant-isolation
git add web/prisma/migrations/20260702000000_enable_rls \
        web/rls \
        web/lib/tenantPrisma.ts
git commit -m "RLS tenant isolation: policies for all 65 tables, athletix_app role, tenant Prisma wrapper, two-club proof harness (48/48)"
git checkout main   # continue other work untouched
```

Add `web/rls/harness/node_modules`, `web/rls/harness/prisma/schema.prisma` (generated copy), and `web/rls/harness/.pgdata` to `.gitignore` if the harness has been run locally before committing.
