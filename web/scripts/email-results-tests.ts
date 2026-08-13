// Pure tests for lib/emailResults.ts. No DB, no network.
//   npx tsx scripts/email-results-tests.ts

import { tallyEmailSends, trackingCapableRatio, batchState, batchStateLabel, type TallyRow } from "../lib/emailResults";

let pass = 0;
let fail = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  console.error(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`);
}

const blank: TallyRow = {
  status: "SENT", skippedReason: null, providerMessageId: null,
  sentAt: null, deliveredAt: null, bouncedAt: null, openedAt: null, clickedAt: null,
};
const row = (o: Partial<TallyRow>): TallyRow => ({ ...blank, ...o });
const D = "2026-08-13T00:00:00.000Z";

// --- empty ---------------------------------------------------------------
{
  const c = tallyEmailSends([]);
  eq(c.intended, 0, "empty: intended");
  eq(c.sent, 0, "empty: sent");
  eq(c.trackingCapable, 0, "empty: trackingCapable");
  eq(trackingCapableRatio(c), 0, "empty: ratio does not divide by zero");
  eq(batchState(c), "NOTHING_SENT", "empty: state");
}

// --- a plain successful send --------------------------------------------
{
  const c = tallyEmailSends([
    row({ status: "SENT", sentAt: D, deliveredAt: D, providerMessageId: "m1" }),
    row({ status: "SENT", sentAt: D, deliveredAt: D, openedAt: D, providerMessageId: "m2" }),
  ]);
  eq(c.intended, 2, "clean: intended");
  eq(c.sent, 2, "clean: sent");
  eq(c.delivered, 2, "clean: delivered");
  eq(c.opened, 1, "clean: opened");
  eq(c.clicked, 0, "clean: clicked");
  eq(c.trackingCapable, 2, "clean: trackingCapable");
  eq(batchState(c), "SENT", "clean: state");
}

// --- a null openedAt is never a zero-open claim, it is unknown -----------
{
  // SMTP send: delivered, but no providerMessageId, so no open can ever
  // arrive. trackingCapable must be 0 so the UI refuses to show a rate.
  const c = tallyEmailSends([
    row({ status: "SENT", sentAt: D, deliveredAt: D, providerMessageId: null }),
    row({ status: "SENT", sentAt: D, deliveredAt: D, providerMessageId: null }),
  ]);
  eq(c.opened, 0, "untracked: opened stays 0");
  eq(c.trackingCapable, 0, "untracked: nothing is trackable");
  eq(trackingCapableRatio(c), 0, "untracked: ratio 0");
}

// --- a row that opened but whose status column lagged counts as sent -----
{
  const c = tallyEmailSends([
    row({ status: "QUEUED", openedAt: D, providerMessageId: "m1" }),
  ]);
  eq(c.sent, 1, "lagging status: an opened row was sent");
  eq(c.queued, 1, "lagging status: still reported as queued by status");
}

// --- skip reasons are broken out individually ---------------------------
{
  const c = tallyEmailSends([
    row({ status: "SKIPPED", skippedReason: "NO_EMAIL" }),
    row({ status: "SKIPPED", skippedReason: "OPTED_OUT" }),
    row({ status: "SKIPPED", skippedReason: "INVALID_ADDRESS" }),
    row({ status: "SKIPPED", skippedReason: "DUPLICATE_IN_BATCH" }),
    row({ status: "SKIPPED", skippedReason: "NO_PROVIDER" }),
  ]);
  eq(c.skipped, 5, "skips: total");
  eq(c.sent, 0, "skips: nothing counted as sent");
  eq(c.skippedNoEmail, 1, "skips: no email");
  eq(c.skippedOptedOut, 1, "skips: opted out");
  eq(c.skippedInvalid, 1, "skips: invalid");
  eq(c.skippedDuplicate, 1, "skips: duplicate");
  eq(c.skippedNoProvider, 1, "skips: no provider");
  eq(batchState(c), "NOTHING_SENT", "skips: state is nothing-sent, not sent");
}

// --- a bounce is a problem, not a success -------------------------------
{
  const c = tallyEmailSends([
    row({ status: "SENT", sentAt: D, deliveredAt: D, providerMessageId: "m1" }),
    row({ status: "SENT", sentAt: D, bouncedAt: D, providerMessageId: "m2" }),
  ]);
  eq(c.bounced, 1, "bounce: counted");
  eq(batchState(c), "PROBLEMS", "bounce: state");
  eq(batchStateLabel(batchState(c)), "Sent with problems", "bounce: label");
}

// --- a provider failure is a problem ------------------------------------
{
  const c = tallyEmailSends([
    row({ status: "SENT", sentAt: D }),
    row({ status: "FAILED" }),
  ]);
  eq(c.failed, 1, "failure: counted");
  eq(c.sent, 1, "failure: the failed row is not counted as sent");
  eq(batchState(c), "PROBLEMS", "failure: state");
}

// --- a half-drained queue reads as sending, not as sent -----------------
{
  const c = tallyEmailSends([
    row({ status: "SENT", sentAt: D, providerMessageId: "m1" }),
    row({ status: "QUEUED" }),
  ]);
  eq(c.queued, 1, "queue: counted");
  eq(batchState(c), "SENDING", "queue: outstanding rows dominate the state");
  eq(batchStateLabel(batchState(c)), "Sending", "queue: label");
}

// --- a queue that has drained and bounced is a problem, not sending -----
{
  const c = tallyEmailSends([
    row({ status: "SENT", sentAt: D, bouncedAt: D, providerMessageId: "m1" }),
  ]);
  eq(batchState(c), "PROBLEMS", "drained queue with a bounce: state");
}

// --- ratio uses intended, so untracked recipients dilute honestly -------
{
  const c = tallyEmailSends([
    row({ status: "SENT", sentAt: D, providerMessageId: "m1" }),
    row({ status: "SENT", sentAt: D, providerMessageId: null }),
    row({ status: "SENT", sentAt: D, providerMessageId: null }),
    row({ status: "SENT", sentAt: D, providerMessageId: null }),
  ]);
  eq(c.trackingCapable, 1, "ratio: one trackable");
  eq(trackingCapableRatio(c), 0.25, "ratio: 1 of 4");
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
