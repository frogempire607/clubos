/**
 * Every address that belongs to somebody who manages a member.
 *
 * Feeds the duplicate detector's "this is a shared GUARDIAN, not a shared
 * PERSON" rule (see lib/memberDuplicates.ts). Split out so the two callers —
 * the duplicates page and the roster's possible-duplicates count — build the
 * same map, because a count that disagrees with the list it opens is the exact
 * class of bug D-3 was.
 *
 * ── Which addresses count ───────────────────────────────────────────────────
 *
 * For each CONFIRMED guardian link on the member:
 *   • the guardian's LOGIN email (`users.email`) — the one they actually sign
 *     in with, and the one most likely to have been typed into a child's own
 *     contact field at import;
 *   • the guardian's member-record contact email and phone, when they have one.
 *
 * PENDING links are excluded on purpose: an unconfirmed link grants nothing,
 * and treating it as proof of a family relationship would let anyone suppress
 * duplicate detection by proposing a link.
 */

import { prisma } from "@/lib/prisma";

/** memberId → every email/phone belonging to one of its confirmed guardians. */
export type GuardianContactMap = Map<string, string[]>;

export async function loadGuardianContacts(
  clubId: string,
  memberIds: string[],
): Promise<GuardianContactMap> {
  const map: GuardianContactMap = new Map();
  if (memberIds.length === 0) return map;

  try {
    const links = await prisma.memberGuardianUser.findMany({
      where: { clubId, memberId: { in: memberIds }, status: "CONFIRMED" },
      select: {
        memberId: true,
        user: {
          select: {
            email: true,
            // The guardian's own member record, when they have one — an adult
            // who is also a member keeps their contact details there.
            memberProfile: { select: { email: true, phone: true } },
          },
        },
      },
    });

    for (const l of links) {
      const list = map.get(l.memberId) ?? [];
      for (const v of [l.user?.email, l.user?.memberProfile?.email, l.user?.memberProfile?.phone]) {
        if (v) list.push(v);
      }
      map.set(l.memberId, list);
    }
  } catch (e) {
    // Degrading to the guardianEmail/guardianPhone columns is the previous
    // behaviour — worse, but not wrong. Failing the whole duplicates page
    // because this lookup broke would be.
    console.error("[guardianContacts] lookup failed", e);
  }

  return map;
}
