// ═══════════════════════════════════════════════════════════════════════════
// Tenant-scoped Prisma client for Postgres Row Level Security.
// ═══════════════════════════════════════════════════════════════════════════
// How it works (full design: web/rls/README.md):
//   • RLS policies (migration 20260702000000_enable_rls) filter every tenant
//     table by the transaction-local GUC `app.club_id`.
//   • This module wraps EVERY Prisma operation (model queries AND raw
//     queries) in a batch transaction whose first statement is
//     `SELECT set_config('app.club_id', <clubId>, TRUE)`. Because both
//     statements run on the same connection inside one transaction, the GUC
//     is guaranteed to apply — and it evaporates at COMMIT, which makes this
//     safe behind PgBouncer/Supavisor transaction pooling.
//   • Enforcement requires connecting as the non-owner role `athletix_app`
//     (env APP_DATABASE_URL). Connecting as `postgres` silently bypasses RLS
//     — that's what the existing system client (lib/prisma.ts) is for:
//     webhooks, auth/login, signup, cron, cross-club admin.
//
// Usage in an API route:
//   const session = await getServerSession(authOptions);
//   if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
//   const db = tenantPrismaFromSession(session);      // throws if no clubId
//   const members = await db.member.findMany();        // ← only this club's rows
//
// Interactive transactions must use tenantTransaction() — see below.

import { PrismaClient } from "@prisma/client";

// ── Base client on the RLS-enforced role ─────────────────────────────────────
// Lazy so importing this module (e.g. from the test harness, which injects its
// own client) never opens a connection by side effect.
let _appPrisma: PrismaClient | null = null;

export function getAppPrisma(): PrismaClient {
  if (!_appPrisma) {
    const url = process.env.APP_DATABASE_URL;
    if (!url) {
      throw new Error(
        "APP_DATABASE_URL is not set. The tenant client must connect as the " +
          "RLS-enforced role (athletix_app), never as postgres — see web/rls/README.md.",
      );
    }
    _appPrisma = new PrismaClient({ datasources: { db: { url } } });
  }
  return _appPrisma;
}

// ── Core factory (dependency-injected so the harness tests the EXACT logic) ──
// Accepts any PrismaClient-shaped object (including driver-adapter clients).
type ClientLike = {
  $extends: (...args: any[]) => any;
  $transaction: (...args: any[]) => Promise<any>;
  $executeRaw: (...args: any[]) => any;
};

export function createTenantFactory<C extends ClientLike>(client: C) {
  return function forClub(clubId: string) {
    if (!clubId || typeof clubId !== "string") {
      throw new Error("forClub(clubId): a non-empty clubId string is required.");
    }
    return client.$extends({
      query: {
        // $allOperations at the top level covers every model operation AND
        // $queryRaw / $executeRaw. Each operation is batched into a transaction
        // with the set_config so the GUC and the query share one connection.
        // set_config's third arg TRUE = transaction-local (resets at COMMIT).
        async $allOperations({ args, query }: { args: unknown; query: (a: unknown) => Promise<unknown> }) {
          const [, result] = await client.$transaction([
            client.$executeRaw`SELECT set_config('app.club_id', ${clubId}, TRUE)`,
            query(args),
          ]);
          return result;
        },
      },
    }) as C; // same surface as the base client, now tenant-scoped
  };
}

// ── App-facing helpers ────────────────────────────────────────────────────────

// Cache one extended client per clubId (extending is cheap but not free, and
// routes call this on every request). Bounded to keep memory flat.
const cache = new Map<string, PrismaClient>();
const CACHE_MAX = 500;

/** Tenant-scoped Prisma client. Every query is RLS-constrained to `clubId`. */
export function tenantPrisma(clubId: string): PrismaClient {
  const hit = cache.get(clubId);
  if (hit) return hit;
  const created = createTenantFactory(getAppPrisma())(clubId);
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(clubId, created);
  return created;
}

// Matches the loose session shape used across the codebase (lib/apiGuard.ts).
type Sess = { user?: { clubId?: string } } | null | undefined;

/**
 * The standard way to get a DB handle inside an authenticated API route.
 * Throws when the session has no clubId — callers must have already 401'd
 * on a null session (same pattern as requirePermission).
 */
export function tenantPrismaFromSession(session: Sess): PrismaClient {
  const clubId = session?.user?.clubId;
  if (!clubId) {
    throw new Error(
      "tenantPrismaFromSession: session has no clubId. Return 401 before calling this.",
    );
  }
  return tenantPrisma(clubId);
}

/**
 * Interactive (callback-style) transactions CANNOT go through the extension
 * above — each inner operation would try to open its own nested batch on a
 * different pooled connection and the GUC would not apply. Use this instead:
 *
 *   await tenantTransaction(clubId, async (tx) => {
 *     const m = await tx.member.create({ ... });
 *     await tx.transaction.create({ ... });
 *   });
 *
 * The GUC is set as the first statement INSIDE the transaction, so every
 * subsequent statement in `fn` runs tenant-scoped on the same connection.
 */
export type TenantTx = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export async function tenantTransaction<T>(
  clubId: string,
  fn: (tx: TenantTx) => Promise<T>,
  opts?: { maxWait?: number; timeout?: number },
): Promise<T> {
  return tenantTransactionOn(getAppPrisma(), clubId, fn, opts);
}

// Same as tenantTransaction but on an explicit client — used by the RLS test
// harness so the identical code path is what gets proven.
export async function tenantTransactionOn<T>(
  client: ClientLike & { $transaction: PrismaClient["$transaction"] },
  clubId: string,
  fn: (tx: TenantTx) => Promise<T>,
  opts?: { maxWait?: number; timeout?: number },
): Promise<T> {
  if (!clubId) throw new Error("tenantTransaction: clubId is required.");
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.club_id', ${clubId}, TRUE)`;
    return fn(tx as never);
  }, opts);
}

/**
 * Startup sanity check (call once, e.g. from instrumentation.ts): verifies the
 * app connection really is RLS-enforced. Guards against the silent failure
 * mode where APP_DATABASE_URL points at postgres and RLS does nothing.
 */
export async function assertRlsEnforced(injected?: {
  $queryRaw: PrismaClient["$queryRaw"];
}): Promise<void> {
  const client = injected ?? getAppPrisma();
  const rows = await client.$queryRaw<
    Array<{ current_user: string; bypass: boolean; owns_tables: boolean }>
  >`
    SELECT
      current_user::text AS current_user,
      (SELECT (rolbypassrls OR rolsuper) FROM pg_roles WHERE rolname = current_user) AS bypass,
      EXISTS (
        SELECT 1 FROM pg_tables
        WHERE schemaname = 'public' AND tableowner = current_user::text
      ) AS owns_tables
  `;
  const r = rows[0];
  if (!r || r.bypass || r.owns_tables) {
    throw new Error(
      `RLS NOT ENFORCED for role "${r?.current_user}" (bypassrls=${r?.bypass}, ` +
        `owns_tables=${r?.owns_tables}). APP_DATABASE_URL must use the athletix_app role.`,
    );
  }
}
