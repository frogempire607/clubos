// Two fixes from 2026-11-17:
//
//  A. No raw error code ever reaches a member. The Schedule page printed
//     "ROSTER_REQUIRED"; it now hands such registrations to the Events page's
//     register flow, and every member-portal error goes through
//     lib/memberErrorText. A source guard fails the build if a page prints
//     `.error` straight onto the screen again.
//  B. "Remove, keep the payment": a paid registrant can be removed with an
//     explicit refund-or-keep choice, by the owner or billing staff only; a
//     kept payment stays on the row and reads "Removed, paid $X, not refunded".
//
// PURE plus source-text guards. No database.
//   npx tsx scripts/member-errors-and-remove-paid-tests.ts

import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import {
  memberErrorText,
  looksLikeErrorCode,
  EVENT_REGISTER_FLOW_CODES,
  eventRegisterFlowPath,
} from "../lib/memberErrorText";
import { buildAttendeeLedger, removedPaidLabel, keptFromRemoved, type LedgerRegistration } from "../lib/eventAttendees";
import { removePlan, attendeeTiles } from "../lib/eventAttendeeActions";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = join(__dirname, "..");
const code = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

console.log("\nA. memberErrorText never returns a code:");
{
  check("ROSTER_REQUIRED is a code", looksLikeErrorCode("ROSTER_REQUIRED"));
  check("a sentence is not a code", !looksLikeErrorCode("This class is full."));
  const t = memberErrorText({ error: "ROSTER_REQUIRED" }, "Could not register.");
  check("known code → plain words", t !== "ROSTER_REQUIRED" && /details/.test(t), t);
  check("unknown code → the page's fallback", memberErrorText({ error: "SOMETHING_NEW_XYZ" }, "Could not register.") === "Could not register.");
  check("message wins over code", memberErrorText({ error: "SPOT_FULL", message: "That spot was just taken." }, "x") === "That spot was just taken.");
  check("a sentence in `error` is kept (older routes)", memberErrorText({ error: "Club not found." }, "x") === "Club not found.");
  check("a code in `message` is never shown", memberErrorText({ message: "FORM_INVALID" }, "Fallback.") !== "FORM_INVALID");
  check("objects never leak", memberErrorText({ error: { fieldErrors: {} } }, "Save failed") === "Save failed");
  check("null body → fallback", memberErrorText(null, "Fallback.") === "Fallback.");
  for (const c of ["ROSTER_REQUIRED", "FORM_REQUIRED", "FORM_INVALID", "ENTRIES_INVALID", "PAYMENT_METHOD_REQUIRED"]) {
    check(`${c} sends the person to the full register flow`, EVENT_REGISTER_FLOW_CODES.has(c));
  }
  const p = eventRegisterFlowPath("evt_1", "mem_2");
  // 2026-11-18: the hand-off now opens the event's details screen with the register flow started.
  check("hand-off path names the event and the athlete", p === "/member/events/evt_1?memberId=mem_2&register=1", p);
  check("hand-off path stays inside the portal", p.startsWith("/member/"));
}

console.log("\nA. Source guards:");
{
  const sched = code("app/member/schedule/page.tsx");
  check("Schedule register hands over to the details screen's register flow (never posts itself)", /eventRegisterFlowPath\(item\.refId, target\.memberId\)/.test(sched) && !/\/register`/.test(sched));
  const events = code("app/member/events/page.tsx");
  check("old ?event=&memberId= links forward to the details screen for that athlete", /router\.replace\(eventDetailsPath\(id, sp\.get\("memberId"\)/.test(events));

  // Every member-facing surface: no `x.error ||`, no `typeof x.error === "string" ? x.error`,
  // no `msg = x.error;` — those print whatever the server sent, codes included.
  const RAW = [
    /\b[a-zA-Z]+\??\.error\s*\|\|/,
    /typeof\s+([a-zA-Z]+)\.error\s*===\s*"string"\s*\?\s*\1\.error\b/,
    /=\s*[a-zA-Z]+\.error\s*;/,
    /\{\s*[a-zA-Z]+\.error\s*\}/,
  ];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name)) files.push(p);
    }
  };
  for (const d of ["app/member", "components/member"]) walk(join(ROOT, d));
  const offenders: string[] = [];
  for (const f of files) {
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (RAW.some((re) => re.test(line))) offenders.push(`${relative(ROOT, f)}:${i + 1}`);
    });
  }
  check(`no member-portal file prints a raw .error (${files.length} files scanned)`, offenders.length === 0, offenders.join(", "));
}

console.log("\nB. Removing someone who paid:");
const now = new Date();
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
const reg = (over: Partial<LedgerRegistration> & { id: string }): LedgerRegistration => ({
  memberId: null, name: over.id, email: `${over.id}@x.test`, phone: null, status: "REGISTERED",
  amountDue: null, amountPaid: null, createdAt: daysAgo(10), ...over,
});
const EV = { capacity: 20, coveredOrFree: false, categoryKey: null, categoryLabel: null, sessionCount: 1 };
{
  // Shaped like Tucker Tominack on Parabellum Duals: a guest (no member
  // profile), card payment of $61.74 on a $60 entry, set CANCELED by hand
  // with the payment kept.
  const ledger = buildAttendeeLedger(EV, [
    reg({ id: "tucker", status: "CANCELED", approvalStatus: "APPROVED", amountDue: 60, amountPaid: 61.74, paidByCard: true, refundedAmount: null }),
    reg({ id: "refunded", status: "CANCELED", amountDue: 60, amountPaid: 60, paidByCard: true, refundedAmount: 60 }),
    reg({ id: "partial", status: "CANCELED", amountDue: 60, amountPaid: 60, paidByCard: true, refundedAmount: 20 }),
    reg({ id: "live", status: "PAID", amountDue: 60, amountPaid: 60, paidByCard: true }),
    reg({ id: "cashpaid", status: "PAID", amountDue: 60, amountPaid: 60, paidByCard: false }),
    reg({ id: "unpaid-gone", status: "CANCELED", amountDue: null }),
  ], [], { now });
  const row = (id: string) => ledger.rows.find((r) => r.registrationId === id)!;

  check("Tucker is in the removed section", row("tucker").removed);
  check("Tucker reads “Removed, paid $61.74, not refunded”", row("tucker").label === "Removed, paid $61.74, not refunded", row("tucker").label);
  check("a full refund reads as refunded", row("refunded").label === "Removed, refunded $60.00", row("refunded").label);
  check("a part refund says how much", row("partial").label === "Removed, paid $60.00, $20.00 refunded", row("partial").label);
  check("an unpaid removal keeps the plain label", row("unpaid-gone").label === "Canceled", row("unpaid-gone").label);
  check("kept money: Tucker 61.74, partial 40, refunded 0", keptFromRemoved(row("tucker")) === 61.74 && keptFromRemoved(row("partial")) === 40 && keptFromRemoved(row("refunded")) === 0);
  check("Collected counts kept money (60 + 61.74 + 40 + 60)", ledger.tiles.collected === 221.74, String(ledger.tiles.collected));
  check("…and the tile says how much came from removed people", /\$101\.74 from removed/.test(attendeeTiles(ledger)[0].sub), attendeeTiles(ledger)[0].sub);
  check("removed rows never count as attendees or spots", ledger.visible === 2 && ledger.capacity.attendees === 2);
  check("removedPaidLabel never claims more refunded than paid", removedPaidLabel(10, 50) === "Removed, refunded $10.00");

  const owner = { canDecideMoney: true };
  const coach = { canDecideMoney: false };
  const p = removePlan(row("live"), null, owner);
  check("paid card registrant → a refund-or-keep choice", p.kind === "paid" && p.refundUnavailable === null && p.notAllowed === null);
  const c = removePlan(row("cashpaid"), null, owner);
  check("paid in cash → keep is offered, refund from here is not", c.kind === "paid" && !!c.refundUnavailable && c.notAllowed === null);
  const s = removePlan(row("live"), null, coach);
  check("staff without billing permission → refused with a reason", s.kind === "paid" && !!s.notAllowed);
  check("no viewer given → refused (fails closed)", (() => { const x = removePlan(row("live")); return x.kind === "paid" && !!x.notAllowed; })());
}

console.log("\nB. Source guards on the DELETE route:");
{
  const route = code("app/api/events/[id]/registrations/[regId]/route.ts");
  check("a paid registrant still needs an explicit choice", /PAID_CHOICE_REQUIRED/.test(route));
  check("the choice needs billing:full, checked live", /hasPermissionLive\(session, "billing", "full"\)/.test(route));
  const keep = route.slice(route.indexOf("async function removePaid"));
  const claim = keep.slice(keep.indexOf("prisma.eventRegistration.updateMany"), keep.indexOf("if (claimed.count === 0)"));
  check("keep/refund claims the row once (conditional on not already CANCELED)", /status: \{ not: "CANCELED" \}/.test(claim));
  check("the claim never touches amountPaid, transactionId or the payment intent", !/amountPaid|transactionId|stripePaymentIntentId|amountDue/.test(claim.slice(claim.indexOf("data:"))));
  check("keeping writes an audit row saying the payment was kept", /EVENT_REGISTRATION_REMOVED_PAYMENT_KEPT/.test(keep) && /was kept — not refunded/.test(keep));
  check("refund reuses the decline path's idempotency key", /idempotencyKey: `aox-eventreg-refund-\$\{reg\.id\}`/.test(keep));
  check("a failed refund is audited, never retried", /EVENT_REGISTRATION_REFUND_FAILED/.test(keep));
  const modal = code("components/events/AttendeesModal.tsx");
  check("Attendees offers both choices in an in-app dialog", /Remove and refund/.test(modal) && /Remove, keep the payment/.test(modal));
  check("removed people have their own section", /aria-label="Removed"/.test(modal));
  check("the live list never mixes removed rows in", /visibleRows\(ledger, filter, false\)/.test(modal));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
