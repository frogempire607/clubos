/**
 * Event attendee screen (2026-11-17): see each registrant's form answers,
 * see everyone's answers in one table / CSV, and email everyone registered.
 *
 *   npx tsx scripts/event-attendee-answers-tests.ts
 *
 * No database, no network. Dates are built from Date.now(), never typed in.
 *
 *   1  answers show under the question's own label, in the owner's order
 *   2  answers asked once per entry, removed questions, server-written keys
 *   3  the answers table and its CSV: one row per registrant, cancelled left out
 *   4  "Email registrants" reaches guests, skips cancelled, one email per address
 *   5  paid only vs everyone not cancelled
 *   6  the "Registered for event" audience no longer includes cancelled people
 *   7  the route sends through the club email path with the unsubscribe rules
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAttendeeLedger, type LedgerBooking, type LedgerRegistration } from "../lib/eventAttendees";
import { attendeeStatusText, tableToCsv } from "../lib/eventAttendeeExtras";
import { answerCell, answerColumns, answerFor, answersTable, messageToBlocks, registrantRecipients, type AnswerSource } from "../lib/eventFormAnswers";
import { ruleToWhere } from "../lib/audienceFilters";

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

const DAY = 86_400_000;
const now = new Date();
const ago = (days: number) => new Date(now.getTime() - days * DAY);

// The Finger Lakes Duals shape: a dropdown, a yes/no question, a per-entry question.
const FORM = [
  { id: "participant_category", label: "Weight class", type: "select", required: true, options: ["106", "113", "120"] },
  { id: "f_upweight", label: "Are you willing to go up a weight to win a dual?", type: "checkbox", required: false },
  { id: "f_school", label: "School", type: "text", required: false },
  { id: "f_seed", label: "Record this season", type: "text", required: false, perEntry: true },
];

const reg = (o: Partial<LedgerRegistration> & { id: string; name: string }): LedgerRegistration => ({
  memberId: null,
  email: null,
  phone: null,
  status: "PAID",
  amountDue: 40,
  amountPaid: 40,
  createdAt: ago(3),
  formResponses: {},
  ...o,
});

const regs: LedgerRegistration[] = [
  reg({ id: "r1", name: "Ava Stone", memberId: "m1", email: "", recipientEmail: "Stone.Family@example.com", formResponses: { participant_category: "113", f_upweight: true, f_school: "Lincoln" } }),
  reg({ id: "r2", name: "Ben Stone", memberId: "m2", email: "", recipientEmail: "stone.family@example.com", status: "AWAITING_CASH", amountPaid: 0, formResponses: { participant_category: "120", f_school: "Lincoln" } }),
  reg({ id: "r3", name: "Guest Wrestler", email: "guest.parent@example.com", formResponses: { participant_category: "106", f_upweight: true, __via: "private-link", old_question: "kept" } }),
  reg({ id: "r4", name: "Pulled Out", email: "pulled.out@example.com", status: "CANCELED", formResponses: { participant_category: "106" } }),
  reg({ id: "r5", name: "Declined Kid", email: "declined@example.com", status: "REGISTERED", approvalStatus: "DECLINED" }),
  reg({ id: "r6", name: "No Address", email: "", status: "AWAITING_CHECK", amountPaid: 0 }),
  reg({ id: "r7", name: "Half Checkout", email: "half@example.com", status: "PENDING_PAYMENT", amountPaid: 0 }),
];
const bookings: LedgerBooking[] = [
  { id: "b1", memberId: "m9", status: "CONFIRMED", createdAt: ago(2), member: { id: "m9", firstName: "Cora", lastName: "Member", email: "cora@example.com" } },
  { id: "b2", memberId: "m8", status: "CANCELED", createdAt: ago(2), member: { id: "m8", firstName: "Gone", lastName: "Member", email: "gone@example.com" } },
];
const ledger = buildAttendeeLedger({ capacity: null, coveredOrFree: true, sessionCount: 1 }, regs, bookings, { now });

const sources: Record<string, AnswerSource> = {};
for (const r of regs) sources[r.id] = { formResponses: (r.formResponses ?? null) as Record<string, unknown> | null, entries: [] };
sources.r1.entries = [
  { label: "Varsity · 113", answers: { f_seed: "18-2" } },
  { label: "JV · 120", answers: { f_seed: "4-0" } },
];
sources.r2.entries = [{ label: "Varsity · 120", answers: { f_seed: "9-9" } }];

console.log("\n§1 answers under the question's own label");
{
  const cols = answerColumns(FORM, [sources.r1]);
  check("columns are the form's questions, in the owner's order", cols.map((c) => c.label).join("|") === "Weight class|Are you willing to go up a weight to win a dual?|School|Record this season", cols.map((c) => c.label).join("|"));
  check("a dropdown answer reads as chosen", answerFor(sources.r1, "participant_category") === "113");
  check("a ticked checkbox reads Yes", answerFor(sources.r1, "f_upweight") === "Yes");
  check("an unticked checkbox reads No, so the column can be read top to bottom", answerCell(sources.r2, cols[1], FORM) === "No");
  check("a text question left blank stays blank", answerCell(sources.r3, cols[2], FORM) === "");
}

console.log("\n§2 per-entry answers, removed questions, server-written keys");
{
  check("two entries: each answer is named by its entry", answerFor(sources.r1, "f_seed") === "Varsity · 113: 18-2 · JV · 120: 4-0", answerFor(sources.r1, "f_seed"));
  check("one entry: just the answer", answerFor(sources.r2, "f_seed") === "9-9");
  const cols = answerColumns(FORM, Object.values(sources));
  const extra = cols.filter((c) => c.removedQuestion);
  check("an answer to a question no longer on the form is still shown", extra.length === 1 && extra[0].id === "old_question");
  check("server-written keys (private-link stamp) are never shown as answers", !cols.some((c) => c.id.startsWith("__")));
  check("a category answer stored under its short key is found", answerFor({ formResponses: { category: "126" }, entries: [] }, "participant_category") === "126");
  check("a malformed form gives no columns rather than throwing", answerColumns("nope", []).length === 0);
}

console.log("\n§3 the answers table and its CSV");
{
  const t = answersTable(ledger.rows, (id) => sources[id] ?? null, FORM, { statusText: (r) => attendeeStatusText(r) });
  const names = t.rows.map((r) => r[0]);
  check("one row per registration that has not been removed", names.length === 5 && !names.includes("Pulled Out") && !names.includes("Declined Kid"), names.join(","));
  check("a member booked without the form is not a form row", !names.includes("Cora Member"));
  check("headers carry the question text", t.headers.includes("Are you willing to go up a weight to win a dual?"));
  const col = t.headers.indexOf("Are you willing to go up a weight to win a dual?");
  const byName = Object.fromEntries(t.rows.map((r) => [r[0], r[col]]));
  check("the question is answered for every wrestler in one column", byName["Ava Stone"] === "Yes" && byName["Ben Stone"] === "No" && byName["Guest Wrestler"] === "Yes");
  const csv = tableToCsv(t);
  check("CSV has a header line plus one line per row", csv.trim().split("\r\n").length === 6);
  check("CSV carries the question text", csv.includes("Are you willing to go up a weight to win a dual?"));
  const evil = answersTable(
    buildAttendeeLedger({ capacity: null, coveredOrFree: true, sessionCount: 1 }, [reg({ id: "x", name: "X", formResponses: { f_school: "=HYPERLINK(\"http://evil\")" } })], [], { now }).rows,
    () => ({ formResponses: { f_school: "=HYPERLINK(\"http://evil\")" }, entries: [] }),
    FORM,
    { statusText: (r) => attendeeStatusText(r) },
  );
  check("an answer that starts like a formula is made plain text in the CSV", tableToCsv(evil).includes("'=HYPERLINK"));
}

console.log("\n§4 who an event email reaches");
{
  const all = registrantRecipients(ledger.rows, "all");
  const emails = all.send.map((r) => r.email).sort();
  check("a guest with no member profile is reached at the registration's own address", emails.includes("guest.parent@example.com"));
  check("a cancelled registration is skipped", !emails.includes("pulled.out@example.com"));
  check("a declined registration is skipped", !emails.includes("declined@example.com"));
  check("a cancelled booking is skipped", !emails.includes("gone@example.com"));
  check("a member booked without a registration is included", emails.includes("cora@example.com"));
  const fam = all.send.filter((r) => r.email === "stone.family@example.com");
  check("a family with two athletes gets one email, whatever the capitalisation", fam.length === 1 && fam[0].names.length === 2, JSON.stringify(fam));
  check("no address appears twice", new Set(emails).size === emails.length);
  check("someone with no address is reported, not silently dropped", all.noEmail.join() === "No Address");
  check("people counted before families are merged", all.people === 6, String(all.people));
}

console.log("\n§5 paid only, or everyone not cancelled");
{
  const paid = registrantRecipients(ledger.rows, "paid").send.map((r) => r.email).sort();
  check("paid only: the paid family, the paid guest, the covered member", paid.join() === "cora@example.com,guest.parent@example.com,stone.family@example.com", paid.join());
  check("paid only leaves out an unfinished checkout", !paid.includes("half@example.com"));
  const all = registrantRecipients(ledger.rows, "all").send.map((r) => r.email);
  check("everyone not cancelled includes people who still owe", all.includes("half@example.com"));
  const onlyUnpaidSibling = registrantRecipients(ledger.rows.filter((r) => r.name === "Ben Stone"), "paid");
  check("paid only: a family whose only athlete has not paid is not emailed", onlyUnpaidSibling.send.length === 0);
  check("a typed message keeps its lines as paragraphs", messageToBlocks("Weigh-ins at 7:30.\n\nPark behind the gym.\nBring water.").length === 3);
}

console.log("\n§6 the \"Registered for event\" audience");
(async () => {
  const where = (await ruleToWhere("club", { field: "registeredForEventId", op: "eq", value: "ev1" } as never, now)) as {
    OR: [{ bookings: { some: Record<string, unknown> } }, { eventRegistrations: { some: Record<string, unknown> } }];
  };
  const b = where.OR[0].bookings.some;
  const r = where.OR[1].eventRegistrations.some;
  check("a cancelled booking no longer counts as registered", JSON.stringify(b.status) === JSON.stringify({ not: "CANCELED" }));
  check("a cancelled registration no longer counts as registered", JSON.stringify(r.status) === JSON.stringify({ not: "CANCELED" }));
  check("a declined registration no longer counts as registered", JSON.stringify(r.OR).includes("DECLINED"));
  check("a registration that was never reviewed still counts", JSON.stringify(r.OR).includes("null"));

  console.log("\n§7 the send goes through the club's email path");
  const route = code("app/api/events/[id]/email-registrants/route.ts");
  check("recipients come from the Attendees ledger, not a second query", route.includes("loadEventAttendees(") && route.includes("registrantRecipients("));
  check("sent as a club bulk email, so the unsubscribe list applies", route.includes('kind: "BULK"') && !route.includes('kind: "TRANSACTIONAL"'));
  check("every email carries the unsubscribe link", (route.match(/listUnsubscribeUrl: unsubscribeUrl/g) ?? []).length === 2);
  check("one batch and one key per address: a retry sends nothing twice", route.includes("sendBatchId") && (route.match(/dedupeKey: `eventmail:\$\{r\.email\}`/g) ?? []).length === 2);
  check("large sends are queued for the worker instead of sent inline", route.includes("INLINE_DISPATCH_MAX") && route.includes("enqueueEmailSendRows("));
  check("needs permission to see the event and to email families", route.includes('requirePermission(session, "events", "view")') && route.includes('requirePermission(session, "messages", "send")'));
  check("it never sends mail outside sendClubEmail / the queue", !/from "@\/lib\/email"/.test(route));
  const modal = code("components/events/AttendeesModal.tsx");
  check("the Attendees screen has Email registrants, Form answers and tap-a-name", modal.includes("<EmailRegistrantsSheet") && modal.includes("<AnswersView") && modal.includes("<RegistrantSheet"));
  check("the answers CSV is the export route's answers view", code("components/events/attendees/AnswersView.tsx").includes("export?view=answers") && code("app/api/events/[id]/attendees/export/route.ts").includes('sp.get("view") === "answers"'));

  console.log(failed ? `\n${failed} FAILED` : "\nall passed");
  process.exit(failed ? 1 : 0);
})();
