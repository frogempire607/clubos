# AthletixOS Native Launch Checklist

This checklist covers the single AthletixOS iOS and Android app shell. Club-specific branding remains inside the app after login. Separate per-club App Store apps are future roadmap.

## Native Shell

- App name: AthletixOS
- iOS bundle ID: `com.athletixos.app`
- Android package ID: `com.athletixos.app`
- Capacitor server URL: set `CAPACITOR_SERVER_URL` to the production AthletixOS origin before syncing release builds.
- Local development URL: `http://localhost:3001`
- Start route: `/member`

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
