// Rules an audience must meet before it can be SAVED.
//
// PURE — no database import — so the editor in the browser and the routes on
// the server apply the same check with the same words.
//
// Decision 2026-11-18 (Julian, after the crash audit): an audience with a
// "Member status" rule and no status picked is refused on save. Left blank,
// that rule constrains nothing (lib/audienceFilters.ts), so an audience that
// reads as "members with status …" would quietly mean "everyone" — and an
// audience is what an email is sent to.
//
// Audiences ALREADY saved with a blank status rule are not touched and keep
// evaluating exactly as before: this is a check on what is being saved now,
// not a change to how a stored filter is read.

export const STATUS_RULE_INCOMPLETE = "STATUS_RULE_INCOMPLETE";
export const STATUS_RULE_MESSAGE = "Pick a status for the “Member status” rule, or remove that rule, then save.";

type RuleLike = { field?: unknown; value?: unknown };

/** True when this rule is a member-status rule with nothing picked. */
export function isBlankStatusRule(rule: RuleLike): boolean {
  if (rule.field !== "membershipStatus") return false;
  const values = Array.isArray(rule.value) ? rule.value : rule.value == null ? [] : [rule.value];
  return values.map((v) => String(v).trim()).filter((v) => v !== "").length === 0;
}

/** How many member-status rules in this filter have nothing picked. */
export function blankStatusRuleCount(filter: { rules?: unknown } | null | undefined): number {
  const rules = filter && Array.isArray(filter.rules) ? (filter.rules as RuleLike[]) : [];
  return rules.filter((r) => r && typeof r === "object" && isBlankStatusRule(r)).length;
}

/**
 * The message to show, or null when the filter may be saved.
 *
 * `stored` is what is already saved for this audience (when editing). If the
 * filter being saved is identical to it, the save is allowed: renaming or
 * archiving an older audience that already has a blank status rule must keep
 * working. Changing its rules means fixing the blank one first.
 */
export function audienceSaveProblem(filter: { match?: unknown; rules?: unknown }, stored?: { match?: unknown; rules?: unknown } | null): string | null {
  if (blankStatusRuleCount(filter) === 0) return null;
  if (stored && sameRules(filter, stored)) return null;
  return STATUS_RULE_MESSAGE;
}

function sameRules(a: { match?: unknown; rules?: unknown }, b: { match?: unknown; rules?: unknown }): boolean {
  const norm = (f: { match?: unknown; rules?: unknown }) =>
    JSON.stringify({
      match: f.match === "ANY" ? "ANY" : "ALL",
      rules: (Array.isArray(f.rules) ? f.rules : []).map((r) => {
        const rr = (r ?? {}) as Record<string, unknown>;
        return { field: rr.field ?? null, op: rr.op ?? "eq", value: rr.value ?? null };
      }),
    });
  return norm(a) === norm(b);
}
