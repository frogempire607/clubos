// The website's side of the native app: one small, dependency-free bridge.
//
// Inside the iOS / Android app, Capacitor injects `window.Capacitor` into our
// pages with three primitives that need no JavaScript library on our side:
//
//     Capacitor.isNativePlatform()
//     Capacitor.nativePromise(pluginName, methodName, options)
//     Capacitor.addListener(pluginName, eventName, callback)
//
// Everything here is built on those, so the website bundle carries no native
// code and a browser visitor pays nothing for the app.
//
// WHY NOT `window.Capacitor.Plugins.App`: that object is only filled in by
// @capacitor/core's `registerPlugin`, which this site never loads. The first
// version of the deep-link handler read it, found nothing, and silently did
// nothing — links opened from outside the app never navigated. (Found
// 2026-11-15 by reading the bridge the app actually ships:
// node_modules/@capacitor/ios/Capacitor/Capacitor/assets/native-bridge.js.)
//
// Every function is safe to call in a browser: it resolves to a "not
// available" value instead of throwing.

type Listener = { remove: () => void | Promise<void> };
type Bridge = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  nativePromise?: (plugin: string, method: string, options?: unknown) => Promise<unknown>;
  addListener?: (plugin: string, event: string, cb: (data: unknown) => void) => Listener;
};

function bridge(): Bridge | null {
  if (typeof window === "undefined") return null;
  const cap = (window as unknown as { Capacitor?: Bridge }).Capacitor;
  return cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform() ? cap : null;
}

/** True only inside the iOS / Android app. */
export function isNativeApp(): boolean {
  return bridge() !== null;
}

export function nativePlatform(): "ios" | "android" | null {
  const p = bridge()?.getPlatform?.();
  return p === "ios" || p === "android" ? p : null;
}

/** Call a native plugin method. Resolves `null` in a browser or on any failure. */
export async function nativeCall<T = unknown>(plugin: string, method: string, options?: unknown): Promise<T | null> {
  const cap = bridge();
  if (!cap?.nativePromise) return null;
  try {
    return (await cap.nativePromise(plugin, method, options ?? {})) as T;
  } catch {
    return null;
  }
}

/** Listen for a native event. Returns an unsubscribe function (a no-op in a browser). */
export function nativeListen<T = unknown>(plugin: string, event: string, cb: (data: T) => void): () => void {
  const cap = bridge();
  if (!cap?.addListener) return () => undefined;
  try {
    const handle = cap.addListener(plugin, event, (d) => cb(d as T));
    return () => { try { void handle.remove(); } catch { /* already gone */ } };
  } catch {
    return () => undefined;
  }
}

// ── Haptics ────────────────────────────────────────────────────────────────

export type HapticKind = "tap" | "success" | "warning" | "error";

/** A touch you can feel. Silent in a browser and when the phone has it off. */
export function haptic(kind: HapticKind = "tap"): void {
  if (!isNativeApp()) return;
  if (kind === "tap") void nativeCall("Haptics", "impact", { style: "LIGHT" });
  else void nativeCall("Haptics", "notification", { type: kind.toUpperCase() });
}

// ── Launch screen and status bar ───────────────────────────────────────────

export function hideSplash(): void {
  void nativeCall("SplashScreen", "hide", { fadeOutDuration: 200 });
}

/** `dark` = dark background behind the status bar, so light icons. */
export function setStatusBar(input: { dark: boolean; color?: string }): void {
  if (!isNativeApp()) return;
  void nativeCall("StatusBar", "setStyle", { style: input.dark ? "DARK" : "LIGHT" });
  if (input.color && nativePlatform() === "android") void nativeCall("StatusBar", "setBackgroundColor", { color: input.color });
}

// ── Sharing ────────────────────────────────────────────────────────────────

/**
 * The system share sheet in the app, the Web Share sheet in a browser that
 * has one. Resolves false when neither exists (the caller falls back to
 * copying the link).
 */
export async function shareLink(input: { title: string; text?: string; url: string }): Promise<boolean> {
  if (isNativeApp()) {
    const r = await nativeCall("Share", "share", { title: input.title, text: input.text, url: input.url, dialogTitle: input.title });
    return r !== null;
  }
  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try { await navigator.share(input); return true; } catch { return false; }
  }
  return false;
}

// ── Small native key/value store (survives being offline) ──────────────────

export async function nativeStoreSet(key: string, value: string): Promise<void> {
  await nativeCall("Preferences", "set", { key, value });
}

// ── Camera scanner ─────────────────────────────────────────────────────────

/** QR_CODE in the plugin's format list (@capacitor/barcode-scanner definitions). */
const QR_CODE_HINT = 0;

/**
 * Open the camera and read one QR code. Resolves the code's text, or null if
 * the person cancelled, refused the camera, or this is a browser. The camera
 * permission prompt is shown by the system the first time, with the reason
 * from Info.plist / the Android manifest.
 */
export async function scanQrCode(instructions: string): Promise<string | null> {
  const r = await nativeCall<{ ScanResult?: string }>("CapacitorBarcodeScanner", "scanBarcode", {
    hint: QR_CODE_HINT,
    scanInstructions: instructions,
    scanButton: false,
    scanText: " ",
    cameraDirection: 1,
    scanOrientation: 1,
  });
  const text = typeof r?.ScanResult === "string" ? r.ScanResult.trim() : "";
  return text || null;
}

// ── Leaving the app (Android back at the first screen) ─────────────────────

export function minimizeApp(): void {
  void nativeCall("App", "minimizeApp");
}
