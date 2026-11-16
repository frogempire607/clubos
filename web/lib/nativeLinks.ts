// Turning a URL that arrived from OUTSIDE the page — a link that opened the
// app, or a QR code the camera read — into a path inside the app. PURE.
//
// Both are untrusted input. A QR code on a wall can say anything, so nothing
// here ever returns a foreign address: the answer is a path on our own site
// or null.

const OUR_HOSTS = /(^|\.)athletix-os\.com$/i;

/** The in-app path for a link to our own site, or null for anything else. */
export function pathForAppUrl(raw: string, currentHost: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!OUR_HOSTS.test(u.hostname) && u.host !== currentHost) return null;
    return `${u.pathname}${u.search}${u.hash}` || "/";
  } catch {
    return null;
  }
}

/** A door code (`/c/<id>`) or a check-in page (`/member/checkin/<id>`). */
const CHECK_IN_PATH = /^\/(?:c|member\/checkin)\/([A-Za-z0-9_-]{6,64})\/?$/;

export type ScanOutcome =
  | { ok: true; path: string }
  | { ok: false; reason: "EMPTY" | "NOT_A_LINK" | "OTHER_SITE" | "NOT_A_CHECK_IN" };

/**
 * What a scanned QR code means for check-in. Only a door code from our own
 * site is accepted; the result always lands on `/member/checkin/<id>`, never
 * on whatever path the code happened to carry.
 */
export function checkInPathFromScan(raw: string | null | undefined, currentHost: string): ScanOutcome {
  const text = (raw ?? "").trim();
  if (!text) return { ok: false, reason: "EMPTY" };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: "NOT_A_LINK" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "NOT_A_LINK" };
  if (!OUR_HOSTS.test(url.hostname) && url.host !== currentHost) return { ok: false, reason: "OTHER_SITE" };
  const m = CHECK_IN_PATH.exec(url.pathname);
  if (!m) return { ok: false, reason: "NOT_A_CHECK_IN" };
  return { ok: true, path: `/member/checkin/${m[1]}` };
}

/** What to tell the person when a scan was not a check-in code. */
export function scanProblemMessage(reason: Exclude<ScanOutcome, { ok: true }>["reason"]): string {
  switch (reason) {
    case "EMPTY":
      return "Nothing was scanned. Point the camera at the code by the door and try again.";
    case "NOT_A_LINK":
    case "OTHER_SITE":
      return "That code isn't one of your club's check-in codes.";
    case "NOT_A_CHECK_IN":
      return "That code is from your club, but it isn't a check-in code. Look for the one posted by the door.";
  }
}
