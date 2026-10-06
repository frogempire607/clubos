// Which club member an anonymous signup is for — the database half of
// lib/registrationLink.matchMemberForPublicSignup. Shared by the public
// register route and the price quote, so the price a family is shown before
// they submit is decided by the same match that decides what they're charged.

import { prisma } from "@/lib/prisma";
import { matchMemberForPublicSignup } from "@/lib/registrationLink";

/**
 * Match by email AND name. The email finds the household — the athlete's own
 * address, or a guardian's — and the name picks the athlete inside it. Email
 * alone put two brothers registered by one parent on the same member record
 * (2026-10). Exactly one name match links; anything else is null.
 */
export async function findMemberForPublicSignup(args: {
  clubId: string;
  email: string;
  name: string;
}): Promise<string | null> {
  const signupEmail = args.email.trim().toLowerCase();
  if (!signupEmail || !args.name.trim()) return null;
  const emailIs = { equals: signupEmail, mode: "insensitive" as const };
  const candidates = await prisma.member.findMany({
    where: {
      clubId: args.clubId,
      deletedAt: null,
      OR: [
        { email: emailIs },
        { guardianEmail: emailIs },
        { user: { email: emailIs } },
        { guardian: { email: emailIs } },
        { guardianLinks: { some: { status: { not: "REVOKED" }, user: { email: emailIs } } } },
      ],
    },
    select: { id: true, firstName: true, lastName: true },
    take: 50,
  });
  return matchMemberForPublicSignup({ name: args.name, candidates });
}
