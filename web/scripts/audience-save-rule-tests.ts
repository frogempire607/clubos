/**
 * An audience with a status rule and no status picked cannot be saved.
 *
 *   npx tsx scripts/audience-save-rule-tests.ts
 *
 * Decision 2026-11-18: left blank, a "Member status" rule constrains nothing,
 * so the audience would mean "everyone" — and an audience is what an email is
 * sent to. Saving one is refused with a plain message. Audiences already saved
 * that way are untouched and keep working. No database, no network.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STATUS_RULE_MESSAGE, audienceSaveProblem, blankStatusRuleCount, isBlankStatusRule } from "../lib/audienceRules";

const code = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : `  — ${detail}`}`);
}
const status = (value: unknown) => ({ field: "membershipStatus", op: "in", value });

console.log("\n§1 what counts as \"no status picked\"");
for (const [label, v] of [['""', ""], ['[""]', [""]], ["[]", []], ["null", null], ["undefined", undefined], ['"   "', "   "], ['["", " "]', ["", " "]]] as const) {
  check(`${label} is blank`, isBlankStatusRule(status(v)));
}
check('"ACTIVE" is not blank', !isBlankStatusRule(status("ACTIVE")));
check('["ACTIVE", ""] is not blank — one status is picked', !isBlankStatusRule(status(["ACTIVE", ""])));
check("a blank value on a different rule is not this rule's business", !isBlankStatusRule({ field: "tag", value: "" }));

console.log("\n§2 saving");
check("a new audience with a blank status rule is refused", audienceSaveProblem({ match: "ALL", rules: [status("")] }) === STATUS_RULE_MESSAGE);
check("…even alongside good rules", audienceSaveProblem({ match: "ALL", rules: [{ field: "isMinor", op: "true" }, status([""])] }) === STATUS_RULE_MESSAGE);
check("a status rule with a status saves", audienceSaveProblem({ match: "ALL", rules: [status(["ACTIVE"])] }) === null);
check("an audience with no status rule saves", audienceSaveProblem({ match: "ANY", rules: [{ field: "isMinor", op: "true" }] }) === null);
check("an audience with no rules at all saves, as before", audienceSaveProblem({ match: "ALL", rules: [] }) === null);
check("the message is plain and says what to do", /Pick a status/.test(STATUS_RULE_MESSAGE) && /remove that rule/.test(STATUS_RULE_MESSAGE) && !/400|invalid|enum|null/i.test(STATUS_RULE_MESSAGE));
check("two blank rules are counted as two", blankStatusRuleCount({ rules: [status(""), status([]), status("PAUSED")] }) === 2);

console.log("\n§3 audiences already saved with a blank status rule keep working");
const old = { match: "ALL", rules: [status([""]), { field: "tag", op: "eq", value: "travel-team" }] };
check("renaming or archiving one (rules sent back unchanged) is allowed", audienceSaveProblem(JSON.parse(JSON.stringify(old)), old) === null);
check("changing its other rules means fixing the blank one first", audienceSaveProblem({ match: "ALL", rules: [status([""]), { field: "tag", op: "eq", value: "varsity" }] }, old) === STATUS_RULE_MESSAGE);
check("switching it from ALL to ANY counts as a change", audienceSaveProblem({ ...old, match: "ANY" }, old) === STATUS_RULE_MESSAGE);
check("fixing the blank rule saves", audienceSaveProblem({ match: "ALL", rules: [status(["ACTIVE"]), old.rules[1]] }, old) === null);
const filters = code("lib/audienceFilters.ts");
check("how a stored blank rule is READ is unchanged (still no constraint)", /if \(arr\.length === 0\) return \{\};/.test(filters));

console.log("\n§4 where it is enforced");
const post = code("app/api/marketing-audiences/route.ts");
const patch = code("app/api/marketing-audiences/[id]/route.ts");
check("create refuses with 400 before anything is evaluated or written", post.indexOf("audienceSaveProblem(filter)") > 0 && post.indexOf("audienceSaveProblem(filter)") < post.indexOf("evaluateAudience(session.user.clubId, filter)") && post.indexOf("audienceSaveProblem(filter)") < post.indexOf("marketingAudience.create"));
check("edit refuses only when rules were sent, compared with what is stored", /if \(data\.filters !== undefined\) \{\s*const problem = audienceSaveProblem\(filter, existing\.filters/.test(patch));
check("both answer with the same code", /STATUS_RULE_INCOMPLETE/.test(post) && /STATUS_RULE_INCOMPLETE/.test(patch));
const page = code("app/dashboard/communication/audiences/page.tsx");
check("the editor says it before sending, in the same words", /audienceSaveProblem\(filterSnapshot, audience\?\.filters \?\? null\)/.test(page));
check("the check is importable in the browser (no database in lib/audienceRules.ts)", !/prisma|@prisma\/client/.test(code("lib/audienceRules.ts").replace(/^\/\/.*$/gm, "")));
check("the preview is NOT refused — it shows the count while a rule is being built", !/audienceSaveProblem/.test(code("app/api/marketing-audiences/preview/route.ts")));

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
