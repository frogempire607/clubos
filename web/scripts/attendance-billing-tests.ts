/**
 * The attendance billing gate — "don't record a non-member as present in
 * silence".
 *
 *   npm run test:attendance-billing
 *
 * No database, no network. lib/attendanceBilling.ts is pure precisely so every
 * branch can be constructed by hand here, the way lib/entitlements.ts is
 * exercised by scripts/entitlements-tests.ts.
 *
 * ── What these assertions are defending ─────────────────────────────────────
 *
 * Two rules that are easy to "clean up" into bugs:
 *
 *   1. The membership question is the COUNT OF ACTIVE SUBSCRIPTION ROWS.
 *      Not Member.status, not countsAsMembership(). Events, privates and class
 *      booking all ask the row question — pinned in
 *      scripts/member-tracks-tests.ts — and this gate must ask the same one, or
 *      somebody who gets member pricing starts getting prompted.
 *
 *   2. The drop-in price comes from THIS class's `dropin` tier or nowhere.
 *      The chain it replaced was `dropin ?? nonmember ?? member ?? 0`, which
 *      reaches the MEMBER price to prefill an amount for somebody with no
 *      membership. Null must stay null all the way to an empty box: 0 is a
 *      number a coach can accept by pressing Enter.
 */
import {
  needsNoMembershipConfirmation,
  isBillableAttendanceStatus,
  classDropInPrice,
  noMembershipMessage,
  BILLABLE_ATTENDANCE_STATUSES,
} from "../lib/attendanceBilling";

let pass = 0;
const failures: string[] = [];
const check = (label: string, ok: boolean) => {
  if (ok) pass++;
  else failures.push(label);
};

/** A member with no membership, being marked present, prompt not yet shown. */
const base = {
  status: "PRESENT",
  activeSubscriptionCount: 0,
  trialWindowActive: false,
  alreadyCharged: false,
  confirmed: false,
};
const withIt = (o: Partial<typeof base>) => needsNoMembershipConfirmation({ ...base, ...o });

// ── The case that started this ──────────────────────────────────────────────
//
// Somebody with no subscription, marked present, no prompt yet. This is the
// silent write that left ~17 people with unbilled training.
check("a non-member marked PRESENT is stopped", withIt({}) === true);
check("...and marked LATE too — LATE is attendance that bills nothing", withIt({ status: "LATE" }) === true);

// ── The membership question ─────────────────────────────────────────────────
//
// ONE active row is enough. The gate does not care what kind of row it is: a
// comp, a $0 MANUAL, a Stripe trial at full price with no payment behind it.
// countsAsMembership() rejects some of those, and using it here would prompt on
// people who are demonstrably on a plan.
check("one active subscription row is enough to skip the prompt", withIt({ activeSubscriptionCount: 1 }) === false);
check("several rows also skip it", withIt({ activeSubscriptionCount: 3 }) === false);
check(
  "the question is the COUNT, not a judgement about the row's quality",
  // A row that countsAsMembership() would reject (priced, unpaid) is still a
  // row. Pricing everywhere else is this generous; the gate matches it.
  withIt({ activeSubscriptionCount: 1 }) === false,
);

// ── Ways the decision was already made ──────────────────────────────────────
check(
  "a running free-trial window is not re-asked every session",
  withIt({ trialWindowActive: true }) === false,
);
check(
  "a session already paid for is not re-asked (DROP_IN corrected to PRESENT)",
  withIt({ alreadyCharged: true }) === false,
);
check("having answered the prompt records it", withIt({ confirmed: true }) === false);

// ── Statuses that are not a billing question ────────────────────────────────
check("ABSENT never prompts — a non-attendance bills nothing by definition", withIt({ status: "ABSENT" }) === false);
check("TRIAL never prompts — it IS one of the answers", withIt({ status: "TRIAL" }) === false);
check("DROP_IN never prompts — it IS the other answer", withIt({ status: "DROP_IN" }) === false);
check("an unknown status never prompts", withIt({ status: "WHATEVER" }) === false);

check(
  "the billable set is exactly PRESENT and LATE",
  JSON.stringify([...BILLABLE_ATTENDANCE_STATUSES]) === JSON.stringify(["PRESENT", "LATE"]),
);
check("isBillableAttendanceStatus agrees", isBillableAttendanceStatus("PRESENT") && !isBillableAttendanceStatus("TRIAL"));

// ── The message names the person ────────────────────────────────────────────
check("the message names the client", noMembershipMessage("Kellan").startsWith("Kellan "));

// ── The drop-in price: this class's own, or nothing ─────────────────────────
//
// Measured 2026-09-13: all six live classes set `dropin` (Girls Class 40, the
// rest 25) and NONE sets `member` or `nonmember`. So the old fallback chain
// could not misfire — which is what a latent wrong number looks like before it
// fires. These assertions are what stop it being reintroduced.
check("reads this class's drop-in price", classDropInPrice([{ type: "dropin", price: 40 }]) === 40);
check("a different class, a different price", classDropInPrice([{ type: "dropin", price: 25 }]) === 25);
check("$0 is a real drop-in price, not 'unset'", classDropInPrice([{ type: "dropin", price: 0 }]) === 0);

check(
  "NEVER falls back to the nonmember tier",
  classDropInPrice([{ type: "nonmember", price: 60 }]) === null,
);
check(
  "NEVER falls back to the member tier — that is the membership rate for somebody with no membership",
  classDropInPrice([{ type: "member", price: 175 }]) === null,
);
check(
  "not even when both are set and dropin is absent",
  classDropInPrice([{ type: "member", price: 175 }, { type: "nonmember", price: 60 }]) === null,
);
check("no pricing at all is null, not 0", classDropInPrice([]) === null);
check("a malformed blob is null, not 0", classDropInPrice(null) === null);
check("a non-numeric price is null, not 0", classDropInPrice([{ type: "dropin", price: "25" }]) === null);
check(
  "picks dropin out of a full pricing list",
  classDropInPrice([
    { type: "membership", membershipId: "m1" },
    { type: "member", price: 175 },
    { type: "dropin", price: 25 },
    { type: "nonmember", price: 60 },
  ]) === 25,
);


// ═══════════════════════════════════════════════════════════════════════════
// The panel's COPY — server-rendered, no browser
// ═══════════════════════════════════════════════════════════════════════════
//
// Same approach as scripts/member-ui-tests.ts: this does not prove the panel
// looks right, it proves it renders without throwing for the states that matter
// and that the agreed copy is actually what comes out. The wording here was
// reviewed and signed off before the code was written, so a silent edit to it
// is a change to a decision, not a tweak.

import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import NoMembershipPanel, {
  type NoMembershipPrompt,
} from "../components/attendance/NoMembershipPanel";

const prompt = (o: Partial<NoMembershipPrompt> = {}): NoMembershipPrompt => ({
  memberFirstName: "Kellan",
  status: "PRESENT",
  message: "Kellan has no active membership — choose how to record this session.",
  trial: { available: true, name: "Free trial", days: 7, renewable: false, unavailableReason: null },
  ...o,
});

const render = (props: Partial<React.ComponentProps<typeof NoMembershipPanel>> = {}) =>
  renderToStaticMarkup(
    React.createElement(NoMembershipPanel, {
      prompt: prompt(),
      dropInPrice: 25,
      showDropIn: true,
      busy: false,
      emailReceipt: false,
      onEmailReceiptChange: () => {},
      onTrial: () => {},
      onDropIn: () => {},
      onAnyway: () => {},
      onCancel: () => {},
      ...props,
    }),
  );

// Decode the entities renderToStaticMarkup emits for the typographic quotes and
// apostrophes in the copy, so assertions can be written the way the copy reads.
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&ldquo;|&rdquo;/g, '"')
    // JSX &ldquo;/&rsquo; entities become real curly characters in the output —
    // normalise so assertions can be written with plain quotes.
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#x2014;|&mdash;/g, "—")
    .replace(/\s+/g, " ")
    .trim();

const out = text(render());
check("heading", out.includes("No active membership"));
check(
  "body names the client and says nothing is billed",
  out.includes("Kellan isn't on a membership. Marking them present records the session and bills nothing."),
);
check("trial option names the club's offer", out.includes("Start Free trial"));
check("trial option states the length", out.includes("7 days free, active like a membership, then it ends on its own."));
check("proceed-as-is option is offered", out.includes("Mark present anyway"));
check(
  "proceed-as-is says where they end up — the queue label, verbatim",
  out.includes('No charge. Kellan stays in "Attending, no active membership" until they\'re on a plan.'),
);
check("there is a way out", out.includes("Cancel"));

// ── LATE reads as LATE, not as "present" ───────────────────────────────────
const late = text(render({ prompt: prompt({ status: "LATE" }) }));
check("LATE says late in the body", late.includes("Marking them late records the session"));
check("LATE says late on the button", late.includes("Mark late anyway"));

// ── The renewable rule is the CLUB's, not a universal one ──────────────────
//
// Frog Empire runs renewable:false. A club with renewals on must never be told
// the trial is one per client — that is their setting talking, not ours.
check("renewable OFF says so", out.includes("One per client — it can't be renewed later."));
const renewable = text(
  render({ prompt: prompt({ trial: { available: true, name: "Free trial", days: 7, renewable: true, unavailableReason: null } }) }),
);
check("renewable ON stays silent about limits", !renewable.includes("One per client"));
check("renewable ON still offers the trial", renewable.includes("Start Free trial"));

// A club that renamed the offer, with a different length.
const custom = text(
  render({ prompt: prompt({ trial: { available: true, name: "Two-week look", days: 14, renewable: true, unavailableReason: null } }) }),
);
check("the offer's own name is used", custom.includes("Start Two-week look"));
check("the offer's own length is used", custom.includes("14 days free"));
check("one day is not pluralised", text(
  render({ prompt: prompt({ trial: { available: true, name: "Day pass", days: 1, renewable: true, unavailableReason: null } }) }),
).includes("1 day free"));

// ── No trial available: the reason, not a dead button ──────────────────────
const noTrial = text(
  render({
    prompt: prompt({
      trial: {
        available: false,
        name: "Free trial",
        days: 7,
        renewable: false,
        unavailableReason: "Kellan already used their free trial and the offer doesn't allow renewals.",
      },
    }),
  }),
);
check("an unavailable trial is not offered", !noTrial.includes("Start Free trial"));
check("...the reason is shown instead", noTrial.includes("already used their free trial"));
check("...and the other two options survive", noTrial.includes("Charge a drop-in") && noTrial.includes("Mark present anyway"));

// ── The drop-in price is THIS class's, or absent ───────────────────────────
check("shows this class's price", out.includes("Charge a drop-in — $25"));
check("a different class shows its own price", text(render({ dropInPrice: 40 })).includes("Charge a drop-in — $40"));
const noPrice = text(render({ dropInPrice: null }));
check("no drop-in price set → no price shown", noPrice.includes("Charge a drop-in") && !noPrice.includes("$"));
check("...and never a zero", !noPrice.includes("$0"));
check("a real $0 drop-in still renders as $0", text(render({ dropInPrice: 0 })).includes("Charge a drop-in — $0"));
check("cents survive", text(render({ dropInPrice: 22.5 })).includes("Charge a drop-in — $22.50"));

// A surface with no class context (the eventId branch) hides drop-in entirely.
const noDropIn = text(render({ showDropIn: false }));
check("no class context → no drop-in option", !noDropIn.includes("Charge a drop-in"));
check("...but the other options remain", noDropIn.includes("Start Free trial") && noDropIn.includes("Mark present anyway"));

console.log(`\n${"─".repeat(62)}`);
if (failures.length) {
  console.log(`✗ ${failures.length} failed, ${pass} passed\n`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log(`✓ ${pass}/${pass} passed — attendance billing gate + panel copy\n`);
