# AthletixOS Security Audit — Results

**Audit date:** 2026-06-05
**Scope:** `web/` workspace at branch `main` tip `0c5c340` → ending tip `6ad3a1b`
**Tasks covered:** 1 through 7 of `CLAUDE_TASKS.md`
**Pinned versions preserved:** Next.js 14.2.35, Prisma 5.7.0, NextAuth v4 (no dependency upgrades performed)

---

## Headline

**No critical issues found that block v1 launch.** Every audit task either confirmed an existing safe pattern or surfaced a defense-in-depth gap that was closed during the audit. Two items are deliberately deferred as security debt (one architectural, one nice-to-have hardening step). Neither leaves a known exploit on the table.

---

## Critical (must fix before v1 or any real customer)

**None.**

The audit did not find any exploitable vulnerability that would block v1. Every issue surfaced is either already closed in this audit's commits, or carried forward as security debt that does not enable a known attack.

---

## High (fix soon)

### ✅ Login endpoint had no rate limit — CLOSED (commit `0c5c340`)
The NextAuth `CredentialsProvider.authorize()` callback in `lib/auth.ts` was the only auth-adjacent route without a brute-force throttle. Now rate-limited at 10 attempts / 10 minutes per IP via `lib/ratelimit`. Returning `null` on throttle exhaustion surfaces NextAuth's generic `CredentialsSignin` error — no timing oracle distinguishing brute force from a wrong password.

**Caveat carried forward:** `lib/ratelimit` is in-memory per-process. On a Vercel-style multi-instance deploy each warm instance has its own bucket. Effective limit scales with warm-instance count. Survivable with strong passwords; swap for `@upstash/ratelimit` + Redis only if you need per-cluster guarantees later.

---

## Medium (fix when convenient)

### ✅ `lib/memberStatus.ts` accepted a bare memberId — CLOSED (commit `c5e7aea`)
The helper `recomputeMemberStatus(memberId)` did `findUnique({where: {id: memberId}})` with no clubId check. All 7 callers happened to pass clubId-scoped IDs (so it was safe at the time of audit) but the helper had no enforcement. Signature is now `recomputeMemberStatus(memberId, clubId)` with internal `findFirst({where: {id, clubId}})` — a future caller cannot leak tenancy.

### ✅ Stripe webhook loaded ClassSession/ProductSale by ID without clubId cross-check — CLOSED (commit `c5e7aea`)
Two `findUnique({where: {id: classSessionId}})` / `findUnique({where: {id: saleId}})` sites in the webhook handler are now `findFirst({where: {id, clubId}})` using the clubId already extracted from `session.metadata.clubId`. Stripe signature verification already prevents arbitrary fabrication, but this closes the defense-in-depth gap so a future metadata-injection bug cannot cross-club a booking or product inventory decrement.

### ✅ bcrypt cost factor was 10 (OWASP minimum) — CLOSED (commit `0c5c340`)
All 7 password-hash sites bumped from cost 10 to cost 12. bcrypt encodes cost in the hash, so existing user hashes (cost 10) continue to verify forever; only new hashes (signup, password reset, change-password, staff invites, contractor invites, member migration activation) get cost 12. Cost 12 ≈ 250-400 ms per hash on modern hardware — invisible to users, meaningful for offline-cracking attackers.

---

## Low / nice-to-have (post-v1)

### ✅ Explicit 14-day session lifetime — DONE (commit `0c5c340`)
`session.maxAge = 60 * 60 * 24 * 14` (was inheriting NextAuth's 30-day default). Tighter window for stolen cookies. SOC2-friendly. Owner-side users use the dashboard daily and will never see the prompt; member native-shell users get a fresh login every two weeks.

### ✅ Security headers — DONE (commit `342d8ad`)
`next.config.mjs` now sends `Strict-Transport-Security`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and `Permissions-Policy` on every response. CSP is shipped in **Report-Only** mode with directives that pre-permit Stripe (redirect Checkout), Plaid Link iframes, and the Capacitor WebView. Promote `Content-Security-Policy-Report-Only` to `Content-Security-Policy` after ~2 weeks of clean violation reports in the browser console.

### ✅ Input validation gap on `email-test` — CLOSED (commit `6ad3a1b`)
`app/api/club/email-test/route.ts` now validates the optional `to` field through a Zod `z.string().email().optional()` schema before passing it to nodemailer. Closes the only no-Zod body-accepting route surfaced by the Task 7 audit. (Owner-only route; risk profile was already low — owners can broadcast via announcements — but the `as string` cast allowed header-shaped strings through.)

### Removing `'unsafe-inline'` from `script-src` — DEFERRED
The CSP's `script-src` includes `'unsafe-inline'` because `app/layout.tsx` has 3 inline `<script>` tags (no-flash theme + 2 JSON-LD blocks). Replacing with nonces requires per-request nonce generation in middleware + threading the nonce through every inline script tag. Next 14 App Router has no built-in nonce flow. ~1 day of work; tracked as security debt.

### Central tenant-enforcement layer — DEFERRED (F-3 from Task 2)
271 Prisma query sites audited; every one is correctly clubId-scoped through manual discipline. There is no DB-level safety net (no Prisma middleware `$use`, no client extension auto-injecting tenant filter). The 11 indirectly-scoped models (`Booking`, `EventSession`, `MemberSubscription`, etc.) all resolve to clubId through a required parent FK.

**Recommended post-v1 approach:** add a `tenantDb(clubId)` typed wrapper at route-handler boundaries rather than a global Prisma extension. Bigger lift (~1 day) but enforces tenancy at compile time. Tracked as security debt — does not block v1 because current discipline holds across all 271 query sites.

---

## Audit-by-task summary

| Task | What was audited | Result |
|---|---|---|
| 1 — Dependency licenses | 704 packages | ✅ No GPL/AGPL/LGPL/SSPL anywhere. 4 MPL-2.0 transitives (axe-core dev-only, dompurify is dual-licensed Apache-2.0, lightningcss build-only). No open-source obligation, no removal needed. `licenses.json` saved at repo root. |
| 2 — Multi-tenant isolation | 271 Prisma query sites + 59 models | ✅ Schema correct (every model resolves to clubId). 30 of 31 mutate-by-id sites had upstream clubId guards; the 1 weak helper closed (F-1). Two webhook lookups hardened (F-2). Architectural F-3 deferred. |
| 3 — Stripe webhook signature | `app/api/stripe/webhook/route.ts` | ✅ `constructEvent` over raw body, env-sourced secret, signature failure rejected, idempotent via `StripeWebhookEvent` table. No fixes needed. |
| 4 — Secrets & git history | Current code + all 155 commits | ✅ No real `sk_live`/`sk_test`/`whsec_`/`DATABASE_URL` credentials in code or history. `.env*` correctly gitignored. No rotation needed. |
| 5 — Security headers | `next.config.mjs` | ✅ 5 hardening headers enforced + CSP in Report-Only mode. |
| 6 — Auth & login | NextAuth + bcrypt sites | ✅ Cookies correct (httpOnly, secure, sameSite, prefixed in prod). Login rate-limit added, bcrypt cost bumped, session shortened to 14 days. |
| 7 — Input validation | 131 mutating routes | ✅ 114 use Zod, 16 take no body (URL params only), 1 (preview) has manual enum validation, 1 (email-test) gap closed in F-VAL-1. Zero `$queryRawUnsafe`. The one `$queryRaw` site is correctly parameterized. |

---

## Commits produced by this audit (in order)

| SHA | Task | Description |
|---|---|---|
| `c5e7aea` | 2 | Multi-tenant defense-in-depth (F-1 + F-2) |
| `342d8ad` | 5 | Security headers + CSP (Report-Only) |
| `0c5c340` | 6 | Auth hardening: login rate-limit + bcrypt cost 12 + 14d session |
| `6ad3a1b` | 7 | Input validation: email-test Zod schema |

Pure read-only / report-only deliverables (Tasks 1, 3, 4) produced no code commits beyond `licenses.json`.

All commits verified `tsc --noEmit` + `npm run build` + `cap sync` clean. No dependency versions changed. No new dependencies added. No git history rewrites. No database migrations applied.

---

## Items for the operator (you) to handle before launch

These are operational, not code:

1. **Set production env vars** — `NEXT_PUBLIC_SITE_URL=https://athletix-os.com`, `EMAIL_FROM=AthletixOS <noreply@athletix-os.com>`, all `STRIPE_*` live mode IDs, `STRIPE_WEBHOOK_SECRET` from your live Stripe dashboard webhook endpoint, `NEXTAUTH_SECRET` strong random (32+ chars), `DATABASE_URL` to production Postgres.
2. **Stripe live mode** — switch from test mode keys, create live-mode Stripe Price IDs for Growth/Pro/Enterprise tiers, register the production webhook URL.
3. **Promote CSP to enforcing** — after ~2 weeks of running with no `Content-Security-Policy-Report-Only` violations in browser DevTools console, rename the header to `Content-Security-Policy` in `next.config.mjs`.
4. **One-time user re-login** — the new 14-day session cap is shorter than the old 30-day default. Active users will be prompted to re-login once after deploy. One-time blip, not recurring.
5. **Watch the rate-limit caveat** — in-memory rate limits scale per-warm-instance on Vercel. If brute-force attempts become a problem, swap `lib/ratelimit.ts` for an Upstash/Redis-backed implementation.
