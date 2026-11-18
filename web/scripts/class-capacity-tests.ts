/**
 * Class limits (owner decision 2026-11-17).
 *
 *   npx tsx scripts/class-capacity-tests.ts
 *
 * No database, no network.
 *
 *   1  no capacity = unlimited; a capacity counts spots per class day
 *   2  a full day reads "Full" and cannot be booked; a booked member keeps theirs
 *   3  staff get a clear warning, and are not blocked
 *   4  the last spot is taken once (count + create under one lock)
 *   5  every member path that takes a spot goes through the lock
 *   6  nothing here removes an existing booking
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLASS_FULL_BODY, CLASS_FULL_LABEL, classIsFull, classLimit, classSpotsLeft, fullDayOffer, overLimitWarning } from "../lib/classCapacity";

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

console.log("\n§1 unlimited unless a capacity is set");
check("no capacity: never full, however many are booked", !classIsFull(null, 500) && !classIsFull(undefined, 500));
check("no capacity: no spots-left number to show", classSpotsLeft(null, 3) === null);
check("a capacity of 0 or less is treated as not set", classLimit(0) === null && classLimit(-4) === null && !classIsFull(0, 10));
check("12 spots, 11 taken: one left, not full", classSpotsLeft(12, 11) === 1 && !classIsFull(12, 11));
check("12 spots, 12 taken: full", classIsFull(12, 12) && classSpotsLeft(12, 12) === 0);
check("a day already over its limit before this shipped is full, never negative", classIsFull(12, 15) && classSpotsLeft(12, 15) === 0);

console.log("\n§2 what a member is offered on a full day");
{
  const open = { canBook: true, statusText: "Included in your membership", bookingStatus: null as string | null, price: null };
  const full = fullDayOffer(open, true);
  check("not booked: reads Full and cannot be booked", full.statusText === CLASS_FULL_LABEL && full.canBook === false);
  check("a day with room is offered unchanged", fullDayOffer(open, false) === open);
  const booked = { canBook: false, statusText: "Booked", bookingStatus: "PRESENT" as string | null };
  check("already booked: their booking still reads Booked", fullDayOffer(booked, true) === booked);
  check("the refusal carries a code the app can recognise", CLASS_FULL_BODY.code === "CLASS_FULL" && /full/i.test(CLASS_FULL_BODY.error));
}

console.log("\n§3 staff are warned, not blocked");
{
  check("room left: no warning", overLimitWarning(12, 11) === null);
  check("no capacity: no warning", overLimitWarning(null, 40) === null);
  const w = overLimitWarning(12, 12, "Ava Stone") ?? "";
  check("full: the warning says how many are taken and what adding does", w.includes("12 of 12") && w.includes("Ava Stone") && w.includes("13 of 12"), w);
  const page = code("app/dashboard/attendance/page.tsx");
  check("the attendance Add panel shows the warning", page.includes("overLimitWarning(") && page.includes('role="alert"'));
  for (const f of ["app/api/attendance/route.ts", "app/api/attendance/charge/route.ts", "app/api/attendance/charge-card/route.ts", "app/api/classes/[id]/charge/route.ts"]) {
    check(`staff route can still add over the limit: ${f}`, !code(f).includes("CLASS_FULL") && !code(f).includes("withClassCapacityLock"));
  }
}

console.log("\n§4 the last spot is taken once");
{
  const srv = code("lib/classCapacityServer.ts");
  const lock = srv.indexOf("pg_advisory_xact_lock");
  const count = srv.indexOf("countClassSpotsTaken(args.classSessionId, db)");
  const create = srv.indexOf("await create(db)");
  check("lock, then count, then create, in that order", lock > 0 && lock < count && count < create);
  check("all three run in one transaction", srv.includes("prisma.$transaction(async (db)"));
  check("the lock is per class day, so two classes never wait on each other", srv.includes('"clscap:" + args.classSessionId'));
  check("a class with no capacity takes no lock", /if \(limit == null\) \{\s*return \{ full: false, value: await create\(/.test(srv));
  check("it is the same lock shape as the event fix", code("lib/eventCapacityServer.ts").includes("pg_advisory_xact_lock"));
}

console.log("\n§5 every member path that takes a spot is guarded");
{
  const book = code("app/api/member/classes/book/route.ts");
  check("booking: no attendance row is created outside the lock", !book.includes("prisma.attendanceRecord.create("));
  check("booking: all four free paths (covered, trial, plan-day, 100% code) use the lock", (book.match(/withClassCapacityLock\(capacityArgs/g) ?? []).length === 4);
  check("booking: each one answers Full when the spot is gone", (book.match(/if \(spot\.full\) return classFull\(\)/g) ?? []).length === 4);
  const early = book.indexOf("CLASS_FULL_BODY, { status: 409 }");
  check("booking: a full class is refused before the Stripe page is opened", early > 0 && early < book.indexOf("stripe.checkout.sessions.create"));
  check("booking: and before a parent is asked to approve it", early < book.indexOf("applyParentalControls("));
  const door = code("app/api/member/checkin/[id]/route.ts");
  check("door scan without a booking: takes the spot under the lock", door.includes("withClassCapacityLock(") && door.includes("CLASS_FULL_BODY"));
  check("door scan: the free trial starts only after the spot is theirs", door.indexOf("withClassCapacityLock(") < door.lastIndexOf("data: { trialEndsAt }"));
  const hook = code("app/api/stripe/webhook/route.ts");
  check("a payment that lands after the class filled is still seated, and marked", hook.includes("paidIntoFull") && hook.includes("over the class limit"));
  const sched = code("app/api/member/schedule/route.ts");
  check("the member schedule marks a full day", sched.includes("fullDayOffer(") && sched.includes("classIsFull(sessionItem.recurringClass.capacity, sessionItem._count.attendance)"));
}

console.log("\n§6 existing bookings are never removed");
for (const f of ["lib/classCapacity.ts", "lib/classCapacityServer.ts"]) {
  const src = code(f);
  check(`${f} deletes and updates nothing`, !/\.(delete|deleteMany|update|updateMany)\(/.test(src));
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
