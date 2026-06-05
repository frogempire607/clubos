# Android verification & release guide

Companion to `docs/native-launch-checklist.md`. This doc covers everything Android-specific: how to run the AthletixOS native shell on an emulator or device, how to verify the WebView behavior matches what we ship on iOS, and how to set up a release keystore for Google Play uploads.

**Audience**: anyone who needs to test or build the Android shell. No prior Android experience assumed.

---

## 1. Current Android setup (read this first)

This is what's already in the repo as of `feat/cx-overhaul` merge (commit `2c22af9`):

| Setting              | Value                          | Where it lives                                       |
|----------------------|--------------------------------|------------------------------------------------------|
| App ID / package     | `com.athletixos.app`           | `android/app/build.gradle`                           |
| App name             | `AthletixOS`                   | `android/app/src/main/res/values/strings.xml`        |
| Capacitor version    | 8.x                            | `package.json` → `@capacitor/core`                   |
| Android Gradle Plugin| 8.13.0                         | `android/build.gradle`                               |
| compileSdk / target  | 36                             | `android/variables.gradle`                           |
| minSdk               | 24 (Android 7.0 Nougat)        | `android/variables.gradle`                           |
| Activity             | single `MainActivity`, portrait-locked, `singleTask` | `android/app/src/main/AndroidManifest.xml` |
| Permissions          | INTERNET only                  | `android/app/src/main/AndroidManifest.xml`           |
| Launcher icons       | adaptive (mipmap-anydpi-v26)   | `android/app/src/main/res/mipmap-*`                  |
| Server URL           | resolved at `cap sync` time    | `capacitor.config.ts` + `scripts/native-shell-config.mjs` |
| Release keystore     | **NONE — must be added before any Play upload** | n/a                                |

Dev-mode server URL fallback chain (set in `capacitor.config.ts`):
1. `CAPACITOR_SERVER_URL` env var (preferred for release/test builds)
2. `NEXT_PUBLIC_APP_URL`
3. `http://127.0.0.1:3000` (default for local emulator on the host machine)

⚠️ `NEXTAUTH_URL` is intentionally NOT in the chain — a malformed `.env` would otherwise poison the WebView start URL.

---

## 2. One-time host setup

You need this exactly once per developer machine.

### Required tools

1. **Android Studio (Hedgehog or newer)** — <https://developer.android.com/studio>
   - During setup, accept the SDK Platform 34/36 install and at least one Google Play system image (for the emulator).
2. **JDK 17** — Android Studio bundles its own JBR; the `JAVA_HOME` it sets is enough.
3. **Node + npm** — already required for the web app; same versions work for Capacitor.

### One-time path config

After installing Android Studio, add to your shell rc (`~/.zshrc` on macOS):

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"      # macOS default
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
```

Then `source ~/.zshrc` and verify:

```bash
adb --version       # Android Debug Bridge version 1.x
emulator -version   # Android emulator version 34.x
```

### Create an emulator (one time)

1. Open Android Studio → **More Actions** → **Virtual Device Manager**.
2. **Create Device** → pick **Pixel 7** (or any recent Pixel).
3. System image: **API 34 (Android 14)** with **Google Play** services. Download it if Studio prompts.
4. Name it something memorable (e.g. `Pixel7_API34`). Finish.

---

## 3. Local dev — run the shell on emulator

This is the day-to-day loop for testing changes against your local Next dev server.

```bash
# Terminal A — start the web app on 0.0.0.0:3000 (already configured in package.json)
npm run dev

# Terminal B — boot the emulator, then open Android Studio
emulator -avd Pixel7_API34 &
npm run cap:android
```

`cap:android` runs `node scripts/native-shell-config.mjs && cap sync && cap open android`. The script bakes the resolved server URL into `public/native-shell/server-config.js` before sync, then Android Studio opens with Gradle syncing automatically (first sync = 3-8 minutes, subsequent = seconds).

When Gradle is done:
1. Top toolbar → device picker shows `Pixel7_API34`. Select it.
2. Click the green **Run** ▶ button. Builds + installs + launches.

**Emulator → host networking note**: `127.0.0.1` from inside an Android emulator refers to the emulator itself, NOT your host. The emulator can reach the host's Next dev server via the special alias `10.0.2.2:3000`. If the WebView shows the "Reconnecting…" screen, set `CAPACITOR_SERVER_URL` before sync:

```bash
CAPACITOR_SERVER_URL=http://10.0.2.2:3000 npm run cap:android
```

(iOS Simulator does NOT have this constraint — it shares the host loopback, which is why `127.0.0.1` works there.)

---

## 4. Local dev — run on a physical Android device

Useful for verifying touch targets, WebView keyboard behavior, and real-world Stripe/Plaid hand-offs.

1. On the device: **Settings → About phone → tap Build number 7 times** to enable Developer Options.
2. **Settings → Developer options → enable USB debugging**.
3. Plug device into the Mac with a USB-C cable.
4. First connect prompts "Allow USB debugging from this computer?" on the device — accept.
5. Confirm with `adb devices` — should list the device ID.
6. Find your Mac's LAN IP: `ipconfig getifaddr en0` → e.g. `192.168.1.42`.
7. Make sure the device is on the same Wi-Fi network.
8. Build & run with the LAN URL baked in:

```bash
CAPACITOR_SERVER_URL=http://192.168.1.42:3000 npm run cap:android
```

In Android Studio, the device picker now shows your physical device — pick it and Run.

---

## 5. The 8-minute smoke test

Run this every time you touch member-portal code, auth, the native shell, or anything that mutates `capacitor.config.ts`. Same checklist used for iOS so behavior parity is enforced.

| # | Action                                                                                            | Pass criteria                                                                              |
|---|---------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------|
| 1 | Cold launch the app                                                                                | Lands on `/member` (NOT marketing `/`). No "Restricted port" or net errors in Logcat.       |
| 2 | Tap **Sign in to your club** → log in as OWNER                                                     | Lands on `/dashboard`. Avatar menu visible top-right.                                       |
| 3 | Avatar → **Sign out**                                                                              | Lands at `/login`.                                                                          |
| 4 | Sign back in with the same credentials                                                             | Lands at `/dashboard`. (Catches the re-login cookie regression from the 2026-05-29 session.) |
| 5 | Stop `npm run dev` briefly                                                                         | WebView shows the dark "Reconnecting…" screen with spinner. Does NOT show marketing `/`.    |
| 6 | Restart dev server                                                                                 | Auto-retries within ~8s, lands at `/member` → middleware sends signed-in owner to `/dashboard`. |
| 7 | Log in as a MEMBER                                                                                 | Lands on `/member` (light theme). Bottom nav: Home / Schedule / Bookings / Messages / More. |
| 8 | Tap each bottom-nav item                                                                           | Each page loads. Icons all render (no `?` / tofu boxes — P1.H sweep should hold).           |
| 9 | More sheet → tap **Sign out**                                                                      | Lands at `/login`.                                                                          |
| 10| As a parent: open `/member/messages` and tap a child thread                                        | Lime "For \<kid\>" pill renders in header (style-inline, Tailwind v4 JIT proof).            |
| 11| As a member: tap a membership on `/member/memberships`                                             | If owner has `trialEnabled`, lime "X-day free trial" pill shows.                            |
| 12| Open a paid event registration → tap Pay                                                           | Stripe Checkout opens in the in-app browser tab. Returning to the app lands back in `/member`. |

Logcat filter for the WebView: in Android Studio bottom panel **Logcat** → filter by package `com.athletixos.app` and search `Chromium` to see WebView console output.

---

## 6. Where to look when something breaks

| Symptom                                       | Most likely cause                                                                                                       |
|-----------------------------------------------|--------------------------------------------------------------------------------------------------------------------------|
| "Can't reach AthletixOS" / static error page  | Server URL is wrong. Emulator can't reach `127.0.0.1` — use `10.0.2.2`. Device needs your LAN IP.                       |
| Cold launch lands on marketing `/`            | Old bug — should not recur. If it does, check `public/native-shell/native-shell-error.html` retry URL.                  |
| Sign-out works, sign-in fails second time     | Cookie issue (the bug fixed in `bdc0365`). Verify `lib/auth.ts` cookie config still pins on `NODE_ENV` not `NEXTAUTH_URL`. |
| Icons show as `?` boxes                       | Unicode glyph reintroduced somewhere. Re-run the lucide audit from the P1.H session log.                                |
| Stripe Checkout opens but return doesn't work | Capacitor in-app-browser config. Look at how iOS handles `window.open` returns — should be identical.                   |
| Gradle sync fails after `cap sync`            | Run `cd android && ./gradlew clean && ./gradlew --refresh-dependencies` from a terminal, then re-open Android Studio.   |

---

## 7. Release keystore — required before any Play Store upload

The repo currently has **no keystore**. You CANNOT submit to Play without one. Once generated, every release build for the lifetime of the app must be signed with the same keystore — losing it means you can never publish an update to that listing.

### 7a. Generate the keystore (one time, ever)

```bash
# Generate a 25-year RSA 2048 keystore. Store it OUTSIDE the repo.
keytool -genkey -v \
  -keystore ~/keystores/athletixos-upload.jks \
  -alias athletixos-upload \
  -keyalg RSA -keysize 2048 \
  -validity 9125
```

Answer the prompts:
- **Password** — pick a strong one, store in 1Password.
- **First and last name** — `AthletixOS`
- **Organizational unit** — leave blank or `Engineering`
- **Organization** — `AthletixOS`
- **City, State, Country code** — your incorporation locale (e.g. `Austin`, `TX`, `US`)

When done you'll have `~/keystores/athletixos-upload.jks`.

⚠️ **Back this file up to two separate secure locations**. Losing it = permanent loss of update access to the Play Store listing for this app ID.

### 7b. Wire the keystore into Gradle

Create `android/keystore.properties` (DO NOT commit — see step 7c):

```properties
storeFile=/Users/<you>/keystores/athletixos-upload.jks
storePassword=<from-1password>
keyAlias=athletixos-upload
keyPassword=<from-1password>
```

Edit `android/app/build.gradle`. Add ABOVE the existing `android { ... }` block:

```groovy
def keystorePropertiesFile = rootProject.file("keystore.properties")
def keystoreProperties = new Properties()
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
}
```

INSIDE the `android { ... }` block, add a `signingConfigs` block and reference it from `buildTypes.release`:

```groovy
android {
    namespace = "com.athletixos.app"
    compileSdk = rootProject.ext.compileSdkVersion
    // ... existing defaultConfig stays the same ...

    signingConfigs {
        release {
            if (keystorePropertiesFile.exists()) {
                storeFile     file(keystoreProperties['storeFile'])
                storePassword keystoreProperties['storePassword']
                keyAlias      keystoreProperties['keyAlias']
                keyPassword   keystoreProperties['keyPassword']
            }
        }
    }
    buildTypes {
        release {
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro'
            signingConfig signingConfigs.release   // ← add this line
        }
    }
}
```

### 7c. Gitignore the secret

Append to `android/.gitignore`:

```
keystore.properties
*.jks
*.keystore
```

Verify nothing leaked:

```bash
git status android/
grep -r "storePassword\|keystore.properties" android/app/ ':(exclude)android/app/build.gradle'
```

### 7d. Build a signed release AAB (Play Store format)

```bash
# Ensure the web is built and synced first
CAPACITOR_SERVER_URL=https://app.athletix-os.com npm run cap:sync

cd android
./gradlew bundleRelease
```

Output: `android/app/build/outputs/bundle/release/app-release.aab` — this is what you upload to Play Console.

To test the same release build on a device first:

```bash
cd android
./gradlew assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
```

---

## 8. Play Console first-time setup

When you reach this step you'll also be doing the iOS App Store submission. See `docs/native-launch-checklist.md` for the cross-platform asset list (icons, screenshots, privacy policy URL, demo credentials, etc.). Android-specific items only:

1. **Create a Google Play Console account** — $25 one-time fee at <https://play.google.com/console/signup>.
2. **Create app** — name `AthletixOS`, default language English (US), App / Free.
3. **Declarations** — app is for sports clubs, contains no ads (currently true), targets 13+ (we collect youth data through guardian consent flows, so we are NOT a child-directed app under COPPA).
4. **Data safety form** — declare:
   - Personal info: name, email, phone (for member accounts)
   - Financial info: payment card processing handled by Stripe (we don't store cards)
   - App activity: in-app interactions
   - All encrypted in transit ✓ / users can request deletion ✓ (via Settings → Account)
5. **Content rating** — answer IARC questionnaire honestly; AthletixOS rates **Everyone**.
6. **Target audience** — 13+ (parents/guardians manage minor accounts).
7. **Upload the signed AAB** to Internal Testing track first. Add yourself + 2-3 trusted testers via opt-in URL. Validate the release build end-to-end before promoting to Production.
8. **Production rollout** — start at 20% staged rollout for the first 48h, monitor crashes in Play Console → Statistics → Vitals.

---

## 9. Routine maintenance

| When | What |
|---|---|
| Capacitor major version bump | Run `npx cap doctor` after upgrade; re-test §5 smoke. |
| Android Studio updates | Accept Gradle / AGP upgrade prompts in Studio's "Project Structure" dialog. Test build before commit. |
| `targetSdkVersion` bump (Play requires within 1y of latest API) | Edit `android/variables.gradle`, rebuild, retest §5. |
| New launcher icon source | Run `npx @capacitor/assets generate --android` (the iOS-side `cap sync` does NOT regenerate Android mipmaps — separate command). |
| Add native plugin (camera, push, etc.) | `npm i @capacitor/<plugin>` → `npx cap sync android` → declare any new permission in `AndroidManifest.xml`. |

---

## 10. What still isn't built (Android-side roadmap)

- **Push notifications** — would require Firebase Cloud Messaging (FCM) setup + `@capacitor/push-notifications` plugin + a backend send pipeline. Tracked in CLAUDE.md "Not Built Yet".
- **Per-club branded apps** — currently one AthletixOS shell. Separate per-club AAB submissions would need an automated build pipeline and a way to inject per-club brand assets at build time. Not started.
- **Deep linking** — `/e/<slug>` event registration URLs should open in the app when installed. Requires `<intent-filter>` config in `AndroidManifest.xml` + iOS Universal Links parity. Not started.
- **App Bundle splits** — already implicit with AAB. No action needed unless install size becomes a problem.

When any of these get prioritized, this doc should grow a section for them.
