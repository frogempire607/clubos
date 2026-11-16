// Is this request coming from inside the iOS / Android app? PURE.
//
// The app adds a marker to its user agent (`appendUserAgent` in
// lib/nativeConfig.ts). The server uses it for exactly one thing: refusing to
// start a purchase of AthletixOS's OWN plan from inside the app.
//
// Why: a family paying a club for classes is a real-world service, and both
// stores require a payment method other than their own for it. A club owner
// buying AthletixOS Pro is software that unlocks features in the app, which
// Apple (3.1.1) and Google (Payments §2) reserve for their in-app billing. So
// in the app that purchase does not exist: no button, no price, no link, and
// — enforced here — no way to start it even by calling the route directly.
// On the website nothing changes.

export const NATIVE_SHELL_UA_MARKER = "AthletixOSNativeShell";

export function isNativeShellUserAgent(userAgent: string | null | undefined): boolean {
  return typeof userAgent === "string" && userAgent.includes(NATIVE_SHELL_UA_MARKER);
}

/** The one sentence the app shows where the plan screens would be. No price, no link, no "go to the website". */
export const NATIVE_PLAN_NOTICE = "Your club's AthletixOS plan can't be changed in the app.";
