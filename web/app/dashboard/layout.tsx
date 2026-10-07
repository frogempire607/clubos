"use client";

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
const MUTED = "var(--color-muted)";

type Me = {
  role?: string;
  permissions?: Record<string, unknown> | null;
  title?: string | null;
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

  if (status === "loading") {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: BACKGROUND,
        }}
      >
        <div style={{ fontSize: 14, color: MUTED }}>Loading…</div>
      </div>
    );
  }

  if (!session) return null;

  const email = session.user.email;
  const displayName = session.user.name || email || "";
  const initials = initialsOf(displayName, email);

  return (
    <div
      className="dashboard-root"
      style={{ display: "flex", height: "100vh", background: BACKGROUND, color: TEXT }}
    >
      {/* Desktop sidebar — fixed 248px column, only at md+ */}
      <aside
        className="hidden md:flex"
        style={{ width: 248, flexShrink: 0, flexDirection: "column" }}
      >
        <DashboardSidebar email={email} me={me} pathname={pathname} />
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
        <div className="flex-1 pb-24 md:pb-0">{children}</div>
      </main>

      {/* Mobile bottom nav — fixed, persistent. Permission-filtered for
          STAFF so they don't see tabs that dead-end on a 403 redirect. */}
      <DashboardBottomNav
        pathname={pathname}
        role={me?.role}
        permissions={me?.permissions}
      />
    </div>
  );
}
