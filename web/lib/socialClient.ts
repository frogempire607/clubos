"use client";

// Starting Sign in with Google / Apple from a page.
//
//   Website: ask the server for the provider's address and go there.
//   App:     Google refuses sign-in inside an app's own web view
//            (`disallowed_useragent`), so the flow runs in the system browser
//            sheet (@capacitor/browser: SFSafariViewController / Custom Tabs).
//            Before opening it we make a secret and send only its SHA-256.
//            The sheet ends on com.athletixos.app://auth/social?code=…, which
//            reopens the app; the web view then trades the code AND the
//            secret for a session. A code without the secret is worthless.

import { isNativeApp, nativeCall, nativeListen } from "@/lib/native";
import type { SocialProvider } from "@/lib/socialAuth";
import { socialErrorText } from "@/lib/socialErrors";

export type StartResult = { ok: true } | { ok: false; error: string };

function b64u(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function makeSecret(): Promise<{ verifier: string; challenge: string }> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const verifier = b64u(raw);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64u(new Uint8Array(digest)) };
}

const RETURN_PREFIX = "com.athletixos.app://auth/social";
let stopListening: (() => void) | null = null;

type Finished = (r: { next?: string; error?: string; connected?: boolean }) => void;

function listenForReturn(verifier: string, onDone: Finished) {
  stopListening?.();
  stopListening = nativeListen<{ url?: string }>("App", "appUrlOpen", (e) => {
    const url = e?.url ?? "";
    if (!url.startsWith(RETURN_PREFIX)) return;
    stopListening?.();
    stopListening = null;
    void nativeCall("Browser", "close");
    let q: URLSearchParams;
    try {
      q = new URL(url).searchParams;
    } catch {
      onDone({ error: "That sign-in attempt expired. Please try again." });
      return;
    }
    if (q.get("error")) return onDone({ error: socialErrorText(q.get("error")) });
    if (q.get("result") === "connected") return onDone({ connected: true });
    const code = q.get("code");
    if (!code) return onDone({ error: socialErrorText("provider") });
    void fetch("/api/auth/social/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ code, verifier }),
    })
      .then(async (r) => {
        const d = (await r.json().catch(() => ({}))) as { next?: string; error?: string };
        onDone(r.ok && d.next ? { next: d.next } : { error: socialErrorText(d.error) });
      })
      .catch(() => onDone({ error: "Could not reach the server. Check your connection and try again." }));
  });
}

/**
 * Begin a Google or Apple sign-in (mode "signin", needs the club code) or
 * connect one to the signed-in account (mode "connect"). In a browser this
 * navigates away; in the app `onDone` is called when the sheet comes back.
 */
export async function startSocial(input: {
  provider: SocialProvider;
  club?: string;
  mode?: "signin" | "connect";
  next?: string | null;
  onDone?: Finished;
}): Promise<StartResult> {
  const native = isNativeApp();
  const secret = native ? await makeSecret() : null;
  let res: Response;
  try {
    res = await fetch("/api/auth/social/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        provider: input.provider,
        club: input.club ?? "",
        mode: input.mode ?? "signin",
        next: input.next ?? undefined,
        ...(secret ? { app: secret.challenge } : {}),
      }),
    });
  } catch {
    return { ok: false, error: "Could not reach the server. Check your connection and try again." };
  }
  const d = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!res.ok || !d.url) return { ok: false, error: d.error ?? "That sign-in option isn't available right now." };

  if (native && secret) {
    listenForReturn(secret.verifier, (r) => {
      if (r.next) window.location.assign(r.next);
      else input.onDone?.(r);
    });
    const opened = await nativeCall("Browser", "open", { url: d.url, presentationStyle: "popover" });
    if (opened === null) {
      stopListening?.();
      stopListening = null;
      return { ok: false, error: "This version of the app can't open Google or Apple sign-in. Update the app, or use your email and password." };
    }
    return { ok: true };
  }
  window.location.assign(d.url);
  return { ok: true };
}

/** The buttons to draw: only providers whose keys are set on the server. */
export async function fetchSocialProviders(): Promise<SocialProvider[]> {
  try {
    const r = await fetch("/api/auth/social/providers");
    const d = (await r.json()) as { providers?: SocialProvider[] };
    return Array.isArray(d.providers) ? d.providers : [];
  } catch {
    return [];
  }
}
