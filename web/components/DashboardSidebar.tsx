"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { UserCircle2, Eye, HelpCircle, LogOut, ChevronRight, type LucideIcon } from "lucide-react";
import ThemeToggle from "@/components/ThemeToggle";
import { canAccessPath } from "@/lib/permissions";
import { signOutEverywhere } from "@/lib/signOutEverywhere";
import {
  NAV,
  type NavChild,
  type NavItem,
  isGroupActive,
  isItemActive,
} from "@/lib/dashboardNav";

const PRIMARY = "var(--color-primary)";
const SIDEBAR_BG = "var(--color-sidebar-bg)";
const SIDEBAR_HOVER = "var(--color-sidebar-hover)";
const SIDEBAR_BORDER = "rgba(255,255,255,0.08)";
const TEXT_DIM = "rgba(229,231,235,0.72)";
const TEXT_HOVER = "#fff";

type Me = { role?: string; permissions?: Record<string, unknown> | null; title?: string | null } | null;

// Extracted sidebar. Used by both the always-visible desktop column and
// the mobile slide-in drawer. Caller controls width/visibility — the
// component just renders the nav tree.
//
// `onNavigate` fires after any link click so the mobile drawer can close
// itself. Desktop layout passes nothing.
export default function DashboardSidebar({
  email,
  me,
  pathname,
  onNavigate,
  showSignOut = true,
}: {
  email: string | null | undefined;
  me: Me;
  pathname: string;
  onNavigate?: () => void;
  showSignOut?: boolean;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const updates: Record<string, boolean> = {};
    NAV.forEach((item) => {
      if ("children" in item && item.children && isGroupActive(item, pathname)) {
        updates[item.id] = true;
      }
    });
    setExpanded((prev) => ({ ...prev, ...updates }));
  }, [pathname]);

  function toggle(id: string) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  const role = me?.role;
  const perms = me?.permissions ?? null;
  const isStaff = role === "STAFF";

  const visibleNav: NavItem[] = NAV.flatMap((item) => {
    if (!isStaff) return [item];
    if ("children" in item && item.children) {
      const kids = item.children.filter((c) => canAccessPath(role, perms, c.href));
      if (kids.length === 0) return [];
      return [{ ...item, children: kids }];
    }
    const href = (item as { href: string }).href;
    return canAccessPath(role, perms, href) ? [item] : [];
  });

  return (
    <div
      style={{
        background: SIDEBAR_BG,
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflowY: "auto",
      }}
    >
      {/* Logo + email */}
      <div style={{ padding: "16px 14px", borderBottom: `1px solid ${SIDEBAR_BORDER}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 3 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/icon.png"
            alt=""
            style={{ width: 28, height: 28, borderRadius: 8, flexShrink: 0, display: "block" }}
          />
          <span
            style={{
              color: "#fff",
              fontWeight: 600,
              fontSize: 15,
              letterSpacing: "-0.01em",
              fontFamily: "Georgia, serif",
            }}
          >
            AthletixOS
          </span>
        </div>
        <div
          style={{
            fontSize: 11,
            color: TEXT_DIM,
            paddingLeft: 38,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {email}
        </div>
        {isStaff && (
          <div style={{ marginLeft: 38, marginTop: 4 }}>
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                color: "#fff",
                background: "rgba(255,255,255,0.14)",
                padding: "2px 7px",
                borderRadius: 6,
              }}
            >
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
            const href = (item as { href: string }).href;
            const active = isItemActive(href, pathname);
            const Icon = item.icon;
            return (
              <Link
                key={item.id}
                href={href}
                onClick={onNavigate}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "7px 12px",
                  borderRadius: 8,
                  borderLeft: `3px solid ${active ? PRIMARY : "transparent"}`,
                  fontSize: 13,
                  textDecoration: "none",
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
                <Icon size={18} strokeWidth={2} style={{ flexShrink: 0, opacity: active ? 1 : 0.85 }} />
                {item.label}
              </Link>
            );
          }

          const open = !!expanded[item.id];
          const groupActive = isGroupActive(item, pathname);
          const Icon = item.icon;

          return (
            <div key={item.id}>
              <button
                onClick={() => toggle(item.id)}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "7px 12px",
                  borderRadius: 8,
                  fontSize: 13,
                  border: "none",
                  borderLeft: `3px solid ${groupActive ? PRIMARY : "transparent"}`,
                  cursor: "pointer",
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
                  <Icon size={18} strokeWidth={2} style={{ flexShrink: 0, opacity: groupActive ? 1 : 0.85 }} />
                  {item.label}
                </span>
                <ChevronRight
                  size={14}
                  strokeWidth={2}
                  style={{
                    color: "rgba(255,255,255,0.4)",
                    transform: open ? "rotate(90deg)" : "none",
                    transition: "transform 0.15s",
                    flexShrink: 0,
                  }}
                />
              </button>

              {open && (
                <div
                  style={{
                    marginLeft: 26,
                    marginTop: 2,
                    paddingLeft: 10,
                    borderLeft: "1px solid rgba(255,255,255,0.1)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 1,
                  }}
                >
                  {(item as { children: NavChild[] }).children.map((child) => {
                    const active = isItemActive(child.href, pathname);
                    return (
                      <Link
                        key={child.id}
                        href={child.href}
                        onClick={onNavigate}
                        style={{
                          display: "block",
                          padding: "6px 10px",
                          borderRadius: 7,
                          borderLeft: `2px solid ${active ? PRIMARY : "transparent"}`,
                          fontSize: 12,
                          textDecoration: "none",
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

      {/* My account */}
      <div style={{ padding: "4px 8px 0" }}>
        <SidebarLink
          href="/dashboard/my-account"
          label="My account"
          icon={UserCircle2}
          pathname={pathname}
          onNavigate={onNavigate}
        />
      </div>

      {/* Client view */}
      <div style={{ padding: "4px 8px 0" }}>
        <SidebarLink
          href="/dashboard/preview"
          label="Client view"
          icon={Eye}
          pathname={pathname}
          onNavigate={onNavigate}
        />
      </div>

      {/* Help */}
      <div style={{ padding: "10px 8px 0" }}>
        <SidebarLink
          href="/dashboard/help"
          label="Need help?"
          icon={HelpCircle}
          pathname={pathname}
          onNavigate={onNavigate}
        />
      </div>

      {/* Sign out — preserves Phase 1 signOutEverywhere wiring */}
      {showSignOut && (
        <div style={{ padding: "10px 8px", borderTop: `1px solid ${SIDEBAR_BORDER}`, marginTop: 8 }}>
          <button
            onClick={() => signOutEverywhere({ callbackUrl: "/login" })}
            style={{
              width: "100%",
              textAlign: "left",
              padding: "7px 12px",
              borderRadius: 8,
              fontSize: 12,
              border: "none",
              cursor: "pointer",
              background: "transparent",
              color: TEXT_DIM,
              display: "flex",
              alignItems: "center",
              gap: 10,
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
            <LogOut size={16} strokeWidth={2} style={{ flexShrink: 0, opacity: 0.85 }} />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function SidebarLink({
  href,
  label,
  icon: Icon,
  pathname,
  onNavigate,
}: {
  href: string;
  label: string;
  icon: LucideIcon;
  pathname: string;
  onNavigate?: () => void;
}) {
  const active = isItemActive(href, pathname);
  return (
    <Link
      href={href}
      onClick={onNavigate}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        textAlign: "left",
        padding: "7px 12px",
        borderRadius: 8,
        fontSize: 13,
        textDecoration: "none",
        background: active ? SIDEBAR_HOVER : "transparent",
        color: active ? "#fff" : TEXT_DIM,
        transition: "background 0.15s, color 0.15s",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = SIDEBAR_HOVER;
        (e.currentTarget as HTMLElement).style.color = TEXT_HOVER;
      }}
      onMouseLeave={(e) => {
        if (!active) {
          (e.currentTarget as HTMLElement).style.background = "transparent";
          (e.currentTarget as HTMLElement).style.color = TEXT_DIM;
        }
      }}
    >
      <Icon size={16} strokeWidth={2} style={{ flexShrink: 0, opacity: active ? 1 : 0.85 }} />
      {label}
    </Link>
  );
}
