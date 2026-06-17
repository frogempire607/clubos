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

  // Fallback: unclaimed member with the same email.
  //
  // Skip minors. A minor is reached by their guardian through the guardian-link
  // system, not by silently claiming a same-email member row as the logged-in
  // user's OWN profile — otherwise a guardian whose email also sits on the
  // minor's record would auto-become the child. A minor who legitimately has
  // their own login gets member.userId set explicitly (e.g. at activation), so
  // they resolve via the userId path above and never need this fallback.
  const byEmail = await prisma.member.findFirst({
    where: {
      clubId,
      email: userEmail.toLowerCase(),
      deletedAt: null,
      userId: null,
      isMinor: false,
    },
  });
  if (!byEmail) return null;

  return prisma.member.update({
    where: { id: byEmail.id },
    data: { userId },
  });
}
