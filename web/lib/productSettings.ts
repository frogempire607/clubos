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

// B10 slice 3 — the handoff's 11 types. FACILITY_RENTAL / BIRTHDAY_PARTY are the
// pre-redesign values; they still read as Bookable (isBookable) and the editor
// offers BOOKABLE instead.
export type ProductType =
  | "GEAR" | "BOOKABLE" | "PUNCH_CARD" | "TEAM_KIT" | "CONCESSION" | "GIFT_CARD"
  | "MEMBERSHIP_ADDON" | "TOURNAMENT_ENTRY" | "PRE_ORDER" | "DIGITAL" | "OTHER"
  | "FACILITY_RENTAL" | "BIRTHDAY_PARTY";

export const PRODUCT_TYPES = [
  "GEAR", "BOOKABLE", "PUNCH_CARD", "TEAM_KIT", "CONCESSION", "GIFT_CARD",
  "MEMBERSHIP_ADDON", "TOURNAMENT_ENTRY", "PRE_ORDER", "DIGITAL", "OTHER",
] as const;
export const ALL_PRODUCT_TYPES = [...PRODUCT_TYPES, "FACILITY_RENTAL", "BIRTHDAY_PARTY"] as const;

export const PRODUCT_TYPE_LABELS: Record<ProductType, string> = {
  GEAR: "Gear / merch",
  BOOKABLE: "Bookable",
  PUNCH_CARD: "Punch card / class pack",
  TEAM_KIT: "Team registration kit",
  CONCESSION: "Concessions",
  GIFT_CARD: "Gift card",
  MEMBERSHIP_ADDON: "Membership add-on",
  TOURNAMENT_ENTRY: "Tournament entry",
  PRE_ORDER: "Fundraiser pre-order",
  DIGITAL: "Digital item",
  OTHER: "Other",
  FACILITY_RENTAL: "Bookable (rental)",
  BIRTHDAY_PARTY: "Bookable (party)",
};

/** The Product.category column the list/filters and Financials group by. */
export function categoryForType(type: ProductType): "GEAR" | "APPAREL" | "FACILITY" | "SERVICE" | "OTHER" {
  if (type === "GEAR" || type === "PRE_ORDER" || type === "TEAM_KIT" || type === "CONCESSION") return "GEAR";
  if (isBookable(type)) return "FACILITY";
  if (type === "DIGITAL" || type === "PUNCH_CARD" || type === "MEMBERSHIP_ADDON" || type === "GIFT_CARD" || type === "TOURNAMENT_ENTRY") return "SERVICE";
  return "OTHER";
}
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
/** Bulk pricing: buying `minQty` or more in one checkout makes each unit `price`. */
export type QtyBreak = { minQty: number; price: number };
export type Duration = { mins: number; price: number | null };
export type AddOn = { label: string; price: number | null; perGuest: boolean };
export type QuestionKind = "SHORT" | "LONG" | "NUMBER";
export type Question = { label: string; kind: QuestionKind; required: boolean };
/** A bookable time window: on these days, from–to ("16:00"–"20:00", 24h). */
export type TimeWindow = { days: string[]; from: string; to: string };
export type DepositMode = "FULL" | "DEPOSIT" | "REQUEST_ONLY";

export type ProductSettings = {
  v: 2;
  photos: string[];
  memberPrice: number | null;
  /** Bulk pricing, ascending by minQty (2+). Empty = one price at any quantity. */
  quantityBreaks: QtyBreak[];
  tiersEnabled: boolean;
  tiers: Tier[];
  lowStockAlertQuantity: number | null;
  optionGroups: OptionGroup[];
  variants: Variant[];
  fulfillment: string;
  digitalInstructions: string | null;
  digitalAccess: string | null;
  availableDays: string[];
  /** Structured since B10 slice 3; legacy text lines ("Mon-Fri 4:00 PM-8:00 PM")
   *  are parsed by parseTimeWindowLine. Empty = open all day on bookable days
   *  (9:00–21:00, see effectiveWindows). */
  timeWindows: TimeWindow[];
  /** How far ahead families can book, in days. null = 60. */
  bookingWindowDays: number | null;
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
    quantityBreaks: [],
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
    bookingWindowDays: null,
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

// ── time windows ─────────────────────────────────────────────────────────────

export const DAY_KEYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "4:00 PM" / "16:00" / "4pm" → "16:00"; anything else → null. */
export function normTime(v: unknown): string | null {
  const t = str(v).toLowerCase().replace(/\s+/g, "");
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? "0");
  if (m[3] === "pm" && h < 12) h += 12;
  if (m[3] === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** "Mon-Fri 4:00 PM-8:00 PM", "Sat 9am-1pm", "Mon,Wed 16:00-20:00" → a window. */
export function parseTimeWindowLine(line: string): TimeWindow | null {
  const m = line.trim().match(/^([A-Za-z,\s-]+?)\s+(\d{1,2}(?::\d{2})?\s*(?:[ap]m)?)\s*[-–]\s*(\d{1,2}(?::\d{2})?\s*(?:[ap]m)?)$/i);
  if (!m) return null;
  const from = normTime(m[2]), to = normTime(m[3]);
  if (!from || !to || from >= to) return null;
  const cap = (d: string) => d.slice(0, 1).toUpperCase() + d.slice(1, 3).toLowerCase();
  const days: string[] = [];
  for (const part of m[1].split(",").map((x) => x.trim()).filter(Boolean)) {
    const [a, b] = part.split("-").map((x) => cap(x.trim()));
    const ia = DAY_KEYS.indexOf(a);
    if (ia < 0) return null;
    if (!b) { days.push(a); continue; }
    const ib = DAY_KEYS.indexOf(b);
    if (ib < 0) return null;
    for (let i = ia; ; i = (i + 1) % 7) { days.push(DAY_KEYS[i]); if (i === ib) break; }
  }
  return { days: Array.from(new Set(days)), from, to };
}

/** "16:00" → "4:00 PM" */
export function timeLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
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
  out.timeWindows = Array.isArray(s.timeWindows)
    ? (s.timeWindows as unknown[]).flatMap((w) => {
        if (typeof w === "string") return parseTimeWindowLine(w) ?? [];
        const o = (w && typeof w === "object" ? w : {}) as Partial<TimeWindow>;
        const from = normTime(o.from), to = normTime(o.to);
        return from && to && from < to ? [{ days: strList(o.days).filter((d) => DAY_KEYS.includes(d)), from, to }] : [];
      })
    : typeof s.timeWindows === "string" ? strList(s.timeWindows).flatMap((l) => parseTimeWindowLine(l) ?? []) : [];
  out.bookingWindowDays = int(s.bookingWindowDays);
  out.bufferMinutes = int(s.bufferMinutes);
  out.capacityLimit = int(s.capacityLimit);
  out.requiresApproval = !!s.requiresApproval;
  out.depositMode = s.depositMode === "DEPOSIT" || s.depositMode === "REQUEST_ONLY" ? s.depositMode : "FULL";
  out.depositAmount = num(s.depositAmount);
  out.blackoutDates = strList(s.blackoutDates);
  out.maxGuests = int(s.maxGuests);
  out.otherRequiresApproval = !!s.otherRequiresApproval;
  out.photos = strList(s.photos).slice(0, 4);
  out.quantityBreaks = parseQuantityBreaks(s.quantityBreaks);

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

/**
 * Which types hold stock, how (a variant matrix or one plain count), and the
 * note the editor shows under the type picker — the handoff's 2a table.
 */
export function stockBehaviour(type: ProductType): { holdsStock: boolean; variants: boolean; reason: string } {
  switch (type) {
    case "GEAR":
      return { holdsStock: true, variants: true, reason: "Physical items with sizes and colors. Each variant carries its own stock, price, SKU and photo." };
    case "PRE_ORDER":
      return { holdsStock: true, variants: true, reason: "Sold before it exists — collect orders now, count what you owe families later. Stock here is how many you'll order; leave it off to take unlimited orders." };
    case "CONCESSION":
      return { holdsStock: true, variants: false, reason: "Snack-bar items sold fast at the desk. Simple count per item, no sizes." };
    case "BOOKABLE":
    case "FACILITY_RENTAL":
    case "BIRTHDAY_PARTY":
      return { holdsStock: false, variants: false, reason: "Facility rentals and birthday parties, booked into time slots — there is no shelf to count. Private lessons stay OUT of products: they keep their own Privates surface." };
    case "PUNCH_CARD":
      return { holdsStock: false, variants: false, reason: "A number of visits sold up front. Stock is unlimited — the visits are tracked by whoever redeems them, not by a shelf count." };
    case "TEAM_KIT":
      return { holdsStock: false, variants: false, reason: "A kit's stock comes from the items inside it — counting the bundle separately would double-count. Track the items as their own products." };
    case "GIFT_CARD":
      return { holdsStock: false, variants: false, reason: "A gift card is a balance, not an object — there is nothing to count and nothing to ship." };
    case "MEMBERSHIP_ADDON":
      return { holdsStock: false, variants: false, reason: "Add-ons bill alongside a membership, so there is no shelf to count." };
    case "TOURNAMENT_ENTRY":
      return { holdsStock: false, variants: false, reason: "Entries are capped by the event's capacity, not a stock count." };
    case "DIGITAL":
      return { holdsStock: false, variants: false, reason: "Delivered after purchase. Nothing to count, nothing to ship." };
    default:
      return { holdsStock: false, variants: false, reason: "Anything else purchasable, with optional questions at checkout." };
  }
}

export function isBookable(type: ProductType | string): boolean {
  return type === "BOOKABLE" || type === "FACILITY_RENTAL" || type === "BIRTHDAY_PARTY";
}

/** Types with something to hand over (the fulfilment choice applies). */
export function needsFulfillment(type: ProductType): boolean {
  return type === "GEAR" || type === "PRE_ORDER" || type === "CONCESSION" || type === "TEAM_KIT" || type === "OTHER";
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

// ── bulk pricing ─────────────────────────────────────────────────────────────

export const MAX_QTY_BREAKS = 5;

/** Clean a quantityBreaks list: whole quantities of 2+, prices of 0+, one row
 *  per quantity (the last wins), ascending, at most MAX_QTY_BREAKS. */
export function parseQuantityBreaks(raw: unknown): QtyBreak[] {
  if (!Array.isArray(raw)) return [];
  const byQty = new Map<number, number>();
  for (const r of raw as Partial<QtyBreak>[]) {
    const q = Math.floor(Number(r?.minQty));
    const p = Number(r?.price);
    if (!Number.isFinite(q) || q < 2 || q > 1000) continue;
    if (r?.price == null || !Number.isFinite(p) || p < 0) continue;
    byQty.set(q, Math.round(p * 100) / 100);
  }
  return Array.from(byQty, ([minQty, price]) => ({ minQty, price }))
    .sort((a, b) => a.minQty - b.minQty)
    .slice(0, MAX_QTY_BREAKS);
}

/** The bulk row that applies at this quantity (the highest minQty ≤ qty), or null. */
export function qtyBreakFor(breaks: QtyBreak[], quantity: number): QtyBreak | null {
  let hit: QtyBreak | null = null;
  for (const b of breaks) if (quantity >= b.minQty) hit = b;
  return hit;
}

/**
 * The unit price at a quantity: the bulk price when a row applies AND it is
 * lower than what the unit would cost anyway (a member price or a variant
 * price that is already cheaper is never raised).
 */
export function unitPriceAtQuantity(breaks: QtyBreak[], unit: number, quantity: number): { unit: number; bulk: QtyBreak | null } {
  const b = qtyBreakFor(breaks, quantity);
  if (b && b.price < unit) return { unit: b.price, bulk: b };
  return { unit, bulk: null };
}

/** "2+ $35 each · 3+ $30 each" */
export function quantityBreaksLabel(breaks: QtyBreak[]): string {
  return breaks.map((b) => `${b.minQty}+ $${b.price.toFixed(2)} each`).join(" · ");
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
