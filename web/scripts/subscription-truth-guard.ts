/**
 * Phase 6 — the standing guard against a member-level field answering a
 * subscription-level question.
 *
 *   npm run test:subscription-truth
 *
 * No database, no network — this reads the source tree, like
 * scripts/members-grep-guards.ts, whose ratchet pattern this follows.
 *
 * ── Why a guard and not a code review ───────────────────────────────────────
 *
 * Four production bugs in one week were one shape: a field on `Member` that
 * names "the" membership, "the" commitment or "the" billing date, read as the
 * current answer. The pattern is easy to see in someone else's code and easy to
 * repeat in your own — the fourth was written by the person documenting the
 * first three, in a diagnostic query, while writing them up.
 *
 * Every one was found by accident. That is the thing this replaces.
 *
 * ── What it cannot catch ────────────────────────────────────────────────────
 *
 * `Transaction.memberId` in a reconciliation join was typed into an MCP session
 * and never lived in the repo. A source guard cannot see that. GUARD C below
 * covers the in-repo half; the data half is
 * scripts/report-subscription-truth.ts, which reads production and reports
 * where the two answers diverge.
 *
 * ── Ratchet, not a wall ─────────────────────────────────────────────────────
 *
 * Each guard records the count measured on 2026-09-03 and fails only if it
 * GROWS. Every baseline below is real, current, and legitimate — the migration
 * and import paths that WRITE these fields, and the surfaces that deliberately
 * display them as history. A guard that is red on the day it is written gets
 * ignored within a week.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..");
const SCAN_DIRS = ["app", "components", "lib"];

let failed = false;
const note = (s: string) => console.log(s);

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next" || e.startsWith(".")) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((x) => p.endsWith(x))) out.push(p);
  }
  return out;
}

/**
 * Strip comments before scanning. A field name in a comment explaining why the
 * field must NOT be read is the documentation this guard exists to protect —
 * counting it would punish the explanation and reward silence.
 */
function stripComments(src: string): string {
  // Blank the comment out rather than delete it — a block comment that collapses
  // to nothing shifts every line number after it, and a guard that reports the
  // wrong line teaches people to distrust it.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, (_m, p1) => p1);
}

/** 1-indexed line number of a character offset. */
const lineAt = (src: string, idx: number) => src.slice(0, idx).split("\n").length;

/**
 * The brace-balanced argument object of a call whose opening paren is at
 * `open`. Character windows are not good enough here: a `membershipId` sixty
 * characters past the end of a query reads as part of it, and every false
 * positive spends the credibility this guard runs on.
 */
function callArgs(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open, open + 2000);
}

/** The `where: { … }` clause inside a Prisma call's arguments, or "". */
function whereClause(args: string): string {
  const m = /\bwhere\s*:\s*\{/.exec(args);
  if (!m) return "";
  const open = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < args.length; i++) {
    const c = args[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return args.slice(open, i + 1);
    }
  }
  return "";
}

const ALL_SOURCE = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d), [".ts", ".tsx"]));

/**
 * Where these fields are legitimately read: the paths that IMPORT them, the
 * paths that WRITE them at purchase, and the billing surfaces that show them
 * labelled as history ("Imported billing anchor"). A file matching this is
 * still counted — the ratchet just expects it to be there.
 */
const MIGRATION_ZONE =
  /(\/migration\/|\/import\/|\/activate\/|\/reactivat|\/approvals?\/|\/approve\/|billing-admin|billingAdmin|migrationServer|reactivation\.ts)/i;

type Hit = { file: string; line: number; text: string };

function scan(re: RegExp, files = ALL_SOURCE): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    const lines = stripComments(readFileSync(file, "utf8")).split("\n");
    lines.forEach((l, i) => {
      if (re.test(l)) hits.push({ file: relative(ROOT, file), line: i + 1, text: l.trim().slice(0, 96) });
    });
  }
  return hits;
}

/**
 * Two thresholds, because they mean different things.
 *
 * `outsideBaseline` is the one that matters: a read of a member-level date in a
 * file that is NOT migration/import/approve code. It is 0 today and going above
 * it is a hard fail — that is the bug, arriving.
 *
 * `totalBaseline` ratchets the migration-zone reads, which are legitimate (they
 * are the code that WRITES these fields) but should not quietly multiply.
 */
function ratchet(
  label: string,
  totalBaseline: number,
  outsideBaseline: number,
  hits: Hit[],
  guidance: string[],
) {
  const outside = hits.filter((h) => !MIGRATION_ZONE.test(h.file));
  note(`  current: ${hits.length} total (baseline ${totalBaseline}) · ` +
       `${outside.length} outside migration/import paths (baseline ${outsideBaseline})`);

  if (outside.length > outsideBaseline) {
    failed = true;
    note(`  ✗ ${outside.length - outsideBaseline} NEW read(s) outside migration code — ${label}`);
    for (const h of outside) note(`      ${h.file}:${h.line}  ${h.text}`);
    note("");
    for (const g of guidance) note(`    ${g}`);
    return;
  }
  if (hits.length > totalBaseline) {
    failed = true;
    note(`  ✗ migration-zone reads went UP (${totalBaseline} → ${hits.length}).`);
    note("    That is allowed to be deliberate — these paths own these fields — but it");
    note("    is not allowed to be accidental. Raise the baseline in the same commit and");
    note("    say what the new read is for.");
    return;
  }
  if (hits.length < totalBaseline) note(`  ✓ went DOWN (${totalBaseline} → ${hits.length}) — lower the baseline to ${hits.length}`);
  else note("  ✓ holding at baseline");
}

// ═══════════════════════════════════════════════════════════════════════════
// GUARD A — Member-level subscription fields, read outside migration code
// ═══════════════════════════════════════════════════════════════════════════
//
// `member.commitmentEndDate` is a CEILING chosen at import; the subscription's
// `minimumTermEndsAt` is a FLOOR computed at purchase, and its `endDate` is the
// per-subscription ceiling. `member.billingAnchorDate` is a one-time migration
// input that nothing advances; the subscription's `currentPeriodEnd` and
// `paidThroughDate` are the live answers.
//
// Matching is on the PROPERTY ACCESS (`member.x`, `m.x`, `sub.member.x`), not
// the bare identifier — MemberSubscription has its OWN `billingAnchorDate`
// column, and reading THAT is correct. A guard that could not tell them apart
// would be wrong half the time and get switched off.

note("\nGUARD A — member-level subscription fields read as the current answer");
const MEMBER_FIELD_READ =
  /\b(?:member|m|mem|athlete|child|row|rec)\s*(?:\?)?\.\s*(commitmentEndDate|billingAnchorDate|nextBillingDate|membershipStartDate)\b/;
ratchet(
  "a member-level date is being read as a subscription fact",
  44,
  0,
  scan(MEMBER_FIELD_READ),
  [
    "The subscription carries the per-purchase versions and they do not go stale:",
    "  term      → MemberSubscription.minimumTermEndsAt, else its own endDate",
    "  next bill → MemberSubscription.currentPeriodEnd ?? paidThroughDate",
    "  money     → MemberSubscription.paidThroughDate",
    "A member can end one membership and buy another, or hold two at once, so a",
    "single member-level date cannot say WHICH membership it meant. It is import",
    "history — keep it, read it in migration code, never answer with it.",
  ],
);

// ═══════════════════════════════════════════════════════════════════════════
// GUARD B — "who is on this plan", asked of Member instead of subscriptions
// ═══════════════════════════════════════════════════════════════════════════
//
// HARD FAIL, and green today. On 2026-08-25 the pointer-based count said Girls
// Only had 0 members while two women were on it, and Girls Jr Frogs had 2 on
// the strength of pointers left behind by memberships that had ended. Neither
// number described anybody. Measured 2026-09-03, the pointer agrees with the
// subscriptions for 19 of 42 people — it is wrong more often than right.
//
// lib/membersQuery.onPlanWhere() is the one definition. This catches the second
// one being written.

note("\nGUARD B — plan membership counted from Member.membershipId (HARD FAIL)");
const planHits: Hit[] = [];
for (const file of ALL_SOURCE) {
  const rel = relative(ROOT, file);
  const src = stripComments(readFileSync(file, "utf8"));

  // A prisma.member.* query that FILTERS on membershipId. Scoped to the where
  // clause: `const { memberId, clubId, membershipId } = input` sitting two lines
  // above a member lookup is not this bug, and counting it would train people to
  // ignore the guard.
  const callRe = /prisma\.member\.(findMany|findFirst|count|groupBy|aggregate|updateMany)\s*\(/g;
  let mt: RegExpExecArray | null;
  while ((mt = callRe.exec(src))) {
    const where = whereClause(callArgs(src, mt.index + mt[0].length - 1));
    if (/\bmembershipId\b/.test(where)) {
      planHits.push({ file: rel, line: lineAt(src, mt.index), text: mt[0] });
    }
  }

  // `_count: { select: { members: true } }` counts the Membership.members
  // back-relation, i.e. the same stale pointer. Only on a MEMBERSHIP query —
  // MessageGroup has a `members` relation too, and counting ITS members is a
  // completely different and entirely correct thing to do.
  const countRe = /prisma\.membership\.(findMany|findFirst|findUnique)\s*\(/g;
  while ((mt = countRe.exec(src))) {
    const args = callArgs(src, mt.index + mt[0].length - 1);
    if (/_count\s*:\s*\{\s*select\s*:\s*\{[^}]*\bmembers\b/.test(args)) {
      planHits.push({ file: rel, line: lineAt(src, mt.index), text: "_count.members on Membership" });
    }
  }
}
// Baseline 1: app/api/memberships/route.ts keeps `_count.members` so nothing
// reading the old field breaks, and computes the real `activeMemberCount` from
// a memberSubscription.groupBy right beside it. The pointer count is returned
// deliberately, and is no longer the member count.
const PLAN_BASELINE = 1;
note(`  current: ${planHits.length} (baseline ${PLAN_BASELINE})`);
for (const h of planHits) note(`      ${h.file}:${h.line}  ${h.text}`);
if (planHits.length > PLAN_BASELINE) {
  failed = true;
  note("");
  note("  ✗ a plan-membership question is being asked of Member.membershipId.");
  note("    That column is a denormalised 'current plan' pointer. Nothing updates it");
  note("    when a subscription ends, so it survives the membership it described —");
  note("    measured 2026-09-03 it agreed with the subscriptions for 19 of 42 people.");
  note("    Use lib/membersQuery.onPlanWhere(membershipId) — the one definition — or");
  note("    group memberSubscription by membershipId with HOLDS_MEMBERSHIP_STATUSES.");
} else if (planHits.length < PLAN_BASELINE) {
  note(`  ✓ went DOWN — lower PLAN_BASELINE to ${planHits.length}`);
} else {
  note("  ✓ holding at baseline");
}

// ═══════════════════════════════════════════════════════════════════════════
// GUARD C — money reconciled through a member instead of the invoice id
// ═══════════════════════════════════════════════════════════════════════════
//
// HARD FAIL, and green today. Reconciling invoices to payments THROUGH
// `Transaction.memberId` reported a $545.37 hole that did not exist: the
// subscription had been transferred from Michael Lister to Kellan, so the money
// and the subscription sat on different members. Both records were correct; the
// join was the bug.
//
// `memberId` is deliberately movable — a transfer rewrites it. `stripeInvoiceId`
// is not. This looks for a transaction query that filters on memberId in the
// same breath as an invoice or reconciliation concept.

note("\nGUARD C — money matched through Transaction.memberId (HARD FAIL)");
const moneyHits: Hit[] = [];
for (const file of ALL_SOURCE) {
  const rel = relative(ROOT, file);
  const src = stripComments(readFileSync(file, "utf8"));
  const callRe = /prisma\.transaction\.(findMany|findFirst|count|groupBy|aggregate)\s*\(/g;
  let mt: RegExpExecArray | null;
  while ((mt = callRe.exec(src))) {
    const where = whereClause(callArgs(src, mt.index + mt[0].length - 1));
    // BOTH keys in one filter is the signature. Counting a member's own
    // transactions is normal and correct — archival preflight, a balance, an
    // email merge field. What is never right is reaching for the invoice and
    // the member together, because that asks the movable key to confirm the
    // immutable one.
    if (/\bmemberId\b/.test(where) && /\bstripeInvoiceId\b/.test(where)) {
      moneyHits.push({ file: rel, line: lineAt(src, mt.index), text: mt[0] });
    }
  }
}
note(`  current: ${moneyHits.length} (baseline 0)`);
for (const h of moneyHits) note(`      ${h.file}:${h.line}  ${h.text}`);
if (moneyHits.length > 0) {
  failed = true;
  note("");
  note("  ✗ an invoice is being matched together with a member. Transaction.memberId is");
  note("    movable — a membership transfer rewrites it, and the payment stays with");
  note("    whoever actually paid, which is also correct. Match on stripeInvoiceId");
  note("    ALONE. Both records are right; joining them through a member is what");
  note("    invents the discrepancy — that is the $545.37 that was never missing.");
} else {
  note("  ✓ none");
}

// ═══════════════════════════════════════════════════════════════════════════
// GUARD D — planNonRenewal must never take a member-level date again
// ═══════════════════════════════════════════════════════════════════════════
//
// HARD FAIL. This is the one that wrote a member-level date to STRIPE as
// `cancel_at`. Removed 2026-09-03; the input type now carries the subscription's
// own `endDate`. Measured before removal: 28 of 33 live subscriptions had no
// term of their own, 17 would have taken their stop date from the member row,
// and three disagreed with the subscription they would have stopped — one
// member held TWO live subscriptions behind a single date.

note("\nGUARD D — planNonRenewal reading a member-level commitment (HARD FAIL)");
const autopay = join(ROOT, "lib", "autopay.ts");
const autopaySrc = stripComments(readFileSync(autopay, "utf8"));
const nonRenewalTakesMemberField = /commitmentEndDate\s*[:?]/.test(autopaySrc);
const callSites = scan(/commitmentEndDate\s*:\s*[a-zA-Z_$][\w.$?]*\.member/);
if (nonRenewalTakesMemberField || callSites.length) {
  failed = true;
  note("  ✗ the member-level commitment date is back in the non-renewal path.");
  for (const h of callSites) note(`      ${h.file}:${h.line}  ${h.text}`);
  note("");
  note("    planNonRenewal's result is written to Stripe as cancel_at. Reading the");
  note("    member row there means a second membership can be stopped on a date that");
  note("    belonged to the first. Use minimumTermEndsAt ?? the subscription's own");
  note("    endDate — activation, approve and reactivation all copy the commitment");
  note("    onto it at purchase, so legacy rows keep working.");
} else {
  note("  ✓ planNonRenewal reads the subscription only");
}

// ═══════════════════════════════════════════════════════════════════════════
note(`\n${"─".repeat(70)}`);
if (failed) {
  note("✗ subscription-truth guard failed");
  note("");
  note("  If a hit here is genuinely correct — migration code, an import path, or a");
  note("  surface deliberately showing import history — raise that guard's baseline in");
  note("  this file IN THE SAME COMMIT, and say in the message what the new read is and");
  note("  why the member row is the right source for it. Never raise one to get green.");
  note("");
  note("  The data-side half of this check is:  npx tsx scripts/report-subscription-truth.ts");
  note("");
  process.exit(1);
}
note("✓ subscription-truth guard passed\n");
