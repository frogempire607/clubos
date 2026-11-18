"use client";

// Push notifications inside the iOS / Android app. Renders nothing; in a
// browser it attaches nothing.
//
//   - a tapped notification opens the screen it is about (a path on this
//     site only)
//   - on signed-in screens, if the person has ALREADY allowed notifications,
//     this phone's token is sent to the server under their account
//
// It never shows the permission prompt. That happens only when the person
// presses "Turn on notifications" (components/account/NotificationSettings).
//
// Mount once, next to <NativeShell /> in the root layout.

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { isNativeApp } from "@/lib/native";
import { listenForPush, startPush } from "@/lib/pushClient";

/** Screens only a signed-in person reaches. */
function signedInArea(pathname: string): boolean {
  if (pathname.startsWith("/member/signup")) return false;
  return pathname.startsWith("/dashboard") || pathname.startsWith("/member");
}

export default function PushRegistration() {
  const pathname = usePathname() ?? "";

  useEffect(() => {
    if (!isNativeApp()) return;
    listenForPush();
  }, []);

  const inside = signedInArea(pathname);
  useEffect(() => {
    if (!inside || !isNativeApp()) return;
    void startPush();
  }, [inside]);

  return null;
}
