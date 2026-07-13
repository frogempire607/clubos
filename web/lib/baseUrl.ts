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
// Hostnames that are never reachable from a real device even when the dev
// server binds to them. NEXTAUTH_URL pointing at any of these gets rejected
// so we don't ship URLs that crash the iPhone WebView (`0.0.0.0` is on
// WebKit's restricted-network-ports list — the WebView refuses to load it
// and Capacitor escapes to Safari, which then shows the visible "Not
// allowed to use restricted network port" error).
const UNROUTABLE_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

// Base URL derived from the INCOMING REQUEST's origin, for URLs the current
// visitor will navigate to next (Stripe success/cancel returns, links echoed
// back into the UI, reactivation emails sent from an owner session). Why:
// NEXTAUTH_URL is one value for every Netlify context, so on a deploy
// preview / branch deploy getAppBaseUrl() points at the PRODUCTION domain —
// which 404s for any route that only exists on the preview. Deriving from
// the request keeps the whole flow on the deployment the user is actually
// using (and on production it IS the production origin).
//
// Host-header safety: the host is attacker-influencable in principle, and
// these URLs land in emails — so only hosts we recognize are trusted
// (the configured NEXTAUTH_URL host, *.netlify.app deploy domains, and
// local dev). Anything else falls back to getAppBaseUrl().
export function baseUrlFromRequest(req: Request): string {
  const configured = getAppBaseUrl();
  try {
    const rawHost = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "")
      .split(",")[0]
      .trim()
      .toLowerCase();
    if (!rawHost) return configured;
    const hostname = rawHost.split(":")[0];
    const configuredHost = new URL(configured).hostname.toLowerCase();
    const trusted =
      hostname === configuredHost ||
      hostname.endsWith(".netlify.app") ||
      hostname === "localhost" ||
      hostname === "127.0.0.1";
    if (!trusted) return configured;
    const proto = (req.headers.get("x-forwarded-proto") ?? "").split(",")[0].trim() ||
      (hostname === "localhost" || hostname === "127.0.0.1" ? "http" : "https");
    return `${proto}://${rawHost}`;
  } catch {
    return configured;
  }
}

export function getAppBaseUrl(): string {
  const raw = process.env.NEXTAUTH_URL;
  if (raw) {
    try {
      const parsed = new URL(raw);
      if (UNROUTABLE_HOSTS.has(parsed.hostname)) {
        if (!warnedThisProcess) {
          // eslint-disable-next-line no-console
          console.warn(
            `[baseUrl] NEXTAUTH_URL host ${parsed.hostname} is a bind-only ` +
              `address that the iPhone WebView can't reach (it's on WebKit's ` +
              `restricted-network-port list). Falling back to ${DEV_FALLBACK}. ` +
              `Set NEXTAUTH_URL to your Mac's LAN IP (e.g. http://10.0.0.45:3000) ` +
              `for real-device dev, or 127.0.0.1:3000 for the simulator.`,
          );
          warnedThisProcess = true;
        }
        return DEV_FALLBACK;
      }
      return parsed.origin;
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
