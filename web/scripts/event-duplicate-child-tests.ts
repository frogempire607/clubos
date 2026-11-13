// The same child registering twice for one event through the public link
// (/e/<slug>) or the private one (/e/s-<token>) — lib/eventDuplicateChild.
// PURE: no database, no network.
//
//   npx tsx scripts/event-duplicate-child-tests.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALREADY_REGISTERED,
  alreadyRegisteredMessage,
  birthdateFromForm,
  findDuplicateChild,
  isBirthdateField,
  normalizeBirthdate,
  registrationIsLive,
  sameChild,
  type ChildIdentity,
  type ExistingChildRegistration,
} from "../lib/eventDuplicateChild";
import { ACTIVE_REGISTRATION_STATUSES, CHECKOUT_HOLD_MS, REGISTRATION_STATUSES } from "../lib/eventPayments";
import { eventFormFields } from "../lib/eventForm";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const child = (over: Partial<ChildIdentity> = {}): ChildIdentity => ({
  memberId: null, name: "Eli Fasulo", email: "parent@x.test", birthdate: null, ...over,
});
const row = (over: Partial<ExistingChildRegistration> = {}): ExistingChildRegistration => ({
  id: "reg_1", status: "REGISTERED", approvalStatus: null, ...child(), ...over,
});
const dup = (candidate: ChildIdentity, existing: ExistingChildRegistration[], memberHasBooking = false) =>
  findDuplicateChild({ candidate, existing, memberHasBooking }).duplicate;

console.log("\nWho is the same child:");
check("same matched member", sameChild(child({ memberId: "m1", name: "Eli F" }), child({ memberId: "m1", name: "Elijah Fasulo", email: "other@x.test" })));
check("two different member records are never the same child", !sameChild(child({ memberId: "m1" }), child({ memberId: "m2" })));
check("same name + same email, no birthdate collected", sameChild(child(), child()));
check("name is case- and whitespace-insensitive", sameChild(child({ name: "  eli   FASULO " }), child()));
check("email is case- and whitespace-insensitive", sameChild(child({ email: " Parent@X.test " }), child()));
check("SIBLINGS on one parent's email are two children", !sameChild(child({ name: "Eli Fasulo" }), child({ name: "Noah Fasulo" })));
check("the email alone never matches", !sameChild(child({ name: "A B" }), child({ name: "C D" })));
check("same name, different email, no birthdate → not assumed the same", !sameChild(child(), child({ email: "someone-else@x.test" })));
check("same name + same birthdate → same child whatever the email", sameChild(child({ birthdate: "2014-03-05" }), child({ birthdate: "2014-03-05", email: "dad@x.test" })));
check("same name + same email but DIFFERENT birthdates → two children", !sameChild(child({ birthdate: "2014-03-05" }), child({ birthdate: "2016-07-01" })));
check("birthdate on only one side falls back to the email", sameChild(child({ birthdate: "2014-03-05" }), child()) && !sameChild(child({ birthdate: "2014-03-05" }), child({ email: "dad@x.test" })));
check("a matched signup still matches an unlinked row for the same name + email", sameChild(child({ memberId: "m1" }), child()));
check("an empty name never matches", !sameChild(child({ name: "  " }), child({ name: "" })));
check("a missing email never matches on email", !sameChild(child({ email: null }), child({ email: null })));

console.log("\nWhich existing rows still count:");
for (const s of ACTIVE_REGISTRATION_STATUSES) check(`${s} is live`, registrationIsLive({ status: s }));
check("a request waiting on the coach is live", registrationIsLive({ status: "PENDING_REVIEW", approvalStatus: "PENDING" }));
check("CANCELED is not live", !registrationIsLive({ status: "CANCELED" }));
check("a declined request is not live", !registrationIsLive({ status: "PENDING_REVIEW", approvalStatus: "DECLINED" }) && !registrationIsLive({ status: "REGISTERED", approvalStatus: "DECLINED" }));
check("an unfinished card checkout is not live", !registrationIsLive({ status: "PENDING_PAYMENT" }));
check("every status is decided on purpose", REGISTRATION_STATUSES.every((s) => typeof registrationIsLive({ status: s }) === "boolean") &&
  REGISTRATION_STATUSES.filter((s) => !registrationIsLive({ status: s })).sort().join() === ["CANCELED", "PENDING_PAYMENT"].join());
check("liveness reuses ACTIVE_REGISTRATION_STATUSES, not a hand-rolled list",
  /ACTIVE_REGISTRATION_STATUSES/.test(readFileSync(join(__dirname, "..", "lib/eventDuplicateChild.ts"), "utf8")) &&
  !/status\s*!==\s*"PAID"/.test(readFileSync(join(__dirname, "..", "lib/eventDuplicateChild.ts"), "utf8")));

console.log("\nThe decision:");
check("first signup goes through", !dup(child(), []));
check("second signup for the same child is blocked", dup(child(), [row()]));
check("a sibling on the same email goes through", !dup(child({ name: "Noah Fasulo" }), [row()]));
check("a canceled registration does not block a new one", !dup(child(), [row({ status: "CANCELED" })]));
check("a declined request does not block a new one", !dup(child(), [row({ status: "PENDING_REVIEW", approvalStatus: "DECLINED" })]));
check("a paid registration blocks", dup(child(), [row({ status: "PAID" })]));
check("cash owed at the door blocks", dup(child(), [row({ status: "AWAITING_CASH" })]));
check("a request under review blocks", dup(child(), [row({ status: "PENDING_REVIEW", approvalStatus: "PENDING" })]));
{
  // Relative to now — never a calendar date. Neither side of the hold window
  // blocks: the route has no "resume this checkout" path.
  const startedAgo = (ms: number) => new Date(Date.now() - ms);
  const abandoned = { ...row({ status: "PENDING_PAYMENT" }), createdAt: startedAgo(CHECKOUT_HOLD_MS + 60_000) };
  const inFlight = { ...row({ status: "PENDING_PAYMENT" }), createdAt: startedAgo(60_000) };
  check("an abandoned card checkout (past the hold) does not block a retry", !dup(child(), [abandoned]));
  check("a card checkout that just failed can be retried straight away", !dup(child(), [inFlight]));
  check("…but a live row next to the abandoned one still blocks", dup(child(), [abandoned, row({ id: "reg_2", status: "PAID" })]));
}
check("matched member with a live registration under another spelling", dup(child({ memberId: "m1", name: "Eli Fasulo" }), [row({ memberId: "m1", name: "Elijah Fasulo", email: "mum@x.test" })]));
check("matched member who already holds a booking (registered in the app)", dup(child({ memberId: "m1" }), [], true));
check("a booking only counts for a MATCHED member", !dup(child({ memberId: null }), [], true));
check("two members with the same name are not blocked by each other", !dup(child({ memberId: "m2" }), [row({ memberId: "m1" })]));
check("same name + birthdate from a different parent's email is blocked", dup(child({ email: "dad@x.test", birthdate: "2014-03-05" }), [row({ birthdate: "2014-03-05" })]));
check("same name, same email, different birthdates are both registered", !dup(child({ birthdate: "2016-07-01" }), [row({ birthdate: "2014-03-05" })]));
{
  const d = findDuplicateChild({ candidate: child({ name: "  eli fasulo" }), existing: [row({ id: "reg_9" })] });
  eq("the answer names the code, the row and the child", d, { duplicate: true, code: "ALREADY_REGISTERED", registrationId: "reg_9", message: "eli is already registered for this event." });
  eq("code constant", ALREADY_REGISTERED, "ALREADY_REGISTERED");
  eq("message uses the first name as typed", alreadyRegisteredMessage("Eli Fasulo"), "Eli is already registered for this event.");
  eq("message with no name", alreadyRegisteredMessage("   "), "This athlete is already registered for this event.");
}

console.log("\nBirthdate — read from the event's own form:");
eq("ISO", normalizeBirthdate("2014-03-05"), "2014-03-05");
eq("US slashes", normalizeBirthdate("3/5/2014"), "2014-03-05");
eq("US dashes, padded", normalizeBirthdate("03-05-2014"), "2014-03-05");
eq("spelled month", normalizeBirthdate("March 5, 2014"), "2014-03-05");
eq("unreadable text is kept comparable, not dropped", normalizeBirthdate(" Spring  2014 "), "spring2014");
eq("empty", normalizeBirthdate("   "), null);
eq("not a string", normalizeBirthdate(true), null);
check("a bare number is not read as a date", normalizeBirthdate("12") === "12");
check("label: Date of birth", isBirthdateField({ label: "Date of birth", type: "text", perEntry: false }));
check("label: Birthdate / Birth date / Birthday / DOB", ["Athlete birthdate", "Birth date", "Birthday", "DOB", "D.O.B."].every((label) => isBirthdateField({ label, type: "text", perEntry: false })));
check("label: an unrelated question", !isBirthdateField({ label: "Division", type: "select", perEntry: false }) && !isBirthdateField({ label: "Adobe account", type: "text", perEntry: false }));
check("a per-entry question is not the athlete's birthdate", !isBirthdateField({ label: "Date of birth", type: "text", perEntry: true }));
{
  const fields = eventFormFields([
    { id: "f_div", label: "Division", type: "select", options: ["A", "B"] },
    { id: "f_dob", label: "Date of birth", type: "text", required: true },
  ]);
  eq("reads the birthdate answer", birthdateFromForm(fields, { f_div: "A", f_dob: "3/5/2014" }), "2014-03-05");
  eq("no answer → null", birthdateFromForm(fields, { f_div: "A" }), null);
  eq("a form with no birthdate question → null", birthdateFromForm(eventFormFields([{ id: "f_div", label: "Division" }]), { f_div: "A" }), null);
  eq("malformed responses → null", birthdateFromForm(fields, ["x"]), null);
}

console.log("\nWiring (source checks):");
const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const lib = src("lib/eventDuplicateChild.ts");
const route = src("app/api/public/events/[slug]/register/route.ts");
const page = src("app/e/[slug]/page.tsx");
check("the decision is pure — no prisma in the lib", !/from "@\/lib\/prisma"|@prisma\/client/.test(lib));
check("register route asks the pure decision", route.includes("findDuplicateChild({") && route.includes('from "@/lib/eventDuplicateChild"'));
check("the route does not hand-roll the status test", !/status\s*!==\s*"PAID"/.test(route));
check("answers 409 with the code and the message", /duplicate\.duplicate\)\s*\{\s*return NextResponse\.json\(\{ error: duplicate\.code, code: duplicate\.code, message: duplicate\.message \}, \{ status: 409 \}\)/.test(route));
check("the guard runs before anything is written", route.indexOf("findDuplicateChild({") > 0 && route.indexOf("findDuplicateChild({") < route.indexOf("prisma.eventRegistration.create("));
check("…and before the capacity answer", route.indexOf("findDuplicateChild({") < route.indexOf('"This event is full"'));
check("one route serves the public and the private link", route.includes("resolveEventLink(params.slug)"));
check("the guard keeps the one member match", (route.match(/findMemberForPublicSignup\(/g) ?? []).length === 1);
check("the page shows it as a calm notice", page.includes('d.code === "ALREADY_REGISTERED"') && page.includes("setDuplicateNotice("));
{
  const at = page.indexOf("{duplicateNotice && (");
  const block = at > 0 ? page.slice(at, at + 500) : "";
  check("the notice is not styled as an error", block.includes('role="status"') && !/red-/.test(block));
  check("the notice says nothing was charged", block.includes("Nothing was charged"));
}
check("a duplicate does not also raise the red error", /ALREADY_REGISTERED"\) \{\s*setDuplicateNotice\([^;]+;\s*return;/.test(page));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
