// The last spot in a class day is taken once.
//
// Same shape as lib/eventCapacityServer.ts: the count and the create happen
// together, one booking at a time per class day, behind a transaction-scoped
// advisory lock keyed on the class session. Two families tapping Book on the
// last spot at the same moment: the second waits for the first, then sees the
// day is full.
//
// A class with no capacity takes no lock and costs nothing extra.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { classIsFull, classLimit } from "@/lib/classCapacity";
import type { CapacityGuarded } from "@/lib/eventCapacityServer";

/** How many spots are taken on this class day right now. */
export function countClassSpotsTaken(classSessionId: string, db: Prisma.TransactionClient = prisma as unknown as Prisma.TransactionClient): Promise<number> {
  return db.attendanceRecord.count({ where: { classSessionId } });
}

/**
 * Run `create` only if the class day still has room, with nobody else able to
 * take the same spot in between. `full: true` = nothing was created.
 */
export async function withClassCapacityLock<T>(
  args: { classSessionId: string; capacity: number | null | undefined },
  create: (db: Prisma.TransactionClient) => Promise<T>,
): Promise<CapacityGuarded<T>> {
  const limit = classLimit(args.capacity);
  if (limit == null) {
    return { full: false, value: await create(prisma as unknown as Prisma.TransactionClient) };
  }
  const lockKey = "clscap:" + args.classSessionId;
  return prisma.$transaction(async (db) => {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
    const taken = await countClassSpotsTaken(args.classSessionId, db);
    if (classIsFull(limit, taken)) return { full: true as const };
    return { full: false as const, value: await create(db) };
  });
}
