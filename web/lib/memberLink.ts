import { prisma } from "@/lib/prisma";
import type { Member } from "@prisma/client";

/**
 * Resolves the Member record for a portal session.
 *
 * Primary path: look up by Member.userId (set during signup when the club
 * already had a matching record, or by a previous auto-link).
 *
 * Fallback path: if no userId-linked member is found, search for an unclaimed
 * Member with the same email address and silently link it. This self-heals the
 * common case where a club owner added the member *after* they already created
 * a portal account, leaving Member.userId = null.
 */
export async function findOrAutoLinkMember(
  userId: string,
  clubId: string,
  userEmail: string,
): Promise<Member | null> {
  const byUserId = await prisma.member.findFirst({
    where: { userId, clubId, deletedAt: null },
  });
  if (byUserId) return byUserId;

  // Fallback: unclaimed member with the same email
  const byEmail = await prisma.member.findFirst({
    where: {
      clubId,
      email: userEmail.toLowerCase(),
      deletedAt: null,
      userId: null,
    },
  });
  if (!byEmail) return null;

  return prisma.member.update({
    where: { id: byEmail.id },
    data: { userId },
  });
}
