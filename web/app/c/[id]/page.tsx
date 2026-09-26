"use client";

import { useEffect, useState } from "react";

type Data = {
  kind: "class" | "event";
  title: string;
  dateLabel: string;
  timeLabel: string;
  club: { name: string; slug: string; logoUrl: string | null; primaryColor: string | null };
};

const IOS_URL = process.env.NEXT_PUBLIC_IOS_APP_URL || null;
const ANDROID_URL = process.env.NEXT_PUBLIC_ANDROID_APP_URL || null;

export default function CheckinPage({ params }: { params: { id: string } }) {
  const [d, setD] = useState<Data | null>(null);
  const [notFound, setNotFound] = useState(false);

  // Already signed in as a member (the website, or the app via Universal
  // Link)? Skip the sign-up screen and go straight to check-in.
  const [platform, setPlatform] = useState<"ios" | "android" | "other">("other");
  const [inApp, setInApp] = useState(false);
  useEffect(() => {
    const ua = navigator.userAgent || "";
    setPlatform(/iPhone|iPad|iPod/i.test(ua) ? "ios" : /Android/i.test(ua) ? "android" : "other");
    setInApp(!!(window as Window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.());
    fetch("/api/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((me) => {
        if (me?.role === "MEMBER") window.location.replace(`/member/checkin/${encodeURIComponent(params.id)}`);
      })
      .catch(() => {});
  }, [params.id]);

  useEffect(() => {
    fetch(`/api/checkin/${params.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j || j.error) setNotFound(true);
        else setD(j);
      })
      .catch(() => setNotFound(true));
  }, [params.id]);

  if (notFound) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-50 px-4">
        <p className="text-stone-500 text-sm">This check-in link is no longer available.</p>
      </div>
    );
  }

  if (!d) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-50 text-sm text-stone-400">
        Loading…
      </div>
    );
  }

  const accent = d.club.primaryColor || "#1C1917";
  const clubQ = encodeURIComponent(d.club.slug);
  // Carry the scanned class/event through signup and login so the member is
  // checked in automatically at /member/checkin/[id] afterwards — instead of
  // landing on the portal home with the class lost.
  const checkinNext = encodeURIComponent(`/member/checkin/${params.id}`);
  const signUpUrl = `/member/signup?club=${clubQ}&checkin=${encodeURIComponent(params.id)}`;
  const signInUrl = `/login?club=${clubQ}&role=member&next=${checkinNext}`;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-stone-50 px-4 py-10 print:bg-white">
      <div className="w-full max-w-sm bg-white rounded-2xl border border-stone-200 shadow-sm overflow-hidden print:shadow-none print:border-stone-300">
        <div className="px-8 pt-10 pb-8 flex flex-col items-center text-center">
          {/* Club logo */}
          {d.club.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={d.club.logoUrl}
              alt={d.club.name}
              className="w-24 h-24 rounded-2xl object-cover mb-5"
            />
          ) : (
            <div
              className="w-24 h-24 rounded-2xl mb-5 flex items-center justify-center text-white text-3xl font-bold"
              style={{ background: accent }}
            >
              {d.club.name.slice(0, 1).toUpperCase()}
            </div>
          )}

          <p className="text-xs uppercase tracking-widest text-stone-400 font-medium mb-1">
            {d.club.name}
          </p>

          {/* Date */}
          <p className="text-sm font-medium text-stone-500 mb-1">
            {d.dateLabel} · {d.timeLabel}
          </p>

          {/* Class / event name */}
          <h1 className="text-2xl font-bold text-stone-900 mb-7 leading-tight">
            {d.title}
          </h1>

          {/* Sign up (primary) + Sign in */}
          <a
            href={signUpUrl}
            className="w-full py-3.5 rounded-xl text-white text-base font-semibold text-center"
            style={{ background: accent }}
          >
            Create an account
          </a>
          <a
            href={signInUrl}
            className="w-full py-3 mt-2 rounded-xl border border-stone-300 text-stone-700 text-base font-semibold text-center"
          >
            I already have an account
          </a>
          <p className="text-xs text-stone-400 mt-3">
            Joining {d.club.name} for the first time? Tap “Create an account”.
          </p>

          {/* Get the app — hidden inside the app itself and until the store
              listings exist (NEXT_PUBLIC_IOS_APP_URL / NEXT_PUBLIC_ANDROID_APP_URL). */}
          {!inApp && (IOS_URL || ANDROID_URL) && (
            <div className="w-full mt-6 pt-5 border-t border-stone-100 print:hidden">
              <p className="text-xs text-stone-500 mb-2">Check in faster next time with the app</p>
              <div className="flex gap-2 justify-center">
                {IOS_URL && platform !== "android" && (
                  <a href={IOS_URL} className="flex-1 min-h-[44px] inline-flex items-center justify-center rounded-xl bg-black text-white text-xs font-semibold px-3">
                    Download on the App Store
                  </a>
                )}
                {ANDROID_URL && platform !== "ios" && (
                  <a href={ANDROID_URL} className="flex-1 min-h-[44px] inline-flex items-center justify-center rounded-xl bg-black text-white text-xs font-semibold px-3">
                    Get it on Google Play
                  </a>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <button
        onClick={() => window.print()}
        className="mt-6 text-xs text-stone-400 hover:text-stone-700 print:hidden"
      >
        Print this page
      </button>
    </div>
  );
}
