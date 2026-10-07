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
//
// ── Session revocation (2026-10-07) ─────────────────────────────────────────
//
// The same lookup now answers a second question: is this person STILL a staff
// member at all? A JWT lasts 14 days and nothing used to re-check `deletedAt`
// or `role`, so a coach removed on Monday kept working API access until the
// token expired. The live record below carries role + deletedAt + clubId, and:
//
//   - lib/auth.ts `jwt` callback reads it on EVERY getServerSession(): a
//     removed user gets no session at all (401 everywhere), a changed role or
//     permission set is refreshed into the session.
//   - requirePermissionLive / requireOwnerLive read it directly.
//   - requirePermission / requireOwner (synchronous) peek at the cached copy.
//
// Worst-case delay before a removal bites: PERM_TTL_MS (20s) per warm server
// instance. The instance that handles the removal invalidates its own cache
// (invalidatePermissionCache), so there it is immediate.
//
// Failure policy: if the lookup itself fails, the *Live guards FAIL CLOSED for
// staff (503 — nothing is changed) rather than trusting a possibly-revoked
// token. A token that says OWNER is still let through requirePermissionLive on
// a lookup failure (an owner can only be demoted by another owner, and a
// database outage fails the request anyway); requireOwnerLive — used for the
// few owner-making actions — fails closed for everyone.
export type LiveUser = {
  role: string;
  clubId: string;
  deleted: boolean;
  /** Raw StaffProfile.permissions JSON (levels + sub-scope maps), or null. */
  perms: Record<string, unknown> | null;
};
type PermCacheEntry = { at: number; user: LiveUser | null };
const PERM_CACHE = new Map<string, PermCacheEntry>();
export const PERM_TTL_MS = 20_000;

export function invalidatePermissionCache(userId: string) {
  PERM_CACHE.delete(userId);
}

/** The cached live record if it is still fresh. `undefined` = nothing cached. */
function peekLiveUser(userId: string | undefined): LiveUser | null | undefined {
  if (!userId) return undefined;
  const hit = PERM_CACHE.get(userId);
  if (hit && Date.now() - hit.at < PERM_TTL_MS) return hit.user;
  return undefined;
}

/**
 * The user's CURRENT row: role, club, removed-or-not, permissions.
 *   LiveUser   the row
 *   null       no such user
 *   undefined  the lookup failed (callers decide; see the failure policy above)
 */
export async function liveUser(userId: string): Promise<LiveUser | null | undefined> {
  const hit = PERM_CACHE.get(userId);
  if (hit && Date.now() - hit.at < PERM_TTL_MS) return hit.user;
  try {
    const row = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, clubId: true, deletedAt: true, staffProfile: { select: { permissions: true } } },
    });
    const user: LiveUser | null = row
      ? {
          role: row.role,
          clubId: row.clubId,
          deleted: !!row.deletedAt,
          perms: (row.staffProfile?.permissions ?? null) as Record<string, unknown> | null,
        }
      : null;
    PERM_CACHE.set(userId, { at: Date.now(), user });
    return user;
  } catch {
    return undefined;
  }
}

const REVOKED = () =>
  NextResponse.json(
    { error: "Your access to this club has ended. Please sign in again.", code: "SESSION_REVOKED" },
    { status: 401 },
  );
const UNVERIFIED = () =>
  NextResponse.json(
    { error: "We couldn't confirm your access just now, so nothing was changed. Please try again.", code: "ACCESS_CHECK_UNAVAILABLE" },
    { status: 503 },
  );

/** True when this live record no longer backs the session it was read for. */
function isRevoked(live: LiveUser | null, sessionClubId: string | undefined): boolean {
  return !live || live.deleted || (!!sessionClubId && live.clubId !== sessionClubId);
}

// Loosely typed to match the rest of the codebase, which augments the
// next-auth Session with user.role / user.clubId / user.permissions and
// accesses them via casts.
type Sess =
  | { user?: { id?: string; role?: string; clubId?: string; permissions?: Record<string, unknown> | null } }
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
  let role = (session.user as any)?.role as string | undefined;
  let perms = (session.user as any)?.permissions as Record<string, unknown> | null;
  // Cheap live-awareness: getServerSession() has just refreshed the live record
  // (lib/auth.ts jwt callback), so when a fresh copy is cached it wins over the
  // token — a removed or demoted user is refused here too. No I/O.
  const live = peekLiveUser((session.user as any)?.id);
  if (live !== undefined) {
    if (isRevoked(live, (session.user as any)?.clubId)) return REVOKED();
    role = live!.role;
    perms = live!.perms;
  }
  if (role === "OWNER") return null;
  if (role !== "STAFF") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (hasPermission(perms, key, level)) return null;
  return NextResponse.json(
    { error: `You don't have permission to ${level === "view" ? "view" : "manage"} this.` },
    { status: 403 },
  );
}

// Owner-only guard (settings, billing, staff management, contractors).
export function requireOwner(session: Sess): NextResponse | null {
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let role = (session.user as any)?.role as string | undefined;
  const live = peekLiveUser((session.user as any)?.id);
  if (live !== undefined) {
    if (isRevoked(live, (session.user as any)?.clubId)) return REVOKED();
    role = live!.role;
  }
  if (role !== "OWNER") {
    return NextResponse.json({ error: "Owner access required" }, { status: 403 });
  }
  return null;
}

/**
 * Owner-only, verified against the DATABASE rather than the token. Use for the
 * few actions that make or unmake an owner (creating an OWNER account, a setup
 * link for an owner, restoring a removed account): a stale token that still
 * says OWNER must not be enough. Fails CLOSED if the lookup fails.
 */
export async function requireOwnerLive(session: Sess): Promise<NextResponse | null> {
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = (session.user as any)?.id as string | undefined;
  if (!userId) return NextResponse.json({ error: "Owner access required" }, { status: 403 });
  const live = await liveUser(userId);
  if (live === undefined) return UNVERIFIED();
  if (isRevoked(live, (session.user as any)?.clubId)) return REVOKED();
  if (live!.role !== "OWNER") {
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
  let role = (session.user as any)?.role as string | undefined;
  let perms = (session.user as any)?.permissions as Record<string, unknown> | null;
  // Same cheap live-awareness as requirePermission: a sub-scope granted or
  // removed a moment ago applies without a re-login.
  const live = peekLiveUser((session.user as any)?.id);
  if (live !== undefined) {
    if (isRevoked(live, (session.user as any)?.clubId)) return REVOKED();
    role = live!.role;
    perms = live!.perms;
  }
  if (role === "OWNER") return null;
  if (role !== "STAFF") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
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
  const tokenRole = (session.user as any)?.role as string | undefined;
  const userId = (session.user as any)?.id as string | undefined;
  let role = tokenRole;
  let perms = (session.user as any)?.permissions as Record<string, unknown> | null;

  if (userId) {
    const live = await liveUser(userId);
    if (live === undefined) {
      // The lookup itself failed. Staff fail CLOSED — a token may be describing
      // someone who was removed a minute ago. See the failure policy up top.
      if (tokenRole !== "OWNER") {
        return tokenRole === "STAFF" ? UNVERIFIED() : NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    } else {
      if (isRevoked(live, (session.user as any)?.clubId)) return REVOKED();
      role = live!.role;
      perms = live!.perms;
    }
  }

  if (role === "OWNER") return null;
  if (role !== "STAFF") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (hasPermission(perms, key, level)) return null;
  return NextResponse.json(
    { error: `You don't have permission to ${level === "view" ? "view" : "manage"} this.` },
    { status: 403 },
  );
}

/** Boolean form of requirePermissionLive — "may this person do X right now?". */
export async function hasPermissionLive(
  session: Sess,
  key: PermissionKey,
  level: PermissionLevel,
): Promise<boolean> {
  return (await requirePermissionLive(session, key, level)) === null;
}

/**
 * Is the signed-in person an OWNER right now (database, not token)? False on a
 * failed lookup — callers use this to decide whether a self-rule applies, and
 * "not provably an owner" must get the stricter treatment.
 */
export async function isOwnerLive(session: Sess): Promise<boolean> {
  const userId = (session?.user as any)?.id as string | undefined;
  if (!session || !userId) return false;
  const live = await liveUser(userId);
  if (live === undefined || isRevoked(live, (session.user as any)?.clubId)) return false;
  return live!.role === "OWNER";
}
