# Dependency security audit

2026-11-18 · branch `claude/dependency-security-2026-11-18` · not pushed, not deployed

## Count

| | critical | high | moderate | low | total |
|---|---|---|---|---|---|
| Before (`npm audit`, lockfile on `main`) | 9 | 24 | 81 | 2 | **116** |
| After | 1 | 4 | 41 | 0 | **46** |

The request quoted 128 (9 critical, 38 high) from `npm install`. Measured here
from the committed lockfile it was 116 (9 critical, 24 high). The advisory feed
changes daily; the nine criticals are the same nine either way.

**Everything left needs a major version**, which was out of scope. Each is
explained under "Needs your decision".

No `npm audit fix --force`. Only patch and minor updates, plus one removal.

## Where a package can run

| Label | Meaning |
|---|---|
| **Server** | the Next.js server and the scheduled function on Netlify |
| **Browser** | shipped in the JavaScript a visitor downloads |
| **App** | compiled into the iOS / Android app |
| **Tooling** | only on a developer's machine or the build server; never serves a request |

## Critical (9)

| Package | Was | Reaches | What it is, here | Outcome |
|---|---|---|---|---|
| `next` | 14.2.35 | Server, Browser | 25 advisories. Three are critical remote-code-execution: one is Windows hosting only (we are not); two are in Next's own image optimizer, which **does not run in production** — the live `/_next/image` is answered by Netlify's Image CDN (checked: the response carries Netlify's image headers), and the app has zero `next/image` uses. What does apply: several denial-of-service advisories against the App Router. Not applicable by construction: Server Actions (none in the app), Pages Router and i18n (not used), CSP nonces (not used), WebSocket upgrades (not available on Netlify functions), rewrite SSRF (the three rewrites point at fixed internal paths). | **Not fixed — 14.2.35 is the last 14.x.** See decision 1. |
| `next-auth` | 4.24.14 | Server, Browser | Email look-alike check, a crash on a malformed `Authorization` header, OAuth check cookies not bound to their provider. Sign in with Google and Apple are live, so the third one mattered. | **Fixed: 4.24.15.** |
| `@auth/core` | 0.29.0 | — | Same three advisories. Came in only through `@auth/prisma-adapter`. | **Removed** (below). |
| `@auth/prisma-adapter` | 1.6.0 | — | Listed as a dependency and imported by nothing — sessions are JWT, there is no adapter. | **Removed.** Took `@auth/core` with it. |
| `@capacitor/ios` | 8.3.4 | App | Remote content could be loaded at the app's own origin through Capacitor's internal web server. The app is a WebView on the live site, so "the app's origin" is where the session lives. | **Updated to 8.6.2 in `package.json` — NOT YET IN THE APP.** See "The mobile app" below. |
| `@capacitor/android` | 8.3.4 | App | Same advisory. | Same. |
| `@sentry/nextjs` | 10.54.0 | Server, Browser | Middleware bypass when Sentry's tunnel route is used. No tunnel route is configured, and Sentry is not initialised in production at all (crash audit, Part 3). | **Fixed anyway: 10.78.0.** |
| `tar` | 7.5.15 | Tooling | Archive parsing bugs. Comes from `@capacitor/cli`, which runs when a developer syncs the native projects. It unpacks Capacitor's own templates. | **Fixed** (transitive update). |
| `proxy-addr` | 2.0.7 | Tooling | IP spoofing in an Express helper. Comes from `shadcn`, a component-scaffolding CLI. | **Fixed** (`shadcn` 4.23.0). |

## High (24)

| Package | Reaches | What it is, here | Outcome |
|---|---|---|---|
| `@tiptap/core` | Browser | The email composer's editor: an attribute-merging bug and a slow regex in Markdown parsing. | **Fixed: 3.34.0** (all seven Tiptap packages together). |
| `prosemirror-view` | Browser | Cross-site scripting through pasted content in the same editor. The realistic case is staff pasting from a hostile page. | **Fixed** (with Tiptap). |
| `dompurify` | Server, Browser | Sanitizer bypasses in modes this app does not use (`IN_PLACE`, templates, Trusted Types). It is what cleans club-written HTML before it is stored, so it is kept current regardless. | **Fixed** (transitive). |
| `axios`, `follow-redirects`, `form-data` | Server | Used by the Plaid SDK for calls to Plaid's own API: proxy credential leaks on redirect, header injection through prototype pollution. No proxy is configured and the destination is fixed. | **Fixed** (transitive). |
| `undici` | Server | HTTP client inside `jsdom` (behind the sanitizer) and `mjml`. Proxy and cookie-parsing bugs; neither makes proxied requests. | **Fixed** (transitive). |
| `svgo`, `js-yaml` | Server | Inside `mjml`, which builds marketing emails. `svgo`'s script-stripping gaps and `js-yaml`'s slow parsing are not on a path that takes outside input: templates are written by club staff and compiled with minification off. | **Fixed** (transitive). |
| `@xmldom/xmldom` | Tooling | From `@capacitor/cli`; parses the native projects' own config files. | **Fixed** (transitive). |
| `nanoid`, `source-map-js`, `browserslist`, `brace-expansion` | Tooling (build) | Build-time helpers under Next, PostCSS, Tailwind, mjml and ESLint. They process our own source and config. | **Fixed** (transitive). |
| `playwright` | Tooling | Browser downloads were not certificate-checked. Used only for the local crash sweep, which drives the installed Chrome and downloads nothing. | **Fixed: 1.65.1.** |
| `shadcn`, `@modelcontextprotocol/sdk`, `body-parser`, `fast-uri`, `ip-address`, `systeminformation` | Tooling | All inside the `shadcn` CLI. | **Fixed** (`shadcn` 4.23.0). |
| `nodemailer` | Server | See decision 2. | **Not fixed — needs a major version.** |
| `zod` | Server, Browser | See decision 3. | **Not fixed — needs a major version.** |
| `postcss` (the copy inside `next`) | Tooling (build) | Next bundles its own PostCSS 8.4.31. It only ever compiles this repo's own CSS at build time. The app's own PostCSS is current (8.5.33). | **Not fixable without Next 15+. Accepted.** |

`next-auth` still shows as *high* after the update. That is not a next-auth
bug: npm marks it because it declares `nodemailer` as an optional companion,
and `nodemailer` is flagged. It clears when decision 2 is made.

## Checked and not flagged

`stripe` 14.25.0, `@prisma/client` 5.7.0, `jose` (inside next-auth), `plaid`,
`resend`, `bcryptjs`, `jspdf`, `exceljs` itself, and every Capacitor plugin
(`app`, `barcode-scanner`, `browser`, `haptics`, `keyboard`, `network`,
`preferences`, `push-notifications`, `share`, `splash-screen`, `status-bar`)
have no critical or high advisory. They were left on their current versions.

## The mobile app — a step that is yours

`package.json` now asks for Capacitor 8.6.2, but the **iOS project still pins
8.3.4** (`ios/App/CapApp-SPM/Package.swift`, a file `cap sync` writes), and no
installed app changes until a new build is released. To actually close the
Capacitor advisory:

1. `npm run cap:sync` — rewrites the native projects for 8.6.2.
2. Build and test in Xcode and Android Studio.
3. Submit both to the stores.

I did not run `cap sync`: it rewrites native project files I cannot build or
test from here, and a store release is your call. Until then the critical
Capacitor advisory is **open for everyone with the app installed**. The app's
shell already limits navigation to our own host and allows no cleartext or
mixed content (`capacitor.config.ts`), which narrows it; it does not close it.

## Needs your decision (major upgrades — not done)

### 1. Next.js 14 → 15 — recommended, as its own phase

- **Risk of staying:** the App Router denial-of-service advisories apply. On
  Netlify each request runs in its own short-lived function, so a crafted
  request costs an invocation rather than taking the site down, and nothing
  found is a data-exposure path given how this app is built. The larger risk
  is the direction: 14.2.35 is the end of the line, every future Next
  advisory will land here unpatched, and the next one may not be mitigated by
  how we happen to be hosted.
- **Effort:** about a week including regression. Next 15's App Router needs
  React 19. Route handlers and pages take `params` as a Promise (about 235 of the 477
  route files; there is a codemod, and several routes are already written
  that way). `fetch` and GET handlers stop caching by default — good for this
  app, but every screen needs a look. next-auth 4 runs on Next 15. Tiptap,
  react-plaid-link and jspdf each need a check against React 19.
- **Recommendation:** do it next, alone on a branch, with the crash sweep and
  the 150 build checks as the gate. Go to the latest 15.5.x, not 16: 16
  renames middleware and is a second set of changes on top.

### 2. nodemailer 7 → 10 — recommended, small

- **Risk of staying:** most of the 20 advisories need options this app never
  passes (`raw`, `envelope`, `list` headers, OAuth2, DKIM, JSON transport —
  `lib/email.ts` uses none). What does apply is how addresses are parsed: a
  crafted recipient string can make parsing slow, or be read as a different
  address. Addresses reach the mailer from member and guardian records, which
  are format-checked on entry; imported rows are the weakest link. In
  production email goes through Resend first, and nodemailer is the fallback.
- **Effort:** half a day. One file uses it, through one call.
- **Recommendation:** yes, as a small separate change, with a real send
  tested against a throwaway inbox — which is why it is not in this one.

### 3. zod 3 → 4 — not now

- **Risk of staying:** one advisory — memory use when validating a very large
  array or string that has a size limit. Netlify caps a request body at 6 MB,
  which bounds it.
- **Effort:** large. 267 files import zod, and version 4 changes error shapes
  that `lib/zodErrors.ts` turns into the messages people read.
- **Recommendation:** leave it. Revisit with or after the Next upgrade.

### 4. Prisma 5.7 → 6+ — no security reason today

Not flagged. Pinned on purpose. Nothing to decide for security.

## Accepted (moderate, 41 — all three causes need a major version of their parent)

| Cause | Packages it flags | Reaches | Why accepted |
|---|---|---|---|
| `glob` / `minimatch` slow or over-broad pattern matching | `mjml` and its 30 component packages, `mjml-cli`, `js-beautify`, `editorconfig`, the Sentry build plugins, `ts-morph` (inside `shadcn`) | Tooling, and `mjml` on the Server | The patterns are file globs written by the libraries themselves. Nothing a visitor sends becomes a glob. npm's suggested "fix" is a *downgrade* of mjml to 4.x. |
| `uuid` missing bounds check when writing into a caller's buffer | `exceljs` | Server | exceljs calls it without a buffer. The suggested fix is a downgrade to exceljs 3. |
| The `next` advisories rated moderate | `next`, `@sentry/nextjs` (it depends on `next`) | Server | Decision 1. |

## What changed

| | From | To | Kind |
|---|---|---|---|
| `@auth/prisma-adapter` | 1.6.0 | removed | unused |
| `next-auth` | 4.24.14 | 4.24.15 | patch |
| `@capacitor/core`, `ios`, `android`, `cli` | 8.3.4 | 8.6.2 | minor |
| `@sentry/nextjs` | 10.54.0 | 10.78.0 | minor |
| `@tiptap/*` (7 packages) | 3.29.2 | 3.34.0 | minor |
| `mjml` | 5.4.0 | 5.4.1 | patch |
| `playwright` (dev) | 1.49.1 | 1.65.1 | minor |
| `shadcn` (dev) | 4.11.0 | 4.23.0 | minor |
| `tsx` (dev) | 4.21.0 | 4.23.15 | minor |
| `postcss` (dev) | 8.5.25 | 8.5.33 | patch |
| transitive packages | | | via `npm audit fix` (no `--force`) |

No application code needed changing for any of these.

## Verified

- `tsc --noEmit`, `node scripts/run-build-tests.mjs`, `npm run build`: pass.
- **Crash sweep re-run on the updated packages** (the one from
  `docs/CRASH-AUDIT-2026-11-18.md`): 69 pages at desktop size and 69 at phone
  size, 49 and 51 sheets opened and probed. **Nothing new.** The only
  findings are the same two at each size as before the updates: "Connect
  Stripe" answers 500 because the local server has no Stripe key, by design —
  the code stops before any request leaves the machine.
- The sweep ran only through `scripts/dev-local.sh built`. Checked before
  starting and again after: database addresses local, Stripe / Plaid / email /
  push / storage blank, the server listening on 127.0.0.1 only, and no
  connection open to anything outside this machine.
