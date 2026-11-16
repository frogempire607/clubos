"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { isNativeApp, nativeListen } from "@/lib/native";
import { pathForAppUrl } from "@/lib/nativeLinks";

// Inside the native app, a Universal Link / App Link — the door QR (/c/...),
// a Stripe return (/member/checkin/...?paid=1), a portal email link — launches
// or foregrounds the app and fires `appUrlOpen`. The web view does NOT
// navigate by itself, so route it here. Outside the app this renders nothing
// and does nothing.
//
// The listener is attached through lib/native.ts. It used to read
// `window.Capacitor.Plugins.App`, which nothing on this site ever creates, so
// it never attached at all — see the note at the top of lib/native.ts.

export { pathForAppUrl };

export default function NativeDeepLinks() {
  const router = useRouter();
  useEffect(() => {
    if (!isNativeApp()) return;
    return nativeListen<{ url?: string }>("App", "appUrlOpen", (e) => {
      const path = e?.url ? pathForAppUrl(e.url, window.location.host) : null;
      // In-app navigation, not a page load: assigning window.location here
      // restarted the whole app (blank screen, every script re-downloaded)
      // each time a door QR, an emailed link or a Stripe return opened it.
      if (path && path !== `${window.location.pathname}${window.location.search}`) router.push(path);
    });
  }, [router]);
  return null;
}
