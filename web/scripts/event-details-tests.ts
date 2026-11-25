/**
 * Member event details screen + "register only from an informed place"
 * (2026-11-18).
 *
 *   npx tsx scripts/event-details-tests.ts
 *
 * Runs the REAL routes against a fake database:
 *   - GET  /api/member/events/[id]           (the details screen's data)
 *   - POST /api/member/events/[id]/register  (registering)
 * and checks the pure wording in lib/eventDetailsView. Every date is relative
 * to now.
 *
 * Covers what was asked:
 *   1. visibility: a member can't open an event they can't see
 *   2. nothing registers without the confirm step
 *   3. price and payment-timing wording for each payment type
 *   4. a long description shows in full
 *   5. the details screen and the old Schedule hand-off reach the same flow
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { makeFakeDb, installFakePrisma } from "./fake-prisma";

let pass = 0;
let fail = 0;
const ok = (c: unknown, m: string, detail?: string) => {
  if (c) { pass++; console.log("  ✓ " + m); }
  else { fail++; console.log("  ✗ " + m + (detail ? ` — ${detail}` : "")); }
};
const ROOT = join(__dirname, "..");
const code = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const now = new Date();
const days = (n: number) => new Date(now.getTime() + n * 86_400_000);

// ── The fake database ──────────────────────────────────────────────────────
const fake = makeFakeDb({
  relations: {
    event: {
      sessions: { model: "eventSession", kind: "many", fk: "eventId" },
      bookings: { model: "booking", kind: "many", fk: "eventId" },
      customEventType: { model: "clubEventType", kind: "one", fk: "customEventTypeId" },
      location: { model: "location", kind: "one", fk: "locationId" },
    },
    memberGuardianUser: { member: { model: "member", kind: "one", fk: "memberId" } },
    eventStaffAssignment: { user: { model: "user", kind: "one", fk: "userId" } },
  },
});

const SESSION = { user: { id: "u_parent", clubId: "c1", role: "MEMBER", email: "parent@example.com" } };
let paramCalls = 0;
const ACK_DOCS: { id: string; title: string }[] = [];

installFakePrisma(fake.client, {
  "next-auth": { getServerSession: async () => SESSION, default: {} },
  "@/lib/auth": { authOptions: {} },
  "@/lib/memberLink": {
    findOrAutoLinkMember: async (userId: string) => (await fake.client.member.findFirst({ where: { userId } })) ?? null,
  },
  "@/lib/parentalConsent": { guardianActionBlocked: async () => false, CONSENT_BLOCK_BODY: {} },
  "@/lib/parentalControls": {
    applyParentalControls: async () => { paramCalls++; return { kind: "allow" }; },
  },
  "@/lib/eventDocuments": {
    missingSignedEventDocs: async () => [],
    acknowledgementDocs: async () => ACK_DOCS,
    documentsForEvent: async () => [],
    EVENT_DOC_REQUIREMENT_LABELS: { INFO: "For your information", ACKNOWLEDGE: "Acknowledge", SIGN_REQUIRED: "Signature required" },
  },
  "@/lib/eventRosterServer": {
    loadRosterDef: async () => ({ rosters: [], positions: [] }),
    checkPicks: async () => ({ ok: true }),
    writeEntries: async () => undefined,
    rosterForSignup: async () => null,
  },
  "@/lib/stripe": { stripe: {}, calculatePlatformFee: () => 0 },
  "@/lib/email": { sendBookingConfirmationEmail: async () => undefined },
  "@/lib/eventLifecycleEmails": { sendRegistrationLifecycleEmail: async () => undefined },
  "@/lib/memberCard": { resolveChargeablePaymentMethodId: async () => null, resolveCardSnapshot: async () => null, prettyBrand: (b: string) => b },
  "@/lib/eventAutoDiscountServer": { autoDiscountsForSignup: async () => ({ candidates: [] }), catchUpGroupRate: async () => undefined },
  "@/lib/eventOfflinePayments": { createEventOfflinePendingTx: async () => ({ id: "tx_1" }) },
  "@/lib/eventAutoCharge": { chargeEventRegistration: async () => ({ ok: true }) },
});

/* eslint-disable @typescript-eslint/no-require-imports */
const registerRoute = require("../app/api/member/events/[id]/register/route.ts") as typeof import("../app/api/member/events/[id]/register/route");
const detailsRoute = require("../app/api/member/events/[id]/route.ts") as typeof import("../app/api/member/events/[id]/route");
const view = require("../lib/eventDetailsView.ts") as typeof import("../lib/eventDetailsView");
const paths = require("../lib/memberErrorText.ts") as typeof import("../lib/memberErrorText");
/* eslint-enable @typescript-eslint/no-require-imports */

const EV = (id: string, o: Record<string, unknown> = {}) => ({
  id, clubId: "c1", deletedAt: null, type: "CLINIC", customEventTypeId: null, locationId: null,
  name: `Event ${id}`, description: null, startsAt: days(10), endsAt: new Date(days(10).getTime() + 3 * 3_600_000),
  capacity: null, memberPrice: null, nonMemberPrice: null, dropInFee: null, pricingModel: "FIXED", sellIndividualSessions: false,
  visibility: "MEMBERS_ONLY", purchaseAccess: "ANYONE", publishAt: null, unpublishAt: null,
  audience: null, registrationForm: null, pricingOptions: null, paymentMethods: null, autoChargeDate: null,
  variableCostEnabled: false, variableCostTotal: null, variableCostEstimatedTotal: null, variableCostMode: null, variableCostEstimatedSignups: null,
  requiresCoachApproval: null, approvalPaymentIntent: null, holdSpotDuringReview: false, autoDiscounts: {},
  allowMultipleEntries: false, maxEntries: null, additionalEntryPrice: null, allowSameRosterTwice: false, entriesOnPublicLink: false,
  registrationDeadline: null, registrationOpen: null, cancellationPolicyText: null, divisions: null, externalLinks: null, registrationLink: null,
  publicFormIntro: null, imageUrl: null, ...o,
});

fake.seed("club", [{ id: "c1", name: "Riverside", timezone: "America/New_York", stripeAccountId: "acct_1", stripeChargesEnabled: true, passProcessingFees: false, passPlatformFee: false, tier: "starter" }]);
fake.seed("user", [{ id: "u_parent", clubId: "c1", email: "parent@example.com", deletedAt: null }]);
fake.seed("member", [
  { id: "m_self", clubId: "c1", userId: "u_parent", firstName: "John", lastName: "Doe", email: "parent@example.com", phone: null, isMinor: false, dateOfBirth: null, deletedAt: null, parentControls: null },
  { id: "m_other", clubId: "c1", userId: "u_other", firstName: "Otherfamily", lastName: "Kid", email: "o@example.com", deletedAt: null },
]);
fake.seed("memberGuardianUser", []);
fake.seed("memberSubscription", [{ id: "s1", memberId: "m_self", membershipId: "plan_covered", status: "active" }]);
fake.seed("membership", []);
fake.seed("eventSession", []);
fake.seed("clubEventType", []);
fake.seed("location", []);
fake.seed("eventStaffAssignment", []);
fake.seed("eventRegistration", []);
fake.seed("booking", [{ id: "b_other", eventId: "free", memberId: "m_other", status: "CONFIRMED" }]);
fake.seed("event", [
  EV("free"),
  EV("covered", { memberPrice: 40, nonMemberPrice: 60, pricingOptions: [{ type: "membership", membershipId: "plan_covered" }] }),
  EV("cash", { memberPrice: 45, nonMemberPrice: 45, paymentMethods: ["CASH"] }),
  EV("choice", { memberPrice: 45, nonMemberPrice: 45, paymentMethods: ["CARD", "CASH"] }),
  EV("approval", { requiresCoachApproval: true }),
  EV("private", { visibility: "PRIVATE" }),
  EV("staffonly", { purchaseAccess: "STAFF_ONLY" }),
  EV("unpublished", { publishAt: days(5) }),
  EV("otherclub", { clubId: "c2" }),
  EV("deleted", { deletedAt: days(-1) }),
  EV("long", { description: "Line one\n\nCheck https://example.com/info.\n" + "x".repeat(4000) + "\nEnd of the long description" }),
]);

const post = async (id: string, body: Record<string, unknown>) => {
  const res = await registerRoute.POST(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
  return { status: res.status, d: (await res.json()) as Record<string, unknown> };
};
const get = async (id: string) => {
  const res = await detailsRoute.GET(new Request(`http://x/api/member/events/${id}`), { params: Promise.resolve({ id }) });
  return { status: res.status, d: (await res.json()) as Record<string, unknown> };
};
const writes = () => fake.writes().filter((w) => w.model !== "user"); // lastLoginAt-style touches would show here too

(async () => {
  console.log("\n1. Visibility: only what the Events list would show");
  for (const id of ["private", "staffonly", "unpublished", "otherclub", "deleted", "nope"]) {
    const r = await get(id);
    ok(r.status === 404, `details: "${id}" can't be opened (404)`, String(r.status));
  }
  for (const id of ["private", "staffonly", "unpublished", "otherclub"]) {
    fake.resetCalls();
    const r = await post(id, { confirmed: true });
    ok(r.status === 404 && writes().length === 0, `register: "${id}" refused even when confirmed, nothing written`);
  }
  const visible = await get("free");
  ok(visible.status === 200, "a members-only event in its window opens");
  const body = JSON.stringify(visible.d);
  ok(!body.includes("Otherfamily"), "another family's athlete is never in the details answer");
  const fam = visible.d.family as { firstName: string }[];
  ok(Array.isArray(fam) && fam.length === 1 && fam[0].firstName === "John", "the athletes listed are this login's own");
  const det = visible.d.details as { capacity: unknown; taken: number };
  ok(typeof det.taken === "number", "spots are a count, nothing more");
  const routeSrc = code("app/api/member/events/route.ts") + code("app/api/member/events/[id]/route.ts") + code("app/api/member/events/[id]/ics/route.ts") + code("app/api/member/events/[id]/register/route.ts");
  ok((routeSrc.match(/memberVisibleEventWhere\(/g) ?? []).length >= 4, "list, details, calendar file and register all use the one visibility rule");
  ok(/shapeForMember\(clubId, \[row\], ctx\)/.test(code("app/api/member/events/[id]/route.ts")), "details applies the list's who-it's-for rule too");

  console.log("\n2. Nothing registers or charges without the confirm step");
  const cases: { id: string; pricing: string; extra?: (d: Record<string, unknown>) => boolean; note: string }[] = [
    { id: "free", pricing: "FREE", note: "free, no questions" },
    { id: "covered", pricing: "COVERED", note: "covered by a membership" },
    { id: "cash", pricing: "PAID", extra: (d) => d.method === "CASH", note: "one way to pay (cash)" },
    { id: "approval", pricing: "FREE", extra: (d) => d.approval === true, note: "the club approves registrations" },
  ];
  for (const c of cases) {
    fake.resetCalls();
    const r = await post(c.id, {});
    ok(r.status === 200 && r.d.review === true && r.d.pricing === c.pricing && (c.extra ? c.extra(r.d) : true), `${c.note}: first tap answers with a review`, JSON.stringify(r.d).slice(0, 160));
    ok(writes().length === 0, `${c.note}: …and writes nothing`, JSON.stringify(writes().map((w) => `${w.model}.${w.method}`)));
  }
  fake.resetCalls();
  const choice = await post("choice", {});
  ok(choice.status === 400 && choice.d.error === "PAYMENT_METHOD_REQUIRED" && writes().length === 0, "several ways to pay: asks how (the confirm screen), writes nothing");
  fake.resetCalls();
  const picked = await post("choice", { paymentMethod: "CASH" });
  ok(picked.d.review === true && writes().length === 0, "a way to pay chosen but not confirmed: still a review, nothing written");
  ACK_DOCS.push({ id: "doc1", title: "Event waiver" });
  fake.resetCalls();
  const ack = await post("free", {});
  ok((ack.d.acknowledge as unknown[])?.length === 1 && writes().length === 0, "a document to acknowledge is listed on the review, not recorded yet");
  ACK_DOCS.length = 0;
  paramCalls = 0;
  await post("cash", {});
  ok(paramCalls === 0, "the guardian-approval gate (which writes a request) is not reached before confirm");

  fake.resetCalls();
  const confirmed = await post("free", { confirmed: true });
  const booked = (await fake.client.booking.findMany({ where: { eventId: "free", memberId: "m_self" } })) as unknown[];
  ok(confirmed.status === 200 && confirmed.d.free === true && booked.length === 1, "the same request WITH confirmed registers");

  const reg = code("app/api/member/events/[id]/register/route.ts");
  ok(/confirmed: z\.boolean\(\)\.optional\(\)/.test(reg) && /const reviewOnly = body\.confirmed !== true;/.test(reg), "register treats anything not explicitly confirmed as a review");
  const flow = code("components/member/events/registerFlow.tsx");
  ok(/function start\([^)]*\) \{\n\s*void register\(eventId, pricingType, undefined, undefined, sessionIds\);/.test(flow), "starting the flow never sends confirmed");
  ok((flow.match(/sessionIds, true, nonRefundable\);/g) ?? []).length === 2 && /onConfirm=\{/.test(flow) && /onChoose=\{/.test(flow), "confirmed is sent only from the review sheet and the payment-choice screen");
  // No member page or component posts to the event register route except the shared flow.
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(n)) files.push(p);
    }
  };
  walk(join(ROOT, "app/member"));
  walk(join(ROOT, "components/member"));
  const posting = files.filter((f) => /api\/member\/events\/\$\{[^}]+\}\/register/.test(readFileSync(f, "utf8"))).map((f) => relative(ROOT, f));
  ok(posting.length === 1 && posting[0] === "components/member/events/registerFlow.tsx", "only the shared flow posts to the register route", posting.join(", "));
  ok(!/register\(e\.id/.test(code("app/member/events/page.tsx")), "the Events list's cards no longer register anyone");
  ok(/confirmDialog\(/.test(code("app/member/events/page.tsx")), "a bundle asks in the app's own dialog before registering");

  console.log("\n3. Price and payment-timing wording, per payment type");
  const tz = "America/New_York";
  const chargeOn = days(20);
  const f = { cardTotal: 46.61, offlineTotal: 45, cardFee: 1.61, chargeOn, savedCardLabel: "Visa ····4242", tz };
  const day = view.longDate(chargeOn, tz);
  ok(view.methodSentence("CARD", f) === "Pay $46.61 now by card on a secure checkout page (includes $1.61 processing fee).", "card now");
  ok(view.methodSentence("SAVED_CARD", f).startsWith("Your saved card (Visa ····4242) is charged $46.61 now"), "saved card now");
  ok(view.methodSentence("AUTO_CARD", f).includes(`Nothing is charged today. Your saved card (Visa ····4242) is charged $46.61 on ${day}`), "card charged automatically on a date", view.methodSentence("AUTO_CARD", f));
  ok(view.methodSentence("CASH", f) === "Bring $45.00 in cash to the event. The club records it when they receive it.", "cash, no card fee");
  ok(view.methodSentence("CHECK", f).startsWith("Bring a check for $45.00"), "check");
  ok(view.methodSentence("APPROVAL_CHARGE", f).includes("If the coach approves, your saved card"), "charged when approved");
  ok(view.methodSentence("INVOICE", f).includes("emails you a payment link for $45.00"), "billed if approved");
  ok(view.splitSentence({ mode: "ESTIMATED", perHead: 37.5 }).includes("about $37.50 each"), "split cost, estimated share");
  ok(/once the final amount is known/.test(view.splitSentence({ mode: "OFFICIAL", perHead: null })), "split cost, amount not known yet");
  const multi = view.paymentSummary({ pricing: "PAID", methods: ["CARD", "CASH"], facts: f, approval: true });
  ok(multi[0] === "You choose how to pay when you register:" && multi.length === 4 && multi[3] === view.APPROVAL_SENTENCE, "several ways: each listed, then the approval note");
  ok(view.paymentSummary({ pricing: "FREE", methods: [], facts: null, approval: false })[0] === "Free. Nothing to pay.", "free");
  ok(view.paymentSummary({ pricing: "COVERED", methods: [], facts: null, approval: false, athleteName: "Ava" })[0] === "Included in Ava's membership. Nothing to pay.", "covered by membership");
  const pv = view.priceView({ pricing: "PAID", isActiveMember: false, memberPrice: 40, nonMemberPrice: 60, dropInFee: 15, multiSession: true, cardFee: 2, passFees: true, discountLines: ["2nd sibling: 10% off"] });
  ok(pv.headline === "$60.00" && pv.lines.includes("Members $40.00 · non-members $60.00") && pv.lines.includes("One session only: $15.00") && pv.lines.includes("2nd sibling: 10% off") && pv.lines.some((l) => l.includes("$2.00 processing fee")), "price: non-member rate, member rate shown, one-session price, sibling pricing, fee");
  ok(view.priceView({ pricing: "PAID", isActiveMember: true, memberPrice: 40, nonMemberPrice: 60, dropInFee: null, multiSession: false }).headline === "$40.00", "an active member sees the member price");
  const reviewBase = { pricing: "PAID" as const, approval: false, waitlisted: false, method: "AUTO_CARD" as const, amount: { gross: 45, due: 45, discountLabel: null, cardFee: 1.61, cardTotal: 46.61 }, chargeOn: chargeOn.toISOString(), savedCardLabel: null, split: null };
  ok(view.reviewTiming(reviewBase, tz).includes(day), "the review names the charge day");
  ok(view.confirmLabel({ ...reviewBase, method: "CARD" }) === "Continue to payment · $46.61", "card: the button names the amount");
  ok(view.confirmLabel({ ...reviewBase, method: "SAVED_CARD" }) === "Pay $46.61 and register", "saved card: the button names the amount");
  ok(view.confirmLabel({ ...reviewBase, approval: true }) === "Send registration request", "approval: a request, not a registration");
  ok(view.confirmLabel({ pricing: "FREE", approval: false, waitlisted: false, method: null, amount: null }) === "Confirm registration", "free: one clear confirm");
  ok(view.spotsText(20, 12) === "8 spots left" && view.spotsText(20, 20) === "Full · you can join the waitlist" && view.spotsText(null, 3) === null, "spots: a number, or full");
  const dl = view.deadlineText(days(-1), now, tz);
  ok(!!dl && dl.closed && view.deadlineText(days(3), now, tz)?.closed === false, "deadline: open, then closed");

  console.log("\n4. A long description shows in full");
  const long = (await get("long")).d.event as { description: string };
  ok(long.description.length > 4000 && long.description.endsWith("End of the long description"), "the details answer carries all of it");
  const pieces = view.linkifyText(long.description);
  ok(pieces.map((p) => p.text).join("") === long.description, "split into text and links, nothing lost (line breaks kept)");
  ok(pieces.some((p) => p.kind === "link" && p.href === "https://example.com/info"), "links become links; the full stop after one stays text");
  ok(view.linkifyText("javascript:alert(1) and ftp://x").every((p) => p.kind === "text"), "only web addresses become links");
  const block = code("components/events/EventInfoBlock.tsx");
  ok(!/line-clamp|truncate/.test(block.slice(block.indexOf("export function DescriptionText"), block.indexOf("export default"))) && /whitespace-pre-wrap/.test(block), "the description is never clamped and keeps line breaks");
  ok(/<EventInfoBlock/.test(code("app/e/[slug]/page.tsx")) && /<EventInfoBlock/.test(code("app/member/events/[id]/page.tsx")), "the public page and the details screen render the same block");
  // Midnight UTC a month from now is 9 AM in Tokyo (UTC+9 all year, no
  // daylight saving), whatever zone this test runs in.
  const midnightUtc = new Date(Date.UTC(days(30).getUTCFullYear(), days(30).getUTCMonth(), days(30).getUTCDate()));
  const tzWhen = view.eventWhen(midnightUtc, new Date(midnightUtc.getTime() + 6 * 3_600_000), "Asia/Tokyo");
  ok(tzWhen.time === "9:00 AM – 3:00 PM" && !tzWhen.multiDay, "times are in the club's timezone", tzWhen.time);
  ok(view.eventWhen(days(10), days(12), tz).multiDay, "an event over several days shows both dates");

  console.log("\n5. Same register flow from the details screen and the Schedule hand-off");
  const hand = paths.eventRegisterFlowPath("e1", "m1");
  ok(hand === "/member/events/e1?memberId=m1&register=1" && paths.eventDetailsPath("e1", "m1") === "/member/events/e1?memberId=m1", "the hand-off is the details screen with the flow opened");
  const page = code("app/member/events/[id]/page.tsx");
  ok(/useEventRegisterFlow\(/.test(page) && /searchParams\.get\("register"\) !== "1"/.test(page) && /flow\.start\(data\.event\.id\)/.test(page), "the details screen starts that flow, on tap or on arrival from the hand-off");
  const sched = code("app/member/schedule/page.tsx");
  ok(/router\.push\(eventRegisterFlowPath\(item\.refId, target\.memberId\)\)/.test(sched) && /eventDetailsPath\(item\.refId/.test(sched), "Schedule hands registering, and event taps, to the details screen");
  ok(/eventDetailsPath\(b\.event\.id\)/.test(code("app/member/page.tsx")) && /eventDetailsPath\(ev\.id\)/.test(code("app/member/shop/page.tsx")) && /eventDetailsPath\(b\.event\.id, b\.memberId\)/.test(code("components/member/BookingsPanel.tsx")), "Home, Book and Bookings open the same screen");
  ok(/eventDetailsPath\(event\.id\)/.test(code("app/e/[slug]/page.tsx")), "the public page sends signed-in members there");
  ok(/eventDetailsPath\(args\.eventId/.test(reg) && /eventDetailsPath\(event\.id\)/.test(code("app/api/events/[id]/charge/route.ts")) && /eventDetailsPath\(event\.id\)/.test(code("app/api/stripe/webhook/route.ts")), "event confirmation emails link to it");
  const exports = (code("components/member/events/registerFlow.tsx").match(/export function useEventRegisterFlow/g) ?? []).length;
  ok(exports === 1 && !/function EventFormModal|function PaymentChoiceModal/.test(code("app/member/events/page.tsx")), "one copy of the flow and its screens");

  console.log("\n6. House rules on the new screens");
  for (const rel of ["app/member/events/[id]/page.tsx", "components/member/events/registerFlow.tsx", "components/events/EventInfoBlock.tsx"]) {
    const s = code(rel);
    ok(!/text-\[(?:[0-9]|1[01])(?:\.\d+)?px\]|text-xs\b.*text-\[1[01]px\]/.test(s), `${rel}: no text under 12px`);
    ok(!/\balert\(|window\.confirm\(|\bconfirm\(/.test(s.replace(/confirmDialog\(/g, "")), `${rel}: no browser pop-ups`);
  }
  ok(/DetailsSkeleton/.test(page) && /aria-busy/.test(page), "the details screen shows a loading skeleton");
  ok(/ConnectionGuard/.test(code("app/member/layout.tsx")), "the member layout's connection guard covers it");

  console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
