"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import { useRouter, usePathname } from "next/navigation";
import GlobalSearch from "@/components/GlobalSearch";
import BackButton from "@/components/BackButton";
import UserMenu from "@/components/UserMenu";
import DashboardSidebar from "@/components/DashboardSidebar";
import DashboardMobileDrawer from "@/components/DashboardMobileDrawer";
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
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) setMe(d);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  // Close the mobile drawer on every route change so a tap on a nav
  // link doesn't leave the overlay open over the new page.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

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

      {/* Mobile drawer — slides in from the left at < md */}
      <DashboardMobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        <DashboardSidebar
          email={email}
          me={me}
          pathname={pathname}
          onNavigate={() => setDrawerOpen(false)}
        />
      </DashboardMobileDrawer>

      {/* ── Main content column ── */}
      <main style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>
        {/* Mobile topbar (charcoal, matches sidebar tone for native-app feel) */}
        <div
          className="md:hidden sticky top-0 z-30 flex items-center gap-2 px-3 py-2 border-b border-white/10"
          style={{
            background: "var(--color-sidebar-bg)",
            paddingTop: "max(8px, env(safe-area-inset-top))",
          }}
        >
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open menu"
            className="w-10 h-10 rounded-lg flex items-center justify-center text-white/80 hover:text-white hover:bg-white/10"
          >
            <span className="text-xl leading-none">≡</span>
          </button>
          <div className="flex-1 flex items-center gap-2 min-w-0">
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
          <div className="shrink-0">
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
          <UserMenu name={displayName} email={email} initials={initials} />
        </div>

        {/* Page content — extra bottom padding on mobile so the fixed
            bottom nav doesn't cover the last row of content. */}
        <div className="flex-1 pb-24 md:pb-0">{children}</div>
      </main>

      {/* Mobile bottom nav — fixed, persistent */}
      <DashboardBottomNav
        pathname={pathname}
        onMore={() => setDrawerOpen(true)}
      />
    </div>
  );
}
