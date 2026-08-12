/**
 * Delete a test event and everything hanging off it.
 *
 * Written for the 2026-08-12 "Test" event: a $0 APPROVED registration with a
 * Booking, created while `publicFixedPrice` was quoting walk-ins nothing on a
 * member-priced event. It is a test record, and leaving an approved-but-free
 * row in the table would skew every future "who owes what" query.
 *
 * DRY RUN BY DEFAULT. Requires an explicit event id to act:
 *
 *   npx tsx scripts/delete-test-event.ts --event <id>            # report only
 *   npx tsx scripts/delete-test-event.ts --event <id> --apply    # delete
 *
 * Refuses any event that has money attached — a SUCCEEDED/PENDING Transaction,
 * an amountPaid, or a Stripe PaymentIntent on a registration. Deleting rows
 * that money touched is a reconciliation problem, not a cleanup.
 *
 * The delete is a HARD delete of the Event; Prisma cascades to its
 * registrations and bookings (both onDelete: Cascade). EmailSend rows keep
 * their `relatedEventId` as a scalar with no FK — the send ledger is an audit
 * trail and outlives the object it refers to, deliberately.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
const APPLY = process.argv.includes("--apply");
const eventId = arg("event");

async function main() {
  if (!eventId) {
    console.error("REFUSING: pass --event <id>. This script never guesses which event you mean.");
    process.exit(1);
  }

  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, name: true, clubId: true, startsAt: true, publicSlug: true, deletedAt: true },
  });
  if (!event) {
    console.error(`No event ${eventId}.`);
    process.exit(1);
  }

  const regs = await prisma.eventRegistration.findMany({
    where: { eventId },
    select: {
      id: true, name: true, status: true, amountDue: true, amountPaid: true,
      transactionId: true, stripePaymentIntentId: true, paymentMethod: true,
    },
  });
  const bookings = await prisma.booking.count({ where: { eventId } });
  const txs = await prisma.transaction.findMany({
    where: { eventId, status: { in: ["SUCCEEDED", "PENDING"] } },
    select: { id: true, amount: true, status: true, description: true },
  });

  console.log(`Event   ${event.name}  (${event.id})`);
  console.log(`Club    ${event.clubId}`);
  console.log(`Starts  ${event.startsAt.toISOString()}`);
  console.log(`Slug    ${event.publicSlug ?? "—"}`);
  console.log(`Would delete: ${regs.length} registration(s), ${bookings} booking(s)`);
  for (const r of regs) {
    console.log(
      `  · ${r.name} — ${r.status} · due ${r.amountDue ?? 0} · paid ${r.amountPaid ?? 0} · ${r.paymentMethod ?? "no method"}`,
    );
  }

  const moneyReasons: string[] = [];
  if (txs.length > 0) moneyReasons.push(`${txs.length} live Transaction(s): ${txs.map((t) => `${t.status} $${t.amount}`).join(", ")}`);
  for (const r of regs) {
    if (Number(r.amountPaid ?? 0) > 0) moneyReasons.push(`${r.name} has amountPaid ${r.amountPaid}`);
    if (r.stripePaymentIntentId) moneyReasons.push(`${r.name} has PaymentIntent ${r.stripePaymentIntentId}`);
    if (r.transactionId) moneyReasons.push(`${r.name} points at Transaction ${r.transactionId}`);
  }
  if (moneyReasons.length > 0) {
    console.error("\nREFUSING — money is attached to this event:");
    for (const m of moneyReasons) console.error(`  · ${m}`);
    console.error("Resolve or void those first. This script only removes records nothing was collected against.");
    process.exit(1);
  }

  if (!APPLY) {
    console.log("\nDRY RUN — nothing deleted. Re-run with --apply to delete.");
    return;
  }

  const deleted = await prisma.event.delete({ where: { id: eventId }, select: { id: true, name: true } });
  console.log(`\nDeleted event ${deleted.name} (${deleted.id}) and its cascaded registrations + bookings.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
