// Bulk pricing (quantity breaks) and the public product/event image paths.
// PURE, no database.
//
//   npx tsx scripts/product-bulk-pricing-tests.ts

import { normalizeProductSettings, parseQuantityBreaks, qtyBreakFor, unitPriceAtQuantity, unitPriceFor, quantityBreaksLabel } from "../lib/productSettings";
import { publicMediaUrl, uploadedFileId, productPhotoUrls } from "../lib/publicMedia";
import { storeView } from "../lib/productStore";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};

// ── parsing ──
eq("empty / junk → []", parseQuantityBreaks(undefined), []);
eq("not an array → []", parseQuantityBreaks("2 for 70"), []);
eq("sorted ascending", parseQuantityBreaks([{ minQty: 3, price: 30 }, { minQty: 2, price: 35 }]), [{ minQty: 2, price: 35 }, { minQty: 3, price: 30 }]);
eq("qty 1 dropped (a break starts at 2)", parseQuantityBreaks([{ minQty: 1, price: 10 }]), []);
eq("missing price dropped", parseQuantityBreaks([{ minQty: 2, price: null }]), []);
eq("negative price dropped", parseQuantityBreaks([{ minQty: 2, price: -1 }]), []);
eq("fractional qty floored", parseQuantityBreaks([{ minQty: 2.7, price: 35 }]), [{ minQty: 2, price: 35 }]);
eq("duplicate qty → last wins", parseQuantityBreaks([{ minQty: 2, price: 35 }, { minQty: 2, price: 33 }]), [{ minQty: 2, price: 33 }]);
eq("price rounded to cents", parseQuantityBreaks([{ minQty: 2, price: 35.555 }]), [{ minQty: 2, price: 35.56 }]);
eq("capped at 5", parseQuantityBreaks([2, 3, 4, 5, 6, 7].map((q) => ({ minQty: q, price: 40 - q }))).length, 5);
eq("normalize keeps breaks (v2)", normalizeProductSettings({ v: 2, quantityBreaks: [{ minQty: 2, price: 35 }] }).quantityBreaks, [{ minQty: 2, price: 35 }]);
eq("normalize keeps breaks (v1 blob)", normalizeProductSettings({ quantityBreaks: [{ minQty: 3, price: 30 }] }).quantityBreaks, [{ minQty: 3, price: 30 }]);
eq("normalize default []", normalizeProductSettings({}).quantityBreaks, []);

// ── which break applies ──
const B = parseQuantityBreaks([{ minQty: 2, price: 35 }, { minQty: 3, price: 30 }]);
eq("qty 1 → no break", qtyBreakFor(B, 1), null);
eq("qty 2 → 2+", qtyBreakFor(B, 2)?.minQty, 2);
eq("qty 3 → 3+", qtyBreakFor(B, 3)?.minQty, 3);
eq("qty 10 → highest (3+)", qtyBreakFor(B, 10)?.minQty, 3);

// ── the unit price ──
eq("qty 1 at $40 → $40", unitPriceAtQuantity(B, 40, 1), { unit: 40, bulk: null });
eq("qty 2 at $40 → $35", unitPriceAtQuantity(B, 40, 2).unit, 35);
eq("qty 3 at $40 → $30", unitPriceAtQuantity(B, 40, 3).unit, 30);
eq("cheaper member price is never raised", unitPriceAtQuantity(B, 32, 2), { unit: 32, bulk: null });
eq("break still applies when lower than member price", unitPriceAtQuantity(B, 32, 3).unit, 30);
eq("no breaks → unit", unitPriceAtQuantity([], 40, 9).unit, 40);
eq("label", quantityBreaksLabel(B), "2+ $35.00 each · 3+ $30.00 each");

// ── composed with the storefront price (what the routes do) ──
const s = normalizeProductSettings({ v: 2, memberPrice: 36, quantityBreaks: [{ minQty: 2, price: 35 }, { minQty: 3, price: 30 }] });
eq("member 1× → member price", unitPriceAtQuantity(s.quantityBreaks, unitPriceFor(s, 40, null, "MEMBER_PORTAL"), 1).unit, 36);
eq("member 2× → 35", unitPriceAtQuantity(s.quantityBreaks, unitPriceFor(s, 40, null, "MEMBER_PORTAL"), 2).unit, 35);
eq("public 2× → 35", unitPriceAtQuantity(s.quantityBreaks, unitPriceFor(s, 40, null, "PUBLIC"), 2).unit, 35);
eq("staff 3× → 30", unitPriceAtQuantity(s.quantityBreaks, unitPriceFor(s, 40, null, "STAFF"), 3).unit, 30);

// ── public image paths ──
eq("file id from /api/files path", uploadedFileId("/api/files/cmabc123"), "cmabc123");
eq("file id from absolute path", uploadedFileId("https://athletix-os.com/api/files/cmabc123?x=1"), "cmabc123");
eq("external url → no id", uploadedFileId("https://cdn.example.com/a.jpg"), null);
eq("rewrite ours", publicMediaUrl("product", "p1", "/api/files/f1"), "/api/public/media/product/p1/f1");
eq("external passes through", publicMediaUrl("event", "e1", "https://cdn.example.com/a.jpg"), "https://cdn.example.com/a.jpg");
eq("null stays null", publicMediaUrl("product", "p1", null), null);
eq("photo urls: cover, gallery, variants", productPhotoUrls({ imageUrl: "/api/files/a", settings: { photos: ["/api/files/a", "/api/files/b"], variants: [{ photoUrl: "/api/files/c" }, { photoUrl: null }] } }), ["/api/files/a", "/api/files/a", "/api/files/b", "/api/files/c"]);

// ── the store projection ──
const view = storeView({
  id: "p1", name: "Long Sleeve", description: null, price: "40", category: "APPAREL", productType: "GEAR",
  imageUrl: "/api/files/a", trackInventory: true, inventory: null,
  settings: { v: 2, photos: ["/api/files/a", "https://cdn.example.com/b.jpg"], optionGroups: [{ name: "Size", values: ["YM"] }], variants: [{ id: "YM", label: "YM", stock: 2, photoUrl: "/api/files/c" }], quantityBreaks: [{ minQty: 2, price: 35 }] },
});
eq("store photos rewritten", view.photos, ["/api/public/media/product/p1/a", "https://cdn.example.com/b.jpg"]);
eq("store variant photo rewritten", view.variants[0].photoUrl, "/api/public/media/product/p1/c");
eq("store carries breaks", view.quantityBreaks, [{ minQty: 2, price: 35 }]);
const legacy = storeView({ id: "p2", name: "Old", description: null, price: 10, category: "GEAR", productType: "GEAR", imageUrl: "/api/files/z", trackInventory: false, inventory: null, settings: {} });
eq("legacy imageUrl rewritten", legacy.photos, ["/api/public/media/product/p2/z"]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
