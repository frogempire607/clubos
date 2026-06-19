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

/**
 * After member(s) are soft-deleted and their `userId` released, soft-delete any
 * of those member LOGINS that are now orphaned — this is what makes "delete a
 * member" also remove their ability to sign in (NextAuth `authorize` rejects a
 * User with `deletedAt` set).
 *
 * Safe by construction — a login is removed ONLY if it is:
 *   - a MEMBER-role User in this club (never an OWNER/STAFF account), AND
 *   - not already deleted, AND
 *   - not still the OWN login of another live member, AND
 *   - not still a guardian of any live member (so a parent who manages other
 *     children, or whose own membership is still active, keeps their login).
 *
 * Set-based (4 queries total) so it scales to large bulk deletes. Pass the
 * `userId`s captured from the members BEFORE their `userId` was nulled.
 */
export async function deleteOrphanedMemberLogins(
  userIds: (string | null | undefined)[],
  clubId: string,
): Promise<number> {
  const ids = Array.from(new Set(userIds.filter((u): u is string => !!u)));
  if (ids.length === 0) return 0;

  // Candidate logins: MEMBER-role users in this club that aren't already deleted.
  const candidates = await prisma.user.findMany({
    where: { id: { in: ids }, clubId, role: "MEMBER", deletedAt: null },
    select: { id: true },
  });
  if (candidates.length === 0) return 0;
  const candidateIds = candidates.map((u) => u.id);

  // Keep any still attached to a LIVE member — as own login or as a guardian.
  const [stillOwn, stillGuard] = await Promise.all([
    prisma.member.findMany({
      where: { userId: { in: candidateIds }, deletedAt: null },
      select: { userId: true },
    }),
    prisma.memberGuardianUser.findMany({
      where: { userId: { in: candidateIds }, member: { deletedAt: null } },
      select: { userId: true },
    }),
  ]);
  const keep = new Set<string>();
  for (const m of stillOwn) if (m.userId) keep.add(m.userId);
  for (const g of stillGuard) keep.add(g.userId);

  const toDelete = candidateIds.filter((id) => !keep.has(id));
  if (toDelete.length === 0) return 0;

  const res = await prisma.user.updateMany({
    where: { id: { in: toDelete } },
    data: { deletedAt: new Date() },
  });
  return res.count;
}
