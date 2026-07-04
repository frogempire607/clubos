import { prisma } from "@/lib/prisma";

// Event group chats
// -----------------
// One MessageGroup per Event (MessageGroup.eventId @unique). Access is NOT a
// fixed member list: a user may read/post while they (or a child they manage)
// hold a live registration for the event — a Booking that isn't CANCELED or an
// EventRegistration that isn't CANCELED. Owner/staff always have access from
// the dashboard side. MessageGroupMember rows are still created (lazily) so
// the chat shows up in the member's group list and read receipts work, but
// the junction row alone is never trusted for an event-linked group: the
// registration check runs on every open (see /api/member/messages/groups/[id]).

/**
 * User ids that may currently access an event's chat because of a live
 * registration: the registered member's own login plus every guardian login
 * linked to that member (a registered minor's parent gets the chat).
 */
export async function eligibleEventChatUserIds(eventId: string, clubId: string): Promise<Set<string>> {
  const [bookings, registrations] = await Promise.all([
    prisma.booking.findMany({
      where: { eventId, status: { not: "CANCELED" }, event: { clubId } },
      select: { memberId: true },
    }),
    prisma.eventRegistration.findMany({
      where: { eventId, clubId, status: { not: "CANCELED" }, memberId: { not: null } },
      select: { memberId: true },
    }),
  ]);

  const memberIds = new Set<string>();
  for (const b of bookings) memberIds.add(b.memberId);
  for (const r of registrations) if (r.memberId) memberIds.add(r.memberId);
  if (memberIds.size === 0) return new Set();

  const members = await prisma.member.findMany({
    where: { id: { in: [...memberIds] }, clubId, deletedAt: null },
    select: { userId: true, guardianLinks: { select: { userId: true } } },
  });

  const userIds = new Set<string>();
  for (const m of members) {
    if (m.userId) userIds.add(m.userId);
    for (const link of m.guardianLinks) userIds.add(link.userId);
  }
  return userIds;
}

/** Is this user (self or via a managed child) registered for the event? */
export async function userCanAccessEventChat(userId: string, clubId: string, eventId: string): Promise<boolean> {
  const eligible = await eligibleEventChatUserIds(eventId, clubId);
  return eligible.has(userId);
}

/**
 * Get (or lazily create) the chat group for an event, then sync membership:
 * every currently-eligible user gets a junction row; MEMBER-role rows whose
 * registration went away are removed (owner/staff rows are kept so moderators
 * stay in the thread). Returns the group id, or null when the event doesn't
 * exist in this club.
 */
export async function getOrCreateEventChat(
  eventId: string,
  clubId: string,
  createdById: string,
): Promise<{ groupId: string } | null> {
  const event = await prisma.event.findFirst({
    where: { id: eventId, clubId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!event) return null;

  let group = await prisma.messageGroup.findFirst({
    where: { eventId, clubId },
    select: { id: true },
  });
  if (!group) {
    try {
      group = await prisma.messageGroup.create({
        data: {
          clubId,
          name: `${event.name} — event chat`,
          type: "GROUP",
          filterType: "custom",
          eventId,
          createdById,
        },
        select: { id: true },
      });
    } catch {
      // Unique race: someone else created it between the find and the create.
      group = await prisma.messageGroup.findFirst({ where: { eventId, clubId }, select: { id: true } });
      if (!group) return null;
    }
  }

  await syncEventChatMembers(group.id, eventId, clubId);
  return { groupId: group.id };
}

/** Reconcile junction rows with current registrations. */
export async function syncEventChatMembers(groupId: string, eventId: string, clubId: string): Promise<void> {
  const eligible = await eligibleEventChatUserIds(eventId, clubId);

  const current = await prisma.messageGroupMember.findMany({
    where: { groupId },
    select: { id: true, userId: true, user: { select: { role: true } } },
  });
  const currentIds = new Set(current.map((m) => m.userId));

  const toAdd = [...eligible].filter((id) => !currentIds.has(id));
  // Only revoke plain member logins; owner/staff moderators keep their rows.
  const toRemove = current.filter((m) => m.user.role === "MEMBER" && !eligible.has(m.userId));

  if (toAdd.length > 0) {
    await prisma.messageGroupMember.createMany({
      data: toAdd.map((userId) => ({ groupId, userId })),
      skipDuplicates: true,
    });
  }
  if (toRemove.length > 0) {
    await prisma.messageGroupMember.deleteMany({ where: { id: { in: toRemove.map((m) => m.id) } } });
  }
}

/** Ensure a specific user has a junction row (used after an eligibility check). */
export async function ensureEventChatMember(groupId: string, userId: string): Promise<void> {
  await prisma.messageGroupMember.createMany({
    data: [{ groupId, userId }],
    skipDuplicates: true,
  });
}
