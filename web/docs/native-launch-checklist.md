# AthletixOS Native Launch Checklist

This checklist covers the single AthletixOS iOS and Android app shell. Club-specific branding remains inside the app after login. Separate per-club App Store apps are future roadmap.

## Native Shell

- App name: AthletixOS
- iOS bundle ID: `com.athletixos.app`
- Android package ID: `com.athletixos.app`
- Capacitor server URL: set `CAPACITOR_SERVER_URL` to the production AthletixOS origin before syncing release builds.
- Local development URL: `http://127.0.0.1:3000` (default if no env override; see table below)
- Start route: `/member`

### Switching the native dev target (simulator ↔ real iPhone ↔ prod)

Three things have to stay in lockstep for native login to work:

1. **WebView URL** baked into `ios/App/App/capacitor.config.json` by `cap:sync`. This is what the iPhone actually loads.
2. **`NEXTAUTH_URL`** read by the Next dev server. Determines the host that server-side absolute URLs use (Stripe redirects, password-reset links, partner-invite emails, NextAuth's CSRF check).
3. **`window.NATIVE_SERVER_URL`** baked into `public/native-shell/server-config.js`. The reconnecting/offline page retries against this URL.

If those three don't match, the WebView loads (say) `10.0.0.45:3000`, but a server route generates a redirect to `127.0.0.1:3000`. The iPhone WebView can't reach 127.0.0.1, Capacitor bounces the nav to Safari, and Safari shows WebKit's "Not allowed to use restricted network port" page on `0.0.0.0` (a common Next-dev self-URL leak from the `-H 0.0.0.0` bind).

One command keeps them aligned:

| Target | Command | Result |
|---|---|---|
| **iOS Simulator** | `npm run cap:dev:sim` | All three set to `http://127.0.0.1:3000`. |
| **Real iPhone on same Wi-Fi** | `npm run cap:dev:iphone -- <mac-lan-ip>` | All three set to `http://<mac-lan-ip>:3000`. Example: `npm run cap:dev:iphone -- 10.0.0.45`. |
| **Production** | `npm run cap:dev:prod -- https://app.yourdomain.com` | All three set to the HTTPS prod URL before archive/upload. |

After running the script you'll see a hint to **restart `npm run dev`** so the dev server picks up the new `NEXTAUTH_URL`. Skipping that step is the #1 cause of "the WebView loads but every redirect bounces to Safari."

Notes:
- The script writes `NEXTAUTH_URL` to `.env.local` (gitignored, surgical replace — leaves DATABASE_URL, STRIPE_*, SMTP_* etc. untouched). `.env` stays whatever it is.
- The script runs `cap:sync` for you with the right `CAPACITOR_SERVER_URL`, so both the WebView and the reconnect page line up.
- `lib/baseUrl.ts` rejects `0.0.0.0` (and `::`) as NEXTAUTH hostnames and falls back to `127.0.0.1:3000` with a console warning. Belt-and-braces against `NEXTAUTH_URL=http://0.0.0.0:3000` ever shipping to a device.
- `capacitor.config.ts` allows `0.0.0.0`, `0.0.0.0:3000`, plus `*` (only when `server.url` is cleartext http://, i.e. dev). Any stray absolute nav stays in the WebView where the error is visible, instead of escaping to Safari.
- ATS in `Info.plist` already allows local-network HTTP (`NSAllowsLocalNetworking`), which covers both `127.0.0.1` (simulator) and any RFC1918 LAN address (`10.x`, `172.16-31.x`, `192.168.x`). No per-IP exception needed.
- `localhost` is intentionally avoided in dev (`127.0.0.1` literal instead) because macOS resolves `localhost` to IPv6 `::1` first and Next.js dev binds IPv4 only — the WebView's connect fails silently and falls back to the reconnecting page. The literal IP bypasses DNS entirely.
- Dev port is `3000`. WebKit added `3001` to its restricted-network-ports blocklist so the simulator can't reach it. The `npm run dev` script binds `0.0.0.0:3000` so the LAN IP path works for real devices.
- The generated `ios/App/App/capacitor.config.json` and `public/native-shell/server-config.js` are both gitignored.

## Local development — iOS simulator

You only need this section to test the native shell on your own Mac.

### One-time setup

1. Install Xcode (App Store), open it once, and accept the license.
2. From Xcode → Settings → Platforms, download the **iOS Simulator runtime** for whatever iOS version you want to test.
3. Install CocoaPods if you don't have it: `brew install cocoapods`.
4. In `web/`, run `npm install` if you haven't already.

### Every-time workflow

Open **two terminals**:

**Terminal 1 — Next.js dev server:**

```bash
cd web
npm run dev
```

Confirm `http://127.0.0.1:3000` loads in your desktop browser before continuing. The native shell loads this same URL.

**Terminal 2 — Capacitor / Xcode:**

```bash
cd web
npx cap sync ios        # regenerates ios/App/App/capacitor.config.json
npm run cap:ios         # opens Xcode on the AthletixOS workspace
```

In Xcode:

1. Pick a simulator from the device dropdown (iPhone 15 or similar).
2. Hit ▶ (Cmd+R). The simulator boots and the AthletixOS app launches.
3. The WebView should load `http://127.0.0.1:3000/member`. Unauthenticated visitors are redirected by middleware to `/login` — sign in with your dev member credentials and you'll land back on `/member`.

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `ERROR: Unable to load /App.app/public//member` | Old config had `appStartPath: "/member"` which iOS interpreted as a local file path | Already fixed — server URL now bakes the path in (`http://127.0.0.1:3000/member`). If you still see it, run `npx cap sync ios` and **Product → Clean Build Folder** in Xcode (Shift+Cmd+K), then ▶. |
| Black screen on launch | App Transport Security blocking HTTP | `ios/App/App/Info.plist` already has `NSAllowsLocalNetworking`. Re-run `npx cap sync ios` and rebuild. |
| "Can't reach AthletixOS" page | Dev server not running, or wrong URL | Confirm `npm run dev` is up on port 3000. If you're on a real device, set `CAPACITOR_SERVER_URL=http://<mac-lan-ip>:3000` and re-sync. Also check the macOS firewall isn't blocking inbound 3000 (System Settings → Network → Firewall). |
| Login loop in the WebView | `NEXTAUTH_URL` doesn't match the URL the WebView loads | Set `NEXTAUTH_URL=http://127.0.0.1:3000` in `web/.env` and restart the dev server. Cookies are scoped to that exact host. |
| Stale config after editing `capacitor.config.ts` | Capacitor caches the iOS bundle | `npx cap sync ios` regenerates `capacitor.config.json`, then in Xcode use **Clean Build Folder** (Shift+Cmd+K) before ▶. |
| `UIScene` lifecycle warning | Capacitor 6 still uses the old AppDelegate launch path; harmless | No action — Apple is years out from making this an error. |
| Stripe Checkout opens but never returns | External browser, not the WebView | Use `https://` URLs in production. On localhost, just verify the webhook fires server-side; the WebView won't bounce back. |

### Reaching the dev server from a real iPhone

The simulator can hit `localhost` on your Mac because they share a kernel. A real iPhone on the same Wi-Fi cannot. Do this instead:

```bash
# 1. Find your Mac's LAN IP
ipconfig getifaddr en0          # e.g. 192.168.1.42

# 2. Re-sync with that IP
cd web
CAPACITOR_SERVER_URL="http://192.168.1.42:3000" npx cap sync ios
npm run cap:ios
```

Then pick your iPhone in Xcode's device picker (after enabling Developer Mode on the phone) and hit ▶.

## Local development — Android emulator

Same idea as iOS, with `cap:android` instead. The Android emulator can't talk to `localhost` directly — Capacitor's `server.androidScheme` defaults will use `http://10.0.2.2:3000` (the emulator's alias for the host machine). If you're hitting trouble, set `CAPACITOR_SERVER_URL=http://10.0.2.2:3000` and re-sync.

```bash
cd web
npm run dev                              # Terminal 1
CAPACITOR_SERVER_URL="http://10.0.2.2:3000" npx cap sync android  # Terminal 2
npm run cap:android                      # opens Android Studio
```

In Android Studio, pick an AVD (Pixel 6 or similar) and hit ▶.

## Production build

For App Store / Play Store builds, the WebView must load HTTPS. Before running `cap sync`:

```bash
# Production
CAPACITOR_SERVER_URL="https://app.yourdomain.com" npx cap sync
npm run cap:ios     # or cap:android
# then archive + upload from Xcode / Android Studio
```

With an HTTPS URL the ATS exceptions in Info.plist become no-ops and the build is store-compliant.

## Store Accounts

- Apple Developer Program account active.
- App Store Connect access confirmed.
- Google Play Console account active.
- Play Console developer profile and payments/tax forms completed if required.

## Required Store Metadata

- App icon, 1024 x 1024 PNG.
- iOS app icon set generated in Xcode asset catalog.
- Android adaptive icon foreground/background generated.
- Splash screen assets and background color approved.
- Privacy policy URL.
- Support URL.
- Marketing URL, optional.
- Demo login for App Review and Play review.
- App category: Sports, Health & Fitness, or Business depending on final positioning.
- Contact email monitored during review.

## Review Prep

- Production `NEXTAUTH_URL` and `CAPACITOR_SERVER_URL` use HTTPS.
- Stripe checkout return URLs are production URLs.
- Test member login works in the native shell.
- Parent/guardian profile switching works.
- Bookings, schedules, products, memberships, messages, announcements, and documents work.
- External checkout and billing links complete successfully and return to the app/web flow.
- PWA install path still works from mobile Safari and Chrome.
- Screenshots captured for iPhone, iPad if supported, Android phone, and Android tablet if supported.

## Current Scope

- Available now: member portal branding, PWA branding, and one native AthletixOS Capacitor shell.
- Future roadmap: separate per-club App Store apps, automated app submissions, deeper native push and store automation.
