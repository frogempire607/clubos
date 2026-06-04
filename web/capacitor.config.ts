import type { CapacitorConfig } from "@capacitor/cli";

// Capacitor server config.
//
// - Local dev (simulator):  http://127.0.0.1:3000  (default below)
// - Real iOS device on LAN: http://<mac-lan-ip>:3000   via CAPACITOR_SERVER_URL
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
//
// Why port 3000 and not 3001: WebKit blocks a list of "restricted network
// ports" inside WKWebView (the error reads "Not allowed to use restricted
// network port"). 3001 hits that block on recent iOS versions while macOS
// browsers don't, which made the dev server reachable in Safari/Chrome
// but invisible to the simulator. 3000 is on WebKit's allowlist.
const nativeServerUrl =
  process.env.CAPACITOR_SERVER_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "http://127.0.0.1:3000";

function serverHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

// Hostnames the WebView is allowed to navigate to. Anything NOT in this list
// gets bounced to Safari (Capacitor's external-link behavior). For a dev
// build we err on the permissive side so a stray absolute URL during dev
// (Next's error overlay, a misconfigured NEXTAUTH_URL, a Stripe sandbox
// redirect) stays in-app where the error is visible — not in Safari, which
// throws WebKit's "Not allowed to use restricted network port" page on
// 0.0.0.0 and other bind-only addresses. Production HTTPS targets stay
// tight because the wildcard only fires when the server URL itself is
// cleartext http://.
const isDevServer = nativeServerUrl.startsWith("http://");
const baseAllowed = [
  serverHost(nativeServerUrl),
  "localhost:3000",
  "127.0.0.1:3000",
  "localhost",
  "127.0.0.1",
  // Defensive: Next dev's `-H 0.0.0.0` bind sometimes leaks into self-URLs
  // (HMR sockets, error overlays). Listing 0.0.0.0 keeps the WebView in
  // charge rather than letting Safari take the nav and hit its restricted-
  // port wall.
  "0.0.0.0",
  "0.0.0.0:3000",
].filter(Boolean);

// In dev (cleartext http://), allow any host on the same /24 as the
// configured server URL so a Mac LAN-IP nav can roam — same-network
// devices only. Plus a wildcard for catch-all under cleartext.
const allowedHosts = Array.from(
  new Set(
    isDevServer
      ? [
          ...baseAllowed,
          // Cleartext-only catch-all. Capacitor honors `*` here only when
          // server.cleartext === true (which is gated below to dev URLs).
          // In a production HTTPS build this list is irrelevant.
          "*",
        ]
      : baseAllowed,
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
