// B6 — the migration queue chrome and send-result states, as fixtures.
//
//   npm run test:migration-b6
//
// NO DATABASE. NO NETWORK. Pure rules from lib/migrationQueueModel.ts.

import {
  accumulateSendResult,
  classifySendReason,
  countTurnsAndNeeds,
  emptySearchSentence,
  emptySendResult,
  isUndelivered,
  levenshtein,
  needOf,
  sentHeadline,
  suggestName,
  summarizeSkipped,
  turnOf,
  asNeed,
  asQueueTurn,
  type SendOutcome,
} from "../lib/migrationQueueModel";

let pass = 0;
let fail = 0;
let section = "";
function group(name: string) {
  section = name;
  console.log(`\n${name}`);
}
function eq<T>(name: string, actual: T, expected: T) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else {
    fail++;
    console.log(`  ✗ [${section}] ${name}\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`);
  }
}

group("§1 whose turn — same rule as the funnel");
eq("step 7 is done even if blocked", turnOf({ step: 7, waitingOn: "BLOCKED" }), "done");
eq("blocked is needs you", turnOf({ step: 2, waitingOn: "BLOCKED" }), "needs_you");
eq("staff is needs you", turnOf({ step: 1, waitingOn: "STAFF" }), "needs_you");
eq("member is waiting on member", turnOf({ step: 3, waitingOn: "MEMBER" }), "waiting_member");
eq("nobody (snoozed) is in setup", turnOf({ step: 3, waitingOn: "NOBODY" }), "in_setup");
eq("unknown waitingOn falls to in setup", turnOf({ step: 3, waitingOn: "???" }), "in_setup");
eq("asQueueTurn accepts a known key", asQueueTurn("done"), "done");
eq("asQueueTurn rejects junk", asQueueTurn("drop table"), null);

group("§2 needs-you cards");
eq("unreviewed → review", needOf({ step: 1, waitingOn: "STAFF" }), "review");
eq("step 0 staff → review", needOf({ step: 0, waitingOn: "STAFF" }), "review");
eq("reviewed not invited → invite", needOf({ step: 2, waitingOn: "STAFF" }), "invite");
eq("profile done → approve", needOf({ step: 5, waitingOn: "STAFF" }), "approve");
eq("step 6 staff → no card", needOf({ step: 6, waitingOn: "STAFF" }), null);
eq("blocked outranks step", needOf({ step: 2, waitingOn: "BLOCKED" }), "blocked");
eq("member's turn → no card", needOf({ step: 3, waitingOn: "MEMBER" }), null);
eq("done → no card", needOf({ step: 7, waitingOn: "STAFF" }), null);
eq("asNeed rejects junk", asNeed("x"), null);
const counted = countTurnsAndNeeds([
  { step: 1, waitingOn: "STAFF" },
  { step: 1, waitingOn: "STAFF" },
  { step: 2, waitingOn: "STAFF" },
  { step: 2, waitingOn: "BLOCKED" },
  { step: 3, waitingOn: "MEMBER" },
  { step: 4, waitingOn: "MEMBER" },
  { step: 5, waitingOn: "STAFF" },
  { step: 6, waitingOn: "STAFF" },
  { step: 3, waitingOn: "NOBODY" },
  { step: 7, waitingOn: "NOBODY" },
]);
eq("turn counts", counted.turns, { needs_you: 6, waiting_member: 2, in_setup: 1, done: 1 });
eq("need counts", counted.needs, { review: 2, invite: 1, approve: 1, blocked: 1 });
eq(
  "cards never exceed the needs-you segment",
  Object.values(counted.needs).reduce((a, b) => a + b, 0) <= counted.turns.needs_you,
  true,
);

group("§3 send reasons");
eq("no email", classifySendReason("no email on file"), "NO_EMAIL");
eq("already completed", classifySendReason("already completed"), "ALREADY_COMPLETE");
eq("not found", classifySendReason("not found"), "NOT_FOUND");
eq("provider failure", classifySendReason("email failed: Error: 550 mailbox unavailable"), "SEND_FAILED");
eq("club missing → other", classifySendReason("club missing"), "OTHER");
eq("undefined → other", classifySendReason(undefined), "OTHER");
eq("only SEND_FAILED is undelivered", ["NO_EMAIL", "ALREADY_COMPLETE", "NOT_FOUND", "SEND_FAILED", "OTHER"].map((c) => isUndelivered(c as never)), [false, false, false, true, false]);

const sk = (id: string, reason: SendOutcome["reason"]): SendOutcome => ({ memberId: id, name: id, reason });
eq("nothing skipped → empty", summarizeSkipped([]), "");
eq("one person", summarizeSkipped([sk("a", "NO_EMAIL")]), "1 person was skipped: 1 has no email on file.");
eq(
  "largest group first",
  summarizeSkipped([sk("a", "ALREADY_COMPLETE"), sk("b", "NO_EMAIL"), sk("c", "NO_EMAIL")]),
  "3 people were skipped: 2 have no email on file, 1 already finished moving over.",
);
eq(
  "ties in fixed order",
  summarizeSkipped([sk("a", "NOT_FOUND"), sk("b", "NO_EMAIL")]),
  "2 people were skipped: 1 has no email on file, 1 is no longer on the roster.",
);
eq("headline plural", sentHeadline(21, false), "21 invitations sent");
eq("headline singular reminder", sentHeadline(1, true), "1 reminder sent");
eq("headline zero", sentHeadline(0, false), "0 invitations sent");

let r = emptySendResult(false);
r = accumulateSendResult(r, { sent: 10, membersInvited: 2, skipped: [sk("a", "NO_EMAIL")], undelivered: [] });
r = accumulateSendResult(r, { sent: 11, skipped: [sk("a", "NO_EMAIL"), sk("b", "ALREADY_COMPLETE")], undelivered: [sk("c", "SEND_FAILED")] });
r = accumulateSendResult(r, { sent: 0 }); // older server: no arrays
eq("accumulate sent", r.sent, 21);
eq("accumulate covered", r.covered, 2);
eq("accumulate dedupes skipped by member", r.skipped.map((x) => x.memberId), ["a", "b"]);
eq("accumulate undelivered", r.undelivered.map((x) => x.memberId), ["c"]);
eq("accumulate keeps reminder flag", r.reminder, false);

group("§4 empty search");
eq("query + filters", emptySearchSentence("jon", ["Step 3 · Invitation sent", "Invited"]), "No one matches ‘jon’ with Step 3 · Invitation sent · Invited");
eq("query only", emptySearchSentence(" jon ", []), "No one matches ‘jon’");
eq("filters only", emptySearchSentence("", ["Needs you"]), "No one matches with Needs you");
eq("blank labels dropped", emptySearchSentence("x", [null, "", "Done"]), "No one matches ‘x’ with Done");
eq("nothing at all", emptySearchSentence("", []), "No one here yet");

eq("levenshtein equal", levenshtein("abc", "abc"), 0);
eq("levenshtein insert", levenshtein("jon", "john"), 1);
eq("levenshtein kitten", levenshtein("kitten", "sitting"), 3);
eq("levenshtein empty", levenshtein("", "abc"), 3);

const names = ["John Smith", "Maria Garcia", "Jonathan Lee", "Sara Kim"];
eq("typo in last name", suggestName("smiht", names), "Smith");
eq("typo in first name, case-insensitive", suggestName("MARIE", names), "Maria");
eq("full-name typo", suggestName("sara kin", names), "Sara Kim");
eq("exact word exists → no suggestion", suggestName("john", names), null);
eq("too far → none", suggestName("zzzzz", names), null);
eq("too short → none", suggestName("jo", names), null);
eq("closest wins", suggestName("garcai", ["Garcia", "Garcias"]), "Garcia");
eq("respects maxDistance", suggestName("smiht", names, 1), null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
