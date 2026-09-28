"use client";

// Check-in: one menu destination for the two check-in screens.
//   phones (<768px)  → /dashboard/front-desk  (Door: tap people in at the door)
//   larger screens   → /dashboard/attendance  (Roster: take attendance by session)
// Both pages carry a Door / Roster switch (components/CheckInModeSwitch.tsx),
// so the pick here is only a sensible default, never a dead end.
//
// router.replace so Back skips this hop. Gated like its two targets
// (attendance: edit) in lib/permissions.ts PATH_PERMISSIONS.
import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function CheckInPage() {
  const router = useRouter();

  useEffect(() => {
    let phone = false;
    try {
      phone = window.matchMedia("(max-width: 767px)").matches;
    } catch {
      phone = window.innerWidth < 768;
    }
    router.replace(phone ? "/dashboard/front-desk" : "/dashboard/attendance");
  }, [router]);

  // Shown for a moment while the redirect runs (or if scripts are slow).
  return (
    <div className="mx-auto max-w-[480px] p-6 text-center">
      <p className="text-[14px] text-text-muted">Opening check-in…</p>
      <div className="mt-4 flex justify-center gap-2">
        <Link
          href="/dashboard/front-desk"
          className="inline-flex min-h-[44px] items-center rounded-lg border border-app-border px-4 text-[13px] font-medium text-text-primary hover:bg-app-bg md:min-h-[36px]"
        >
          Door
        </Link>
        <Link
          href="/dashboard/attendance"
          className="inline-flex min-h-[44px] items-center rounded-lg border border-app-border px-4 text-[13px] font-medium text-text-primary hover:bg-app-bg md:min-h-[36px]"
        >
          Roster
        </Link>
      </div>
    </div>
  );
}
