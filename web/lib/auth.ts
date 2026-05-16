import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "./prisma";
import { resolvePermissions } from "./permissions";

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
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

        const club = await prisma.club.findUnique({
          where: { slug: credentials.clubSlug },
        });
        if (!club) return null;

        const user = await prisma.user.findUnique({
          where: {
            clubId_email: {
              clubId: club.id,
              email: credentials.email.toLowerCase(),
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
