"use client";

import { useEffect, useState } from "react";
import { useSession, signOut } from "next-auth/react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/member", label: "Home", icon: "⌂", exact: true },
  { href: "/member/messages", label: "Messages", icon: "✉", exact: false },
  { href: "/member/bookings", label: "Bookings", icon: "◷", exact: false },
  { href: "/member/documents", label: "Documents", icon: "▤", exact: false },
  { href: "/member/profile", label: "Profile", icon: "◎", exact: false },
];

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export default function MemberLayout({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const pathname = usePathname();
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [clubColor, setClubColor] = useState<string | null>(null);

  // Register service worker
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  // Capture install prompt
  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handler);

    // Already installed
    if (window.matchMedia("(display-mode: standalone)").matches) {
      setInstalled(true);
    }

    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  // Load club color and update theme-color meta dynamically
  useEffect(() => {
    fetch("/api/club/info")
      .then((r) => (r.ok ? r.json() : null))
      .then((club) => {
        if (club?.primaryColor) {
          setClubColor(club.primaryColor);
          const meta = document.querySelector('meta[name="theme-color"]');
          if (meta) meta.setAttribute("content", club.primaryColor);
        }
      })
      .catch(() => {});
  }, []);

  async function handleInstall() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === "accepted") {
      setInstalled(true);
      setInstallPrompt(null);
    }
  }

  function isActive(item: { href: string; exact: boolean }) {
    if (item.exact) return pathname === item.href;
    return pathname.startsWith(item.href);
  }

  const accentColor = clubColor || "#1C1917";

  return (
    <div className="min-h-screen bg-stone-50">
      {/* ── Top bar (desktop) ── */}
      <header className="bg-white border-b border-stone-200 sticky top-0 z-40 hidden md:block">
        <div className="max-w-4xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/member" className="flex items-center gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/icon.png" alt="" className="w-7 h-7 rounded-md" />
              <span className="text-sm font-bold text-stone-900">AthletixOS</span>
            </Link>
            <nav className="flex gap-1">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`px-3 py-1.5 rounded-md text-sm transition ${
                    isActive(item)
                      ? "text-white font-medium"
                      : "text-stone-600 hover:bg-stone-100"
                  }`}
                  style={isActive(item) ? { background: accentColor } : {}}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-stone-600">{session?.user?.name}</span>
            <button
              onClick={() => signOut({ callbackUrl: "/login" })}
              className="text-xs text-stone-400 hover:text-stone-700 px-2 py-1 rounded hover:bg-stone-100"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      {/* ── Mobile top bar ── */}
      <header className="bg-white border-b border-stone-200 sticky top-0 z-40 md:hidden">
        <div className="px-4 h-12 flex items-center justify-between">
          <Link href="/member" className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/icon.png" alt="" className="w-6 h-6 rounded-md" />
            <span className="text-sm font-bold text-stone-900">AthletixOS</span>
          </Link>
          <span className="text-sm text-stone-500">{session?.user?.name?.split(" ")[0]}</span>
        </div>
      </header>

      {/* ── Install banner ── */}
      {installPrompt && !installed && (
        <div className="bg-stone-900 text-white px-4 py-2.5 flex items-center justify-between md:hidden">
          <div>
            <p className="text-sm font-medium">Add to Home Screen</p>
            <p className="text-xs text-stone-400">Get the full app experience</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setInstallPrompt(null)}
              className="text-xs text-stone-400 px-2 py-1"
            >
              Not now
            </button>
            <button
              onClick={handleInstall}
              className="text-xs px-3 py-1.5 rounded-lg font-medium text-stone-900"
              style={{ background: "white" }}
            >
              Install
            </button>
          </div>
        </div>
      )}

      {/* ── Page content ── */}
      <main className="max-w-4xl mx-auto px-4 py-6 pb-24 md:pb-8">
        {children}
      </main>

      {/* ── Bottom tab bar (mobile only) ── */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 bg-white border-t border-stone-200 md:hidden">
        <div className="grid grid-cols-5 h-16">
          {NAV.map((item) => {
            const active = isActive(item);
            return (
              <Link
                key={item.href}
                href={item.href}
                className="flex flex-col items-center justify-center gap-0.5 transition"
                style={active ? { color: accentColor } : { color: "#78716C" }}
              >
                <span className="text-xl leading-none">{item.icon}</span>
                <span className="text-[10px] font-medium">{item.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
