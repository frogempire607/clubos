// The "Private link" badge on the Attendees list — a registration that came in
// through the event's private share link (/e/s-<token>).
// PURE: no database, no network.
//
//   npx tsx scripts/event-private-link-badge-tests.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAttendeeLedger, PRIVATE_LINK_BADGE, type LedgerBooking, type LedgerRegistration } from "../lib/eventAttendees";
import { VIA_KEY, VIA_LINK_ID_KEY, VIA_PRIVATE_LINK } from "../lib/eventShareLink";
import { validateFormResponses, eventFormFields } from "../lib/eventForm";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const reg = (over: Partial<LedgerRegistration> & { id: string }): LedgerRegistration => ({
  memberId: null, name: "Public Person", email: "p@x.test", phone: null, status: "REGISTERED",
  amountDue: null, amountPaid: null, createdAt: ago(1), ...over,
});
const booking = (over: Partial<LedgerBooking> & { id: string; memberId: string }): LedgerBooking => ({
  status: "CONFIRMED", member: { id: over.memberId, firstName: "M", lastName: over.memberId }, createdAt: ago(1), ...over,
});
const EV = { capacity: 10, coveredOrFree: false, categoryKey: "weight", categoryLabel: "Weight", sessionCount: 1 };
const VIA = { [VIA_KEY]: VIA_PRIVATE_LINK, [VIA_LINK_ID_KEY]: "0123456789abcdef" };

console.log("\nThe row says where it came from:");
{
  const l = buildAttendeeLedger(EV, [
    reg({ id: "private", formResponses: { weight: "120", ...VIA } }),
    reg({ id: "public", formResponses: { weight: "126" } }),
    reg({ id: "none", formResponses: null }),
    reg({ id: "member-private", memberId: "m1", name: "Ava Smith", formResponses: { ...VIA } }),
    reg({ id: "forged", formResponses: { __via: "something-else" } }),
    reg({ id: "gone", status: "CANCELED", formResponses: { ...VIA } }),
  ], [booking({ id: "b1", memberId: "m1" }), booking({ id: "b2", memberId: "m2" })], { now: NOW });
  const by = (id: string) => l.rows.find((r) => r.id === id)!;
  check("a private-link signup is flagged", by("private").viaPrivateLink === true);
  check("a public-link signup is not", by("public").viaPrivateLink === false);
  check("a row with no answers is not", by("none").viaPrivateLink === false);
  check("a private-link signup that matched a member keeps the flag", by("member-private").viaPrivateLink === true && by("member-private").source === "MEMBER");
  check("any other __via value is not a private link", by("forged").viaPrivateLink === false);
  check("a removed private-link signup still says so", by("gone").viaPrivateLink === true && by("gone").removed);
  check("a roster-only booking (no registration) is never flagged", by("booking:b2").viaPrivateLink === false);
  check("the flag does not change the source column", by("private").source === "PUBLIC");
  check("the flag does not change the category the row shows", by("private").categoryValue === "120");
  eq("exactly the private-link rows are flagged", l.rows.filter((r) => r.viaPrivateLink).map((r) => r.id).sort(), ["gone", "member-private", "private"]);
  eq("the flag changes no count", [l.visible, l.removed, l.filters.all], [6, 1, 6]);
}

console.log("\nThe stamp can't be forged from the form:");
{
  const fields = eventFormFields([{ id: "weight", label: "Weight", type: "text" }]);
  const checked = validateFormResponses(fields, { weight: "120", [VIA_KEY]: VIA_PRIVATE_LINK });
  check("a client-sent __via is dropped by the validator", checked.ok && !(VIA_KEY in checked.answers));
}

console.log("\nWiring (source checks):");
const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const lib = src("lib/eventAttendees.ts");
const modal = src("components/events/AttendeesModal.tsx");
const checkin = src("components/events/attendees/CheckInView.tsx");
const server = src("lib/eventAttendeesServer.ts");
const route = src("app/api/public/events/[slug]/register/route.ts");
eq("badge text", PRIVATE_LINK_BADGE, "Private link");
check("the ledger reads the stamp through the one helper", lib.includes("cameViaPrivateLink(r.formResponses)") && !lib.includes('"__via"'));
check("the ledger stays pure", !/from "@\/lib\/prisma"/.test(lib));
check("the loader hands formResponses to the ledger", /formResponses:\s*true/.test(server) && server.includes("formResponses: (r.formResponses ?? null)"));
check("the register route writes the stamp for a token signup", route.includes('link.via === "token"') && route.includes("[VIA_KEY]: VIA_PRIVATE_LINK"));
check("the Attendees list renders the badge", modal.includes("r.viaPrivateLink &&") && modal.includes("{PRIVATE_LINK_BADGE}"));
check("…in both layouts, through the one chip", (modal.match(/<SourceChip r=\{r\} \/>/g) ?? []).length >= 2);
check("the check-in list names it too", checkin.includes("r.viaPrivateLink ? PRIVATE_LINK_BADGE : null"));
{
  const at = modal.indexOf("r.viaPrivateLink &&");
  const block = modal.slice(at, at + 400);
  check("the badge text is at least 12px", /text-\[1[2-9]px\]/.test(block) && !/text-\[(10|11)px\]/.test(block));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
