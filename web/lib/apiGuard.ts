import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hasPermission, hasMessagesSubScope, type PermissionKey, type PermissionLevel, type MessagesSubScope } from "@/lib/permissions";

// ── Live permission resolution ──────────────────────────────────────────────
//
// `session.user.permissions` is a SNAPSHOT minted by lib/auth.ts at sign-in and
// carried in the JWT. It does not change when an owner edits a staff profile,
// which breaks authorization in both directions:
//
//   - A GRANT does not take effect until the staff member re-authenticates.
//     `/api/me` reads the database live, so the nav shows the newly-granted
//     screen while every server guard still refuses it — the staff member can
//     see the button and is rejected when they press it. (Sal Jones, 2026-08-12:
//     billing set to full at 03:24, last actual login 2026-08-08.)
//   - A REVOCATION also does not take effect until re-login, which is the
//     dangerous direction: removing billing:full leaves the staff member with
//     billing access until their token happens to expire.
//
// So guards resolve from the database, cached briefly per user. One indexed
// lookup by userId, same 20s TTL pattern the Action Center already uses.
type PermCacheEntry = { at: number; perms: Record<string, unknown> | null };
const PERM_CACHE = new Map<string, PermCacheEntry>();
const PERM_TTL_MS = 20_000;

export function invalidatePermissionCache(userId: string) {
  PERM_CACHE.delete(userId);
}

async function livePermissions(userId: string): Promise<Record<string, unknown> | null> {
  const hit = PERM_CACHE.get(userId);
  if (hit && Date.now() - hit.at < PERM_TTL_MS) return hit.perms;
  try {
    const profile = await prisma.staffProfile.findUnique({
      where: { userId },
      select: { permissions: true },
    });
    const perms = (profile?.permissions ?? null) as Record<string, unknown> | null;
    PERM_CACHE.set(userId, { at: Date.now(), perms });
    return perms;
  } catch {
    // A lookup failure must not silently widen or narrow access — fall back to
    // the token snapshot, which is what every caller used before this existed.
    return undefined as unknown as Record<string, unknown> | null;
  }
}

// Loosely typed to match the rest of the codebase, which augments the
// next-auth Session with user.role / user.clubId / user.permissions and
// accesses them via casts.
type Sess =
  | { user?: { role?: string; clubId?: string; permissions?: Record<string, unknown> | null } }
  | null;

// Server-side permission guard for dashboard API routes.
//   - No session            → 401
//   - MEMBER                 → 403 (dashboard APIs are owner/staff only)
//   - OWNER                  → always allowed
//   - STAFF                  → allowed only if their resolved permission for
//                              `key` is at least `level`
// Returns a NextResponse to short-circuit on failure, or null when allowed.
//
// SYNCHRONOUS, token-snapshot version. Prefer `requirePermissionLive` on any
// route where a freshly granted or revoked permission must apply immediately.
export function requirePermission(
  session: Sess,
  key: PermissionKey,
  level: PermissionLevel,
): NextResponse | null {
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const role = (session.user as any)?.role as string | undefined;
  if (role === "OWNER") return null;
  if (role !== "STAFF") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const perms = (session.user as any)?.permissions as Record<string, unknown> | null;
  if (hasPermission(perms, key, level)) return null;
  return NextResponse.json(
    { error: `You don't have permission to ${level === "view" ? "view" : "manage"} this.` },
    { status: 403 },
  );
}

// Owner-only guard (settings, billing, staff management, contractors).
export function requireOwner(session: Sess): NextResponse | null {
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if ((session.user as any)?.role !== "OWNER") {
    return NextResponse.json({ error: "Owner access required" }, { status: 403 });
  }
  return null;
}

// Messaging sub-scope guard (plan §3L). Owner bypasses. Assumes the
// caller already ran requirePermission(session, "messages", "send"|"view")
// for the base level check — this is the second-tier gate that says
// "…and also has the bulk/marketing/etc. sub-scope enabled".
//
// Deliberate 403 message so a coach who accidentally hits the bulk API
// gets a legible error instead of a generic "Forbidden".
export function requireMessagesSubScope(
  session: Sess,
  scope: MessagesSubScope,
): NextResponse | null {
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const role = (session.user as any)?.role as string | undefined;
  if (role === "OWNER") return null;
  if (role !== "STAFF") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const perms = (session.user as any)?.permissions as Record<string, unknown> | null;
  if (hasMessagesSubScope(perms, scope)) return null;
  return NextResponse.json(
    {
      error: `You don't have the "messages.${scope}" permission. Ask an owner to enable it in Settings → Staff.`,
      code: "MESSAGES_SUBSCOPE_REQUIRED",
      requiredSubScope: scope,
    },
    { status: 403 },
  );
}


/**
 * Database-backed permission guard. Same contract as `requirePermission`, but
 * resolves the staff member's CURRENT permissions rather than the copy frozen
 * into their session token at sign-in.
 *
 * Use this anywhere a permission change has to take effect without the staff
 * member re-authenticating — which is every money-gated route.
 */
export async function requirePermissionLive(
  session: Sess,
  key: PermissionKey,
  level: PermissionLevel,
): Promise<NextResponse | null> {
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const role = (session.user as any)?.role as string | undefined;
  if (role === "OWNER") return null;
  if (role !== "STAFF") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const userId = (session.user as any)?.id as string | undefined;
  const tokenPerms = (session.user as any)?.permissions as Record<string, unknown> | null;

  let perms = tokenPerms;
  if (userId) {
    const live = await livePermissions(userId);
    // `undefined` means the lookup itself failed — keep the token snapshot.
    if (live !== undefined) perms = live;
  }

  if (hasPermission(perms, key, level)) return null;
  return NextResponse.json(
    { error: `You don't have permission to ${level === "view" ? "view" : "manage"} this.` },
    { status: 403 },
  );
}
