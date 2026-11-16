"use client";

import { useEffect, useState } from "react";
import { isNativeApp } from "@/lib/native";

/**
 * True inside the iOS / Android app. False on the server and on the first
 * client render (so both render the same thing), then corrected after mount.
 */
export function useIsNativeApp(): boolean {
  const [native, setNative] = useState(false);
  useEffect(() => { setNative(isNativeApp()); }, []);
  return native;
}
