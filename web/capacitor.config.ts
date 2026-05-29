import type { CapacitorConfig } from "@capacitor/cli";

// Capacitor server config.
//
// - Local dev (simulator):  http://127.0.0.1:3001  (default below)
// - Real iOS device on LAN: http://<mac-lan-ip>:3001   via CAPACITOR_SERVER_URL
// - Production:             https://app.yourdomain.com via CAPACITOR_SERVER_URL
//   (or NEXT_PUBLIC_APP_URL — first one set wins)
//
// Why 127.0.0.1 instead of `localhost`: macOS resolves `localhost` to IPv6
// `::1` first. If Next dev only bound to IPv4 127.0.0.1 (a common Next 14
// default and what you get on macOS without an explicit -H flag), the
// simulator's WKWebView tries `::1`, the connect is refused, and Capacitor
// falls back to the native-shell-error.html page ("Can't reach AthletixOS").
// Browsers happen-stance try both stacks more aggressively, which is why
// they work and the WebView doesn't. The literal IP bypasses DNS so this
// IPv6/IPv4 race never happens.
//
// We do NOT fall back to NEXTAUTH_URL here. A misconfigured .env (e.g.
// the literal string `NEXTAUTH_URL=http://...` with the key name baked
// into the value) would poison the WebView's start URL.
const nativeServerUrl =
  process.env.CAPACITOR_SERVER_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "http://127.0.0.1:3001";

function serverHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

// Hostnames the WebView is allowed to navigate to. Always include localhost +
// 127.0.0.1 so the simulator can reach the dev server no matter which form
// the URL takes, plus whatever the resolved server URL points at.
const allowedHosts = Array.from(
  new Set(
    [
      serverHost(nativeServerUrl),
      "localhost:3001",
      "127.0.0.1:3001",
      "localhost",
      "127.0.0.1",
    ].filter(Boolean),
  ),
);

// Start the WebView at the member portal. We bake the `/member` path into
// the URL itself rather than using `appStartPath`, because Capacitor iOS
// interprets `appStartPath` as a path INSIDE the local webDir bundle and
// errors out at startup if that file doesn't exist (`Unable to load
// /App.app/public//member`). The server URL form bypasses that local-file
// check entirely. Middleware redirects unauthenticated visitors to /login,
// then NextAuth's callbackUrl brings them back here after sign-in.
const startUrl = `${nativeServerUrl.replace(/\/$/, "")}/member`;

const config: CapacitorConfig = {
  appId: "com.athletixos.app",
  appName: "AthletixOS",
  // Static fallback bundle. The default appStartPath is "index.html",
  // which exists at public/native-shell/index.html — so the local-file
  // validator at iOS launch is satisfied even though the WebView always
  // jumps straight to server.url.
  webDir: "public/native-shell",
  backgroundColor: "#1F1F23",
  appendUserAgent: "AthletixOSNativeShell",
  loggingBehavior: "debug",
  server: {
    url: startUrl,
    cleartext: nativeServerUrl.startsWith("http://"),
    allowNavigation: allowedHosts,
    errorPath: "native-shell-error.html",
  },
  ios: {
    path: "ios",
    // Lets the WebView keep cookies across launches so the NextAuth
    // session survives between app opens.
    limitsNavigationsToAppBoundDomains: false,
  },
  android: {
    path: "android",
    // Same effect as `cleartext: true` but scoped to the Android arm.
    allowMixedContent: true,
  },
};

export default config;
