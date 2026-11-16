# AthletixOS store submission packet

Written 2026-11-15 against the rules as read that day (Apple App Review
Guidelines "Last Updated: October 16, 2026"; Google Play help pages). Copy the
answers below into App Store Connect and Play Console. Anything marked
**YOU** needs a decision or an account only you have.

**Do not submit yet.** What is still open is in §9. The app builds and runs
today; the blockers are decisions and account setup, not code.

## 1. What the app is (use this wording everywhere)

- **Name:** AthletixOS
- **Subtitle (Apple, 30 characters max):** Your club, in your pocket
- **Bundle / package id:** `com.athletixos.app`
- **Publisher:** MC Technologies Group LLC
- **Category:** Apple: Sports (primary), Business (secondary). Google: Sports.
- **Price:** Free. No in-app purchases. No ads.

**Short description (Google, 80 characters max):**
Book classes, check in at the door and manage your club membership.

**Description (both stores):**

> AthletixOS is the app for members of sports clubs and training gyms that run
> on AthletixOS.
>
> Sign in with the account your club gave you to:
> - See your schedule and book classes, events and private lessons
> - Check in at the door by scanning the club's code with your camera
> - Manage your membership and see what you have paid
> - Message your coaches and read club announcements
> - Sign waivers and documents
> - Manage every athlete in your family from one account
>
> Coaches and club owners use the same app to take attendance, see the day's
> schedule and run the front desk.
>
> You need an account with a club that uses AthletixOS. Ask your club for its
> sign-up link.

**Wording rules (Apple 2.3.8, 5.1.4; Google target audience):** never "for
kids", "for children" or "youth" in the name, subtitle, description, keywords
or screenshots. Say "members", "families", "athletes". No cartoon characters,
no photos of children in screenshots or the icon.

**Keywords (Apple, 100 characters):**
`sports club,gym,membership,class booking,check in,schedule,coach,team,training,athlete`

**URLs**
- Privacy policy: `https://athletix-os.com/privacy`
- Terms: `https://athletix-os.com/terms`
- Account deletion (Google requires this field): `https://athletix-os.com/delete-account`
- Marketing: `https://athletix-os.com`
- Support: **YOU** — a page or an email that is answered. `support@athletix-os.com`
  already appears in the privacy policy; if that inbox is monitored, use
  `mailto:` on a simple `/support` page (I can add the page; tell me the hours
  and how fast you answer).

## 2. Review notes (paste into "App Review Information → Notes")

> AthletixOS is used by members and staff of sports clubs to manage real-world
> club memberships, in-person classes and events.
>
> NATIVE FEATURES
> - Door check-in with the camera: Home → "Scan to check in" opens a native
>   scanner. A test code is attached to this submission and printed in the
>   demo instructions below.
> - Works offline: in Airplane Mode the app shows a native offline screen with
>   the member's last-known schedule and reconnects by itself.
> - Haptic feedback on check-in, system status bar and launch screen, Android
>   back button handling.
> - Universal Links: scanning a club's printed door code with the phone's
>   camera opens the app directly on the check-in screen.
>
> PAYMENTS (Guideline 3.1.3(e))
> Everything a member can pay for in this app is a physical service consumed
> outside the app: gym and club memberships, in-person classes, in-person
> events and in-person private lessons at the club's facility. Payments go to
> the club through Stripe. Nothing paid for unlocks content or features in
> the app, and the app offers no live-streamed or on-demand digital classes.
> The software subscription that club owners pay to AthletixOS cannot be
> purchased, upgraded or managed inside the app.
>
> WEB CONTENT (Guideline 2.5.2 / 4.2)
> The app is built with Capacitor. Screens are our own first-party pages
> served from athletix-os.com inside WKWebView; navigation is locked to that
> domain and to Stripe's hosted checkout. All native functionality (camera
> scanner, haptics, offline screen, share, launch screen) is compiled into the
> binary. We do not download native code or change the purpose of the app
> from the server.
>
> ACCOUNTS
> Email and password only; no third-party sign-in. Account deletion is in the
> app for every account type: More → Account → Delete account (members and
> parents), or the name menu → My account → Delete my account (staff and
> owners).
>
> CHILDREN
> The app is for adults: members, parents and club staff. A parent manages
> their children's club records from the parent's own account. The app is not
> in the Kids category and is not directed at children.
>
> DEMO ACCOUNTS: see the sign-in information fields. The demo club uses
> fictional people. To try a booking without a card, book the free class
> "Open Mat (demo)" or choose "Pay at the front desk" on any paid item.

## 3. Demo accounts and data (**YOU** create these; I cannot write to production)

Use the existing club with the link `demo` (it has one member today). Rename it
"Riverside Athletics (Demo)". Everything in it must be fictional.

| Role | Email | Purpose |
|---|---|---|
| Adult member | `review.member@athletix-os.com` | books for themself, has an active membership |
| Parent with a minor | `review.parent@athletix-os.com` | one child "Jordan Rivers", born about 10 years ago |
| Staff (coach) | `review.staff@athletix-os.com` | attendance and schedule permissions |

Passwords: one strong password each, entered in the store forms only. They
must never expire and must not need a code by email (Google: credentials
"accessible at all times, reusable").

Set up in the demo club, in this order:

1. Settings → Club: name, a plain logo, timezone, and turn on cash and check.
2. Purchase Options → Memberships: "Adult Unlimited" $99/month, "Junior
   2x/week" $79/month. Assign Adult Unlimited to the adult member as a cash
   membership and record one payment, so billing screens have content.
3. Classes: "Open Mat (demo)" free, every day for the review period; "Skills
   Class" with a drop-in price.
4. Events: one free event next week and one $25 event with cash allowed.
5. Staff → add the coach; assign them to Open Mat.
6. Announcements: one welcome announcement.
7. Documents: one short waiver, signed by the adult member.
8. Sign in once as each demo account and check nothing asks for setup.

**Test check-in code.** Open the door code for today's Open Mat class (the QR
the club prints for the door; its address looks like
`https://athletix-os.com/c/…`). Save it as an image, attach it in App Store
Connect ("Attachment"), and put its link in the notes. A reviewer scans it
from a second screen. I have not walked this path in the demo club, so check
that the code you attach really opens the check-in screen.

**Card payments.** Production uses live Stripe, so test card numbers do not
work. That is why the demo club has a free class and a "pay at the front
desk" option: every flow can be completed without a card. Say exactly that in
the notes (it is in §2).

Keep the back end and the demo club untouched while a review is in progress.

## 4. Apple: App Privacy answers

"Data used to track you": **None.** No advertising, no data brokers, no
cross-app tracking, no advertising identifier.

"Data linked to you" (all for **App Functionality**; add **Analytics** only
where noted):

| Data type | Collected | Notes |
|---|---|---|
| Name | Yes | account and club roster |
| Email address | Yes | sign-in and receipts |
| Phone number | Yes | optional, club contact |
| Physical address | Yes | optional, club records |
| Other user contact info | Yes | guardian contact for a child's record |
| Payment info | **No** | cards are entered on Stripe's pages; we never receive card numbers |
| Purchase history | Yes | membership and booking payments |
| Photos | Yes | optional profile photo or uploaded document |
| Other user content | Yes | messages to coaches, signed documents |
| User ID | Yes | account id |
| Sensitive info / Health & fitness | **No** | attendance is a visit record, not health data. If you ever store weight, injuries or medical notes in custom fields, this answer changes to Yes. |
| Location, Contacts, Browsing/Search history | No | |
| Crash data / performance data | Yes if Sentry is on in production | App Functionality; **YOU** confirm whether `NEXT_PUBLIC_SENTRY_DSN` is set in Netlify |
| Device ID | No (Yes, for App Functionality, once push notifications ship) | |

Age rating questionnaire: all "None". Unrestricted web access: **No**
(navigation is locked to our site). Expected result: 4+.

Export compliance: uses only standard HTTPS; `ITSAppUsesNonExemptEncryption`
is already `false` in Info.plist.

Sign in with Apple: not required (no third-party login).

## 5. Google: App content answers

- **Privacy policy:** `https://athletix-os.com/privacy`
- **Ads:** No.
- **App access:** "All or some functionality is restricted" → add the three
  demo logins from §3, in English, plus: "The club link field is `demo`."
- **Content rating:** questionnaire, category "Utility, Productivity,
  Communication or Other"; all "No". User-to-user communication: **Yes**
  (members message club staff), not public, and staff are identified.
- **Target audience:** **YOU decide** (plan §6.5). "18 and over" hides the app
  from under-18s, including teen athletes with their own login. "13 and over"
  matches the product. Either way answer "No" to "appeals to children".
- **News app / COVID / Government / Financial features / Health:** No.
- **Data safety:**
  - Collects data: Yes. Shares with third parties: **No** (Stripe, Supabase,
    Resend and Netlify are service providers acting for us; that is
    "processing", not "sharing").
  - Encrypted in transit: **Yes.**
  - Users can request deletion: **Yes** → `https://athletix-os.com/delete-account`
  - Types (all "Collected", "Required" unless noted, purpose "App
    functionality" and "Account management"): Name; Email address; User IDs;
    Phone number (optional); Address (optional); Purchase history; Messages
    (other in-app messages); Photos (optional); Files and docs (optional).
  - Payment info / credit card: **not collected** (entered on Stripe's own
    pages; Google's form says data a payment service collects directly need
    not be declared).
  - Location, contacts, health, web history, device IDs: not collected.
- **Permissions:** Camera only, requested when the person taps "Scan to check
  in". No declaration form is needed for camera.
- **Payments:** physical services (gym memberships, in-person classes, event
  tickets): Play Billing does not apply.

## 6. Screenshots (fictional data only, signed in to the demo club)

Apple needs 6.9-inch iPhone (1320 × 2868). iPad only if you tick iPad support;
**recommend iPhone-only for the first release.** Google needs phone
screenshots (at least 2, 1080 × 1920 or larger), a 512 × 512 icon and a
1024 × 500 feature graphic.

Never the sign-in screen, never a real family's name (Apple 2.3.3).

1. Member home with "Scan to check in" and upcoming bookings
2. Schedule: the week, with a class to book
3. A check-in success screen ("You're checked in")
4. Family: the parent account with one child and their bookings
5. Membership and payment history
6. Messages with a coach
7. Staff: today's attendance list
8. The offline screen showing the saved schedule (optional, good 4.2 evidence)

How to capture: run the TestFlight build on your iPhone, or in Xcode's
simulator choose iPhone 17 Pro Max and press Cmd+S.

## 7. iPhone: Xcode archive → TestFlight

One-time: Xcode → Settings → Accounts → add the Apple ID that belongs to the
MC Technologies organization team.

```bash
cd /Users/cubano/Desktop/clubos/web
```

```bash
npm install
```

```bash
npm run cap:dev:prod -- https://athletix-os.com
```

```bash
npm run cap:ios
```

In Xcode:

1. Click **App** in the left sidebar → **Signing & Capabilities** → Team: MC
   Technologies Group LLC, "Automatically manage signing" on. Bundle
   identifier must read `com.athletixos.app`.
2. **General** → Version `1.0.0`, Build `1`. Raise Build by one for every
   upload.
3. Device menu at the top → **Any iOS Device (arm64)**.
4. **Product → Archive.** Wait for the Organizer window.
5. **Distribute App → App Store Connect → Upload.** Accept the defaults.
6. In App Store Connect → your app → **TestFlight**: the build appears after
   10 to 30 minutes of "Processing". Add yourself under Internal Testing.
7. On your iPhone install **TestFlight** from the App Store, accept the
   invite, install AthletixOS.

Check on the phone before going further (these cannot be proven on a
simulator):

- [ ] Scan to check in opens the camera, asks permission with our wording,
      and a door code lands on the check-in screen
- [ ] You feel a tap on a successful check-in
- [ ] Airplane Mode on, reopen the app: offline screen with your schedule;
      Airplane Mode off: it reconnects by itself
- [ ] Scan a printed door code with the phone's Camera app: it opens the app
- [ ] Start a card payment: Stripe opens inside the app, and after paying you
      are back in the app, not in Safari
- [ ] Delete account works on a throwaway account

## 8. Android: Android Studio bundle → Play internal testing

```bash
cd /Users/cubano/Desktop/clubos/web
```

```bash
npm run cap:dev:prod -- https://athletix-os.com
```

```bash
npm run cap:android
```

In Android Studio:

1. Wait for "Gradle sync finished".
2. **Build → Generate Signed App Bundle / APK → Android App Bundle → Next.**
3. **Create new…** key store. Save it OUTSIDE the repo, for example
   `~/keys/athletixos-upload.jks`. Choose two passwords and an alias
   (`upload`). **Back up the file and both passwords in your password
   manager now. If you lose them you can never update the app.** Never
   commit the file and never send it to anyone, including me.
4. Build variant **release** → **Create**. The `.aab` is in
   `android/app/release/`.
5. Play Console → your app → **Testing → Internal testing → Create new
   release** → upload the `.aab` → add yourself as a tester → Review → Roll
   out.
6. Play Console → **Setup → App integrity → App signing**: copy the SHA-256
   certificate fingerprint. In Netlify add `ANDROID_APP_SHA256` with that
   value and redeploy. This is what makes door codes open the app on Android.
7. Raise `versionCode` in `android/app/build.gradle` by one for every upload.

Check on the phone: the same list as iPhone, plus:

- [ ] The back button closes a sheet, then goes back a screen, then leaves
      the app from the home screen (it never does nothing)
- [ ] Play Console → **Pre-launch report** shows no crash and no
      "edge-to-edge" or "16 KB page size" warning. I could not confirm either
      rule from Google's pages; if one appears, send me the text.

## 9. Open before you press Submit

| # | What | Who |
|---|---|---|
| 1 | Merge and deploy both branches (the app talks to the live site; the scanner button, the dialogs and the deletion screens are web changes) | YOU |
| 2 | ~~Signup email check (audit S2)~~ **Built 2026-11-16.** Make sure confirmation emails actually arrive (Resend is configured in Netlify) before a reviewer signs up. | Done; YOU check delivery |
| 3 | Confirm the account-deletion rules (plan §6.1 to §6.4). The public page says requests by email are handled within 30 days; change the number if that is not true. | YOU |
| 4 | Google target audience 18+ or 13+ (plan §6.5) | YOU |
| 5 | Support address or page | YOU |
| 6 | Create the demo club data and three demo logins (§3) | YOU |
| 7 | Hands-on phone checks in §7 and §8 | YOU |
| 8 | The privacy policy is marked attorney-pending in the repo (`legal/PRIVACY_POLICY.md`). It should mention the app, the camera, and (later) push notifications. | YOU + attorney |
| 9 | Text under 12 px in the member portal (115 places) and screens that can spin forever on a dropped connection. Not a rejection risk by themselves; planned next. | Me |
| 10 | Push notifications (plan slice 5): migration + APNs key + Firebase project. Not needed for the first submission. | Later |

## 10. If a reviewer pushes back

- **"This is a website" (4.2):** point to the scanner, the offline screen,
  haptics and Universal Links, and offer a screen recording. Push
  notifications are the strongest addition if they still disagree.
- **"Use in-app purchase" (3.1.1):** quote 3.1.3(e): these are services
  "consumed outside of the app", for which other payment methods are
  required. Confirm no digital content is sold and that AthletixOS plans
  cannot be bought in the app.
- **"Downloaded code" (2.5.2):** the content is our own HTML and JavaScript in
  WKWebView; all native capability is in the binary; the purpose of the app
  does not change from the server.
- **"We could not sign in":** check the demo logins from a phone that is not
  yours, on cellular.
