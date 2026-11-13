// An event that is no longer public must not be findable at its old public
// address /e/<slug>: the API answers exactly as it does for a slug that never
// existed, and the page shows a neutral "This event isn't available" with
// nothing about the event. The private link /e/s-<token> keeps working.
// PURE: no database, no network.
//
//   npx tsx scripts/event-unavailable-tests.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EVENT_NOT_FOUND, linkAccess, publicLinkOn, type LinkAccessEvent } from "../lib/eventShareLink";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const DAY = 86_400_000;
const now = new Date();
const past = new Date(now.getTime() - 5 * DAY);
const future = new Date(now.getTime() + 14 * DAY);
const slug = (e: LinkAccessEvent | null) => linkAccess("slug", e, now);
const token = (e: LinkAccessEvent | null) => linkAccess("token", e, now);

const pub: LinkAccessEvent = { signupAccess: "PUBLIC_LINK", publicRegistration: true };
const membersOnly: LinkAccessEvent = { signupAccess: "MEMBERS", publicRegistration: false };
const staffOnly: LinkAccessEvent = { signupAccess: "STAFF_ONLY", publicRegistration: false };
const NEVER_EXISTED = slug(null);

console.log("\nThe answer for a slug that never existed:");
eq("404 + one error string", NEVER_EXISTED, { ok: false, status: 404, error: "Event not found" });
eq("the constant", EVENT_NOT_FOUND, "Event not found");

console.log("\nSwitched to private → the same answer, byte for byte:");
eq("members-only", slug(membersOnly), NEVER_EXISTED);
eq("staff-only (hidden)", slug(staffOnly), NEVER_EXISTED);
eq("STAFF_ONLY with the legacy flag still set", slug({ signupAccess: "STAFF_ONLY", publicRegistration: true }), NEVER_EXISTED);
eq("STAFF_ONLY on a hosted tournament", slug({ signupAccess: "STAFF_ONLY", tournamentMode: "HOST" }), NEVER_EXISTED);
eq("no access settings at all", slug({}), NEVER_EXISTED);
eq("deleted", slug({ ...pub, deletedAt: past }), NEVER_EXISTED);
// The dates must not give it away either: a private event never answers
// "registration has closed" / "not open yet" — those would confirm it exists.
eq("private + deadline passed", slug({ ...membersOnly, registrationDeadline: past }), NEVER_EXISTED);
eq("private + unpublished", slug({ ...staffOnly, unpublishAt: past }), NEVER_EXISTED);
eq("private + not published yet", slug({ ...membersOnly, publishAt: future }), NEVER_EXISTED);
eq("private + for some athletes only", slug({ ...membersOnly, audience: { membershipIds: ["m1"] } }), NEVER_EXISTED);

console.log("\nA genuinely public event is unchanged:");
eq("open", slug(pub), { ok: true, canRegister: true });
eq("deadline passed → still says so", slug({ ...pub, registrationDeadline: past }), { ok: false, status: 403, error: "The registration deadline has passed" });
eq("unpublished → still says closed", slug({ ...pub, unpublishAt: past }), { ok: false, status: 403, error: "Registration has closed" });
eq("not published yet → still says so", slug({ ...pub, publishAt: future }), { ok: false, status: 403, error: "Registration is not open yet" });
eq("deadline in the future → open", slug({ ...pub, registrationDeadline: future }), { ok: true, canRegister: true });
eq("hosted tournament → open", slug({ signupAccess: "MEMBERS", tournamentMode: "HOST" }), { ok: true, canRegister: true });
eq("legacy publicRegistration flag → open", slug({ signupAccess: "MEMBERS", publicRegistration: true }), { ok: true, canRegister: true });
check("publicLinkOn is the one switch", publicLinkOn(pub) && !publicLinkOn(membersOnly) && !publicLinkOn(staffOnly) && !publicLinkOn({}));

console.log("\nThe private link keeps working:");
eq("members-only event", token(membersOnly), { ok: true, canRegister: true });
eq("staff-only event", token(staffOnly), { ok: true, canRegister: true });
eq("not published yet", token({ ...staffOnly, publishAt: future }), { ok: true, canRegister: true });
eq("deadline passed → closed, as before", token({ ...membersOnly, registrationDeadline: past }), { ok: false, status: 403, error: "The registration deadline has passed" });
eq("deleted → 404", token({ ...membersOnly, deletedAt: past }), NEVER_EXISTED);

console.log("\nWiring (source checks):");
const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const routes = [
  ["page API", src("app/api/public/events/[slug]/route.ts")],
  ["register", src("app/api/public/events/[slug]/register/route.ts")],
  ["discount check", src("app/api/public/events/[slug]/validate-discount/route.ts")],
  ["quote", src("app/api/public/events/[slug]/quote/route.ts")],
] as const;
for (const [n, s] of routes) {
  check(`${n} takes its answer from linkAccess`, s.includes("linkAccess(link.via"));
  // One return for "no row" and "access refused": status and body both come
  // from the decision, so a private event and a missing one cannot differ.
  check(`${n} answers a refusal with the decision's own status and error`,
    /if \(!event \|\| !access\.ok\) \{\s*return NextResponse\.json\(\s*\{ error: access\.ok \? "Event not found" : access\.error \},\s*\{ status: access\.ok \? 404 : access\.status \},?\s*\);/.test(s));
  check(`${n} reads no event field before the access decision`,
    !/(?<!prisma\.)\bevent\.[a-zA-Z]/.test(s.slice(s.indexOf("await resolveEventLink(params.slug)"), s.indexOf("linkAccess(link.via"))));
}
const page = src("app/e/[slug]/page.tsx");
const layout = src("app/e/[slug]/layout.tsx");
check("the page turns a 404 into the neutral page", /if \(r\.status === 404\) \{\s*setUnavailable\(true\);/.test(page));
{
  const at = page.indexOf("if (unavailable) {");
  const end = page.indexOf("if (error && !event) {");
  const block = at > 0 && end > at ? page.slice(at, end) : "";
  check("the neutral page says the event isn't available", block.includes("This event isn&apos;t available"));
  check("it renders nothing from the event or the API", !/\bevent\??\.|\{error\}|club\??\.|imageUrl|startsAt|\{[a-zA-Z]/.test(block));
  check("it does not say registration is closed", !/closed|full|deadline/i.test(block));
  check("it comes before the page reads the event", at > 0 && at < page.indexOf("if (!event) return null;"));
}
check("a public event that is full still says so", page.includes('event.capacityReached ? "This event is full" : "Registration is closed"'));
check("no title or metadata is built from the event for a slug", !/prisma|findUnique|event\.name/.test(layout) && layout.includes('if (parseLinkSegment(slug).kind !== "token") return {};'));
check("the page never sets the tab title from the event", !/document\.title/.test(page));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
