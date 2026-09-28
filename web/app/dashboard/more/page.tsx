"use client";

// Phone "More" (audit §6.2/§6.6). The bottom tab bar is the only phone nav —
// no hamburger, no drawer — so this page lists every other destination the
// viewer can open, grouped like iOS Settings: section header, then 48px rows
// with icon, label and chevron. The list comes from the same NAV tree and the
// same canAccessPath filter the desktop sidebar uses (visibleNavFor), so the
// two can never disagree about what a staff member may open.
//
// No PATH_PERMISSIONS rule on purpose: everyone can open More; it only ever
// shows them what they are allowed into.
import { useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import {
  ChevronRight,
  Moon,
  CircleUserRound,
  Eye,
  HelpCircle,
  LogOut,
  UserCircle2,
  type LucideIcon,
} from "lucide-react";
import { applyTheme, readStoredTheme } from "@/components/ThemeToggle";
import { signOutEverywhere } from "@/lib/signOutEverywhere";
import { visibleNavFor, type NavChild, type NavItem } from "@/lib/dashboardNav";
import { SkeletonList } from "@/components/LoadingSkeleton";
import PageHeader from "@/components/PageHeader";

type Me = { role?: string; permissions?: Record<string, unknown> | null } | null;

type Row = { id: string; label: string; href: string; icon: LucideIcon };
type Section = { id: string; title: string; rows: Row[] };

function sectionsFrom(nav: NavItem[]): Section[] {
  // Leaves (Dashboard, Check-in, Financials…) gather into one "General"
  // section in NAV order; each group becomes its own section.
  const out: Section[] = [];
  let general: Section | null = null;
  for (const item of nav) {
    if ("children" in item && item.children) {
      out.push({
        id: item.id,
        title: item.label,
        rows: (item.children as NavChild[]).map((c) => ({ id: c.id, label: c.label, href: c.href, icon: item.icon })),
      });
    } else {
      if (!general) {
        general = { id: "general", title: "General", rows: [] };
        out.push(general);
      }
      general.rows.push({ id: item.id, label: item.label, href: (item as { href: string }).href, icon: item.icon });
    }
  }
  return out;
}

const rowCls =
  "flex min-h-[48px] w-full items-center gap-3 px-4 text-left text-[15px] text-text-primary hover:bg-app-bg active:bg-app-bg focus-ring-inset";

function RowLink({ row }: { row: Row }) {
  const Icon = row.icon;
  return (
    <li className="border-b border-app-border last:border-b-0">
      <Link href={row.href} className={rowCls}>
        <Icon className="h-5 w-5 shrink-0 text-text-muted" strokeWidth={2} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{row.label}</span>
        <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" aria-hidden />
      </Link>
    </li>
  );
}

function SectionBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h2 className="px-4 pb-1.5 text-[12px] font-semibold uppercase tracking-wide text-text-muted">{title}</h2>
      <ul className="overflow-hidden rounded-xl border border-app-border bg-surface">{children}</ul>
    </section>
  );
}

// The sidebar's ThemeToggle is styled for the dark sidebar; on this light
// surface it would be unreadable, so the row gets its own switch. Same storage
// key and applyTheme as ThemeToggle.
function AppearanceRow() {
  const [dark, setDark] = useState<boolean | null>(null);
  useEffect(() => {
    try {
      setDark(readStoredTheme() === "dark");
    } catch {
      setDark(false);
    }
  }, []);
  function flip() {
    const next = !dark;
    setDark(next);
    applyTheme(next ? "dark" : "light");
    try {
      window.localStorage.setItem("athletixos-theme", next ? "dark" : "light");
    } catch {}
  }
  return (
    <li className="border-b border-app-border">
      <button type="button" role="switch" aria-checked={!!dark} onClick={flip} className={rowCls}>
        <Moon className="h-5 w-5 shrink-0 text-text-muted" strokeWidth={2} aria-hidden />
        <span className="min-w-0 flex-1">Dark mode</span>
        <span
          aria-hidden
          className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors ${dark ? "bg-brand" : "bg-app-border"}`}
        >
          <span
            className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${dark ? "translate-x-[18px]" : "translate-x-0.5"}`}
          />
        </span>
      </button>
    </li>
  );
}

export default function MorePage() {
  const { data: session, status } = useSession();
  const [me, setMe] = useState<Me>(null);
  const [meLoaded, setMeLoaded] = useState(false);

  // Same source the layout uses for the sidebar: live role + permissions from
  // /api/me (a permissions change shows up without re-login). Falls back to the
  // session if the call fails, so the page never hangs on a skeleton.
  useEffect(() => {
    if (status !== "authenticated") return;
    let live = true;
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (live && d) setMe(d);
      })
      .catch(() => {})
      .finally(() => {
        if (live) setMeLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [status]);

  const sessionUser = session?.user as { role?: string; permissions?: Record<string, unknown> | null } | undefined;
  const role = me?.role ?? sessionUser?.role;
  const perms = me ? me.permissions ?? null : sessionUser?.permissions ?? null;
  const sections = sectionsFrom(visibleNavFor(role, perms));

  const account: Row[] = [
    { id: "my-profile", label: "My profile", href: "/dashboard/my-profile", icon: CircleUserRound },
    { id: "my-account", label: "My account", href: "/dashboard/my-account", icon: UserCircle2 },
    { id: "preview", label: "Client view", href: "/dashboard/preview", icon: Eye },
    { id: "help", label: "Help", href: "/dashboard/help", icon: HelpCircle },
  ];

  return (
    <div className="mx-auto w-full max-w-[640px] px-4 pb-32 pt-4 md:pb-8 md:pt-6">
      <PageHeader
        title="More"
      />

      {!meLoaded && status !== "unauthenticated" ? (
        <div className="rounded-xl border border-app-border bg-surface">
          <SkeletonList rows={6} />
        </div>
      ) : (
        sections.map((s) => (
          <SectionBlock key={s.id} title={s.title}>
            {s.rows.map((r) => (
              <RowLink key={r.id} row={r} />
            ))}
          </SectionBlock>
        ))
      )}

      <SectionBlock title="You">
        {account.map((r) => (
          <RowLink key={r.id} row={r} />
        ))}
        <AppearanceRow />
        <li>
          <button
            type="button"
            onClick={() => signOutEverywhere({ callbackUrl: "/login" })}
            className={rowCls}
            style={{ color: "var(--color-danger-text)" }}
          >
            <LogOut className="h-5 w-5 shrink-0" strokeWidth={2} aria-hidden />
            <span className="min-w-0 flex-1">Sign out</span>
          </button>
        </li>
      </SectionBlock>
    </div>
  );
}
