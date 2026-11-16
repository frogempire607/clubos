"use client";

// What the website does differently when it is running inside the iOS or
// Android app. Mounted once, in the root layout. In a browser it renders
// nothing and attaches nothing.
//
//   - hides the launch screen once the first real screen has drawn
//   - matches the status bar to the page behind it
//   - Android back button: close whatever is open, else go back, else leave
//   - tells the person, quietly, when the phone has no connection
//
// The native side of each of these is compiled into the app (Capacitor's
// official SplashScreen, StatusBar, App and Network plugins); this is only
// the part that decides when to call them.

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { hideSplash, isNativeApp, minimizeApp, nativeCall, nativeListen, setStatusBar } from "@/lib/native";
import { backAction } from "@/lib/nativeBack";

export default function NativeShell() {
  const pathname = usePathname();
  const [offline, setOffline] = useState(false);

  // Launch screen: gone as soon as there is something of ours to look at.
  useEffect(() => {
    if (!isNativeApp()) return;
    document.documentElement.classList.add("native-app");
    const t = requestAnimationFrame(() => hideSplash());
    return () => cancelAnimationFrame(t);
  }, []);

  // Status bar: the dashboard and the sign-in screens sit on charcoal; the
  // member portal has a light page under a club-coloured header.
  useEffect(() => {
    if (!isNativeApp()) return;
    const light = pathname.startsWith("/member") && !pathname.startsWith("/member/signup");
    setStatusBar({ dark: !light, color: light ? "#FFFFFF" : "#1F1F23" });
  }, [pathname]);

  // Android hardware / gesture back.
  useEffect(() => {
    if (!isNativeApp()) return;
    return nativeListen("App", "backButton", () => {
      const action = backAction({
        hasOpenDialog: !!document.querySelector('[role="dialog"][aria-modal="true"], [data-sheet-open="true"]'),
        pathname: window.location.pathname,
        historyLength: window.history.length,
      });
      if (action === "CLOSE_DIALOG") {
        // Every sheet and modal in the app already closes on Escape.
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      } else if (action === "GO_BACK") {
        window.history.back();
      } else {
        minimizeApp();
      }
    });
  }, []);

  // Connection state. `Network.getStatus` for the first answer, then changes.
  useEffect(() => {
    if (!isNativeApp()) return;
    let alive = true;
    void nativeCall<{ connected?: boolean }>("Network", "getStatus").then((s) => {
      if (alive && s && s.connected === false) setOffline(true);
    });
    const stop = nativeListen<{ connected?: boolean }>("Network", "networkStatusChange", (s) => setOffline(s?.connected === false));
    return () => { alive = false; stop(); };
  }, []);

  if (!offline) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 top-0 z-[80] px-4 pb-2 text-center text-[13px] font-medium text-white"
      style={{ background: "#1F1F23", paddingTop: "calc(env(safe-area-inset-top) + 8px)" }}
    >
      No connection. You are seeing what was already loaded — changes will not save until you are back online.
    </div>
  );
}
