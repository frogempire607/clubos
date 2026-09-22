// Product settings — the typed v2 shape, the v1 free-text parser, the variant
// ledger and the storefront mapping. PURE, no database.
//
//   npx tsx scripts/product-settings-tests.ts

import {
  columnsForStorefronts,
  derivedInventory,
  expandVariants,
  normalizeProductSettings,
  parseAddOnLine,
  parseDurationLine,
  parseOptionGroupLine,
  parseTierLine,
  parseVariantStockLine,
  reconcileVariants,
  storefrontsFor,
  tierRange,
  variantLedger,
} from "../lib/productSettings";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};

console.log("\nLine parsers (the handoff's migration rules):");
eq("option group", parseOptionGroupLine("Size: Youth S, Youth M, Adult L"), { name: "Size", values: ["Youth S", "Youth M", "Adult L"] });
eq("option group with pipes", parseOptionGroupLine("Color: Black | White"), { name: "Color", values: ["Black", "White"] });
eq("option group without colon is ignored", parseOptionGroupLine("just words"), null);
eq("variant stock", parseVariantStockLine("Youth S / Black: 8"), { label: "Youth S / Black", stock: 8 });
eq("variant stock normalises spacing around the slash", parseVariantStockLine("Youth S/Black = 3"), { label: "Youth S / Black", stock: 3 });
eq("tier", parseTierLine("Basic: 60 minutes, $150"), { name: "Basic", includes: "", length: "60 minutes", price: 150 });
eq("tier with includes", parseTierLine("Premium: 120 minutes, pizza, 2 coaches, $300"), { name: "Premium", includes: "pizza, 2 coaches", length: "120 minutes", price: 300 });
eq("duration in minutes", parseDurationLine("30 minutes: $40"), { mins: 30, price: 40 });
eq("duration in hours", parseDurationLine("1.5 hours: $110"), { mins: 90, price: 110 });
eq("add-on flat", parseAddOnLine("Extra coach: $50"), { label: "Extra coach", price: 50, perGuest: false });
eq("add-on per guest", parseAddOnLine("Pizza (per guest): $12"), { label: "Pizza", price: 12, perGuest: true });

console.log("\nv1 → v2 upgrade:");
{
  const s = normalizeProductSettings({
    variantOptions: ["Size: S, M", "Color: Black, White"],
    variantStock: ["S / Black: 8", "M / Black: 10", "XL / Red: 2"],
    packageTiers: ["Basic: 60 minutes, $150", "Plus: 90 minutes, $225"],
    durationPrices: ["30 minutes: $40", "60 minutes: $75"],
    addOns: ["Extra 30 minutes: $75"],
    customQuestions: "Party theme\nAllergies?",
    lowStockAlertQuantity: "2",
    memberPrice: "20",
    depositMode: "DEPOSIT",
    depositAmount: 75,
  });
  eq("version stamped", s.v, 2);
  eq("option groups parsed", s.optionGroups.map((g) => g.name), ["Size", "Color"]);
  eq("matrix has 4 combos + 1 orphan stock row", s.variants.length, 5);
  eq("stock carried by label", s.variants.find((v) => v.id === "S / Black")?.stock, 8);
  eq("unlisted combo starts at 0", s.variants.find((v) => v.id === "S / White")?.stock, 0);
  eq("orphan stock note kept as its own row", s.variants.find((v) => v.id === "XL / Red")?.stock, 2);
  eq("tiers on when any parsed", [s.tiersEnabled, s.tiers.length], [true, 2]);
  eq("durations", s.durations, [{ mins: 30, price: 40 }, { mins: 60, price: 75 }]);
  eq("add-ons", s.addOns, [{ label: "Extra 30 minutes", price: 75, perGuest: false }]);
  eq("questions from free text", s.questions.map((q) => q.label), ["Party theme", "Allergies?"]);
  eq("scalars survive", [s.lowStockAlertQuantity, s.memberPrice, s.depositMode, s.depositAmount], [2, 20, "DEPOSIT", 75]);
  eq("idempotent on v2", normalizeProductSettings(s), s);
}
eq("absent settings → empty v2", normalizeProductSettings(null).v, 2);
eq("garbage settings → empty v2", normalizeProductSettings("nope").variants, []);

console.log("\nVariant matrix:");
eq("cartesian in group order", expandVariants([{ name: "Size", values: ["S", "M"] }, { name: "Color", values: ["Black"] }]), [["S", "Black"], ["M", "Black"]]);
eq("no groups → no variants", expandVariants([]), []);
{
  const before = reconcileVariants([{ name: "Size", values: ["S", "M"] }], []).map((v) => ({ ...v, stock: 5, sku: `SKU-${v.id}` }));
  const after = reconcileVariants([{ name: "Size", values: ["S", "M"] }, { name: "Color", values: ["Black"] }], before);
  eq("adding a group rebuilds ids AND keeps the old counted rows until they are zeroed (stock is never silently lost)", after.map((v) => v.id), ["S / Black", "M / Black", "S", "M"]);
  eq("…the new rows start at 0, the old rows keep their units", after.map((v) => v.stock), [0, 0, 5, 5]);
  const same = reconcileVariants([{ name: "Size", values: ["S", "M", "L"] }], before);
  eq("adding a value keeps existing stock", same.map((v) => v.stock), [5, 5, 0]);
  eq("…and existing sku", same[0].sku, "SKU-S");
  const dropped = reconcileVariants([{ name: "Size", values: ["S"] }], before);
  eq("removing a value keeps the orphan while it still holds units", dropped.map((v) => v.id), ["S", "M"]);
  const zeroed = reconcileVariants([{ name: "Size", values: ["S"] }], before.map((v) => (v.id === "M" ? { ...v, stock: 0 } : v)));
  eq("…and drops it once it is at 0", zeroed.map((v) => v.id), ["S"]);
}

console.log("\nLedger — one source for every stock number:");
{
  const s = normalizeProductSettings({ v: 2, optionGroups: [{ name: "Size", values: ["S", "M", "L"] }], variants: [
    { id: "S", label: "S", stock: 0 }, { id: "M", label: "M", stock: 2, price: 30 }, { id: "L", label: "L", stock: 10 },
  ], lowStockAlertQuantity: 3 });
  const l = variantLedger(s, { price: 25, trackInventory: true, inventory: 99 });
  eq("tracked via variants", l.tracked, true);
  eq("units = sum of variant stock (ignores the stale column)", l.units, 12);
  eq("retail value uses the variant price when set", l.retailValue, 2 * 30 + 10 * 25);
  eq("sold out / low counts", [l.soldOut, l.low], [1, 1]);
  eq("derived inventory column = variant total", derivedInventory(s, 99), 12);
  const plain = variantLedger(normalizeProductSettings({}), { price: 10, trackInventory: true, inventory: 2 });
  eq("no variants → falls back to the column", [plain.units, plain.low], [2, 1]);
  eq("no variants → derived inventory is the typed count", derivedInventory(normalizeProductSettings({}), 7), 7);
  eq("untracked", variantLedger(normalizeProductSettings({}), { price: 10, trackInventory: false, inventory: null }).tracked, false);
}
eq("tier range", tierRange([{ name: "a", includes: "", length: "", price: 300 }, { name: "b", includes: "", length: "", price: 150 }]), { min: 150, max: 300 });
eq("tier range with no prices", tierRange([{ name: "a", includes: "", length: "", price: null }]), null);

console.log("\nStorefronts ↔ columns (both directions, the only interpreter of the pair):");
eq("members + public", storefrontsFor("MEMBERS_AND_PUBLIC", "PUBLIC_CHECKOUT"), ["MEMBER_PORTAL", "PUBLIC_LINK"]);
eq("members only", storefrontsFor("MEMBERS_ONLY", "MEMBER_PORTAL"), ["MEMBER_PORTAL"]);
eq("the contradiction the handoff names: members-only visibility on the public link → public link wins", storefrontsFor("MEMBERS_ONLY", "PUBLIC_CHECKOUT"), ["MEMBER_PORTAL", "PUBLIC_LINK"]);
eq("internal", storefrontsFor("INTERNAL_ONLY", "MEMBER_PORTAL"), ["STAFF_ONLY"]);
eq("public only", storefrontsFor("PUBLIC_ONLY", "PUBLIC_CHECKOUT"), ["PUBLIC_LINK"]);
eq("round trip members+public", columnsForStorefronts(["MEMBER_PORTAL", "PUBLIC_LINK"]), { visibility: "MEMBERS_AND_PUBLIC", showLocation: "PUBLIC_CHECKOUT" });
eq("round trip staff only", columnsForStorefronts(["STAFF_ONLY"]), { visibility: "INTERNAL_ONLY", showLocation: "INTERNAL_ONLY" });
eq("nothing ticked → staff only, never silently public", columnsForStorefronts([]), { visibility: "INTERNAL_ONLY", showLocation: "INTERNAL_ONLY" });

console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
