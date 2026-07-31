/**
 * Email recipient resolution — pure-function tests.
 *
 * Verifies the schema-review constraint that a guardian with two children
 * collapses to ONE EmailSend row in HOUSEHOLD mode and expands to TWO rows
 * in PER_MEMBER and PER_ATHLETE_PRIMARY modes, and that dedupeKeys line up
 * with what the M16 partial unique index enforces (which is what stops the
 * same clientKey from double-sending).
 *
 * No DB, no Prisma, no network. Runs against the exported
 * resolveRecipientsPure() with hand-built fixtures.
 *
 *   npx tsx scripts/email-recipients-tests.ts
 *
 * Exits non-zero on any failure.
 */

import {
  resolveRecipientsPure,
  type MemberForResolve,
  type HouseholdMode,
} from "../lib/emailRecipients";

// ── Test harness ─────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    const line = `  FAIL ${name}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ""}`;
    console.error(line);
    failures.push(line);
  }
}
function section(title: string) {
  console.log(`\n${title}`);
}

// ── Fixture builders ─────────────────────────────────────────────────────

// Minor athlete whose primary guardian is a real User row (via
// MemberGuardianUser). Legacy Member.guardianEmail is present too so we
// verify the code prefers the live guardian link over legacy.
function minor(overrides: {
  id: string;
  firstName?: string;
  lastName?: string;
  guardianUserId: string;
  guardianEmail: string;
  guardianFirstName?: string;
  guardianLastName?: string;
  createdAt?: Date;
  legacyGuardianEmail?: string | null;
  legacyGuardianName?: string | null;
}): MemberForResolve {
  return {
    id: overrides.id,
    firstName: overrides.firstName ?? "Kid",
    lastName: overrides.lastName ?? "Doe",
    email: null,
    isMinor: true,
    userId: null,
    guardianName: overrides.legacyGuardianName ?? null,
    guardianEmail: overrides.legacyGuardianEmail ?? null,
    guardian: null,
    guardianLinks: [
      {
        userId: overrides.guardianUserId,
        createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00Z"),
        user: {
          id: overrides.guardianUserId,
          email: overrides.guardianEmail,
          firstName: overrides.guardianFirstName ?? null,
          lastName: overrides.guardianLastName ?? null,
          deletedAt: null,
        },
      },
    ],
  };
}

// Minor with NO guardianLink (legacy path — only the inline guardianEmail).
function minorLegacyOnly(overrides: {
  id: string;
  firstName?: string;
  lastName?: string;
  guardianEmail: string;
  guardianName?: string | null;
}): MemberForResolve {
  return {
    id: overrides.id,
    firstName: overrides.firstName ?? "Kid",
    lastName: overrides.lastName ?? "Doe",
    email: null,
    isMinor: true,
    userId: null,
    guardianName: overrides.guardianName ?? null,
    guardianEmail: overrides.guardianEmail,
    guardian: null,
    guardianLinks: [],
  };
}

function adult(overrides: {
  id: string;
  email: string | null;
  firstName?: string;
  lastName?: string;
  userId?: string | null;
}): MemberForResolve {
  return {
    id: overrides.id,
    firstName: overrides.firstName ?? "Adult",
    lastName: overrides.lastName ?? "Doe",
    email: overrides.email,
    isMinor: false,
    userId: overrides.userId ?? null,
    guardianName: null,
    guardianEmail: null,
    guardian: null,
    guardianLinks: [],
  };
}

function noOptOuts(): Set<string> {
  return new Set<string>();
}

// ═════════════════════════════════════════════════════════════════════════
// SCHEMA-REVIEW CONSTRAINT: guardian with two children
//
// The point of the exercise: the same guardian email must produce
//   HOUSEHOLD             → 1 send row (dedupeKey = email)
//   PER_MEMBER            → 2 send rows (dedupeKey = email:memberId)
//   PER_ATHLETE_PRIMARY   → 2 send rows (dedupeKey = email:athleteMemberId)
//
// If HOUSEHOLD ever yields 2, the M16 partial unique index would
// (correctly) reject the second insert and the guardian would silently
// miss a send. If PER_MEMBER yields 1, we've collapsed a mode the sender
// deliberately chose.
// ═════════════════════════════════════════════════════════════════════════

section("Guardian with two children — HOUSEHOLD mode:");

{
  const kellen = minor({
    id: "m-kellen",
    firstName: "Kellen",
    guardianUserId: "u-michael",
    guardianEmail: "michael@example.com",
    guardianFirstName: "Michael",
    guardianLastName: "Lister",
  });
  const cameron = minor({
    id: "m-cameron",
    firstName: "Cameron",
    guardianUserId: "u-michael",
    guardianEmail: "michael@example.com",
    guardianFirstName: "Michael",
    guardianLastName: "Lister",
    createdAt: new Date("2026-01-02T00:00:00Z"),
  });

  const res = resolveRecipientsPure({
    members: [kellen, cameron],
    mode: "HOUSEHOLD",
    optOutSet: noOptOuts(),
    selectedMemberCount: 2,
  });

  check(
    "1 EmailSend row written",
    res.send.length === 1,
    { got: res.send.length, send: res.send },
  );
  check(
    "1 skipped as DUPLICATE_IN_BATCH (the second child at the same address)",
    res.skipped.length === 1 && res.skipped[0].reason === "DUPLICATE_IN_BATCH",
    res.skipped,
  );
  check(
    "willSendRows count matches the actual send array",
    res.counts.willSendRows === 1,
    res.counts,
  );
  check(
    "duplicateInBatch counted separately from willSendRows",
    res.counts.duplicateInBatch === 1,
    res.counts,
  );
  check(
    "selectedMembers reflects the caller's original input, not the collapsed count",
    res.counts.selectedMembers === 2,
    res.counts,
  );
  check(
    "uniqueAddresses = 1 (both children share one guardian inbox)",
    res.counts.uniqueAddresses === 1,
    res.counts,
  );
  check(
    "dedupeKey = lower(email) — no memberId/athleteMemberId suffix",
    res.send[0]?.dedupeKey === "michael@example.com",
    res.send[0]?.dedupeKey,
  );
  check(
    "recipientEmail lowercased at resolve time",
    res.send[0]?.recipientEmail === "michael@example.com",
    res.send[0]?.recipientEmail,
  );
  check(
    "athleteMemberId=null in HOUSEHOLD mode (per emailRecipients.ts contract)",
    res.send[0]?.athleteMemberId === null,
    res.send[0]?.athleteMemberId,
  );
  check(
    "recipientDisplayName rendered from guardianLink User name",
    res.send[0]?.recipientDisplayName === "Michael Lister",
    res.send[0]?.recipientDisplayName,
  );
  // In HOUSEHOLD mode the recipientMemberId is whichever child collapsed
  // first — the sending semantic is "one message to the household", and 3G
  // history is scoped by the sendBatchId, so which child "owns" the row is
  // not user-visible. But it must be deterministic: candidatesFor runs in
  // input order, so kellen (the first) wins.
  check(
    "recipientMemberId is the FIRST-processed child (deterministic)",
    res.send[0]?.recipientMemberId === "m-kellen",
    res.send[0]?.recipientMemberId,
  );
}

section("Guardian with two children — PER_MEMBER mode:");

{
  const kellen = minor({
    id: "m-kellen",
    firstName: "Kellen",
    guardianUserId: "u-michael",
    guardianEmail: "michael@example.com",
    guardianFirstName: "Michael",
    guardianLastName: "Lister",
  });
  const cameron = minor({
    id: "m-cameron",
    firstName: "Cameron",
    guardianUserId: "u-michael",
    guardianEmail: "michael@example.com",
    guardianFirstName: "Michael",
    guardianLastName: "Lister",
    createdAt: new Date("2026-01-02T00:00:00Z"),
  });

  const res = resolveRecipientsPure({
    members: [kellen, cameron],
    mode: "PER_MEMBER",
    optOutSet: noOptOuts(),
    selectedMemberCount: 2,
  });

  check(
    "2 EmailSend rows written (one per member, same address)",
    res.send.length === 2,
    { got: res.send.length, send: res.send },
  );
  check("no skipped rows", res.skipped.length === 0, res.skipped);
  check(
    "willSendRows count matches",
    res.counts.willSendRows === 2,
    res.counts,
  );
  check(
    "uniqueAddresses = 1 (still one inbox on the receiving end — the count is honest)",
    res.counts.uniqueAddresses === 1,
    res.counts,
  );
  const kellenRow = res.send.find((r) => r.memberId === "m-kellen");
  const cameronRow = res.send.find((r) => r.memberId === "m-cameron");
  check("kellen row present", !!kellenRow);
  check("cameron row present", !!cameronRow);
  check(
    "kellen dedupeKey = email:memberId — memberId axis",
    kellenRow?.dedupeKey === "michael@example.com:m-kellen",
    kellenRow?.dedupeKey,
  );
  check(
    "cameron dedupeKey = email:memberId — different from kellen's",
    cameronRow?.dedupeKey === "michael@example.com:m-cameron",
    cameronRow?.dedupeKey,
  );
  check(
    "athleteMemberId set to the CHILD on both rows",
    kellenRow?.athleteMemberId === "m-kellen" && cameronRow?.athleteMemberId === "m-cameron",
    { k: kellenRow?.athleteMemberId, c: cameronRow?.athleteMemberId },
  );
  check(
    "same delivery address on both rows",
    kellenRow?.recipientEmail === cameronRow?.recipientEmail,
    { k: kellenRow?.recipientEmail, c: cameronRow?.recipientEmail },
  );
}

section("Guardian with two children — PER_ATHLETE_PRIMARY mode:");

{
  const kellen = minor({
    id: "m-kellen",
    firstName: "Kellen",
    guardianUserId: "u-michael",
    guardianEmail: "michael@example.com",
  });
  const cameron = minor({
    id: "m-cameron",
    firstName: "Cameron",
    guardianUserId: "u-michael",
    guardianEmail: "michael@example.com",
    createdAt: new Date("2026-01-02T00:00:00Z"),
  });

  const res = resolveRecipientsPure({
    members: [kellen, cameron],
    mode: "PER_ATHLETE_PRIMARY",
    optOutSet: noOptOuts(),
    selectedMemberCount: 2,
  });

  check(
    "2 EmailSend rows written (one per athlete's primary contact)",
    res.send.length === 2,
    { got: res.send.length, send: res.send },
  );
  const kellenRow = res.send.find((r) => r.memberId === "m-kellen");
  const cameronRow = res.send.find((r) => r.memberId === "m-cameron");
  check(
    "PER_ATHLETE_PRIMARY dedupeKey = email:athleteMemberId (the athlete axis, not the guardian)",
    kellenRow?.dedupeKey === "michael@example.com:m-kellen" &&
      cameronRow?.dedupeKey === "michael@example.com:m-cameron",
    { k: kellenRow?.dedupeKey, c: cameronRow?.dedupeKey },
  );
}

// ═════════════════════════════════════════════════════════════════════════
// DUPLICATE-SEND PREVENTION ON THE SAME clientKey
//
// The server derives sendBatchId = "batch-<clubId>-<clientKey>" and the
// (sendBatchId, dedupeKey) partial unique index makes a duplicate insert a
// P2002 unique-violation. That guarantee is upstream of the pure resolver,
// but the resolver's dedupeKey semantics are what the index KEYS ON. If two
// candidates produce the same dedupeKey in the same batch, resolver skips
// the second as DUPLICATE_IN_BATCH — same visible behavior as a P2002
// retry, minus a wasted DB round-trip.
//
// This section verifies the dedupeKey shape and in-batch dedup for each of
// the three shapes the server writes:
//   HOUSEHOLD           = email
//   PER_MEMBER          = email:memberId
//   PER_ATHLETE_PRIMARY = email:athleteMemberId
// so a client that resubmits the same (memberIds, mode, clientKey) tuple
// cannot silently double-charge the recipient's inbox.
// ═════════════════════════════════════════════════════════════════════════

section("Duplicate-send prevention — same clientKey retry produces same dedupeKeys:");

{
  const kellen = minor({
    id: "m-kellen",
    guardianUserId: "u-michael",
    guardianEmail: "michael@example.com",
  });
  const cameron = minor({
    id: "m-cameron",
    guardianUserId: "u-michael",
    guardianEmail: "michael@example.com",
    createdAt: new Date("2026-01-02T00:00:00Z"),
  });

  for (const mode of ["HOUSEHOLD", "PER_MEMBER", "PER_ATHLETE_PRIMARY"] as HouseholdMode[]) {
    const first = resolveRecipientsPure({
      members: [kellen, cameron],
      mode,
      optOutSet: noOptOuts(),
      selectedMemberCount: 2,
    });
    const second = resolveRecipientsPure({
      members: [kellen, cameron],
      mode,
      optOutSet: noOptOuts(),
      selectedMemberCount: 2,
    });
    const keys1 = first.send.map((r) => r.dedupeKey).sort();
    const keys2 = second.send.map((r) => r.dedupeKey).sort();
    check(
      `${mode}: dedupeKeys are stable across retries`,
      JSON.stringify(keys1) === JSON.stringify(keys2),
      { keys1, keys2 },
    );
  }
}

section("Duplicate-send prevention — same dedupeKey collapses within one batch:");

{
  // Two ADULTS that happen to share a personal email — a real edge (a
  // couple registering under one address, an athlete + relative sharing an
  // inbox). HOUSEHOLD must collapse them; PER_MEMBER must not.
  const alice = adult({ id: "m-alice", email: "shared@example.com", firstName: "Alice" });
  const bob = adult({ id: "m-bob", email: "shared@example.com", firstName: "Bob" });

  const household = resolveRecipientsPure({
    members: [alice, bob],
    mode: "HOUSEHOLD",
    optOutSet: noOptOuts(),
    selectedMemberCount: 2,
  });
  check(
    "HOUSEHOLD: two adults at the same address collapse to 1 send",
    household.send.length === 1 && household.skipped.length === 1 &&
      household.skipped[0].reason === "DUPLICATE_IN_BATCH",
    { send: household.send.length, skipped: household.skipped },
  );

  const perMember = resolveRecipientsPure({
    members: [alice, bob],
    mode: "PER_MEMBER",
    optOutSet: noOptOuts(),
    selectedMemberCount: 2,
  });
  check(
    "PER_MEMBER: two adults at the same address stay separate",
    perMember.send.length === 2 && perMember.skipped.length === 0,
    { send: perMember.send.length, skipped: perMember.skipped },
  );
}

// ═════════════════════════════════════════════════════════════════════════
// SKIP REASONS — plan §3A pre-send review must be honest about who won't
// receive the email.
// ═════════════════════════════════════════════════════════════════════════

section("Skip reasons:");

{
  const withEmail = adult({ id: "m-1", email: "one@example.com" });
  const noEmailAdult = adult({ id: "m-2", email: null });
  const optedOut = adult({ id: "m-3", email: "out@example.com" });
  const invalid = adult({ id: "m-4", email: "not-an-email" });
  const minorNoGuardian = minorLegacyOnly({
    id: "m-5",
    guardianEmail: "",
    guardianName: null,
  });

  const res = resolveRecipientsPure({
    members: [withEmail, noEmailAdult, optedOut, invalid, minorNoGuardian],
    mode: "HOUSEHOLD",
    optOutSet: new Set(["out@example.com"]),
    selectedMemberCount: 5,
  });

  check("1 valid send", res.send.length === 1 && res.send[0].memberId === "m-1", res.send);
  check("NO_EMAIL counted for adult with null email", res.counts.noEmail >= 1, res.counts);
  check("OPTED_OUT counted for opted-out row", res.counts.optedOut === 1, res.counts);
  check("INVALID_ADDRESS counted for 'not-an-email'", res.counts.invalidAddress === 1, res.counts);
  check(
    "minor with no guardian at all → NO_EMAIL (not a crash)",
    res.skipped.some((s) => s.memberId === "m-5" && s.reason === "NO_EMAIL"),
    res.skipped,
  );
}

section("Legacy guardianEmail fallback (no MemberGuardianUser):");

{
  const kid = minorLegacyOnly({
    id: "m-legacy",
    firstName: "Legacy",
    lastName: "Kid",
    guardianEmail: "parent@example.com",
    guardianName: "Legacy Parent",
  });
  const res = resolveRecipientsPure({
    members: [kid],
    mode: "HOUSEHOLD",
    optOutSet: noOptOuts(),
    selectedMemberCount: 1,
  });
  check(
    "minor routed to legacy guardianEmail when no live link",
    res.send.length === 1 && res.send[0].recipientEmail === "parent@example.com",
    res.send,
  );
  check(
    "recipientUserId is null when routed via legacy path (no User row)",
    res.send[0]?.recipientUserId === null,
    res.send[0]?.recipientUserId,
  );
  check(
    "recipientDisplayName pulled from legacy guardianName",
    res.send[0]?.recipientDisplayName === "Legacy Parent",
    res.send[0]?.recipientDisplayName,
  );
}

section("Adult member — always own address regardless of mode:");

{
  const a = adult({ id: "m-adult", email: "adult@example.com", userId: "u-adult" });
  for (const mode of ["HOUSEHOLD", "PER_MEMBER", "PER_ATHLETE_PRIMARY"] as HouseholdMode[]) {
    const res = resolveRecipientsPure({
      members: [a],
      mode,
      optOutSet: noOptOuts(),
      selectedMemberCount: 1,
    });
    check(
      `${mode}: adult sent to their own address`,
      res.send.length === 1 && res.send[0].recipientEmail === "adult@example.com",
      res.send,
    );
    check(
      `${mode}: adult recipientUserId carries through`,
      res.send[0]?.recipientUserId === "u-adult",
      res.send[0]?.recipientUserId,
    );
  }
}

section("Empty input:");

{
  const res = resolveRecipientsPure({
    members: [],
    mode: "HOUSEHOLD",
    optOutSet: noOptOuts(),
    selectedMemberCount: 0,
  });
  check(
    "empty members yields empty resolution",
    res.send.length === 0 && res.skipped.length === 0 && res.counts.willSendRows === 0,
    res,
  );
}

// ── Report ───────────────────────────────────────────────────────────────

console.log("");
if (fail === 0) {
  console.log(`All ${pass} email-recipients tests passed.`);
  process.exit(0);
} else {
  console.error(`${fail} failure(s) out of ${pass + fail}:`);
  for (const f of failures) console.error(f);
  process.exit(1);
}
