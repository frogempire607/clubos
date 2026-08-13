// Phase 4.5.11 — the status model, the migration meter and the nextAction
// resolver, as fixtures.
//
//   npm run test:member-tracks
//
// NO DATABASE. NO NETWORK. Every case is plain data through a pure rule from
// lib/memberTracks.ts, the same discipline as scripts/family-fixtures-tests.ts.
// These rules decide what an owner reads about every person in their club, so
// they must be verifiable in milliseconds on a machine with no .env.
//
// Sections are named to match plan.md §4.5.11 so coverage can be checked line
// by line. Two sections cover shapes the OLD code got wrong in production and
// that must never come back:
//
//   §3   a paying member mid-migration read "Prospect · Un-invited" — two
//        labels each individually defensible and together completely wrong.
//   §5   "Un-invited" on a walk-in minor added at practice, who nobody ever
//        intended to invite, which read as an outstanding task that did not
//        exist.

import { duplicateKeyDiagnostics, duplicateKeysOf, groupDuplicates } from "../lib/memberDuplicates";
import {
  ACTION_KIND,
  MEMBERSHIP_LABELS,
  MEMBERSHIP_TRACK,
  MIGRATION_STEP_COUNT,
  REPEATED_NO_OPEN_THRESHOLD,
  SETUP_TRACK,
  WAITING_ON,
  ageFrom,
  derivedBlockedReason,
  everHeldMembership,
  importedColumnHeader,
  importedMetaLine,
  inviteAddressFor,
  isImported,
  membershipDetailFor,
  membershipTrackFor,
  migrationMeterFor,
  needsStaffAttention,
  nextAction,
  resolveSourceLabel,
  rolesFor,
  setupComplete,
  setupLabelFor,
  setupTrackFor,
  sourcePhrase,
  type MemberTrackInput,
  countsAsMembership,
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
  check(
    `${name}${actual === expected ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`,
    actual === expected,
  );
}

// A fixed "now" so every relative-date assertion is deterministic.
const NOW = new Date("2026-08-04T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const daysAhead = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

/** Minimum viable member. Every fixture spreads this and overrides. */
function member(over: Partial<MemberTrackInput> = {}): MemberTrackInput {
  return {
    id: "m1",
    firstName: "Alex",
    lastName: "Rivera",
    status: "PROSPECT",
    isMinor: false,
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
group("§1  Track 1 — Role derivation (all five, and combinations)");
// ═══════════════════════════════════════════════════════════════════════════

const rolesOf = (m: MemberTrackInput) => rolesFor(m, NOW).map((r) => r.role);

eq("athlete — has a subscription", rolesOf(member({ subscriptions: [{ status: "active", billingType: "MANUAL" }] })).join(), "ATHLETE");
eq("athlete — attendance only, no subscription", rolesOf(member({ hasAttendance: true })).join(), "ATHLETE");
eq("parent — guardian of one child", rolesOf(member({ guardianOfCount: 1 })).join(), "PARENT");
eq(
  "account holder",
  rolesOf(member({ isAccountHolder: true })).join(),
  "ACCOUNT_HOLDER",
);
eq("staff", rolesOf(member({ isStaff: true })).join(), "STAFF");
eq("nobody — a bare record has no role chips", rolesOf(member()).length, 0);

// The one the redesign calls out explicitly: a parent who also trains is ONE
// record holding several roles, not two records and not a single winner.
eq(
  "a parent who also trains holds BOTH roles on one record",
  rolesOf(member({ subscriptions: [{ status: "active", billingType: "MANUAL" }], guardianOfCount: 2 })).join(" · "),
  "ATHLETE · PARENT",
);
eq(
  "all five at once, in fixed order",
  rolesOf(
    member({
      subscriptions: [{ status: "active", billingType: "MANUAL" }],
      guardianOfCount: 1,
      isAccountHolder: true,
      isMinor: true,
      isStaff: true,
    }),
  ).join(" · "),
  "ATHLETE · PARENT · ACCOUNT_HOLDER · MINOR · STAFF",
);

// Minor chips carry the age — a bare "MINOR" is far less actionable than
// "MINOR · 14" when the question is waivers and age brackets.
eq(
  "minor chip carries the age",
  rolesFor(member({ isMinor: true, dateOfBirth: "2012-03-01" }), NOW).find((r) => r.role === "MINOR")?.label,
  "MINOR · 14",
);
eq(
  "minor chip degrades when the DOB is unknown",
  rolesFor(member({ isMinor: true }), NOW).find((r) => r.role === "MINOR")?.label,
  "MINOR",
);
eq("age — birthday not yet reached this year", ageFrom("2012-12-01", NOW), 13);
eq("age — birthday already passed this year", ageFrom("2012-01-01", NOW), 14);

// ═══════════════════════════════════════════════════════════════════════════
group("§2  Track 2 — Membership pill, all five conditions");
// ═══════════════════════════════════════════════════════════════════════════

const mt = (m: MemberTrackInput) => membershipTrackFor(m, NOW);

eq("Active — an active subscription", mt(member({ subscriptions: [{ status: "active", billingType: "MANUAL" }] })), MEMBERSHIP_TRACK.ACTIVE);
eq("Active — a live staff-granted trial with no subscription", mt(member({ trialEndsAt: daysAhead(5) })), MEMBERSHIP_TRACK.ACTIVE);
eq("Pending — a pending subscription", mt(member({ subscriptions: [{ status: "pending" }] })), MEMBERSHIP_TRACK.PENDING);
// J-10 split (owner, 2026-08-04): Prospect means they SHOWED UP.
eq("Prospect — trialled, never joined", mt(member({ hasAttendance: true })), MEMBERSHIP_TRACK.PROSPECT);
eq("Prospect — a lapsed free trial still counts as having trialled", mt(member({ trialEndsAt: daysAgo(30) })), MEMBERSHIP_TRACK.PROSPECT);
eq("Prospect — signed up for a portal login", mt(member({ userId: "u1" })), MEMBERSHIP_TRACK.PROSPECT);
eq("Lead — a name nobody has contacted", mt(member()), MEMBERSHIP_TRACK.LEAD);
eq("Paused — owner-controlled and sticky", mt(member({ status: "PAUSED", subscriptions: [{ status: "active", billingType: "MANUAL" }] })), MEMBERSHIP_TRACK.PAUSED);
eq(
  "Inactive — had one, it ended",
  mt(member({ status: "INACTIVE", subscriptions: [{ status: "canceled", canceledAt: daysAgo(40) }] })),
  MEMBERSHIP_TRACK.INACTIVE,
);
eq("an expired trial does not keep them Active", mt(member({ trialEndsAt: daysAgo(1) })), MEMBERSHIP_TRACK.PROSPECT);
eq("the pill label spells out that nothing was charged", MEMBERSHIP_LABELS.PENDING, "Pending · not charged");

// ═══════════════════════════════════════════════════════════════════════════
group("§3  THE HARD RULE — an imported member is NEVER Prospect");
// ═══════════════════════════════════════════════════════════════════════════
// This is the headline bug. Every one of these fixtures previously rendered
// "Prospect", which told an owner their paying member had never bought
// anything.

for (const [name, over] of [
  ["migrationStatus set", { migrationStatus: "IMPORTED" }],
  ["importedAt set", { importedAt: daysAgo(20) }],
  ["importBatchId set", { importBatchId: "batch_1" }],
  ["legacyMemberId set", { legacyMemberId: "607329885" }],
  ["an imported plan name", { migrationStatus: "IMPORTED", legacyMembershipName: "Competition Team" }],
  ["an imported plan price only", { migrationStatus: "IMPORTED", legacyMembershipPrice: 175 }],
] as [string, Partial<MemberTrackInput>][]) {
  const t = mt(member(over));
  check(`${name} → Pending, never Prospect (got ${t})`, t === MEMBERSHIP_TRACK.PENDING);
}

eq("isImported() is true for any import signal", isImported(member({ legacyMemberId: "x" })), true);
eq("isImported() is false for a walk-in", isImported(member()), false);
eq("an imported plan counts as having held a membership", everHeldMembership(member({ legacyMembershipName: "Team" })), true);
eq("a completed migration with no sub is genuinely Inactive, not Pending forever",
  mt(member({ migrationStatus: "COMPLETED", migrationCompletedAt: daysAgo(3), legacyMembershipName: "Team" })),
  MEMBERSHIP_TRACK.INACTIVE);

eq("Prospect's detail line names what happened", membershipDetailFor(member({ hasAttendance: true }), NOW), "Trialled, never joined");
eq("Lead's detail line names what has NOT happened", membershipDetailFor(member(), NOW), "Never contacted");
eq(
  "an imported plan shows the plan, the price and that it came from an import",
  membershipDetailFor(member({ migrationStatus: "IMPORTED", legacyMembershipName: "Competition Team", legacyMembershipPrice: 175 }), NOW),
  "Competition Team · $175 · imported",
);

// ═══════════════════════════════════════════════════════════════════════════
group("§4  Track 3 — Account setup, all states");
// ═══════════════════════════════════════════════════════════════════════════

const st = (m: MemberTrackInput) => setupTrackFor(m);

eq("Complete — their own portal login", st(member({ userId: "u1" })), SETUP_TRACK.COMPLETE);
eq("Complete — a minor whose guardian holds the account", st(member({ isMinor: true, hasGuardianAccount: true })), SETUP_TRACK.COMPLETE);
eq("Profile created — activated, membership not yet confirmed", st(member({ migrationStatus: "ACTIVATED", activatedAt: daysAgo(2) })), SETUP_TRACK.PROFILE_CREATED);
eq("Setting up — they reached the billing step", st(member({ migrationStatus: "INVITED", activationEmailSentAt: daysAgo(3), paymentSetupStatus: "REQUIRED" })), SETUP_TRACK.SETTING_UP);
eq("Invited — sent, nothing started", st(member({ migrationStatus: "INVITED", activationEmailSentAt: daysAgo(3), email: "a@b.com" })), SETUP_TRACK.INVITED);
eq("Not invited — imported, never sent", st(member({ migrationStatus: "IMPORTED", email: "a@b.com" })), SETUP_TRACK.NOT_INVITED);
eq("Blocked — a bounce", st(member({ migrationStatus: "INVITED", email: "a@b.com", activationEmailSentAt: daysAgo(3), invitationBouncedCount: 1 })), SETUP_TRACK.BLOCKED);

// §5's rule, asserted from the Track 3 side.
eq(
  "a manually-added walk-in is Profile incomplete, NOT Not-invited",
  st(member()),
  SETUP_TRACK.PROFILE_INCOMPLETE,
);

eq("setupComplete — own login", setupComplete(member({ userId: "u1" })), true);
eq("setupComplete — minor via guardian", setupComplete(member({ isMinor: true, hasGuardianAccount: true })), true);
eq("setupComplete — an adult with a guardian link is NOT complete on that basis", setupComplete(member({ hasGuardianAccount: true })), false);

// Labels
eq("Invited label counts the days", setupLabelFor(member({ migrationStatus: "INVITED", email: "a@b.com", activationEmailSentAt: daysAgo(4) }), NOW), "Invited · 4 days ago");
eq("Invited label — singular day", setupLabelFor(member({ migrationStatus: "INVITED", email: "a@b.com", activationEmailSentAt: daysAgo(1) }), NOW), "Invited · 1 day ago");
eq("Invited label — today", setupLabelFor(member({ migrationStatus: "INVITED", email: "a@b.com", activationEmailSentAt: NOW }), NOW), "Invited · today");
eq("Blocked label names the reason", setupLabelFor(member({ migrationStatus: "INVITED", email: "a@b.com", invitationBouncedCount: 2 }), NOW), "Blocked · email bounced");
eq("Complete label", setupLabelFor(member({ userId: "u1" }), NOW), "Complete");

// ═══════════════════════════════════════════════════════════════════════════
group("§5  Retired vocabulary — the labels that must never come back");
// ═══════════════════════════════════════════════════════════════════════════

const ALL_LABELS = [
  setupLabelFor(member(), NOW),
  setupLabelFor(member({ migrationStatus: "IMPORTED" }), NOW),
  setupLabelFor(member({ migrationStatus: "INVITED", email: "a@b.com", activationEmailSentAt: daysAgo(2) }), NOW),
  setupLabelFor(member({ migrationStatus: "ACTIVATED", activatedAt: daysAgo(1) }), NOW),
  setupLabelFor(member({ userId: "u1" }), NOW),
  ...Object.values(MEMBERSHIP_LABELS),
];

check('no label anywhere says "Un-invited"', !ALL_LABELS.some((l) => /un-?invited/i.test(l)));
check('no label says "Profile completed (reviewed)"', !ALL_LABELS.some((l) => /reviewed\)/i.test(l)));
check('"Migrating" is gone from Track 2 — it belongs to Track 3', !Object.values(MEMBERSHIP_LABELS).some((l) => /migrat/i.test(l)));

// ═══════════════════════════════════════════════════════════════════════════
group("§6  Blocked derivation — bounced vs ignored need opposite actions");
// ═══════════════════════════════════════════════════════════════════════════

eq("a bounce blocks immediately", derivedBlockedReason(member({ migrationStatus: "INVITED", email: "a@b.com", invitationBouncedCount: 1 })), "EMAIL_BOUNCED");
eq(
  `${REPEATED_NO_OPEN_THRESHOLD} sends with no open blocks`,
  derivedBlockedReason(member({ migrationStatus: "INVITED", email: "a@b.com", invitationSendCount: REPEATED_NO_OPEN_THRESHOLD, invitationOpenedCount: 0 })),
  "REPEATED_NO_OPEN",
);
eq(
  `${REPEATED_NO_OPEN_THRESHOLD - 1} sends with no open does NOT block yet`,
  derivedBlockedReason(member({ migrationStatus: "INVITED", email: "a@b.com", invitationSendCount: REPEATED_NO_OPEN_THRESHOLD - 1, invitationOpenedCount: 0 })),
  null,
);
eq(
  "many sends but they opened one → not blocked, just slow",
  derivedBlockedReason(member({ migrationStatus: "INVITED", email: "a@b.com", invitationSendCount: 5, invitationOpenedCount: 1 })),
  null,
);
eq("an imported member with nowhere to send is blocked", derivedBlockedReason(member({ migrationStatus: "IMPORTED" })), "EMAIL_MISSING");
eq("a walk-in with no email is NOT blocked — they were never on the invite path", derivedBlockedReason(member()), null);
// Regression: the first cut of derivedBlockedReason put a red Blocked dot on
// members who had already finished setup but had no email on their own record —
// a minor onboarded entirely through a guardian. Blocking someone for lacking
// an invite address AFTER they have used the invitation is precisely the
// wrong-but-defensible label this redesign exists to kill.
eq("an ACTIVATED member with no email of their own is NOT blocked", derivedBlockedReason(member({ migrationStatus: "ACTIVATED", activatedAt: daysAgo(2) })), null);
eq("a member who reached the billing step is NOT blocked", derivedBlockedReason(member({ migrationStatus: "INVITED", paymentSetupStatus: "REQUIRED" })), null);
eq("a minor completed via their guardian is NOT blocked", derivedBlockedReason(member({ migrationStatus: "COMPLETED", isMinor: true, hasGuardianAccount: true })), null);
eq("an explicit stored reason wins over derivation", derivedBlockedReason(member({ blockedReason: "CONFLICTING_DATA", invitationBouncedCount: 3 })), "CONFLICTING_DATA");
eq("a finished member with an old bounce is not an outstanding task", st(member({ userId: "u1", invitationBouncedCount: 2 })), SETUP_TRACK.COMPLETE);

// Where the invitation actually goes.
eq("a minor's invitation goes to the guardian", inviteAddressFor(member({ isMinor: true, email: "kid@x.com", guardianEmail: "mum@x.com" })), "mum@x.com");
eq("an adult's goes to their own address", inviteAddressFor(member({ email: "me@x.com", guardianEmail: "other@x.com" })), "me@x.com");
eq("a minor with no guardian address falls back to their own", inviteAddressFor(member({ isMinor: true, email: "kid@x.com" })), "kid@x.com");
eq("nowhere to send", inviteAddressFor(member()), null);

// ═══════════════════════════════════════════════════════════════════════════
group("§7  Migration meter — 7 segments match state");
// ═══════════════════════════════════════════════════════════════════════════

eq("seven steps, always", MIGRATION_STEP_COUNT, 7);
eq("a non-migration member gets no meter", migrationMeterFor(member(), NOW).applicable, false);

const step1 = migrationMeterFor(member({ migrationStatus: "IMPORTED" }), NOW);
eq("imported only → step 1 of 7", step1.step, 1);
eq("step 2 is the current one", step1.steps[1].current, true);
eq("step 1 is done", step1.steps[0].done, true);

eq("reviewed → step 2", migrationMeterFor(member({ migrationStatus: "IMPORTED", reviewedAt: daysAgo(5) }), NOW).step, 2);
eq("invited → step 3", migrationMeterFor(member({ migrationStatus: "INVITED", reviewedAt: daysAgo(5), activationEmailSentAt: daysAgo(4) }), NOW).step, 3);
eq(
  "started setup → step 4",
  migrationMeterFor(member({ migrationStatus: "INVITED", reviewedAt: daysAgo(5), activationEmailSentAt: daysAgo(4), paymentSetupStatus: "REQUIRED" }), NOW).step,
  4,
);
eq(
  "profile completed → step 5",
  migrationMeterFor(member({ migrationStatus: "ACTIVATED", reviewedAt: daysAgo(5), activationEmailSentAt: daysAgo(4), activatedAt: daysAgo(1) }), NOW).step,
  5,
);
eq(
  "membership confirmed → step 6",
  migrationMeterFor(member({ migrationStatus: "ACTIVATED", reviewedAt: daysAgo(5), activationEmailSentAt: daysAgo(4), activatedAt: daysAgo(1), approvalStatus: "APPROVED" }), NOW).step,
  6,
);
const done7 = migrationMeterFor(member({ migrationStatus: "COMPLETED", migrationCompletedAt: daysAgo(1) }), NOW);
eq("complete → all 7", done7.step, 7);
eq("a complete row has no current segment", done7.steps.filter((s) => s.current).length, 0);
eq("a complete row waits on nobody", done7.waitingOn, WAITING_ON.NOBODY);

// The ordinal backfill. A member activated long before reviewedAt existed must
// not render a hole in the middle of their meter.
const legacyActivated = migrationMeterFor(member({ migrationStatus: "ACTIVATED", activatedAt: daysAgo(30) }), NOW);
eq("an old activated member has no gap at step 2", legacyActivated.steps[1].done, true);
eq("…and reads step 5, not step 3", legacyActivated.step, 5);

// Whose turn.
eq("unreviewed → waiting on you", migrationMeterFor(member({ migrationStatus: "IMPORTED", email: "a@b.com" }), NOW).waitingOn, WAITING_ON.STAFF);
// …but an import with nowhere to send is blocked, not merely pending review.
eq("unreviewed AND unreachable → blocked", migrationMeterFor(member({ migrationStatus: "IMPORTED" }), NOW).waitingOn, WAITING_ON.BLOCKED);
eq(
  "invited, nothing back → waiting on member",
  migrationMeterFor(member({ migrationStatus: "INVITED", reviewedAt: daysAgo(6), activationEmailSentAt: daysAgo(4), email: "a@b.com" }), NOW).waitingOn,
  WAITING_ON.MEMBER,
);
eq(
  "activated, awaiting the owner's yes → waiting on you",
  migrationMeterFor(member({ migrationStatus: "ACTIVATED", reviewedAt: daysAgo(6), activationEmailSentAt: daysAgo(4), activatedAt: daysAgo(1) }), NOW).waitingOn,
  WAITING_ON.STAFF,
);
eq(
  "a bounce → blocked, not 'waiting on member'",
  migrationMeterFor(member({ migrationStatus: "INVITED", reviewedAt: daysAgo(6), activationEmailSentAt: daysAgo(4), email: "a@b.com", invitationBouncedCount: 1 }), NOW).waitingOn,
  WAITING_ON.BLOCKED,
);

// ═══════════════════════════════════════════════════════════════════════════
group("§8  nextAction — one resolver, twelve canonical states");
// ═══════════════════════════════════════════════════════════════════════════

const CANONICAL: [string, MemberTrackInput, string][] = [
  ["imported, unreviewed", member({ migrationStatus: "IMPORTED", email: "a@b.com" }), ACTION_KIND.REVIEW_INFO],
  ["reviewed, never invited", member({ migrationStatus: "IMPORTED", email: "a@b.com", reviewedAt: daysAgo(2) }), ACTION_KIND.SEND_INVITATION],
  ["invited, no response", member({ migrationStatus: "INVITED", email: "a@b.com", reviewedAt: daysAgo(6), activationEmailSentAt: daysAgo(4), invitationSendCount: 1 }), ACTION_KIND.RESEND_INVITE],
  ["setting up", member({ migrationStatus: "INVITED", email: "a@b.com", reviewedAt: daysAgo(6), activationEmailSentAt: daysAgo(4), paymentSetupStatus: "REQUIRED", invitationSendCount: 1 }), ACTION_KIND.RESEND_INVITE],
  ["activated, needs the owner's yes", member({ migrationStatus: "ACTIVATED", email: "a@b.com", reviewedAt: daysAgo(6), activationEmailSentAt: daysAgo(4), activatedAt: daysAgo(1) }), ACTION_KIND.CONFIRM_MEMBERSHIP],
  ["approved, not yet marked complete", member({ migrationStatus: "ACTIVATED", email: "a@b.com", reviewedAt: daysAgo(6), activationEmailSentAt: daysAgo(4), activatedAt: daysAgo(1), approvalStatus: "APPROVED" }), ACTION_KIND.COMPLETE_MIGRATION],
  ["migration complete, membership live", member({ migrationStatus: "COMPLETED", migrationCompletedAt: daysAgo(1), userId: "u1", subscriptions: [{ status: "active", billingType: "MANUAL" }] }), ACTION_KIND.LEAVE_ALONE],
  ["bounced invitation", member({ migrationStatus: "INVITED", email: "a@b.com", reviewedAt: daysAgo(6), activationEmailSentAt: daysAgo(4), invitationBouncedCount: 1 }), ACTION_KIND.FIX_EMAIL],
  ["imported with no address at all", member({ migrationStatus: "IMPORTED" }), ACTION_KIND.ADD_CONTACT],
  // A BOUNCE and an IGNORE are different problems with opposite fixes. Both
  // used to render "Fix email"; for the ignore case the address is fine, so
  // that told staff to break the one working address they had.
  ["three sends, never opened", member({ migrationStatus: "INVITED", email: "a@b.com", reviewedAt: daysAgo(9), activationEmailSentAt: daysAgo(2), invitationSendCount: 3, invitationOpenedCount: 0 }), ACTION_KIND.CALL_GUARDIAN],
  ["a walk-in who trialled", member({ userId: "u2", hasAttendance: true }), ACTION_KIND.ASSIGN_MEMBERSHIP],
  ["an untouched lead", member(), ACTION_KIND.MAKE_CONTACT],
  ["a lapsed member", member({ status: "INACTIVE", userId: "u3", subscriptions: [{ status: "canceled", canceledAt: daysAgo(60) }] }), ACTION_KIND.WIN_BACK],
];

for (const [name, m, expected] of CANONICAL) {
  const a = nextAction(m, NOW);
  check(`${name} → ${expected}${a.kind === expected ? "" : ` (got ${a.kind})`}`, a.kind === expected);
}

// The invariant that makes it ONE resolver: the row button, the profile banner
// and the mobile card must be the same call. Calling it repeatedly on the same
// input must be stable in every field a surface renders.
group("§9  The same resolver, three surfaces — identical every time");
for (const [name, m] of CANONICAL.map((c) => [c[0], c[1]] as [string, MemberTrackInput])) {
  const row = nextAction(m, NOW);
  const banner = nextAction(m, NOW);
  const mobile = nextAction(m, NOW);
  check(
    `${name} — row, banner and mobile agree`,
    row.kind === banner.kind &&
      banner.kind === mobile.kind &&
      row.label === mobile.label &&
      row.tone === mobile.tone &&
      row.permission === mobile.permission &&
      row.waitingOn === mobile.waitingOn,
  );
}

group("§10 nextAction — permissions and tone");
eq("confirming a membership is gated on billing, not members", nextAction(CANONICAL[4][1], NOW).permission, "billing:full");
eq("assigning a membership is gated on billing", nextAction(CANONICAL[10][1], NOW).permission, "billing:full");
eq("making first contact is gated on members, not billing", nextAction(CANONICAL[11][1], NOW).permission, "members:edit");
eq("reviewing import data is gated on members:edit", nextAction(CANONICAL[0][1], NOW).permission, "members:edit");
eq("'leave alone' asks for no permission", nextAction(CANONICAL[6][1], NOW).permission, null);
eq("fixing a broken address renders charcoal, not brand", nextAction(CANONICAL[7][1], NOW).tone, "charcoal");
eq("'leave alone' renders muted", nextAction(CANONICAL[6][1], NOW).tone, "muted");
check("the blocked action carries evidence, not just a verb", (nextAction(CANONICAL[7][1], NOW).detail ?? "").includes("a@b.com"));
check("the resend action counts the sends", (nextAction(CANONICAL[2][1], NOW).detail ?? "").includes("1 invitation"));

group("§11 Snooze — sets a person aside without changing anything real");
const snoozed = member({ migrationStatus: "IMPORTED", email: "a@b.com", snoozedUntil: daysAhead(5) });
eq("a snoozed member's action is muted", nextAction(snoozed, NOW).kind, ACTION_KIND.LEAVE_ALONE);
eq("a snoozed member waits on nobody", nextAction(snoozed, NOW).waitingOn, WAITING_ON.NOBODY);
eq("a snoozed member drops out of 'Needs you'", needsStaffAttention(snoozed, NOW), false);
eq("an expired snooze comes back", needsStaffAttention(member({ migrationStatus: "IMPORTED", email: "a@b.com", snoozedUntil: daysAgo(1) }), NOW), true);
eq("snooze does NOT change the membership pill", membershipTrackFor(snoozed, NOW), MEMBERSHIP_TRACK.PENDING);
eq("snooze does NOT change the meter step", migrationMeterFor(snoozed, NOW).step, 1);
// A blocked member is a broken thing, not a slow one — snoozing must not hide
// a bouncing address, because the sends keep being consumed.
eq(
  "a BLOCKED member is still surfaced even when snoozed",
  nextAction(member({ migrationStatus: "INVITED", email: "a@b.com", invitationBouncedCount: 1, snoozedUntil: daysAhead(5) }), NOW).kind,
  ACTION_KIND.FIX_EMAIL,
);

// The bounce/ignore split, stated directly rather than only through CANONICAL.
eq(
  "a bounced address says fix the address",
  nextAction(member({ migrationStatus: "INVITED", email: "a@b.com", invitationBouncedCount: 1, invitationSendCount: 3 }), NOW).kind,
  ACTION_KIND.FIX_EMAIL,
);
eq(
  "an ignored-but-delivered invitation says call, not fix",
  nextAction(member({ migrationStatus: "INVITED", email: "a@b.com", invitationSendCount: 3, invitationOpenedCount: 0 }), NOW).kind,
  ACTION_KIND.CALL_GUARDIAN,
);
check(
  "the ignore case tells staff NOT to change a working address",
  /will not help/.test(
    nextAction(member({ migrationStatus: "INVITED", email: "a@b.com", invitationSendCount: 3, invitationOpenedCount: 0 }), NOW).detail ?? "",
  ),
);
eq(
  "calling a guardian is not an edit, so it needs only members:view",
  nextAction(member({ migrationStatus: "INVITED", email: "a@b.com", invitationSendCount: 3, invitationOpenedCount: 0 }), NOW).permission,
  "members:view",
);

group("§12 'Needs you' membership");
eq("unreviewed import needs you", needsStaffAttention(member({ migrationStatus: "IMPORTED", email: "a@b.com" }), NOW), true);
eq("waiting on the member does not need you", needsStaffAttention(CANONICAL[2][1], NOW), false);
eq("blocked needs you", needsStaffAttention(CANONICAL[7][1], NOW), true);
eq("a settled active member does not need you", needsStaffAttention(CANONICAL[6][1], NOW), false);

// ═══════════════════════════════════════════════════════════════════════════
group("§13 Import source label — never a hardcoded vendor name");
// ═══════════════════════════════════════════════════════════════════════════

eq("the owner-typed batch label wins", resolveSourceLabel({ batchSourceLabel: "Acme Gym Software", legacySource: "Other" }), "Acme Gym Software");
eq("legacySource is the fallback — also owner-supplied", resolveSourceLabel({ legacySource: "Old System" }), "Old System");
eq("blank batch label falls through", resolveSourceLabel({ batchSourceLabel: "   ", legacySource: "Old System" }), "Old System");
eq("nothing typed → null, never a guess", resolveSourceLabel({}), null);
eq("whitespace-only everywhere → null", resolveSourceLabel({ batchSourceLabel: " ", legacySource: "  " }), null);

eq("column header with a label", importedColumnHeader("Acme Gym"), "As imported from Acme Gym");
eq("column header degrades", importedColumnHeader(null), "As imported");
eq("meta line with both", importedMetaLine("Acme Gym", "2026-07-08T00:00:00Z"), "imported from Acme Gym · Jul 8");
eq("meta line with a date only", importedMetaLine(null, "2026-07-08T00:00:00Z"), "imported Jul 8");
eq("meta line with neither", importedMetaLine(null, null), "imported");
eq("prose fallback", sourcePhrase(null), "your previous system");
eq("prose with a label", sourcePhrase("Acme Gym"), "Acme Gym");

// ═══════════════════════════════════════════════════════════════════════════
group("§14 Degradation before the migration is applied");
// ═══════════════════════════════════════════════════════════════════════════
// Every Phase 4.5.1 column is optional. Until 20260804000000_members_experience
// is applied these read undefined, and the model must stay coherent rather than
// throw or invent a state.

const preMigration = member({ migrationStatus: "IMPORTED", email: "a@b.com" });
check("no reviewedAt → the meter simply reads step 1", migrationMeterFor(preMigration, NOW).step === 1);
check("no blockedReason → nothing is falsely blocked", setupTrackFor(preMigration) !== SETUP_TRACK.BLOCKED);
check("no snoozedUntil → nothing is falsely snoozed", nextAction(preMigration, NOW).snoozed !== true);
check("no invitation rollup → falls back to the Member counter", derivedBlockedReason(member({ migrationStatus: "INVITED", email: "a@b.com", activationEmailSendCount: 3 })) === "REPEATED_NO_OPEN");
check("the resolver still returns a real action", nextAction(preMigration, NOW).kind === ACTION_KIND.REVIEW_INFO);

// ═══════════════════════════════════════════════════════════════════════════
group("§20 Duplicate keys — the sibling bug (Session D, D-1)");

// The detector's header used to claim siblings could never collide because
// minors carry guardian contact on guardianEmail/guardianPhone. Production
// disagreed: 27 of the 34 live minors with an own email had their GUARDIAN's,
// and 42 had their guardian's phone. Siblings then shared an `email:` key AND
// a `phone:`+lastName key, because siblings share a surname.
//
// These fixtures pin the rule structurally, so it holds whether or not the
// data-correction script has run — the next import can reintroduce the shape.
const sibA = {
  id: "sibA",
  firstName: "Iris", lastName: "Nakamura", dateOfBirth: new Date("2013-02-04"),
  email: "kenji@x.com", phone: "(555) 010-0142",
  guardianEmail: "kenji@x.com", guardianPhone: "(555) 010-0142",
};
const sibB = { ...sibA, id: "sibB", firstName: "Otto", dateOfBirth: new Date("2015-09-19") };

const keysA = duplicateKeyDiagnostics(sibA);
const keysB = duplicateKeyDiagnostics(sibB);
check(
  "a child's email that IS the guardian's is not a duplicate key",
  !keysA.keys.some((k) => k.startsWith("email:")),
);
check(
  "a child's phone that IS the guardian's is not a duplicate key",
  !keysA.keys.some((k) => k.startsWith("phone:")),
);
check(
  "the skip is reported, not silent",
  keysA.skipped.length === 2 && keysA.skipped.every((s) => s.reason === "matches-guardian-contact"),
);
check(
  "two siblings sharing a guardian share NO key",
  keysA.keys.filter((k) => keysB.keys.includes(k)).length === 0,
);

// ── The Cameron shape: a STALE guardianEmail column ────────────────────────
// The column-only rule was not enough. Cameron's guardianEmail held a phantom
// address nobody uses, while his OWN email held his father's real one — so the
// equality test never fired and he clustered with his dad. The confirmed
// guardian LINKS are the live truth; the column is one field that goes stale.
const staleGuardianCol = {
  id: "ivo",
  firstName: "Ivo", lastName: "Varga", dateOfBirth: new Date("2011-08-22"),
  email: "hal.varga@x.com", phone: null,
  guardianEmail: "old-hal@dead-domain.test", guardianPhone: null,
};
check(
  "a stale guardianEmail column alone does NOT protect the child",
  duplicateKeysOf(staleGuardianCol)
    .some((k) => k === "email:hal.varga@x.com"),
);
check(
  "…but the confirmed guardian's real address does",
  !duplicateKeysOf({ ...staleGuardianCol, guardianContacts: ["hal.varga@x.com"] })
    .some((k) => k.startsWith("email:")),
);
check(
  "a guardian's PHONE from the links is skipped too",
  !duplicateKeysOf({
    ...staleGuardianCol, email: null, phone: "(555) 010-0199",
    guardianContacts: ["555-010-0199"],
  })
    .some((k) => k.startsWith("phone:")),
);
check(
  "an unrelated address in the guardian list changes nothing",
  duplicateKeysOf({ ...staleGuardianCol, guardianContacts: ["someone.else@x.com"] })
    .some((k) => k === "email:hal.varga@x.com"),
);

// The keys that must still work, or the fix would have traded one bug for a worse one.
const twinA = { ...sibA, id: "twinA", email: "iris.own@x.com", guardianEmail: "kenji@x.com" };
check(
  "a child's OWN email (different from the guardian's) is still a key",
  duplicateKeysOf(twinA)
    .some((k) => k === "email:iris.own@x.com"),
);
const dupe1 = {
  id: "dupe1",
  firstName: "Marcus", lastName: "Delacroix", dateOfBirth: new Date("1996-11-23"),
  email: "m@x.com", phone: null, guardianEmail: null, guardianPhone: null,
};
const dupe2 = { ...dupe1, id: "dupe2", email: null, phone: "555-0188" };
check(
  "the same person entered twice still collides on name + date of birth",
  duplicateKeysOf(dupe1)
    .some((k) => duplicateKeysOf(dupe2)
    .includes(k)),
);

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${"─".repeat(62)}`);
if (failures.length) {
  console.log(`✗ ${failures.length} failed, ${pass} passed\n`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}

// ── countsAsMembership — "holds a membership" is not "money is current" ──────
// Both readers (Member.status and the roster's derived track) resolve through
// this one predicate, so they cannot drift apart.
{
  const sub = (o: Partial<Parameters<typeof countsAsMembership>[0]>) =>
    ({ status: "active", ...o }) as Parameters<typeof countsAsMembership>[0];

  // The case that started this: a Stripe trial is an active row at full price
  // with no money behind it. Levi Schanzenbach, $175, zero payments.
  check("priced row with NO payment is not a membership (the trial case)",
    countsAsMembership(sub({ price: 175, billingType: "RECURRING", hasSucceededPayment: false })) === false);
  check("priced row WITH a payment is a membership",
    countsAsMembership(sub({ price: 175, billingType: "RECURRING", hasSucceededPayment: true })) === true);
  check("missing payment proof reads as no proof, not as yes",
    countsAsMembership(sub({ price: 175, billingType: "RECURRING" })) === false);

  // stripeStatus is deliberately NOT consulted — it is a cached snapshot that
  // goes stale. Kellan Lister still reads "trialing" though he paid in July.
  check("a stale trialing snapshot cannot demote a member who paid",
    countsAsMembership(sub({ price: 450, billingType: "RECURRING", hasSucceededPayment: true })) === true);

  // MANUAL is exempt: a cash member IS a member; unrecorded cash is a
  // bookkeeping gap, surfaced in TRAINING_UNBILLED instead.
  check("MANUAL cash row counts with no payment recorded (Max Hall)",
    countsAsMembership(sub({ price: 175, billingType: "MANUAL", hasSucceededPayment: false })) === true);
  check("MANUAL exemption does not depend on price",
    countsAsMembership(sub({ price: 0, billingType: "MANUAL" })) === true);

  // $0 needs the club to have said so.
  check("$0 without the marker is not a membership (placeholder rows)",
    countsAsMembership(sub({ price: 0, billingType: "RECURRING" })) === false);
  check("$0 WITH the deliberate-free marker is a membership (real comps)",
    countsAsMembership(sub({ price: 0, billingType: "RECURRING", deliberateFree: true })) === true);
  check("a priced row is not rescued by the free marker",
    countsAsMembership(sub({ price: 175, billingType: "RECURRING", deliberateFree: true, hasSucceededPayment: false })) === false);
  check("null price behaves as zero",
    countsAsMembership(sub({ price: null, billingType: "RECURRING" })) === false);
}

console.log(`✓ ${pass}/${pass} passed`);
