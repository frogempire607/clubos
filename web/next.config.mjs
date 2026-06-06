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
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://js.stripe.com https://cdn.plaid.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://api.stripe.com",
  "frame-src https://js.stripe.com https://hooks.stripe.com https://cdn.plaid.com https://production.plaid.com",
  "frame-ancestors 'none'",
  "form-action 'self' https://checkout.stripe.com",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          ...securityHeaders,
          { key: "Content-Security-Policy-Report-Only", value: csp },
        ],
      },
    ];
  },
};

export default nextConfig;
