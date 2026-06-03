// Single source of truth for the app's external base URL.
//
// Why this exists: 18+ call sites used to inline
//   process.env.NEXTAUTH_URL || "http://localhost:3001"
// to build email links, Stripe success/cancel URLs, password-reset URLs,
// etc. Two failure modes that pattern doesn't handle:
//
//   1. NEXTAUTH_URL set but malformed (e.g. the literal string
//      `NEXTAUTH_URL=http://...` with the key name baked into the value
//      from a copy-paste). The `||` fallback never fires because the
//      string is truthy, and the downstream redirect ships the malformed
//      URL to the browser.
//   2. Port 3001 is on WebKit's restricted-network-ports blocklist —
//      iOS WKWebView refuses to navigate to it. The hard-coded fallback
//      silently breaks the native shell.
//
// getAppBaseUrl() validates NEXTAUTH_URL with `new URL()`. If parsing
// fails (or the env var is unset), it returns the IPv4-literal dev URL
// the Capacitor shell expects. In production NEXTAUTH_URL must be set
// correctly — the fallback is a dev-time safety net, not a prod default.
const DEV_FALLBACK = "http://127.0.0.1:3000";

let warnedThisProcess = false;

// IMPORTANT: subpath deployments (NEXTAUTH_URL=https://example.com/app)
// are NOT supported by this helper — `.origin` drops the path. If you
// ever need that, return new URL(raw).href.replace(/\/$/, "") instead
// and audit every `${baseUrl}/...` call site for double-slashing.
export function getAppBaseUrl(): string {
  const raw = process.env.NEXTAUTH_URL;
  if (raw) {
    try {
      return new URL(raw).origin;
    } catch {
      // Always log, including in production. The point of this hardening
      // was to surface misconfig loudly — silencing prod buries the bug
      // exactly where it matters most (Stripe redirect URLs, email links,
      // webhook callback URLs all use this value).
      if (!warnedThisProcess) {
        const msg =
          `[baseUrl] NEXTAUTH_URL is set but does not parse as a URL ` +
          `(value: ${JSON.stringify(raw)}). Falling back to ${DEV_FALLBACK}. ` +
          `If this fires in production, every Stripe/email URL constructed ` +
          `from this value is unreachable. Fix .env immediately.`;
        // Error level in prod, warn elsewhere.
        if (process.env.NODE_ENV === "production") {
          // eslint-disable-next-line no-console
          console.error(msg);
        } else {
          // eslint-disable-next-line no-console
          console.warn(msg);
        }
        warnedThisProcess = true;
      }
    }
  }
  return DEV_FALLBACK;
}
