// Sign in with Google / Sign in with Apple: the RULES. PURE: no prisma, no
// fetch, no Date.now() (callers pass `now`). The network and database half is
// lib/socialAuthServer.ts; the token maths is lib/socialJwt.ts.
//
// The one decision that matters is `decideSocialSignIn`: when may a Google or
// Apple sign-in be attached to an account that already exists? The answer is
// deliberately narrow, because attaching the wrong one hands a stranger a
// family's records:
//
//   1. Linked before                          -> sign in.
//   2. Provider says the email is VERIFIED, it is a real address (not an Apple
//      relay), and it matches a live MEMBER / parent login in this club
//                                             -> link, then sign in.
//   3. Anything else                          -> CHOOSE: the person either
//      signs in once with their password ("Link to my existing account") or
//      creates an account. Nothing is linked and nothing is created silently.
//
// Staff and owner logins are never linked by an email match, even a verified
// one: those accounts see every family and move money. They connect a method
// from My account after a password sign-in.
//
// CHOOSE is the same screen whether or not an account matched, so the flow
// cannot be used to ask "does this address have an account here?".

import { createHmac, timingSafeEqual } from "crypto";

export const SOCIAL_PROVIDERS = ["google", "apple"] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

export function isSocialProvider(v: unknown): v is SocialProvider {
  return v === "google" || v === "apple";
}

/** Stored in user_identities.provider. */
export function providerKey(p: SocialProvider): "GOOGLE" | "APPLE" {
  return p === "google" ? "GOOGLE" : "APPLE";
}

export function providerLabel(p: SocialProvider | "GOOGLE" | "APPLE"): string {
  return p === "google" || p === "GOOGLE" ? "Google" : "Apple";
}

// ── What the provider told us ──────────────────────────────────────────────

export type ProviderProfile = {
  provider: SocialProvider;
  /** The provider's stable id for this person (`sub`). The only thing an
   *  existing link is ever looked up by. */
  subject: string;
  email: string | null;
  emailVerified: boolean;
  /** Apple "Hide My Email": a relay address that matches nothing on file. */
  emailIsRelay: boolean;
  firstName: string | null;
  lastName: string | null;
};

const APPLE_RELAY_DOMAIN = "@privaterelay.appleid.com";

/** Claims arrive as booleans from Google and as the strings "true"/"false" from Apple. */
export function claimIsTrue(v: unknown): boolean {
  return v === true || v === "true";
}

export function profileFromClaims(
  provider: SocialProvider,
  claims: Record<string, unknown>,
  appleUser?: { firstName?: string | null; lastName?: string | null } | null,
): ProviderProfile | null {
  const subject = typeof claims.sub === "string" ? claims.sub : "";
  if (!subject) return null;
  const rawEmail = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  const email = rawEmail && rawEmail.includes("@") ? rawEmail : null;
  const emailIsRelay = provider === "apple" && (claimIsTrue(claims.is_private_email) || (email ?? "").endsWith(APPLE_RELAY_DOMAIN));
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : null);
  return {
    provider,
    subject,
    email,
    emailVerified: !!email && claimIsTrue(claims.email_verified),
    emailIsRelay,
    firstName: provider === "google" ? str(claims.given_name) : str(appleUser?.firstName),
    lastName: provider === "google" ? str(claims.family_name) : str(appleUser?.lastName),
  };
}

// ── The decision ───────────────────────────────────────────────────────────

export type AccountRole = "MEMBER" | "STAFF" | "OWNER";

export type SocialSignInFacts = {
  profile: Pick<ProviderProfile, "email" | "emailVerified" | "emailIsRelay">;
  /** The account this provider id is already linked to in this club, if any. */
  linked: { userId: string; deleted: boolean } | null;
  /** The login in this club whose email equals the provider's email, if any. */
  emailMatch: { userId: string; role: AccountRole; deleted: boolean } | null;
};

export type SocialSignInDecision =
  | { action: "SIGN_IN"; userId: string }
  | { action: "LINK_AND_SIGN_IN"; userId: string }
  | { action: "CHOOSE"; reason: "NO_ACCOUNT" | "UNVERIFIED_EMAIL" | "RELAY_EMAIL" | "STAFF_ACCOUNT" | "NO_EMAIL" };

export function decideSocialSignIn(f: SocialSignInFacts): SocialSignInDecision {
  if (f.linked && !f.linked.deleted) return { action: "SIGN_IN", userId: f.linked.userId };
  const { email, emailVerified, emailIsRelay } = f.profile;
  if (!email) return { action: "CHOOSE", reason: "NO_EMAIL" };
  if (emailIsRelay) return { action: "CHOOSE", reason: "RELAY_EMAIL" };
  if (!emailVerified) return { action: "CHOOSE", reason: "UNVERIFIED_EMAIL" };
  const m = f.emailMatch;
  if (!m || m.deleted) return { action: "CHOOSE", reason: "NO_ACCOUNT" };
  if (m.role !== "MEMBER") return { action: "CHOOSE", reason: "STAFF_ACCOUNT" };
  return { action: "LINK_AND_SIGN_IN", userId: m.userId };
}

/**
 * After a sign-in is attached to an account: is the account's own address now
 * proven? Only when the provider vouches for a real address AND it is the
 * address on the account. This is what allows the existing "after
 * verification, do the linking" step to run; nothing weaker may.
 */
export function provesAccountEmail(profile: Pick<ProviderProfile, "email" | "emailVerified" | "emailIsRelay">, accountEmail: string): boolean {
  return !!profile.email && profile.emailVerified && !profile.emailIsRelay && profile.email === accountEmail.trim().toLowerCase();
}

// ── Sign-in methods on an account ──────────────────────────────────────────

/** A real bcrypt hash. Deleted accounts ("deleted:…") and accounts created
 *  through Google or Apple ("social:…") hold a marker nobody can type. */
export function passwordIsUsable(passwordHash: string | null | undefined): boolean {
  return typeof passwordHash === "string" && /^\$2[aby]\$/.test(passwordHash);
}

export const SOCIAL_PASSWORD_PREFIX = "social:";

/** One way in must always remain. */
export function canRemoveMethod(input: { hasPassword: boolean; identityCount: number }): boolean {
  return input.hasPassword ? input.identityCount >= 1 : input.identityCount >= 2;
}

// ── Signed, short-lived tokens (state, pending sign-in, app handoff) ───────
//
// Compact `payload.signature`, HMAC-SHA256 over the payload with a key derived
// from NEXTAUTH_SECRET and a per-purpose label, so a token minted for one
// purpose is never accepted for another.

export type TokenPurpose = "state" | "pending" | "handoff" | "ticket";

const b64u = (b: Buffer) => b.toString("base64url");

function mac(purpose: TokenPurpose, body: string, secret: string): Buffer {
  return createHmac("sha256", `aox-social:${purpose}:${secret}`).update(body).digest();
}

export function signToken<T extends object>(purpose: TokenPurpose, payload: T, ttlMs: number, now: Date, secret: string | undefined): string {
  if (!secret) throw new Error("NEXTAUTH_SECRET is not set");
  const body = b64u(Buffer.from(JSON.stringify({ ...payload, exp: now.getTime() + ttlMs }), "utf8"));
  return `${body}.${b64u(mac(purpose, body, secret))}`;
}

export function readToken<T extends object>(purpose: TokenPurpose, token: string | null | undefined, now: Date, secret: string | undefined): T | null {
  if (!secret || !token || typeof token !== "string" || token.length > 6000) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const body = token.slice(0, dot);
  let given: Buffer;
  try {
    given = Buffer.from(token.slice(dot + 1), "base64url");
  } catch {
    return null;
  }
  const want = mac(purpose, body, secret);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp?: number };
    if (typeof parsed.exp !== "number" || parsed.exp <= now.getTime()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export const STATE_TTL_MS = 10 * 60_000;
export const PENDING_TTL_MS = 20 * 60_000;
export const HANDOFF_TTL_MS = 90_000;
export const TICKET_TTL_MS = 10 * 60_000;

export type SocialMode = "signin" | "connect";

export type StatePayload = {
  p: SocialProvider;
  /** Club slug the person chose before starting. */
  c: string;
  m: SocialMode;
  /** Nonce echoed back inside the provider's signed id_token. */
  n: string;
  /** Random value also held in a cookie: ties the answer to the browser that asked. */
  b: string;
  /** Exact redirect address registered with the provider. */
  r: string;
  /** In the app: SHA-256 of a secret only the app that started this holds. */
  a?: string;
  /** connect mode: the signed-in account that asked. */
  u?: string;
  /** Where a member goes afterwards (a /member path), if anywhere special. */
  x?: string;
};

export type PendingPayload = {
  provider: SocialProvider;
  subject: string;
  clubId: string;
  clubSlug: string;
  email: string | null;
  emailVerified: boolean;
  emailIsRelay: boolean;
  firstName: string | null;
  lastName: string | null;
  /** Apple refresh token, already encrypted (lib/fieldCrypto). */
  rt?: string | null;
};

export type HandoffPayload =
  | { k: "session"; userId: string; a: string }
  | { k: "pending"; pending: string; a: string };

/** The app proves it started the flow by presenting the secret whose hash went out with it. */
export function challengeMatches(challenge: string, verifier: string | null | undefined, sha256b64u: (s: string) => string): boolean {
  if (!verifier || verifier.length < 32 || verifier.length > 200) return false;
  const a = Buffer.from(sha256b64u(verifier));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The custom address the browser sheet finishes on, which reopens the app. */
export const APP_RETURN_SCHEME = "com.athletixos.app";
export function appReturnUrl(params: Record<string, string>): string {
  return `${APP_RETURN_SCHEME}://auth/social?${new URLSearchParams(params).toString()}`;
}

/** Only a path inside the member portal may be carried through sign-in. */
export function safeMemberNext(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith("/member") || raw.startsWith("//") || raw.includes("://") || raw.includes("\\") || raw.length > 300) return null;
  return raw;
}

export { SOCIAL_ERROR_TEXT } from "@/lib/socialErrors";
