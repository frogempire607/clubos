// Shown in place of a Pro/Enterprise surface on a plan that doesn't include
// it. Purely presentational — the API route behind the surface is what
// actually enforces the gate (lib/tierGuard.ts).
//
// In the iOS / Android app there is no "See plans" button: the app shows what
// a plan includes and never sells one (lib/nativeUserAgent.ts).
"use client";

import Link from "next/link";
import { useIsNativeApp } from "@/lib/useIsNativeApp";

export default function UpgradeNotice({
  title,
  body,
  plan = "Pro",
}: {
  title: string;
  body: string;
  plan?: "Pro" | "Enterprise";
}) {
  const native = useIsNativeApp();
  return (
    <div className="rounded-xl border border-app-border bg-surface p-6 sm:p-8 text-center">
      <span className="inline-block text-[12px] font-medium px-2 py-0.5 rounded-full bg-brand/10 text-brand mb-3">
        Included on {plan}
      </span>
      <h3 className="text-base font-semibold text-text-primary">{title}</h3>
      <p className="text-sm text-text-muted mt-1 max-w-md mx-auto leading-relaxed">{body}</p>
      {!native && (
        <Link
          href="/dashboard/settings?section=plan"
          className="inline-flex items-center justify-center mt-4 min-h-[44px] px-4 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand-hover"
        >
          See plans
        </Link>
      )}
    </div>
  );
}
