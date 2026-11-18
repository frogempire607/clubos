// Sign in with Google / Apple: the network and database half. The rules are in
// lib/socialAuth.ts (pure, tested); the token maths in lib/socialJwt.ts.
//
// Configuration is by environment only, and a provider whose variables are
// missing is simply not offered, so this ships dark:
//   GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET
//   APPLE_SIGNIN_SERVICES_ID, APPLE_SIGNIN_KEY_ID, APPLE_SIGNIN_PRIVATE_KEY,
//   APPLE_TEAM_ID (defaults to the team that owns the app)

import { createHash } from "crypto";
import { encode, type JWT } from "next-auth/jwt";
import { prisma } from "@/lib/prisma";
import { authOptions, sessionPermissions } from "@/lib/auth";
import { encryptField, decryptField, fieldCryptoConfigured } from "@/lib/fieldCrypto";
import { completeEmailLinks } from "@/lib/emailLinkServer";
import { resolveIsMinor, childHasCurrentConsent, parentalConsentEnforced } from "@/lib/parentalConsent";
import { invalidatePermissionCache } from "@/lib/apiGuard";
import { appleClientSecret, verifyIdToken, type Jwk } from "@/lib/socialJwt";
import {
  profileFromClaims,
  providerKey,
  provesAccountEmail,
  type ProviderProfile,
  type SocialProvider,
} from "@/lib/socialAuth";

const DEFAULT_APPLE_TEAM_ID = "J5TSB958YP";
const FETCH_TIMEOUT_MS = 8_000;

// ── Configuration ──────────────────────────────────────────────────────────

const env = (k: string) => (process.env[k] ?? "").trim();

export function providerConfigured(p: SocialProvider): boolean {
  if (p === "google") return !!env("GOOGLE_OAUTH_CLIENT_ID") && !!env("GOOGLE_OAUTH_CLIENT_SECRET");
  return !!env("APPLE_SIGNIN_SERVICES_ID") && !!env("APPLE_SIGNIN_KEY_ID") && !!env("APPLE_SIGNIN_PRIVATE_KEY");
}

export function availableProviders(): SocialProvider[] {
  return (["google", "apple"] as const).filter(providerConfigured);
}

function clientId(p: SocialProvider): string {
  return p === "google" ? env("GOOGLE_OAUTH_CLIENT_ID") : env("APPLE_SIGNIN_SERVICES_ID");
}

function clientSecret(p: SocialProvider, now: Date): string {
  if (p === "google") return env("GOOGLE_OAUTH_CLIENT_SECRET");
  return appleClientSecret({
    teamId: env("APPLE_TEAM_ID") || DEFAULT_APPLE_TEAM_ID,
    keyId: env("APPLE_SIGNIN_KEY_ID"),
    servicesId: env("APPLE_SIGNIN_SERVICES_ID"),
    privateKeyPem: env("APPLE_SIGNIN_PRIVATE_KEY"),
    now,
  });
}

export function callbackUrl(p: SocialProvider, baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/api/auth/social/callback/${p}`;
}

export function authorizationUrl(p: SocialProvider, input: { state: string; nonce: string; redirectUri: string }): string {
  if (p === "google") {
    const q = new URLSearchParams({
      client_id: clientId(p),
      redirect_uri: input.redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state: input.state,
      nonce: input.nonce,
      prompt: "select_account",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`;
  }
  const q = new URLSearchParams({
    client_id: clientId(p),
    redirect_uri: input.redirectUri,
    response_type: "code",
    // Asking for name or email makes Apple answer with a form POST.
    response_mode: "form_post",
    scope: "name email",
    state: input.state,
    nonce: input.nonce,
  });
  return `https://appleid.apple.com/auth/authorize?${q.toString()}`;
}

// ── Talking to the providers ───────────────────────────────────────────────

async function fetchJson(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, cache: "no-store" });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

const JWKS_URL: Record<SocialProvider, string> = {
  google: "https://www.googleapis.com/oauth2/v3/certs",
  apple: "https://appleid.apple.com/auth/keys",
};
const ISSUERS: Record<SocialProvider, string[]> = {
  google: ["https://accounts.google.com", "accounts.google.com"],
  apple: ["https://appleid.apple.com"],
};
const keyCache = new Map<SocialProvider, { keys: Jwk[]; at: number }>();
const KEY_TTL_MS = 60 * 60_000;

async function providerKeys(p: SocialProvider, forceFresh = false): Promise<Jwk[]> {
  const hit = keyCache.get(p);
  if (!forceFresh && hit && Date.now() - hit.at < KEY_TTL_MS) return hit.keys;
  const r = await fetchJson(JWKS_URL[p]);
  const keys = Array.isArray(r.body.keys) ? (r.body.keys as Jwk[]) : [];
  if (keys.length) keyCache.set(p, { keys, at: Date.now() });
  return keys;
}

export type ProviderAnswer =
  | { ok: true; profile: ProviderProfile; refreshToken: string | null }
  | { ok: false; reason: string };

/**
 * Trade the one-time code for the person's signed identity, and check it.
 * Nothing about the person is believed unless the provider's signature,
 * issuer, audience, expiry and our nonce all hold.
 */
export async function exchangeAndVerify(
  p: SocialProvider,
  input: { code: string; redirectUri: string; nonce: string; appleUser?: { firstName?: string | null; lastName?: string | null } | null },
): Promise<ProviderAnswer> {
  const now = new Date();
  let tokenRes;
  try {
    tokenRes = await fetchJson(p === "google" ? "https://oauth2.googleapis.com/token" : "https://appleid.apple.com/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId(p),
        client_secret: clientSecret(p, now),
        code: input.code,
        grant_type: "authorization_code",
        redirect_uri: input.redirectUri,
      }).toString(),
    });
  } catch (e) {
    return { ok: false, reason: `token request failed: ${String(e).slice(0, 120)}` };
  }
  if (!tokenRes.ok || typeof tokenRes.body.id_token !== "string") {
    return { ok: false, reason: `token request refused (${tokenRes.status} ${String(tokenRes.body.error ?? "")})` };
  }
  const idToken = tokenRes.body.id_token;
  const check = { issuers: ISSUERS[p], audience: clientId(p), nonce: input.nonce, now };
  let verified = verifyIdToken(idToken, await providerKeys(p), check);
  // A key we don't have yet: the provider rotated. Fetch once more.
  if (!verified.ok && verified.reason === "NO_KEY") verified = verifyIdToken(idToken, await providerKeys(p, true), check);
  if (!verified.ok) return { ok: false, reason: `id_token rejected: ${verified.reason}` };
  const profile = profileFromClaims(p, verified.claims, input.appleUser);
  if (!profile) return { ok: false, reason: "id_token has no subject" };
  const refreshToken = typeof tokenRes.body.refresh_token === "string" ? tokenRes.body.refresh_token : null;
  return { ok: true, profile, refreshToken };
}

/** Apple's refresh token, sealed for storage. Only kept to revoke it later. */
export function sealAppleRefreshToken(p: SocialProvider, token: string | null): string | null {
  if (p !== "apple" || !token || !fieldCryptoConfigured()) return null;
  try {
    return encryptField(token);
  } catch {
    return null;
  }
}

/**
 * Tell Apple this app no longer has access (Apple requires it when an account
 * is deleted). Best-effort: resolves false and logs when it could not.
 */
export async function revokeAppleToken(refreshTokenEnc: string | null | undefined): Promise<boolean> {
  if (!refreshTokenEnc || !providerConfigured("apple")) return false;
  try {
    const token = decryptField(refreshTokenEnc);
    const r = await fetchJson("https://appleid.apple.com/auth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId("apple"),
        client_secret: clientSecret("apple", new Date()),
        token,
        token_type_hint: "refresh_token",
      }).toString(),
    });
    if (!r.ok) console.error("[social] Apple revoke refused", r.status, r.body.error);
    return r.ok;
  } catch (e) {
    console.error("[social] Apple revoke failed", e);
    return false;
  }
}

// ── The session ────────────────────────────────────────────────────────────

type SessionUser = { id: string; clubId: string; email: string; firstName: string; lastName: string; role: string };

/** The same cookie, with the same contents, that a password sign-in writes. */
export async function sessionCookieFor(user: SessionUser): Promise<{ name: string; value: string; options: Record<string, unknown> }> {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("NEXTAUTH_SECRET is not set");
  const maxAge = authOptions.session?.maxAge ?? 60 * 60 * 24 * 14;
  let permissions: Record<string, unknown> | null = null;
  if (user.role === "STAFF") {
    const sp = await prisma.staffProfile.findUnique({ where: { userId: user.id }, select: { permissions: true } });
    permissions = sessionPermissions(sp?.permissions ?? null);
  }
  const value = await encode({
    secret,
    maxAge,
    token: {
      sub: user.id,
      name: `${user.firstName} ${user.lastName}`.trim(),
      email: user.email,
      id: user.id,
      role: user.role,
      clubId: user.clubId,
      permissions,
    } as unknown as JWT,
  });
  const cfg = authOptions.cookies?.sessionToken;
  return {
    name: cfg?.name ?? "next-auth.session-token",
    value,
    options: { ...(cfg?.options ?? { httpOnly: true, sameSite: "lax", path: "/" }), maxAge },
  };
}

export type GateResult = { ok: true; user: SessionUser } | { ok: false; error: "removed" | "consent" };

/** The checks a password sign-in makes before it lets someone in. */
export async function signInGate(userId: string, clubId: string): Promise<GateResult> {
  const user = await prisma.user.findFirst({
    where: { id: userId, clubId },
    select: {
      id: true, clubId: true, email: true, firstName: true, lastName: true, role: true, deletedAt: true,
      memberProfile: { select: { id: true, isMinor: true, dateOfBirth: true } },
    },
  });
  if (!user || user.deletedAt) return { ok: false, error: "removed" };
  if (parentalConsentEnforced() && user.role === "MEMBER" && user.memberProfile && resolveIsMinor(user.memberProfile)) {
    if (!(await childHasCurrentConsent(user.memberProfile.id))) return { ok: false, error: "consent" };
  }
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  invalidatePermissionCache(user.id);
  return { ok: true, user: { id: user.id, clubId: user.clubId, email: user.email, firstName: user.firstName, lastName: user.lastName, role: user.role } };
}

// ── Linked sign-in methods ─────────────────────────────────────────────────

export async function findLinked(clubId: string, p: SocialProvider, subject: string) {
  return prisma.userIdentity.findUnique({
    where: { clubId_provider_providerSubject: { clubId, provider: providerKey(p), providerSubject: subject } },
    select: { id: true, userId: true, user: { select: { deletedAt: true } } },
  });
}

export type AttachResult = { ok: true } | { ok: false; error: "taken" };

/**
 * Connect this Google / Apple identity to an account. Refused when it already
 * belongs to a different login in the club (the unique index would refuse it
 * anyway; this says so in words).
 */
export async function attachIdentity(input: { userId: string; clubId: string; profile: ProviderProfile; refreshTokenEnc: string | null }): Promise<AttachResult> {
  const { userId, clubId, profile } = input;
  const existing = await findLinked(clubId, profile.provider, profile.subject);
  if (existing && existing.userId !== userId && !existing.user.deletedAt) return { ok: false, error: "taken" };
  const data = {
    userId,
    email: profile.email,
    emailIsRelay: profile.emailIsRelay,
    lastUsedAt: new Date(),
    ...(input.refreshTokenEnc ? { refreshTokenEnc: input.refreshTokenEnc } : {}),
  };
  if (existing) {
    // Same login, or a deleted one whose row is being taken over.
    await prisma.userIdentity.update({ where: { id: existing.id }, data });
  } else {
    await prisma.userIdentity.create({
      data: { ...data, clubId, provider: providerKey(profile.provider), providerSubject: profile.subject },
    });
  }
  return { ok: true };
}

/** A sign-in through an identity already linked: note when it was used, keep Apple's newest token. */
export async function touchIdentity(clubId: string, profile: ProviderProfile, refreshTokenEnc: string | null): Promise<void> {
  await prisma.userIdentity
    .update({
      where: { clubId_provider_providerSubject: { clubId, provider: providerKey(profile.provider), providerSubject: profile.subject } },
      data: { lastUsedAt: new Date(), email: profile.email, emailIsRelay: profile.emailIsRelay, ...(refreshTokenEnc ? { refreshTokenEnc } : {}) },
    })
    .catch(() => undefined);
}

/**
 * When the provider vouches for the account's own address: mark it proven and
 * run the existing "after verification, do the linking" step. Nothing weaker
 * (an unverified or relay address, or a different one) gets this far.
 */
export async function afterProviderProof(userId: string, profile: ProviderProfile): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, clubId: true, email: true, emailVerified: true } });
  if (!user || !provesAccountEmail(profile, user.email)) return;
  if (!user.emailVerified) await prisma.user.update({ where: { id: user.id }, data: { emailVerified: new Date() } });
  try {
    await completeEmailLinks(user);
  } catch (e) {
    console.error("[social] email links after provider proof failed", e);
  }
}

export const sha256b64u = (s: string) => createHash("sha256").update(s).digest("base64url");
