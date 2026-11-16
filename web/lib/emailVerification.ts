// "Is this really your email address?" — the rule and the signed link. PURE.
//
// WHY THIS EXISTS (audit 2026-11-15, finding S2). Creating a portal account
// never checked that the person owned the address they typed, and three
// things then trusted that address:
//   - signup connected the new login to an existing member record with the
//     same email;
//   - signup, and later "link my child", gave CONFIRMED guardian access to
//     every child whose guardian email matched;
//   - findOrAutoLinkMember connected a login to a same-email member record
//     the first time any portal page loaded.
// So anyone who knew a parent's email — and a club link, which is public —
// could sign up as them and get their profile, their billing and their
// children. 193 invited families had no login yet when this was found.
//
// THE RULE. An address only links an account to a record somebody else
// created once the person has proved they receive mail there. Until then the
// account works for everything that does not depend on a match.
//
// Proof is any of:
//   - clicking the link this module signs (emailed at signup, re-sendable);
//   - setting a password from an emailed link (reset, staff setup, guardian
//     invite, migration activation) — those routes stamp emailVerified too;
//   - the account pre-dates the rule (see REQUIRED_FROM).
//
// No database column was added: `users.emailVerified` already existed, unused,
// and the link is a stateless HMAC so there is no token table.

import { createHash, createHmac, timingSafeEqual } from "crypto";

/**
 * Accounts created before this moment keep the behaviour they were created
 * under. They could not have been made to exploit a hole nobody knew about
 * and then left unlinked — a matching record would have been linked on the
 * spot — and asking every existing family to re-prove an address they have
 * used for months would only generate support calls.
 */
export const EMAIL_VERIFICATION_REQUIRED_FROM = new Date("2026-11-16T00:00:00.000Z");

/** How long an emailed confirmation link works. */
export const EMAIL_VERIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function isEmailVerified(user: { emailVerified: Date | null | undefined; createdAt: Date }): boolean {
  if (user.emailVerified) return true;
  return user.createdAt.getTime() < EMAIL_VERIFICATION_REQUIRED_FROM.getTime();
}

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** A short, stable fingerprint of an address: the link dies if the address changes. */
export function emailFingerprint(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 16);
}

function sign(payload: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(`email-verify.v1.${payload}`).digest());
}

/**
 * A confirmation link token for one user and one address.
 * Throws when there is no secret: an unsigned link must never be issued.
 */
export function signVerificationToken(input: { userId: string; email: string; now: Date }, secret: string | undefined): string {
  if (!secret) throw new Error("Email verification is not configured (no signing secret).");
  const payload = b64url(
    Buffer.from(JSON.stringify({ u: input.userId, e: emailFingerprint(input.email), x: input.now.getTime() + EMAIL_VERIFICATION_TTL_MS })),
  );
  return `${payload}.${sign(payload, secret)}`;
}

export type VerificationClaim = { userId: string; emailFingerprint: string };
export type VerificationRead =
  | { ok: true; claim: VerificationClaim }
  | { ok: false; reason: "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED" | "NOT_CONFIGURED" };

/** Check a token. Constant-time on the signature; never throws. */
export function readVerificationToken(token: string | null | undefined, secret: string | undefined, now: Date): VerificationRead {
  if (!secret) return { ok: false, reason: "NOT_CONFIGURED" };
  if (typeof token !== "string" || token.length > 600) return { ok: false, reason: "MALFORMED" };
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined) return { ok: false, reason: "MALFORMED" };
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "BAD_SIGNATURE" };
  let body: { u?: unknown; e?: unknown; x?: unknown };
  try {
    body = JSON.parse(fromB64url(payload).toString("utf8"));
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  if (typeof body.u !== "string" || typeof body.e !== "string" || typeof body.x !== "number") return { ok: false, reason: "MALFORMED" };
  if (now.getTime() > body.x) return { ok: false, reason: "EXPIRED" };
  return { ok: true, claim: { userId: body.u, emailFingerprint: body.e } };
}

/** What to tell someone whose link did not work. */
export function verificationProblemMessage(reason: Exclude<VerificationRead, { ok: true }>["reason"] | "ADDRESS_CHANGED" | "NO_ACCOUNT"): string {
  switch (reason) {
    case "EXPIRED":
      return "This link has expired. Sign in and ask for a new one — it takes a few seconds.";
    case "ADDRESS_CHANGED":
      return "This link was for a different email address than the one on the account now. Sign in and ask for a new one.";
    case "NO_ACCOUNT":
      return "We couldn't find the account this link belongs to.";
    case "NOT_CONFIGURED":
      return "Email confirmation isn't available right now. Please try again later.";
    default:
      return "This link isn't valid. Open the newest email from us, or sign in and ask for a new one.";
  }
}
