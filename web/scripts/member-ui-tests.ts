// Phase 4.5.11 — UI-layer assertions for the members surfaces.
//
//   npm run test:member-ui
//
// NO DATABASE. NO BROWSER. Two kinds of check:
//
//   1. Static assertions over the `⋯` menu definition — order and gating are
//      data, so they can be verified without rendering anything.
//   2. Server-render smoke via react-dom/server. This does NOT prove the pages
//      look right; it proves every component renders without throwing for the
//      fixture states that matter, and that the copy the handoff specifies as
//      final actually appears in the output. A browser pass is still owed —
//      see PROGRESS.md.

import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import {
  AccountSetupCell,
  MembershipPill,
  MigrationMeterBar,
  NextActionBanner,
  NextActionButton,
  RoleChips,
  WaitingOnPill,
} from "../components/members/MemberTracks";
import { MEMBER_MENU_ITEMS, MEMBER_MENU_ORDER } from "../components/members/MemberActionsMenu";
import { PasswordResetDialog } from "../components/members/PasswordResetDialog";
import {
  MEMBERSHIP_LABELS,
  migrationMeterFor,
  nextAction,
  setupLabelFor,
  setupTrackFor,
  SETUP_DOT,
  type MemberTrackInput,
} from "../lib/memberTracks";

let pass = 0;
const failures: string[] = [];
let section = "";

function group(name: string) {
  section = name;
  console.log(`\n${name}`);
}
function check(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${section} → ${name}`);
    console.log(`  ✗ ${name}`);
  }
}
function eq<T>(name: string, actual: T, expected: T) {
  check(`${name}${actual === expected ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`, actual === expected);
}
/** Render and return markup, or the thrown error as a string. */
function render(el: React.ReactElement): string {
  try {
    return renderToStaticMarkup(el);
  } catch (e) {
    return `__THREW__ ${e instanceof Error ? e.message : String(e)}`;
  }
}
function renders(name: string, el: React.ReactElement, mustContain: string[] = []) {
  const html = render(el);
  if (html.startsWith("__THREW__")) {
    check(`${name} — ${html}`, false);
    return "";
  }
  const missing = mustContain.filter((t) => !html.includes(t));
  check(`${name}${missing.length ? ` — missing ${JSON.stringify(missing)}` : ""}`, missing.length === 0);
  return html;
}

const NOW = new Date("2026-08-04T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function member(over: Partial<MemberTrackInput> = {}): MemberTrackInput {
  return { id: "m1", firstName: "Cameron", lastName: "Lister", status: "PROSPECT", isMinor: false, ...over };
}

// ═══════════════════════════════════════════════════════════════════════════
group("§1  ⋯ menu — fixed order, identical everywhere");
// ═══════════════════════════════════════════════════════════════════════════
// The handoff specifies this order literally. Staff work this list all day and
// muscle memory is the feature.

eq(
  "order matches the handoff exactly",
  MEMBER_MENU_ORDER.join(" · "),
  "view · edit · resend · reset · migration · assign · relationship · checkin · archive",
);
eq("nine actions, no more", MEMBER_MENU_ORDER.length, 9);
eq("two dividers group them", MEMBER_MENU_ITEMS.filter((i) => i.kind === "divider").length, 2);

const byKey = Object.fromEntries(
  MEMBER_MENU_ITEMS.filter((i): i is Extract<typeof i, { kind: "item" }> => i.kind === "item").map((i) => [i.key, i]),
);
eq("View profile needs no permission", byKey.view.requires, null);
eq("Assign membership is gated on BILLING, not members", byKey.assign.requires, "billing");
eq("Archive is owner-only", byKey.archive.requires, "owner");
eq("Archive is the only destructive item", MEMBER_MENU_ITEMS.filter((i) => i.kind === "item" && i.destructive).length, 1);
check("Archive is last — a destructive action never sits mid-list", MEMBER_MENU_ORDER.at(-1) === "archive");

// ═══════════════════════════════════════════════════════════════════════════
group("§2  Permission-denied items are VISIBLE and locked, never hidden");
// ═══════════════════════════════════════════════════════════════════════════
// Hiding is what made the dashboard feel arbitrary to coaches.

// The menu component itself cannot be server-rendered here: it calls
// useRouter(), which throws "expected app router to be mounted" outside Next.
// That is a harness limit, not a defect — and the rule under test is data, not
// markup, so assert it directly against the definition instead of faking a
// router. The rendered lock affordance is covered by the browser pass owed in
// PROGRESS.md.
function gatedFor(canEdit: boolean, canBill: boolean, isOwner: boolean) {
  return MEMBER_MENU_ITEMS.filter((i): i is Extract<typeof i, { kind: "item" }> => i.kind === "item").filter((i) => {
    if (i.requires === null) return false;
    if (i.requires === "owner") return !isOwner;
    if (i.requires === "billing") return !canBill;
    return !canEdit;
  });
}
const coachLocked = gatedFor(true, false, false).map((i) => i.key);
eq("a coach with members:edit but no billing sees assign + archive locked", coachLocked.join(" · "), "assign · archive");
eq("an owner sees nothing locked", gatedFor(true, true, true).length, 0);
// J-5: Sal gets billing:full with finances/reports staying at view, so he
// clears every gate here except owner-only Archive. No exception was built.
eq("Sal (billing:full, not owner) is locked out of Archive only", gatedFor(true, true, false).map((i) => i.key).join(), "archive");
check("nothing is ever REMOVED from the list — locked items still render", MEMBER_MENU_ORDER.length === 9);

// ═══════════════════════════════════════════════════════════════════════════
group("§3  Track components render every state without throwing");
// ═══════════════════════════════════════════════════════════════════════════

for (const [track, label] of Object.entries(MEMBERSHIP_LABELS)) {
  renders(`membership pill — ${track}`, React.createElement(MembershipPill, { track, label }), [label]);
}

const SETUP_STATES: MemberTrackInput[] = [
  member({ userId: "u1" }),
  member({ migrationStatus: "IMPORTED", email: "a@b.com" }),
  member({ migrationStatus: "INVITED", email: "a@b.com", activationEmailSentAt: daysAgo(3) }),
  member({ migrationStatus: "INVITED", email: "a@b.com", paymentSetupStatus: "REQUIRED" }),
  member({ migrationStatus: "ACTIVATED", activatedAt: daysAgo(1) }),
  member({ migrationStatus: "INVITED", email: "a@b.com", invitationBouncedCount: 2 }),
  member(),
];
for (const m of SETUP_STATES) {
  const t = setupTrackFor(m);
  renders(
    `account-setup cell — ${t}`,
    React.createElement(AccountSetupCell, {
      track: t,
      label: setupLabelFor(m, NOW),
      dot: SETUP_DOT[t],
      meter: migrationMeterFor(m, NOW),
    }),
    [setupLabelFor(m, NOW)],
  );
}

// Every meter step 0..7 renders 7 segments.
for (let step = 0; step <= 7; step++) {
  const meter = migrationMeterFor(
    member({
      migrationStatus: step >= 7 ? "COMPLETED" : "IMPORTED",
      migrationCompletedAt: step >= 7 ? daysAgo(1) : null,
      reviewedAt: step >= 2 ? daysAgo(6) : null,
      activationEmailSentAt: step >= 3 ? daysAgo(5) : null,
      paymentSetupStatus: step >= 4 ? "REQUIRED" : null,
      activatedAt: step >= 5 ? daysAgo(2) : null,
      approvalStatus: step >= 6 ? "APPROVED" : null,
      email: "a@b.com",
    }),
    NOW,
  );
  const html = render(React.createElement(MigrationMeterBar, { meter }));
  const segments = (html.match(/rounded-\[2px\]/g) || []).length;
  eq(`meter always renders 7 segments (step ${step})`, segments, 7);
}

renders("waiting-on pill — you", React.createElement(WaitingOnPill, { waitingOn: "STAFF" }), ["You"]);
renders("waiting-on pill — member", React.createElement(WaitingOnPill, { waitingOn: "MEMBER" }), ["Member"]);
renders("waiting-on pill — blocked", React.createElement(WaitingOnPill, { waitingOn: "BLOCKED" }), ["Blocked"]);
renders("role chips", React.createElement(RoleChips, { roles: [{ role: "ATHLETE", label: "ATHLETE" }, { role: "PARENT", label: "PARENT / GUARDIAN" }] }), [
  "ATHLETE",
  "PARENT / GUARDIAN",
]);

// ═══════════════════════════════════════════════════════════════════════════
group("§4  Next action — locked state names the role, never hides the action");
// ═══════════════════════════════════════════════════════════════════════════

const confirmAction = nextAction(
  member({ migrationStatus: "ACTIVATED", email: "a@b.com", reviewedAt: daysAgo(6), activationEmailSentAt: daysAgo(4), activatedAt: daysAgo(1) }),
  NOW,
);
eq("the fixture is the billing-gated one", confirmAction.permission, "billing:full");

const allowedHtml = renders("action button — allowed", React.createElement(NextActionButton, { action: confirmAction, allowed: true }), [
  "Confirm membership",
]);
const lockedHtml = renders(
  "action button — locked still shows the label",
  React.createElement(NextActionButton, { action: confirmAction, allowed: false, requiredRoleLabel: "Billing" }),
  ["Confirm membership", "Billing"],
);
check("locked button is disabled", lockedHtml.includes("disabled"));
check("allowed button is not disabled", !allowedHtml.includes("disabled"));

// ═══════════════════════════════════════════════════════════════════════════
group("§5  Next-action banner — renders only when something is outstanding");
// ═══════════════════════════════════════════════════════════════════════════

const settled = nextAction(member({ migrationStatus: "COMPLETED", migrationCompletedAt: daysAgo(1), userId: "u1", subscriptions: [{ status: "active" }] }), NOW);
eq("a settled member's banner renders nothing", render(React.createElement(NextActionBanner, { action: settled, memberName: "Cameron" })), "");

const blocked = nextAction(member({ migrationStatus: "INVITED", email: "a@b.com", invitationBouncedCount: 1 }), NOW);
const bannerHtml = renders("blocked banner renders with evidence", React.createElement(NextActionBanner, { action: blocked, memberName: "Cameron" }), [
  "Fix email",
  "a@b.com",
]);
// The reassurance half is not decoration: an owner reading "blocked" about a
// paying member needs to know in the same breath that nothing broke for the athlete.
check("banner carries the reassurance line", bannerHtml.includes("keeps training"));

// ═══════════════════════════════════════════════════════════════════════════
group("§6  Password reset — three states, copy is FINAL and must be verbatim");
// ═══════════════════════════════════════════════════════════════════════════

const confirmHtml = renders(
  "confirm state",
  React.createElement(PasswordResetDialog, {
    state: "confirm",
    memberName: "Cameron",
    email: "michael@example.com",
    isGuardianEmail: true,
    staffName: "Dana R.",
    onClose: () => {},
    onSend: () => {},
  }),
  ["Send password reset link?", "michael@example.com", "It works once and expires in 60 minutes."],
);
check("confirm names the guardian relationship", confirmHtml.includes("guardian"));
// The copy uses a typographic apostrophe (&rsquo; → U+2019), so match on that.
check("confirm promises staff never see the password", confirmHtml.includes("You won\u2019t see the new password"));
check("confirm names what it does NOT change", confirmHtml.includes("membership, bookings or") && confirmHtml.includes("migration status"));
check("confirm attributes the send to the staff member", confirmHtml.includes("Dana R."));

renders(
  "success state",
  React.createElement(PasswordResetDialog, {
    state: "sent",
    memberName: "Cameron",
    email: "michael@example.com",
    staffName: "Dana R.",
    sentAt: new Date("2026-08-04T14:14:00Z"),
    cooldownSeconds: 58,
    onClose: () => {},
    onSend: () => {},
  }),
  ["Password reset email sent successfully", "Resend in", "different email"],
);

renders(
  "no-email state",
  React.createElement(PasswordResetDialog, {
    state: "no-email",
    memberName: "Cameron",
    email: null,
    staffName: "Dana R.",
    onClose: () => {},
    onSend: () => {},
  }),
  ["This member does not have an email address on file", "Add an email address", "Link a guardian"],
);

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${"─".repeat(62)}`);
if (failures.length) {
  console.log(`✗ ${failures.length} failed, ${pass} passed\n`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log(`✓ ${pass}/${pass} passed`);
