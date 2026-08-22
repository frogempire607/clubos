/**
 * Tests for the renewal-surfacing pair: the `endingSoon` roster queue and the
 * EXPIRING_MEMBERSHIP Action Item that drills through to it.
 *
 * No database. Everything here is either a pure function or a static read of
 * source text, so it runs anywhere:
 *
 *   npx tsx scripts/renewal-surfacing-tests.ts
 *
 * ── The guard that matters most ─────────────────────────────────────────────
 *
 * The EXPIRING_MEMBERSHIP card shipped in 2.5.1a pointing at
 * `/dashboard/members?filter=expiring`. `filter` is not a parameter this app
 * has ever parsed — `parseMemberFilters` reads `search`, `personType`,
 * `setupState`, `membership`, `tag`, `gender`, `queue`, `sort`, `page`,
 * `pageSize` and nothing else. So the card's only call to action opened an
 * unfiltered roster, and it did that for months without anything noticing,
 * because a dead query parameter is silent: the page renders, it just renders
 * the wrong thing.
 *
 * Writing this suite found a THIRD one: UPCOMING_RENEWAL_LARGE pointed at
 * `?filter=upcoming_renewals`, equally dead, shipped in the same release.
 *
 * So the link guard below checks EVERY static `/dashboard/members?…` link in
 * lib/, app/ and components/ against the roster's declared parameter
 * vocabulary (MEMBER_FILTER_PARAM_KEYS + MEMBER_NON_FILTER_PARAM_KEYS). A link
 * carrying a parameter the roster does not read fails the suite.
 */
import fs from "fs";
import path from "path";
import {
  ENDING_SOON_WINDOW_DAYS,
  MEMBER_FILTER_PARAM_KEYS,
  MEMBER_NON_FILTER_PARAM_KEYS,
  parseMemberFilters,
  queueClauses,
  type MemberListFilters,
} from "../lib/membersQuery";
import { cannotChargeOutsidePlanDays, renewalSeverity } from "../lib/reportsActionItems";

let pass = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
    return;
  }
  failures.push(detail ? `${label} — ${detail}` : label);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}

const WEB = path.resolve(__dirname, "..");
const DAY = 86_400_000;

// ── 1. The endingSoon queue clause ──────────────────────────────────────────
console.log("\nendingSoon queue clause:");
{
  const now = new Date("2026-08-16T12:00:00.000Z");
  const clause = queueClauses(now).endingSoon as {
    subscriptions?: { some?: Record<string, unknown> };
  };

  const some = clause.subscriptions?.some;
  check("is expressed as a subscriptions.some predicate", !!some);

  // The whole point: ONE `some`, holding BOTH conditions. Split across two
  // clauses this matches a member with a live open-ended plan and a separate
  // dead row that happens to carry a date — not a renewal conversation.
  check(
    "status and endDate live inside the SAME some (not split across clauses)",
    !!some && some.status === "active" && !!some.endDate,
    some ? `keys: ${Object.keys(some).join(", ")}` : "no some",
  );
  check(
    "nothing leaks to the Member level",
    !("endDate" in (clause as Record<string, unknown>)) &&
      !("status" in (clause as Record<string, unknown>)),
  );

  const range = (some?.endDate ?? {}) as { gte?: Date; lte?: Date };
  check(
    "window opens at now — an already-past end date is an expiry to sweep, not a renewal to sell",
    range.gte instanceof Date && range.gte.getTime() === now.getTime(),
    String(range.gte),
  );
  check(
    `window closes at exactly ENDING_SOON_WINDOW_DAYS (${ENDING_SOON_WINDOW_DAYS}) days out`,
    range.lte instanceof Date &&
      range.lte.getTime() === now.getTime() + ENDING_SOON_WINDOW_DAYS * DAY,
    String(range.lte),
  );

  // Time-relative predicates must be computed per call. A module-level constant
  // would freeze the window at the moment the server booted — the same reason
  // queueClauses is a function and not an object.
  const later = new Date(now.getTime() + 10 * DAY);
  const clauseLater = queueClauses(later).endingSoon as {
    subscriptions: { some: { endDate: { gte: Date } } };
  };
  check(
    "window moves with `now` (not frozen at module load)",
    clauseLater.subscriptions.some.endDate.gte.getTime() === later.getTime(),
  );
}

// ── 2. The window actually admits and rejects the right dates ───────────────
console.log("\nendingSoon window boundaries:");
{
  const now = new Date("2026-08-16T00:00:00.000Z");
  const { gte, lte } = (
    queueClauses(now).endingSoon as {
      subscriptions: { some: { endDate: { gte: Date; lte: Date } } };
    }
  ).subscriptions.some.endDate;
  const admits = (iso: string) => {
    const d = new Date(iso).getTime();
    return d >= gte.getTime() && d <= lte.getTime();
  };

  // The eight ending memberships, as their endDate was STORED on 2026-08-16.
  // Skylor's row said 2026-10-26 then; Stripe's real 2026-08-27 only lands in
  // the row once F1's write-back runs, so both dates are checked.
  const STORED = [
    "2026-09-11", // Mack Munroe
    "2026-09-16", // Hunter Meyer
    "2026-09-16", // Sawyer Mayhew
    "2026-09-18", // Levi Schanzenbach
    "2026-10-26", // Skylor Day — stale; Stripe says 2026-08-27
    "2026-10-30", // Joseph Bower
    "2026-11-18", // André Serra
    "2026-11-23", // Orson Chorba
  ];

  check("admits every one of the eight as stored", STORED.every((d) => admits(`${d}T00:00:00Z`)));
  check(
    "admits Orson Chorba at 99 days — the furthest of the eight, and outside a 90-day window",
    admits("2026-11-23T00:00:00Z"),
  );
  check("admits Skylor's corrected Stripe end (2026-08-27)", admits("2026-08-27T00:00:00Z"));
  check("rejects a date already past (2026-08-15)", !admits("2026-08-15T00:00:00Z"));
  check("rejects beyond the window (2027-07-14 — Titus)", !admits("2027-07-14T00:00:00Z"));
  check(
    "the old 14-day window would have admitted NONE of the eight as stored",
    !STORED.some((d) => new Date(d).getTime() <= now.getTime() + 14 * DAY),
  );
}

// ── 3. Severity thresholds ──────────────────────────────────────────────────
console.log("\nrenewalSeverity thresholds:");
{
  check("ends today → high", renewalSeverity(0) === "high");
  check("14 days → high (inclusive boundary)", renewalSeverity(14) === "high");
  check("15 days → medium", renewalSeverity(15) === "medium");
  check("45 days → medium (inclusive boundary)", renewalSeverity(45) === "medium");
  check("46 days → low", renewalSeverity(46) === "low");
  check("90 days → low", renewalSeverity(90) === "low");
  check(
    "every day inside the window resolves to a severity",
    Array.from({ length: ENDING_SOON_WINDOW_DAYS + 1 }, (_, i) => renewalSeverity(i)).every((s) =>
      ["high", "medium", "low"].includes(s),
    ),
  );
}

// ── 4. Link guard — every /dashboard/members?… link must actually filter ────
console.log("\nlink guard (/dashboard/members?… must parse to a real filter):");
{
  const DEFAULTS = parseMemberFilters(new URL("http://x/dashboard/members"));
  /** Which fields a link changed, compared to opening the roster with no query. */
  function changedBy(qs: string): string[] {
    const f = parseMemberFilters(new URL(`http://x/dashboard/members${qs}`));
    return (Object.keys(DEFAULTS) as (keyof MemberListFilters)[]).filter(
      (k) => f[k] !== DEFAULTS[k],
    );
  }

  // Self-check: prove the guard can tell a live parameter from a dead one,
  // using the exact string that shipped broken.
  check("guard detects the dead link that shipped (?filter=expiring)", changedBy("?filter=expiring").length === 0);
  check("guard accepts the replacement (?queue=endingSoon)", changedBy("?queue=endingSoon").includes("queue"));

  check(
    "every declared filter key genuinely changes the parsed filter",
    MEMBER_FILTER_PARAM_KEYS.every((k) => changedBy(`?${k}=2`).length > 0),
    MEMBER_FILTER_PARAM_KEYS.filter((k) => changedBy(`?${k}=2`).length === 0).join(", "),
  );

  // Now sweep the codebase.
  const roots = ["lib", "app", "components"];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        files.push(full);
      }
    }
  };
  for (const r of roots) {
    const dir = path.join(WEB, r);
    if (fs.existsSync(dir)) walk(dir);
  }

  const known = new Set<string>([...MEMBER_FILTER_PARAM_KEYS, ...MEMBER_NON_FILTER_PARAM_KEYS]);
  // Only static links — a template literal with an interpolation cannot be
  // checked here and is out of scope for this guard.
  const LINK = /["'`](\/dashboard\/members\?[^"'`${}\s]*)["'`]/g;
  const dead: string[] = [];
  let found = 0;
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(LINK)) {
      found++;
      const params = new URL(`http://x${m[1]}`).searchParams;
      const unknown = [...params.keys()].filter((k) => !known.has(k));
      if (unknown.length > 0) {
        dead.push(`${path.relative(WEB, file)} → ${m[1]} (unknown: ${unknown.join(", ")})`);
      }
    }
  }
  console.log(`  (scanned ${files.length} files, found ${found} static members links)`);
  check(
    "no static /dashboard/members link carries a parameter the roster does not read",
    dead.length === 0,
    dead.join("; "),
  );
}

// ── 5. The card and the queue read the same window ──────────────────────────
console.log("\ncard ↔ queue agreement:");
{
  const src = fs.readFileSync(path.join(WEB, "lib/reportsActionItems.ts"), "utf8");
  check(
    "the EXPIRING_MEMBERSHIP probe imports the window rather than restating it",
    src.includes("ENDING_SOON_WINDOW_DAYS") && !/lte:\s*in\d+d[\s\S]{0,40}90\s*\*/.test(src),
  );
  check(
    "the probe links to the endingSoon queue",
    src.includes("/dashboard/members?queue=endingSoon"),
  );
  // `filter` is not a parameter ANY dashboard page parses. It appeared on five
  // separate Action Item links — EXPIRING_MEMBERSHIP, UPCOMING_RENEWAL_LARGE,
  // OFFLINE_PAYMENT_PENDING and UNCATEGORIZED_LARGE_BANK — all shipped in
  // 2.5.1a, all silent. This is the narrow pin for that exact mistake; the
  // vocabulary guard above is the broad one, but it only covers members links
  // because members is the only roster with a declared parameter list.
  check(
    "no href in the probe file uses the dead ?filter= parameter",
    !/href:\s*["'`][^"'`]*[?&]filter=/.test(src),
  );
  check(
    "no href in the probe file deep-links Financials, which parses no query params",
    !/href:\s*["'`]\/dashboard\/financials\?/.test(src),
  );
  check(
    "items are keyed per member so they can be snoozed individually",
    src.includes('itemId("EXPIRING_MEMBERSHIP", sub.member.id)'),
  );
}


// ── CLASS_MISSING_DROPIN_PRICE ──────────────────────────────────────────────
//
// Fires on nothing today — every active class is drop-in only — so the logic is
// the only thing there is to verify. It exists to make the mistake visible the
// first time somebody makes it.
console.log("\ncannotChargeOutsidePlanDays:");
{
  const mem = { type: "membership", membershipId: "m1" };
  const cannot = cannotChargeOutsidePlanDays;

  check(
    "accepts a membership, no drop-in and no non-member → flagged",
    cannot([mem]) === true,
  );
  check(
    "every real Frog Empire class today (membership + $25 drop-in) → NOT flagged",
    cannot([{ type: "dropin", price: 25 }, mem]) === false,
  );
  check(
    "a non-member price is an acceptable fallback too",
    cannot([{ type: "nonmember", price: 30 }, mem]) === false,
  );
  check(
    "a class that accepts NO membership is not this problem",
    cannot([{ type: "dropin", price: 25 }]) === false,
  );
  check(
    "  …even with no prices at all — nothing to fall FROM",
    cannot([]) === false,
  );
  check(
    "a $0 drop-in is NOT a fallback — free is what they already get",
    cannot([{ type: "dropin", price: 0 }, mem]) === true,
  );
  check(
    "a member price is not a fallback — they are not entitled that day",
    cannot([{ type: "member", price: 20 }, mem]) === true,
  );
  check("null pricingOptions never throws", cannot(null) === false);
  check("a non-array never throws", cannot({ type: "dropin" }) === false);
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFailures:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
