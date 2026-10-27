#!/usr/bin/env node
// B25 (2026-09-28) — the ONE list of checks that gate `npm run build`.
//
// Why this exists: for weeks the sport-terms guard was believed to gate the
// build and never ran in it; a wrestling-only email template reached every
// club. Only 4 of 45 test scripts were in the build line, and 21 test files
// were run by nothing at all. So:
//   1. Every test file under scripts/ must be listed below — GATED (runs on
//      every build) or MANUAL (with the reason it can't). A new test file that
//      isn't listed fails the build, so nothing can silently drop out again.
//   2. Tests run with DATABASE_URL pointed at a dead address. None of them
//      needs a database; if one ever starts querying, it fails loudly here
//      instead of reading production during a deploy.
//   3. They run in parallel (4 at a time) so the whole set adds seconds, not
//      a minute, to each build.
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RENDER = ["--tsconfig", "scripts/tsconfig.render.json"];

// [file, extra tsx args, extra env]
export const GATED = [
  // guards
  ["scripts/sport-terms-guard.ts"],
  // pricing overhaul (2026-10-18): gross-up math + 1.4% platform floor + tier gates
  ["scripts/fee-math-tests.ts"],
  ["scripts/tier-gating-guard.ts"],
  ["scripts/subscription-truth-guard.ts"],
  ["scripts/permission-boundary-guard.ts"],
  ["scripts/members-grep-guards.ts"],
  ["scripts/reports-mobile-guard.ts", [], { TZ: "America/New_York" }],
  ["scripts/ui-polish-guard.ts"],
  ["scripts/tx-swallow-guard.ts"],
  // members & families
  ["scripts/family-accounts-tests.ts"],
  ["scripts/family-fixtures-tests.ts"],
  ["scripts/family-scope-tests.ts"],
  ["scripts/member-tracks-tests.ts"],
  ["scripts/member-ui-tests.ts", RENDER],
  ["scripts/member-duplicates-tests.ts"],
  ["scripts/member-deletion-tests.ts"],
  ["scripts/members-list-b6-tests.ts"],
  ["scripts/member-profile-b6-tests.ts"],
  ["scripts/migration-b6-tests.ts"],
  ["scripts/renewal-surfacing-tests.ts"],
  ["scripts/signup-intent-tests.ts"],
  ["scripts/parental-gate-tests.ts"],
  ["scripts/import-integrity-tests.ts"],
  // memberships & billing
  ["scripts/membership-options-tests.ts"],
  ["scripts/option-facts-tests.ts"],
  ["scripts/entitlements-tests.ts"],
  ["scripts/accepted-plans-tests.ts"],
  ["scripts/membership-panel-tests.ts"],
  ["scripts/membership-money-tests.ts"],
  ["scripts/membership-sibling-tests.ts"],
  ["scripts/membership-group-rate-tests.ts"],
  ["scripts/assign-discount-tests.ts"],
  ["scripts/charge-date-tests.ts"],
  ["scripts/membership-audit-tests.ts"],
  ["scripts/billing-admin-tests.ts"],
  ["scripts/billing-anchor-tests.ts"],
  ["scripts/bulk-price-change-tests.ts"],
  ["scripts/stripe-plan-change-tests.ts"],
  ["scripts/stripe-truth-tests.ts"],
  ["scripts/billing-data-tests.ts"],
  ["scripts/non-renewal-tests.ts"],
  ["scripts/billing-retire-tests.ts"],
  ["scripts/invoice-period-tests.ts"],
  ["scripts/bank-reconciliation-tests.ts"],
  // accounting Phase 1 (2026-10-20): double-entry rules, chart template,
  // category mapping, tier gate, and the source guarantees (one write path,
  // every query club-scoped, RLS in the migration).
  ["scripts/ledger-tests.ts"],
  // accounting Phase 2 (2026-10-21): what each kind of money posts, the
  // double-count guard, reconciliation arithmetic, and the source guarantees
  // (one write path, immutable keys, FK-aware RLS, every route gated).
  ["scripts/gl-posting-tests.ts"],
  // accounting Phase 3 (2026-10-22): the statements. A trial balance whose
  // debits equal its credits, a balance sheet that balances as of EVERY date
  // in the fixture, and a cash flow statement that ties to the actual movement
  // in the cash accounts for every month — all to the cent, because integer
  // cents make an exact check possible and a tolerance check would hide the
  // drift these tests exist to catch.
  ["scripts/gl-reports-tests.ts"],
  // Phase 12.1 Part 1 (2026-10-27): server-renders every Books → Reports view.
  // Four of the five crashed in production because the statement on screen and
  // the payload in state were separate pieces of state, so a view could be
  // handed another report's data for one render. RENDER tests, so it needs the
  // react-jsx tsconfig override.
  ["scripts/gl-reports-ui-tests.ts", RENDER],
  // accounting Phase 3 (2026-10-22): depreciation schedules that total exactly
  // cost less salvage over 600+ parameter combinations, a disposal that
  // balances at every combination of proceeds and accumulated depreciation,
  // and a reopen that restores the PREVIOUS lock date rather than unlocking
  // the year.
  ["scripts/gl-close-tests.ts"],
  // accounting Phase 3 (2026-10-22): the 1099 threshold report. §1 is a
  // STANDING GUARD that no tax-identification field exists anywhere in the
  // schema without field-level encryption to protect it — the repo has no
  // encryption, so no TIN was stored, and this fails the build if one
  // appears without it.
  ["scripts/form1099-tests.ts"],
  // Phase 12.1 Part 2 (2026-10-27): AES-256-GCM field encryption and the
  // W-9. §1 proves there is NO plaintext path; §6 is the build guard that a
  // tax-id field may only exist while the encryption protecting it exists,
  // is the only way it is written, and is read in exactly one audited place.
  ["scripts/field-crypto-tests.ts"],
  // accounting Phase 3 (2026-10-22): the QuickBooks opening balance and the
  // read-only history archive. §6 greps the reports and posting modules to
  // prove the archive never feeds a report, a balance or a posting — the
  // whole promise it makes, and a property of the source tree rather than
  // of any one function.
  ["scripts/gl-opening-tests.ts"],
  // attendance, classes, front desk
  ["scripts/attendance-billing-tests.ts", RENDER],
  ["scripts/class-session-reconcile-tests.ts"],
  ["scripts/class-time-tests.ts"],
  ["scripts/client-bundle-guard.ts"],
  ["scripts/class-staff-tests.ts"],
  ["scripts/class-staff-ui-tests.ts"],
  ["scripts/class-staff-server-tests.ts"],
  ["scripts/class-topup-tests.ts"],
  ["scripts/class-staffing-api-tests.ts"],
  ["scripts/door-access-tests.ts"],
  ["scripts/app-links-tests.ts"],
  // events
  ["scripts/event-attendees-tests.ts"],
  ["scripts/event-attendees-actions-tests.ts"],
  ["scripts/event-attendees-extras-tests.ts"],
  ["scripts/event-pricing-model-tests.ts"],
  ["scripts/event-roster-tests.ts"],
  ["scripts/event-auto-discount-tests.ts"],
  ["scripts/event-confirmation-state-tests.ts"],
  ["scripts/event-payment-tests.ts"],
  ["scripts/registration-money-tests.ts"],
  ["scripts/registration-match-tests.ts"],
  ["scripts/event-repricing-tests.ts"],
  ["scripts/event-comp-tests.ts"],
  ["scripts/event-links-tests.ts"],
  ["scripts/event-share-link-tests.ts"],
  // products
  ["scripts/product-settings-tests.ts"],
  ["scripts/product-booking-tests.ts"],
  ["scripts/product-bulk-pricing-tests.ts"],
  // staff & pay
  ["scripts/staff-compensation-draft-tests.ts"],
  ["scripts/staff-profile-tests.ts"],
  ["scripts/staff-access-ui-tests.ts"],
  ["scripts/staff-schedule-fit-tests.ts"],
  ["scripts/staff-assignments-tests.ts"],
  ["scripts/pay-schedule-tests.ts"],
  ["scripts/pay-ledger-tests.ts"],
  // Run TWICE, in two zones. payrollRange() used to mix a UTC-parsed date with
  // local-time setters, which lost the payroll range's final day in any
  // negative-offset zone (B37). It now composes the range in UTC explicitly, so
  // the suite is zone-independent — and these two runs are what keeps it that
  // way. A regression fails the build instead of waiting to be noticed on
  // somebody's laptop. Netlify itself runs UTC.
  ["scripts/pay-ledger-server-tests.ts", [], { TZ: "UTC" }],
  ["scripts/pay-ledger-server-tests.ts", [], { TZ: "America/New_York" }],
  ["scripts/schedule-feeds-pay-tests.ts"],
  ["scripts/email-queue-tests.ts"],
  ["scripts/charge-timing-tests.ts"],
  ["scripts/retry-payment-tests.ts"],
  ["scripts/finance-entities-tests.ts"],
  ["scripts/permission-behaviour-tests.ts"],
  ["scripts/staff-authz-tests.ts"],
  // communication, reports, nav, platform
  ["scripts/email-drafts-tests.ts"],
  ["scripts/email-recipients-tests.ts"],
  ["scripts/email-results-tests.ts"],
  ["scripts/send-path-tests.ts"],
  ["scripts/personalization-catalog-tests.ts"],
  ["scripts/reports-tests.ts"],
  ["scripts/dashboard-nav-tests.ts"],
  ["scripts/production-hardening-tests.ts"],
  ["scripts/zod-errors-tests.ts"],
];

// Test files that deliberately do NOT run in the build, and why.
export const MANUAL = {
  "scripts/audience-filters-tests.ts": "needs the local throwaway Postgres on port 55432",
  "scripts/family-shapes-repair-tests.ts": "needs the local throwaway Postgres on port 55432",
  "scripts/signature-attribution-tests.ts": "needs the local throwaway Postgres on port 55432",
};

const isTestFile = (f) => /-(tests|guard|guards)\.ts$/.test(f);

function registryProblems() {
  const listed = new Set([...GATED.map((g) => g[0]), ...Object.keys(MANUAL)]);
  const onDisk = readdirSync(join(ROOT, "scripts")).filter(isTestFile).map((f) => `scripts/${f}`);
  const unlisted = onDisk.filter((f) => !listed.has(f));
  const missing = [...listed].filter((f) => !onDisk.includes(f));
  return { unlisted, missing };
}

function run([file, args = [], env = {}]) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tsx = process.env.TSX_BIN || join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
    const child = spawn(tsx, [...args, file], {
      cwd: ROOT,
      env: {
        ...process.env,
        // No test needs a database. A dead address makes any accidental
        // query fail here instead of reaching production during a deploy.
        DATABASE_URL: "postgresql://build-tests-no-db@127.0.0.1:1/none",
        DIRECT_URL: "postgresql://build-tests-no-db@127.0.0.1:1/none",
        ...env,
      },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ file, code, ms: Date.now() - started, out }));
  });
}

async function main() {
  const { unlisted, missing } = registryProblems();
  if (unlisted.length || missing.length) {
    if (unlisted.length) console.log(`✗ test files not in scripts/run-build-tests.mjs (add to GATED or MANUAL):\n  ${unlisted.join("\n  ")}`);
    if (missing.length) console.log(`✗ listed but not on disk:\n  ${missing.join("\n  ")}`);
    process.exit(1);
  }
  const only = process.argv.slice(2);
  const queue = only.length ? GATED.filter((g) => only.some((o) => g[0].includes(o))) : [...GATED];
  const results = [];
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) results.push(await run(queue.shift()));
  });
  const t0 = Date.now();
  await Promise.all(workers);
  const failed = results.filter((r) => r.code !== 0);
  for (const r of results.sort((a, b) => a.file.localeCompare(b.file))) {
    console.log(`${r.code === 0 ? "  ✓" : "  ✗"} ${r.file.replace("scripts/", "")} (${r.ms}ms)`);
  }
  for (const r of failed) {
    console.log(`\n──── ${r.file} (exit ${r.code}) ────\n${r.out.split("\n").slice(-40).join("\n")}`);
  }
  console.log(
    `\n${failed.length ? "✗" : "✓"} ${results.length - failed.length}/${results.length} build checks passed in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
      ` · ${Object.keys(MANUAL).length} manual-only (need a local test database)`,
  );
  process.exit(failed.length ? 1 : 0);
}
main();
