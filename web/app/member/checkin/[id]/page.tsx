"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CheckCircle2, AlertTriangle, Users } from "lucide-react";
import { kindIsWallClockUTC } from "@/lib/datetime";

// Lands here after the attendance-QR flow (/c/[id] → signup or login). Keeps
// the scanned class/event intent: single-profile accounts are checked in
// automatically; guardians pick which athlete is at the door. Retries are
// safe — the API is idempotent and reports "already checked in".

type Profile = {
  id: string;
  firstName: string;
  lastName: string;
  kind: "self" | "child";
  alreadyCheckedIn: boolean;
};
type Info = {
  target: { kind: "class" | "event"; title: string; startsAt: string; endsAt: string; ended: boolean };
  profiles: Profile[];
  defaultMemberId: string | null;
};

export default function MemberCheckinPage({ params }: { params: { id: string } }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [done, setDone] = useState<{ message: string; already: boolean } | null>(null);
  const autoRan = useRef(false);

  async function checkIn(memberId: string) {
    setBusyId(memberId);
    setError("");
    const res = await fetch(`/api/member/checkin/${encodeURIComponent(params.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId }),
    });
    const d = await res.json().catch(() => ({}));
    setBusyId(null);
    if (!res.ok) {
      setError(typeof d.error === "string" ? d.error : "Could not check you in. Please try again.");
      return;
    }
    setDone({ message: d.message || "You're checked in!", already: !!d.already });
  }

  useEffect(() => {
    fetch(`/api/member/checkin/${encodeURIComponent(params.id)}`, { cache: "no-store" })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) {
          setError(typeof d.error === "string" ? d.error : "This check-in link is no longer available.");
          return;
        }
        setInfo(d);
        // One eligible profile → complete the scanned intent automatically.
        if (!autoRan.current && Array.isArray(d.profiles) && d.profiles.length === 1 && !d.target.ended) {
          autoRan.current = true;
          checkIn(d.profiles[0].id);
        }
      })
      .catch(() => setError("Could not reach the server. Check your connection and try again."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  // Classes store wall-clock pinned to UTC; events are true instants. Render in
  // the matching frame so the check-in time matches the schedule.
  const whenUtc = info ? kindIsWallClockUTC(info.target.kind) : false;
  const when = info
    ? `${new Date(info.target.startsAt).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", ...(whenUtc ? { timeZone: "UTC" } : {}) })} · ${new Date(info.target.startsAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", ...(whenUtc ? { timeZone: "UTC" } : {}) })}`
    : "";

  return (
    <div className="max-w-md mx-auto">
      <div className="bg-white rounded-2xl border border-stone-200 p-6 text-center">
        {info && (
          <>
            <p className="text-xs uppercase tracking-widest text-stone-400 font-medium mb-1">Class check-in</p>
            <h1 className="text-xl font-bold text-stone-900">{info.target.title}</h1>
            <p className="text-sm text-stone-500 mb-5">{when}</p>
          </>
        )}

        {done ? (
          <div>
            <div className="mx-auto mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full bg-lime-accent/20 text-charcoal">
              <CheckCircle2 className="h-7 w-7" strokeWidth={2} />
            </div>
            <p className="text-base font-semibold text-stone-900 mb-1">
              {done.already ? "Already checked in" : "You're checked in!"}
            </p>
            <p className="text-sm text-stone-600 mb-5">{done.message}</p>
            <div className="flex gap-2">
              <Link
                href="/member"
                className="flex-1 px-4 py-2.5 rounded-xl bg-stone-900 text-white text-sm font-semibold"
              >
                Go to my portal
              </Link>
              <Link
                href="/member/schedule"
                className="flex-1 px-4 py-2.5 rounded-xl border border-stone-300 text-stone-700 text-sm font-semibold"
              >
                See the schedule
              </Link>
            </div>
          </div>
        ) : error ? (
          <div>
            <div className="mx-auto mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full bg-red-50 text-red-600">
              <AlertTriangle className="h-7 w-7" strokeWidth={2} />
            </div>
            <p className="text-sm text-red-700 mb-4">{error}</p>
            <Link href="/member" className="inline-block px-4 py-2.5 rounded-xl bg-stone-900 text-white text-sm font-semibold">
              Go to my portal
            </Link>
          </div>
        ) : !info ? (
          <p className="text-sm text-stone-400 py-6">Checking you in…</p>
        ) : info.profiles.length === 0 ? (
          <p className="text-sm text-stone-500 py-4">
            Your account isn&apos;t linked to an athlete profile yet — ask your club to add you.
          </p>
        ) : info.profiles.length === 1 ? (
          <p className="text-sm text-stone-400 py-6">Checking {info.profiles[0].firstName} in…</p>
        ) : (
          <div>
            <p className="inline-flex items-center gap-1.5 text-sm font-medium text-stone-700 mb-3">
              <Users className="h-4 w-4" strokeWidth={2} /> Who&apos;s checking in?
            </p>
            <div className="space-y-2">
              {info.profiles.map((p) => (
                <button
                  key={p.id}
                  disabled={!!busyId || p.alreadyCheckedIn}
                  onClick={() => checkIn(p.id)}
                  className="w-full flex items-center justify-between px-4 py-3 rounded-xl border border-stone-200 text-left hover:border-stone-400 disabled:opacity-60"
                >
                  <span className="text-sm font-medium text-stone-900">
                    {p.firstName} {p.lastName}
                    {p.kind === "self" && <span className="ml-1.5 text-[11px] text-stone-400">you</span>}
                  </span>
                  <span className="text-xs text-stone-500">
                    {busyId === p.id ? "Checking in…" : p.alreadyCheckedIn ? "Checked in ✓" : "Check in"}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
