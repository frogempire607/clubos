import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "./prisma";
import { resolvePermissions } from "./permissions";

const isProd = process.env.NODE_ENV === "production";

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt" },
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
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password || !credentials?.clubSlug) {
          return null;
        }

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
        if (!club) return null;

        const user = await prisma.user.findUnique({
          where: {
            clubId_email: {
              clubId: club.id,
              email: emailNormalized,
            },
          },
          include: { staffProfile: { select: { permissions: true } } },
        });
        if (!user || user.deletedAt) return null;

        const valid = await bcrypt.compare(credentials.password, user.passwordHash);
        if (!valid) return null;

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
              ? resolvePermissions(user.staffProfile?.permissions ?? null)
              : null,
        } as any;
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = (user as any).role;
        token.clubId = (user as any).clubId;
        token.permissions = (user as any).permissions ?? null;
      }
      return token;
    },
    async session({ session, token }) {
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
