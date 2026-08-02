/**
 * Send-path smoke tests — the send-side invariants the plan §3N test
 * matrix says we must never break. Deliberately narrow: covers the
 * dedup, opt-out, personalization, and coach-audience code paths that
 * back the real send. No DB, no provider — fixtures + pure fns only.
 *
 *   npx tsx scripts/send-path-tests.ts
 *
 * Exits non-zero on any failure.
 */

import {
  resolveRecipientsPure,
  type MemberForResolve,
} from "../lib/emailRecipients";
import {
  extractTokensFromBlocks,
  interpolateBlocks,
  interpolateString,
} from "../lib/emailPersonalization";
import type { EmailBlock } from "../lib/emailBlocks";
import {
  runPreflight,
  hasBlocker,
  TYPED_CONFIRM_THRESHOLD,
} from "../lib/emailPreflight";
import { INLINE_DISPATCH_MAX } from "../lib/enqueueEmailSend";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else {
    fail++;
    const line = `  FAIL ${name}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ""}`;
    console.error(line);
    failures.push(line);
  }
}
function section(t: string) { console.log(`\n${t}`); }

// ── Fixtures ─────────────────────────────────────────────────────────────

function minor(id: string, overrides: {
  guardianUserId?: string;
  guardianEmail?: string;
  guardianFirstName?: string;
} = {}): MemberForResolve {
  const guardianEmail = overrides.guardianEmail ?? "guardian@example.com";
  const guardianUserId = overrides.guardianUserId ?? "u-g";
  return {
    id,
    firstName: id, lastName: "Kid",
    email: null,
    isMinor: true,
    userId: null,
    guardianName: overrides.guardianFirstName ?? null,
    guardianEmail,
    guardian: null,
    guardianLinks: [
      {
        userId: guardianUserId,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        user: {
          id: guardianUserId, email: guardianEmail,
          firstName: overrides.guardianFirstName ?? "G",
          lastName: "Doe", deletedAt: null,
        },
      },
    ],
  };
}

function adult(id: string, email: string | null = `${id}@example.com`): MemberForResolve {
  return {
    id, firstName: id, lastName: "Doe",
    email, isMinor: false, userId: `u-${id}`,
    guardianName: null, guardianEmail: null,
    guardian: null, guardianLinks: [],
  };
}

// ── 1. Household vs per-member dedup ─────────────────────────────────────

section("1) Household vs per-member dedup:");
{
  const kellen = minor("kellen", { guardianUserId: "u-michael", guardianEmail: "michael@example.com", guardianFirstName: "Michael" });
  const cameron = minor("cameron", { guardianUserId: "u-michael", guardianEmail: "michael@example.com", guardianFirstName: "Michael" });

  const household = resolveRecipientsPure({
    members: [kellen, cameron], mode: "HOUSEHOLD",
    optOutSet: new Set(),
    selectedMemberCount: 2,
  });
  check("HOUSEHOLD collapses shared-guardian siblings to 1 row", household.send.length === 1, household.send.length);
  check("HOUSEHOLD dedupeKey has no memberId suffix", household.send[0]?.dedupeKey === "michael@example.com", household.send[0]?.dedupeKey);
  check("HOUSEHOLD reports second sibling as DUPLICATE_IN_BATCH", household.skipped[0]?.reason === "DUPLICATE_IN_BATCH", household.skipped);

  const perMember = resolveRecipientsPure({
    members: [kellen, cameron], mode: "PER_MEMBER",
    optOutSet: new Set(),
    selectedMemberCount: 2,
  });
  check("PER_MEMBER expands to 2 rows at same guardian address", perMember.send.length === 2, perMember.send.length);
  check("PER_MEMBER dedupeKeys include memberId", perMember.send.every((r) => r.dedupeKey.includes(":")), perMember.send.map((r) => r.dedupeKey));
}

// ── 2. Missing + invalid addresses ───────────────────────────────────────

section("2) Missing + invalid addresses:");
{
  const noEmail = adult("orphan", null);
  const bad = adult("garbage", "not-an-email");
  const good = adult("ok", "ok@example.com");
  const res = resolveRecipientsPure({
    members: [noEmail, bad, good], mode: "PER_MEMBER",
    optOutSet: new Set(),
    selectedMemberCount: 3,
  });
  check("orphan skipped NO_EMAIL", res.skipped.find((s) => s.memberId === "orphan")?.reason === "NO_EMAIL", res.skipped);
  check("garbage skipped INVALID_ADDRESS", res.skipped.find((s) => s.memberId === "garbage")?.reason === "INVALID_ADDRESS", res.skipped);
  check("valid row survives", res.send.some((s) => s.memberId === "ok"), res.send);
  check("counts.noEmail = 1", res.counts.noEmail === 1, res.counts);
  check("counts.invalidAddress = 1", res.counts.invalidAddress === 1, res.counts);
}

// ── 3. Unsubscribed recipients ───────────────────────────────────────────

section("3) Unsubscribed recipients:");
{
  const a = adult("out", "out@example.com");
  const b = adult("in", "in@example.com");
  const res = resolveRecipientsPure({
    members: [a, b], mode: "PER_MEMBER",
    optOutSet: new Set(["out@example.com"]),
    selectedMemberCount: 2,
  });
  check("opted-out address skipped OPTED_OUT", res.skipped.find((s) => s.memberId === "out")?.reason === "OPTED_OUT", res.skipped);
  check("in-list address still sends", res.send.some((s) => s.memberId === "in"), res.send);
  check("counts.optedOut = 1", res.counts.optedOut === 1, res.counts);
}

// ── 4. Duplicate-send prevention (dedupeKey uniqueness) ──────────────────

section("4) Duplicate-send prevention:");
{
  // Same guardian for 3 different children, HOUSEHOLD → 1 row + 2 skipped
  const g = "shared@example.com";
  const a = minor("a", { guardianUserId: "u-x", guardianEmail: g });
  const b = minor("b", { guardianUserId: "u-x", guardianEmail: g });
  const c = minor("c", { guardianUserId: "u-x", guardianEmail: g });
  const res = resolveRecipientsPure({
    members: [a, b, c], mode: "HOUSEHOLD",
    optOutSet: new Set(),
    selectedMemberCount: 3,
  });
  check("3 shared-guardian minors collapse to 1", res.send.length === 1, res.send.length);
  check("2 rows reported as DUPLICATE_IN_BATCH", res.counts.duplicateInBatch === 2, res.counts);
  check("dedupeKeys are unique in the send set (matches M16 partial unique index)",
    new Set(res.send.map((r) => `batch|${r.dedupeKey}`)).size === res.send.length,
    res.send.map((r) => r.dedupeKey));
}

// ── 5. Personalization with a missing token ──────────────────────────────

section("5) Personalization with a missing token:");
{
  const blocks: EmailBlock[] = [
    { type: "heading", level: 1, text: "Hi {{guardian_first_name}},", align: "left" },
    { type: "paragraph", align: "left", runs: [{ kind: "text", text: "Balance: {{outstanding_balance}}. Event: {{event_name}}." }] },
  ];
  const referenced = extractTokensFromBlocks(blocks);
  check("extracts guardian_first_name", referenced.includes("guardian_first_name"));
  check("extracts outstanding_balance", referenced.includes("outstanding_balance"));

  // Values missing outstanding_balance ON PURPOSE.
  const values: Record<string, string> = {
    guardian_first_name: "Michael",
    event_name: "Summer Camp",
  };
  const rendered = interpolateBlocks(blocks, values);
  const headingText = (rendered[0] as { text: string }).text;
  const paragraphText = (rendered[1] as { runs: Array<{ text: string }> }).runs[0].text;

  check("heading gets Michael", headingText === "Hi Michael,", headingText);
  check("missing balance collapses to blank (no {{token}} leak)",
    paragraphText === "Balance: . Event: Summer Camp.",
    paragraphText);
  // Explicit: nobody should ever see raw double-braces in a sent email.
  check("no raw {{token}} anywhere in body", !/\{\{|\}\}/.test(paragraphText + headingText), { paragraphText, headingText });

  // Subject interpolation: unknown tokens also collapse.
  const subject = interpolateString("Reminder for {{athlete_first_name}}", { });
  check("subject interpolation with missing token → blank", subject === "Reminder for ", subject);
}

// ── 6. Cross-family safety ──────────────────────────────────────────────

section("6) Cross-family safety — tokens resolve per recipient:");
{
  // If we ran ONE interpolation pass and reused the values for the
  // whole batch, we'd leak the first recipient's guardian name to every
  // other row. The send path calls resolveMemberPersonalization per
  // recipient (see /api/members/bulk); this test verifies that
  // interpolateBlocks itself doesn't have any hidden shared state.
  const blocks: EmailBlock[] = [
    { type: "paragraph", align: "left", runs: [{ kind: "text", text: "Hi {{guardian_first_name}}," }] },
  ];
  const first = interpolateBlocks(blocks, { guardian_first_name: "Michael" });
  const second = interpolateBlocks(blocks, { guardian_first_name: "Anne" });
  const firstText = (first[0] as { runs: Array<{ text: string }> }).runs[0].text;
  const secondText = (second[0] as { runs: Array<{ text: string }> }).runs[0].text;
  check("first recipient sees Michael", firstText === "Hi Michael,", firstText);
  check("second recipient sees Anne (not Michael)", secondText === "Hi Anne,", secondText);
  // And the original blocks array is never mutated (defensive contract).
  const origText = (blocks[0] as { runs: Array<{ text: string }> }).runs[0].text;
  check("original blocks not mutated", origText === "Hi {{guardian_first_name}},", origText);
}

// ── 7. 3K preflight — the send blockers ─────────────────────────────────

section("7) 3K preflight blockers:");
{
  const clubOk = {
    name: "Test Club", publicEmail: "hello@test.com", contactEmail: null,
    publicPhone: null, contactPhone: null,
    mailingAddress: "1 Main", mailingCity: "Ithaca", mailingState: "NY", mailingZip: "14850",
  };
  const emptyPreflight = runPreflight({
    subject: "",
    blocks: [{ type: "paragraph", align: "left", runs: [{ kind: "text", text: "Hi" }] }],
    counts: { willSendRows: 5, noEmail: 0, invalidAddress: 0, optedOut: 0, duplicateInBatch: 0 },
    fromName: "Test", club: clubOk,
  });
  check("empty subject → BLOCK", hasBlocker(emptyPreflight), emptyPreflight);

  const emptyBody = runPreflight({
    subject: "hi", blocks: [], counts: { willSendRows: 5, noEmail: 0, invalidAddress: 0, optedOut: 0, duplicateInBatch: 0 },
    fromName: "Test", club: clubOk,
  });
  check("empty blocks → BLOCK", hasBlocker(emptyBody), emptyBody);

  const noRecipients = runPreflight({
    subject: "hi", blocks: [{ type: "paragraph", align: "left", runs: [{ kind: "text", text: "Hi" }] }],
    counts: { willSendRows: 0, noEmail: 3, invalidAddress: 0, optedOut: 0, duplicateInBatch: 0 },
    fromName: "Test", club: clubOk,
  });
  check("willSendRows=0 → BLOCK", hasBlocker(noRecipients), noRecipients);

  const good = runPreflight({
    subject: "hi", blocks: [{ type: "paragraph", align: "left", runs: [{ kind: "text", text: "Hi" }] }],
    counts: { willSendRows: 5, noEmail: 0, invalidAddress: 0, optedOut: 0, duplicateInBatch: 0 },
    fromName: "Test", club: clubOk,
  });
  check("clean input → no BLOCK", !hasBlocker(good), good);

  const typoTokens = runPreflight({
    subject: "hi {{gaurdian_first_name}}",  // typo
    blocks: [{ type: "paragraph", align: "left", runs: [{ kind: "text", text: "Hi" }] }],
    counts: { willSendRows: 5, noEmail: 0, invalidAddress: 0, optedOut: 0, duplicateInBatch: 0 },
    fromName: "Test", club: clubOk,
  });
  check("typo token surfaces UNKNOWN_TOKENS warning", typoTokens.some((i) => i.code === "UNKNOWN_TOKENS"), typoTokens);
  check("typo token does NOT block send", !hasBlocker(typoTokens), typoTokens);
}

// ── 8. Queue threshold ──────────────────────────────────────────────────

section("8) INLINE_DISPATCH_MAX guards the timeout:");
{
  check("threshold is set", INLINE_DISPATCH_MAX > 0 && INLINE_DISPATCH_MAX <= 200, INLINE_DISPATCH_MAX);
  check("threshold provides ≥40s headroom vs Netlify 60s ceiling at 400ms/row",
    INLINE_DISPATCH_MAX * 400 <= 60_000 - 20_000, INLINE_DISPATCH_MAX);
  check("large 292-family send exceeds threshold (uses queue path)",
    292 > INLINE_DISPATCH_MAX, INLINE_DISPATCH_MAX);
  check("typed-confirm threshold ≤ inline dispatch threshold (typed confirm still fires for the fast path)",
    TYPED_CONFIRM_THRESHOLD <= INLINE_DISPATCH_MAX);
}

// ── Report ──────────────────────────────────────────────────────────────

console.log("");
if (fail === 0) {
  console.log(`All ${pass} send-path tests passed.`);
  process.exit(0);
} else {
  console.error(`${fail} failure(s) out of ${pass + fail}:`);
  for (const f of failures) console.error(f);
  process.exit(1);
}
