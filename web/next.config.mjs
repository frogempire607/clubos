/** @type {import('next').NextConfig} */

// Production-only headers. Dev sends them too but HSTS is a no-op over HTTP.
const securityHeaders = [
  // Forces HTTPS for 2 years, includes subdomains, opt-in to preload list later.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  // Block clickjacking — no embedding of our pages in any iframe.
  { key: "X-Frame-Options", value: "DENY" },
  // Block MIME-sniffing — browsers must trust our Content-Type.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Send full URL on same-origin, only path on cross-origin (no querystrings leak).
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Disable powerful browser features we don't use.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
];

// CSP is shipped Report-Only first. After ~2 weeks of clean reports it can be
// promoted to "Content-Security-Policy" (enforcing). Notes on each directive:
//   * 'unsafe-inline' on script-src is needed for our 3 inline <script> tags
//     in app/layout.tsx (theme no-flash + 2 JSON-LD). Next 14 App Router has
//     no built-in nonce flow; nonces would require middleware rewiring.
//     Removing 'unsafe-inline' is a future hardening step (~1d work).
//   * Stripe: redirect-mode Checkout only. js.stripe.com is defensive.
//   * Plaid: Plaid Link uses iframes from cdn.plaid.com + production.plaid.com.
//   * blob: + data: on img-src for our private file viewer (/api/files/[id])
//     and the user-uploaded avatar previews that use object URLs.
//   * connect-src 'self' is enough — every API call goes through our own
//     /api routes. Stripe/Plaid calls are server-side.
const cspDirectives = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://js.stripe.com https://cdn.plaid.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://api.stripe.com",
  "frame-src https://js.stripe.com https://hooks.stripe.com https://cdn.plaid.com https://production.plaid.com",
  "form-action 'self' https://checkout.stripe.com",
  "base-uri 'self'",
  "object-src 'none'",
];

const csp = [...cspDirectives, "frame-ancestors 'none'"].join("; ");

// The public embeddable calendar (/cal/:clubId/:token) exists to be iframed
// on club websites, so it must NOT get X-Frame-Options and needs an open
// frame-ancestors. The pages are token-gated, read-only, and session-free —
// there is nothing to clickjack. Everything else keeps DENY / 'none'.
// (A per-club allowlist from Club.websiteUrl isn't possible here: these
// headers are static and edge middleware has no Prisma access.)
const embedSecurityHeaders = securityHeaders.filter((h) => h.key !== "X-Frame-Options");
const embedCsp = "frame-ancestors *";

const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  // isomorphic-dompurify pulls in jsdom, which Next's webpack bundling mangles
  // for serverless functions — making sanitizeRichHtml() throw at runtime (the
  // Create Document 500). Marking it external makes Netlify load it from
  // node_modules at runtime instead of bundling it.
  experimental: {
    serverComponentsExternalPackages: ["isomorphic-dompurify"],
  },
  async headers() {
    return [
      // Embeddable public calendar — no X-Frame-Options, open frame-ancestors
      // (enforcing; frame-ancestors is ignored in Report-Only mode anyway).
      {
        source: "/cal/:path*",
        headers: [
          ...embedSecurityHeaders,
          { key: "Content-Security-Policy", value: embedCsp },
          { key: "Content-Security-Policy-Report-Only", value: cspDirectives.join("; ") },
        ],
      },
      // Everything else. The negative lookahead excludes the /cal subtree
      // (including bare /cal, which the rule above also matches — :path* is
      // zero-or-more) so the DENY header is never added there: Next applies
      // EVERY matching rule, and a stray X-Frame-Options: DENY blocks
      // embedding even when CSP allows it.
      {
        source: "/((?!cal$|cal/).*)",
        headers: [
          ...securityHeaders,
          { key: "Content-Security-Policy-Report-Only", value: csp },
        ],
      },
    ];
  },
};

export default nextConfig;
