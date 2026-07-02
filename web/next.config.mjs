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

// CSP is now ENFORCING (was Report-Only). Notes on each directive:
//   * 'unsafe-inline' on script-src remains REQUIRED: Next 14 App Router streams
//     the RSC payload via dynamic, per-request inline <script> tags
//     (self.__next_f.push(...)) that cannot be hashed and have no nonce without
//     wiring a nonce through middleware. Dropping 'unsafe-inline' without that
//     wiring breaks hydration entirely. Nonce-based CSP is the remaining
//     hardening step (tracked on the security follow-up list) and needs browser
//     regression testing; it is deliberately NOT attempted blind here.
//   * Stripe: redirect-mode Checkout only. js.stripe.com is defensive.
//   * Plaid: Plaid Link uses iframes from cdn.plaid.com + production.plaid.com.
//   * Plausible + Sentry: optional telemetry — allowed in script-src/connect-src
//     so enabling them can't be broken by the enforcing policy.
//   * blob: + data: on img-src for our private file viewer (/api/files/[id])
//     and the user-uploaded avatar previews that use object URLs.
//   * worker-src blob: for Sentry session-replay (opt-in) web workers.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://js.stripe.com https://cdn.plaid.com https://plausible.io",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://api.stripe.com https://plausible.io https://*.sentry.io https://*.ingest.sentry.io https://*.ingest.us.sentry.io",
  "frame-src https://js.stripe.com https://hooks.stripe.com https://cdn.plaid.com https://production.plaid.com",
  "frame-ancestors 'none'",
  "form-action 'self' https://checkout.stripe.com",
  "base-uri 'self'",
  "object-src 'none'",
  "worker-src 'self' blob:",
].join("; ");

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
      {
        source: "/:path*",
        headers: [
          ...securityHeaders,
          { key: "Content-Security-Policy", value: csp },
        ],
      },
    ];
  },
};

export default nextConfig;
