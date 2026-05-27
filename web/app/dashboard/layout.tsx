"use client";

import { useState, useEffect } from "react";
import { useSession, signOut } from "next-auth/react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import ThemeToggle from "@/components/ThemeToggle";
import GlobalSearch from "@/components/GlobalSearch";
import BackButton from "@/components/BackButton";
import { canAccessPath } from "@/lib/permissions";

type NavChild = { id: string; label: string; href: string };
type NavItem =
  | { id: string; label: string; icon: string; href: string; children?: never }
  | { id: string; label: string; icon: string; href?: string; children: NavChild[] };

const NAV: NavItem[] = [
  { id: "dashboard", label: "Dashboard", icon: "⌂", href: "/dashboard" },
  { id: "members", label: "Members", icon: "◉", href: "/dashboard/members" },
  {
    id: "staff",
    label: "Staff",
    icon: "◎",
    children: [
      { id: "staff-directory", label: "Directory", href: "/dashboard/staff" },
      { id: "staff-contractors", label: "Guest & Contractors", href: "/dashboard/staff/contractors" },
      { id: "staff-schedule", label: "Schedule", href: "/dashboard/staff/schedule" },
      { id: "staff-availability", label: "Availability", href: "/dashboard/staff/availability" },
      { id: "staff-payroll", label: "Payroll / Payouts", href: "/dashboard/staff/payroll" },
    ],
  },
  {
    id: "purchase-options",
    label: "Purchase Options",
    icon: "◇",
    children: [
      { id: "memberships", label: "Memberships", href: "/dashboard/purchase-options/memberships" },
      { id: "privates", label: "Privates", href: "/dashboard/purchase-options/privates" },
      { id: "products", label: "Products", href: "/dashboard/purchase-options/products" },
    ],
  },
  {
    id: "classes-events",
    label: "Classes & Events",
    icon: "◈",
    children: [
      { id: "classes", label: "Classes", href: "/dashboard/classes" },
      { id: "events", label: "Events", href: "/dashboard/events" },
      { id: "calendar", label: "Calendar", href: "/dashboard/calendar" },
    ],
  },
  {
    id: "communication",
    label: "Communication",
    icon: "✉",
    children: [
      { id: "messages", label: "Messaging", href: "/dashboard/messages" },
      { id: "announcements", label: "Announcements", href: "/dashboard/announcements" },
      { id: "campaigns", label: "Campaigns", href: "/dashboard/communication/campaigns" },
    ],
  },
  { id: "attendance", label: "Attendance", icon: "✓", href: "/dashboard/attendance" },
  { id: "financials", label: "Financials", icon: "$", href: "/dashboard/financials" },
  { id: "reports", label: "Reports", icon: "▦", href: "/dashboard/reports" },
  { id: "documents", label: "Documents", icon: "□", href: "/dashboard/documents" },
  { id: "settings", label: "Settings", icon: "⚙", href: "/dashboard/settings" },
];

const PRIMARY = "var(--color-primary)";
const BACKGROUND = "var(--color-bg)";
const TEXT = "var(--color-text)";
const MUTED = "var(--color-muted)";
const SIDEBAR_BG = "var(--color-sidebar-bg)";
const SIDEBAR_HOVER = "var(--color-sidebar-hover)";
const SIDEBAR_BORDER = "rgba(255,255,255,0.08)";
const TEXT_DIM = "rgba(229,231,235,0.72)";
const TEXT_HOVER = "#fff";

function isGroupActive(item: NavItem, pathname: string): boolean {
  if ("children" in item && item.children) {
    return item.children.some((c) => pathname.startsWith(c.href));
  }
  return false;
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const router   = useRouter();
  const pathname = usePathname();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [me, setMe] = useState<{ role: string; permissions: Record<string, unknown> | null; title?: string | null } | null>(null);

  useEffect(() => {
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setMe(d); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  useEffect(() => {
    const updates: Record<string, boolean> = {};
    NAV.forEach((item) => {
      if ("children" in item && item.children && isGroupActive(item, pathname)) {
        updates[item.id] = true;
      }
    });
    setExpanded((prev) => ({ ...prev, ...updates }));
  }, [pathname]);

  if (status === "loading") {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: BACKGROUND }}>
        <div style={{ fontSize: 14, color: MUTED }}>Loading…</div>
      </div>
    );
  }

  if (!session) return null;

  function toggle(id: string) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function isActive(href: string) {
    if (href === "/dashboard") return pathname === "/dashboard";
    return pathname === href || pathname.startsWith(href + "/");
  }

  // Role/permissions — prefer the live /api/me value, fall back to the
  // session token so owners don't see a flash of a restricted nav.
  const role = me?.role ?? ((session?.user as any)?.role as string | undefined);
  const perms = me?.permissions ?? ((session?.user as any)?.permissions ?? null);
  const isStaff = role === "STAFF";

  const visibleNav: NavItem[] = NAV.flatMap((item) => {
    if (!isStaff) return [item]; // owners see everything
    if ("children" in item && item.children) {
      const kids = item.children.filter((c) => canAccessPath(role, perms, c.href));
      if (kids.length === 0) return [];
      return [{ ...item, children: kids }];
    }
    const href = (item as { href: string }).href;
    return canAccessPath(role, perms, href) ? [item] : [];
  });

  return (
    <div className="dashboard-root" style={{ display: "flex", height: "100vh", background: BACKGROUND, color: TEXT }}>

      {/* ── Dark sidebar ── */}
      <aside style={{
        width: 248,
        background: SIDEBAR_BG,
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        overflowY: "auto",
      }}>

        {/* Logo */}
        <div style={{ padding: "16px 14px", borderBottom: `1px solid ${SIDEBAR_BORDER}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 3 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/icon.png"
              alt=""
              style={{ width: 28, height: 28, borderRadius: 8, flexShrink: 0, display: "block" }}
            />
            <span style={{
              color: "#fff", fontWeight: 600, fontSize: 15,
              letterSpacing: "-0.01em",
              fontFamily: "Georgia, serif",
            }}>
              AthletixOS
            </span>
          </div>
          <div style={{ fontSize: 11, color: TEXT_DIM, paddingLeft: 38, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {session.user.email}
          </div>
          {isStaff && (
            <div style={{ marginLeft: 38, marginTop: 4 }}>
              <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: "#fff", background: "rgba(255,255,255,0.14)", padding: "2px 7px", borderRadius: 6 }}>
                Staff view{me?.title ? ` · ${me.title}` : ""}
              </span>
            </div>
          )}
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, padding: "8px 8px", display: "flex", flexDirection: "column", gap: 2 }}>
          {visibleNav.map((item) => {
            const hasChildren = "children" in item && !!item.children;

            if (!hasChildren) {
              const href   = (item as { href: string }).href;
              const active = isActive(href);
              return (
                <Link
                  key={item.id}
                  href={href}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "7px 12px", borderRadius: 8,
                    borderLeft: `3px solid ${active ? PRIMARY : "transparent"}`,
                    fontSize: 13, textDecoration: "none",
                    fontWeight: active ? 500 : 400,
                    background: active ? SIDEBAR_HOVER : "transparent",
                    color: active ? "#fff" : TEXT_DIM,
                    transition: "background 0.15s, color 0.15s",
                  }}
                  onMouseEnter={(e) => {
                    if (!active) {
                      (e.currentTarget as HTMLElement).style.background = SIDEBAR_HOVER;
                      (e.currentTarget as HTMLElement).style.color = TEXT_HOVER;
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!active) {
                      (e.currentTarget as HTMLElement).style.background = "transparent";
                      (e.currentTarget as HTMLElement).style.color = TEXT_DIM;
                    }
                  }}
                >
                  <span style={{ width: 22, textAlign: "center", fontSize: 17, opacity: 0.85, lineHeight: 1 }}>{item.icon}</span>
                  {item.label}
                </Link>
              );
            }

            const open        = !!expanded[item.id];
            const groupActive = isGroupActive(item, pathname);

            return (
              <div key={item.id}>
                <button
                  onClick={() => toggle(item.id)}
                  style={{
                    width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "7px 12px", borderRadius: 8,
                    fontSize: 13, border: "none", borderLeft: `3px solid ${groupActive ? PRIMARY : "transparent"}`, cursor: "pointer",
                    fontWeight: groupActive ? 500 : 400,
                    background: groupActive ? SIDEBAR_HOVER : "transparent",
                    color: groupActive ? "#fff" : TEXT_DIM,
                    transition: "background 0.15s, color 0.15s",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.background = SIDEBAR_HOVER;
                    (e.currentTarget as HTMLElement).style.color = TEXT_HOVER;
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.background = groupActive ? SIDEBAR_HOVER : "transparent";
                    (e.currentTarget as HTMLElement).style.color = groupActive ? "#fff" : TEXT_DIM;
                  }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ width: 22, textAlign: "center", fontSize: 17, opacity: 0.85, lineHeight: 1 }}>{item.icon}</span>
                    {item.label}
                  </span>
                  <span style={{
                    fontSize: 12, color: "rgba(255,255,255,0.3)",
                    transform: open ? "rotate(90deg)" : "none",
                    display: "inline-block", transition: "transform 0.15s",
                  }}>›</span>
                </button>

                {open && (
                  <div style={{
                    marginLeft: 26, marginTop: 2,
                    paddingLeft: 10,
                    borderLeft: "1px solid rgba(255,255,255,0.1)",
                    display: "flex", flexDirection: "column", gap: 1,
                  }}>
                    {(item as { children: NavChild[] }).children.map((child) => {
                      const active = isActive(child.href);
                      return (
                        <Link
                          key={child.id}
                          href={child.href}
                          style={{
                            display: "block",
                            padding: "6px 10px", borderRadius: 7,
                            borderLeft: `2px solid ${active ? PRIMARY : "transparent"}`,
                            fontSize: 12, textDecoration: "none",
                            fontWeight: active ? 500 : 400,
                            background: active ? SIDEBAR_HOVER : "transparent",
                            color: active ? "#fff" : "rgba(255,255,255,0.4)",
                            transition: "background 0.15s, color 0.15s",
                          }}
                          onMouseEnter={(e) => {
                            if (!active) {
                              (e.currentTarget as HTMLElement).style.background = SIDEBAR_HOVER;
                              (e.currentTarget as HTMLElement).style.color = TEXT_HOVER;
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (!active) {
                              (e.currentTarget as HTMLElement).style.background = "transparent";
                              (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.4)";
                            }
                          }}
                        >
                          {child.label}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* Theme toggle */}
        <div style={{ padding: "10px 10px 0", display: "flex" }}>
          <ThemeToggle />
        </div>

        {/* My account — every signed-in user (owner + staff) can change
            their own password and update their name here, even if the owner
            hasn't granted any other dashboard permissions. */}
        <div style={{ padding: "4px 8px 0" }}>
          <Link
            href="/dashboard/my-account"
            style={{
              display: "flex", alignItems: "center", gap: 10,
              width: "100%", textAlign: "left",
              padding: "7px 12px", borderRadius: 8,
              fontSize: 13, textDecoration: "none",
              background: isActive("/dashboard/my-account") ? SIDEBAR_HOVER : "transparent",
              color: isActive("/dashboard/my-account") ? "#fff" : TEXT_DIM,
              transition: "background 0.15s, color 0.15s",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = SIDEBAR_HOVER;
              (e.currentTarget as HTMLElement).style.color = TEXT_HOVER;
            }}
            onMouseLeave={(e) => {
              if (!isActive("/dashboard/my-account")) {
                (e.currentTarget as HTMLElement).style.background = "transparent";
                (e.currentTarget as HTMLElement).style.color = TEXT_DIM;
              }
            }}
          >
            <span style={{ width: 22, textAlign: "center", fontSize: 16, opacity: 0.85, lineHeight: 1 }}>◎</span>
            My account
          </Link>
        </div>

        {/* Preview / Client view — owner & staff. Always shown so it's
            discoverable; the API enforces role on activation. */}
        <div style={{ padding: "4px 8px 0" }}>
          <Link
            href="/dashboard/preview"
            style={{
              display: "flex", alignItems: "center", gap: 10,
              width: "100%", textAlign: "left",
              padding: "7px 12px", borderRadius: 8,
              fontSize: 13, textDecoration: "none",
              background: isActive("/dashboard/preview") ? SIDEBAR_HOVER : "transparent",
              color: isActive("/dashboard/preview") ? "#fff" : TEXT_DIM,
              transition: "background 0.15s, color 0.15s",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = SIDEBAR_HOVER;
              (e.currentTarget as HTMLElement).style.color = TEXT_HOVER;
            }}
            onMouseLeave={(e) => {
              if (!isActive("/dashboard/preview")) {
                (e.currentTarget as HTMLElement).style.background = "transparent";
                (e.currentTarget as HTMLElement).style.color = TEXT_DIM;
              }
            }}
          >
            <span style={{ width: 22, textAlign: "center", fontSize: 16, opacity: 0.85, lineHeight: 1 }}>◐</span>
            Client view
          </Link>
        </div>

        {/* Need help */}
        <div style={{ padding: "10px 8px 0" }}>
          <Link
            href="/dashboard/help"
            style={{
              display: "flex", alignItems: "center", gap: 10,
              width: "100%", textAlign: "left",
              padding: "7px 12px", borderRadius: 8,
              fontSize: 13, textDecoration: "none",
              background: isActive("/dashboard/help") ? SIDEBAR_HOVER : "transparent",
              color: isActive("/dashboard/help") ? "#fff" : TEXT_DIM,
              transition: "background 0.15s, color 0.15s",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = SIDEBAR_HOVER;
              (e.currentTarget as HTMLElement).style.color = TEXT_HOVER;
            }}
            onMouseLeave={(e) => {
              if (!isActive("/dashboard/help")) {
                (e.currentTarget as HTMLElement).style.background = "transparent";
                (e.currentTarget as HTMLElement).style.color = TEXT_DIM;
              }
            }}
          >
            <span style={{ width: 22, textAlign: "center", fontSize: 16, opacity: 0.85, lineHeight: 1 }}>?</span>
            Need help?
          </Link>
        </div>

        {/* Sign out */}
        <div style={{ padding: "10px 8px", borderTop: `1px solid ${SIDEBAR_BORDER}`, marginTop: 8 }}>
          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            style={{
              width: "100%", textAlign: "left",
              padding: "7px 12px", borderRadius: 8,
              fontSize: 12, border: "none", cursor: "pointer",
              background: "transparent", color: TEXT_DIM,
              transition: "background 0.15s, color 0.15s",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = SIDEBAR_HOVER;
              (e.currentTarget as HTMLElement).style.color = TEXT_HOVER;
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = "transparent";
              (e.currentTarget as HTMLElement).style.color = TEXT_DIM;
            }}
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* ── Main content ── */}
      <main style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>
        <div
          style={{
            position: "sticky", top: 0, zIndex: 30,
            background: "var(--color-surface)",
            borderBottom: "1px solid var(--color-app-border, var(--color-border))",
            padding: "10px 16px",
            display: "flex", alignItems: "center", gap: 12,
          }}
        >
          {/* Back button — hidden on the dashboard home so the topbar
              doesn't get a dead "Back" that only points at itself. */}
          {pathname !== "/dashboard" && <BackButton fallbackHref="/dashboard" />}
          <GlobalSearch />
        </div>
        <div style={{ flex: 1 }}>{children}</div>
      </main>
    </div>
  );
}
