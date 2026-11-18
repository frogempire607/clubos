"use client";

import { useEffect, useState } from "react";
import { fetchSocialProviders, startSocial } from "@/lib/socialClient";
import type { SocialProvider } from "@/lib/socialAuth";

// "Continue with Google" / "Continue with Apple". Drawn only for providers
// whose keys are set on the server. Both buttons are the same size, in the
// same place, with the same weight (App Review 4.8: Sign in with Apple is
// offered as an equal option wherever another provider is).

export function GoogleMark() {
  return (
    <svg aria-hidden viewBox="0 0 48 48" className="w-[18px] h-[18px]">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

export function AppleMark() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="w-[18px] h-[18px]" fill="currentColor">
      <path d="M16.37 12.6c-.02-2.2 1.8-3.26 1.88-3.31-1.02-1.5-2.62-1.7-3.19-1.72-1.36-.14-2.65.8-3.34.8-.69 0-1.75-.78-2.88-.76-1.48.02-2.85.86-3.61 2.19-1.54 2.67-.39 6.62 1.11 8.79.73 1.06 1.6 2.25 2.75 2.2 1.1-.04 1.52-.71 2.85-.71 1.33 0 1.71.71 2.88.69 1.19-.02 1.94-1.08 2.66-2.14.84-1.23 1.19-2.42 1.21-2.48-.03-.01-2.32-.89-2.34-3.55zM14.19 6.13c.61-.74 1.02-1.76.91-2.78-.88.04-1.94.59-2.57 1.32-.56.65-1.06 1.69-.93 2.69.98.08 1.98-.5 2.59-1.23z" />
    </svg>
  );
}

const BTN = "w-full min-h-11 flex items-center justify-center gap-2.5 rounded-lg text-sm font-medium px-4 py-2.5 disabled:opacity-60";

export function socialButtonClass(p: SocialProvider): string {
  return p === "apple"
    ? `${BTN} bg-black text-white hover:bg-neutral-800`
    : `${BTN} bg-white text-[#1F1F1F] border border-[#747775] hover:bg-neutral-50`;
}

export default function SocialButtons({
  club,
  next,
  onError,
}: {
  /** The club code typed above. Required to start: one email can have an account at more than one club. */
  club: string;
  next?: string | null;
  onError: (message: string) => void;
}) {
  const [providers, setProviders] = useState<SocialProvider[]>([]);
  const [busy, setBusy] = useState<SocialProvider | null>(null);

  useEffect(() => {
    let live = true;
    fetchSocialProviders().then((p) => live && setProviders(p));
    return () => { live = false; };
  }, []);

  if (providers.length === 0) return null;

  async function go(p: SocialProvider) {
    if (!club.trim()) {
      onError("Enter your club code first, then choose Google or Apple.");
      return;
    }
    onError("");
    setBusy(p);
    const r = await startSocial({
      provider: p,
      club: club.trim().toLowerCase(),
      mode: "signin",
      next,
      onDone: (res) => {
        setBusy(null);
        if (res.error) onError(res.error);
      },
    });
    if (!r.ok) {
      setBusy(null);
      onError(r.error);
    }
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-3 text-xs text-text-muted" aria-hidden>
        <span className="flex-1 h-px bg-app-border" />or<span className="flex-1 h-px bg-app-border" />
      </div>
      {providers.map((p) => (
        <button key={p} type="button" className={socialButtonClass(p)} disabled={busy !== null} onClick={() => go(p)}>
          {p === "apple" ? <AppleMark /> : <GoogleMark />}
          {busy === p ? "Opening…" : p === "apple" ? "Continue with Apple" : "Continue with Google"}
        </button>
      ))}
    </div>
  );
}
