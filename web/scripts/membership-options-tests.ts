/**
 * Tests for lib/membershipOptions.ts — the one model for what a plan sells.
 *
 * No database, no Stripe. Run:  npm run test:membership-options
 *
 * The fixtures are Frog Empire's real plans as stored on 2026-08-16, because
 * the shapes that matter here are the awkward ones: two options sharing a
 * billing period, a renamed option, a plan-level contractMonths that has to
 * cover options wanting 3 and 12.
 */
import {
  BILLING_PERIODS,
  describeDays,
  describeOption,
  entitlementCoversWeekday,
  findDuplicateOptions,
  makeOption,
  mintOptionId,
  parseEntitlement,
  parseOptions,
  resolveSubscriptionOption,
  resolveTerms,
  serializeOptions,
  withMintedIds,
  type Entitlement,
  type MembershipOption,
} from "../lib/membershipOptions";

let pass = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
    return;
  }
  const d = detail === undefined ? "" : ` — ${JSON.stringify(detail)}`;
  failures.push(`${label}${d}`);
  console.log(`  ✗ ${label}${d}`);
}

// Exactly as stored in production: a JSON *string* inside a json column.
const MSHS =
  '[{"label":"Monthly Full Membership","price":175,"billingPeriod":"MONTHLY"},' +
  '{"label":"Monthly 2 days (Tue/Thu)","price":110,"billingPeriod":"MONTHLY"},' +
  '{"label":"3 months Upfront","price":450,"billingPeriod":"QUARTERLY"},' +
  '{"label":"1 year","price":1500,"billingPeriod":"ANNUAL"}]';

// ── Parsing ─────────────────────────────────────────────────────────────────
console.log("\nparseOptions:");
{
  const o = parseOptions(MSHS);
  check("parses the stored JSON string shape", o.length === 4);
  check("parses an already-parsed array too", parseOptions(JSON.parse(MSHS)).length === 4);
  check("empty string → []", parseOptions("").length === 0);
  check("malformed JSON → [] and never throws", parseOptions("{oops").length === 0);
  check("null → []", parseOptions(null).length === 0);
  check("non-array JSON → []", parseOptions('{"label":"x"}').length === 0);
  check(
    "drops entries missing label / period / price",
    parseOptions('[{"label":"X"},{"label":"Y","price":1,"billingPeriod":"MONTHLY"}]').length === 1,
  );
  check(
    "rejects a billingPeriod the app cannot schedule",
    parseOptions('[{"label":"X","price":1,"billingPeriod":"FORTNIGHTLY"}]').length === 0,
  );
  check("reads the right price", o[0].price === 175);

  // Every Phase 8 field defaults to "inherit", never to a value.
  check("id defaults to null on an un-migrated option", o[0].id === null);
  check("contractMonths defaults to null (inherit the plan)", o[0].contractMonths === null);
  check("autoRenewDefault defaults to null (inherit the plan)", o[0].autoRenewDefault === null);
  check("entitlement defaults to ALL", o[0].entitlement.kind === "ALL");
  check("requiredDocumentIds defaults to null", o[0].requiredDocumentIds === null);

  const rich = parseOptions(
    '[{"id":"opt_abc","label":"12 months","price":150,"billingPeriod":"MONTHLY",' +
      '"contractMonths":12,"autoRenewDefault":false,' +
      '"entitlement":{"kind":"DAYS","days":[2,4]},"requiredDocumentIds":["doc_1"]}]',
  );
  check("reads a fully-specified option", rich.length === 1);
  check("  id", rich[0].id === "opt_abc");
  check("  contractMonths", rich[0].contractMonths === 12);
  check("  autoRenewDefault false survives (not coerced to null)", rich[0].autoRenewDefault === false);
  check("  entitlement days", JSON.stringify(rich[0].entitlement) === '{"kind":"DAYS","days":[2,4]}');
  check("  requiredDocumentIds", JSON.stringify(rich[0].requiredDocumentIds) === '["doc_1"]');

  check(
    "a zero or negative contractMonths is not a term",
    parseOptions('[{"label":"X","price":1,"billingPeriod":"MONTHLY","contractMonths":0}]')[0]
      .contractMonths === null,
  );
}

// ── Entitlement parsing degrades toward MORE access ─────────────────────────
console.log("\nparseEntitlement (must fail open):");
{
  check("missing → ALL", parseEntitlement(undefined).kind === "ALL");
  check("null → ALL", parseEntitlement(null).kind === "ALL");
  check("unknown kind → ALL", parseEntitlement({ kind: "NONSENSE" }).kind === "ALL");
  check("DAYS with no days → ALL, not 'grants nothing'", parseEntitlement({ kind: "DAYS", days: [] }).kind === "ALL");
  check(
    "DAYS with only invalid days → ALL",
    parseEntitlement({ kind: "DAYS", days: [9, -1, "tue"] }).kind === "ALL",
  );
  const mixed = parseEntitlement({ kind: "DAYS", days: [4, 2, 2, 99] });
  check(
    "DAYS dedupes, sorts, and drops out-of-range",
    JSON.stringify(mixed) === '{"kind":"DAYS","days":[2,4]}',
    mixed,
  );
  check("COUNT is preserved when valid", JSON.stringify(parseEntitlement({ kind: "COUNT", perWeek: 2 })) === '{"kind":"COUNT","perWeek":2}');
  check("COUNT with a bad perWeek → ALL", parseEntitlement({ kind: "COUNT", perWeek: 0 }).kind === "ALL");
}

// ── Round-trip must not rewrite an untouched plan ───────────────────────────
console.log("\nserializeOptions:");
{
  const round = serializeOptions(parseOptions(MSHS));
  check("an untouched plan round-trips byte-identical", round === MSHS, round.slice(0, 60));
  check(
    "ALL entitlement is omitted rather than written out",
    !serializeOptions([makeOption({ label: "x", price: 1, billingPeriod: "MONTHLY" })]).includes("entitlement"),
  );
  const withDays = serializeOptions([
    makeOption({ label: "x", price: 1, billingPeriod: "MONTHLY", entitlement: { kind: "DAYS", days: [2, 4] } }),
  ]);
  check("a real entitlement IS written", withDays.includes('"entitlement":{"kind":"DAYS","days":[2,4]}'));
  check("null contractMonths is omitted", !withDays.includes("contractMonths"));
}

// ── Option identity ─────────────────────────────────────────────────────────
console.log("\noption ids:");
{
  let n = 0;
  const seq = () => ((n = (n + 0.137) % 1), n);
  const id = mintOptionId(seq);
  check("minted id is prefixed and opaque", /^opt_[a-z0-9]{10}$/.test(id), id);

  const minted = withMintedIds(parseOptions(MSHS), seq);
  check("every option gets an id", minted.every((o) => !!o.id));
  check("ids are unique within the plan", new Set(minted.map((o) => o.id)).size === 4);

  const keep = withMintedIds(
    [makeOption({ id: "opt_keepme", label: "a", price: 1, billingPeriod: "MONTHLY" }),
     makeOption({ label: "b", price: 2, billingPeriod: "MONTHLY" })],
    seq,
  );
  check("an existing id is never regenerated", keep[0].id === "opt_keepme");
  check("only the missing one is minted", !!keep[1].id && keep[1].id !== "opt_keepme");
}

// ── The duplicate guard ─────────────────────────────────────────────────────
console.log("\nfindDuplicateOptions:");
{
  check("MS/HS today has no duplicates", findDuplicateOptions(parseOptions(MSHS)).length === 0);
  check(
    "two MONTHLY options at DIFFERENT prices are fine — that is the whole point",
    findDuplicateOptions(parseOptions(MSHS)).length === 0 &&
      parseOptions(MSHS).filter((o) => o.billingPeriod === "MONTHLY").length === 2,
  );
  const dupe = findDuplicateOptions([
    makeOption({ label: "Monthly", price: 175, billingPeriod: "MONTHLY" }),
    makeOption({ label: "Monthly Full", price: 175, billingPeriod: "MONTHLY" }),
  ]);
  check("same period AND same price is refused", dupe.length === 1);
  check("  and names both offenders", JSON.stringify(dupe[0].labels) === '["Monthly","Monthly Full"]');
}

// ── Resolving which option a subscription is on ─────────────────────────────
console.log("\nresolveSubscriptionOption:");
{
  const opts = withMintedIds(parseOptions(MSHS), (() => { let n = 0; return () => ((n = (n + 0.211) % 1), n); })());
  const full = opts[0];

  const exact = resolveSubscriptionOption({ optionId: full.id, billingPeriod: "MONTHLY", price: 175 }, opts);
  check("optionId wins outright", exact.resolution === "exact" && exact.option?.label === "Monthly Full Membership");

  // Hunter Meyer: no optionId, $175 MONTHLY. Unique despite two MONTHLY options.
  const inferred = resolveSubscriptionOption({ optionId: null, billingPeriod: "MONTHLY", price: 175 }, opts);
  check("infers by (period, price) when unique", inferred.resolution === "inferred");
  check("  and it is the right option", inferred.option?.label === "Monthly Full Membership");

  // Kellan Lister: stored label "Upfront", option renamed to "3 months Upfront".
  const kellan = resolveSubscriptionOption({ optionId: null, billingPeriod: "QUARTERLY", price: 450 }, opts);
  check("a renamed option still resolves — labels are not identity", kellan.option?.label === "3 months Upfront");

  // Colton Waite: $530 on a MONTHLY row. Matches nothing on this plan.
  const colton = resolveSubscriptionOption({ optionId: null, billingPeriod: "MONTHLY", price: 530 }, opts);
  check("no match → unresolved, never a guess", colton.resolution === "unresolved");
  check(
    "  with a reason",
    colton.resolution === "unresolved" && colton.reason === "NO_MATCH",
  );

  const ambiguous = resolveSubscriptionOption({ optionId: null, billingPeriod: "MONTHLY", price: 99 }, [
    makeOption({ label: "A", price: 99, billingPeriod: "MONTHLY" }),
    makeOption({ label: "B", price: 99, billingPeriod: "MONTHLY" }),
  ]);
  check(
    "two candidates → unresolved, flagged AMBIGUOUS",
    ambiguous.resolution === "unresolved" && ambiguous.reason === "AMBIGUOUS",
  );

  const deleted = resolveSubscriptionOption({ optionId: "opt_gone", billingPeriod: "MONTHLY", price: 175 }, opts);
  check(
    "an optionId matching nothing does NOT silently fall back to inference",
    deleted.resolution === "unresolved",
  );

  check(
    "a missing billingPeriod cannot infer",
    resolveSubscriptionOption({ optionId: null, billingPeriod: null, price: 175 }, opts).resolution ===
      "unresolved",
  );
  check(
    "a Prisma Decimal-as-string price still infers",
    resolveSubscriptionOption({ optionId: null, billingPeriod: "MONTHLY", price: "175.00" }, opts)
      .resolution === "inferred",
  );
}

// ── Term inheritance ────────────────────────────────────────────────────────
console.log("\nresolveTerms:");
{
  const bare = makeOption({ label: "Monthly", price: 175, billingPeriod: "MONTHLY" });
  const t1 = resolveTerms(bare, { contractMonths: 1, autoRenewDefault: true });
  check("falls back to the plan's contractMonths", t1.contractMonths === 1);
  check("  and says so", t1.source.contractMonths === "plan");

  const twelve = makeOption({ label: "12 months", price: 150, billingPeriod: "MONTHLY", contractMonths: 12 });
  const t2 = resolveTerms(twelve, { contractMonths: 3, autoRenewDefault: true });
  check("the option's own term wins over the plan's", t2.contractMonths === 12);
  check("  and says so", t2.source.contractMonths === "option");

  check(
    "no option value and no plan value → no minimum",
    resolveTerms(bare, {}).contractMonths === null && resolveTerms(bare, {}).source.contractMonths === "none",
  );
  check(
    "autoRenewDefault false on the option is honoured, not treated as absent",
    resolveTerms(
      makeOption({ label: "x", price: 1, billingPeriod: "MONTHLY", autoRenewDefault: false }),
      { autoRenewDefault: true },
    ).autoRenewDefault === false,
  );
  check("autoRenew defaults to true when nothing says otherwise", resolveTerms(bare, {}).autoRenewDefault === true);

  // The exact shape the two-card workaround exists to express.
  const plan = { contractMonths: 1 };
  const six: MembershipOption[] = [
    makeOption({ label: "Monthly Full Membership", price: 175, billingPeriod: "MONTHLY" }),
    makeOption({ label: "Monthly 2 days (Tue/Thu)", price: 110, billingPeriod: "MONTHLY", entitlement: { kind: "DAYS", days: [2, 4] } }),
    makeOption({ label: "3 Months", price: 160, billingPeriod: "MONTHLY", contractMonths: 3 }),
    makeOption({ label: "12 months", price: 150, billingPeriod: "MONTHLY", contractMonths: 12 }),
    makeOption({ label: "3 months Upfront", price: 450, billingPeriod: "QUARTERLY", contractMonths: 3 }),
    makeOption({ label: "1 year", price: 1500, billingPeriod: "ANNUAL", contractMonths: 12 }),
  ];
  check("one card carries six options", six.length === 6);
  check("  four of them billed MONTHLY", six.filter((o) => o.billingPeriod === "MONTHLY").length === 4);
  check("  with no (period, price) collision", findDuplicateOptions(six).length === 0);
  const terms = six.map((o) => resolveTerms(o, plan).contractMonths);
  check("  and three distinct commitment lengths", JSON.stringify(terms) === "[1,1,3,12,3,12]", terms);
}

// ── The derived sentence ────────────────────────────────────────────────────
console.log("\ndescribeOption:");
{
  const d = (o: MembershipOption, plan = {}) => describeOption(o, plan);
  check(
    "monthly with a term",
    d(makeOption({ label: "3 Months", price: 160, billingPeriod: "MONTHLY", contractMonths: 3 })) ===
      "$160 per month for 3 months",
  );
  check(
    "quarterly does not restate its own period as a term",
    d(makeOption({ label: "3 months Upfront", price: 450, billingPeriod: "QUARTERLY", contractMonths: 3 })) ===
      "$450 every 3 months",
  );
  check(
    "annual likewise",
    d(makeOption({ label: "1 year", price: 1500, billingPeriod: "ANNUAL", contractMonths: 12 })) ===
      "$1500 per year",
  );
  check(
    "day-restricted, no minimum",
    d(makeOption({ label: "2 days", price: 110, billingPeriod: "MONTHLY", entitlement: { kind: "DAYS", days: [2, 4] } })) ===
      "$110 per month · Tue & Thu · no minimum",
  );
  check(
    "one-time never claims a minimum",
    d(makeOption({ label: "Drop-in", price: 25, billingPeriod: "ONE_TIME" })) === "$25 one-time",
  );
  check(
    "cents are shown when there are cents",
    d(makeOption({ label: "x", price: 180.08, billingPeriod: "MONTHLY", contractMonths: 1 })) ===
      "$180.08 per month for 1 month",
  );
  check("describeDays: one day", describeDays([4]) === "Thu");
  check("describeDays: two", describeDays([2, 4]) === "Tue & Thu");
  check("describeDays: three", describeDays([1, 2, 4]) === "Mon, Tue & Thu");
}

// ── Weekday coverage ────────────────────────────────────────────────────────
console.log("\nentitlementCoversWeekday:");
{
  const tueThu: Entitlement = { kind: "DAYS", days: [2, 4] };
  check("Tue/Thu covers Tuesday", entitlementCoversWeekday(tueThu, 2));
  check("Tue/Thu covers Thursday", entitlementCoversWeekday(tueThu, 4));
  check("Tue/Thu does NOT cover Monday", !entitlementCoversWeekday(tueThu, 1));
  check("Tue/Thu does NOT cover Sunday", !entitlementCoversWeekday(tueThu, 0));
  check("ALL covers every day", [0, 1, 2, 3, 4, 5, 6].every((d) => entitlementCoversWeekday({ kind: "ALL" }, d)));
  check(
    "COUNT is reserved and must never deny access",
    [0, 1, 2, 3, 4, 5, 6].every((d) => entitlementCoversWeekday({ kind: "COUNT", perWeek: 2 }, d)),
  );

  // Ms/HS Olympic Season runs Mon·Tue·Thu as ONE class. The $175 and $110
  // members attend the same class and differ only on Monday — which is why
  // entitlement is per-weekday and cannot be per-class.
  const classDays = [1, 2, 4];
  const fullCovers = classDays.filter((d) => entitlementCoversWeekday({ kind: "ALL" }, d));
  const twoDayCovers = classDays.filter((d) => entitlementCoversWeekday(tueThu, d));
  check("full member covers all three class days", JSON.stringify(fullCovers) === "[1,2,4]");
  check("two-day member covers exactly two of them", JSON.stringify(twoDayCovers) === "[2,4]");
}

// ── Guard: the billing-period vocabulary is shared ──────────────────────────
console.log("\nvocabulary:");
{
  check("every declared period parses", BILLING_PERIODS.every((p) =>
    parseOptions(`[{"label":"x","price":1,"billingPeriod":"${p}"}]`).length === 1));
  check("describeOption has a phrase for every period", BILLING_PERIODS.every((p) => {
    const s = describeOption(makeOption({ label: "x", price: 1, billingPeriod: p }));
    return s.length > 0 && !s.includes("undefined");
  }));
}

// ── The editor round-trip ───────────────────────────────────────────────────
// The memberships editor used to declare its own three-field option type and
// rebuild options from scratch on save, and both membership routes validated
// with a closed three-key z.object. Zod strips unknown keys, so a routine
// "Save" on a plan deleted every Phase 8 field — including `id`, the identity
// `member_subscriptions.optionId` resolves against. One owner edit would have
// undone the id mint and the subscription backfill.
//
// These pin the contract the editor and both routes now rely on: whatever the
// parser produced must survive being serialized straight back.
console.log("\neditor round-trip (preserves every field):");
{
  const stored = JSON.stringify([{
    id: "opt_7fK2mQ",
    label: "Upfront",
    price: 530,
    billingPeriod: "QUARTERLY",
    contractMonths: 12,
    autoRenewDefault: false,
    entitlement: { kind: "DAYS", days: [1, 3, 5] },
    requiredDocumentIds: ["doc_a"],
  }]);

  const roundTripped = parseOptions(serializeOptions(parseOptions(stored)));
  const o = roundTripped[0];
  check("id survives a parse → serialize → parse cycle", o?.id === "opt_7fK2mQ", o?.id);
  check("contractMonths survives", o?.contractMonths === 12, o?.contractMonths);
  check("autoRenewDefault survives, including an explicit false",
    o?.autoRenewDefault === false, o?.autoRenewDefault);
  check("entitlement survives", o?.entitlement.kind === "DAYS", o?.entitlement);
  check("requiredDocumentIds survive", o?.requiredDocumentIds?.[0] === "doc_a", o?.requiredDocumentIds);

  // The editor only renders label/price/billingPeriod. Editing one of those
  // must not disturb the fields it never shows.
  const edited = parseOptions(stored).map((opt) => ({ ...opt, price: 545 }));
  const afterSave = parseOptions(serializeOptions(edited))[0];
  check("editing the price keeps the option id", afterSave?.id === "opt_7fK2mQ", afterSave?.id);
  check("editing the price keeps contractMonths", afterSave?.contractMonths === 12, afterSave?.contractMonths);
  check("editing the price keeps the entitlement", afterSave?.entitlement.kind === "DAYS", afterSave?.entitlement);
  check("the price change itself lands", afterSave?.price === 545, afterSave?.price);

  // An untouched plan must not have its JSON rewritten (serializeOptions omits nulls).
  const plain = JSON.stringify([{ label: "Monthly", price: 190, billingPeriod: "MONTHLY" }]);
  check("a plan with no Phase 8 fields round-trips to byte-identical JSON",
    serializeOptions(parseOptions(plain)) === plain, serializeOptions(parseOptions(plain)));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFailures:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
