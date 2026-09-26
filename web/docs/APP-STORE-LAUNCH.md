# Getting AthletixOS into the App Store and Google Play

One app, **AthletixOS** (`com.athletixos.app`), for every club. It is the website
in a native shell (Capacitor), so every web deploy updates the app instantly —
store updates are only needed for native changes (icons, permissions, plugins).

## What's already done in code (2026-09-25)

- iOS + Android projects, app icon (1024), splash, Apple team `J5TSB958YP`.
- **QR codes open the app.** Universal Links / App Links for `athletix-os.com`:
  `/c/*` (door QR), `/member/*`, `/e/*`, `/p/*`, `/join/*`, `/r/*`.
  Served at `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json`
  (`lib/appLinks.ts`). Without the app, the same QR opens the website, which shows
  App Store / Google Play badges once the listings exist.
- Stripe returns (`/member/checkin/...?paid=1`) come back into the app.
- Camera / photo-library permission text (iOS kills the app on a file upload without them),
  export-compliance answer, arm64.
- Account deletion in the portal (Apple requires it for apps with sign-up).

## Decide first: individual or company account

Publishing as **MC Technologies Group LLC** needs a free **D-U-N-S number** for the LLC
(dnb.com, ~1–2 weeks). Worth it:
- The store shows the company, not your personal name.
- **Google: new *personal* accounts must run a closed test with 12+ testers for 14 days**
  before they can publish. Organization accounts skip that.

## Apple (App Store)

1. developer.apple.com → confirm the Apple Developer Program ($99/yr) is active for team `J5TSB958YP`.
2. App Store Connect → Apps → **+ New App**: iOS, name "AthletixOS", bundle `com.athletixos.app`, SKU `athletixos`.
3. Build: in `web/`
   ```
   CAPACITOR_SERVER_URL=https://athletix-os.com npm run cap:sync
   npm run cap:ios
   ```
   Xcode → select "Any iOS Device" → **Product → Archive** → Distribute App → App Store Connect.
   (Xcode's automatic signing turns on Associated Domains from `App.entitlements`.)
4. TestFlight → install on your phone → scan a door QR → it should open the app on check-in.
5. Listing: screenshots (6.9" iPhone; iPad 13" too unless we drop iPad), description, keywords,
   support URL, privacy policy `https://athletix-os.com/privacy`, age rating, App Privacy
   answers (name, email, phone, purchases via Stripe, no tracking), and a **demo login**
   for the reviewer (a test member account at Frog Empire).
6. Submit for review.

**Review risk to know about:** Apple sometimes rejects "a website in an app" (guideline 4.2).
UPDATE 2026-09-26: the staff dashboard audit (§6) found the current build is the shape 4.2 rejects —
remote `server.url`, one plugin, no native capabilities (photo upload is a web file input, not native).
Do not submit until backlog **B22** is done; the native QR scanner is the first feature to build.

## Google (Play)

1. play.google.com/console → developer account ($25 once).
2. Create app → "AthletixOS", app, free.
3. Build: `CAPACITOR_SERVER_URL=https://athletix-os.com npm run cap:sync` → `npm run cap:android`
   → Android Studio → **Build → Generate Signed App Bundle** → create an upload key
   (**back up the .jks file and passwords — losing them locks you out of updates**).
4. Upload the `.aab` to **Internal testing** first; add yourself as a tester.
5. **Setup → App integrity → App signing** → copy the **SHA-256 certificate fingerprint**
   → Netlify env `ANDROID_APP_SHA256` (then redeploy). That makes QR codes open the app on Android.
6. Store listing, Data safety form, content rating, **Target audience: 18+** (parents manage
   the accounts; choosing under-13 pulls the app into Google's Families program).
7. Promote to production (after the 14-day closed test if it's a personal account).

## After the listings are live — Netlify environment variables

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_IOS_APP_URL` | the App Store link |
| `NEXT_PUBLIC_ANDROID_APP_URL` | the Play Store link |
| `ANDROID_APP_SHA256` | Play App Signing SHA-256 (comma-separate if several) |

One redeploy after setting them turns on the store badges and Android app links.
