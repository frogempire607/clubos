// Who a registration belongs to — lib/registrationLink + lib/registrationRelink.
// PURE: no database.
//
//   npx tsx scripts/registration-match-tests.ts
//
// Fixtures are the real Finger Lakes Duals rows (2026-10): one parent, one
// email, two brothers; the public signup matched by email alone and put both
// registrations on the first brother's member record.

import {
  nameKey,
  matchMemberForPublicSignup,
  bookingActionOnApprove,
  sharedMemberWarning,
  releasesBookingOnDecline,
} from "../lib/registrationLink";
import { planRelinks, type RelinkRegistration, type RelinkMember, type RelinkBooking } from "../lib/registrationRelink";
import { ACTIVE_REGISTRATION_STATUSES } from "../lib/eventPayments";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const MASON = { id: "cmr7b5wec00gt9il7391ik6i5", firstName: "Mason", lastName: "Martinez" };
const LINCOLN = { id: "cmr7b5wea00gn9il7l6befb88", firstName: "Lincoln", lastName: "Martinez" };

console.log("\nPublic signup → member (email finds the household, name picks the athlete):");
{
  const household = [MASON, LINCOLN];
  eq("first brother links to himself", matchMemberForPublicSignup({ name: "Mason Martinez", candidates: household }), MASON.id);
  eq("second brother links to HIMSELF, not the first", matchMemberForPublicSignup({ name: "Lincoln Martinez", candidates: household }), LINCOLN.id);
  eq("case and spacing ignored", matchMemberForPublicSignup({ name: "  lincoln   MARTINEZ ", candidates: household }), LINCOLN.id);
  // The production shape: only Mason was reachable by the parent's email.
  eq("email matches a member but the name is someone else → unlinked", matchMemberForPublicSignup({ name: "Lincoln Martinez", candidates: [MASON] }), null);
  eq("a third child with no member record → unlinked", matchMemberForPublicSignup({ name: "Nora Martinez", candidates: household }), null);
  eq("no candidates → unlinked", matchMemberForPublicSignup({ name: "Mason Martinez", candidates: [] }), null);
  eq("nickname is not a match → unlinked (staff link it)", matchMemberForPublicSignup({ name: "Zachary Boudreau", candidates: [{ id: "z", firstName: "Zach", lastName: "Boudreau" }] }), null);
  eq("two members with the same name on one email → unlinked, never a guess", matchMemberForPublicSignup({ name: "Mason Martinez", candidates: [MASON, { ...MASON, id: "dup" }] }), null);
  eq("the same member found twice (own + guardian email) is one match", matchMemberForPublicSignup({ name: "Mason Martinez", candidates: [MASON, MASON] }), MASON.id);
  eq("blank name → unlinked", matchMemberForPublicSignup({ name: "   ", candidates: household }), null);
  eq("the parent's own name → unlinked (they are not the athlete)", matchMemberForPublicSignup({ name: "Dana Martinez", candidates: household }), null);
  eq("first name alone is not a match", matchMemberForPublicSignup({ name: "Mason", candidates: household }), null);
  // Siblings on one email are different PEOPLE to the duplicate rule too.
  check("two siblings have different name keys", nameKey("Mason Martinez") !== nameKey("Lincoln Martinez"));
}

console.log("\nApproval → Booking (read first, never create-and-catch):");
{
  eq("no Booking yet → create", bookingActionOnApprove(null), "create");
  eq("canceled Booking → reconfirm", bookingActionOnApprove({ status: "CANCELED" }), "reconfirm");
  eq("live Booking → keep (the case that used to abort the transaction)", bookingActionOnApprove({ status: "CONFIRMED" }), "keep");
  eq("attended Booking → keep", bookingActionOnApprove({ status: "ATTENDED" }), "keep");
}

console.log("\nShared member record warning:");
{
  eq("no other registration → no warning", sharedMemberWarning({ registrationName: "Mason Martinez", memberName: "Mason Martinez", others: [] }), null);
  eq("same athlete twice (same name) → no warning", sharedMemberWarning({ registrationName: "Mason Martinez", memberName: "Mason Martinez", others: [{ name: "mason  martinez" }] }), null);
  eq(
    "approving Mason while Lincoln shares his record → names Lincoln as the mislinked one",
    sharedMemberWarning({ registrationName: "Mason Martinez", memberName: "Mason Martinez", others: [{ name: "Lincoln Martinez" }] }),
    "Lincoln Martinez's registration is linked to Mason Martinez's member record — link it to the right member from Attendees.",
  );
  eq(
    "approving Lincoln (the mislinked one) → same sentence",
    sharedMemberWarning({ registrationName: "Lincoln Martinez", memberName: "Mason Martinez", others: [{ name: "Mason Martinez" }] }),
    "Lincoln Martinez's registration is linked to Mason Martinez's member record — link it to the right member from Attendees.",
  );
  check(
    "member name unknown → still warns, naming both",
    (sharedMemberWarning({ registrationName: "Lincoln Martinez", memberName: null, others: [{ name: "Mason Martinez" }] }) ?? "").includes("Lincoln Martinez and Mason Martinez"),
  );
}

console.log("\nDecline → does the Booking go back?");
{
  eq("nobody else on the member record → released", releasesBookingOnDecline([], ACTIVE_REGISTRATION_STATUSES), true);
  eq("the other registration is still under review → released", releasesBookingOnDecline([{ status: "PENDING_REVIEW", approvalStatus: "PENDING" }], ACTIVE_REGISTRATION_STATUSES), true);
  eq("the other registration is approved → Booking stays (it is theirs too)", releasesBookingOnDecline([{ status: "REGISTERED", approvalStatus: "APPROVED" }], ACTIVE_REGISTRATION_STATUSES), false);
  eq("the other registration was canceled → released", releasesBookingOnDecline([{ status: "CANCELED", approvalStatus: "DECLINED" }], ACTIVE_REGISTRATION_STATUSES), true);
}

console.log("\nRepair plan (scripts/fix-martinez-registration.ts):");
{
  const CLUB = "club1";
  const EVENT = "fld";
  const members: RelinkMember[] = [
    { ...MASON, clubId: CLUB },
    { ...LINCOLN, clubId: CLUB },
    { id: "zach", clubId: CLUB, firstName: "Zach", lastName: "Boudreau" },
    { id: "otherclub-lincoln", clubId: "club2", firstName: "Lincoln", lastName: "Martinez" },
  ];
  const reg = (over: Partial<RelinkRegistration>): RelinkRegistration => ({
    id: "r", eventId: EVENT, clubId: CLUB, memberId: MASON.id, name: "Mason Martinez", status: "PENDING_REVIEW", approvalStatus: "PENDING", ...over,
  });
  const masonReg = reg({ id: "mason-reg" });
  const lincolnReg = reg({ id: "cmusol4w70009wiuh3g0midai", name: "Lincoln Martinez", status: "SCHEDULED", approvalStatus: "APPROVED" });
  const zachReg = reg({ id: "zach-reg", memberId: "zach", name: "Zachary Boudreau", status: "REGISTERED", approvalStatus: "APPROVED" });
  const strayBooking: RelinkBooking = { id: "cmuspe2e3000212fyzbm24z4q", eventId: EVENT, memberId: MASON.id, status: "CONFIRMED" };
  const run = (registrations: RelinkRegistration[], bookings: RelinkBooking[], m = members) =>
    planRelinks({ registrations, members: m, bookings, activeStatuses: ACTIVE_REGISTRATION_STATUSES });

  // Production today.
  const today = run([masonReg, lincolnReg, zachReg], [strayBooking, { id: "zb", eventId: EVENT, memberId: "zach", status: "CONFIRMED" }]);
  eq("exactly one row is planned", today.plans.length, 1);
  const p = today.plans[0];
  eq("…Lincoln's registration", p?.registrationId, "cmusol4w70009wiuh3g0midai");
  eq("…from Mason's member", p?.fromMemberId, MASON.id);
  eq("…to Lincoln's member", p?.toMemberId, LINCOLN.id);
  eq("…and the Booking moves with him", p?.booking, { kind: "MOVE", bookingId: "cmuspe2e3000212fyzbm24z4q" });
  eq("Zachary/Zach Boudreau is NOT planned", today.plans.some((x) => x.registrationId === "zach-reg"), false);
  check("…it is listed as left alone, with the reason", today.skipped.length === 1 && today.skipped[0].registrationId === "zach-reg" && today.skipped[0].reason.includes("no other member"));
  eq("Mason's own registration is untouched", today.plans.some((x) => x.registrationId === "mason-reg"), false);
  eq("a same-named member in ANOTHER club is not a match", run([reg({ id: "x", name: "Lincoln Martinez" })], [], members.filter((m) => m.id !== LINCOLN.id)).plans.length, 0);

  // Booking variants.
  eq(
    "Mason is approved too → he keeps his Booking, Lincoln gets a new one",
    run([reg({ id: "mason-reg", status: "REGISTERED", approvalStatus: "APPROVED" }), lincolnReg], [strayBooking]).plans[0]?.booking,
    { kind: "CREATE" },
  );
  eq(
    "Lincoln already has a live Booking → the stray is canceled",
    run([masonReg, lincolnReg], [strayBooking, { id: "lb", eventId: EVENT, memberId: LINCOLN.id, status: "CONFIRMED" }]).plans[0]?.booking,
    { kind: "CANCEL_STRAY", bookingId: strayBooking.id, keepBookingId: "lb" },
  );
  eq(
    "Lincoln has a CANCELED Booking → reconfirm it, cancel the stray (unique eventId+memberId blocks a move)",
    run([masonReg, lincolnReg], [strayBooking, { id: "lb", eventId: EVENT, memberId: LINCOLN.id, status: "CANCELED" }]).plans[0]?.booking,
    { kind: "RECONFIRM", bookingId: "lb", strayBookingId: strayBooking.id },
  );
  eq(
    "Lincoln's registration still under review → re-linked, Booking untouched",
    run([masonReg, reg({ id: "l", name: "Lincoln Martinez" })], [strayBooking]).plans[0]?.booking.kind,
    "NONE",
  );
  eq(
    "approved but no Booking anywhere → create",
    run([masonReg, lincolnReg], []).plans[0]?.booking,
    { kind: "CREATE" },
  );

  // Refusals.
  eq("canceled registration is ignored", run([reg({ id: "l", name: "Lincoln Martinez", status: "CANCELED", approvalStatus: "DECLINED" })], []).plans.length, 0);
  eq("declined registration is ignored", run([reg({ id: "l", name: "Lincoln Martinez", status: "REGISTERED", approvalStatus: "DECLINED" })], []).plans.length, 0);
  eq("unlinked registration is ignored", run([reg({ id: "l", name: "Lincoln Martinez", memberId: null })], []).plans.length, 0);
  const taken = run([lincolnReg, reg({ id: "l-own", memberId: LINCOLN.id, name: "Lincoln Martinez" })], []);
  check("target already registered on the event → skipped, not planned", taken.plans.length === 0 && taken.skipped[0]?.reason.includes("already has a registration"));
  const twins = run([lincolnReg], [], [...members, { id: "lincoln2", clubId: CLUB, firstName: "Lincoln", lastName: "Martinez" }]);
  check("two members with that name → skipped as ambiguous", twins.plans.length === 0 && twins.skipped[0]?.reason.includes("ambiguous"));
  const two = run([reg({ id: "a", name: "Lincoln Martinez" }), reg({ id: "b", name: "lincoln martinez" })], []);
  check("two mislinked rows for one athlete → only the first is planned", two.plans.length === 1 && two.skipped.length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
