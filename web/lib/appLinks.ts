// Universal Links (iOS) / App Links (Android): which URLs open the installed
// AthletixOS app instead of the browser. PURE — the two /.well-known routes
// and the tests read from here.
//
// The door QR posters point at /c/{id}. With these files served, scanning one
// on a phone that has the app opens the app straight to check-in; without the
// app it opens the website, which offers the app-store badges.

export const APP_BUNDLE_ID = "com.athletixos.app";
/** Apple Developer team that signs the iOS app (ios/App project settings). */
export const APPLE_TEAM_ID = process.env.APPLE_TEAM_ID || "J5TSB958YP";

/** Paths the app should open. Staff-only surfaces (/dashboard, /kiosk) stay in the browser. */
export const APP_LINK_PATHS = ["/c/*", "/member", "/member/*", "/e/*", "/p/*", "/join/*", "/r/*"];

export function appleAppSiteAssociation(teamId = APPLE_TEAM_ID) {
  const appID = `${teamId}.${APP_BUNDLE_ID}`;
  return {
    applinks: {
      details: [{ appIDs: [appID], components: APP_LINK_PATHS.map((p) => ({ "/": p })) }],
    },
    webcredentials: { apps: [appID] },
  };
}

/**
 * Android Digital Asset Links. The SHA-256 is the APP SIGNING key's
 * fingerprint from Play Console → Setup → App integrity (comma-separate
 * several, e.g. the upload key too). Empty until it is set — Android then
 * simply opens links in the browser.
 */
export function androidAssetLinks(fingerprints = process.env.ANDROID_APP_SHA256 || "") {
  const fps = fingerprints.split(",").map((s) => s.trim().toUpperCase()).filter((s) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(s));
  if (fps.length === 0) return [];
  return [{
    relation: ["delegate_permission/common.handle_all_urls"],
    target: { namespace: "android_app", package_name: APP_BUNDLE_ID, sha256_cert_fingerprints: fps },
  }];
}

/** Store badges for the website. Null until the listing exists. */
export function appStoreUrls() {
  return {
    ios: process.env.NEXT_PUBLIC_IOS_APP_URL || null,
    android: process.env.NEXT_PUBLIC_ANDROID_APP_URL || null,
  };
}
