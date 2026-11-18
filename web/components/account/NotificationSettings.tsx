"use client";

// "Notifications" on My account (staff / owner) and on the member profile.
// One switch per kind of push this person can receive, from
// GET /api/me/notifications. Inside the app there is also a
// "Turn on notifications" button: pressing it is the ONLY thing that shows
// the phone's permission prompt. Nothing here prompts on load.

import { useEffect, useState } from "react";
import { isNativeApp, type PushPermission } from "@/lib/native";
import { enablePush, pushPermission } from "@/lib/pushClient";

type Kind = { type: string; title: string; description: string; enabled: boolean };

export default function NotificationSettings({ variant = "dashboard" }: { variant?: "dashboard" | "member" }) {
  const [kinds, setKinds] = useState<Kind[] | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [native, setNative] = useState(false);
  const [permission, setPermission] = useState<PushPermission>("unavailable");
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/me/notifications", { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json().catch(() => null);
        if (!alive) return;
        if (!r.ok || !Array.isArray(d?.kinds)) setError("We couldn't load your notification settings just now.");
        else setKinds(d.kinds as Kind[]);
      })
      .catch(() => { if (alive) setError("No connection. Check your signal and try again."); });
    if (isNativeApp()) {
      setNative(true);
      void pushPermission().then((p) => { if (alive) setPermission(p); });
    }
    return () => { alive = false; };
  }, []);

  async function toggle(kind: Kind) {
    if (saving) return;
    const next = !kind.enabled;
    setSaving(kind.type);
    setError("");
    setKinds((ks) => (ks ?? []).map((k) => (k.type === kind.type ? { ...k, enabled: next } : k)));
    try {
      const res = await fetch("/api/me/notifications", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: kind.type, enabled: next }),
      });
      if (!res.ok) throw new Error("not saved");
    } catch {
      // Put the switch back: what is shown must be what is stored.
      setKinds((ks) => (ks ?? []).map((k) => (k.type === kind.type ? { ...k, enabled: !next } : k)));
      setError("That change was not saved. Please try again.");
    } finally {
      setSaving(null);
    }
  }

  async function turnOn() {
    if (asking) return;
    setAsking(true);
    try {
      setPermission(await enablePush());
    } finally {
      setAsking(false);
    }
  }

  const member = variant === "member";
  const card = member ? "pcard p-5" : "bg-surface border border-app-border rounded-xl p-5";
  const heading = member ? "text-sm font-semibold text-stone-900" : "text-xs font-semibold text-text-muted uppercase tracking-wider";
  const title = member ? "text-sm font-medium text-stone-900" : "text-sm font-medium text-text-primary";
  const muted = member ? "text-xs text-stone-500" : "text-xs text-text-muted";
  const button = member
    ? "pbtn-accent px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
    : "px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50";

  const switchOn = member ? "bg-stone-900" : "bg-brand";
  const switchOff = member ? "bg-stone-300" : "bg-app-border";

  return (
    <section className={card} aria-labelledby="notification-settings-heading">
      <p id="notification-settings-heading" className={heading}>Notifications</p>
      <p className={`${muted} mt-1`}>
        Choose what the app may tell you about. A notification never shows names, amounts or dates. Open it to see the details.
      </p>

      {native && permission === "prompt" && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className={muted}>Notifications are off on this phone.</p>
          <button type="button" onClick={turnOn} disabled={asking} className={button}>
            {asking ? "Asking…" : "Turn on notifications"}
          </button>
        </div>
      )}
      {native && permission === "denied" && (
        <p className={`${muted} mt-4`}>
          Notifications are turned off for this app in your phone&apos;s Settings. Turn them on there to receive them.
        </p>
      )}
      {native && permission === "granted" && <p className={`${muted} mt-4`}>Notifications are on for this phone.</p>}
      {!native && <p className={`${muted} mt-4`}>Notifications arrive in the app on your phone. These choices apply there.</p>}

      {error && <div className="mt-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

      {kinds === null && !error && <p className={`${muted} mt-4`}>Loading…</p>}
      {kinds !== null && kinds.length === 0 && <p className={`${muted} mt-4`}>There is nothing to choose on this account.</p>}
      {kinds !== null && kinds.length > 0 && (
        <ul className="mt-4 space-y-3">
          {kinds.map((k) => (
            <li key={k.type} className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className={title}>{k.title}</p>
                <p className={muted}>{k.description}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={k.enabled}
                aria-label={k.title}
                disabled={saving === k.type}
                onClick={() => toggle(k)}
                className={`relative shrink-0 inline-flex h-7 w-12 items-center rounded-full transition-colors disabled:opacity-60 ${k.enabled ? switchOn : switchOff}`}
              >
                <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${k.enabled ? "translate-x-6" : "translate-x-1"}`} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
