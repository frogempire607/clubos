"use client";

import { useEffect } from "react";

// Inside the native app (Capacitor), a Universal Link / App Link — the door QR
// (/c/...), a Stripe return (/member/checkin/...?paid=1), a portal email link —
// launches or foregrounds the app and fires `appUrlOpen`. The WebView does NOT
// navigate by itself, so route it here. Outside the app this renders nothing
// and does nothing.
//
// Uses the bridge the shell injects (window.Capacitor.Plugins.App) instead of
// importing @capacitor/app, so the website bundle doesn't carry native code.

type AppPlugin = { addListener: (ev: string, cb: (e: { url?: string }) => void) => Promise<{ remove: () => void }> | { remove: () => void } };
type CapWindow = Window & { Capacitor?: { isNativePlatform?: () => boolean; Plugins?: { App?: AppPlugin } } };

const OUR_HOSTS = /(^|\.)athletix-os\.com$/i;

export function pathForAppUrl(raw: string, currentHost: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!OUR_HOSTS.test(u.hostname) && u.host !== currentHost) return null;
    return `${u.pathname}${u.search}${u.hash}` || "/";
  } catch {
    return null;
  }
}

export default function NativeDeepLinks() {
  useEffect(() => {
    const w = window as CapWindow;
    if (!w.Capacitor?.isNativePlatform?.()) return;
    const App = w.Capacitor.Plugins?.App;
    if (!App?.addListener) return;
    let handle: { remove: () => void } | null = null;
    Promise.resolve(
      App.addListener("appUrlOpen", (e) => {
        const path = e?.url ? pathForAppUrl(e.url, window.location.host) : null;
        if (path && path !== `${window.location.pathname}${window.location.search}`) window.location.href = path;
      }),
    ).then((h) => { handle = h; }).catch(() => {});
    return () => { handle?.remove(); };
  }, []);
  return null;
}
