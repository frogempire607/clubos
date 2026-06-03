"use client";

import { signOut } from "next-auth/react";

// Robust sign-out for both browser and Capacitor iOS WKWebView.
//
// Why a wrapper instead of calling signOut({ callbackUrl: "/login" }) directly:
//
//   1. NextAuth's built-in redirect after signOut uses next/router-style
//      client navigation. Inside WKWebView that sometimes leaves the React
//      tree on the dashboard with a stale SessionProvider (same class of
//      bug we already fixed on the login side). A hard window.location
//      navigation always wins.
//
//   2. The member portal keeps an "active athlete profile" id in
//      localStorage (lib/activeProfile). If we sign out without clearing
//      it, the next person to log in on the same device inherits the
//      previous user's child-switcher selection.
//
//   3. /api/preview owns an HttpOnly "Client view" cookie that survives
//      a NextAuth signOut because it's not part of the session. Owners
//      who used preview mode would log out and the cookie would still
//      route them weirdly on next login. Clear it explicitly.
export async function signOutEverywhere(options?: { callbackUrl?: string }) {
  const target = options?.callbackUrl ?? "/login";

  // Clear local app state that isn't owned by NextAuth. Wrapped in
  // try/catches because WKWebView can throw on storage access in some
  // configurations and we never want sign-out to fail because of UI
  // bookkeeping.
  try {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem("athletixos-active-profile");
    }
  } catch {
    /* storage unavailable */
  }

  try {
    // Client View / preview-mode cookie is HttpOnly; only the server
    // route can delete it.
    await fetch("/api/preview", { method: "DELETE", cache: "no-store" });
  } catch {
    /* preview cookie cleanup is best-effort */
  }

  // Tear down the NextAuth session WITHOUT letting next-auth/react do
  // the navigation. redirect:false leaves us in control so we can do a
  // hard nav that works identically in browsers and WKWebView.
  try {
    await signOut({ redirect: false });
  } catch {
    /* even if the signOut request fails, still send the user to /login
       so they're not stuck on an authenticated page with broken state */
  }

  if (typeof window !== "undefined") {
    window.location.href = target;
  }
}
