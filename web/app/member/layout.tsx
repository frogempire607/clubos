"use client";

import { useEffect, useState } from "react";
import { useSession, signOut } from "next-auth/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import ProfileSwitcher from "@/components/member/ProfileSwitcher";
import type { BrandedAppConfig, BrandedNavKey } from "@/lib/brandedApp";

const NAV = [
  { href: "/member",           label: "Home",      icon: HomeIcon,      exact: true  },
  { href: "/member/messages",  label: "Messages",  icon: MessageIcon,   exact: false },
  { href: "/member/schedule",  label: "Schedule",  icon: BookingIcon,   exact: false },
  { href: "/member/documents", label: "Documents", icon: DocumentIcon,  exact: false },
  { href: "/member/profile",   label: "Profile",   icon: ProfileIcon,   exact: false },
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
  const pathname = usePathname();
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [club, setClub] = useState<ClubInfo | null>(null);

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

  function isActive(item: { href: string; exact: boolean }) {
    return item.exact ? pathname === item.href : pathname.startsWith(item.href);
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
  const brandedStyle: React.CSSProperties = {
    ...(club?.appFontFamily ? { fontFamily: club.appFontFamily } : {}),
    ...(club?.appTextAlign
      ? { textAlign: club.appTextAlign as "left" | "center" | "right" }
      : {}),
  };
  const portalNav = buildPortalNav(branded);

  return (
    <div className="min-h-screen bg-stone-50" style={brandedStyle}>
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
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                      active ? "" : "text-stone-500 hover:text-stone-900 hover:bg-stone-100"
                    }`}
                    style={active ? { background: headerBg, color: headerText, borderRadius: branded?.style.borderRadius } : {}}
                  >
                    <Icon size={14} />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-stone-500">{session?.user?.name}</span>
            <button
              onClick={() => signOut({ callbackUrl: "/login" })}
              className="text-xs text-stone-400 hover:text-stone-700 px-2 py-1.5 rounded-lg hover:bg-stone-100 transition"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      {/* ── Mobile top bar ── */}
      <header className="sticky top-0 z-40 md:hidden" style={{ background: headerBg, color: headerText }}>
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
            onClick={() => signOut({ callbackUrl: "/login" })}
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
      <main className="max-w-4xl mx-auto px-4 py-5 pb-24 md:pb-10">
        <ProfileSwitcher />
        {children}
      </main>

      {/* ── Mobile bottom tab bar ── */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 border-t border-stone-200 md:hidden safe-area-bottom" style={{ background: navBg }}>
        <div className="grid" style={{ height: "60px", gridTemplateColumns: `repeat(${portalNav.length}, minmax(0, 1fr))` }}>
          {portalNav.map((item) => {
            const active = isActive(item);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className="flex flex-col items-center justify-center gap-0.5 transition-colors"
                style={{ color: active ? activeNav : inactiveNav }}
              >
                <span
                  className="flex items-center justify-center rounded-xl transition-all"
                  style={active ? { background: `${activeNav}18`, padding: "5px 10px", borderRadius: branded?.style.borderRadius } : { padding: "5px 10px" }}
                >
                  <Icon size={20} />
                </span>
                <span className="text-[10px] font-medium leading-none">{item.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
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
function DocumentIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clipRule="evenodd" />
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
  if (!config) return NAV;
  const byKey: Record<BrandedNavKey, { href: string; icon: ({ size }: { size: number }) => JSX.Element; exact: boolean }> = {
    book: { href: "/member/shop", icon: HomeIcon, exact: false },
    schedule: { href: "/member/schedule", icon: BookingIcon, exact: false },
    store: { href: "/member/products", icon: StoreIcon, exact: false },
    videos: { href: "/member/shop", icon: VideoIcon, exact: false },
    more: { href: "/member/profile", icon: ProfileIcon, exact: false },
  };
  const items = config.navigation.items
    .filter((item) => item.enabled && item.key !== "videos")
    .map((item) => ({ ...byKey[item.key], label: item.label || item.key }));
  return items.length ? items : NAV;
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
