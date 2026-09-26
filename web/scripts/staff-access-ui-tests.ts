/**
 * B21 — pure helpers behind the staff profile's Access, Pay and Lessons tabs.
 *
 *   npm run test:staff-access-ui
 *
 * No database, no network, no React.
 */
import {
  levelTone, TONE_STYLE, LEVEL_LABEL, accessDraftFromStaff, areaChanged, isAccessDirty,
  accessPayload, advancedOpen, hasAdvanced, levelSummary, toAccessState,
} from "../components/staff/access/accessModel";
import {
  BONUS_TYPES, BONUS_META, BONUS_SCOPES, bonusIndexes, setBonusTypeOn, payChangeCount, planSummaryLines, emptyBonus,
} from "../components/staff/pay/payModel";
import { lessonMeta, nextEligible, offeredViaPriceOption, openToAnyStaff } from "../components/staff/pay/lessonModel";
import { DEFAULT_PERMISSIONS, PERMISSION_CATALOG, MESSAGES_SUBSCOPES, DEFAULT_MESSAGES_SUBSCOPES } from "../lib/permissions";
import { describeAccessChanges } from "../lib/staffAccess";
import { compDraftFromPlan, compPayload, type CompDraft } from "../lib/staffCompensationDraft";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL ${name}`, detail ?? "");
  }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ── Access ──────────────────────────────────────────────────────────────────
check("send shares the edit tone", levelTone("send") === "edit");
check("edit tone", levelTone("edit") === "edit");
check("full/view/none tones", levelTone("full") === "full" && levelTone("view") === "view" && levelTone("none") === "none");
check("tones use tokens, not hex", Object.values(TONE_STYLE).every((s) => s.background.startsWith("var(") && s.color.startsWith("var(")));
check("edit tone uses the edit token pair", TONE_STYLE.edit.background === "var(--color-edit-surface)");
check("every catalog level has a label", PERMISSION_CATALOG.every((a) => a.levels.every((l) => !!LEVEL_LABEL[l])));

const staff = { permissions: { ...DEFAULT_PERMISSIONS }, messagesSubScopes: null, billingSubScopes: null };
const saved = accessDraftFromStaff(staff);
check("unset messages sub-scopes resolve to the guard defaults", eq(saved.messages, DEFAULT_MESSAGES_SUBSCOPES));
check("unset billing sub-scope resolves off", saved.billing.transfer_subscription === false);
check("draft has every catalog area", PERMISSION_CATALOG.every((a) => saved.levels[a.key] === DEFAULT_PERMISSIONS[a.key]));
check("a fresh draft is clean", !isAccessDirty(saved, accessDraftFromStaff(staff)));

const stored = accessDraftFromStaff({ ...staff, messagesSubScopes: { bulk: true }, billingSubScopes: { transfer_subscription: true } });
check("stored sub-scope true is kept", stored.messages.bulk === true && stored.billing.transfer_subscription === true);
check("unstored keys still default", stored.messages.templates === true && stored.messages.marketing === false);

const lv = { ...saved, levels: { ...saved.levels, billing: "full" as const } };
check("level change marks the area", areaChanged(saved, lv, "billing"));
check("level change leaves other areas alone", !areaChanged(saved, lv, "members"));
check("level change is dirty", isAccessDirty(saved, lv));
const back = { ...lv, levels: { ...lv.levels, billing: saved.levels.billing } };
check("changing back is clean again", !isAccessDirty(saved, back));

const sub = { ...saved, messages: { ...saved.messages, bulk: true } };
check("sub-scope change marks Messaging", areaChanged(saved, sub, "messages"));
check("sub-scope change is dirty", isAccessDirty(saved, sub));
const bsub = { ...saved, billing: { transfer_subscription: true } };
check("billing sub-scope change marks Billing", areaChanged(saved, bsub, "billing"));

const payload = accessPayload(sub);
check("payload carries every level", PERMISSION_CATALOG.every((a) => payload[a.key] === sub.levels[a.key]));
check("payload always carries messages_subScopes", eq(payload.messages_subScopes, sub.messages));
check("payload always carries billing_subScopes", eq(payload.billing_subScopes, sub.billing));
check("payload map is a copy", payload.messages_subScopes !== sub.messages);
check("payload covers every messages sub-scope", MESSAGES_SUBSCOPES.every((s) => s in (payload.messages_subScopes as object)));

check("only Messaging and Billing have advanced options", PERMISSION_CATALOG.filter((a) => hasAdvanced(a.key)).map((a) => a.key).join() === "messages,billing");
check("advanced closed at none", !advancedOpen("messages", "none") && !advancedOpen("billing", "none"));
check("advanced open above none", advancedOpen("messages", "view") && advancedOpen("billing", "view"));
check("no advanced on Members", !advancedOpen("members", "full"));

check("summary counts defaults", levelSummary(saved.levels) === "Full in 1 area · edit in 1 · view in 5 · none in 4", levelSummary(saved.levels));
check("summary folds send into edit", levelSummary({ ...saved.levels, messages: "send", members: "edit" }).includes("edit in 2"));

const ch = describeAccessChanges("Sal", toAccessState(saved), toAccessState({ ...lv, messages: { ...lv.messages, bulk: true } }));
check("confirm lists level + sub-scope changes", ch.length === 2, ch);
check("billing change flagged as money", ch.some((c) => c.key === "billing" && c.money));
check("sentence names the person", ch.every((c) => c.sentence.startsWith("Sal ")));
check("unchanged draft gives no sentences", describeAccessChanges("Sal", toAccessState(saved), toAccessState(saved)).length === 0);
check("defaults on both sides give no spurious sub-scope sentence",
  describeAccessChanges("Sal", toAccessState(saved), toAccessState(accessDraftFromStaff(staff))).length === 0);

// ── Pay ─────────────────────────────────────────────────────────────────────
const plan: CompDraft = compDraftFromPlan({
  baseType: "SALARY", baseAmount: 1700, baseScopes: [],
  bonuses: [
    { bonusType: "SIGNUP", amount: 25, scopes: [], minThreshold: null, maxThreshold: null },
    { bonusType: "REVENUE_SHARE", amount: 20, scopes: [{ scopeType: "PRIVATE_LESSON_TYPE", scopeId: "lt1" }], minThreshold: 2, maxThreshold: 10 },
  ],
});
check("three bonus types", BONUS_TYPES.join() === "ATTENDANCE,SIGNUP,REVENUE_SHARE");
check("revenue share is a percent of the assigned scope", BONUS_META.REVENUE_SHARE.percent && /assigned scope/.test(BONUS_META.REVENUE_SHARE.desc));
check("revenue share can scope to every type", BONUS_SCOPES.REVENUE_SHARE.length === 4);
check("bonusIndexes finds the row", eq(bonusIndexes(plan, "SIGNUP"), [0]) && eq(bonusIndexes(plan, "ATTENDANCE"), []));

const onAtt = setBonusTypeOn(plan, "ATTENDANCE", true);
check("switch on adds one empty row", onAtt.bonuses.length === 3 && eq(onAtt.bonuses[2], emptyBonus("ATTENDANCE")));
check("switch on twice is a no-op", setBonusTypeOn(onAtt, "ATTENDANCE", true) === onAtt);
check("switch on does not mutate", plan.bonuses.length === 2);
check("empty new bonus is dropped on save (not a $0 bonus)", compPayload(onAtt).bonuses.length === 2);
const offSign = setBonusTypeOn(plan, "SIGNUP", false);
check("switch off removes every row of that type", bonusIndexes(offSign, "SIGNUP").length === 0 && offSign.bonuses.length === 1);
const two = { ...plan, bonuses: [...plan.bonuses, emptyBonus("SIGNUP")] };
check("switch off removes duplicates too", bonusIndexes(setBonusTypeOn(two, "SIGNUP", false), "SIGNUP").length === 0);
check("thresholds survive the switch view", offSign.bonuses[0].minThreshold === "2" && offSign.bonuses[0].maxThreshold === "10");

check("no change → 0", payChangeCount(plan, plan) === 0);
check("base amount → 1", payChangeCount(plan, { ...plan, baseAmount: "1800" }) === 1);
check("base type → 1", payChangeCount(plan, { ...plan, baseType: "HOURLY" }) === 1);
check("base + bonus → 2", payChangeCount(plan, { ...offSign, baseAmount: "1" }) === 2);
check("bonus scope change → 1", payChangeCount(plan, { ...plan, bonuses: plan.bonuses.map((b, i) => (i === 0 ? { ...b, scopes: [{ scopeType: "CLASS", scopeId: "c1" }] } : b)) }) === 1);

const lines = planSummaryLines(plan);
check("summary base line", lines[0] === "Salary · $1,700/mo", lines);
check("summary signup line", lines[1] === "Signup bonus · $25 per signup", lines);
check("summary revenue line", lines[2] === "Revenue share · 20% of revenue (1 selected)", lines);
check("summary skips empty bonus rows", planSummaryLines(onAtt).length === 3);
check("hourly summary", planSummaryLines({ ...plan, baseType: "HOURLY", baseAmount: "22.5", bonuses: [] })[0] === "Hourly · $22.50/hr");

// ── Lessons ─────────────────────────────────────────────────────────────────
check("meta with options", lessonMeta({ durationMin: 60, basePrice: "70", priceOptions: [{ id: "a", label: "x", price: 1 }, { id: "b", label: "y", price: 2 }, { id: "c", label: "z", price: 3 }] }) === "60 min · $70.00 · 3 options");
check("meta with one option", lessonMeta({ durationMin: 30, basePrice: 50, priceOptions: [{ id: "a", label: "x", price: 1 }] }) === "30 min · $50.00 · 1 option");
check("meta without options", lessonMeta({ durationMin: 45, basePrice: 0, priceOptions: null }) === "45 min · $0.00");
check("add coach", eq(nextEligible(["a"], "b", true), ["a", "b"]));
check("add coach is idempotent", eq(nextEligible(["a", "b"], "b", true), ["a", "b"]));
check("remove coach keeps others", eq(nextEligible(["a", "b", "c"], "b", false), ["a", "c"]));
check("remove from null", eq(nextEligible(null, "b", false), []));
check("price-option coach detected", offeredViaPriceOption({ priceOptions: [{ id: "o", label: "x", price: 1, coachIds: ["b"] }] }, "b"));
check("no price options", !offeredViaPriceOption({ priceOptions: undefined }, "b"));
check("empty list = open to any staff", openToAnyStaff({ eligibleCoachIds: [] }) && openToAnyStaff({ eligibleCoachIds: null }));
check("named list is not open", !openToAnyStaff({ eligibleCoachIds: ["a"] }));

console.log(`staff-access-ui: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
