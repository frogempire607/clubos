"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import ProfileSwitcher from "@/components/member/ProfileSwitcher";
import BackButton from "@/components/BackButton";
import ParentalConsentGate from "@/components/member/ParentalConsentGate";
import { signOutEverywhere } from "@/lib/signOutEverywhere";
import type { BrandedAppConfig } from "@/lib/brandedApp";

// Primary tabs — 5 stable slots: Home · Book · Schedule · Messages · More.
// Book is the one purchase hub (/member/shop; Store demoted to a category
// inside it) and Schedule absorbs Bookings as an in-page tab, so neither
// needs its own slot. `also` lists extra route prefixes that keep a tab
// highlighted (deep links like /member/bookings or /member/products).
const NAV = [
  { href: "/member",          label: "Home",     icon: HomeIcon,    exact: true,  kind: "link" as const },
  { href: "/member/shop",     label: "Book",     icon: BookNowIcon, exact: false, kind: "link" as const,
    also: ["/member/products", "/member/memberships", "/member/events"] },
  { href: "/member/schedule", label: "Schedule", icon: BookingIcon, exact: false, kind: "link" as const,
    also: ["/member/bookings"] },
  { href: "/member/messages", label: "Messages", icon: MessageIcon, exact: false, kind: "link" as const },
  { href: "#more",            label: "More",     icon: MoreIcon,    exact: false, kind: "more" as const },
];

// The More sheet — three intentional groups instead of a flat drawer.
// Inbox = news + messages together; Your club = club (Our team lives
// inside it) + privates; Your account = account + sign out (appended in
// render). Documents stays here until the Account page surfaces it.
const MORE_GROUPS: {
  label: string;
  blurb: string;
  items: { href: string; label: string; desc: string; icon: ({ size }: { size: number }) => JSX.Element }[];
}[] = [
  {
    label: "Inbox",
    blurb: "News & messages, together.",
    items: [
      { href: "/member/announcements", label: "News",     desc: "Club updates",        icon: AnnouncementIcon },
      { href: "/member/messages",      label: "Messages", desc: "Chat with your club", icon: MessageIcon },
    ],
  },
  {
    label: "Your club",
    blurb: "About, team & support.",
    items: [
      { href: "/member/club",     label: "Club",     desc: "About, our team & support", icon: HomeIcon },
      { href: "/member/privates", label: "Privates", desc: "Book a coach 1:1",          icon: BookingIcon },
    ],
  },
  {
    label: "Your account",
    blurb: "Profile, family, billing & docs.",
    items: [
      { href: "/member/profile", label: "Account", desc: "Profile, family, billing & documents", icon: ProfileIcon },
    ],
  },
];

// Routes that render their own desktop AthleteRail (Phases 2–5). They get a
// wider desktop canvas and hide the layout's managing chips at `md` (the
// rail replaces them; the chips stay on mobile). Routes are added here in
// the same phase that ships the page's rail.
const RAIL_ROUTES: string[] = [
  "/member/profile",
  "/member/family",
  "/member/schedule",
  "/member/bookings",
  "/member/shop",
];

type ClubInfo = {
  name: string;
  primaryColor: string | null;
  logoUrl: string | null;
  appFontFamily?: string | null;
  appTextAlign?: string | null;
  brandedAppConfig?: BrandedAppConfig | null;
};

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export default function MemberLayout({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [club, setClub] = useState<ClubInfo | null>(null);
  const [previewMode, setPreviewMode] = useState<"member" | "public" | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [navHidden, setNavHidden] = useState(false);
  const [unread, setUnread] = useState(0);
  const [annUnread, setAnnUnread] = useState(0);

  // Close the More sheet whenever the route changes so the overlay
  // doesn't linger across navigation.
  useEffect(() => {
    setMoreOpen(false);
  }, [pathname]);

  // Esc closes the More sheet.
  useEffect(() => {
    if (!moreOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMoreOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moreOpen]);

  // Unread-message count for the Messages tab badge. Refetched on navigation
  // AND when a thread page signals it finished loading (the thread GET is what
  // marks messages read — refetching only on navigation raced that write and
  // left a stale badge, most visibly on mobile).
  useEffect(() => {
    function refresh() {
      fetch("/api/member/messages/unread", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : { count: 0, announcements: 0 }))
        .then((d) => {
          setUnread(typeof d?.count === "number" ? d.count : 0);
          setAnnUnread(typeof d?.announcements === "number" ? d.announcements : 0);
        })
        .catch(() => {});
    }
    refresh();
    window.addEventListener("aox:unread-refresh", refresh);
    return () => window.removeEventListener("aox:unread-refresh", refresh);
  }, [pathname]);

  // Hide the bottom tab bar on scroll-down, reveal on scroll-up (and near the
  // top) so it doesn't cover content while browsing on a phone.
  useEffect(() => {
    let lastY = window.scrollY;
    function onScroll() {
      const y = window.scrollY;
      const dy = y - lastY;
      if (Math.abs(dy) < 6) return;
      if (y < 40) setNavHidden(false);
      else setNavHidden(dy > 0);
      lastY = y;
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    fetch("/api/preview").then((r) => (r.ok ? r.json() : { mode: null })).then((d) => setPreviewMode(d?.mode ?? null)).catch(() => {});
  }, [pathname]);

  async function exitPreview() {
    await fetch("/api/preview", { method: "DELETE" });
    setPreviewMode(null);
    router.replace("/dashboard");
    router.refresh();
  }

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handler);
    if (window.matchMedia("(display-mode: standalone)").matches) setInstalled(true);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  useEffect(() => {
    fetch("/api/member/club")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setClub({
          name: d.name,
          primaryColor: d.primaryColor,
          logoUrl: d.logoUrl,
          appFontFamily: d.appFontFamily ?? null,
          appTextAlign: d.appTextAlign ?? null,
          brandedAppConfig: d.brandedAppConfig ?? null,
        });
        if (d.primaryColor) {
          const meta = document.querySelector('meta[name="theme-color"]');
          if (meta) meta.setAttribute("content", d.primaryColor);
        }
      })
      .catch(() => {});
  }, []);

  async function handleInstall() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === "accepted") { setInstalled(true); setInstallPrompt(null); }
  }

  function isActive(item: { href: string; exact: boolean; also?: string[] }) {
    if (item.exact) return pathname === item.href;
    if (pathname.startsWith(item.href)) return true;
    return (item.also ?? []).some((p) => pathname.startsWith(p));
  }

  const accent = club?.primaryColor || "#1C1917";
  const branded = club?.brandedAppConfig ?? null;
  const headerBg = branded?.style.headerBackgroundColor || accent;
  const headerText = branded?.style.headerTextColor || "#FFFFFF";
  const navBg = branded?.navigation.backgroundColor || "#FFFFFF";
  const activeNav = branded?.navigation.activeIconColor || accent;
  const inactiveNav = branded?.navigation.inactiveIconColor || "#a8a29e";
  const clubName = club?.name || "";
  // Branded-app personalization: font + alignment flow from owner settings.
  // We also publish the club accent as CSS variables on the portal root so the
  // shared member UI kit (components/member/ui.tsx + the `.member-portal` layer
  // in globals.css) brands every card, button, badge and switcher from one
  // source of truth. Only append alpha when the accent is a real 6-digit hex.
  const isHex6 = /^#[0-9a-fA-F]{6}$/.test(accent);
  // CSS custom properties aren't part of the typed CSSProperties surface, so we
  // build them as a plain record and cast the merged style once.
  const accentVars: Record<string, string> = isHex6
    ? {
        "--club-accent": accent,
        "--club-accent-contrast": headerText,
        "--club-accent-soft": `${accent}14`,
        "--club-accent-ring": `${accent}2E`,
      }
    : { "--club-accent-contrast": headerText };
  const brandedStyle = {
    ...accentVars,
    ...(club?.appFontFamily ? { fontFamily: club.appFontFamily } : {}),
    ...(club?.appTextAlign
      ? { textAlign: club.appTextAlign as "left" | "center" | "right" }
      : {}),
  } as React.CSSProperties;
  const portalNav = buildPortalNav(branded);
  // Branded navs may not include a Messages link — unread DMs then surface on
  // the More slot (and on the Messages row inside the sheet). The two counts
  // stay independent; More just aggregates what lives behind it.
  const navHasMessages = portalNav.some((i) => "href" in i && i.href === "/member/messages");
  const moreBadge = annUnread + (navHasMessages ? 0 : unread);
  const railRoute = RAIL_ROUTES.some((r) => pathname.startsWith(r));

  return (
    <div className="min-h-screen bg-stone-50 native-shell-root member-portal" style={brandedStyle}>
      {/* Preview-mode banner. Only visible to owner/staff sessions that
          activated preview from the dashboard; members never see this. */}
      {previewMode && (
        <div className="bg-amber-100 border-b border-amber-300 text-amber-900 text-xs sm:text-sm">
          <div className="max-w-4xl mx-auto px-4 py-2 flex items-center justify-between gap-3">
            <span>
              <strong>Preview mode</strong> — you&apos;re seeing what your members see.
              Real member data isn&apos;t loaded.
            </span>
            <button
              onClick={exitPreview}
              className="text-xs px-3 py-1 rounded-lg bg-amber-900 text-amber-50 hover:bg-amber-800 font-medium flex-shrink-0"
            >
              Exit preview
            </button>
          </div>
        </div>
      )}

      {/* ── Desktop top bar ── */}
      <header className="bg-white border-b border-stone-200 sticky top-0 z-40 hidden md:block">
        <div className="max-w-4xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/member" className="flex items-center gap-2.5 flex-shrink-0">
              <ClubLogo logoUrl={club?.logoUrl} name={clubName} accent={accent} size={28} />
              {clubName && (
                <span className="text-sm font-semibold text-stone-900 max-w-[160px] truncate">
                  {clubName}
                </span>
              )}
            </Link>
            <nav className="flex gap-0.5">
              {portalNav.map((item) => {
                const active = isActive(item);
                const Icon = item.icon;
                // Desktop badge counts: unread DMs on Messages, unseen
                // announcements on the item that leads to News.
                const badge =
                  "kind" in item && item.kind === "more"
                    ? moreBadge
                    : "href" in item && item.href === "/member/messages"
                      ? unread
                      : "href" in item && item.href === "/member/announcements"
                        ? annUnread
                        : 0;
                if ("kind" in item && item.kind === "more") {
                  return (
                    <button
                      key="more"
                      type="button"
                      onClick={() => setMoreOpen(true)}
                      aria-label="Open more menu"
                      aria-expanded={moreOpen}
                      className={`relative flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                        moreOpen ? "" : "text-stone-500 hover:text-stone-900 hover:bg-stone-100"
                      }`}
                      style={moreOpen ? { background: headerBg, color: headerText, borderRadius: branded?.style.borderRadius } : {}}
                    >
                      <Icon size={14} />
                      {item.label}
                      {badge > 0 && (
                        <span className="ml-0.5 min-w-[16px] h-[16px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold inline-flex items-center justify-center">
                          {badge > 9 ? "9+" : badge}
                        </span>
                      )}
                    </button>
                  );
                }
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`relative flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                      active ? "" : "text-stone-500 hover:text-stone-900 hover:bg-stone-100"
                    }`}
                    style={active ? { background: headerBg, color: headerText, borderRadius: branded?.style.borderRadius } : {}}
                  >
                    <Icon size={14} />
                    {item.label}
                    {badge > 0 && (
                      <span className="ml-0.5 min-w-[16px] h-[16px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold inline-flex items-center justify-center">
                        {badge > 9 ? "9+" : badge}
                      </span>
                    )}
                  </Link>
                );
              })}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-stone-500">{session?.user?.name}</span>
            <button
              onClick={() => signOutEverywhere({ callbackUrl: "/login" })}
              className="text-xs text-stone-400 hover:text-stone-700 px-2 py-1.5 rounded-lg hover:bg-stone-100 transition"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      {/* ── Mobile top bar ── */}
      <header className="sticky top-0 z-40 md:hidden safe-area-top" style={{ background: headerBg, color: headerText }}>
        <div className="px-4 h-13 flex items-center justify-between" style={{ height: "52px" }}>
          <Link href="/member" className="flex items-center gap-2">
            <ClubLogo logoUrl={club?.logoUrl} name={clubName} accent={accent} size={30} light />
            {clubName && (
              <span className="text-sm font-semibold max-w-[160px] truncate" style={{ color: headerText }}>
                {clubName}
              </span>
            )}
          </Link>
          <button
            onClick={() => signOutEverywhere({ callbackUrl: "/login" })}
            className="text-xs px-2 py-1 opacity-75 hover:opacity-100"
            style={{ color: headerText }}
          >
            {session?.user?.name?.split(" ")[0] || "Sign out"}
          </button>
        </div>
      </header>

      {/* ── PWA install banner ── */}
      {installPrompt && !installed && (
        <div className="px-4 py-2.5 flex items-center justify-between md:hidden" style={{ background: headerBg, color: headerText }}>
          <div>
            <p className="text-sm font-semibold">{clubName ? `Add ${clubName} to Home Screen` : "Add to Home Screen"}</p>
            <p className="text-xs opacity-70">Get the full app experience</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setInstallPrompt(null)} className="text-xs opacity-60 px-2 py-1">
              Not now
            </button>
            <button
              onClick={handleInstall}
              className="text-xs px-3 py-1.5 rounded-lg font-semibold bg-white"
              style={{ color: headerBg, borderRadius: branded?.style.borderRadius }}
            >
              Install
            </button>
          </div>
        </div>
      )}

      {/* ── Page content ── */}
      <main
        className={`${railRoute ? "max-w-4xl md:max-w-6xl" : "max-w-4xl"} mx-auto px-4 md:px-6 py-5 pb-24 md:pb-10 safe-area-content-bottom`}
      >
        {/* Universal back button. Hidden on the member home so the header
            isn't cluttered with a back link that points at the same page. */}
        {pathname !== "/member" && (
          <div className="mb-3">
            <BackButton fallbackHref="/member" />
          </div>
        )}
        {/* On rail routes the page renders its own desktop AthleteRail, so
            the managing chips only show on mobile there. */}
        <div className={railRoute ? "md:hidden" : ""}>
          <ProfileSwitcher />
        </div>
        {children}
      </main>

      {/* COPPA: blocking consent overlay for guardians who still owe consent
          for a minor. Inert unless FEATURE_PARENTAL_CONSENT is enabled. */}
      <ParentalConsentGate />

      {/* ── Mobile bottom tab bar ── */}
      <nav className={`fixed bottom-0 left-0 right-0 z-40 border-t border-stone-200 md:hidden safe-area-bottom transition-transform duration-300 ${navHidden ? "translate-y-full" : "translate-y-0"}`} style={{ background: navBg }}>
        <div className="grid" style={{ height: "60px", gridTemplateColumns: `repeat(${portalNav.length}, minmax(0, 1fr))` }}>
          {portalNav.map((item) => {
            const active = "kind" in item && item.kind === "more" ? moreOpen : isActive(item);
            const Icon = item.icon;
            const inner = (
              <>
                <span
                  className="relative flex items-center justify-center rounded-xl transition-all"
                  style={active ? { background: `${activeNav}18`, padding: "5px 10px", borderRadius: branded?.style.borderRadius } : { padding: "5px 10px" }}
                >
                  <Icon size={20} />
                  {"href" in item && item.href === "/member/messages" && unread > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] px-1 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">
                      {unread > 9 ? "9+" : unread}
                    </span>
                  )}
                  {/* Unseen announcements (and unread DMs when Messages isn't
                      a top-level tab) live behind More. */}
                  {"kind" in item && item.kind === "more" && moreBadge > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] px-1 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">
                      {moreBadge > 9 ? "9+" : moreBadge}
                    </span>
                  )}
                </span>
                <span className="text-[10px] font-medium leading-none">{item.label}</span>
              </>
            );
            if ("kind" in item && item.kind === "more") {
              return (
                <button
                  key="more"
                  type="button"
                  onClick={() => setMoreOpen(true)}
                  aria-label="Open more menu"
                  aria-expanded={moreOpen}
                  className="flex flex-col items-center justify-center gap-0.5 transition-colors bg-transparent border-none"
                  style={{ color: active ? activeNav : inactiveNav }}
                >
                  {inner}
                </button>
              );
            }
            return (
              <Link
                key={item.href}
                href={item.href}
                className="flex flex-col items-center justify-center gap-0.5 transition-colors"
                style={{ color: active ? activeNav : inactiveNav }}
              >
                {inner}
              </Link>
            );
          })}
        </div>
      </nav>

      {/* ── More sheet — grouped bottom sheet on mobile, 3-column hub on
             desktop (2e / 1g): Inbox · Your club · Your account. ── */}
      {moreOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end md:items-center md:justify-center"
          onClick={() => setMoreOpen(false)}
        >
          <div className="absolute inset-0 bg-black/40" aria-hidden />
          <div
            className="relative w-full bg-white rounded-t-2xl shadow-2xl safe-area-bottom md:max-w-3xl md:rounded-2xl max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="More"
          >
            <div className="flex items-center justify-between px-5 pt-4 pb-1">
              <div>
                <h2 className="text-base font-semibold text-stone-900">More</h2>
                <p className="text-xs text-stone-500 hidden md:block">
                  Inbox, your club, and your account — everything that isn&apos;t a daily tab.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setMoreOpen(false)}
                aria-label="Close more menu"
                className="text-stone-400 hover:text-stone-700 w-9 h-9 flex items-center justify-center rounded-lg hover:bg-stone-100"
              >
                ×
              </button>
            </div>
            <div className="px-3 pb-4 md:px-5 md:pb-6 md:grid md:grid-cols-3 md:gap-4 md:pt-2">
              {MORE_GROUPS.map((group) => (
                <div key={group.label} className="md:rounded-2xl md:border md:border-stone-200 md:p-1.5">
                  <div className="px-2 pt-3 pb-1 md:pt-2">
                    <p className="text-[11px] font-bold uppercase tracking-[0.05em] text-stone-400">
                      {group.label}
                    </p>
                    <p className="text-[11px] text-stone-500 hidden md:block">{group.blurb}</p>
                  </div>
                  {group.items.map((it) => {
                    const Icon = it.icon;
                    const rowBadge =
                      it.href === "/member/announcements" ? annUnread : it.href === "/member/messages" ? unread : 0;
                    return (
                      <Link
                        key={it.href}
                        href={it.href}
                        className="flex items-center gap-3 px-2 py-2.5 rounded-xl hover:bg-stone-50 transition"
                      >
                        <span
                          className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
                          style={{ background: `${accent}18`, color: accent }}
                        >
                          <Icon size={18} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-stone-900">{it.label}</div>
                          <div className="text-xs text-stone-500">{it.desc}</div>
                        </div>
                        {rowBadge > 0 && (
                          <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold inline-flex items-center justify-center flex-shrink-0">
                            {rowBadge > 9 ? "9+" : rowBadge}
                          </span>
                        )}
                        <svg
                          className="text-stone-300 flex-shrink-0"
                          width="16"
                          height="16"
                          viewBox="0 0 20 20"
                          fill="currentColor"
                          aria-hidden
                        >
                          <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
                        </svg>
                      </Link>
                    );
                  })}
                  {/* Sign out lives at the bottom of "Your account". */}
                  {group.label === "Your account" && (
                    <button
                      type="button"
                      onClick={() => { setMoreOpen(false); signOutEverywhere({ callbackUrl: "/login" }); }}
                      className="w-full flex items-center gap-3 px-2 py-2.5 rounded-xl hover:bg-stone-50 transition text-left"
                    >
                      <span className="w-9 h-9 rounded-full bg-stone-100 text-stone-500 flex items-center justify-center flex-shrink-0">
                        <SignOutIcon size={18} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-stone-900">Sign out</div>
                        <div className="text-xs text-stone-500">End your session on this device</div>
                      </div>
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Club logo component ── */
function ClubLogo({
  logoUrl,
  name,
  accent,
  size,
  light = false,
}: {
  logoUrl: string | null | undefined;
  name: string;
  accent: string;
  size: number;
  light?: boolean;
}) {
  if (logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt={name}
        width={size}
        height={size}
        className="rounded-lg object-cover flex-shrink-0"
        style={{ width: size, height: size }}
      />
    );
  }
  // Initials fallback
  const initials = name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
  return (
    <span
      className="rounded-lg flex items-center justify-center text-[11px] font-bold flex-shrink-0"
      style={{
        width: size,
        height: size,
        background: light ? "rgba(255,255,255,0.25)" : `${accent}22`,
        color: light ? "#fff" : accent,
      }}
    >
      {initials || "C"}
    </span>
  );
}

/* ── Minimal SVG icon components ── */
function HomeIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor">
      <path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7a1 1 0 001.414 1.414L4 10.414V17a1 1 0 001 1h4a1 1 0 001-1v-3h2v3a1 1 0 001 1h4a1 1 0 001-1v-6.586l.293.293a1 1 0 001.414-1.414l-7-7z" />
    </svg>
  );
}
function MessageIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9z" clipRule="evenodd" />
    </svg>
  );
}
function BookingIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z" clipRule="evenodd" />
    </svg>
  );
}
function AnnouncementIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor">
      <path d="M18 3a1 1 0 00-1.447-.894L8.763 6H5a3 3 0 000 6h.28l1.771 5.316A1 1 0 008 18h1a1 1 0 001-1v-4.382l6.553 3.276A1 1 0 0018 15V3z" />
    </svg>
  );
}
function DocumentIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clipRule="evenodd" />
    </svg>
  );
}
function CheckSquareIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M16 4a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2h12zm-1.293 5.293a1 1 0 00-1.414-1.414L9 12.172 7.707 10.879a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l5-5z" clipRule="evenodd" />
    </svg>
  );
}
function MoreIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor">
      <circle cx="4.5" cy="10" r="1.5" />
      <circle cx="10" cy="10" r="1.5" />
      <circle cx="15.5" cy="10" r="1.5" />
    </svg>
  );
}
function SignOutIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M3 4a1 1 0 011-1h8a1 1 0 110 2H5v10h7a1 1 0 110 2H4a1 1 0 01-1-1V4zm12.293 4.293a1 1 0 011.414 0l2 2a1 1 0 010 1.414l-2 2a1 1 0 01-1.414-1.414L15.586 11H9a1 1 0 110-2h6.586l-.293-.293a1 1 0 010-1.414z" clipRule="evenodd" />
    </svg>
  );
}
function ProfileIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clipRule="evenodd" />
    </svg>
  );
}

function buildPortalNav(config: BrandedAppConfig | null | undefined) {
  // Branded and default clubs share the same five slots now (Home · Book ·
  // Schedule · Messages · More). Book absorbed the old standalone Store tab
  // (Store is a category inside the Book hub) and Schedule absorbed
  // Bookings, so the per-club nav item toggles no longer change the tab
  // set — branding still drives colors, radius and the header. The config
  // may customize the Book label (e.g. "Book Now"); everything else is
  // canonical so the IA stays predictable.
  if (!config) return NAV;
  const bookLabel =
    config.navigation.items.find((i) => i.key === "book" && i.enabled)?.label || "Book";
  return NAV.map((item) => (item.label === "Book" ? { ...item, label: bookLabel } : item));
}

function BookNowIcon({ size }: { size: number }) {
  // Calendar with a plus inside — distinct from the schedule icon, signals
  // "book / add" rather than "view existing schedule".
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path fillRule="evenodd" d="M6 2a1 1 0 011 1v1h6V3a1 1 0 112 0v1h1a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2h1V3a1 1 0 011-1zm-2 6v8h12V8H4zm6 2a1 1 0 011 1v1h1a1 1 0 110 2h-1v1a1 1 0 11-2 0v-1H8a1 1 0 110-2h1v-1a1 1 0 011-1z" clipRule="evenodd" />
    </svg>
  );
}

function StoreIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor">
      <path d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a4 4 0 01-1 2.646V16a1 1 0 01-1 1H5a1 1 0 01-1-1V8.646A4 4 0 013 6V4zm3 6v5h8v-5a4.02 4.02 0 01-2-.535 4.02 4.02 0 01-4 0A4.02 4.02 0 016 10z" />
    </svg>
  );
}

function VideoIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor">
      <path d="M4 4a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-1.382l2.553 1.276A1 1 0 0018 13V7a1 1 0 00-1.447-.894L14 7.382V6a2 2 0 00-2-2H4z" />
    </svg>
  );
}
