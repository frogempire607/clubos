// Product settings — the typed shape behind `Product.settings` (JSON), and the
// ONE parser that turns the old free-text lines into it.
//
// PURE. No prisma, no Date.now(). Exercised by scripts/product-settings-tests.ts.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// Until 2026-09-22 every type-specific product field was a "one per line"
// textarea stored as string[] in `settings` — `variantOptions`, `variantStock`,
// `packageTiers`, `durationPrices`, `addOns` — and the stock notes' own hint
// said "Simple stock notes for staff until variant checkout is connected". So
// nobody could answer "how many Youth M are left". The products design handoff
// (docs/improvement/design_handoff_products) makes each Size × Color
// combination a real row with its own stock, price and SKU, and turns every
// list into a structured editor.
//
// ── Why it is still `settings` JSON, not columns ────────────────────────────
// Slice 1 ships with NO migration. The typed shape lives in the same JSON
// column, versioned (`v: 2`), and `normalizeProductSettings()` upgrades a v1
// (or absent) blob on read — idempotent on v2. The one column readers already
// depend on, `Product.inventory`, is kept as the DERIVED total of variant stock
// (see `variantLedger`) so the sell and buy routes' stock checks keep working
// unchanged until slice 2 teaches them about variants.
//
// ── The rule ────────────────────────────────────────────────────────────────
// Nothing that appears twice is stored twice. The variant ledger feeds the
// editor totals, the card badges and chips; the tier table feeds the pricing
// summary; storefronts are derived from visibility + showLocation and back.

export type ProductType = "GEAR" | "FACILITY_RENTAL" | "BIRTHDAY_PARTY" | "DIGITAL" | "OTHER";
export type Visibility = "MEMBERS_ONLY" | "PUBLIC_ONLY" | "MEMBERS_AND_PUBLIC" | "INTERNAL_ONLY";
export type ShowLocation = "MEMBER_PORTAL" | "PUBLIC_CHECKOUT" | "INTERNAL_ONLY";
export type Storefront = "MEMBER_PORTAL" | "PUBLIC_LINK" | "STAFF_ONLY";

export type OptionGroup = { name: string; values: string[] };
export type Variant = {
  /** Stable key: option values joined by " / " in group order. */
  id: string;
  label: string;
  sku: string;
  /** null = use the product's base price. */
  price: number | null;
  stock: number;
  photoUrl: string | null;
};
export type Tier = { name: string; includes: string; length: string; price: number | null };
export type Duration = { mins: number; price: number | null };
export type AddOn = { label: string; price: number | null; perGuest: boolean };
export type QuestionKind = "SHORT" | "LONG" | "NUMBER";
export type Question = { label: string; kind: QuestionKind; required: boolean };
export type DepositMode = "FULL" | "DEPOSIT" | "REQUEST_ONLY";

export type ProductSettings = {
  v: 2;
  photos: string[];
  memberPrice: number | null;
  tiersEnabled: boolean;
  tiers: Tier[];
  lowStockAlertQuantity: number | null;
  optionGroups: OptionGroup[];
  variants: Variant[];
  fulfillment: string;
  digitalInstructions: string | null;
  digitalAccess: string | null;
  availableDays: string[];
  /** Kept as the owner typed them ("Mon-Fri 4:00 PM-8:00 PM") — a structured
   *  time-window editor is slice 2. */
  timeWindows: string[];
  durations: Duration[];
  bufferMinutes: number | null;
  capacityLimit: number | null;
  requiresApproval: boolean;
  depositMode: DepositMode;
  depositAmount: number | null;
  blackoutDates: string[];
  maxGuests: number | null;
  addOns: AddOn[];
  questions: Question[];
  otherRequiresApproval: boolean;
};

export const DEFAULT_LOW_STOCK = 3;

export function emptyProductSettings(): ProductSettings {
  return {
    v: 2,
    photos: [],
    memberPrice: null,
    tiersEnabled: false,
    tiers: [],
    lowStockAlertQuantity: null,
    optionGroups: [],
    variants: [],
    fulfillment: "PICKUP",
    digitalInstructions: null,
    digitalAccess: null,
    availableDays: [],
    timeWindows: [],
    durations: [],
    bufferMinutes: null,
    capacityLimit: null,
    requiresApproval: false,
    depositMode: "FULL",
    depositAmount: null,
    blackoutDates: [],
    maxGuests: null,
    addOns: [],
    questions: [],
    otherRequiresApproval: false,
  };
}

// ── small parsers ────────────────────────────────────────────────────────────

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const int = (v: unknown): number | null => {
  const n = num(v);
  return n == null ? null : Math.round(n);
};
const str = (v: unknown): string => (v == null ? "" : String(v)).trim();
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : typeof v === "string" ? v.split("\n").map((l) => l.trim()).filter(Boolean) : [];

/** "$150" / "150.00" / "150 dollars" → 150. Last dollar-ish number in the text. */
function moneyIn(text: string): number | null {
  const m = text.match(/\$?\s*(\d+(?:[.,]\d{1,2})?)\s*(?:dollars|usd)?\s*$/i) ?? text.match(/\$\s*(\d+(?:[.,]\d{1,2})?)/);
  return m ? num(m[1]) : null;
}

/** "Size: Youth S, Youth M, Adult L" → { name: "Size", values: [...] } */
export function parseOptionGroupLine(line: string): OptionGroup | null {
  const i = line.indexOf(":");
  if (i < 0) return null;
  const name = line.slice(0, i).trim();
  const values = line
    .slice(i + 1)
    .split(/[,|]/)
    .map((v) => v.trim())
    .filter(Boolean);
  if (!name || values.length === 0) return null;
  return { name, values };
}

/** "Youth S / Black: 8" → { label: "Youth S / Black", stock: 8 } */
export function parseVariantStockLine(line: string): { label: string; stock: number } | null {
  const m = line.match(/^(.+?)\s*[:=]\s*(\d+)\s*$/);
  if (!m) return null;
  return { label: m[1].split("/").map((s) => s.trim()).join(" / "), stock: parseInt(m[2], 10) };
}

/** "Basic: 60 minutes, $150" → { name, includes: "", length: "60 minutes", price: 150 } */
export function parseTierLine(line: string): Tier | null {
  const i = line.indexOf(":");
  const name = (i < 0 ? line : line.slice(0, i)).trim();
  if (!name) return null;
  const rest = i < 0 ? "" : line.slice(i + 1);
  const parts = rest.split(",").map((p) => p.trim()).filter(Boolean);
  const price = moneyIn(rest);
  const length = parts.find((p) => /\b(min|minute|hour|hr)s?\b/i.test(p)) ?? "";
  const includes = parts.filter((p) => p !== length && moneyIn(p) == null).join(", ");
  return { name, includes, length, price };
}

/** "30 minutes: $40" / "1 hour: $75" → { mins, price } */
export function parseDurationLine(line: string): Duration | null {
  const m = line.match(/(\d+(?:\.\d+)?)\s*(min|minute|minutes|hour|hours|hr|hrs)\b/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const mins = /^h/i.test(m[2]) ? Math.round(n * 60) : Math.round(n);
  return { mins, price: moneyIn(line) };
}

/** "Extra coach: $50" / "Pizza (per guest): $12" → { label, price, perGuest } */
export function parseAddOnLine(line: string): AddOn | null {
  const i = line.lastIndexOf(":");
  const label = (i < 0 ? line : line.slice(0, i)).trim();
  if (!label) return null;
  const perGuest = /per\s*(guest|person|head|kid|child)/i.test(line);
  return { label: label.replace(/\s*\(?per\s*(guest|person|head|kid|child)\)?/i, "").trim(), price: moneyIn(i < 0 ? "" : line.slice(i + 1)), perGuest };
}

/** Free-text question notes → one SHORT optional question per line. */
export function parseQuestions(text: unknown): Question[] {
  if (Array.isArray(text)) {
    return text
      .map((q) => (q && typeof q === "object" ? (q as Partial<Question>) : { label: str(q) }))
      .filter((q) => str(q.label))
      .map((q) => ({
        label: str(q.label),
        kind: q.kind === "LONG" || q.kind === "NUMBER" ? q.kind : "SHORT",
        required: !!q.required,
      }));
  }
  return strList(text).map((label) => ({ label: label.replace(/[?]\s*$/, "?"), kind: "SHORT" as const, required: false }));
}

// ── variants ─────────────────────────────────────────────────────────────────

export function variantId(values: string[]): string {
  return values.map((v) => v.trim()).join(" / ");
}

/** Cartesian product of the option groups, in group order. */
export function expandVariants(groups: OptionGroup[]): string[][] {
  const live = groups.filter((g) => g.values.length > 0);
  if (live.length === 0) return [];
  return live.reduce<string[][]>((acc, g) => acc.flatMap((row) => g.values.map((v) => [...row, v])), [[]]);
}

/**
 * Rebuild the variant list for a new set of option groups, KEEPING the stock,
 * price, sku and photo of any variant whose label survives. Adding a colour
 * must not zero the sizes you already counted.
 */
export function reconcileVariants(groups: OptionGroup[], existing: Variant[]): Variant[] {
  const byId = new Map(existing.map((v) => [v.id, v]));
  const matrix = expandVariants(groups).map((values) => {
    const id = variantId(values);
    const prev = byId.get(id);
    return prev ?? { id, label: id, sku: "", price: null, stock: 0, photoUrl: null };
  });
  // A row the groups no longer produce but that still holds units is real
  // stock somebody counted — it stays until the owner zeroes it. An orphan
  // at 0 is just a removed option and goes quietly.
  const produced = new Set(matrix.map((v) => v.id));
  const orphans = existing.filter((v) => !produced.has(v.id) && v.stock > 0);
  return [...matrix, ...orphans];
}

// ── the parser ───────────────────────────────────────────────────────────────

/**
 * Upgrade whatever is in `Product.settings` to the v2 shape. Idempotent: a v2
 * blob comes back normalised but unchanged. A v1 blob (the free-text lines) is
 * parsed with the rules in the design handoff's migration notes.
 */
export function normalizeProductSettings(raw: unknown): ProductSettings {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = emptyProductSettings();

  // Scalars shared by both versions.
  out.memberPrice = num(s.memberPrice);
  out.lowStockAlertQuantity = int(s.lowStockAlertQuantity);
  out.fulfillment = str(s.fulfillment) || "PICKUP";
  out.digitalInstructions = str(s.digitalInstructions) || null;
  out.digitalAccess = str(s.digitalAccess) || null;
  out.availableDays = strList(s.availableDays);
  out.timeWindows = strList(s.timeWindows);
  out.bufferMinutes = int(s.bufferMinutes);
  out.capacityLimit = int(s.capacityLimit);
  out.requiresApproval = !!s.requiresApproval;
  out.depositMode = s.depositMode === "DEPOSIT" || s.depositMode === "REQUEST_ONLY" ? s.depositMode : "FULL";
  out.depositAmount = num(s.depositAmount);
  out.blackoutDates = strList(s.blackoutDates);
  out.maxGuests = int(s.maxGuests);
  out.otherRequiresApproval = !!s.otherRequiresApproval;
  out.photos = strList(s.photos).slice(0, 4);

  if (s.v === 2) {
    out.tiersEnabled = !!s.tiersEnabled;
    out.tiers = Array.isArray(s.tiers)
      ? (s.tiers as Partial<Tier>[]).map((t) => ({ name: str(t.name), includes: str(t.includes), length: str(t.length), price: num(t.price) })).filter((t) => t.name)
      : [];
    out.optionGroups = Array.isArray(s.optionGroups)
      ? (s.optionGroups as Partial<OptionGroup>[]).map((g) => ({ name: str(g.name), values: strList(g.values) })).filter((g) => g.name)
      : [];
    const variants = Array.isArray(s.variants)
      ? (s.variants as Partial<Variant>[]).map((v) => {
          const label = str(v.label) || str(v.id);
          return { id: str(v.id) || label, label, sku: str(v.sku), price: num(v.price), stock: Math.max(0, int(v.stock) ?? 0), photoUrl: str(v.photoUrl) || null };
        }).filter((v) => v.id)
      : [];
    out.variants = reconcileVariants(out.optionGroups, variants);
    out.durations = Array.isArray(s.durations)
      ? (s.durations as Partial<Duration>[]).map((d) => ({ mins: int(d.mins) ?? 0, price: num(d.price) })).filter((d) => d.mins > 0)
      : [];
    out.addOns = Array.isArray(s.addOns)
      ? (s.addOns as Partial<AddOn>[]).map((a) => ({ label: str(a.label), price: num(a.price), perGuest: !!a.perGuest })).filter((a) => a.label)
      : [];
    out.questions = parseQuestions(s.questions);
    return out;
  }

  // ── v1 → v2: the handoff's migration rules ──
  out.optionGroups = strList(s.variantOptions).map(parseOptionGroupLine).filter((g): g is OptionGroup => !!g);
  const stockLines = strList(s.variantStock).map(parseVariantStockLine).filter((x): x is { label: string; stock: number } => !!x);
  // Stock notes that name a combination the option groups do not produce are
  // kept as their own rows (reconcileVariants keeps any orphan with units) —
  // the count is real even if the groups were sloppy.
  const noted: Variant[] = stockLines.map((x) => ({ id: x.label, label: x.label, sku: "", price: null, stock: x.stock, photoUrl: null }));
  out.variants = reconcileVariants(out.optionGroups, noted);
  out.tiers = strList(s.packageTiers).map(parseTierLine).filter((t): t is Tier => !!t);
  out.tiersEnabled = out.tiers.length > 0;
  out.durations = strList(s.durationPrices).map(parseDurationLine).filter((d): d is Duration => !!d);
  out.addOns = strList(s.addOns).map(parseAddOnLine).filter((a): a is AddOn => !!a);
  out.questions = parseQuestions(s.customQuestions);
  return out;
}

// ── derived ──────────────────────────────────────────────────────────────────

export type VariantStatus = "OUT" | "LOW" | "OK";

export function variantStatus(v: Pick<Variant, "stock">, threshold: number | null): VariantStatus {
  if (v.stock <= 0) return "OUT";
  if (v.stock <= (threshold ?? DEFAULT_LOW_STOCK)) return "LOW";
  return "OK";
}

export type VariantLedger = {
  /** True when the product holds per-variant stock. */
  tracked: boolean;
  variantCount: number;
  units: number;
  retailValue: number;
  low: number;
  soldOut: number;
  threshold: number;
};

/** The one ledger every stock number on screen reads from. */
export function variantLedger(
  settings: ProductSettings,
  product: { price: number | string; trackInventory: boolean; inventory: number | null },
): VariantLedger {
  const threshold = settings.lowStockAlertQuantity ?? DEFAULT_LOW_STOCK;
  const base = Number(product.price) || 0;
  if (settings.variants.length > 0) {
    let units = 0, retail = 0, low = 0, soldOut = 0;
    for (const v of settings.variants) {
      units += v.stock;
      retail += v.stock * (v.price ?? base);
      const st = variantStatus(v, threshold);
      if (st === "OUT") soldOut++;
      else if (st === "LOW") low++;
    }
    return { tracked: true, variantCount: settings.variants.length, units, retailValue: Math.round(retail * 100) / 100, low, soldOut, threshold };
  }
  if (product.trackInventory && product.inventory != null) {
    const st = variantStatus({ stock: product.inventory }, threshold);
    return {
      tracked: true,
      variantCount: 0,
      units: product.inventory,
      retailValue: Math.round(product.inventory * base * 100) / 100,
      low: st === "LOW" ? 1 : 0,
      soldOut: st === "OUT" ? 1 : 0,
      threshold,
    };
  }
  return { tracked: false, variantCount: 0, units: 0, retailValue: 0, low: 0, soldOut: 0, threshold };
}

/** What `Product.inventory` must be written as so the sell/buy stock checks
 *  keep working: the variant total when variants exist, else the typed count. */
export function derivedInventory(settings: ProductSettings, typedInventory: number | null): number | null {
  if (settings.variants.length > 0) return settings.variants.reduce((s, v) => s + v.stock, 0);
  return typedInventory;
}

/** Tier price range for the pricing summary. */
export function tierRange(tiers: Tier[]): { min: number; max: number } | null {
  const ps = tiers.map((t) => t.price).filter((p): p is number => p != null);
  if (ps.length === 0) return null;
  return { min: Math.min(...ps), max: Math.max(...ps) };
}

// ── storefronts ↔ visibility + showLocation ──────────────────────────────────
// The design collapses the two overlapping columns into one "where it's sold"
// list. The columns stay (no migration); these two functions are the mapping,
// in both directions, and nothing else may interpret the pair.

export function storefrontsFor(visibility: Visibility, showLocation: ShowLocation): Storefront[] {
  if (visibility === "INTERNAL_ONLY" || showLocation === "INTERNAL_ONLY") return ["STAFF_ONLY"];
  const out: Storefront[] = [];
  if (visibility !== "PUBLIC_ONLY") out.push("MEMBER_PORTAL");
  if (showLocation === "PUBLIC_CHECKOUT" || visibility === "PUBLIC_ONLY") out.push("PUBLIC_LINK");
  return out.length ? out : ["MEMBER_PORTAL"];
}

export function columnsForStorefronts(fronts: Storefront[]): { visibility: Visibility; showLocation: ShowLocation } {
  const set = new Set(fronts);
  if (set.has("STAFF_ONLY") || set.size === 0) return { visibility: "INTERNAL_ONLY", showLocation: "INTERNAL_ONLY" };
  const member = set.has("MEMBER_PORTAL");
  const pub = set.has("PUBLIC_LINK");
  if (member && pub) return { visibility: "MEMBERS_AND_PUBLIC", showLocation: "PUBLIC_CHECKOUT" };
  if (pub) return { visibility: "PUBLIC_ONLY", showLocation: "PUBLIC_CHECKOUT" };
  return { visibility: "MEMBERS_ONLY", showLocation: "MEMBER_PORTAL" };
}

export const STOREFRONT_LABELS: Record<Storefront, { label: string; hint: string }> = {
  MEMBER_PORTAL: { label: "Member portal store", hint: "Members buy it signed in, at the member price." },
  PUBLIC_LINK: { label: "Public checkout link", hint: "Anyone with the link checks out with Stripe." },
  STAFF_ONLY: { label: "Front desk only", hint: "Sold by staff; never listed anywhere." },
};

/** Which types hold stock, and the reason the others don't (the editor's lock panel). */
export function stockBehaviour(type: ProductType): { holdsStock: boolean; reason: string } {
  switch (type) {
    case "GEAR":
      return { holdsStock: true, reason: "Physical items with sizes and colors. Each variant carries its own stock, price, SKU and photo." };
    case "FACILITY_RENTAL":
    case "BIRTHDAY_PARTY":
      return { holdsStock: false, reason: "Rentals and parties are booked into time slots — there is no shelf to count." };
    case "DIGITAL":
      return { holdsStock: false, reason: "Delivered after purchase. Nothing to count, nothing to ship." };
    default:
      return { holdsStock: false, reason: "Anything else purchasable, with optional questions at checkout." };
  }
}

export function isBookable(type: ProductType): boolean {
  return type === "FACILITY_RENTAL" || type === "BIRTHDAY_PARTY";
}

// ── selling a variant (slice 2) ──────────────────────────────────────────────
//
// The variant ledger is the ONE place per-variant stock lives (the handoff's
// rule: nothing that appears twice is stored twice). Selling therefore edits
// the ledger and lets `derivedInventory` rewrite `Product.inventory` — never
// the other way round. These are pure; lib/productStock.ts wraps them in the
// transaction.

export function hasVariants(settings: ProductSettings): boolean {
  return settings.variants.length > 0;
}

export function findVariant(settings: ProductSettings, variantId: string | null | undefined): Variant | null {
  if (!variantId) return null;
  return settings.variants.find((v) => v.id === variantId) ?? null;
}

/**
 * What one unit costs.
 *
 *   variant price set     → that (a per-variant price is the price, in every
 *                            storefront — it is how "XXL costs $3 more" is said)
 *   member portal + memberPrice → the member price
 *   otherwise             → the product's base price
 */
export function unitPriceFor(
  settings: ProductSettings,
  base: number | string,
  variant: Variant | null,
  storefront: "MEMBER_PORTAL" | "STAFF" | "PUBLIC",
): number {
  if (variant && variant.price != null) return variant.price;
  if (storefront === "MEMBER_PORTAL" && settings.memberPrice != null) return settings.memberPrice;
  return Number(base) || 0;
}

export type StockCheck =
  | { ok: true; available: number | null }
  | { ok: false; reason: "VARIANT_REQUIRED" | "VARIANT_UNKNOWN" | "OUT_OF_STOCK" | "NOT_ENOUGH"; available: number };

/**
 * Can `quantity` of this variant be sold? A product with variants REQUIRES one
 * (there is no "generic" unit to hand over); a product without variants falls
 * back to the plain `inventory` count when it tracks stock.
 */
export function checkStock(
  settings: ProductSettings,
  product: { trackInventory: boolean; inventory: number | null },
  variantId: string | null | undefined,
  quantity: number,
): StockCheck {
  if (hasVariants(settings)) {
    if (!variantId) return { ok: false, reason: "VARIANT_REQUIRED", available: 0 };
    const v = findVariant(settings, variantId);
    if (!v) return { ok: false, reason: "VARIANT_UNKNOWN", available: 0 };
    if (v.stock <= 0) return { ok: false, reason: "OUT_OF_STOCK", available: 0 };
    if (v.stock < quantity) return { ok: false, reason: "NOT_ENOUGH", available: v.stock };
    return { ok: true, available: v.stock };
  }
  if (product.trackInventory && product.inventory != null) {
    if (product.inventory <= 0) return { ok: false, reason: "OUT_OF_STOCK", available: 0 };
    if (product.inventory < quantity) return { ok: false, reason: "NOT_ENOUGH", available: product.inventory };
    return { ok: true, available: product.inventory };
  }
  return { ok: true, available: null };
}

export function stockMessage(check: Exclude<StockCheck, { ok: true }>): string {
  switch (check.reason) {
    case "VARIANT_REQUIRED": return "Pick a size or color first.";
    case "VARIANT_UNKNOWN": return "That option isn't sold any more — pick another.";
    case "OUT_OF_STOCK": return "Out of stock.";
    case "NOT_ENOUGH": return `Only ${check.available} left in stock.`;
  }
}

/**
 * The ledger after selling `quantity` of a variant. Never below zero — a
 * webhook that lands twice, or a count fixed by hand between checkout and
 * payment, must not drive a shelf negative.
 */
export function applyVariantSale(settings: ProductSettings, variantId: string, quantity: number): ProductSettings {
  return {
    ...settings,
    variants: settings.variants.map((v) => (v.id === variantId ? { ...v, stock: Math.max(0, v.stock - quantity) } : v)),
  };
}
