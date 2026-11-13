/**
 * A class day the CLUB cancelled stays visible to families, marked "Canceled"
 * (lib/memberClassCancel.ts + the two member feeds and their screens).
 *
 *   npx tsx scripts/schedule-cancelled-day-tests.ts
 *
 * No database, no network. The rules are pure; where the behaviour lives in a
 * route or a component the test reads the source. All dates are relative to
 * now — never a hard-coded calendar day.
 */
import fs from "node:fs";
import path from "node:path";
import {
  CANCELED_LABEL,
  bookingIsActionable,
  canceledDayOffer,
  classBookingState,
  isPastBooking,
  isUpcomingBooking,
  scrubCancelAudit,
  sharedCancelReason,
} from "../lib/memberClassCancel";

let pass = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}
function eq<T>(label: string, got: T, want: T) {
  check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
function section(name: string, fn: () => void) { console.log(`\n${name}`); fn(); }
const src = (rel: string) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

const HOUR = 3_600_000;
const now = Date.now();
const tomorrow = now + 24 * HOUR;
const yesterday = now - 24 * HOUR;

section("the reason a family may read", () => {
  eq("announced to booked families → shared", sharedCancelReason({ canceled: true, cancelReason: " Coach is ill ", cancelNotifyAudience: "BOOKED" }), "Coach is ill");
  eq("announced to both → shared", sharedCancelReason({ canceled: true, cancelReason: "Gym closed", cancelNotifyAudience: "BOTH" }), "Gym closed");
  eq("told nobody (NONE) → the reason stays a staff note", sharedCancelReason({ canceled: true, cancelReason: "Pay dispute", cancelNotifyAudience: "NONE" }), null);
  eq("no audience recorded → not shared", sharedCancelReason({ canceled: true, cancelReason: "x", cancelNotifyAudience: null }), null);
  eq("blank reason → none", sharedCancelReason({ canceled: true, cancelReason: "   ", cancelNotifyAudience: "BOOKED" }), null);
  eq("not cancelled → none, even with a stale reason", sharedCancelReason({ canceled: false, cancelReason: "old", cancelNotifyAudience: "BOOKED" }), null);
});

section("a cancelled day offers nothing to book", () => {
  const covered = { canBook: true, statusText: "Included in your membership", price: null as string | null, bookingLabel: "Members" as string | null, bookingTier: "MEMBERSHIP" };
  const paid = { canBook: true, statusText: "Purchase required", price: "25.00" as string | null, bookingLabel: "Drop-in" as string | null };
  eq("covered by a membership → still not bookable", canceledDayOffer(covered, true), { ...covered, canBook: false, statusText: "Canceled", price: null, bookingLabel: null });
  eq("priced → no price, no label, not bookable", canceledDayOffer(paid, true), { canBook: false, statusText: "Canceled", price: null, bookingLabel: null });
  eq("a day that is on is untouched", canceledDayOffer(paid, false), paid);
  eq("the word families read", CANCELED_LABEL, "Canceled");
});

section("a booked day the club cancelled reads Canceled instead of vanishing", () => {
  eq("on → Confirmed", classBookingState({ canceled: false }), { status: "CONFIRMED", dayCanceled: false, cancelReason: null });
  eq("cancelled, announced → Canceled with the reason", classBookingState({ canceled: true, cancelReason: "Snow", cancelNotifyAudience: "BOOKED" }), { status: "CANCELED", dayCanceled: true, cancelReason: "Snow" });
  eq("cancelled, told nobody → Canceled, no reason", classBookingState({ canceled: true, cancelReason: "Snow", cancelNotifyAudience: "NONE" }), { status: "CANCELED", dayCanceled: true, cancelReason: null });

  const cancelledDay = { status: "CANCELED", dayCanceled: true, startMs: tomorrow };
  check("it stays under Upcoming while it is still ahead", isUpcomingBooking(cancelledDay, now));
  check("…and is not also under Past", !isPastBooking(cancelledDay, now));
  check("once its time has passed it moves to Past", isPastBooking({ ...cancelledDay, startMs: yesterday }, now) && !isUpcomingBooking({ ...cancelledDay, startMs: yesterday }, now));
  check("a booking the FAMILY cancelled still leaves Upcoming (unchanged)", !isUpcomingBooking({ status: "CANCELED", startMs: tomorrow }, now) && isPastBooking({ status: "CANCELED", startMs: tomorrow }, now));
  check("a confirmed booking ahead is Upcoming (unchanged)", isUpcomingBooking({ status: "CONFIRMED", startMs: tomorrow }, now));
  check("a declined / completed private is Past (unchanged)", isPastBooking({ status: "DECLINED", startMs: tomorrow }, now) && isPastBooking({ status: "COMPLETED", startMs: tomorrow }, now));
  check("no check-in / cancel / manage on a cancelled day", !bookingIsActionable({ status: "CANCELED", dayCanceled: true }));
  check("…even if a caller left the status as Confirmed", !bookingIsActionable({ status: "CONFIRMED", dayCanceled: true }));
  check("a live booking is actionable", bookingIsActionable({ status: "CONFIRMED" }) && bookingIsActionable({ status: "WAITLISTED" }));
});

section("the staff-side audit never reaches a family's browser", () => {
  const row = {
    id: "s1", canceled: true, cancelReason: "Coach quit", cancelNotifyAudience: "NONE",
    canceledByUserId: "owner1", cancelNotifiedCount: 12, cancelPaid: true, cancelPaidByUserId: "owner1", cancelPaidAt: new Date(now),
  };
  const out = scrubCancelAudit({ ...row });
  eq("unshared reason, who cancelled, pay choice and count are blanked", [out.cancelReason, out.canceledByUserId, out.cancelNotifiedCount, out.cancelPaid, out.cancelPaidByUserId, out.cancelPaidAt], [null, null, null, false, null, null]);
  eq("the flag itself stays", [out.id, out.canceled], ["s1", true]);
  eq("a shared reason is kept", scrubCancelAudit({ ...row, cancelNotifyAudience: "BOTH" }).cancelReason, "Coach quit");
});

section("the schedule feed keeps a cancelled day, under the same visibility as before", () => {
  const feed = src("app/api/member/schedule/route.ts");
  const q = feed.slice(feed.indexOf("prisma.classSession.findMany"), feed.indexOf("prisma.privateLessonType.findMany"));
  check("the class-day query has no cancelled filter", q.length > 0 && !/canceled\s*:/.test(q));
  check("PRIVATE (roster-only) classes are still left out", /visibility:\s*\{\s*in:\s*\["PUBLIC",\s*"MEMBERS_ONLY"\]\s*\}/.test(q));
  check("inactive / deleted classes are still left out", /active:\s*true/.test(q) && /deletedAt:\s*null/.test(q));
  check("each item says whether it is cancelled", /canceled:\s*isCanceled/.test(feed) && /canBook:\s*!isCanceled/.test(feed));
  check("the shared reason rule is used, not a second copy", feed.includes("sharedCancelReason(sessionItem)") && feed.includes("canceledDayOffer(rawEval, isCanceled)"));
  check("every athlete on a cancelled day is unbookable with no price", /if \(isCanceled\) \{[\s\S]{0,260}a\.canBook = false;[\s\S]{0,120}a\.price = null;/.test(feed));
});

section("the schedule screen marks it and offers nothing", () => {
  const page = src("app/member/schedule/page.tsx");
  check("the title is struck through and greyed", /item\.canceled \? "text-stone-500 line-through"/.test(page));
  check("the word Canceled is printed where the price would be", page.includes('{item.canceled ? "Canceled" : priceLabel(item, family)}'));
  check("no check-in on a cancelled day", page.includes("!item.canceled && withinCheckinWindow(item)"));
  check("no Book button in the detail sheet", page.includes('selected.kind === "class" && data?.contextMember && !selected.canceled'));
  check("no status / price / how-to-book block in the detail sheet", page.includes("selected.bookingStatus || selected.canceled ? null"));
  check("no Booked chip or Book button per athlete", page.includes("{selected.canceled ? null"));
  check("the calendar views label it", page.includes("item.canceled ? `Canceled: ${item.title}` : item.title"));
});

section("the bookings list keeps a cancelled booked day", () => {
  const portal = src("app/api/member/portal/route.ts");
  const where = portal.slice(portal.indexOf("const classWhere"), portal.indexOf("const classInclude"));
  check("the portal feed no longer drops cancelled class days", where.length > 0 && !/canceled\s*:\s*false/.test(where));
  check("…but still only upcoming days of the family's own bookings", /startsAt:\s*\{\s*gte:\s*wallClockNowUTC\(clubTimezone\)\s*\}/.test(where) && /status:\s*\{\s*in:\s*\["PRESENT", "LATE", "DROP_IN", "TRIAL"\]\s*\}/.test(where));
  check("the audit is scrubbed before the response", portal.includes("if (cs.canceled) scrubCancelAudit(cs)"));

  const panel = src("components/member/BookingsPanel.tsx");
  check("class bookings take their status from the shared rule", panel.includes("classBookingState(cs)") && panel.includes("status: state.status"));
  check("Upcoming / Past use the shared rule", panel.includes("isUpcomingBooking(at, now.getTime())") && panel.includes("isPastBooking(at, now.getTime())"));
  check("no actions on a cancelled day", panel.includes("if (!bookingIsActionable(b)) return null;") && panel.includes("{bookingIsActionable(b) && ("));
  check("struck through and greyed", (panel.match(/b\.dayCanceled \? "text-stone-500 line-through"/g) ?? []).length === 2 && panel.includes('if (b.dayCanceled) return { bg: "#E7E5E4", fg: "#78716C" };'));
  check("the Canceled badge exists", /CANCELED: \{[^}]*label: "Canceled"/.test(panel));

  const rail = src("components/member/AthleteRail.tsx");
  check("a cancelled day is not counted as upcoming on the athlete rail", rail.includes("!r.classSession?.canceled"));
});

section("what was deliberately left alone", () => {
  check("booking a cancelled day is still refused by the server", /canceled:\s*false/.test(src("app/api/member/classes/book/route.ts")));
  check("checking in to a cancelled day is still refused by the server", /canceled:\s*false/.test(src("app/api/member/checkin/[id]/route.ts")));
  check("the calendar subscription feed still leaves cancelled days out", /canceled:\s*false/.test(src("lib/calendarFeed.ts")));
});

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
