"use client";

// "Scan to check in" — the door code, read with the phone's camera.
//
// Only in the iOS / Android app: the scanner is a native screen compiled into
// the app (Capacitor's official barcode scanner). In a browser this renders
// nothing, and the phone's own camera app still opens the same door code as a
// link. The camera is asked for by the system the first time, with the reason
// written in the app's permission text; saying no just leaves the button
// doing nothing — every other part of the app works without it.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { haptic, isNativeApp, scanQrCode } from "@/lib/native";
import { checkInPathFromScan, scanProblemMessage } from "@/lib/nativeLinks";

export default function ScanCheckInCard() {
  const router = useRouter();
  const [native, setNative] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  // Decided after mount so the server-rendered page and the first client
  // render agree (the app is only detectable in the browser).
  useEffect(() => { setNative(isNativeApp()); }, []);
  if (!native) return null;

  async function scan() {
    if (busy) return;
    setBusy(true);
    setProblem("");
    haptic("tap");
    try {
      const text = await scanQrCode("Point the camera at the check-in code by the door");
      if (text === null) return; // cancelled, or the camera was not allowed
      const outcome = checkInPathFromScan(text, window.location.host);
      if (!outcome.ok) {
        haptic("warning");
        setProblem(scanProblemMessage(outcome.reason));
        return;
      }
      router.push(outcome.path);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-4">
      <button
        type="button"
        onClick={scan}
        disabled={busy}
        className="pbtn-accent flex min-h-[52px] w-full items-center justify-center gap-2 rounded-xl px-4 text-[15px] font-semibold disabled:opacity-60"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10" />
        </svg>
        {busy ? "Opening camera…" : "Scan to check in"}
      </button>
      {problem && <p role="alert" className="mt-2 text-[13px] text-stone-700">{problem}</p>}
    </div>
  );
}
