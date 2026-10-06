// An event's PRIVATE share link — the pure rules. No database, no Node APIs
// (the editor imports this), so scripts/event-share-link-tests.ts can prove
// every branch.
//
// The link is /e/s-<token>: the same page, the same API and the same
// registration route as the public link /e/<slug>, reached by a random token
// instead of the event's name. Julian (2026-10-06): "gives the option to send
// a link to people to register without everyone seeing it. Maybe it's not as
// obvious as the public link being the name of the event."
//
// What a token changes is decided in ONE place — `linkAccess` below — and it
// is short on purpose:
//
//   bypassed  visibility, publicRegistration, signupAccess (even STAFF_ONLY),
//             and publishAt (a private link to an event that isn't published
//             yet works — sending it early is the coach's call).
//   enforced  deleted, unpublishAt, the registration deadline, capacity and
//             roster spots, payment setup, documents, coach approval — i.e.
//             everything the public link enforces after "is this public?".

export const SHARE_PREFIX = "s-";
/** Letters and digits only — nothing a chat app will wrap, encode or strip. */
export const SHARE_TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** 20 base62 characters ≈ 119 bits. */
export const SHARE_TOKEN_LENGTH = 20;
const TOKEN_SHAPE = /^[A-Za-z0-9]{16,40}$/;

/** Stored in formResponses (server-written `__` keys can't be forged — lib/eventForm). */
export const VIA_KEY = "__via";
export const VIA_PRIVATE_LINK = "private-link";
/** A fingerprint of the token that was used — never the token itself. */
export const VIA_LINK_ID_KEY = "__viaLinkId";

export type LinkVia = "slug" | "token";

export function isShareToken(token: string): boolean {
  return TOKEN_SHAPE.test(token);
}

/**
 * Build a token from random bytes. Rejection sampling, so every character is
 * uniform over the 62 (a plain `byte % 62` favours the first 8). Returns null
 * when the bytes run out — the caller asks for more.
 */
export function tokenFromBytes(bytes: Uint8Array, length = SHARE_TOKEN_LENGTH): string | null {
  let out = "";
  for (const b of bytes) {
    if (b >= 248) continue; // 248 = 62 × 4
    out += SHARE_TOKEN_ALPHABET[b % 62];
    if (out.length === length) return out;
  }
  return null;
}

/**
 * What a /e/<segment> address is asking for.
 *
 * `s-` followed by something token-shaped MAY be a private link. It may also
 * be an old public slug — "S-Supercalifragilistic Open" slugs to exactly that
 * shape — so the server resolver tries the token first and falls back to the
 * slug (lib/eventShareLinkServer). Everything else is a slug, full stop:
 * "s-curve-clinic" has a hyphen, so it never costs a token lookup.
 */
export function parseLinkSegment(segment: string): { kind: "slug"; slug: string } | { kind: "token"; token: string; slug: string } {
  if (segment.startsWith(SHARE_PREFIX)) {
    const token = segment.slice(SHARE_PREFIX.length);
    if (isShareToken(token)) return { kind: "token", token, slug: segment };
  }
  return { kind: "slug", slug: segment };
}

/**
 * Keep new public slugs out of the private-link namespace. A slug that would
 * read as `s-<token>` gets an `event-` prefix; every other slug is unchanged.
 */
export function reserveSlug(slug: string): string {
  return parseLinkSegment(slug).kind === "token" ? `event-${slug}` : slug;
}

export function sharePath(token: string): string {
  return `/e/${SHARE_PREFIX}${token}`;
}

export function shareUrl(baseUrl: string, token: string): string {
  return `${baseUrl}${sharePath(token)}`;
}

// ── Access ──────────────────────────────────────────────────────────────────

export type LinkAccessEvent = {
  deletedAt?: Date | string | null;
  publishAt?: Date | string | null;
  unpublishAt?: Date | string | null;
  registrationDeadline?: Date | string | null;
  signupAccess?: string | null;
  publicRegistration?: boolean | null;
  tournamentMode?: string | null;
};

export type LinkAccess =
  | { ok: true; /** May this link take a signup (before capacity is considered)? */ canRegister: boolean }
  | { ok: false; status: 404 | 403; error: string };

const at = (d: Date | string | null | undefined): number | null => (d == null ? null : new Date(d).getTime());

/**
 * May this address show the event, and may it take a signup? The one decision
 * the page API, the register route and the discount check all share.
 */
export function linkAccess(via: LinkVia, event: LinkAccessEvent | null | undefined, now: Date = new Date()): LinkAccess {
  if (!event || event.deletedAt) return { ok: false, status: 404, error: "Event not found" };
  const t = now.getTime();
  const publishAt = at(event.publishAt);
  if (via === "slug" && publishAt != null && publishAt > t) {
    return { ok: false, status: 403, error: "Registration is not open yet" };
  }
  const unpublishAt = at(event.unpublishAt);
  if (unpublishAt != null && unpublishAt < t) return { ok: false, status: 403, error: "Registration has closed" };
  const deadline = at(event.registrationDeadline);
  if (deadline != null && deadline < t) return { ok: false, status: 403, error: "The registration deadline has passed" };

  if (via === "token") return { ok: true, canRegister: true };
  // Slice 2: signupAccess is the answer; STAFF_ONLY closes the public link even
  // on a hosted tournament, PUBLIC_LINK opens it. The legacy flag is kept in
  // sync by every write.
  const canRegister =
    event.signupAccess !== "STAFF_ONLY" &&
    (event.signupAccess === "PUBLIC_LINK" || !!event.publicRegistration || event.tournamentMode === "HOST");
  return { ok: true, canRegister };
}

// ── Where a registrant is sent afterwards ───────────────────────────────────

export function cameViaPrivateLink(formResponses: unknown): boolean {
  return (
    !!formResponses &&
    typeof formResponses === "object" &&
    !Array.isArray(formResponses) &&
    (formResponses as Record<string, unknown>)[VIA_KEY] === VIA_PRIVATE_LINK
  );
}

/** The fingerprint stored at signup (see VIA_LINK_ID_KEY), or null. */
export function viaLinkId(formResponses: unknown): string | null {
  if (!cameViaPrivateLink(formResponses)) return null;
  const v = (formResponses as Record<string, unknown>)[VIA_LINK_ID_KEY];
  return typeof v === "string" && v ? v : null;
}

/**
 * The token a registrant may be sent back to: the event's CURRENT one, and
 * only if it is the same link they came in by. After "Make a new link" the
 * people who held the old one are not handed the new one.
 */
export function shareTokenForReturn(args: {
  storedLinkId: string | null;
  currentToken: string | null;
  currentLinkId: string | null;
}): string | null {
  if (!args.storedLinkId || !args.currentToken || !args.currentLinkId) return null;
  return args.storedLinkId === args.currentLinkId ? args.currentToken : null;
}

/**
 * "Register again" / "Try again" on the confirmation page. Someone who came in
 * by a private link goes back to it (while it still exists) — the public page
 * may not exist, or may be closed to them. Never `/e/` with nothing after it.
 */
export function registerAgainPath(args: {
  publicSlug?: string | null;
  shareToken?: string | null;
  viaPrivateLink?: boolean;
}): string {
  if (args.viaPrivateLink && args.shareToken && isShareToken(args.shareToken)) return sharePath(args.shareToken);
  if (args.publicSlug) return `/e/${args.publicSlug}`;
  return "/member/events";
}

/**
 * The event as lib/registrationUrl should see it for a signup that came in by
 * private link: no slug, so the confirmation address is /r/<id>. That page is
 * the same one, it works whether or not the event has a public slug, and it
 * keeps working after the coach makes a new link or turns the link off.
 */
export function urlEventFor<T extends { publicSlug?: string | null }>(via: LinkVia, event: T): { publicSlug?: string | null } {
  return via === "token" ? { publicSlug: null } : event;
}
