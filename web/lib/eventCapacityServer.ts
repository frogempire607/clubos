// The last spot in an event is sold once.
//
// The public registration route counted the spots taken, then (several
// awaits later) created the registration. Two people registering for the last
// spot at the same moment both passed the count, and both got in: an event
// one over its limit, and — for a paid event — a refund to arrange.
//
// Here the count and the create happen together, one registration at a time
// per event: a transaction-scoped advisory lock keyed on the event makes the
// second person wait for the first, and then see the spot is gone. It is the
// same kind of lock the member route already uses to stop a double tap
// creating two registrations.
//
// An event with no capacity limit takes no lock and costs nothing extra.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { capacityWhere } from "@/lib/eventPayments";

export type CapacityGuarded<T> = { full: true } | { full: false; value: T };

/** PURE: is there room, given the limit and what is already taken? */
export function hasRoom(capacity: number | null | undefined, taken: number): boolean {
  return capacity == null || taken < capacity;
}

export async function withEventCapacityLock<T>(
  args: { eventId: string; capacity: number | null | undefined; holdSpotDuringReview: boolean },
  create: (db: Prisma.TransactionClient) => Promise<T>,
): Promise<CapacityGuarded<T>> {
  if (args.capacity == null) {
    return { full: false, value: await create(prisma as unknown as Prisma.TransactionClient) };
  }
  const capacity = args.capacity;
  const lockKey = "evcap:" + args.eventId;
  return prisma.$transaction(async (db) => {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
    // Counted the same way the route counts for display: spot-holding
    // registrations (real ones, plus card checkouts inside their hold window)
    // and confirmed bookings.
    const [registrations, bookings] = await Promise.all([
      db.eventRegistration.count({
        where: { eventId: args.eventId, ...capacityWhere(new Date(), { holdSpotDuringReview: args.holdSpotDuringReview }) },
      }),
      db.booking.count({ where: { eventId: args.eventId, status: { notIn: ["CANCELED"] } } }),
    ]);
    if (!hasRoom(capacity, registrations + bookings)) return { full: true as const };
    return { full: false as const, value: await create(db) };
  });
}
