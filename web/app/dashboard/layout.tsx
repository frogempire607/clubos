"use client";

import { useState, useEffect } from "react";
import { useSession, signOut } from "next-auth/react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";

type NavChild = { id: string; label: string; href: string };
type NavItem =
  | { id: string; label: string; icon: string; href: string; children?: never }
  | { id: string; label: string; icon: string; href?: string; children: NavChild[] };

const NAV: NavItem[] = [
  { id: "dashboard",     label: "Dashboard",       icon: "⌂", href: "/dashboard" },
  { id: "members",       label: "Members",          icon: "◉", href: "/dashboard/members" },
  {
    id: "staff",
    label: "Staff",
    icon: "◎",
    children: [
      { id: "staff-home",         label: "Staff",        href: "/dashboard/staff" },
      { id: "staff-schedule",     label: "Schedule",     href: "/dashboard/staff/schedule" },
      { id: "staff-availability", label: "Availability", href: "/dashboard/staff/availability" },
      { id: "staff-payroll",      label: "Payroll",      href: "/dashboard/staff/payroll" },
    ],
  },
  {
    id: "purchase-options",
    label: "Purchase Options",
    icon: "◇",
    children: [
      { id: "memberships", label: "Memberships", href: "/dashboard/memberships" },
      { id: "privates",    label: "Privates",    href: "/dashboard/privates" },
      { id: "products",    label: "Products",    href: "/dashboard/products" },
    ],
  },
  { id: "classes",       label: "Classes & Events", icon: "◈", href: "/dashboard/classes" },
  { id: "attendance",    label: "Attendance",       icon: "✓", href: "/dashboard/attendance" },
  { id: "messages",      label: "Messaging",        icon: "✉", href: "/dashboard/messages" },
  { id: "announcements", label: "Announcements",    icon: "📢", href: "/dashboard/announcements" },
  { id: "financials",    label: "Financials",       icon: "$", href: "/dashboard/financials" },
  { id: "reports",       label: "Reports",          icon: "▦", href: "/dashboard/reports" },
  { id: "settings",      label: "Settings",         icon: "⚙", href: "/dashboard/settings" },
];

const SIDEBAR_BG     = "#1C1917";
const SIDEBAR_BORDER = "rgba(255,255,255,0.08)";
const ACTIVE_BG      = "#534AB7";
const TEXT_DIM       = "rgba(255,255,255,0.5)";
const TEXT_HOVER     = "#ffffff";
const CONTENT_BG     = "#F5F3EE";

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
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: CONTENT_BG }}>
        <div style={{ fontSize: 14, color: "#78716C" }}>Loading…</div>
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

  return (
    <div style={{ display: "flex", height: "100vh", background: CONTENT_BG }}>

      {/* ── Dark sidebar ── */}
      <aside style={{
        width: 224,
        background: SIDEBAR_BG,
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        overflowY: "auto",
      }}>

        {/* Logo */}
        <div style={{ padding: "16px 14px", borderBottom: `1px solid ${SIDEBAR_BORDER}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 3 }}>
            <div style={{
              width: 28, height: 28, borderRadius: 8,
              background: "#534AB7",
              display: "flex", alignItems: "center", justifyContent: "center",
              flexShrink: 0,
            }}>
              <span style={{ color: "#fff", fontWeight: 700, fontSize: 13 }}>C</span>
            </div>
            <span style={{
              color: "#fff", fontWeight: 600, fontSize: 15,
              letterSpacing: "-0.01em",
              fontFamily: "Georgia, serif",
            }}>
              ClubOS
            </span>
          </div>
          <div style={{ fontSize: 11, color: TEXT_DIM, paddingLeft: 38, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {session.user.email}
          </div>
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, padding: "8px 8px", display: "flex", flexDirection: "column", gap: 2 }}>
          {NAV.map((item) => {
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
                    fontSize: 13, textDecoration: "none",
                    fontWeight: active ? 500 : 400,
                    background: active ? ACTIVE_BG : "transparent",
                    color: active ? "#fff" : TEXT_DIM,
                    transition: "background 0.15s, color 0.15s",
                  }}
                  onMouseEnter={(e) => {
                    if (!active) {
                      (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.07)";
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
                  <span style={{ width: 16, textAlign: "center", fontSize: 12, opacity: 0.7 }}>{item.icon}</span>
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
                    fontSize: 13, border: "none", cursor: "pointer",
                    fontWeight: groupActive ? 500 : 400,
                    background: groupActive && !open ? "rgba(255,255,255,0.07)" : "transparent",
                    color: groupActive ? "#fff" : TEXT_DIM,
                    transition: "background 0.15s, color 0.15s",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.07)";
                    (e.currentTarget as HTMLElement).style.color = TEXT_HOVER;
                  }}
                  onMouseLeave={(e) => {
                    if (!(groupActive && !open)) {
                      (e.currentTarget as HTMLElement).style.background = groupActive && !open ? "rgba(255,255,255,0.07)" : "transparent";
                    }
                    (e.currentTarget as HTMLElement).style.color = groupActive ? "#fff" : TEXT_DIM;
                  }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ width: 16, textAlign: "center", fontSize: 12, opacity: 0.7 }}>{item.icon}</span>
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
                            fontSize: 12, textDecoration: "none",
                            fontWeight: active ? 500 : 400,
                            background: active ? ACTIVE_BG : "transparent",
                            color: active ? "#fff" : "rgba(255,255,255,0.4)",
                            transition: "background 0.15s, color 0.15s",
                          }}
                          onMouseEnter={(e) => {
                            if (!active) {
                              (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.07)";
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

        {/* Sign out */}
        <div style={{ padding: "10px 8px", borderTop: `1px solid ${SIDEBAR_BORDER}` }}>
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
              (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.07)";
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
      <main style={{ flex: 1, overflowY: "auto" }}>{children}</main>
    </div>
  );
}
