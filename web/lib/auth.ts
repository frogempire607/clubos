import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "./prisma";
import { resolvePermissions } from "./permissions";
import { liveUser } from "./apiGuard";
import { rateLimit } from "./ratelimit";
import { resolveIsMinor, childHasCurrentConsent, parentalConsentEnforced } from "./parentalConsent";

const isProd = process.env.NODE_ENV === "production";

// What the session carries for a STAFF user: every permission level resolved,
// PLUS the sub-scope maps. The sub-scopes used to be dropped here (only
// resolvePermissions' flat levels were kept), so `requireMessagesSubScope` and
// the billing transfer switch read defaults no matter what the owner granted.
export function sessionPermissions(raw: unknown): Record<string, unknown> {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...resolvePermissions(obj) };
  for (const k of ["messages_subScopes", "billing_subScopes"]) {
    if (obj[k] && typeof obj[k] === "object") out[k] = obj[k];
  }
  return out;
}

// Precomputed bcrypt hash (cost 12), used ONLY to equalize login response
// timing on the club/user-not-found paths. Without it, a missing email returns
// before bcrypt runs while a real email pays the ~250ms hash cost — that delta
// lets an attacker enumerate which emails exist in a club. Computed once at
// module load.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync("athletixos-login-timing-equalizer", 12);

export const authOptions: NextAuthOptions = {
  // 14-day session lifetime (default was 30d). Owners use the dashboard daily
  // so they'll never see the prompt; members on the native shell get a fresh
  // login every two weeks — tighter window for a stolen cookie to be useful.
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 14 },
  pages: { signIn: "/login" },
  // Explicit cookie config. NextAuth's defaults derive cookie name and
  // `secure` from NEXTAUTH_URL. If NEXTAUTH_URL is missing/malformed (we
  // hit one such .env in the wild), the auto-detection can pick the
  // __Secure- prefix even on http://localhost, which Safari refuses to
  // store on an insecure origin — login succeeds, no cookie persists,
  // user bounces back to /login. Pinning name + secure to NODE_ENV
  // removes that dependency entirely.
  useSecureCookies: isProd,
  cookies: {
    sessionToken: {
      name: `${isProd ? "__Secure-" : ""}next-auth.session-token`,
      options: { httpOnly: true, sameSite: "lax", path: "/", secure: isProd },
    },
    callbackUrl: {
      name: `${isProd ? "__Secure-" : ""}next-auth.callback-url`,
      options: { sameSite: "lax", path: "/", secure: isProd },
    },
    csrfToken: {
      name: `${isProd ? "__Host-" : ""}next-auth.csrf-token`,
      options: { httpOnly: true, sameSite: "lax", path: "/", secure: isProd },
    },
  },
  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        clubSlug: { label: "Club", type: "text" },
      },
      async authorize(credentials, req) {
        if (!credentials?.email || !credentials?.password || !credentials?.clubSlug) {
          return null;
        }

        // Rate-limit login attempts per IP. 10 attempts per 10 minutes leaves
        // headroom for typos but blocks credential stuffing / brute force.
        // Returning null on rate-limit triggers a generic "CredentialsSignin"
        // error to the client — no timing oracle distinguishing it from a
        // wrong password.
        const ip =
          (req?.headers?.["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ||
          (req?.headers?.["x-real-ip"] as string | undefined) ||
          "unknown";
        const rl = rateLimit({ key: `auth:login:${ip}`, limit: 10, windowMs: 10 * 60_000 });
        if (!rl.allowed) return null;

        // iOS WKWebView's default keyboard auto-capitalizes the first
        // letter of <input type="text"> and may auto-correct, so a slug
        // typed as `apex-wrestling` arrives as `Apex-wrestling`. The
        // login form now disables autocaps; this normalization is a
        // belt-and-suspenders so a misbehaving keyboard or autofill on
        // any surface can't lock a user out of their club.
        const emailNormalized = credentials.email.trim().toLowerCase();
        const slugNormalized = credentials.clubSlug.trim().toLowerCase();

        const club = await prisma.club.findUnique({
          where: { slug: slugNormalized },
        });

        const user = club
          ? await prisma.user.findUnique({
              where: {
                clubId_email: {
                  clubId: club.id,
                  email: emailNormalized,
                },
              },
              include: {
                staffProfile: { select: { permissions: true } },
                memberProfile: { select: { id: true, isMinor: true, dateOfBirth: true } },
              },
            })
          : null;

        // Always run EXACTLY ONE bcrypt comparison — even when the club or user
        // doesn't exist — so response time can't reveal which emails are
        // registered (user-enumeration timing oracle). The dummy hash makes the
        // not-found path do the same work as a real check. Behavior is otherwise
        // unchanged: every failure path still returns the same generic null.
        const activeHash =
          user && !user.deletedAt && user.passwordHash ? user.passwordHash : null;
        const valid = await bcrypt.compare(credentials.password, activeHash ?? DUMMY_PASSWORD_HASH);

        if (!club || !user || user.deletedAt || !activeHash || !valid) return null;

        // COPPA: a MINOR's OWN login is blocked until a parent/guardian has
        // recorded a current parental consent for them. This never blocks
        // adults, guardians, owners, or staff — a guardian who manages a minor
        // still signs in normally and is gated per-child inside the member
        // portal, so club operations are never interrupted. Throwing (vs null)
        // surfaces a distinct message on the login page.
        if (parentalConsentEnforced() && user.role === "MEMBER" && user.memberProfile && resolveIsMinor(user.memberProfile)) {
          const consented = await childHasCurrentConsent(user.memberProfile.id);
          if (!consented) {
            throw new Error("A parent or guardian must complete consent before this account can be used.");
          }
        }

        await prisma.user.update({
          where: { id: user.id },
          data: { lastLoginAt: new Date() },
        });

        return {
          id: user.id,
          email: user.email,
          name: `${user.firstName} ${user.lastName}`,
          role: user.role,
          clubId: user.clubId,
          // Resolved staff permissions snapshot. Owners bypass checks so the
          // value is irrelevant for them. Staleness note: if an owner edits a
          // staff member's permissions, that member must re-login to refresh
          // this token; the live nav uses /api/me so the UI is never stale.
          permissions:
            user.role === "STAFF"
              ? sessionPermissions(user.staffProfile?.permissions ?? null)
              : null,
        } as any;
      },
    }),
  ],
  callbacks: {
    // Runs at sign-in AND on every getServerSession() / /api/auth/session read.
    //
    // Session revocation without waiting 14 days for the token to expire: each
    // read re-checks the user against the database (lib/apiGuard.ts `liveUser`,
    // one indexed lookup cached 20s per server instance).
    //   - removed (deletedAt), missing, or moved to another club → the token is
    //     marked `revoked`, the session callback below returns an empty session,
    //     getServerSession() yields null and every API route answers 401.
    //   - role or permissions changed → refreshed into the token, so a demotion
    //     or a narrowed permission applies within the cache window (and a grant
    //     does too — including the messages/billing sub-scopes, which used to be
    //     dropped from the token entirely).
    // If the lookup itself fails the token is left as it was: signing everyone
    // out on a database blip would be worse, and the routes that change money or
    // staff use the *Live guards, which fail closed on their own.
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = (user as any).role;
        token.clubId = (user as any).clubId;
        token.permissions = (user as any).permissions ?? null;
        delete (token as any).revoked;
        return token;
      }
      if ((token as any).revoked) return token; // sticky — sign in again
      if (!token.id) return token;
      const live = await liveUser(token.id as string);
      if (live === undefined) return token;
      if (!live || live.deleted || live.clubId !== token.clubId) {
        (token as any).revoked = true;
        (token as any).permissions = null;
        return token;
      }
      token.role = live.role as typeof token.role;
      (token as any).permissions = live.role === "STAFF" ? sessionPermissions(live.perms) : null;
      return token;
    },
    async session({ session, token }) {
      // A revoked token yields NO session: next-auth treats an empty body as
      // "not signed in", so getServerSession() returns null and the client's
      // useSession() flips to unauthenticated on its next refresh.
      if ((token as any).revoked) return {} as typeof session;
      if (session.user) {
        (session.user as any).id = token.id;
        (session.user as any).role = token.role;
        (session.user as any).clubId = token.clubId;
        (session.user as any).permissions = (token as any).permissions ?? null;
      }
      return session;
    },
  },
};
