# AthletixOS mobile app + branded app: readiness audit (2026-10-18)

Written at the end of the "get AthletixOS ready" session as the handoff for the
app-development session. Everything below was checked against the repo on
2026-10-18 (main @ 9e60ba1), not taken from older docs.

## 1. Bottom line

- **The web product is ready.** Members, billing, events, schedule, payroll,
  financials, and permissions are all built and in production. The phone app is
  only a shell around that website, so it gets every web feature as soon as it ships.
- **The phone app is NOT ready to submit to the App Store.** It is still the
  shape Apple rejects under Guideline 4.2 ("just a website in an app"). That is
  backlog item **B22**, and it has not been started.
- **The "branded app" is about half built.** Owners already have a full editor
  (`/dashboard/settings/branded-app`, Pro tier) and the member portal already
  paints itself in the club's colors and logo. What's missing is the machinery
  that turns that config into a club's *own* app on the App Store and Google Play.

## 2. The one decision to make first: what "branded app" means

| Option | What families see | What it takes | Store rules |
|---|---|---|---|
| **A. One AthletixOS app, branded inside** | They download "AthletixOS", sign in, and everything after that is Frog Empire's colors, logo and menu | Mostly built. Finish B22, then the branded login/splash | Allowed. One developer account (MC Technologies) |
| **B. Each club gets its own store app** ("Frog Empire" on the App Store) | They download "Frog Empire" and it opens straight into that club | A build pipeline that turns `brandedAppConfig` into a separate iOS/Android project per club: name, bundle ID, icons, splash, start URL, app links, push keys | **Apple 4.2.6:** apps built from a template service must be submitted **from the club's own Apple developer account** ($99/yr, its own D-U-N-S number). We build and upload with their App Store Connect access; we can't list 20 club apps under MC Technologies |

**Recommendation:** ship **A** first, because it gets AthletixOS into both stores.
Then build **B** as the Pro "Branded mobile app" feature, with Frog Empire as the
first club, under Frog Empire's own Apple and Google accounts. B reuses everything
from A (same web app, same native features), so none of the A work is wasted.

## 3. What already exists (verified)

- Capacitor 8 shell: `capacitor.config.ts`, plus `ios/` and `android/` committed.
  - App ID `com.athletixos.app`. Apple team `J5TSB958YP`.
  - Dev and prod switch scripts: `npm run cap:dev:sim | cap:dev:iphone | cap:dev:prod`.
- Universal Links / App Links for `athletix-os.com`:
  - Door QR codes (`/c/*`), `/member/*`, `/e/*`, `/p/*`, `/join/*`, `/r/*`.
  - Served by `lib/appLinks.ts`; `components/NativeDeepLinks.tsx` handles them in the app.
  - Associated Domains entitlement is set.
- Camera and photo-library permission text in the iOS Info.plist.
- Account deletion for **members** (`/member/profile`). Privacy page at `/privacy`, terms at `/terms`.
- Phone navigation (B26): one tab bar plus a "More" list. `components/Sheet.tsx` exists.
- Branded app config:
  - `Club.brandedAppConfig` holds appName, icon, theme and splash colors, bundle IDs,
    sign-in screen, button style, nav items, book-now, confirmation, and reviews.
  - Edited by the owner at `/dashboard/settings/branded-app` (1,027 lines).
  - API at `app/api/club/branded-app`. Gated to Pro/Enterprise by `lib/tier.ts` (`brandedApp`).
  - Applied at runtime in `app/member/layout.tsx`.
- Store how-to: `docs/APP-STORE-LAUNCH.md`, `docs/native-launch-checklist.md`, `docs/android-verification.md`.

## 4. Blockers to App Store / Play submission (Option A)

From B22, re-measured today:

### 4a. Configuration (no design needed)

1. **Remote `server.url`.** The app ships no web files. In Airplane Mode on first
   launch it shows "Can't reach AthletixOS". Bundle a real local shell (offline
   screen, splash, last-known schedule) and keep data on `/api`.
2. **Only one plugin** (`@capacitor/app`) and zero device features. This is the core of
   the 4.2 risk. See §5 for what to add.
3. `limitsNavigationsToAppBoundDomains: false`, and Android `allowMixedContent: true`.
   Both should be tightened for release builds.
4. The camera and photo permission text describes features nothing uses natively yet.
   The native QR scanner (§5) fixes that.
5. `loggingBehavior: "debug"` must be off in release builds.

### 4b. Things that make it feel like a website (Apple reviewers look for these)

| Item | Count today |
|---|---|
| `confirm()` / `alert()` browser dialogs (titled with the web address in the app) | **66** |
| `window.location.href =` full-page reloads (should be `router.push`) | **31** |
| `100vh` / `h-screen` (wrong height on phones; use `min-h-dvh`) | **36** |
| Bare "Loading…" pages (should be skeleton screens) | **52** files |
| Swipe-back / pull-to-refresh / swipe-to-dismiss sheets | none |
| Android hardware back button | not handled |
| Status bar, splash, and keyboard plugins | not installed |
| `/api/me` error briefly shows staff the full menu | should fail closed |

### 4c. Store-policy items

- **Account deletion for staff/owner logins.** Only members have it today.
  Apple requires deletion for every account type that can sign up.
- In-app link to the privacy policy from the profile/settings screen inside the app.
- A reviewer demo login (a test member at Frog Empire) plus App Review notes
  explaining the native features.
- App Privacy (Apple) and Data safety (Google) answers: name, email, phone,
  purchases through Stripe, no tracking.
- Google target audience **18+** (parents manage accounts), to stay out of the
  Families program. Make sure the parental-consent work stays consistent with that.
- Stripe payments are for real-world services (classes, events), so Apple
  in-app purchase is **not** required. Say so in the review notes.

## 5. Native features to add (these answer Guideline 4.2)

In priority order:

1. **Native QR scanner for door check-in.** The cheapest strong answer: door codes,
   app links and the camera permission text already exist.
2. **Push notifications.**
   - Nothing exists today: no device-token table, no APNs/FCM keys, no send code.
   - Natural first uses: class cancellations, coverage requests, payment failures,
     event reminders, new messages.
   - The Action Center already computes the queue, and the staff-coverage design
     already plans push as an owner-picked channel.
   - Needs a migration for a `device_tokens` table.
3. Haptics, status bar, splash and keyboard plugins.
4. Biometric unlock (Face ID) to reopen a saved session.
5. Native share sheet (event links, private registration links) and add-to-calendar.
6. Offline check-in queue (later).

## 6. Branded app (Option B): what's missing

1. **Build pipeline.**
   - A script (Fastlane or a Node generator) that reads one club's `brandedAppConfig` and writes:
     - App name, bundle ID, and package ID.
     - Icon sets at every size, plus the splash.
     - A start URL like `https://athletix-os.com/member?club=<slug>`, so the app opens
       straight to that club's login.
     - The signing team.
   - Then it builds the `.ipa` and `.aab`. Today one hard-coded `capacitor.config.ts` builds one app.
2. **App links for many apps on one domain.** The apple-app-site-association file and
   `assetlinks.json` must list every club app's ID (or each club uses its own domain).
   Otherwise a Frog Empire QR code opens the generic app.
3. **Push credentials per app.** Each club app needs its own APNs key or topic and its own
   FCM app, and device tokens must record which app they came from.
4. **Per-club web manifest.** `app/manifest.ts` is static "AthletixOS", so the
   add-to-home-screen app isn't branded. Make it read the club from the host or the `club=` parameter.
5. **Store listing per club.** Screenshots, description, privacy answers and a demo login,
   all under the club's own accounts.
6. **Owner-facing status.** The editor already collects the config. Add a status panel:
   "Waiting on your Apple account → building → in review → live", plus the
   store links shown to that club's families.
7. **Pricing/tier.** Already gated to Pro (`brandedApp: true` on Pro and Enterprise).
   Decide whether the club pays its own Apple $99 and Google $25 or you charge a setup fee.

## 7. Only Julian can do these (start early, they take weeks)

1. **D-U-N-S number for MC Technologies Group LLC** (free at dnb.com, about 1–2 weeks).
   Needed for an organization Apple account. It also skips Google's rule that new
   personal accounts run a 12-tester, 14-day closed test.
2. Confirm the Apple Developer Program ($99/yr) is active on team `J5TSB958YP`,
   and create the Google Play Console account ($25 once).
3. For Option B with Frog Empire: a **second D-U-N-S number and Apple/Google accounts
   for Frog Empire** (the LLC, not the Foundation, unless you want the Foundation listed).
4. A real test member account at Frog Empire for reviewers.
5. When the Android build exists: back up the upload key (.jks) and its passwords.
   Losing them means you can never update the app.
6. After the listings go live, set these Netlify variables:
   - `NEXT_PUBLIC_IOS_APP_URL`
   - `NEXT_PUBLIC_ANDROID_APP_URL`
   - `ANDROID_APP_SHA256`

## 8. Suggested order for the app-development session

| Slice | Content | Migration? |
|---|---|---|
| 1 | Config hardening (§4a 1, 3, 5): bundled offline shell, release-only tight navigation, debug logging off; status bar, splash, keyboard and haptics plugins; Android back button | No |
| 2 | Native QR scanner for door check-in (§5.1) | No |
| 3 | "Feels native" sweep (§4b): replace the 66 dialogs with ConfirmDialog + Undo toast and add a `no-native-dialogs` guard; `router.push` for the 31 reloads; `min-h-dvh`; skeletons; swipe-back and pull-to-refresh; move modals onto `Sheet.tsx` | No |
| 4 | Store-policy items (§4c): staff/owner account deletion, privacy link in the app, fail-closed `/api/me` | Maybe (deletion audit) |
| 5 | Push notifications (§5.2): device tokens, APNs/FCM, first four notification types, owner channel settings | **Yes**, additive |
| 6 | TestFlight + Play internal testing, demo login, screenshots, review notes → **submit Option A** | No |
| 7 | Option B pipeline (§6): per-club build generator, multi-app links, per-app push, branded manifest, owner status panel. Frog Empire first | Yes, small |

Keep to Julian's working rules:

- One branch per slice group, merged to main once (Netlify credits).
- Migrations are hand-written and additive; Julian runs them himself after a backup.
- Never ship automatically.
- Five-part report at the end of each branch.
- No wrestling-specific wording in the product (`test:sport-terms` guard).
- Nothing under 12px.

## 9. Housekeeping found during this audit

- `web/app/dashboard/layout.tsx` has an **uncommitted** change from the pricing-overhaul
  session: the fee-choice redirect now fires once per browser session instead of on every page.
  Commit or discard it before branching.
- `docs/APP-STORE-LAUNCH.md` and `docs/native-launch-checklist.md` still say
  `app.yourdomain.com` in places. The production origin is `https://athletix-os.com`.
- Sandbox-only test failures: the build gate shows 12 known crashes that only happen in
  Claude's test sandbox (they need a local test database). They are not product bugs,
  but a new session should know about them before trusting "81/93".
