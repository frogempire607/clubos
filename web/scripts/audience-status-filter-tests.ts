/**
 * The audience preview never answers 500 for a half-built status rule.
 *
 *   npx tsx scripts/audience-status-filter-tests.ts
 *
 * Production, 2026-11-17 23:53 UTC: POST /api/marketing-audiences/preview →
 * 500, "Invalid value for argument `in`. Expected MemberStatus." The builder
 * had sent `membershipStatus in [""]` — a rule added but not yet filled in.
 * Found by the crash audit (docs/CRASH-AUDIT-2026-11-18.md). No database: the
 * status rule is compiled to a query filter without running it.
 */
import { ruleToWhere, parseAudienceFilter } from "../lib/audienceFilters";

let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : `  — ${detail}`}`);
}
const STATUSES = ["ACTIVE", "PROSPECT", "INACTIVE", "PAUSED"];

async function where(value: unknown, op = "in") {
  const filter = parseAudienceFilter({ rules: [{ field: "membershipStatus", op, value }] });
  const rule = filter.rules[0] ?? { field: "membershipStatus", op, value };
  return (await ruleToWhere("club_x", rule as never, new Date())) as { status?: { in?: string[] } } | null;
}
const valid = (w: { status?: { in?: string[] } } | null) => (w?.status?.in ?? []).every((v) => STATUSES.includes(v));

async function main() {
  console.log("\nmembership status rule → query filter");
  const blank = await where([""]);
  check('the production case — [""] — compiles to a filter the database accepts', valid(blank), JSON.stringify(blank));
  check("…and constrains nothing, like a rule with no value yet", blank?.status?.in === undefined, JSON.stringify(blank));
  check('a bare "" does the same', (await where(""))?.status?.in === undefined);
  const mixed = await where(["ACTIVE", "", "PAUSED"]);
  check("blanks are dropped from a mixed list", JSON.stringify(mixed?.status?.in) === JSON.stringify(["ACTIVE", "PAUSED"]), JSON.stringify(mixed));
  check("lower case is accepted", JSON.stringify((await where(["active"]))?.status?.in) === JSON.stringify(["ACTIVE"]));
  const bogus = await where(["NOT_A_STATUS"]);
  check("something that is not a status matches NOBODY (never everybody)", Array.isArray(bogus?.status?.in) && bogus!.status!.in!.length === 0, JSON.stringify(bogus));
  for (const s of STATUSES) check(`${s} passes through unchanged`, JSON.stringify((await where([s]))?.status?.in) === JSON.stringify([s]));
  console.log(failed ? `\n${failed} FAILED` : "\nall passed");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
