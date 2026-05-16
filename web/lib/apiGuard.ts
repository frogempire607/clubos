import { NextResponse } from "next/server";
import { hasPermission, type PermissionKey, type PermissionLevel } from "@/lib/permissions";

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
