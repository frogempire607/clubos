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
| Apple 4.8 | only when a third-party or social login is used | Email + password only. No action. **Adding Google login later requires Sign in with Apple.** |
| Apple 2.1(a) | demo account, back end live during review | Packet |
| Apple 2.3.3 | screenshots "show the app in use", not a login page | Packet |
| Apple 4.2.6 | template apps must be submitted by the content provider; one app hosting many clients is an accepted model | One AthletixOS app with clubs inside. Nothing here blocks per-club apps later (§7). |
| Apple 5.1.4 / 2.3.8 | no "For Kids" wording; minors' data needs a privacy policy and child-privacy compliance | Listing wording; consent flow unchanged |
| Google target API | from Aug 31, 2026 new apps and updates "must target Android 16 (API level 36)" | Already `targetSdkVersion = 36`, `compileSdkVersion = 36`. Verified in `android/variables.gradle`. |
| Google account deletion | "an in-app path" **and** a web link that "loads without error" and names the app or developer | Slice 1: `/delete-account` |
| Google Payments §3 | Play Billing "must not be used" for "physical services (such as ... gym memberships ... tickets for live events)" | Stripe is correct |
| Google Data safety | data from "a webview" counts when "your app is in control" of it; data a payment processor collects directly need not be declared | Packet answers |
| Google target audience | 18+ option = "Restrict Minor Access": under-18 accounts cannot find or download the app | **Decision for you, §6.** |
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
5. **Google target audience.** "18 and over" hides the app from anyone Google
   believes is under 18, including a 16-year-old athlete who logs in for
   themselves. Options: (a) 18+ as planned, and teen athletes use the website;
   (b) "13 and over", which keeps teens but means Google reviews the listing
   for child appeal more strictly. Minors have accounts today, so (b) matches
   the product. Apple has no equivalent switch; the age rating questionnaire
   decides. **My recommendation is (b)**, but this is a business and legal
   call (COPPA applies under 13 either way; under-13s are already
   parent-managed).
6. **The signup email check** from the audit (S2). It should be decided before
   submission: reviewers create accounts.

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
