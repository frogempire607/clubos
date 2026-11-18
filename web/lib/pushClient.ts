"use client";

// The app's side of push notifications: get this phone's token to the server,
// and open the right screen when a notification is tapped.
//
// Used by components/PushRegistration.tsx (mounted once) and
// components/account/NotificationSettings.tsx (the "Turn on notifications"
// button). In a browser every function here does nothing.
//
// The system permission prompt is shown ONLY by enablePush(), which is only
// ever called from a button press. startPush() never prompts: if the person
// has not allowed notifications yet it simply stops.
//
// Not verified on a real phone. The plugin calls follow
// @capacitor/push-notifications' documented API through the same bridge the
// rest of lib/native.ts uses.

import {
  isNativeApp,
  nativeAppId,
  nativePlatform,
  pushCheckPermission,
  pushOnRegistrationError,
  pushOnTap,
  pushOnToken,
  pushRegister,
  pushRequestPermission,
  type PushPermission,
} from "@/lib/native";
import { DEFAULT_APP_ID, safePushPath } from "@/lib/push";

const TOKEN_KEY = "athletixos-push-token";
const APP_ID_KEY = "athletixos-push-app-id";

let listening = false;
let currentToken: string | null = null;
/** The token the server has accepted for whoever is signed in right now. */
let postedToken: string | null = null;
let posting = false;

function remember(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

function recall(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

async function postToken(token: string): Promise<void> {
  if (posting || postedToken === token) return;
  const platform = nativePlatform();
  if (!platform) return;
  posting = true;
  try {
    const appId = (await nativeAppId()) ?? DEFAULT_APP_ID;
    const res = await fetch("/api/push/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ token, platform: platform === "ios" ? "IOS" : "ANDROID", appId }),
    });
    // 401 = nobody is signed in yet. Leave it unposted; the next screen after
    // sign-in tries again.
    if (res.ok) {
      postedToken = token;
      remember(TOKEN_KEY, token);
      remember(APP_ID_KEY, appId);
    }
  } catch {
    /* no connection: tried again on the next screen */
  } finally {
    posting = false;
  }
}

function listen() {
  if (listening) return;
  listening = true;
  pushOnToken((token) => {
    currentToken = token;
    void postToken(token);
  });
  pushOnRegistrationError(() => undefined);
  pushOnTap((data) => {
    const path = safePushPath(data.path);
    if (!path) return;
    // Same-origin only: the path is resolved against this site and checked.
    try {
      const url = new URL(path, window.location.origin);
      if (url.origin !== window.location.origin) return;
      window.location.assign(url.pathname + url.search);
    } catch {
      /* not a path we can open */
    }
  });
}

/**
 * Called on every signed-in screen. If the person has already allowed
 * notifications, makes sure this phone's token is on the server under their
 * account. Never prompts.
 */
export async function startPush(): Promise<void> {
  if (!isNativeApp()) return;
  listen();
  if ((await pushCheckPermission()) !== "granted") return;
  if (currentToken) {
    await postToken(currentToken);
    return;
  }
  await pushRegister();
}

/** The tap listener alone, so a tap that opened the app is not missed. */
export function listenForPush(): void {
  if (!isNativeApp()) return;
  listen();
}

/** From a button press: show the system prompt, then register. */
export async function enablePush(): Promise<PushPermission> {
  if (!isNativeApp()) return "unavailable";
  listen();
  const state = await pushRequestPermission();
  if (state === "granted") await pushRegister();
  return state;
}

export async function pushPermission(): Promise<PushPermission> {
  return pushCheckPermission();
}

/**
 * Call BEFORE signing out (it needs the session): this phone stops receiving
 * the account's notifications. Safe to call in a browser and when nothing was
 * registered. Never throws.
 */
export async function forgetPushDevice(): Promise<void> {
  if (typeof window === "undefined") return;
  const token = currentToken ?? recall(TOKEN_KEY);
  if (!token) return;
  try {
    await fetch("/api/push/devices", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ token, appId: recall(APP_ID_KEY) ?? undefined }),
    });
  } catch {
    /* best-effort */
  }
  postedToken = null;
  remember(TOKEN_KEY, null);
}
