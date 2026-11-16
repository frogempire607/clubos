// Record a Stripe payment exactly once, and let the caller carry on either way.
//
// `transactions.stripePaymentIntentId` is unique, so a second insert for the
// same payment throws. In the webhook that throw used to end the handler — and
// the webhook answers 200 on any error, so Stripe never tried again. The case
// that bit: a first delivery that wrote the Transaction and was then cut off
// (function timeout, connection blip) before the follow-up write. Stripe
// retried, the insert collided, the handler stopped, and the follow-up never
// ran: money recorded, registration still "awaiting payment" — a family that
// paid and shows as unpaid, with no spot and no receipt.
//
// With this, the retry finds the row the first attempt wrote and continues to
// the follow-up writes, which are all written to be safe to repeat.

import { Prisma, type Transaction } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/** True for Prisma's unique-constraint error. */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

type Db = {
  transaction: {
    findUnique(args: { where: { stripePaymentIntentId: string } }): Promise<Transaction | null>;
    create(args: { data: Prisma.TransactionUncheckedCreateInput }): Promise<Transaction>;
  };
};

/**
 * Create the Transaction for a Stripe payment, or return the one already
 * recorded for the same PaymentIntent. `created` says which happened.
 *
 * Without a PaymentIntent id there is nothing to dedupe on and this is a plain
 * create. Takes the same `{ data }` shape as `prisma.transaction.create`.
 * `db` is injectable for tests.
 */
export async function createTransactionOnce(
  args: { data: Prisma.TransactionUncheckedCreateInput },
  db: Db = prisma as unknown as Db,
): Promise<{ tx: Transaction; created: boolean }> {
  const { data } = args;
  const pi = typeof data.stripePaymentIntentId === "string" && data.stripePaymentIntentId ? data.stripePaymentIntentId : null;
  if (!pi) return { tx: await db.transaction.create({ data }), created: true };

  const prior = await db.transaction.findUnique({ where: { stripePaymentIntentId: pi } });
  if (prior) return { tx: prior, created: false };
  try {
    return { tx: await db.transaction.create({ data }), created: true };
  } catch (err) {
    // Two deliveries racing: the other one inserted between our read and write.
    if (isUniqueViolation(err)) {
      const raced = await db.transaction.findUnique({ where: { stripePaymentIntentId: pi } });
      if (raced) return { tx: raced, created: false };
    }
    throw err;
  }
}
