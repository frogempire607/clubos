"use client";

// Universal back button used across the dashboard and member portal.
//
// Behavior:
//   - If browser history has a previous in-app page (history.length > 1),
//     go back to it via router.back(). That matches the user's intent of
//     "wherever they came from."
//   - Otherwise fall back to a sensible home: /dashboard for owner/staff,
//     /member for members, or whatever `fallbackHref` the caller passed.
//
// Usage:
//   <BackButton fallbackHref="/dashboard" />
//   <BackButton fallbackHref="/member" label="All bookings" />
//
// Styling is intentionally lightweight (text + chevron) so it slots into
// page headers without dictating a layout.

import { useRouter, usePathname } from "next/navigation";
import { useEffect, useState } from "react";

export default function BackButton({
  fallbackHref,
  label,
  className = "",
}: {
  // Where to send the user when there's no in-app history to pop back to.
  // Pass "/dashboard" for owner/staff pages, "/member" for member pages.
  fallbackHref?: string;
  // Optional label override. Defaults to "Back".
  label?: string;
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [canPop, setCanPop] = useState(false);

  // history.length is unreliable across SSR/CSR transitions; check on mount.
  useEffect(() => {
    if (typeof window !== "undefined") {
      setCanPop(window.history.length > 1 && document.referrer !== "");
    }
  }, []);

  // Pick a fallback if caller didn't supply one. Dashboard pages → /dashboard;
  // member portal → /member. Any other path defaults to the dashboard.
  const resolvedFallback =
    fallbackHref ||
    (pathname?.startsWith("/member") ? "/member" : "/dashboard");

  function handleClick(e: React.MouseEvent) {
    e.preventDefault();
    // Don't go back if it would just bounce to the same page (e.g. user
    // refreshed and the only history entry IS this page). router.back()
    // is a no-op in that case anyway; we just try and let the browser
    // handle it.
    if (canPop) {
      router.back();
    } else {
      router.push(resolvedFallback);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-primary transition ${className}`}
    >
      <span aria-hidden>←</span>
      <span>{label || "Back"}</span>
    </button>
  );
}
