# AthletixOS mobile app plan (2026-11-15)

Written after re-reading the store rules on 2026-11-15 and re-measuring the repo.
It replaces the slice order in `docs/MOBILE-APP-AUDIT-2026-10-18.md` §8.

Branch: `claude/athletixos-mobile-app`, cut from the tip of the speed-and-bug
branch (`claude/athletixos-perf-app-audit-d31643`). It is **not** cut from
`main`, on purpose: the app work depends on that branch's fixes (in-app
navigation, phone-height fixes, the staff-route guard). Merge the first branch
to `main` first; this one then merges cleanly on top.

## 1. In plain English

Today the app is a window onto the website. Apple rejects that shape, and it
has no answer for "what does the app do that Safari doesn't?".

The plan keeps the website as the single source of screens (so every web
improvement still reaches the app the same day) and makes the app a real app
around it:

- **Things only an app can do**, compiled into the app itself: a camera QR
  scanner for door check-in, push notifications, the share sheet, haptics, a
  proper launch screen, the Android back button, and an offline screen that
  still shows your last-known schedule.
- **Nothing that looks like a browser**: no web address in pop-ups, no full-page
  reloads, no "Loading…" text, correct screen heights, links that open inside
  the app.
- **The store paperwork**: account deletion for every kind of account, the
  privacy policy inside the app, plain permission wording, demo logins, review
  notes, and the privacy/data-safety answers.

## 2. What the rules say (read 2026-11-15)

Apple's App Review Guidelines page states "Last Updated: October 16, 2026".
Google's pages were read the same day. Quotes are short on purpose.

| Rule | What it says | What we do |
|---|---|---|
| Apple 4.2 | "features, content, and UI that elevate it beyond a repackaged website" | Slices 2, 3, 5: scanner, push, share, haptics, offline, native navigation |
| Apple 2.5.2 | may not "download, install, or execute code which introduces or changes features or functionality of the app" | §3 below |
| Apple 3.1.3(e) | goods and services "consumed outside of the app" **must** use a non-IAP method | Memberships, classes, events and lessons happen in a gym. Stripe is correct. |
| Apple 3.1.3(d) | "One-to-few and one-to-many real-time services must use in-app purchase" | This is about services delivered **through the app** (live video classes). We sell none. Review notes say so. **Never add paid live-streamed classes or paid in-app content without revisiting this.** |
| Apple 3.1.1 | no own mechanism "to unlock content or functionality" in the app | See §4: one thing to keep out of the iOS app |
| Apple 5.1.1(v) | "If your app supports account creation, you must also offer account deletion within the app" | Slice 1: members, parents, staff and owners |
| Apple 5.1.1(i) | privacy policy link "within the app" | Slice 1 |
| Apple 4.5.4 | push "must not be required for the app to function"; no "sensitive personal or confidential information" | Slice 5 rules |
| Apple 4.8 | only when a third-party or social login is used | Email + password only today. **Decided 2026-11-17: add Google and Apple together** (§10), Apple as an equal option. |
| Apple 2.1(a) | demo account, back end live during review | Packet |
| Apple 2.3.3 | screenshots "show the app in use", not a login page | Packet |
| Apple 4.2.6 | template apps must be submitted by the content provider; one app hosting many clients is an accepted model | One AthletixOS app with clubs inside. Nothing here blocks per-club apps later (§7). |
| Apple 5.1.4 / 2.3.8 | no "For Kids" wording; minors' data needs a privacy policy and child-privacy compliance | Listing wording; consent flow unchanged |
| Google target API | from Aug 31, 2026 new apps and updates "must target Android 16 (API level 36)" | Already `targetSdkVersion = 36`, `compileSdkVersion = 36`. Verified in `android/variables.gradle`. |
| Google account deletion | "an in-app path" **and** a web link that "loads without error" and names the app or developer | Slice 1: `/delete-account` |
| Google Payments §3 | Play Billing "must not be used" for "physical services (such as ... gym memberships ... tickets for live events)" | Stripe is correct |
| Google Data safety | data from "a webview" counts when "your app is in control" of it; data a payment processor collects directly need not be declared | Packet answers |
| Google target audience | 18+ option = "Restrict Minor Access": under-18 accounts cannot find or download the app | **Decided 2026-11-16: 13 and over** (§6.5). |
| Google sign-in details | credentials "accessible at all times, reusable", in English | Packet |

Not confirmed from the pages I could read: Google's 16 KB page-size rule and
edge-to-edge enforcement. Capacitor 8 with API 36 handles both in my
understanding, but I will check the Play Console pre-launch report rather than
assert it.

## 3. Architecture, and the case for it

**Choice: a bundled native shell plus first-party web content from our own
server, with every device capability compiled into the app.**

The alternatives:

| Option | Verdict |
|---|---|
| Keep `server.url` as it is (remote only) | Rejected. No offline behaviour, nothing native, the 4.2 shape. |
| Bundle the whole web app in the binary (static export) | Not possible without rewriting the product: 462 server routes, server-side sessions, middleware, per-request rendering. It would also mean a store review for every bug fix. |
| **Hybrid shell (chosen)** | The binary ships real local code: launch screen, connectivity check, offline screen with the cached schedule, and all native plugins. Screens come from `https://athletix-os.com`, in the app's own web view, locked to our domain. |

**Against 2.5.2.** The rule is about code that changes what the app *is*. What
we download is our own HTML and JavaScript, run by WebKit, which is the
mechanism Apple names for web content (2.5.6: apps that browse the web "must
use the appropriate WebKit framework"). The app's purpose (run your club
membership: schedule, check-in, booking, messages, billing) is fixed in the
binary and in the listing. Every native capability is compiled in, declared in
the permission strings, and reviewed; a web deploy cannot add one. We never
download native code and never change the app's purpose from the server.
The Apple Developer Program License Agreement has matching language on
interpreted code (as I recall it, §3.3.1(B): allowed so long as it does not
change the app's primary purpose, create a store for other code, or bypass OS
security). **I have not re-read the agreement today; check that clause in your
developer account before relying on my wording.** The review notes describe
this arrangement openly rather than hoping it is not noticed.

**Against 4.2.** A reviewer who opens the app sees: a native launch screen, a
camera scanner that checks you into a class at the door, a system permission
prompt for notifications tied to a clear benefit, the system share sheet on an
event, haptic feedback on check-in, a working offline screen in Airplane Mode,
and no browser chrome or web-address pop-ups anywhere.

**Release hardening** (all in `capacitor.config.ts`, switched on automatically
for an HTTPS build): logging off, cleartext off, Android mixed content off,
navigation limited to `athletix-os.com` plus the three Stripe-hosted pages we
send people to (Checkout, the billing portal, Connect onboarding). Those stay
**inside** the app's web view on purpose: sent out to Safari, the "you paid"
page would open in the browser and the app would never hear about it.

## 4. One thing to keep out of the iOS app: AthletixOS's own subscription

Club owners pay AthletixOS for Pro and Enterprise. Inside the app that is a
purchase that unlocks app features, which is exactly what Apple 3.1.1 and
Google Payments §2 reserve for their own billing. Families paying a club is
fine; **owners upgrading AthletixOS inside the app is not.**

Plan: in the native app, the plan/upgrade screens show the current plan and
"Manage your plan at athletix-os.com on a computer", with no price, no button
and no link (Apple also forbids steering). On the web nothing changes. This is
in slice 3.

## 5. Slices

Each slice leaves the web product and the app shippable. "Migration" means a
hand-written, additive SQL folder that you run after a backup.

| # | Slice | What you get | Migration | Needs from you |
|---|---|---|---|---|
| 1 | **Store-policy basics** | Staff and owner account deletion; a public `/delete-account` page for Google; privacy policy and terms links inside the member portal and the dashboard; what happens to minors and billing records, in writing | No | The decisions in §6 |
| 2 | **Native shell** | Official plugins (app, status bar, splash, keyboard, haptics, network, share, preferences, barcode scanner); release hardening in one tested module; Android back button; offline screen with the last-known schedule; a web-to-native bridge that needs no library in the website | No | Nothing |
| 3 | **QR scanner + "feels native" sweep** | Camera scanner for door check-in (member) and for the front desk (staff); the 78 browser dialogs replaced by in-app confirm sheets and toasts, with a build guard; AthletixOS plan screens hidden in the app (§4); text under 12 px raised; remaining stuck-spinner screens get Retry | No | Nothing |
| 4 | **Review build** | TestFlight and Play internal testing builds; demo club with fictional data; screenshots; `docs/STORE-SUBMISSION-PACKET.md` | No | Apple and Google accounts (§8) |
| 5 | **Push notifications** | Device registration, an in-app pre-prompt, per-person settings, first four notices | **Yes**: `device_tokens`, `notification_preferences` | APNs key and Firebase project (§8) |
| 6 | **Submit** | Store listings, privacy answers, submission | No | You press Submit |
| 7 | Later: per-club branded apps | Build pipeline per club under the club's own accounts | Small | Each club's own Apple and Google accounts |

Order changed from the October audit: store-policy basics come first because
they are pure web work, they are required by both stores, and Google's web
deletion link has to be live before a listing can be filled in. Push moved
after the review build because it needs keys only your new accounts can issue,
and 4.2 is already answered by the scanner, offline mode and native navigation.
Submitting without push is safe; adding it is then a normal update.

### Push rules (slice 5), fixed now so nothing built earlier contradicts them

- Never required. The app works fully with notifications off.
- Asked for at a moment that explains itself ("Get told when a class you booked
  is cancelled?"), with our own screen first and the system prompt second.
- **No amounts, no health information, no child's name or details** in the
  notification text. "A class on your schedule changed" and "A payment needs
  your attention", then the detail inside the app after sign-in.
- First four: class cancelled or moved, payment needs attention, new message,
  event reminder. Marketing notices are a separate opt-in, off by default.
- Each device token records which app it came from, so per-club apps later can
  have their own push credentials.

## 6. Decisions I need from you

1. **What deleting a parent account does to their children.** My proposal: a
   child's record belongs to the club and the family, not to one login. If
   another confirmed guardian exists, the children stay and that guardian
   carries on. If the deleted parent was the only guardian, the children's
   records stay with the club (attendance, signed waivers) but lose portal
   access, and the club is told so it can re-invite a guardian. A parent who
   wants the children's data removed too can ask in the same screen; that goes
   to the club as a request, because the club is the record holder.
2. **What is kept.** Payment records, invoices, signed documents and
   attendance are kept as the law and the club's bookkeeping require; the
   deletion screen says so in plain words before the person confirms. The
   login, password, device tokens, message drafts and profile photo are
   removed. Names on kept financial records stay (a receipt with no name is
   not a receipt).
3. **An active card-billed membership.** Proposal: deletion is refused with
   "Cancel your membership first" and a link to the cancellation request,
   because deleting the login would otherwise leave a card being charged with
   no way to see it. Both stores allow a clearly explained step like this.
4. **The last owner of a club.** Proposal: an owner cannot delete their own
   account while they are the only owner; they must add another owner or
   close the club (that screen already exists).
5. **Google target audience. DECIDED 2026-11-16: 13 and over.** "18 and over"
   would have hidden the app from a 16-year-old athlete who logs in for
   themselves. Under-13s are not a target audience: they are managed from a
   parent's account. COPPA applies under 13 either way and the consent flow
   is unchanged. Apple has no equivalent switch; its age-rating questionnaire
   decides.
6. **The signup email check** from the audit (S2). **DECIDED and built
   2026-11-16:** verify the email first.

## 7. Not blocking per-club apps later

- App id, name, start URL, colours and allowed domains come from one config
  module, not from strings scattered in native files.
- Device tokens carry the app id they were issued to.
- App Links files (`lib/appLinks.ts`) already build from a list.
- Nothing in the web bridge assumes the app is called AthletixOS.

## 8. What I need from the Apple and Google accounts, and when

| When | What | Why |
|---|---|---|
| Slice 4 | Apple Developer Program active on team `J5TSB958YP` as an organization; you signed in to Xcode with it | Archive and upload |
| Slice 4 | App Store Connect: app record "AthletixOS", bundle `com.athletixos.app`, SKU `athletixos` | TestFlight |
| Slice 4 | Google Play Console organization account; app "AthletixOS" created | Internal testing |
| Slice 4 | An Android upload key you create and back up (I give the command; never send it to me) | Signing |
| Slice 4 | From Play Console → App integrity: the SHA-256 fingerprint, set as `ANDROID_APP_SHA256` in Netlify | QR links open the Android app |
| Slice 5 | Apple: an APNs Auth Key (`.p8`), its Key ID and your Team ID, set as Netlify variables | Sending push to iPhones |
| Slice 5 | Google: a Firebase project with the Android app added; `google-services.json` placed in `android/app/` and a service-account key set in Netlify | Sending push to Android |
| Slice 6 | A support email and a support page address | Both listings require one |

## 9. How each slice is verified

- `npx tsc --noEmit`, `node scripts/run-build-tests.mjs`, `npm run build`.
- New guards: no browser dialogs; staff routes refuse member logins (exists);
  speed guard (exists); a native-config test that fails if a release build
  would ship debug logging, cleartext, mixed content or an open navigation
  list.
- iOS Simulator and Android emulator runs for anything touching the shell.
  Camera scanning and push cannot be proven on a simulator; those need your
  phone, with exact steps in each report.

## 10. Sign in with Google and Sign in with Apple (built 2026-11-18; switched off until the keys are set)

Status: built. Table applied. Not tried against real Google or Apple, or on a
phone. Email and password stays, unchanged, next to both buttons.

Where it lives: rules `lib/socialAuth.ts` (pure), token checks
`lib/socialJwt.ts`, provider calls and session `lib/socialAuthServer.ts`,
routes `app/api/auth/social/*` (start, callback, redeem, pending, link,
providers) and `app/api/account/sign-in-methods`, pages `/login` (buttons),
`/login/social` (which account?), `/member/signup?social=1` (create without
a password), My account → Sign-in methods. Tests: `scripts/social-auth-tests.ts`.

Built differently from the design, and why:
- A Google/Apple-only account adds a password by the emailed reset link, not
  from My account with just a session: a stolen session could otherwise add a
  permanent way in.
- The app's return address is `com.athletixos.app://auth/social` (registered
  in Info.plist and the Android manifest). iPhone may show "Open in
  AthletixOS?" when the sheet hands back; check on a device.

### Rules re-read 2026-11-17

- Apple App Review Guidelines, still "Last Updated: October 16, 2026". 4.8: an
  app that uses a third-party login must also offer one that "limits data
  collection to the user's name and email address", lets people keep their
  email private, and does not track for advertising without consent. Sign in
  with Apple is that option; both buttons get the same size and position.
- Google OAuth 2.0 Policies, "Last modified: August 5, 2026": a developer
  "must not direct a Google OAuth 2.0 authorization request to an embedded
  user-agent". Google's native-app page says a WKWebView request fails with
  `disallowed_useragent`, that "SFSafariViewController" is a supported option,
  and that custom URI schemes are no longer supported as Google redirect
  addresses.
- **Could not load:** Apple's "Token revocation" and "Configuring your
  environment for Sign in with Apple" pages returned a title only. The
  revocation endpoint and the Services ID steps below are from memory of those
  pages, not a fresh read. Check them in your developer account as you go.

### How it works

- **Website:** the button sends the browser to Google or Apple and back to
  `https://athletix-os.com/api/auth/social/callback/<google|apple>`. The server
  checks the provider's signed answer and signs the person in.
- **In the app:** the same flow, but opened in the system browser sheet
  (SFSafariViewController on iPhone, Custom Tabs on Android), never in the
  app's own web view. When it finishes, the sheet hands the app a one-time
  code that only the app that started the flow can redeem. This needs one new
  official plugin (`@capacitor/browser`) and a rebuild of both apps.
- A club is still chosen first (the club link field), because one email can
  have an account at more than one club.

### Linking rules (security)

1. A Google or Apple sign-in that was linked before signs straight in.
2. **Verified email, matching a member or parent account:** linked and signed
   in. The account's email is then treated as proven, and the same
   "after verification, do the linking" step the signup email check uses
   (`lib/emailLinkServer.completeEmailLinks`) connects the records the club
   has under that address. Nothing else makes those links.
3. **Email not verified by the provider:** never linked on a match.
4. **Apple "Hide My Email"** (a private relay address): it matches nothing, so
   no account is created silently. The person sees "Link to my existing
   account": sign in once with the password and Apple is connected; or, if new,
   create an account with a real email (which goes through the normal
   confirm-your-email step).
5. **Staff and owner accounts are never linked by an email match**, even a
   verified one. A staff member or owner signs in with their password and
   connects Google or Apple from My account. After that they can use it.
   (Decision: staff and owners MAY use Google and Apple. The extra step is
   because those accounts can see every family's data and move money, so a
   match on an address is not enough.)
6. One account can have several methods. My account lists them with Remove;
   the last remaining method cannot be removed.
7. Account deletion revokes the Apple token (Apple requires it) and deletes
   the linked sign-in rows.

"Approval by the club" for a hidden-email link was considered and left out:
"sign in once with your password" and "create an account with your real
email" cover every case, including a family that has a record but no login.

### What you create

**Google** (Google Cloud Console, a project owned by MC Technologies):
1. APIs & Services → OAuth consent screen: User type External; app name
   "AthletixOS"; support email `support@athletix-os.com`; authorized domain
   `athletix-os.com`; privacy policy and terms links; scopes `openid`,
   `email`, `profile` only (no verification review is needed for these).
   Publish it ("In production").
2. Credentials → Create OAuth client ID → **Web application**. Authorized
   redirect URI: `https://athletix-os.com/api/auth/social/callback/google`
   (add `http://127.0.0.1:3000/api/auth/social/callback/google` for local
   testing). Copy the client ID and secret.
3. **iOS and Android client IDs are not needed for this design.** The app uses
   the web client through the browser sheet. They are only needed if we later
   switch to Google's native SDKs.

**Apple** (developer.apple.com → Certificates, Identifiers & Profiles):
1. Identifiers → the App ID `com.athletixos.app` → tick **Sign in with
   Apple** → Save.
2. Identifiers → + → **Services IDs**: description "AthletixOS web sign-in",
   identifier `com.athletixos.app.signin`. Tick Sign in with Apple →
   Configure: primary App ID `com.athletixos.app`; Domains
   `athletix-os.com`; Return URL
   `https://athletix-os.com/api/auth/social/callback/apple`. (Apple accepts
   https only, so there is no local test address.)
3. Keys → + → name "AthletixOS Sign in with Apple", tick **Sign in with
   Apple**, primary App ID as above. Download the `.p8` once and note the Key
   ID. Keep the file in the password manager.
4. Services → Sign in with Apple for Email Communication: register
   `athletix-os.com` and the sending address (`noreply@athletix-os.com`), or
   email to hidden-address users will not be delivered.

**Netlify variables** (the names the code will read):

| Variable | Value |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | the Web client ID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | the Web client secret |
| `APPLE_SIGNIN_SERVICES_ID` | `com.athletixos.app.signin` |
| `APPLE_SIGNIN_KEY_ID` | the Key ID from step 3 |
| `APPLE_SIGNIN_PRIVATE_KEY` | the full contents of the `.p8` file |
| `APPLE_TEAM_ID` | `J5TSB958YP` (already the default in code) |

A button appears only when its variables are set, so the feature can ship
dark and be switched on by adding them. `FIELD_ENCRYPTION_KEY` (already set)
encrypts the Apple token kept for revocation.

## 11. Push notifications (built 2026-11-18; switched off until the keys are set)

Status: built. Tables applied. Never sent to a real phone. Rules `lib/push.ts`,
sending `lib/pushServer.ts`, client `lib/pushClient.ts` +
`components/PushRegistration.tsx`, switches `components/account/NotificationSettings.tsx`,
daily reminder `/api/cron/offline-membership-reminders` + Netlify function
`offline-membership-reminders-cron` (13:00 UTC, `CRON_SECRET`). Tests:
`scripts/push-tests.ts`. The reminder goes 1 to 3 days before the end date (a
missed run is caught the next day). Lock-screen text is the fixed wording in
the table below; names and dates appear only inside the app and in the
family's email.

### What is sent, and to whom

| Kind | Goes to | Text on the lock screen | Opens |
|---|---|---|---|
| Approvals | The owner, and each staff member whose permissions let them act on that kind of approval. Nobody else. | "Something is waiting for your approval." | Members → Approvals |
| Messages | The message's recipients, staff or family. | "You have a new message." | The conversation |
| Cash or check membership ending | Owner and staff with billing access | "A cash membership ends soon. Record payment or renew." | That member's billing |
| Same, to the family | The paying family, by push and by email | "Your membership needs a payment to continue." | Their membership |

The wording you asked for names the athlete and the date ("<Athlete>'s cash
membership ends <date>"). The standing rule in this plan, and your rule for
this work, is no minors' details in the push text. Most athletes are minors,
so **the name and date show inside the app after the tap, not on the lock
screen.** Say if you want the name on the lock screen for adult athletes only.

- Cash/check reminder timing: the same lead time as the existing pay-reminders
  job if it fits; otherwise 3 days before the membership ends.
- Once per membership period: `notification_logs` has a unique key per
  membership, period end, person and channel.
- Never for comps (memberships marked free on purpose) or card-billed ones.
- "Who is on this plan / when does it end" is read from the subscription
  (`MemberSubscription`), never from a field on the member.

### Rules

- Push is never required. Everything works with it off.
- Every kind has its own on/off switch per person (My account → Notifications).
- No amounts, health information or minors' details in the text.
- Each device token records its app id and platform, so a per-club branded
  app can use its own credentials later.
- A token Apple or Google reports dead is switched off automatically.

### What you create

**Apple:** developer.apple.com → Keys → + → name "AthletixOS push", tick
**Apple Push Notifications service (APNs)**. Download the `.p8` once, note the
Key ID. (A separate key from the sign-in key keeps the two revocable apart.)
In Xcode: App target → Signing & Capabilities → + Capability → **Push
Notifications**.

**Google:** console.firebase.google.com → Add project "AthletixOS" → Add app →
Android, package `com.athletixos.app` → download `google-services.json` and
put it at `web/android/app/google-services.json`. Then Project settings →
Service accounts → Generate new private key (a JSON file).

**Netlify variables** (the names the code will read):

| Variable | Value |
|---|---|
| `APNS_KEY_ID` | the push key's Key ID |
| `APNS_PRIVATE_KEY` | the full contents of the push `.p8` |
| `APPLE_TEAM_ID` | `J5TSB958YP` |
| `APNS_BUNDLE_ID` | `com.athletixos.app` |
| `APNS_ENVIRONMENT` | `production` (TestFlight and App Store builds) |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | the full contents of the service-account JSON |

Never commit either `.p8` or the service-account JSON. `google-services.json`
is not a secret and is committed with the Android project.

