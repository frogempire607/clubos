import type { CapacitorConfig } from "@capacitor/cli";

// Capacitor server config.
//
// - Local dev (simulator):  http://localhost:3001  (default below)
// - Real iOS device on LAN: http://<mac-lan-ip>:3001   via CAPACITOR_SERVER_URL
// - Production:             https://app.yourdomain.com via CAPACITOR_SERVER_URL
//   (or NEXT_PUBLIC_APP_URL / NEXTAUTH_URL — first one set wins)
//
// iOS needs App Transport Security exceptions for `http://` URLs; those live
// in `ios/App/App/Info.plist` (NSAppTransportSecurity → NSAllowsLocalNetworking).
// On Android, `cleartext: true` below is enough.
const nativeServerUrl =
  process.env.CAPACITOR_SERVER_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  process.env.NEXTAUTH_URL ||
  "http://localhost:3001";

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

const config: CapacitorConfig = {
  appId: "com.athletixos.app",
  appName: "AthletixOS",
  // Static fallback bundle. Used only when server.url is unreachable
  // (`errorPath` below) — every other load goes to the live server.
  webDir: "public/native-shell",
  backgroundColor: "#1F1F23",
  appendUserAgent: "AthletixOSNativeShell",
  loggingBehavior: "debug",
  server: {
    url: nativeServerUrl,
    // Start the WebView at the member portal. Middleware redirects
    // unauthenticated visitors to /login, then NextAuth's callbackUrl
    // brings them back here after sign-in.
    appStartPath: "/member",
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
