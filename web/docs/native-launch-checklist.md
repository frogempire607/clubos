# AthletixOS Native Launch Checklist

This checklist covers the single AthletixOS iOS and Android app shell. Club-specific branding remains inside the app after login. Separate per-club App Store apps are future roadmap.

## Native Shell

- App name: AthletixOS
- iOS bundle ID: `com.athletixos.app`
- Android package ID: `com.athletixos.app`
- Capacitor server URL: set `CAPACITOR_SERVER_URL` to the production AthletixOS origin before syncing release builds.
- Local development URL: `http://localhost:3001`
- Start route: `/member`

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

Confirm `http://localhost:3001` loads in your desktop browser before continuing. The native shell loads this same URL.

**Terminal 2 — Capacitor / Xcode:**

```bash
cd web
npx cap sync ios        # regenerates ios/App/App/capacitor.config.json
npm run cap:ios         # opens Xcode on the AthletixOS workspace
```

In Xcode:

1. Pick a simulator from the device dropdown (iPhone 15 or similar).
2. Hit ▶ (Cmd+R). The simulator boots and the AthletixOS app launches.
3. The WebView should load `http://localhost:3001/member`. Unauthenticated visitors are redirected by middleware to `/login` — sign in with your dev member credentials and you'll land back on `/member`.

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Black screen on launch | App Transport Security blocking HTTP | `ios/App/App/Info.plist` already has `NSAllowsLocalNetworking`. Re-run `npx cap sync ios` and rebuild. |
| "Can't reach AthletixOS" page | Dev server not running, or wrong URL | Confirm `npm run dev` is up on port 3001. If you're on a real device, set `CAPACITOR_SERVER_URL=http://<mac-lan-ip>:3001` and re-sync. |
| Login loop in the WebView | `NEXTAUTH_URL` doesn't match the URL the WebView loads | Set `NEXTAUTH_URL=http://localhost:3001` in `web/.env` and restart the dev server. Cookies are scoped to that exact host. |
| Stale config after editing `capacitor.config.ts` | Capacitor caches the iOS bundle | `npx cap sync ios` regenerates `capacitor.config.json` inside the Xcode project. |
| Stripe Checkout opens but never returns | External browser, not the WebView | Use `https://` URLs in production. On localhost, just verify the webhook fires server-side; the WebView won't bounce back. |

### Reaching the dev server from a real iPhone

The simulator can hit `localhost` on your Mac because they share a kernel. A real iPhone on the same Wi-Fi cannot. Do this instead:

```bash
# 1. Find your Mac's LAN IP
ipconfig getifaddr en0          # e.g. 192.168.1.42

# 2. Re-sync with that IP
cd web
CAPACITOR_SERVER_URL="http://192.168.1.42:3001" npx cap sync ios
npm run cap:ios
```

Then pick your iPhone in Xcode's device picker (after enabling Developer Mode on the phone) and hit ▶.

## Local development — Android emulator

Same idea as iOS, with `cap:android` instead. The Android emulator can't talk to `localhost` directly — Capacitor's `server.androidScheme` defaults will use `http://10.0.2.2:3001` (the emulator's alias for the host machine). If you're hitting trouble, set `CAPACITOR_SERVER_URL=http://10.0.2.2:3001` and re-sync.

```bash
cd web
npm run dev                              # Terminal 1
CAPACITOR_SERVER_URL="http://10.0.2.2:3001" npx cap sync android  # Terminal 2
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
