"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { signOutEverywhere } from "@/lib/signOutEverywhere";

// Avatar dropdown that lives in the dashboard topbar. Replaces sidebar
// burial of My Account / Client View / Help / Sign out so mobile users
// (no sidebar at < md) still have a path to every account action.
//
// Click outside or press Escape to close. Sign out goes through
// signOutEverywhere — preserves the Phase 1 logout behavior.
export default function UserMenu({
  name,
  email,
  initials,
}: {
  name: string | null | undefined;
  email: string | null | undefined;
  initials: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-full pl-1 pr-3 py-1 hover:bg-app-bg transition"
      >
        <span className="w-8 h-8 rounded-full bg-charcoal text-white text-xs font-semibold flex items-center justify-center">
          {initials}
        </span>
        <span className="hidden sm:block text-sm text-text-primary font-medium max-w-[140px] truncate">
          {name || email || "Account"}
        </span>
        <ChevronDown className="hidden sm:block h-3 w-3 text-text-muted" strokeWidth={2} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-60 rounded-xl border border-app-border bg-surface shadow-lg overflow-hidden z-50"
        >
          <div className="px-3 py-3 border-b border-app-border">
            <div className="text-sm font-semibold text-text-primary truncate">
              {name || "Account"}
            </div>
            {email && (
              <div className="text-xs text-text-muted truncate mt-0.5">{email}</div>
            )}
          </div>
          <nav className="py-1.5">
            <Link
              href="/dashboard/my-account"
              onClick={() => setOpen(false)}
              role="menuitem"
              className="block px-3 py-2 text-sm text-text-primary hover:bg-app-bg"
            >
              My account
            </Link>
            <Link
              href="/dashboard/preview"
              onClick={() => setOpen(false)}
              role="menuitem"
              className="block px-3 py-2 text-sm text-text-primary hover:bg-app-bg"
            >
              Client view
            </Link>
            <Link
              href="/dashboard/help"
              onClick={() => setOpen(false)}
              role="menuitem"
              className="block px-3 py-2 text-sm text-text-primary hover:bg-app-bg"
            >
              Need help?
            </Link>
          </nav>
          <div className="border-t border-app-border py-1.5">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                signOutEverywhere({ callbackUrl: "/login" });
              }}
              className="block w-full text-left px-3 py-2 text-sm text-text-primary hover:bg-app-bg"
            >
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
