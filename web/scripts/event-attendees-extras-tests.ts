// The Attendees screen extras (design handoff §3): Export, Check-in mode and
// the per-row sent-link history — the pure rules in lib/eventAttendeeExtras.ts.
// CSV rows come off the ONE ledger through the screen's filter; cells are
// quoted and formula-neutralised; the door counter and the pay-first block
// reuse the member check-in gate; link history text reads invoiceCount /
// invoicedAt. PURE: no database.
//
//   npx tsx scripts/event-attendees-extras-tests.ts

import { buildAttendeeLedger, type LedgerBooking, type LedgerRegistration } from "../lib/eventAttendees";
import { cashRecordable } from "../lib/eventAttendeeActions";
import {
  attendeeExportTable,
  attendeeStatusText,
  checkInCounts,
  checkInRows,
  checkInState,
  csvCell,
  filterCheckIn,
  linkSentSummary,
  neutralizeFormula,
  NO_MEMBER_REASON,
  parseExportFilter,
  paymentMethodText,
  sendRegistrationId,
  sendStatusText,
  tableToCsv,
  type CheckInRecord,
  type RowExtras,
} from "../lib/eventAttendeeExtras";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const NOW = new Date("2026-09-22T12:00:00Z");
const reg = (over: Partial<LedgerRegistration> & { id: string }): LedgerRegistration => ({
  memberId: null, name: over.id, email: `${over.id}@x.test`, phone: null, status: "REGISTERED",
  amountDue: null, amountPaid: null, createdAt: "2026-09-01T00:00:00Z", ...over,
});
const booking = (over: Partial<LedgerBooking> & { id: string; memberId: string }): LedgerBooking => ({
  status: "CONFIRMED", member: { id: over.memberId, firstName: "M", lastName: over.memberId, email: null, phone: null }, createdAt: "2026-09-01T00:00:00Z", ...over,
});
const EV = { capacity: 20, coveredOrFree: false, categoryKey: "division", categoryLabel: "Division", sessionCount: 1 };

const ledger = buildAttendeeLedger(EV, [
  reg({ id: "paid", name: "Ada Paid", memberId: "m1", status: "PAID", amountDue: 200, amountPaid: 200, formResponses: { division: "Open" }, createdAt: "2026-09-05T00:00:00Z" }),
  reg({ id: "cash", name: "Cy Cash", memberId: "m2", status: "AWAITING_CASH", amountDue: 150, createdAt: "2026-09-04T00:00:00Z" }),
  reg({ id: "public", name: "=HYPERLINK(\"x\")", memberId: null, status: "PAID", amountDue: 50, amountPaid: 50, phone: "+1 607 555 0100", createdAt: "2026-09-03T00:00:00Z" }),
  reg({ id: "sched", name: "Sam, \"Sched\"", memberId: "m3", status: "SCHEDULED", amountDue: 80, scheduledChargeAt: "2026-09-30T00:00:00Z", createdAt: "2026-09-02T00:00:00Z" }),
  reg({ id: "review", name: "Rae Review", memberId: "m4", status: "PENDING_REVIEW", approvalStatus: "PENDING", amountDue: 90, createdAt: "2026-09-01T12:00:00Z" }),
  reg({ id: "gone", name: "Gus Gone", memberId: "m5", status: "CANCELED", createdAt: "2026-09-01T06:00:00Z" }),
], [
  booking({ id: "b1", memberId: "m1" }),
  booking({ id: "b-wait", memberId: "m8", status: "WAITLISTED" }),
  booking({ id: "b-free", memberId: "m9" }),
], { now: NOW });
const row = (id: string) => ledger.rows.find((r) => r.registrationId === id || r.bookingId === id)!;

const extras: Record<string, RowExtras> = {
  paid: { paymentMethod: "CARD", paidVia: "STRIPE", invoiceCount: 0, invoicedAt: null, paymentUrl: null },
  cash: { paymentMethod: "CASH", paidVia: null, invoiceCount: 3, invoicedAt: "2026-09-20T15:00:00.000Z", paymentUrl: "https://checkout.test/c" },
  public: { paymentMethod: null, paidVia: "CASH", invoiceCount: 1, invoicedAt: "2026-09-18T15:00:00.000Z", paymentUrl: null },
};

console.log("\nExport table — the screen's rows and columns:");
{
  const t = attendeeExportTable(ledger, { filter: "all", showRemoved: false, categoryLabel: "Division", extras });
  eq("headers in screen order, category column uses the event's own label", t.headers, [
    "Name", "Source", "Email", "Phone", "Division", "Attending", "Owes", "Status", "Paid", "Payment method", "Last link sent", "Times sent",
  ]);
  eq("all = every visible row (removed hidden)", t.rows.length, ledger.visible);
  const cash = t.rows.find((r) => r[0] === "Cy Cash")!;
  eq("owes row: owes, status, method, last link date, times sent", [cash[6], cash[7], cash[9], cash[10], cash[11]], ["150.00", "Awaiting cash", "Cash", "2026-09-20", 3]);
  const paid = t.rows.find((r) => r[0] === "Ada Paid")!;
  eq("paid row: category value, paid amount, paid via card, no owes", [paid[4], paid[6], paid[8], paid[9]], ["Open", "", "200.00", "Card"]);
  const pub = t.rows.find((r) => String(r[0]).startsWith("=HYP"))!;
  eq("public source", pub[1], "Public");
  const sched = t.rows.find((r) => String(r[0]).startsWith("Sam"))!;
  eq("scheduled status matches the pill text", sched[7], "Card charge 2026-09-30");
  const bookingOnly = t.rows.find((r) => r[0] === "M m9")!;
  eq("booking-only row has blank link columns", [bookingOnly[10], bookingOnly[11]], ["", ""]);

  const owes = attendeeExportTable(ledger, { filter: "owes", showRemoved: false, categoryLabel: null, extras });
  eq("filter respected — owes only", owes.rows.map((r) => r[0]), ["Cy Cash"]);
  eq("no category label → 'Category'", owes.headers[4], "Category");
  const withRemoved = attendeeExportTable(ledger, { filter: "all", showRemoved: true, categoryLabel: null, extras });
  eq("show removed adds the canceled row, marked", withRemoved.rows.find((r) => r[0] === "Gus Gone")?.[7], "Canceled (removed)");
  eq("parseExportFilter: known", parseExportFilter("settled"), "settled");
  eq("parseExportFilter: junk → all", parseExportFilter("drop table"), "all");
  eq("parseExportFilter: null → all", parseExportFilter(null), "all");
}

console.log("\nCSV — quoting and formula injection:");
{
  eq("= is neutralised", neutralizeFormula("=1+1"), "'=1+1");
  eq("+ is neutralised (phone numbers too)", neutralizeFormula("+1 607"), "'+1 607");
  eq("- is neutralised", neutralizeFormula("-2"), "'-2");
  eq("@ is neutralised", neutralizeFormula("@SUM(A1)"), "'@SUM(A1)");
  eq("tab is neutralised", neutralizeFormula("\t=1"), "'\t=1");
  eq("plain text untouched", neutralizeFormula("Ada"), "Ada");
  eq("a formula char mid-string is fine", neutralizeFormula("a=b"), "a=b");
  eq("quotes doubled and wrapped", csvCell('Sam, "Sched"'), '"Sam, ""Sched"""');
  eq("formula + quotes: prefix then quote", csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  eq("newline wrapped", csvCell("a\nb"), '"a\nb"');
  eq("numbers never prefixed", csvCell(-3), "-3");
  eq("null → empty", csvCell(null), "");
  const csv = tableToCsv({ headers: ["Name", "N"], rows: [["=x", 2], ["ok", ""]] });
  check("BOM + CRLF rows", csv === "﻿Name,N\r\n'=x,2\r\nok,\r\n", JSON.stringify(csv));
  const full = tableToCsv(attendeeExportTable(ledger, { filter: "all", showRemoved: false, categoryLabel: "Division", extras }));
  check("no line of the real export starts a cell with a bare formula char", !full.split(/\r\n/).some((l) => /(^|,)[=+\-@]/.test(l.replace(/^﻿/, ""))));
}

console.log("\nPayment method + status text:");
{
  eq("paid via stripe → Card", paymentMethodText({ paidVia: "STRIPE", paymentMethod: "CASH" }), "Card");
  eq("unpaid saved card", paymentMethodText({ paidVia: null, paymentMethod: "AUTO_CARD" }), "Saved card");
  eq("unknown → blank", paymentMethodText(undefined), "");
  eq("waiting on the parent wins the pill", attendeeStatusText({ ...row("review"), waitingOn: "PARENT" }), "Waiting on the parent");
}

console.log("\nCheck-in — who can, who can't, and the counter:");
{
  const opts = { requirePaymentBeforeCheckin: true, cashRecordable };
  const recs: CheckInRecord[] = [
    { recordId: "a1", memberId: "m1", status: "PRESENT", checkedInAt: "2026-09-22T17:00:00Z" },
    { recordId: "a9", memberId: "m9", status: "ABSENT", checkedInAt: null },
  ];
  const list = checkInRows(ledger.rows, recs, opts);
  const st = (name: string) => list.find((x) => x.row.name === name)?.state;
  eq("removed + waitlisted are not expected at the door", list.some((x) => x.row.name === "Gus Gone" || x.row.bookingId === "b-wait"), false);
  eq("alphabetical", list.map((x) => x.row.name), [...list.map((x) => x.row.name)].sort((a, b) => a.localeCompare(b)));
  eq("PRESENT record → in", st("Ada Paid")?.kind, "in");
  eq("ABSENT record is not an arrival", st("M m9")?.kind, "ready");
  const cash = st("Cy Cash");
  eq("pay-first + awaiting cash → blocked", cash?.kind, "blocked");
  check("block reason is the member check-in gate's sentence", cash?.kind === "blocked" && cash.reason === "Payment of $150.00 in cash is due before check-in.");
  check("blocked cash row offers Record cash", cash?.kind === "blocked" && cash.canRecordCash);
  eq("pending review holds no spot, so it is not on the door list", st("Rae Review"), undefined);
  const rev = checkInState(row("review"), { requirePaymentBeforeCheckin: true, record: null, cashRecordable });
  check("…and if reached directly it is blocked with the approval reason, no cash shortcut", rev.kind === "blocked" && rev.reason.includes("coach approval") && !rev.canRecordCash);
  eq("scheduled card charge is not blocked", st('Sam, "Sched"')?.kind, "ready");
  const pub = list.find((x) => x.row.registrationId === "public")!.state;
  eq("public signup with no member → noMember with the note", pub, { kind: "noMember", reason: NO_MEMBER_REASON });

  const off = checkInState(row("cash"), { requirePaymentBeforeCheckin: false, record: null, cashRecordable });
  eq("gate off → owes but can check in", off.kind, "ready");
  const dup = checkInRows(ledger.rows, [
    { recordId: "x1", memberId: "m2", status: "ABSENT", checkedInAt: null },
    { recordId: "x2", memberId: "m2", status: "LATE", checkedInAt: "2026-09-22T17:05:00Z" },
  ], { requirePaymentBeforeCheckin: false, cashRecordable });
  eq("duplicate records: an arrival beats a non-arrival", dup.find((x) => x.row.memberId === "m2")?.state.kind, "in");

  const c = checkInCounts(list);
  eq("counter", [c.checkedIn, c.expected, c.notYet, c.noMember, c.blocked], [1, list.length, list.length - 1, 1, 1]);
  eq("counter label", c.label, `1 of ${list.length} checked in`);
  eq("Not yet here hides the checked-in", filterCheckIn(list, "", true).some((x) => x.state.kind === "in"), false);
  eq("search by name, case-insensitive", filterCheckIn(list, "cy c", false).map((x) => x.row.name), ["Cy Cash"]);
  eq("search by category value", filterCheckIn(list, "open", false).map((x) => x.row.name), ["Ada Paid"]);
  eq("search by phone", filterCheckIn(list, "555 0100", false).length, 1);
  eq("search + not yet here", filterCheckIn(list, "ada", true).length, 0);
}

console.log("\nSent-link history text:");
{
  const fmt = (s: string) => s.slice(5, 10);
  eq("never sent → null", linkSentSummary({ invoiceCount: 0, invoicedAt: null }, fmt), null);
  eq("once", linkSentSummary({ invoiceCount: 1, invoicedAt: "2026-09-20T00:00:00Z" }, fmt), "Link sent · 09-20");
  eq("3×", linkSentSummary({ invoiceCount: 3, invoicedAt: "2026-09-20T00:00:00Z" }, fmt), "Link sent 3× · last 09-20");
  eq("count with no date", linkSentSummary({ invoiceCount: 2, invoicedAt: null }, fmt), "Link sent 2×");
  eq("missing extras → null", linkSentSummary(undefined), null);
  eq("delivered", sendStatusText({ status: "DELIVERED", note: null }), { label: "Delivered", tone: "ok" });
  eq("bounced", sendStatusText({ status: "BOUNCED", note: null }).tone, "bad");
  eq("failed", sendStatusText({ status: "FAILED", note: "smtp down" }).label, "Failed");
  eq("skipped carries the reason", sendStatusText({ status: "SKIPPED", note: "opted-out" }).label, "Not sent (opted-out)");
  const ids = new Set(["r1", "r2"]);
  eq("confirmation key → reg", sendRegistrationId("event-confirm:r1", ids), "r1");
  eq("stamped key → reg", sendRegistrationId("event-proposal:r2:2026-09-01T00:00:00.000Z", ids), "r2");
  eq("unknown reg → null", sendRegistrationId("event-confirm:zz", ids), null);
  eq("no key → null", sendRegistrationId(null, ids), null);
  eq("key without an id → null", sendRegistrationId("digest", ids), null);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
