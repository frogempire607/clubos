"use client";

import ConnectionGuard from "@/components/ConnectionGuard";
import { SkeletonLine, SkeletonCard } from "@/components/LoadingSkeleton";
import { useState, useEffect } from "react";
import { useSession, getSession } from "next-auth/react";
import { signOutEverywhere } from "@/lib/signOutEverywhere";
import { useRouter, usePathname } from "next/navigation";
import GlobalSearch from "@/components/GlobalSearch";
import BackButton from "@/components/BackButton";
import UserMenu from "@/components/UserMenu";
import NotificationBell from "@/components/NotificationBell";
import DashboardSidebar from "@/components/DashboardSidebar";
import DashboardBottomNav from "@/components/DashboardBottomNav";

const BACKGROUND = "var(--color-bg)";
const TEXT = "var(--color-text)";

type Me = {
  role?: string;
  permissions?: Record<string, unknown> | null;
  title?: string | null;
  feeChoiceRequired?: boolean;
} | null;

function initialsOf(name: string | null | undefined, email: string | null | undefined): string {
  if (name) {
    const parts = name.trim().split(/\s+/).slice(0, 2);
    const initials = parts.map((p) => p[0]?.toUpperCase() ?? "").join("");
    if (initials) return initials;
  }
  return (email?.[0] ?? "?").toUpperCase();
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me>(null);

  // Gate /api/me on an authenticated session. Without the gate, the
  // fetch can race the NextAuth cookie commit (especially in WKWebView
  // and Safari) — the API returns 401, we silently swallow, and STAFF
  // users see the full nav instead of their filtered nav until the next
  // page navigation.
  useEffect(() => {
    if (status !== "authenticated") return;
    fetch("/api/me")
      .then((r) => {
        // The browser still holds a session cookie but the server says there is
        // no session: this login was removed (lib/auth.ts revokes it on the
        // next request). Sign out for real so the shell doesn't sit there with
        // every request failing.
        // Confirmed against /api/auth/session first, so a one-off 401 (the
        // WKWebView cookie race this effect is gated for) never signs anyone out.
        if (r.status === 401) {
          void getSession().then((s) => {
            if (!s) void signOutEverywhere();
          });
          return null;
        }
        return r.ok ? r.json() : null;
      })
      .then((d) => {
        if (d) setMe(d);
      })
      .catch(() => {});
  }, [status]);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  // Pricing overhaul (2026-10-18): until the OWNER saves their fee split once,
  // they're sent to Member payments, where an explainer says what changed.
  // Owners only — the member portal and staff logins are never redirected.
  // ONCE per browser session — never a trap: after the first redirect the
  // owner can go anywhere, and the banner on Member payments stays until they
  // save. (First version redirected on every page and locked owners out.)
  useEffect(() => {
    if (me?.role !== "OWNER" || !me.feeChoiceRequired || pathname === "/dashboard/settings/billing") return;
    let shown = false;
    try { shown = sessionStorage.getItem("aox:fee-choice-redirected") === "1"; } catch { shown = true; }
    if (shown) return;
    try { sessionStorage.setItem("aox:fee-choice-redirected", "1"); } catch { /* storage blocked: skip redirect */ }
    router.replace("/dashboard/settings/billing?feeChange=1");
  }, [me, pathname, router]);
  // The billing page fires this once the choice is saved.
  useEffect(() => {
    const done = () => setMe((m) => (m ? { ...m, feeChoiceRequired: false } : m));
    window.addEventListener("aox:fee-choice-made", done);
    return () => window.removeEventListener("aox:fee-choice-made", done);
  }, []);

  // While the session is being read, show the SHAPE of the dashboard rather
  // than a blank page with the word "Loading…": the frame is the same for
  // everyone, so it can be on screen immediately. No menu items are drawn —
  // what this person may open is not known yet.
  if (status === "loading") {
    return (
      <div
        className="dashboard-root"
        aria-busy="true"
        aria-label="Loading your dashboard"
        style={{ display: "flex", height: "100dvh", background: BACKGROUND }}
      >
        <aside className="hidden md:block" style={{ width: 248, flexShrink: 0, background: "var(--color-sidebar-bg, #1F1F23)" }} />
        <main className="flex-1 min-w-0">
          <div className="md:hidden" style={{ height: "calc(56px + env(safe-area-inset-top))", background: "var(--color-sidebar-bg, #1F1F23)" }} />
          <div className="p-4 md:p-6 space-y-4 max-w-5xl">
            <SkeletonLine width={192} height={28} />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        </main>
      </div>
    );
  }

  if (!session) return null;

  // Until /api/me answers — and for good if it fails — the menu is drawn from
  // the signed-in session's own role and permissions. It used to fall back to
  // "unknown role", which the nav treats as an owner: a coach saw the full
  // owner menu on every load, and permanently when that request errored.
  // (The server refused every screen behind it; this was the menu lying.)
  const sessionUser = session.user as { role?: string; permissions?: Record<string, unknown> | null };
  const viewer: NonNullable<Me> = me ?? { role: sessionUser.role, permissions: sessionUser.permissions ?? null };

  const email = session.user.email;
  const displayName = session.user.name || email || "";
  const initials = initialsOf(displayName, email);

  return (
    <div
      className="dashboard-root"
      style={{ display: "flex", height: "100dvh", background: BACKGROUND, color: TEXT }}
    >
      {/* Desktop sidebar — fixed 248px column, only at md+ */}
      <aside
        className="hidden md:flex"
        style={{ width: 248, flexShrink: 0, flexDirection: "column" }}
      >
        <DashboardSidebar email={email} me={viewer} pathname={pathname} />
      </aside>

      {/* Phones have no drawer: the bottom tab bar + /dashboard/more cover
          every destination (audit §6.2/§6.6). */}

      {/* ── Main content column ── */}
      {/* overflowX: "hidden" — safety net. CSS grid items inside `/dashboard`
          can briefly overflow at mount on iOS Safari before min-w-0 kicks
          in. Clipping here prevents the body-level horizontal scroll bar
          users were seeing on the iOS native shell. */}
      <main style={{ flex: 1, overflowY: "auto", overflowX: "hidden", display: "flex", flexDirection: "column" }}>
        {/* Mobile topbar (charcoal, matches sidebar tone for native-app feel) */}
        <div
          className="md:hidden sticky top-0 z-30 flex items-center gap-2 px-4 py-2 border-b border-white/10"
          style={{
            background: "var(--color-sidebar-bg)",
            paddingTop: "max(8px, env(safe-area-inset-top))",
          }}
        >
          <div className="flex-1 flex items-center gap-2 min-w-0 min-h-[44px]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/icon.png"
              alt=""
              className="w-7 h-7 rounded-md shrink-0"
            />
            <span
              className="text-white font-semibold text-sm tracking-tight truncate"
              style={{ fontFamily: "Georgia, serif" }}
            >
              AthletixOS
            </span>
          </div>
          <div className="shrink-0 flex items-center gap-1">
            <NotificationBell variant="onDark" />
            <UserMenu name={displayName} email={email} initials={initials} />
          </div>
        </div>

        {/* Mobile second row — Back + Search. Only renders when needed. */}
        <div
          className="md:hidden sticky z-20 flex items-center gap-2 px-3 py-2 border-b border-app-border"
          style={{ top: "calc(56px + env(safe-area-inset-top))", background: "var(--color-surface)" }}
        >
          {pathname !== "/dashboard" && <BackButton fallbackHref="/dashboard" />}
          <div className="flex-1 min-w-0">
            <GlobalSearch />
          </div>
        </div>

        {/* Desktop topbar */}
        <div
          className="hidden md:flex sticky top-0 z-30 items-center gap-3 px-4 py-2.5 border-b border-app-border"
          style={{ background: "var(--color-surface)" }}
        >
          {pathname !== "/dashboard" && <BackButton fallbackHref="/dashboard" />}
          <div className="flex-1 min-w-0">
            <GlobalSearch />
          </div>
          <NotificationBell variant="onSurface" />
          <UserMenu name={displayName} email={email} initials={initials} />
        </div>

        {/* Page content — extra bottom padding on mobile so the fixed
            bottom nav doesn't cover the last row of content. */}
        <div className="flex-1 pb-24 md:pb-0"><ConnectionGuard>{children}</ConnectionGuard></div>
      </main>

      {/* Mobile bottom nav — fixed, persistent. Permission-filtered for
          STAFF so they don't see tabs that dead-end on a 403 redirect. */}
      <DashboardBottomNav
        pathname={pathname}
        role={viewer.role}
        permissions={viewer.permissions}
      />
    </div>
  );
}
