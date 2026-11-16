// The native app's configuration, as a pure function of where it points.
//
// `capacitor.config.ts` calls this and nothing else, so the rules for a
// RELEASE build live in one place that a test can hold to account
// (scripts/native-config-tests.ts). No imports: the Capacitor CLI loads this
// file with a bare TypeScript transpile, and tests load it without the CLI.
//
// What a store build must never ship, and why:
//   - debug logging          every bridge call, with its arguments, in the
//                            device log
//   - cleartext / mixed      plain-http content inside a signed-in session
//   - an open navigation     the web view is the app; it may only ever show
//     list                   our own pages and the payment pages we send
//                            people to
//
// ARCHITECTURE (docs/MOBILE-APP-PLAN-2026-11-15.md §3): the binary ships a
// local shell (launch screen, offline screen with the last-known schedule,
// retry) plus every native capability. Screens are first-party web content
// from our own server, in this web view, locked to the hosts listed here.

export const APP_ID = "com.athletixos.app";
export const APP_NAME = "AthletixOS";
export const DEV_SERVER_URL = "http://127.0.0.1:3000";

/**
 * Stripe-hosted pages a signed-in person is sent to and must come back from:
 * Checkout, the billing portal, and Connect onboarding for an owner. They stay
 * INSIDE the app's web view so the return lands back in the app — sent out to
 * Safari, the "you paid" page opens in the browser and the app never hears.
 */
export const PAYMENT_HOSTS = ["checkout.stripe.com", "billing.stripe.com", "connect.stripe.com"] as const;

export type NativeEnv = { CAPACITOR_SERVER_URL?: string; NEXT_PUBLIC_APP_URL?: string };

export function resolveServerUrl(env: NativeEnv): string {
  // Deliberately NOT falling back to NEXTAUTH_URL: a mis-set value there has
  // poisoned the start URL before.
  return (env.CAPACITOR_SERVER_URL || env.NEXT_PUBLIC_APP_URL || DEV_SERVER_URL).replace(/\/$/, "");
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** A release build is one that points at an https origin. */
export function isReleaseTarget(serverUrl: string): boolean {
  return /^https:\/\//i.test(serverUrl);
}

export function allowedNavigation(serverUrl: string): string[] {
  const host = hostOf(serverUrl);
  if (isReleaseTarget(serverUrl)) {
    const own = [host, host.startsWith("www.") ? host.slice(4) : `www.${host}`].filter(Boolean);
    return Array.from(new Set([...own, ...PAYMENT_HOSTS]));
  }
  // Development only (cleartext http): stay permissive so a stray absolute
  // URL — Next's error overlay, a LAN IP, a 0.0.0.0 self-link — shows its
  // error in the web view instead of bouncing to Safari.
  return Array.from(
    new Set([host, "localhost:3000", "127.0.0.1:3000", "localhost", "127.0.0.1", "0.0.0.0", "0.0.0.0:3000", "*"].filter(Boolean)),
  );
}

export type BuiltNativeConfig = {
  appId: string;
  appName: string;
  webDir: string;
  backgroundColor: string;
  appendUserAgent: string;
  loggingBehavior: "none" | "debug";
  server: { url: string; cleartext: boolean; allowNavigation: string[]; errorPath: string };
  ios: { path: string; limitsNavigationsToAppBoundDomains: boolean; contentInset: "never" };
  android: { path: string; allowMixedContent: boolean; webContentsDebuggingEnabled: boolean };
  plugins: {
    SplashScreen: { launchAutoHide: boolean; launchShowDuration: number; backgroundColor: string; showSpinner: boolean };
    Keyboard: { resize: "native"; resizeOnFullScreen: boolean };
    StatusBar: { overlaysWebView: boolean; backgroundColor: string; style: "DARK" };
  };
};

export function buildNativeConfig(env: NativeEnv): BuiltNativeConfig {
  const serverUrl = resolveServerUrl(env);
  const release = isReleaseTarget(serverUrl);
  return {
    appId: APP_ID,
    appName: APP_NAME,
    // The bundled local shell: index.html (launch), native-shell-error.html
    // (offline + last-known schedule + retry).
    webDir: "public/native-shell",
    backgroundColor: "#1F1F23",
    appendUserAgent: "AthletixOSNativeShell",
    loggingBehavior: release ? "none" : "debug",
    server: {
      // The path is baked into the URL rather than `appStartPath`, which iOS
      // reads as a file inside the local bundle and fails on.
      url: `${serverUrl}/member`,
      cleartext: !release,
      allowNavigation: allowedNavigation(serverUrl),
      errorPath: "native-shell-error.html",
    },
    ios: {
      path: "ios",
      // false: app-bound domains would also restrict the script the bridge
      // injects into our own pages. Navigation is limited by allowNavigation.
      limitsNavigationsToAppBoundDomains: false,
      contentInset: "never",
    },
    android: {
      path: "android",
      allowMixedContent: !release,
      webContentsDebuggingEnabled: !release,
    },
    plugins: {
      // The web app hides the splash once its first screen has drawn
      // (components/NativeShell). The duration is only the fallback if it
      // never gets the chance; the offline page hides it too.
      SplashScreen: { launchAutoHide: true, launchShowDuration: 4000, backgroundColor: "#1F1F23", showSpinner: false },
      Keyboard: { resize: "native", resizeOnFullScreen: true },
      StatusBar: { overlaysWebView: false, backgroundColor: "#1F1F23", style: "DARK" },
    },
  };
}
