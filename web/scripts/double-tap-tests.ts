/**
 * The last two double-tap money bugs (audit R9, 2026-11-15).
 *
 *   npx tsx scripts/double-tap-tests.ts
 *
 * No database, no network. These hold the two routes to the ORDER that makes
 * a second tap harmless; the order is the whole fix.
 *
 *   1  cash / check / card reader at the event door: one registration, one payment
 *   2  "Create payout records": one payable per coach
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const code = (rel: string) =>
  readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, (_m, p1) => p1);

let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : `  — ${detail}`}`);
}

console.log("\n§1 cash at the door");
{
  const src = code("app/api/events/[id]/charge/route.ts");
  const doorStart = src.indexOf('paymentMethod === "CASH" || paymentMethod === "TERMINAL" || paymentMethod === "CHECK"');
  const invoiceStart = src.indexOf('if (paymentMethod === "INVOICE")');
  const door = src.slice(doorStart, invoiceStart);
  const invoice = src.slice(invoiceStart);
  const lock = door.indexOf("pg_advisory_xact_lock");
  const find = door.indexOf("db.eventRegistration.findFirst(");
  const create = door.indexOf("db.eventRegistration.create(");
  const settle = door.indexOf("settleEventRegistrationOffline(");
  const booking = door.indexOf("prisma.booking.upsert(");
  check("the registration is looked up and created behind a lock", lock > 0 && lock < find && find < create);
  check("the lock is per member per event, the same key the member route uses", door.includes("`evreg:${event.id}:${memberId}`") && code("app/api/member/events/[id]/register/route.ts").includes("evreg:"));
  check("lookup and create share one transaction, so a second tap sees the first", door.slice(0, lock).includes("prisma.$transaction(async (db)") && !door.slice(lock, settle).includes("prisma.eventRegistration.create("));
  check("an already-paid registration is refused before any money is written", door.indexOf("claimed.paid") > create && door.indexOf("claimed.paid") < settle);
  check("money is written only by the shared settle path, after the lock", settle > create);
  check("the settle path claims the registration before writing money", /updateMany\(\{\s*where: \{ id: reg\.id, clubId, status: \{ notIn: \["PAID", "CANCELED"\] \} \}/.test(code("lib/eventOfflinePayments.ts")));
  check("a second spot for the same member cannot crash the request", booking > settle && !door.includes("prisma.booking.create({ data: { eventId: event.id, memberId, status } })"));
  check("no Transaction is created directly in the door branch", !door.slice(0, booking).includes("transaction.create("));
  const iLock = invoice.indexOf("pg_advisory_xact_lock");
  check("\"pay later by emailed link\" takes the same lock, so a double tap leaves one bill, not two", iLock > 0 && iLock < invoice.indexOf("db.eventRegistration.create(") && !invoice.includes("prisma.eventRegistration.create(") && !invoice.includes("prisma.booking.create("));
}

console.log("\n§2 payout records");
{
  const src = code("app/api/events/[id]/comp/generate-payouts/route.ts");
  const tx = src.indexOf("$transaction(async (db)");
  const create = src.indexOf("db.payout.create(");
  const claim = src.indexOf("db.eventCompAssignment.updateMany(");
  check("the payable and the claim are written in one transaction", tx > 0 && tx < create && create < claim);
  check("the claim only succeeds while the assignment is unclaimed", src.includes("where: { id: a.id, payoutId: null }"));
  check("losing the claim rolls the payable back", src.includes("if (claim.count !== 1) throw new AlreadyGenerated()"));
  check("and is counted as already generated, not as an error", /if \(!won\) \{\s*skippedExisting\+\+;\s*continue;/.test(src));
  check("no payable is created outside that transaction", !src.includes("prisma.payout.create("));
  check("the old unconditional claim is gone", !src.includes("prisma.eventCompAssignment.update("));
  check("a real failure still surfaces", src.includes("throw err;"));
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
